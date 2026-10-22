/**
 * The learning guide for the mixture-of-experts drill: what a sparse MoE layer is and where it sits in
 * Switch Transformer, Mixtral and DeepSeek; the top-k router as an unlabelled classifier; the Switch
 * load-balancing loss and the collapse it prevents; capacity and dropped tokens; dispatching per expert
 * with gathers and index_add_ rather than per token — a figure or a table where one says it faster than
 * prose, a pop quiz per section. Rendered at `/pt-moe-router/learn`.
 */
export const learn = `# The mechanism at a glance

A transformer block is attention followed by a feed-forward network (FFN), and the FFN holds most of
the parameters. A **mixture of experts** (MoE) replaces that one FFN with \`E\` of them — the *experts* —
and a tiny **router** that sends each token to the \`k\` experts it scores highest. Every token still
pays for \`k\` FFNs of compute, but the model carries \`E\` FFNs of parameters: Switch Transformer trained
1.6 T parameters at the cost of a 1 B dense model, Mixtral 8×7B activates 2 of 8 experts per token,
DeepSeek-V3 activates 8 of 256. The layer the drill builds is the one those models share:

:::architecture
{"input": "h · (B, S, D) = (2, 16, 32)", "items": [
  {"tone": "block", "label": "Transformer block · MoE", "items": [
    {"id": "ln1", "label": "LayerNorm 1", "kind": "norm"},
    {"id": "attn", "label": "Masked self-attention", "sub": "dense · every token"},
    {"id": "add1", "op": "+", "from": "ln1"},
    {"id": "ln2", "label": "LayerNorm 2", "kind": "norm"},
    {"tone": "dotted", "label": "MoE layer · the FFN slot", "items": [
      {"id": "gate", "label": "Router gate", "kind": "attention", "sub": "nn.Linear D → E · float32", "shape": "logits (T, E)"},
      {"id": "topk", "label": "Softmax, top-k, renormalise", "kind": "attention", "sub": "idx, weights (T, k)", "detail": "Softmax over the \`E\` experts, \`torch.topk\`, and the \`k\` probabilities divided by their sum."},
      {"id": "dispatch", "label": "Dispatch under capacity", "kind": "attention", "sub": "where(idx == e)[:capacity]", "side": {"label": "Capacity", "sub": "⌈cf · T · k / E⌉"}},
      {"columns": [
        [{"id": "expert-0", "label": "Expert 0", "kind": "ffn", "sub": "D → d_ff → D"}],
        [{"id": "expert-1", "label": "Expert 1", "kind": "ffn", "sub": "D → d_ff → D"}],
        [{"id": "expert-e", "label": "… Expert E − 1", "kind": "ffn", "sub": "D → d_ff → D"}]
      ]},
      {"id": "combine", "label": "Weighted sum", "kind": "attention", "sub": "index_add_(0, tok, w · out)"}
    ]},
    {"id": "add2", "op": "+", "from": "ln2", "detail": "\`h + moe(norm(h))\`: the block's residual, not the layer's."}
  ]},
  {"id": "loss", "label": "Training loss", "kind": "loss", "sub": "LM loss + α · aux", "side": {"label": "Load-balancing aux", "sub": "E · Σ_e f_e · P_e"}}
],
"notes": [
  {"at": "topk", "text": "Each token pays for **k** experts; the model stores **E**"},
  {"at": "dispatch", "text": "Overflow beyond capacity is **dropped**"},
  {"at": "combine", "text": "Gate weights carry the gradient to the router"},
  {"at": "loss", "text": "aux = **1** balanced, **E** collapsed"},
  {"at": "add2", "text": "A dropped token rides the residual", "side": "left"}
]}
:::

Read it bottom to top: the block is a dense transformer block whose feed-forward slot now holds a router
and \`E\` experts, and the router's auxiliary loss joins the training loss.

The contract the drill implements:

- \`TopKRouter(d_model, n_experts, k, z_loss_coef=0.0)\`: \`(T, D)\` → \`(idx (T, k), weights (T, k), aux)\`.
  Logits in float32, softmax over experts, \`torch.topk\`, the \`k\` probabilities renormalised to sum to 1.
- \`aux = n_experts · Σ_e f_e · P_e\` — the Switch load-balancing loss — plus
  \`z_loss_coef · mean(logsumexp(logits)²)\` when the coefficient is positive.
- \`MoE(d_model, d_ff, n_experts, k, capacity_factor=1.25, z_loss_coef=0.0)\`: \`(B, S, D)\` → \`(y, aux)\`.
  \`capacity = ceil(capacity_factor · T · k / n_experts)\` slots per expert; one loop over experts, each
  run once on the tokens it won; the outputs scattered back with \`index_add_\`, weighted by the gate.
- A token that overflowed every expert it chose leaves a zero row in \`y\`. The layer never adds its own
  input: the block's residual \`h + moe(norm(h))\` is what carries a dropped token on.

# Routing: a classifier nobody labels

The router is a linear map from the token to one score per expert, and a softmax turns the scores into
a distribution. Top-k keeps the \`k\` largest and renormalises so a token's weights still sum to 1:

\`\`\`text
logits  = x · Wgᵀ                    (T, D) · (D, E) → (T, E), computed in float32
probs   = softmax(logits, dim=-1)    (T, E)
p, idx  = topk(probs, k)             (T, k) each
weights = p / p.sum(-1, keepdim)     (T, k), rows sum to 1
\`\`\`

| Tensor | Shape | dtype | What it is |
| --- | --- | --- | --- |
| \`gate.weight\` | \`(E, D)\` | float32 | the only trainable parameter of the router — 4 × 32 numbers in the drill |
| \`probs\` | \`(T, E)\` | float32 | soft routing; the gradient path into the gate |
| \`idx\` | \`(T, k)\` | int64 | hard routing; which experts run |
| \`weights\` | \`(T, k)\` | float32 | how much of each chosen expert's output the token keeps |

- **Float32 for the gate.** The model may run in bf16, but a softmax over experts decides a discrete
  choice, and a 3-digit mantissa flips choices between runs. Every production router upcasts here.
- **Renormalise after top-k.** With \`E = 8\`, \`k = 2\` and probabilities 0.3 and 0.2 on the two winners,
  the token would otherwise keep only half its output. Dividing by their sum makes the combine a convex
  mix of the chosen experts' outputs.
- **The gate learns through the weights.** Nothing labels "this token should go to expert 3". The only
  dense gradient is \`∂loss/∂weights\`: if expert 3's output helped, its weight grows, so its probability
  grows, so the token (and tokens like it) keep choosing it. The hard \`idx\` has no gradient at all.
- **z-loss.** If the logits drift large the softmax saturates and \`∂probs/∂logits\` vanishes — the router
  freezes. [ST-MoE](https://arxiv.org/abs/2202.08906) adds \`mean(logsumexp(logits)²)\` with a coefficient
  around \`1e-3\` to keep the logits near zero; it is an optional term in the drill's \`aux\`.

:::quiz
Q: Why is the gate computed in float32 even when the rest of the model runs in bfloat16?
- [ ] nn.Linear does not support bfloat16
- [x] The softmax decides a discrete choice; bf16 rounding flips which expert wins and makes routing unstable
- [ ] float32 makes the aux loss exactly 1
> The choice is argmax-like: two experts with probabilities 0.251 and 0.249 are the same number in bf16's 8-bit mantissa. Upcasting the few numbers of the gate costs nothing and keeps the top-k decision deterministic and smooth to train.
:::

# The load-balancing loss

Left alone, a router collapses. The [Switch Transformer](https://arxiv.org/abs/2101.03961) paper
describes why: an expert that received slightly more tokens early trains slightly faster, so its
outputs help slightly more, so the gate sends it more tokens. The rich get richer until one expert is
the model and the others are untouched parameters:

| training step | expert 0's share | experts 1 to 3 | what happens |
|---|---|---|---|
| 1 | 30 %, a little above 25 % | 70 % shared | expert 0 gets more gradient, so its outputs improve |
| 1,000 | 80 % | 20 % | the combine weights reward expert 0, so the gate raises its logit |
| 10,000 | 100 % | 0 %, barely trained, so never chosen | a dense model with \`E − 1\` dead experts |

The fix is a loss that is small when the load is even and large when it is not. The difficulty is
that the thing you want to balance — how many tokens each expert *got* — is a count, and counts have
no gradient. Switch (building on GShard) pairs the count with the one thing that does:

\`\`\`text
f_e = (number of the T·k routing slots that went to e) / (T·k)     hard, no gradient
P_e = mean over tokens of probs[:, e]                               soft, differentiable
aux = E · Σ_e f_e · P_e
\`\`\`

| Routing | \`f\` (E = 4) | \`P\` | \`aux\` |
| --- | --- | --- | --- |
| uniform — zeroed gate | any (ties broken by topk) | \`(¼, ¼, ¼, ¼)\` | \`4 · Σ f_e / 4 = 1\` |
| even load, confident gate | \`(¼, ¼, ¼, ¼)\` | \`≈ (¼, ¼, ¼, ¼)\` | \`≈ 1\` |
| everything to expert 0 | \`(1, 0, 0, 0)\` | \`≈ (1, 0, 0, 0)\` | \`≈ 4\` |
| 80 % to expert 0, rest spread | \`(0.8, 0.07, 0.07, 0.07)\` | \`≈ f\` | \`≈ 2.6\` |

- **The gradient flows through** \`P\`, in the direction \`f\` points. \`∂aux/∂P_e = E · f_e\`: the crowded
  expert gets the largest push *down* on its mean probability, the empty ones get none. The hard
  count decides *where* to push; the soft probability is *what* moves.
- **The factor** \`E\` **normalises the optimum to 1** whatever the expert count, so one coefficient (Switch
  uses \`α = 0.01\`) works from 8 experts to 256. The drill returns \`aux\` unscaled; the training loop
  adds \`α · aux\` to the language-modelling loss.
- **Measured per batch of tokens.** \`f\` and \`P\` are means over the \`T\` tokens in the forward pass, so
  the loss balances this batch, not a running average. Production trainers also sum a copy per device
  and per sequence.

Skew the routing in the widget: the loss sits at 1 while the load is even and climbs toward \`E\` as one
expert takes over.

:::widget moe-routing {"experts": 4, "k": 2}

:::details Why not just penalise the counts?
Because a count is a step function of the logits: nudging a logit by ε changes nothing until the
argmax flips, then changes the count by one. Its gradient is zero almost everywhere. Replacing the
count with the probability in one factor keeps the loss differentiable while the other factor —
the count — keeps it honest about what actually happened. Expected-value arguments in the Switch paper
show the product is minimised when both are uniform.
:::

:::quiz
Q: With a zeroed gate every token's softmax is uniform, yet topk breaks the tie by sending every token to the same first k experts. What is the aux loss?
- [x] Exactly 1 — P is uniform, so E · Σ f_e · (1/E) = Σ f_e = 1 whatever f is
- [ ] About E — the hard assignment is fully collapsed
- [ ] 0 — the loss only counts mismatches between f and P
> The loss is bilinear. When P is exactly 1/E everywhere the sum collapses to Σ f_e, which is 1 by construction. The collapsed f only matters once P follows it — which is precisely the drift the loss then penalises.
:::

# Capacity: why some tokens are dropped

In a real model the experts are not in one process. Expert parallelism puts expert \`e\` on device \`e\`,
and the dispatch is an **all-to-all**: every device sends its tokens to the devices that own their
experts. An all-to-all needs fixed-size buffers, known before the routing is, so each expert accepts a
fixed number of slots per forward pass:

\`\`\`text
capacity = ceil(capacity_factor · T · k / E)
\`\`\`

| \`T\` | \`k\` | \`E\` | factor | capacity | meaning |
| --- | --- | --- | --- | --- | --- |
| 32 | 2 | 4 | 1.0 | 16 | exactly the even share: any imbalance drops |
| 32 | 2 | 4 | 1.25 | 20 | the default: 25 % slack before dropping |
| 32 | 1 | 4 | 0.5 | 4 | the drill's drop test: an expert with 14 tokens keeps 4, drops 10 |
| 4096 | 2 | 8 | 1.25 | 1280 | a production batch at Mixtral's shape |

- **Which tokens are dropped is a policy.** The drill keeps the first \`capacity\` tokens *in token order*
  — \`torch.where(idx == e)\` returns row-major, so slicing \`[:capacity]\` keeps the earliest. Switch does
  the same; some trainers randomise the order so later positions are not systematically dropped.
- **A dropped slot contributes nothing**, and a token dropped by all \`k\` of its experts gets a zero row
  from the layer. It is not lost: the transformer block computes \`h + moe(norm(h))\`, and \`h\` carries
  it unchanged to the next layer. That is why the layer must not add its input itself — the residual
  belongs to the block, and adding it twice would double every routed token.
- **The capacity factor is a dial between waste and loss.** Below 1 some tokens always drop even under
  perfect balance; above 1.25 most buffers sit mostly empty. Training commonly uses 1.25 and inference
  2.0, where dropping a token hurts more than padding a buffer.

One expert of the drill's drop test, with a capacity of 4 and 14 tokens that chose it:

:::architecture
{"input": "idx (32, 1) · k = 1, capacity_factor 0.5", "items": [
  {"id": "c-where", "label": "where(idx == 1)", "kind": "attention", "sub": "14 tokens, in token order"},
  {"columns": [
    [
      {"id": "c-keep", "label": "Keep tok[:4]", "kind": "attention", "sub": "capacity = ⌈0.5 · 32 · 1 / 4⌉ = 4"},
      {"id": "c-expert", "label": "Expert 1", "kind": "ffn", "sub": "one (4, D) call"},
      {"id": "c-add", "label": "index_add_ into y", "kind": "attention", "sub": "weights[tok, slot] · out"}
    ],
    [
      {"id": "c-drop", "label": "Drop tok[4:]", "kind": "loss", "sub": "10 tokens · no write"}
    ]
  ]},
  {"id": "c-y", "label": "y", "kind": "io", "sub": "4 rows filled · 10 rows stay zero"}
],
"notes": [
  {"at": "c-drop", "text": "Their rows stay **0**; the residual carries them"}
]}
:::

:::quiz
Q: A token's only expert dropped it. What does the next transformer layer see for that position?
- [ ] A zero vector
- [x] The token's residual stream h unchanged, because the block adds the layer's zero output to h
- [ ] The output of the least-loaded expert, used as a fallback
> The MoE layer returns a zero row for the token; the block's residual connection adds that zero to h. The token skips one FFN and continues — the same thing a residual does for any sub-layer whose output is zero.
:::

# Dispatch per expert, not per token

The naive layer loops over tokens: for each token, for each of its \`k\` slots, call the expert on one
row. It is the reference the drill checks against, and it is the wrong shape for a GPU — \`T · k\`
tiny matmuls with no reuse of the expert weights. The layer instead loops over the \`E\` experts and
gives each one **all** its tokens at once:

\`\`\`python
y = torch.zeros_like(tokens)                                   # (T, D)
for e, expert in enumerate(self.experts):
    tok, slot = torch.where(idx == e)                          # token ids, and which slot chose e
    tok, slot = tok[:capacity], slot[:capacity]
    out = expert(tokens[tok])                                  # one (n_e, D) matmul per expert
    y.index_add_(0, tok, out * weights[tok, slot].unsqueeze(-1))
\`\`\`

- \`torch.where\` on the \`(T, k)\` index tensor is the gather: \`tok\` are the rows to pull from \`tokens\`,
  \`slot\` picks the right weight from \`weights[tok, slot]\`.
- \`tokens[tok]\` is an index gather — one copy of \`n_e · D\` floats — and
  [\`index_add_\`](https://docs.pytorch.org/docs/stable/generated/torch.Tensor.index_add_.html) is the
  scatter back; a token with two slots gets two adds into the same row, which is the combine.
- Both are differentiable: autograd routes \`∂y\` back through \`index_add_\` to \`out\` and to \`weights\`,
  and from \`weights\` through the renormalisation and the softmax into \`gate.weight\`. That is the
  gradient the drill's last test checks for.

| Version | Expert calls | Weight reads per expert | Python iterations |
| --- | --- | --- | --- |
| per token (reference) | \`T · k\` | once per token routed to it | \`T · k\` |
| per expert (the drill) | \`E\` | once | \`E\` |
| fused (Megatron, MegaBlocks) | 1 grouped matmul | once | 0 |

What production adds: a sort of the tokens by expert so all gathers become one *permute*, the
all-to-all across devices, and either a padded per-expert batch or — in
[MegaBlocks](https://arxiv.org/abs/2211.15841) — a block-sparse matmul whose blocks are exactly the
tokens each expert received, which removes the capacity and the dropping entirely.
[Mixtral](https://arxiv.org/abs/2401.04088) ships this router with \`k = 2\` of \`E = 8\` and the same
renormalised softmax weights; DeepSeek-V3 keeps the top-k but replaces the auxiliary loss with a
per-expert bias that a load counter nudges up or down between steps, so balancing never competes
with the language-modelling gradient.

:::quiz
Q: Why does the vectorised layer match the per-token reference exactly, dropped tokens included?
- [ ] Both drop tokens at random with the same seed
- [x] torch.where returns tokens in row-major order, so the first capacity entries per expert are the same tokens the per-token loop's counter admits first
- [ ] The reference does not drop tokens; the test only compares kept rows
> The per-token loop walks tokens in order and admits each until an expert's counter hits capacity. where(idx == e) lists that expert's tokens in the same order, so [:capacity] admits exactly the same set. Any other order would make the two disagree on which rows are zero.
:::

# What to take away

- **An MoE layer is a router plus E FFNs.** Softmax over experts in float32, top-k, renormalised
  weights; every token pays for \`k\` experts and the model stores \`E\`.
- **The router trains on the combine weights alone, so it collapses unless balanced.** The Switch loss
  \`E · Σ f_e · P_e\` pairs the non-differentiable count with the differentiable mean probability; 1 at
  the optimum, \`E\` when collapsed; the z-loss keeps the logits from saturating the softmax.
- **Capacity makes the dispatch a fixed-size buffer.** \`ceil(cf · T · k / E)\` slots per expert, the first
  in token order kept, the rest dropped to a zero row that the block's residual carries through.
- **Loop over experts, gather, run once, scatter.** \`where(idx == e)\`, \`tokens[tok]\`, one matmul,
  \`index_add_\` weighted by \`weights[tok, slot]\` — the same answer as the per-token loop and \`E\` calls
  instead of \`T · k\`.
- **Frameworks fuse the rest.** Permute/all-to-all/unpermute across devices, grouped or block-sparse
  matmuls, dropless routing and bias-based balancing — none of which change what the router computes.

The primary reference is Fedus, Zoph and Shazeer's
[*Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity*](https://arxiv.org/abs/2101.03961),
whose equations 4–6 are the load-balancing loss and whose section 2.2 defines the capacity factor and
the dropped-token residual path built here.
`;
