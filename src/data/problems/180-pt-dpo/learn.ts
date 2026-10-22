/**
 * The learning guide for DPO from scratch: where DPO sits after RLHF, the derivation from the
 * KL-regularised objective to a logistic loss on the policy, sequence log-probs and their mask, the
 * gradient weight and β, cDPO and IPO, and the frozen reference in the training loop. Rendered at
 * `/pt-dpo/learn`.
 */
export const learn = `# The mechanism at a glance

Direct Preference Optimization ([Rafailov et al., 2023](https://arxiv.org/abs/2305.18290)) trains a
language model on pairs of answers to the same prompt, one marked better than the other, without a
reward model and without sampling. It replaces the last stage of RLHF as
[InstructGPT](https://arxiv.org/abs/2203.02155) ran it, and it is the default preference stage of most
open post-training recipes since late 2023.

The contract the problem implements, in three files:

- \`sequence_logprobs(model, input_ids, attention_mask, prompt_lengths) -> (N,)\`: the summed
  log-probability of each response given its prompt; \`concatenated_forward(model, batch)\` runs chosen and
  rejected as \`2B\` rows of one forward.
- \`dpo_loss(policy_chosen_logps, policy_rejected_logps, reference_chosen_logps, reference_rejected_logps,
  beta, label_smoothing, loss_type)\`: the per-pair loss, the implicit rewards, the reward accuracy and margin.
- \`make_reference\`, \`dpo_step\`, \`train_dpo\`: a frozen copy of the starting policy and the loop.

:::architecture
{
  "input": "policy π_θ · pairs (x, y_w, y_l)",
  "output": "updated π_θ · π_ref unchanged",
  "items": [
    {"id": "g-freeze", "label": "Freeze the reference", "sub": "deepcopy · eval() · no grad", "detail": "Once, before the loop. At step 0 the two models are equal, so every margin is 0 and the loss is ln 2."},
    {"tone": "block", "repeat": "steps ×", "label": "One DPO step", "items": [
      {"id": "g-concat", "label": "Concatenate and pad", "kind": "io", "sub": "2B rows: x+y_w, then x+y_l"},
      {"columns": [
        [{"id": "g-policy", "label": "Policy log-probs", "kind": "attention", "sub": "log π(y_w|x), log π(y_l|x)", "detail": "With grad: these carry the whole gradient."}],
        [{"id": "g-ref", "label": "Reference log-probs", "sub": "torch.no_grad()", "detail": "Constant over the run; production computes them once."}]
      ]},
      {"id": "g-margin", "label": "Margin h", "sub": "(π_w − π_l) − (ref_w − ref_l)"},
      {"id": "g-loss", "label": "DPO loss", "kind": "loss", "sub": "−log σ(β·h) · mean over B"},
      {"id": "g-step", "label": "Backward, clip, AdamW", "sub": "policy parameters only"}
    ]}
  ],
  "notes": [
    {"at": "g-freeze", "text": "Step 0: loss **ln 2 = 0.693**"},
    {"at": "g-ref", "text": "**No** graph, **no** optimizer state"},
    {"at": "g-loss", "text": "β = **0.1**, the KL coefficient"}
  ]
}
:::

What changes against RLHF with PPO, per training step:

| | RLHF with PPO | DPO |
|---|---|---|
| models in memory | policy, reference, reward model, value head | policy, reference |
| data | prompts; responses sampled from the policy every step | fixed pairs (x, y_w, y_l) collected once |
| reward | a separate learned model scores each sample | implicit: β · log(π / π_ref) |
| KL to the SFT model | a penalty in the reward, estimated per token | built into the loss through π_ref |
| update | several clipped PPO epochs per batch, advantages, value loss | one supervised step on a logistic loss |
| hyperparameters that matter | KL coefficient, clip range, GAE λ, value coefficient, rollout size | β, learning rate |

The [Hugging Face RLHF explainer](https://huggingface.co/blog/rlhf) walks the left column. The rest of
this guide is the right one.

# From RLHF to a loss on the policy

RLHF's last stage maximises a learned reward while a KL term keeps the policy close to the SFT model
it started from (the *reference*). DPO's observation is that this objective has a closed-form optimum,
and that the optimum can be turned around to express the reward through the policy:

\`\`\`text
objective     max_π  E[ r(x, y) ] − β · KL( π(·|x) ‖ π_ref(·|x) )
optimum       π*(y|x) = π_ref(y|x) · exp( r(x, y) / β ) / Z(x)
invert        r(x, y) = β · log( π*(y|x) / π_ref(y|x) ) + β · log Z(x)
preferences   p(y_w ≻ y_l | x) = σ( r(x, y_w) − r(x, y_l) )            Bradley–Terry
substitute    p(y_w ≻ y_l | x) = σ( β · h ),   Z(x) cancels
              h = [ log π(y_w|x) − log π(y_l|x) ] − [ log π_ref(y_w|x) − log π_ref(y_l|x) ]
loss          L = − log σ( β · h )                                    maximum likelihood
\`\`\`

- **The partition function cancels.** \`Z(x)\` sums over every possible response and is intractable; it
  depends only on the prompt, and both sides of a comparison share the prompt. That is why DPO needs
  pairs and cannot use single rated answers.
- **The reward model becomes the policy.** The logistic loss InstructGPT trains its reward model with is
  the same \`−log σ(r_w − r_l)\`; DPO plugs in \`r = β · log(π / π_ref)\` and trains the policy directly.
  Fitting the preferences with this reward and then solving RLHF would give back the same policy.
- **The implicit reward is a by-product.** \`β · (log π(y|x) − log π_ref(y|x))\` is what the policy
  "thinks" a response is worth. \`dpo_loss\` returns it per side, detached, for logging.
- **β is the KL coefficient.** A large β means a tight leash to the reference; a small β lets the
  policy move far for the same change in loss.

| quantity | formula | at step 0, policy = reference |
|---|---|---|
| margin | h = (π_w − π_l) − (ref_w − ref_l) | 0 |
| loss | −log σ(β·h) | ln 2 = 0.693 |
| chosen reward | β·(log π(y_w) − log π_ref(y_w)) | 0 |
| reward accuracy | mean(r_w > r_l) | ties: float noise |
| gradient weight | σ(−β·h) | 0.5 |

:::quiz
Q: Why does DPO need a pair of responses to the same prompt rather than one response with a score?
- [ ] Because the policy's log-probabilities are only defined for pairs
- [x] Because the intractable partition function Z(x) depends only on the prompt and cancels only in a difference of two rewards for that prompt
- [ ] Because the reference model can only be evaluated on pairs
> Inverting the optimum gives r = β·log(π/π_ref) + β·log Z(x). For one response the Z(x) term remains and
> cannot be computed. In the Bradley–Terry difference r(x, y_w) − r(x, y_l) it appears twice with opposite
> signs and disappears.
:::

# Sequence log-probabilities and their mask

Every quantity in the loss is \`log π(y | x)\` for a whole response: the sum, over response tokens, of
the log-probability the model gave the token that is actually there. A causal LM gives one row of
logits per position, and row \`t\` predicts token \`t + 1\`. Two pairs, \`2B = 4\` rows, right padded:

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "g-ids", "array": "input_ids · (2B, T) = (4, 6)", "sub": "rows 0-1 chosen, rows 2-3 rejected", "cols": 6, "rows": 4, "tone": "global",
     "cells": ["1", "5", "7", "3", "3", "2", "1", "9", "8", "10", "11", "12", "1", "5", "7", "6", "0", "0", "1", "9", "12", "2", "0", "0"],
     "marks": [
       {"cols": [0, 2], "rows": [0, 0], "tone": "muted"},
       {"cols": [0, 1], "rows": [1, 1], "tone": "muted"},
       {"cols": [0, 2], "rows": [2, 2], "tone": "muted"},
       {"cols": [4, 5], "rows": [2, 2], "tone": "bad"},
       {"cols": [0, 1], "rows": [3, 3], "tone": "muted"},
       {"cols": [4, 5], "rows": [3, 3], "tone": "bad"}
     ],
     "detail": "Prompt (muted) then response, padded on the right with 0 (red). The two prompts appear twice: once before the chosen response, once before the rejected."},
    {"id": "g-mask", "array": "loss_mask · (2B, T − 1) = (4, 5)", "sub": "labels input_ids[:, 1:] that count", "cols": 5, "rows": 4, "tone": "global",
     "cells": ["0", "0", "1", "1", "1", "0", "1", "1", "1", "1", "0", "0", "1", "0", "0", "0", "1", "1", "0", "0"],
     "marks": [
       {"cols": [0, 1], "rows": [0, 0], "tone": "muted"},
       {"cols": [0, 0], "rows": [1, 1], "tone": "muted"},
       {"cols": [0, 1], "rows": [2, 2], "tone": "muted"},
       {"cols": [3, 4], "rows": [2, 2], "tone": "bad"},
       {"cols": [0, 0], "rows": [3, 3], "tone": "muted"},
       {"cols": [3, 4], "rows": [3, 3], "tone": "bad"}
     ],
     "detail": "attention_mask[:, 1:] AND label position ≥ prompt length: 0 under the prompt (muted) and the padding (red), 1 on response tokens. Each row's sum of per-token log-probs over the 1s is its log π(y | x)."}
  ],
  "arrows": [{"from": "g-ids", "to": "g-mask", "label": "shift by one · mask prompt and padding"}]
}
:::

The code is six lines:

\`\`\`python
logits = model(input_ids, attention_mask)[:, :-1, :].float()   # (N, T-1, V): row t predicts t+1
labels = input_ids[:, 1:]                                        # (N, T-1)
pos = torch.arange(1, T)                                         # label positions
loss_mask = attention_mask[:, 1:].bool() & (pos[None, :] >= prompt_lengths[:, None])
per_token = torch.gather(torch.log_softmax(logits, -1), 2, labels.unsqueeze(-1)).squeeze(-1)
logps = (per_token * loss_mask).sum(-1)                          # (N,)
\`\`\`

Every line has a way to be silently wrong. None of them crash, and all of them still train:

| mistake | what the number becomes | what happens to training |
|---|---|---|
| no shift (logits[:, t] against token t) | each token scored by a position that already saw it | the margin is meaningless; the model learns to copy |
| prompt not masked | log π(x, y) instead of log π(y given x) | the prompt term cancels in theory but adds its noise to every margin |
| padding not masked | a short response gets pad-token log-probs added | rejected and chosen of different lengths are scored unfairly |
| mean instead of sum | per-token average | a different, length-normalised objective (IPO as TRL runs it, SimPO) |
| log_softmax in bf16 | differences below bf16's 8 significant bits are lost | h is rounding noise for small updates |

The self-test of step 1 pins the first three against a slow reference: one forward per response token on
the unpadded prefix, \`x − logsumexp(x)\` in float64. Running chosen and rejected as one \`2B\`-row batch is
not just faster: both halves get the same padding and the same numerics, so the difference \`h\` is not
polluted by batch effects.

:::quiz
Q: A response of 3 tokens is batched next to one of 9 tokens and padded to the longer length. What must hold for its log-probability?
- [ ] It must be divided by 3 so it is comparable with the longer one
- [x] It must equal the log-probability of the same row run alone, which is what the padding mask guarantees
- [ ] It must include the pad tokens, since the model saw them
> With right padding and a causal model, the real tokens never attend to the pads after them, so their
> logits are unchanged; the mask then removes the pad positions from the sum. The result is identical to
> running the row alone. Dividing by length is a different objective, not a correction.
:::

# The gradient and β

Differentiate \`L = −log σ(β·h)\` with respect to \`h\`:

\`\`\`text
dL/dh = −β · σ(−β·h)
∇_θ L = −β · σ(−β·h) · ( ∇_θ log π(y_w|x) − ∇_θ log π(y_l|x) )
\`\`\`

The direction is always the same: raise the chosen response, lower the rejected one. The weight
\`σ(−β·h)\` decides how hard. It is near 1 when the policy still ranks the pair the wrong way round (\`h\`
very negative) and decays towards 0 once the pair is ranked well. This is what separates DPO from naively
maximising \`log π(y_w) − log π(y_l)\`, whose weight is a constant 1 and which degenerates by pushing
the rejected response's probability to 0 at any cost.

At β = 0.1, with the scaled margin \`β·h\`, the DPO loss \`−log σ(β·h)\`, the gradient weight \`σ(−β·h)\` and
IPO's loss \`(h − 5)²\`:

| margin h | scaled margin | DPO loss | gradient weight | IPO loss |
|---|---|---|---|---|
| −20 | −2.0 | 2.127 | 0.881 | 625 |
| −10 | −1.0 | 1.313 | 0.731 | 225 |
| 0 | 0 | 0.693 | 0.500 | 25 |
| 5 | 0.5 | 0.474 | 0.378 | 0 |
| 10 | 1.0 | 0.313 | 0.269 | 25 |
| 20 | 2.0 | 0.127 | 0.119 | 225 |
| 50 | 5.0 | 0.007 | 0.007 | 2025 |

Drag the margin and β. The left panel is the loss with IPO's squared loss for comparison, the right
panel the weight each pair receives:

:::widget dpo-loss {"beta": 0.1, "h": 5}

- **β scales h.** Only \`β·h\` enters the sigmoid, so a smaller β needs a proportionally larger margin
  for the same loss. That is the KL leash: with β = 0.01 the policy must move ten times further from the
  reference than with β = 0.1 to be "done" with a pair.
- **The loss never reaches 0.** For any finite \`h\` the weight is positive, so a pair the policy already
  gets right keeps pushing, just more gently. On a finite dataset with no noise, DPO's optimum is an
  infinite margin. The next section is about that.
- **Use \`F.logsigmoid\`.** In float32 \`torch.log(torch.sigmoid(x))\` returns \`−inf\` once \`x\` drops below
  about −88.7, which a badly ranked pair at β = 1 reaches easily; \`logsigmoid\` stays finite for any \`x\`.

:::quiz
Q: Two pairs in a batch have h = −30 and h = +30, at β = 0.1. How do their gradients compare?
- [ ] They are equal in size and opposite in sign
- [x] Both push the chosen response up and the rejected down, but the mis-ranked pair is weighted σ(3) ≈ 0.95 and the well-ranked one σ(−3) ≈ 0.05
- [ ] The well-ranked pair has zero gradient because its loss is below ln 2
> The sign of the gradient direction never depends on h: DPO always raises y_w and lowers y_l. Only the
> weight σ(−β·h) changes, about 20 times larger for the mis-ranked pair here. It is never exactly 0.
:::

# Noisy and deterministic preferences: cDPO and IPO

Real preference labels disagree with each other: annotators flip on close calls, and the same pair may
be labelled both ways. Two variants change the loss's behaviour far from \`h = 0\`, both one line in
\`dpo_loss\`:

\`\`\`text
DPO     L = −log σ(β·h)                                    weight σ(−β·h) > 0 for every h
cDPO    L = −(1 − ε) · log σ(β·h) − ε · log σ(−β·h)        weight σ(−β·h) − ε, zero at β·h = ln((1 − ε)/ε)
IPO     L = (h − 1/(2β))²                                  gradient 2·(h − 1/(2β)), zero at h = 1/(2β)
\`\`\`

- **Conservative DPO** ([Mitchell's note](https://ericmitchell.ai/cdpo.pdf)) assumes each label is
  flipped with probability ε and takes the expected loss over the flip. The weight becomes
  \`σ(−β·h) − ε\`: positive below the target margin, *negative* above it, so the policy stops at a finite
  margin instead of pushing forever. Set ε with the slider above and watch the gradient cross zero.
- **IPO** ([Azar et al., 2023](https://arxiv.org/abs/2310.12036)) argues that when preferences are
  deterministic (one response always wins), DPO's Bradley–Terry model sends the margin to infinity and
  the KL term stops mattering, whatever β is. It replaces the sigmoid with a squared regression of \`h\` to
  \`1/(2β)\`. The pull is linear in the distance and changes sign at the target.

Where each one stops pulling, at β = 0.1:

| variant | where the pull stops | far below the target | far above the target |
|---|---|---|---|
| DPO | never: h → ∞ | weight → 1, bounded | weight → 0 but positive |
| cDPO, ε = 0.1 | β·h = ln 9, h ≈ 22.0 | weight → 0.9 | weight → −0.1, pushes back |
| cDPO, ε = 0.2 | β·h = ln 4, h ≈ 13.9 | weight → 0.8 | weight → −0.2 |
| IPO | h = 1/(2β) = 5 | gradient grows linearly | gradient grows linearly, pushes back |

TRL applies IPO to length-averaged log-probabilities (its code notes that the IPO authors confirmed this
is the form behind the paper's results); the authors' DPO trainer and this problem apply the same
formula to sums. With sums, \`1/(2β)\` is a margin over the whole response, which a long response reaches
more easily than a short one.

:::quiz
Q: With label smoothing ε = 0.1 and β = 0.1, a pair reaches h = 40. What does the cDPO gradient do?
- [ ] It keeps increasing h, just more slowly than plain DPO
- [ ] It is exactly zero, because cDPO clips the margin
- [x] It pushes h back down, since the weight σ(−4) − 0.1 ≈ −0.08 is negative past h = ln 9 / 0.1 ≈ 22
> cDPO's expected loss over a flipped label has a finite minimum at β·h = ln((1 − ε)/ε). Beyond it the
> ε share of the loss, which treats the pair as reversed, dominates the gradient and lowers the margin.
:::

# The frozen reference and the training loop

The reference is the anchor of the whole objective: the loss only sees the policy's log-probabilities
*relative* to it. It must be the starting policy, exactly, for the entire run:

\`\`\`python
reference = copy.deepcopy(policy)      # separate tensors, same values
reference.eval()                       # no dropout: same number for the same pair, every time
reference.requires_grad_(False)        # no .grad ever allocated
optimizer = torch.optim.AdamW(policy.parameters(), lr=lr)  # the reference is not in it
\`\`\`

Inside a step, the reference forward runs under \`torch.no_grad()\` and the policy forward does not; the
loss is the mean of \`"losses"\`, then \`zero_grad\`, \`backward\`, clip, \`step\`. How the reference goes
wrong, beside the correct version:

| the reference is | what h measures | what you see |
|---|---|---|
| a deep copy, eval, no grad (correct) | change in preference since the start | loss starts at ln 2, margin grows, reference bit-identical |
| the same object as the policy (\`reference = policy\`) | always 0 | loss pinned at ln 2 while the policy still moves: every pair gets the constant weight 0.5, nothing anchors it |
| a copy left in train mode with dropout | change plus dropout noise | first loss not ln 2; noisy margins |
| re-copied from the policy every few steps | change since the last copy | the KL anchor drifts with the policy; β no longer bounds the distance from the SFT model |
| run with grad | the right numbers | activation memory for a second model and gradients nobody uses |

On the toy set (sort three digits ascending rather than descending) the run looks like this, from the
solution's self-test, 150 steps at β = 0.1:

| metric | step 0 | steps 1 to 10 | end |
|---|---|---|---|
| loss (mean over the batch) | 0.693 | falling | 0.001 |
| reward accuracy | float noise around ties | reaches 1.0 | 1.00 on all 32 pairs |
| reward margin | 0 | 0.32 (mean) | 7.26 |
| chosen reward | 0 | up a little | about −0.18 |
| rejected reward | 0 | down | about −7.3 |

Two things to read from it. Reward accuracy saturates within a few steps and says little afterwards;
the margin keeps moving. And the chosen reward ends *below* zero: the policy made the chosen response
less likely than the reference did, and the rejected one far less. DPO only constrains the difference, so
both log-probabilities can fall together; on real data this shows up as the chosen response's
log-probability dropping during training, and recipes such as RPO add a supervised loss on the chosen
response against it.

:::details What production trainers add
TRL's \`DPOTrainer\` and the authors' trainer run the same loop with: an SFT model as both the starting
policy and the reference, reference log-probs precomputed in one pass over the data (they never change),
LoRA adapters so the reference is simply the base model with the adapters disabled, bf16 with FSDP, a
learning rate around 1e-6 with warmup, and evaluation by generating and judging rather than by reward
accuracy on the training pairs.
:::

:::quiz
Q: You write reference = policy instead of a deep copy. What does training look like?
- [ ] Training diverges, because the reference gradient doubles the step
- [x] The loss reads exactly ln 2 at every step while the policy keeps changing, pushed with a constant weight and no anchor
- [ ] Nothing changes, because the reference is evaluated without a graph
> With one object, π and π_ref are the same numbers at every step, so h = 0 for every pair and the loss is
> ln 2. The gradient through the policy branch is not zero: every pair gets the weight σ(0) = 0.5, so the
> policy is trained to raise log π(y_w) − log π(y_l) without limit, the degenerate objective the reference
> exists to prevent. A loss pinned at 0.693 while the weights move is the symptom to recognise.
:::

# What to take away

- DPO turns RLHF's KL-regularised objective into a logistic loss on the policy: \`−log σ(β·h)\`, with
  \`h\` the policy's log-ratio margin minus the reference's. No reward model, no sampling.
- Everything a model contributes is \`log π(y | x)\` per response: shift by one, log-softmax in float32,
  gather, mask prompt and padding, sum. Most DPO bugs live here, and none of them crash.
- The gradient always raises the chosen and lowers the rejected response, weighted by \`σ(−β·h)\`; β is
  the KL coefficient and only \`β·h\` matters.
- Plain DPO never stops pushing a margin. cDPO (label smoothing) and IPO (a squared loss to \`1/(2β)\`)
  give it a finite target.
- The reference is a frozen deep copy of the starting policy, in eval mode, without grad, outside the
  optimizer. Step 0 has loss ln 2; a loss stuck there means the reference is the policy.

The primary source is the DPO paper, [Direct Preference Optimization: Your Language Model is Secretly a
Reward Model](https://arxiv.org/abs/2305.18290), with the authors' trainer at
[eric-mitchell/direct-preference-optimization](https://github.com/eric-mitchell/direct-preference-optimization).
`;
