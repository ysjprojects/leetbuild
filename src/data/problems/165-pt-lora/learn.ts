/**
 * The learning guide for the LoRA drill: the low-rank hypothesis, why B starts at zero, the alpha / r
 * scaling, merging for zero inference overhead, where the memory goes, and what QLoRA, DoRA and
 * multi-adapter serving add. Rendered at `/pt-lora/learn`.
 */
export const learn = `# The mechanism at a glance

LoRA — *Low-Rank Adaptation* (Hu et al., Microsoft, 2021) — fine-tunes a pre-trained model without touching
its weights. A selected \`nn.Linear\` keeps its weight \`W\` of shape \`(out, in)\` frozen, and next to it sit
two small trainable matrices: \`A\` of shape \`(r, in)\` and \`B\` of shape \`(out, r)\`, with the rank \`r\`
between 1 and 64. The layer computes

\`\`\`text
y = W x + b + (B A x) · alpha / r          A: (r, in) Kaiming   B: (out, r) zeros   scaling = alpha / r
\`\`\`

The drill implements this as \`LoRALinear(base, r, alpha, dropout=0.0)\` plus three functions:
\`apply_lora(model, target_names, r, alpha, dropout=0.0)\` swaps the named \`nn.Linear\` modules in place,
\`mark_only_lora_trainable(model)\` freezes everything without \`lora_\` in its name and returns the trainable
count, and \`lora_state_dict(model)\` returns the adapter checkpoint.

:::architecture
{"input": "x · (…, in)", "output": "y · (…, out)", "items": [
  {"tone": "dotted", "label": "LoRALinear(base, r, alpha)", "items": [
    {"columns": [
      [
        {"id": "base", "label": "Frozen base nn.Linear", "sub": "W (out, in) · b", "shape": "(…, out)", "detail": "\`base.requires_grad_(False)\`: \`W\` and \`b\` get no gradient and no optimizer state, and every adapter on this model shares them."}
      ],
      [
        {"id": "drop", "label": "Dropout", "sub": "adapter path only", "shape": "(…, in)"},
        {"id": "lora-a", "label": "lora_A", "kind": "attention", "sub": "(r, in) · Kaiming", "shape": "(…, r)", "detail": "\`x @ lora_A.T\`: down to \`r\` dimensions."},
        {"id": "lora-b", "label": "lora_B", "kind": "attention", "sub": "(out, r) · zeros", "shape": "(…, out)", "detail": "\`@ lora_B.T\`: back up to \`out\`. Zero at the start, so the branch adds 0."},
        {"id": "scale", "label": "Scale by alpha / r", "kind": "attention", "sub": "scaling = alpha / r"}
      ]
    ]},
    {"id": "add", "op": "+", "detail": "\`base(x) + (dropout(x) @ Aᵀ @ Bᵀ) · alpha / r\`; the dense \`B @ A\` is never formed in \`forward\`."}
  ]}
],
"notes": [
  {"at": "base", "text": "Frozen: no gradient, no Adam state", "side": "left"},
  {"at": "lora-a", "text": "Trainable: **r · (in + out)** scalars"},
  {"at": "lora-b", "text": "**B = 0**: the identity at step 0"},
  {"at": "add", "text": "merge(): W += B·A·alpha/r, then **one** matmul"}
]}
:::

Read it bottom to top: the input splits, the frozen path and the thin adapter path run side by side, and
they meet at the sum. \`lora_state_dict\` ships only \`lora_A\` and \`lora_B\`: megabytes, not gigabytes.

- **Frozen base.** \`base.requires_grad_(False)\`: \`W\` and \`b\` get no gradient and no optimizer state.
- **Identity at step 0.** \`B = 0\`, so the wrapped layer returns exactly what the original did.
- **Thin forward.** \`x @ Aᵀ\` is \`(…, r)\`, then \`@ Bᵀ\` is \`(…, out)\`; the dense \`B @ A\` is never formed in
  \`forward\`.
- **Exact merge.** \`W += B @ A · alpha / r\` turns the layer back into one \`nn.Linear\`; \`unmerge()\` subtracts it.
- **In-place surgery.** \`setattr\` on the parent module: the base weights are reused, never copied or
  re-initialised; parameter names become \`blocks.0.q_proj.lora_A\`.

# The low-rank hypothesis

Full fine-tuning learns a dense \`ΔW\` with \`in · out\` free entries for every layer. LoRA bets that the
change fine-tuning needs is far simpler than that: that \`ΔW\` has a low *intrinsic rank*. The bet rests on
[earlier work on intrinsic dimension](https://arxiv.org/abs/2012.13255) (Aghajanyan et al.), which tuned
RoBERTa to 90 % of full fine-tuning on MRPC by optimising only about 200 parameters projected randomly into
the full weight space: pre-training already did the hard part, and adapting to a task moves the weights in
very few directions.

Writing \`ΔW = B @ A\` caps its rank at \`r\` by construction and cuts the parameter count from \`in · out\` to
\`r · (in + out)\`:

| layer | full \`ΔW\` | LoRA \`r = 4\` | LoRA \`r = 16\` |
|---|---|---|---|
| \`q_proj\`, \`d = 128\` (the drill) | 16,384 | 1,024 | 4,096 |
| \`q_proj\`, \`d = 4096\` (a 7B model) | 16.8 M | 32,768 | 131,072 |
| \`q_proj\`, \`d = 12288\` (GPT-3 175B) | 151 M | 98,304 | 393,216 |

- In the drill, \`r = 4\` on \`q_proj\` and \`v_proj\` of two blocks trains \`4 · (4·128 + 128·4) = 4096\` of
  462,336 parameters: 0.89 %.
- The paper adapts only \`W_q\` and \`W_v\` of GPT-3 and finds very small ranks (1 to 8) match full
  fine-tuning on its benchmarks; a larger \`r\` buys little because the useful update lives in a few
  directions.
- It also reports that the learned \`ΔW\` amplifies directions already present but weak in \`W\` — the update
  re-weights features pre-training learned rather than adding new ones.
- The rank cap is a real constraint: tasks far from pre-training (a new language, a new modality) want
  larger \`r\` or full fine-tuning.

:::quiz
Q: Why does LoRA expect a rank-4 update to be enough for a 4096 × 4096 projection?
- [ ] Because attention weights are themselves rank 4
- [x] Because fine-tuning a pre-trained model moves its weights in very few directions, so the change has low intrinsic rank even when W does not
- [ ] Because larger ranks would not fit in GPU memory
> W is full-rank; the hypothesis is about ΔW. Pre-training has learned the features, and adapting to one task
> re-weights a handful of them, which a rank-r product can express with r · (in + out) parameters.
:::

# Why B starts at zero, and A does not

The update is a product, and a product of two matrices has a symmetry the initialisation has to break. With
\`h = A x\` of shape \`(r,)\`, upstream gradient \`g = ∂L/∂y\` and \`s = alpha / r\`:

\`\`\`text
∂L/∂B = s · g hᵀ  = s · g (A x)ᵀ          nonzero as soon as A is random
∂L/∂A = s · Bᵀ g xᵀ                        zero while B = 0
\`\`\`

| init | output at step 0 | first gradients | outcome |
|---|---|---|---|
| \`A\` random, \`B = 0\` (LoRA) | exactly the pre-trained model | \`B\` gets one, \`A\` does not | \`B\` moves on step 1, \`A\` from step 2 |
| \`A = 0\`, \`B = 0\` | pre-trained model | both zero | never moves |
| \`A\` random, \`B\` random | pre-trained model plus noise \`s · B A x\` | both | the first steps undo damage before learning |

Set the rank in the widget and watch what each factor costs, and why the zero \`B\` keeps the layer's
output untouched at step 0:

:::widget lora-rank

- The paper initialises \`A\` with a random Gaussian; the drill uses \`nn.init.kaiming_uniform_(a=math.sqrt(5))\`,
  the same init \`nn.Linear\` gives its weight and Hugging Face PEFT's default. Either works: what matters
  is that \`A\` is random and \`B\` is zero.
- Zero \`B\` makes \`apply_lora\` a no-op on the model's function — the drill asserts \`torch.equal\` on the
  logits before and after wrapping. Training starts from the pre-trained loss, not from a perturbed one.
- The roles could be swapped (\`A = 0\`, \`B\` random); the convention is \`B = 0\` so that \`A\` acts as a
  random projection of the input into \`r\` dimensions from the first step.

:::quiz
Q: Both lora_A and lora_B are initialised to zero. What happens in training?
- [ ] The adapter trains normally, just more slowly at first
- [ ] Only lora_B trains
- [x] Neither moves: the gradient of each is proportional to the other, so both stay exactly zero
> ∂L/∂B depends on A x and ∂L/∂A depends on B. With both zero every gradient is zero, AdamW's update is zero,
> and the adapter is the identity forever. One random factor breaks the symmetry; zero B keeps step 0 exact.
:::

# The alpha / r scaling

The update is multiplied by \`scaling = alpha / r\`. \`alpha\` is a constant chosen once, often \`2r\` or
\`16\`; the paper sets it to the first \`r\` tried and never tunes it. The reason is Adam: it moves every
entry of \`B\` by about \`lr\` per step whatever the gradient's size, so the change in \`B A x\` grows with the
number of rank components contributing to it. Dividing by \`r\` keeps the size of the update roughly
independent of the rank, and a learning rate found at one \`r\` carries to another.

| \`r\` | \`alpha = 16\` → scaling | trainable per \`d = 4096\` projection |
|---|---|---|
| 4 | 4.0 | 32,768 |
| 8 | 2.0 | 65,536 |
| 16 | 1.0 | 131,072 |
| 64 | 0.25 | 524,288 |

- In the drill \`r = 8, alpha = 16\` gives \`scaling == 2.0\`; the self-test asserts it.
- With \`B = 0\`, \`alpha\` does not change the output at step 0 — it changes how fast \`ΔW\` grows, which is
  why it behaves like a second learning rate.
- At large ranks \`1/r\` over-shrinks: rsLoRA (Kalajdzievski, 2023) shows the stable choice is
  \`alpha / sqrt(r)\`, which PEFT exposes as \`use_rslora=True\`.
- Dropout on the adapter's input — \`self.dropout(x)\` before \`lora_A\` — regularises only the adapter path;
  the frozen path sees the clean \`x\`.

:::quiz
Q: You double r from 8 to 16 and keep alpha = 16. What happens to the scaling, and why is that intended?
- [ ] It doubles, so the larger adapter has more influence
- [x] It halves, which offsets the larger number of rank components Adam moves at once and keeps the update size, and the tuned learning rate, roughly unchanged
- [ ] It stays at 2.0, because alpha is fixed
> scaling = alpha / r = 16 / 16 = 1.0. Adam moves each entry by about lr regardless of r, so more components
> mean a larger change in B A x; dividing by r cancels that, which is why alpha need not be retuned per rank.
:::

# Merging: zero inference overhead

\`ΔW = B @ A · scaling\` is an ordinary \`(out, in)\` matrix, so after training it can be added into \`W\`.
The adapted layer becomes a plain \`nn.Linear\` again: one matmul per call, the original latency, the
original memory. This is the property that separates LoRA from bottleneck adapters, which insert extra
layers that stay in the forward pass.

\`\`\`python
@torch.no_grad()
def merge(self):
    if self.merged:
        return
    self.base.weight += (self.lora_B @ self.lora_A) * self.scaling
    self.merged = True
\`\`\`

:::architecture
{"output": "a plain nn.Linear again", "items": [
  {"columns": [
    [
      {"id": "m-w", "label": "Frozen W", "sub": "(out, in)"}
    ],
    [
      {"id": "m-ab", "label": "lora_B @ lora_A", "kind": "attention", "sub": "(out, r) @ (r, in) → (out, in)"},
      {"id": "m-scale", "label": "Scale by alpha / r", "kind": "attention", "sub": "ΔW"}
    ]
  ]},
  {"id": "m-add", "op": "+", "detail": "\`self.base.weight += ΔW\` under \`torch.no_grad()\`, guarded by \`merged\`."},
  {"id": "m-merged", "label": "Merged weight W + ΔW", "sub": "base(x) alone · same latency"}
],
"notes": [
  {"at": "m-add", "text": "In place, under **no_grad**, once: the flag guards it"}
]}
:::

The fold is guarded by the \`merged\` flag, and \`unmerge()\` is its exact inverse:

| call | \`merged\` before | effect on \`W\` | \`forward(x)\` after |
|---|---|---|---|
| \`merge()\` | False | \`W += ΔW\` | \`base(x)\` alone |
| \`merge()\` | True | none, a no-op | \`base(x)\` alone |
| \`unmerge()\` | True | \`W -= ΔW\`, the original \`W\` | \`base(x)\` plus the adapter path |
| \`unmerge()\` | False | none, a no-op | \`base(x)\` plus the adapter path |

- **The flag is the correctness.** Without \`merged\`, a second \`merge()\` adds \`ΔW\` twice, and an unmerged
  forward after a merge adds it twice through the adapter path.
- **No autograd.** \`W\` is a leaf, so the in-place add runs under \`torch.no_grad()\`; merging is not
  a training operation.
- **Precision.** In float64 the round trip is exact to \`1e-12\` and the merged output matches to \`1e-6\`; in
  float32 the whole drill model matches to \`1e-5\`. In bf16, \`W += ΔW\` rounds the small update to \`W\`'s
  coarse grid (8 significant bits) and unmerge no longer restores \`W\` — merge once, in higher precision,
  when writing the final checkpoint.
- **When not to merge.** A server hosting many adapters on one base cannot merge them all into one \`W\`;
  it keeps them separate and pays the two thin matmuls per request (see below).

:::quiz
Q: Why does a merged LoRA model cost nothing extra at inference?
- [ ] Because the adapter matmuls run in parallel with the base matmul
- [x] Because B @ A · alpha / r is a plain (out, in) matrix added into W, so the layer is a single nn.Linear again
- [ ] Because r is small, so the extra work is negligible
> Unmerged, every call pays x @ Aᵀ @ Bᵀ on top of W x — small, but extra kernels and latency. Merged, the
> update lives inside W and the model is architecturally identical to the base.
:::

# Where the memory goes, and what production adds

The savings come from the optimizer, not the forward pass. Full fine-tuning in mixed precision with AdamW
stores about 16 bytes per parameter; LoRA stores the frozen weight and 16 bytes only per adapter
parameter. For a 7B model with \`r = 16\` on \`q_proj\` and \`v_proj\` (32 layers, \`d = 4096\`, about 8.4 M
adapter parameters):

| per parameter | full fine-tune | LoRA, frozen base | LoRA, per adapter parameter |
|---|---|---|---|
| weight | 2 B (bf16) | 2 B (bf16) | 2 B |
| gradient | 2 B | — | 2 B |
| fp32 master + two Adam moments | 12 B | — | 12 B |
| total for 7B | ≈ 112 GB | ≈ 14 GB | ≈ 134 MB |

- Activations are not saved: the backward pass still runs through the frozen layers to reach earlier
  adapters, so it computes input gradients everywhere and skips only the weight gradients.
- The checkpoint shrinks the same way. The paper reports GPT-3's 350 GB checkpoint becoming about 35 MB of
  adapter and a 3× drop in training VRAM; the drill's adapter checkpoint is eight tensors that
  \`load_state_dict(…, strict=False)\` puts back into a fresh \`apply_lora\`'d model.
- **QLoRA.** [Dettmers et al., 2023](https://arxiv.org/abs/2305.14314) store the frozen base in 4-bit
  NormalFloat and dequantise it on the fly in the forward pass, so a 65B model fine-tunes on one 48 GB
  GPU; the adapters stay in bf16 and cannot be merged into 4-bit weights without re-quantising.
- **DoRA.** [Liu et al., 2024](https://arxiv.org/abs/2402.09353) split \`W\` into a magnitude vector and a
  direction, apply LoRA to the direction and train the magnitude separately; it closes much of the gap to
  full fine-tuning at the same rank and still merges.
- **Serving many adapters.** S-LoRA, Punica and vLLM keep one base model resident and batch requests for
  hundreds of unmerged adapters with a gather-matmul kernel — the case where not merging is the point.
- **Libraries.** [Hugging Face PEFT](https://huggingface.co/docs/peft/main/en/conceptual_guides/lora)
  implements exactly this surgery: \`LoraConfig(r, lora_alpha, lora_dropout, target_modules)\`,
  \`get_peft_model\`, \`merge_and_unload()\`.

:::quiz
Q: LoRA cuts training memory for a 7B model from about 112 GB to about 14 GB plus activations. What does it remove?
- [ ] The activations, because frozen layers do not need them
- [x] The gradients, fp32 master weights and Adam moments of the frozen weights — 14 of every 16 bytes per base parameter
- [ ] Nothing at training time; the savings are only in the checkpoint
> A frozen parameter needs only its bf16 copy. Gradients and optimizer state exist for the 8 M adapter
> parameters alone. Activations still have to be kept, because backpropagation passes through the frozen layers.
:::

# What to take away

- Freeze \`W\`; learn \`ΔW = B @ A · alpha / r\` with \`A\` \`(r, in)\` and \`B\` \`(out, r)\` — \`r · (in + out)\`
  parameters instead of \`in · out\`, because fine-tuning updates have low intrinsic rank.
- \`B = 0\` and random \`A\`: the adapter is the identity at step 0 and the product's symmetry is broken; two
  zero factors never train.
- \`alpha / r\` keeps the update size, and the learning rate, roughly independent of the rank.
- Multiply through \`A\` then \`B\` while training; fold \`B @ A\` into \`W\` once, under \`no_grad\` and a flag,
  for zero-overhead inference.
- The savings are gradients and optimizer state for frozen weights and a megabyte-scale checkpoint;
  QLoRA quantises the base, DoRA reparameterises the update, multi-adapter servers skip the merge.

Primary reference: Hu et al., [LoRA: Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685) (ICLR 2022).
`;
