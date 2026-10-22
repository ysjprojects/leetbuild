/**
 * The learning guide for the causal-attention drill: scaled dot-product attention from Vaswani et al., why
 * 1/sqrt(d), heads as subspaces, the causal mask and why it goes before the softmax, a float32 softmax, the
 * [B, H, T, T] memory that FlashAttention removes, and what SDPA's backends add. Rendered at
 * `/pt-causal-attention/learn`.
 */
export const learn = `# The mechanism at a glance

Attention is the layer that lets a token read other tokens. Vaswani et al. introduced it as the whole
model in [*Attention Is All You Need*](https://arxiv.org/abs/1706.03762); every decoder-only LLM since —
GPT-2, LLaMA, Mistral — is a stack of blocks whose first half is the *causal* version: position \`t\` reads
positions \`0..t\` and nothing after it. The drill implements
\`CausalSelfAttention(d_model, n_heads, dropout=0.0, max_len=1024)\` with \`forward(x, attn_mask=None)\`,
\`x\` of shape \`[B, T, d_model]\`, returning the same shape.

:::diagram
{
  "nodes": [
    {"id": "x", "kind": "client", "label": "x", "sub": "[B, T, d_model] · float32, bfloat16 or float64", "x": 6, "y": 50},
    {"id": "qkv", "kind": "service", "label": "qkv", "sub": "one Linear(D, 3D) · split · heads as a view", "x": 28, "y": 50},
    {"id": "attn", "kind": "service", "label": "scores → softmax", "sub": "q @ kᵀ / √hd · -inf where masked · float32 softmax", "x": 52, "y": 50},
    {"id": "mask", "kind": "db", "label": "causal_mask", "sub": "tril buffer · not trained · not saved", "x": 52, "y": 85},
    {"id": "proj", "kind": "service", "label": "probs @ v → proj", "sub": "merge heads · Linear(D, D)", "x": 76, "y": 50},
    {"id": "ref", "kind": "external", "label": "F.scaled_dot_product_attention", "sub": "the reference: is_causal=True, 1e-5", "x": 96, "y": 50}
  ],
  "edges": [
    {"from": "x", "to": "qkv", "kind": "plain", "label": "x"},
    {"from": "qkv", "to": "attn", "kind": "plain", "label": "q, k, v [B, H, T, hd]"},
    {"from": "mask", "to": "attn", "kind": "plain", "label": "tril[:T, :T] & attn_mask"},
    {"from": "attn", "to": "proj", "kind": "plain", "label": "probs [B, H, T, T]"},
    {"from": "proj", "to": "ref", "kind": "plain", "label": "self-test"}
  ]
}
:::

The whole layer, with \`H = n_heads\` and \`hd = d_model // n_heads\`:

\`\`\`text
q, k, v = split(x @ W_qkv + b, D)                 [B, T, D] each
q, k, v → view(B, T, H, hd).transpose(1, 2)       [B, H, T, hd]
S = q @ kᵀ / √hd                                  [B, H, T, T]
S = S.masked_fill(~(tril & key_mask), -inf)
P = dropout(softmax(S, dim=-1) in float32)        rows sum to 1 over keys 0..t
O = (P @ v).transpose(1, 2).contiguous().view(B, T, D)
y = O @ W_proj + b
\`\`\`

- The causal mask is \`torch.tril(torch.ones(max_len, max_len, dtype=torch.bool))\`, a non-persistent
  buffer; \`forward\` slices \`[:T, :T]\`.
- \`attn_mask\` is optional \`[B, T]\` bool, \`True\` for a real key; padding is on the right, so no row is
  fully masked.
- The reference is \`F.scaled_dot_product_attention(q, k, v, is_causal=True)\` through the same weights,
  to \`atol=rtol=1e-5\`; it is forbidden inside the module.

# Scaled dot-product: why divide by the square root

A query \`q_t\` scores every key with a dot product; the softmax turns scores into weights; the output is
the weighted sum of values. The question is the scale. If the entries of \`q\` and \`k\` have mean 0 and
variance 1, then \`q · k\` is a sum of \`hd\` such products, with variance \`hd\`. At \`hd = 128\` the scores
have a standard deviation around 11, and a softmax over numbers that far apart is nearly one-hot.

| head_dim | std of q·k (unscaled) | after / √hd | softmax of a row |
|---|---|---|---|
| 8 | ≈ 2.8 | ≈ 1 | soft |
| 64 | 8 | ≈ 1 | soft |
| 128 | ≈ 11.3 | ≈ 1 | one-hot without the scale |

- A saturated softmax has gradient ≈ 0 everywhere except the winner: the layer stops learning which keys
  matter.
- Dividing by \`√hd\` restores unit variance whatever the head width — the paper's stated reason.
- In code: \`(q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)\` or \`* self.head_dim ** -0.5\`.
- The scale is applied to the scores, before the mask: \`-inf\` scaled is still \`-inf\`, so the order of
  those two does not matter; their order relative to the softmax does.

:::quiz
Q: Why is the scale √hd rather than hd?
- [ ] √hd is cheaper to compute on a GPU
- [x] The variance of a sum of hd unit-variance products is hd, so the standard deviation is √hd
- [ ] Dividing by hd would make the attention non-causal
> Dividing by the standard deviation brings the scores back to unit scale. Dividing by hd would shrink them towards 0 and make every row nearly uniform — the opposite failure.
:::

# Heads are subspaces, and a reshape

Multi-head attention runs \`H\` independent attentions of width \`hd\` instead of one of width \`D\`. Each
head can attend to a different position for a different reason — one tracks the previous token, another
the subject of the sentence — and the output projection mixes what they found. The cost is the same as one
wide head: the FLOPs of \`q @ kᵀ\` are \`B · H · T² · hd = B · T² · D\` either way.

In the drill a head is not a module; it is a slice of the embedding:

| tensor | shape | how |
|---|---|---|
| \`self.qkv(x)\` | \`[B, T, 3D]\` | one fused GEMM, \`x\` read once |
| \`q\` after \`split(D, dim=-1)\` | \`[B, T, D]\` | a view |
| \`.view(B, T, H, hd)\` | \`[B, T, H, hd]\` | no copy |
| \`.transpose(1, 2)\` | \`[B, H, T, hd]\` | strides only |
| \`q @ k.transpose(-2, -1)\` | \`[B, H, T, T]\` | one batched matmul over \`B × H\` |
| \`(P @ v).transpose(1, 2).contiguous()\` | \`[B, T, H, hd]\` | the only copy |
| \`.view(B, T, D)\` | \`[B, T, D]\` | heads side by side again |

- The fused \`nn.Linear(d_model, 3 * d_model)\` is one launch and one read of \`x\` instead of three.
- \`.contiguous()\` is needed because \`transpose\` only changes strides and \`view\` requires memory in
  order; \`reshape\` would copy implicitly.
- \`d_model % n_heads == 0\` is asserted: a head is an exact slice.

:::quiz
Q: What does splitting D into H heads change about the cost of the score matmul?
- [ ] It multiplies the FLOPs by H
- [x] Nothing in FLOPs — B·H·T²·hd equals B·T²·D — but the score tensor is H times larger
- [ ] It divides the memory of the scores by H
> The arithmetic is unchanged, but each head has its own T×T matrix: the scores and probabilities are [B, H, T, T], which is where the memory goes.
:::

# The causal mask, and why it goes before the softmax

Causality is what makes one forward pass train every next-token prediction at once: row \`t\` of the
output must depend on tokens \`0..t\` only. The mask is the lower triangle; the place it is applied is the
whole point. Fill masked scores with \`-inf\`, then softmax: \`exp(-inf) = 0\` exactly, the future gets no
probability, and the denominator sums over the past alone.

:::sequence
{
  "participants": ["forward", "causal_mask", "softmax", "probs @ v"],
  "messages": [
    {"from": "forward", "to": "forward", "label": "S = q @ kᵀ / √hd — row t holds scores for keys 0..T−1", "kind": "sync"},
    {"from": "forward", "to": "causal_mask", "label": "tril[:T, :T] & attn_mask[:, None, None, :]", "kind": "sync"},
    {"from": "causal_mask", "to": "forward", "label": "S.masked_fill(~mask, -inf)", "kind": "reply"},
    {"from": "forward", "to": "softmax", "label": "softmax(S, dim=-1) in float32", "kind": "sync"},
    {"from": "softmax", "to": "forward", "label": "P[t, s] = 0 for s > t, row sums to 1 over 0..t", "kind": "reply"},
    {"from": "forward", "to": "probs @ v", "label": "dropout(P) @ v — the future contributes nothing", "kind": "sync"}
  ]
}
:::

The failure: mask the *probabilities* instead.

:::sequence
{
  "participants": ["forward", "softmax", "mask after", "probs @ v"],
  "messages": [
    {"from": "forward", "to": "softmax", "label": "softmax(S) over all T keys, future included", "kind": "sync"},
    {"from": "softmax", "to": "forward", "label": "P[t, s] = exp(S[t, s]) / Σ over 0..T−1", "kind": "reply"},
    {"from": "forward", "to": "mask after", "label": "P.masked_fill(~tril, 0)", "kind": "sync"},
    {"from": "mask after", "to": "forward", "label": "future weights zeroed — but the denominator still summed them", "kind": "reply"},
    {"from": "forward", "to": "probs @ v", "label": "row t sums to < 1, by an amount set by tokens after t", "kind": "sync"},
    {"from": "probs @ v", "to": "forward", "label": "output at t changes when token t+1 changes: the future leaks", "kind": "reply"}
  ]
}
:::

- The leak is quiet: shapes are right, loss goes down, and the model learns to read the next token through
  the normaliser. At generation time that token does not exist and quality collapses.
- The self-test catches it directly: perturb token 5 and positions \`0..4\` must not move.
- A large finite constant (\`-1e4\`) is not a mask: \`exp(-1e4 + max)\` is not zero once scores are large, and
  in bfloat16 \`-1e4\` is representable but not "minus infinity".
- The padding mask masks *keys* — columns — via \`attn_mask[:, None, None, :]\`, ANDed with the tril. With
  right padding every query still sees itself, so no row is all \`-inf\` (that row would softmax to NaN).
- The mask is a buffer, not a parameter: it moves with \`.to(device)\`, nothing trains it, and
  \`persistent=False\` keeps it out of the \`state_dict\`.

:::quiz
Q: A model masks with P.masked_fill(~tril, 0) after the softmax. What goes wrong?
- [ ] Nothing — the future weights are zero either way
- [x] The normaliser still includes future scores, so the output at t depends on tokens after t
- [ ] The softmax produces NaN on the first row
> Zeroing a probability after normalisation does not remove its score from the denominator. Row t's remaining weights are scaled by a sum over the future: information leaks.
:::

# Softmax in float32

Mixed-precision training runs the matmuls in bfloat16, but the softmax is a reduction over a row that can
be thousands long, and bfloat16 keeps 8 bits of mantissa.

| dtype | mantissa bits | smallest step near 1.0 | what a long row loses |
|---|---|---|---|
| bfloat16 | 8 | ≈ 0.0078 | most of 4096 small probabilities |
| float16 | 11 | ≈ 0.001 | less, but exp overflows past 65504 |
| float32 | 24 | ≈ 1.2e-7 | nothing that matters |

\`\`\`python
probs = torch.softmax(scores, dim=-1,
                      dtype=torch.promote_types(scores.dtype, torch.float32)).to(v.dtype)
\`\`\`

- \`promote_types\` gives float32 for half inputs and leaves float64 alone, so \`gradcheck\` in float64 runs
  the same code path.
- \`torch.softmax\` subtracts the row max internally, so \`exp\` never overflows; \`-inf\` entries stay 0.
- Cast back to \`v.dtype\` so \`probs @ v\` runs in the model's compute dtype.

:::details Dropout on probabilities
\`nn.Dropout(dropout)\` sits between the softmax and \`probs @ v\`: it zeroes whole attention edges and
rescales the rest by \`1/(1−p)\`, so rows no longer sum to exactly 1 in training. In \`eval()\` it is the
identity — the self-test checks that — and large LLMs usually train with \`dropout=0.0\` anyway.
:::

:::quiz
Q: Why does the drill pass dtype=promote_types(scores.dtype, torch.float32) rather than dtype=torch.float32?
- [ ] float32 is not supported by torch.softmax
- [x] So a float64 input is not downcast, which gradcheck needs
- [ ] It makes the softmax faster on bfloat16
> promote_types upcasts bfloat16/float16 to float32 and keeps float64 at float64; a hard float32 would lose precision in the float64 gradcheck.
:::

# The T² memory, and what production adds

This module materialises the full score matrix, and that is its limit. \`[B, H, T, T]\` grows with the
square of the context:

| T | H | scores per sample (bfloat16) |
|---|---|---|
| 1024 | 32 | 64 MiB |
| 8192 | 32 | 4 GiB |
| 32768 | 32 | 64 GiB |

Training also keeps the probabilities for backward and computes their gradient, and each of scores,
softmax and \`probs @ v\` is a round trip through HBM. The arithmetic is cheap; the memory traffic is the
cost.

:::sequence
{
  "participants": ["HBM", "this module", "FlashAttention kernel", "SRAM"],
  "messages": [
    {"from": "this module", "to": "HBM", "label": "write S [B, H, T, T]", "kind": "sync"},
    {"from": "HBM", "to": "this module", "label": "read S → softmax → write P", "kind": "reply"},
    {"from": "HBM", "to": "this module", "label": "read P → P @ v", "kind": "reply"},
    {"from": "FlashAttention kernel", "to": "SRAM", "label": "load a q tile; stream k, v tiles", "kind": "sync"},
    {"from": "SRAM", "to": "FlashAttention kernel", "label": "online softmax: running max and sum, rescale partial O", "kind": "reply"},
    {"from": "FlashAttention kernel", "to": "HBM", "label": "write O [B, H, T, hd] only — O(T) memory", "kind": "sync"}
  ]
}
:::

- [FlashAttention-2](https://arxiv.org/abs/2307.08691) never writes \`S\` or \`P\`: it tiles, keeps per-row
  max and sum, and recomputes probabilities in backward from those statistics.
- With \`is_causal=True\` the kernel skips upper-triangle tiles entirely instead of computing and masking
  them — about half the work.
- [\`F.scaled_dot_product_attention\`](https://pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
  dispatches to FlashAttention, the memory-efficient kernel, or a math fallback equivalent to this file,
  depending on dtype, mask shape and device.
- Real decoders add a KV cache (past \`k\`, \`v\` kept; one query row per step), grouped-query attention
  (fewer \`k\`/\`v\` heads), RoPE on \`q\` and \`k\` before the scores, and \`torch.compile\` to fuse the reshapes.

:::quiz
Q: What does FlashAttention change relative to this module?
- [ ] The result — it is an approximation of attention
- [x] Where the scores live: tiles in SRAM with an online softmax, so the [B, H, T, T] tensor is never stored
- [ ] The causal mask is applied after the softmax
> FlashAttention computes exact attention; it reorders the computation so memory is O(T) and HBM traffic drops, which is why SDPA prefers it.
:::

# What to take away

- Attention is \`softmax(q kᵀ / √hd) v\`; the \`√hd\` keeps scores at unit scale so the softmax does not
  saturate.
- Heads are a view of the embedding: one fused qkv GEMM, one batched matmul over \`B × H\`, one copy to merge.
- The causal mask is \`-inf\` *before* the softmax; masking after leaks the future through the denominator.
- Run the softmax in float32 (or wider) and cast back.
- The \`[B, H, T, T]\` score tensor is the cost that FlashAttention and SDPA exist to remove.

Primary reference: Vaswani et al., [*Attention Is All You Need*](https://arxiv.org/abs/1706.03762).
`;
