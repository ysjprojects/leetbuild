/**
 * The learning guide for the GRPO trainer: one iteration end to end, what GRPO removes from PPO, the
 * rollout tensors, verifiable rewards and the group baseline, the clipped objective with the k3 KL
 * penalty, the aggregation variants, and why the loop learns. Rendered at `/pt-grpo/learn`.
 */
export const learn = `# The system at a glance

GRPO (Group Relative Policy Optimization) is the reinforcement-learning algorithm DeepSeek introduced in
[DeepSeekMath](https://arxiv.org/abs/2402.03300) and used to train
[DeepSeek-R1](https://arxiv.org/abs/2501.12948). A language model is the policy: the prompt is the
state, each generated token is an action, and the reward arrives once, when the completion is finished
and a program checks it. GRPO's one idea is to get the baseline for that reward from **other answers to
the same prompt** rather than from a learned value network.

One iteration of the trainer this problem builds, bottom to top:

:::architecture
{
  "input": "policy π_θ · prompts",
  "output": "updated π_θ",
  "items": [
    {"id": "g-prompts", "label": "Prompt batch", "kind": "io", "sub": "B = 32 problems a + b =", "shape": "(B, 4)"},
    {"id": "g-rollout", "label": "Sample G answers each", "kind": "attention", "sub": "π_old · no_grad · G = 8", "shape": "(B·G, 4 + L)", "detail": "Rows b·G … b·G + G − 1 are prompt b's group."},
    {"columns": [
      [
        {"id": "g-reward", "label": "Verifiable rewards", "sub": "accuracy + 0.5 · format", "shape": "r (B·G,)"},
        {"id": "g-norm", "label": "Group normalisation", "kind": "norm", "sub": "(r − mean_g) / (std_g + ε)", "shape": "A (B·G,)"}
      ],
      [{"id": "g-old", "label": "Old log-probs", "sub": "π_old · no_grad", "shape": "(B·G, L)"}],
      [{"id": "g-ref", "label": "Reference log-probs", "sub": "frozen π_ref · no_grad", "shape": "(B·G, L)"}]
    ]},
    {"tone": "dotted", "repeat": "μ ×", "label": "Inner steps, same rollouts", "items": [
      {"id": "g-logp", "label": "Policy log-probs", "kind": "attention", "sub": "π_θ · with graph"},
      {"id": "g-ratio", "label": "Ratio ρ", "sub": "exp(logp − old_logp)"},
      {"columns": [
        [{"id": "g-surr", "label": "Clipped surrogate", "sub": "min(ρA, clip(ρ, 1 ± ε)A)"}],
        [{"id": "g-kl", "label": "KL penalty, k3", "sub": "e^(ref−logp) − (ref−logp) − 1"}]
      ]},
      {"id": "g-loss", "label": "GRPO loss", "kind": "loss", "sub": "−surrogate + β · k3"},
      {"id": "g-step", "label": "AdamW step", "sub": "π_θ only"}
    ]}
  ],
  "notes": [
    {"at": "g-norm", "text": "**No value model**: the group is the baseline"},
    {"at": "g-surr", "text": "Clip **ε = 0.2**"},
    {"at": "g-kl", "text": "**β = 0.04**", "side": "left"}
  ]
}
:::

The four files map onto it directly: \`grpo_rollout\` draws the bottom two boxes and every log-prob,
\`grpo_advantage\` the reward and normalisation column, \`grpo_loss\` the inner frame, and \`grpo_train\`
the loop around all of it. The tensors that flow between them are small:

| tensor | shape | dtype | made by | graph |
|---|---|---|---|---|
| \`seqs\` | \`(B·G, P + L)\` | int64 | \`generate_group\` | no |
| \`mask\` | \`(B·G, L)\` | float32 | \`completion_mask\` | no |
| \`old_logp\`, \`ref_logp\` | \`(B·G, L)\` | float32 | \`token_logprobs\` under \`no_grad\` | no |
| \`rewards\`, \`advantages\` | \`(B·G,)\` | float32 | \`compute_rewards\`, \`group_advantages\` | no |
| \`logp\` | \`(B·G, L)\` | float32 | \`token_logprobs\` | yes |

With \`B = 32\`, \`G = 8\`, \`P = 4\` and \`L ≤ 3\`, one iteration handles 256 completions; the policy is a
26,573-parameter Transformer, and 200 iterations take about 6 s on one CPU thread.

# From PPO to GRPO: dropping the critic

[PPO](https://arxiv.org/abs/1707.06347) as used for RLHF keeps four models in memory: the policy being
trained, a frozen reference, a reward model, and a **value model** that predicts, for every prefix, the
reward the policy will eventually get. The value model turns one end-of-sequence reward into a
per-token advantage through [GAE](https://arxiv.org/abs/1506.02438). This is the pipeline GRPO starts
from:

:::architecture
{
  "input": "prompts q",
  "output": "updated π_θ and value model",
  "items": [
    {"id": "p-roll", "label": "Policy samples one answer", "kind": "attention", "sub": "o ~ π_old(· | q)"},
    {"columns": [
      [{"id": "p-rm", "label": "Reward model", "sub": "r(q, o) at the last token"}],
      [{"id": "p-ref", "label": "Reference model", "sub": "KL folded into the reward"}],
      [{"id": "p-value", "label": "Value model", "kind": "attention", "sub": "V(prefix) per token", "detail": "Same size as the policy, trained alongside it with its own loss and optimizer state."}]
    ]},
    {"id": "p-gae", "label": "GAE", "sub": "A_t from r, V, γ, λ", "detail": "Per-token advantages from temporal differences of the value estimates."},
    {"columns": [
      [{"id": "p-pol", "label": "Policy loss", "kind": "loss", "sub": "clipped surrogate"}],
      [{"id": "p-vloss", "label": "Value loss", "kind": "loss", "sub": "(V − return)²"}]
    ]}
  ],
  "notes": [
    {"at": "p-value", "text": "A **second** policy-sized network to train"},
    {"at": "p-gae", "text": "Per-token credit, only as good as **V**"}
  ]
}
:::

GRPO keeps PPO's clipped surrogate and changes what feeds it:

| | PPO (RLHF) | GRPO |
|---|---|---|
| samples per prompt | 1 | G (8 here, 64 in DeepSeekMath) |
| baseline | learned \`V(prefix)\` | mean reward of the group |
| advantage | per token, by GAE | one per completion, on every token |
| KL to the reference | subtracted from the reward | added to the loss (k3) |
| models in memory | policy, reference, reward, value | policy, reference (reward is a program here) |
| extra loss | value regression | none |

The trade is compute for memory and bias. A value model costs a policy-sized network plus its AdamW
state, and its errors become the advantages. A group costs G rollouts per prompt, but the baseline is
an unbiased Monte Carlo estimate of the expected reward for exactly that prompt. For language models the
trade is good: the reward comes once per completion, so a per-token critic has little to learn from, and
sampling is something an inference engine already does fast.

:::quiz
Q: What does GRPO use in place of PPO's value model?
- [ ] A smaller value head on top of the policy's last hidden state
- [x] The mean (and std) of the rewards of G completions sampled for the same prompt
- [ ] The reference model's log-probability of each completion
> The baseline is computed, not learned: sample G answers, score each, and judge each one against its
> siblings. No critic is trained, so there is no value loss and no second set of optimizer state.
:::

# Rollouts: groups, masks and log-probs

\`generate_group\` repeats each prompt G times with \`repeat_interleave(G, dim=0)\` and samples the
continuations together. That layout is the contract the rest of the code relies on:

:::gpu
{
  "layout": "column",
  "align": "start",
  "items": [
    {"id": "l-group0", "label": "Prompt 0 · 3 + 1 = · rows 0 to 3", "count": "A = 1.16 · .39 · −.39 · −1.16",
     "detail": "Rewards 1.5, 1.0, 0.5, 0: mean 0.75, unbiased std 0.65, A = (r − 0.75) / 0.65.",
     "items": [
      {"id": "l-seqs0", "array": "seqs[0:4]", "sub": "prompt | completion", "cols": 7, "rows": 4,
       "cells": ["3","+","1","=","4","E","E", "3","+","1","=","4","7","E", "3","+","1","=","2","E","E", "3","+","1","=","+","3","9"],
       "marks": [{"cols": [6, 6], "rows": [0, 0], "tone": "muted"}, {"cols": [6, 6], "rows": [2, 2], "tone": "muted"}],
       "detail": "E is EOS; a row that has stopped keeps receiving EOS (grey). Row 3 never stopped."},
      {"id": "l-mask0", "array": "mask[0:4]", "sub": "through 1st EOS", "cols": 3, "rows": 4,
       "cells": ["1","1","0", "1","1","1", "1","1","0", "1","1","1"],
       "marks": [{"cols": [2, 2], "rows": [0, 0], "tone": "muted"}, {"cols": [2, 2], "rows": [2, 2], "tone": "muted"}]},
      {"id": "l-r0", "array": "r", "sub": "reward", "cols": 1, "rows": 4, "cells": ["1.5", "1", ".5", "0"]}
    ]},
    {"id": "l-group1", "label": "Prompt 1 · 2 + 2 = · rows 4 to 7", "count": "flat: A = 0 · 0 · 0 · 0",
     "detail": "Every completion scored 1.5: std 0, every advantage 0, no policy gradient from this prompt.",
     "items": [
      {"id": "l-seqs1", "array": "seqs[4:8]", "sub": "prompt | completion", "cols": 7, "rows": 4,
       "cells": ["2","+","2","=","4","E","E", "2","+","2","=","4","E","E", "2","+","2","=","4","E","E", "2","+","2","=","4","E","E"],
       "marks": [{"cols": [6, 6], "rows": [0, 3], "tone": "muted"}]},
      {"id": "l-mask1", "array": "mask[4:8]", "sub": "through 1st EOS", "cols": 3, "rows": 4,
       "cells": ["1","1","0", "1","1","0", "1","1","0", "1","1","0"],
       "marks": [{"cols": [2, 2], "rows": [0, 3], "tone": "muted"}]},
      {"id": "l-r1", "array": "r", "sub": "reward", "cols": 1, "rows": 4, "cells": ["1.5", "1.5", "1.5", "1.5"]}
    ]}
  ]
}
:::

Three details decide whether the numbers downstream mean anything:

- **The mask includes the EOS.** Stopping is an action; a completion that stopped at the right time
  should get credit for it. Row 3 above never emitted EOS and was cut at \`max_new_tokens\`, so all three
  of its tokens count.
- **Log-probs at the sampling temperature.** The completions were drawn from \`softmax(logits / T)\`, so
  \`token_logprobs\` divides by the same \`T\` before \`log_softmax\`. Otherwise the ratio is not 1 at the
  first inner step, and the clipping engages before the policy has moved.
- **Shift by one.** The logits at position \`t\` predict token \`t + 1\`. The completion's \`L\` tokens are
  scored by the logits at \`P − 1 … P + L − 2\`, gathered at \`seqs[:, P:]\`.

How each mistake shows up:

| mistake | symptom |
|---|---|
| logits at \`P … P + L − 1\` (no shift) | each token is scored by the distribution of the token after it; the reward never rises |
| \`repeat(G, 1)\` instead of \`repeat_interleave\` | groups mix prompts; advantages compare answers to different questions |
| mask stops before the EOS | the policy is never credited for stopping; completions ramble to the budget |
| log-probs at \`T = 1\` after sampling at \`T = 0.7\` | the ratio starts away from 1 and \`clip_frac\` is high from step one |
| sampling with a graph | memory grows with every generated token, for gradients nobody uses |

The self-test checks \`token_logprobs\` the slow way: re-run the model on every prefix \`seqs[i, :P + t]\`
and read the last row. Agreement to \`1e-5\` proves both the shift and the causal mask.

:::quiz
Q: A completion is \`[4, EOS, EOS]\` with \`L = 3\`. Which positions does the mask keep?
- [ ] Only the digit, since EOS is not content
- [x] The digit and the first EOS, not the padding after it
- [ ] All three, since the loss averages over \`L\`
> The first EOS is a token the policy sampled, so it carries the completion's advantage like the digit.
> The second EOS was written by the rollout loop after the row finished; it was never sampled and must
> not be trained on.
:::

# Verifiable rewards and the group baseline

The reward is a program. DeepSeek-R1-Zero used two: an accuracy reward that checks the final answer and
a format reward that checks the answer is written in the expected tags. The toy task here has the same
shape, small enough for a 26k-parameter model to learn from scratch:

| completion of \`3 + 1 =\` | accuracy | format | reward |
|---|---|---|---|
| \`4 EOS\` | 1 | 1 | 1.5 |
| \`4 7 EOS\` | 1 | 0 | 1.0 |
| \`2 EOS\` | 0 | 1 | 0.5 |
| \`+ 3 9\` | 0 | 0 | 0.0 |

A uniform policy over the 13 tokens scores \`1/13 + 0.5 · 10/169 ≈ 0.107\`: low, but not zero, and that
matters more than anything else in the setup. The advantage of completion \`i\` in its group is

\`\`\`text
A_i = (r_i − mean(r_1..r_G)) / (std(r_1..r_G) + ε)        GRPO, ε = 1e-4, unbiased std
A_i =  r_i − mean(r_1..r_G)                                Dr. GRPO (scale=False)
\`\`\`

and it is given to every token of the completion. With one success in four, \`mean = 0.25\` and
\`std = 0.5\`, so the success gets \`+1.5\` and each failure \`−0.5\`; the group's advantages always sum to
zero. A group where every completion scored the same has \`r_i − mean = 0\` exactly, and the \`ε\` turns
\`0 / 0\` into \`0\`. Drag the slider to a probability near 0 or 1 to see flat groups appear, and compare
the two bar columns:

:::widget grpo-advantages {"G": 8, "p": 0.3}

**Dividing by the std is a choice.** It makes the update invariant to the reward's scale, which is why
DeepSeekMath uses it, but it also weighs prompts by difficulty. With binary rewards and G = 8:

| successes in 8 | std | A of a success, scaled | A of a success, mean only |
|---|---|---|---|
| 1 | 0.354 | 2.47 | 0.875 |
| 4 | 0.535 | 0.93 | 0.5 |
| 7 | 0.354 | 0.35 | 0.125 |

A prompt that is almost never or almost always solved has a small std, so dividing by it inflates its
advantages. [Dr. GRPO](https://arxiv.org/abs/2503.20783) argues this biases training towards the
extremes and drops the division; \`scale=False\` is that variant.

:::quiz
Q: Late in the run, 25 of the 32 groups in a batch scored the same reward on all 8 completions. What do those 25 prompts contribute to the policy-gradient term?
- [ ] Their reward times the mean log-prob, since every completion succeeded
- [x] Nothing: every advantage in a flat group is 0
- [ ] A large update, because the std of 0 makes the advantages blow up
> The advantage is relative: with every completion equal, \`r − mean = 0\`, and the \`ε\` keeps \`0 / 0\` at
> 0. Only the KL term still acts on those tokens. This is why DAPO's dynamic sampling over-samples and
> drops flat groups to keep the effective batch full.
:::

# The clipped objective and the KL penalty

Per completion token, with \`ρ = π_θ / π_old\` and the completion's advantage \`A\`, GRPO maximises PPO's
clipped surrogate and subtracts a KL penalty; \`grpo_loss\` returns the negative:

\`\`\`text
ρ        = exp(logp − old_logp)
surr     = min(ρ · A, clip(ρ, 1 − ε, 1 + ε) · A)
k3       = exp(ref_logp − logp) − (ref_logp − logp) − 1
loss_tok = −surr + β · k3                                   ε = 0.2, β = 0.04
\`\`\`

The minimum makes clipping **one-sided**. It only removes the gradient where the token has already moved
far enough in the direction the advantage wants:

| advantage | ratio | term that wins | gradient |
|---|---|---|---|
| A > 0 | ρ ≤ 1.2 | \`ρA\` | pushes ρ up |
| A > 0 | ρ > 1.2 | clipped | 0: far enough |
| A < 0 | ρ ≥ 0.8 | \`ρA\` | pushes ρ down |
| A < 0 | ρ < 0.8 | clipped | 0: far enough |
| A > 0 | ρ < 0.8 | \`ρA\` (smaller) | still pushes up: a mistake is always corrected |

The widget above draws both curves: the dashed parts are the flat, zero-gradient regions. At the first
inner step \`ρ = 1\` everywhere, the clip is inactive and the gradient of \`−ρA\` with respect to \`logp\` is
\`−A\`: plain REINFORCE with the group baseline. The self-test checks exactly that, then sets \`ρ = 1.5\`
and \`ρ = 0.5\` and checks which side loses its gradient.

**Why k3.** The KL between policy and reference over whole sequences is intractable, so it is estimated
from the sampled tokens. With \`r = π_ref(x) / π_θ(x)\` and \`x ~ π_θ\`, John Schulman's
[note on approximating KL](http://joschu.net/blog/kl-approx.html) compares three estimators:

| estimator | formula | unbiased | sign |
|---|---|---|---|
| k1 | \`−log r\` | yes | negative on about half the samples |
| k2 | \`½ (log r)²\` | no (low bias when close) | ≥ 0 |
| k3 | \`(r − 1) − log r\` | yes | ≥ 0 |

k3 is k1 plus \`r − 1\`, which has expectation 0 under \`π_θ\`, and is never negative because
\`log r ≤ r − 1\`. The self-test draws 400,000 tokens from a 5-way categorical and finds the k3 mean
within 1% of the exact KL (0.1405 against 0.1411). Its gradient with respect to \`logp\` is
\`1 − r\`: it pulls each sampled token's log-prob towards the reference's.

:::quiz
Q: A token has \`A = −1\` and its ratio has fallen to \`ρ = 0.5\` after two inner steps, with \`ε = 0.2\`. What does the surrogate do to it?
- [ ] Keeps pushing its probability down, since the advantage is negative
- [x] Nothing: the clipped term \`0.8 · (−1)\` is the minimum, and it has no gradient
- [ ] Pushes its probability back up towards \`ρ = 0.8\`
> \`min(0.5 · (−1), 0.8 · (−1)) = −0.8\` is the clipped, constant term. The token already moved further
> than the trust region allows in the direction its advantage asked, so the objective stops rewarding
> more movement. Clipping never pushes back; it only stops pushing.
:::

# Aggregation: whose tokens count

The per-token losses are averaged over the mask, and the order of the averages is a modelling choice.
GRPO's paper writes \`1/G Σ_i 1/|o_i| Σ_t\`: each completion's mean, then the mean over completions.
[DAPO](https://arxiv.org/abs/2503.14476) sums over every token and divides by the total.

\`\`\`text
seq-mean    loss = mean_i( Σ_t m_it · ℓ_it / Σ_t m_it )         GRPO
token-mean  loss = Σ_it m_it · ℓ_it / Σ_it m_it                 DAPO
dr_grpo     loss = Σ_it m_it · ℓ_it / (N · max_new_tokens)       Dr. GRPO, TRL's loss_type
\`\`\`

Under \`seq-mean\` a token's weight is \`1 / (N · |o_i|)\`: a token in a 1,000-token answer counts 1/1,000
as much as a 1-token answer. For a wrong answer (\`A < 0\`) that means long completions are penalised
less per token, so the policy learns that rambling is a cheaper way to be wrong. The self-test's
gradients make the weights visible:

| completion length | seq-mean gradient per token | token-mean gradient per token |
|---|---|---|
| 1 | \`−A / N\` | \`−A / T\` |
| 5 | \`−A / (5N)\` | \`−A / T\` |

(\`N\` completions, \`T\` unmasked tokens in the batch.) On the toy task completions are at most 3 tokens
and both settings learn; on reasoning traces of thousands of tokens the difference shows up as response
length drifting with the error rate.

:::quiz
Q: Under \`seq-mean\`, two wrong completions have the same advantage, one with 10 tokens and one with 1,000. How does the penalty on one token compare?
- [ ] Equal, since they share an advantage
- [x] The token in the 10-token completion is pushed down 100 times harder
- [ ] The token in the 1,000-token completion is pushed down harder, since it has more tokens
> \`seq-mean\` divides each completion's sum by its own length, so per-token weight is \`1/|o_i|\`. The
> long wrong answer is penalised less per token, which is the length bias Dr. GRPO and DAPO remove.
:::

# The loop, and why it learns

\`grpo_train\` is DeepSeekMath's Algorithm 1 at toy scale: copy the policy as the reference, then per
iteration sample prompts, roll out under \`no_grad\`, score \`old_logp\` and \`ref_logp\`, compute rewards
and advantages, and take μ = 2 AdamW steps on the same rollouts. The self-test's run (seed 0, one CPU
thread):

| iteration | mean reward (of 1.5) | flat groups (of 32) | mean k3 KL | clip fraction |
|---|---|---|---|---|
| 0 | 0.13 | 11 | 0.04 | 0.16 |
| 10 | 0.51 | 7 | 1.50 | 0.00 |
| 50 | 1.04 | 10 | 2.20 | 0.08 |
| 100 | 1.25 | 21 | 2.90 | 0.00 |
| 199 | 1.42 | 25 | 2.25 | 0.00 |

Greedy decoding then answers 24 of the 25 problems exactly. Three things in that table are general:

- **It learns because the start is not hopeless.** The random policy already earns a non-zero reward in
  some completions, so 21 of 32 groups carry signal at iteration 0. A task where the base model never
  succeeds produces only flat groups and zero gradient; this is why R1-Zero needed a strong base model,
  and why curricula and SFT warm-ups exist.
- **Success starves the gradient.** As the policy improves, more groups are all right; by the end 25 of
  32 prompts contribute nothing but KL. Larger G, harder prompts or dynamic sampling keep the batch
  informative.
- **The clip fraction is a health check.** It is 0 at every first inner step (\`ρ = 1\`) by
  construction; the table records the second step's. A rising clip fraction means the inner steps move
  the policy too far for the trust region, and the learning rate or μ should come down.

The KL to the reference grows to about 2 nats per token, large for an LLM, where the reference holds
everything pre-training taught. Here it holds nothing (a random init), and \`β = 0.04\` only slows the
drift. DAPO removes the KL term for verifiable-reward training, and TRL now defaults to \`beta = 0.0\`,
which skips loading the reference model at all.

:::quiz
Q: With \`mu = 1\`, what are the ratio and the clip fraction at every step?
- [x] The ratio is exactly 1 and nothing is ever clipped, so the update is REINFORCE with a group baseline plus the KL term
- [ ] The ratio drifts from 1 because the policy has been updated since sampling
- [ ] Undefined, since \`old_logp\` is never computed
> With one inner step the policy that is scored is the policy that sampled, so \`logp − old_logp = 0\`.
> Clipping only matters when μ > 1 reuses the rollouts after the policy has moved. TRL's default
> \`num_iterations = 1\` is this case.
:::

# What to take away

- GRPO is PPO's clipped surrogate with the value model replaced by a group of G samples per prompt: an
  answer's advantage is its reward relative to its siblings, given to every one of its tokens.
- The rollout's contract is three tensors: grouped rows, a mask through the first EOS, and per-token
  log-probs at the sampling temperature, shifted by one.
- Clipping is one-sided: it stops the gradient only after a token has moved far enough in the direction
  its advantage wants. k3 estimates the KL from sampled tokens without bias or negative values.
- Std normalisation and per-sequence averaging are choices with biases (difficulty, length); Dr. GRPO
  removes both, DAPO aggregates per token.
- RL with verifiable rewards needs a policy that sometimes succeeds: flat groups carry no gradient, at
  the start and again once the task is solved.

Primary source: Shao et al., [DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models](https://arxiv.org/abs/2402.03300) (2024), section 4, as implemented in TRL's [GRPOTrainer](https://huggingface.co/docs/trl/grpo_trainer).
`;
