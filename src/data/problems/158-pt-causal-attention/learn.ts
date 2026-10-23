/**
 * The learning guide for the causal-attention drill: scaled dot-product attention from Vaswani et al., why
 * 1/sqrt(d), heads as subspaces, the causal mask and why it goes before the softmax, a float32 softmax, the
 * [B, H, T, T] memory that FlashAttention removes, and what SDPA's backends add. Rendered at
 * `/pt-causal-attention/learn`.
 */
export const learn = `# The mechanism at a glance

Attention is the layer that lets a token read other tokens. Vaswani et al. introduced it as the whole
model in [*Attention Is All You Need*](https://arxiv.org/abs/1706.03762); every decoder-only LLM since then
(GPT-2, LLaMA, Mistral) is a stack of blocks whose first half is the *causal* version: position \`t\` reads
positions \`0..t\` and nothing after it. The drill implements
\`CausalSelfAttention(d_model, n_heads, dropout=0.0, max_len=1024)\` with \`forward(x, attn_mask=None)\`,
\`x\` of shape \`[B, T, d_model]\`, returning the same shape.

It is the first sublayer of every decoder block; the figure opens it up on the right.

:::architecture
{
  "input": "token and position embeddings",
  "output": "to the next block",
  "items": [
    {"tone": "block", "repeat": "N ×", "label": "Decoder block", "items": [
      {"id": "ln1", "label": "LayerNorm 1", "kind": "norm", "detail": "Pre-norm: the sublayer sees a normalised copy of the residual stream."},
      {"id": "attn", "label": "Causal self-attention", "kind": "attention", "sub": "this drill · H heads × hd", "shape": "[B, T, D]", "detail": "\`CausalSelfAttention(d_model, n_heads)\`: fused qkv, heads as a view, scaled scores, the tril mask as \`-inf\`, a float32 softmax, \`probs @ v\`, output projection."},
      {"id": "add1", "op": "+", "from": "ln1", "detail": "\`x = x + attn(ln_1(x))\`"},
      {"id": "ln2", "label": "LayerNorm 2", "kind": "norm"},
      {"id": "mlp", "label": "Feed forward", "kind": "ffn", "sub": "D → 4D → D", "detail": "Applied to every position on its own: the only place tokens mix is the attention below it."},
      {"id": "add2", "op": "+", "from": "ln2", "detail": "\`x = x + mlp(ln_2(x))\`"}
    ]}
  ],
  "notes": [
    {"at": "attn", "text": "Position t reads keys **0..t**", "side": "left"},
    {"at": "add1", "text": "Residual stream", "side": "left"}
  ],
  "insets": [
    {"for": "attn", "title": "CausalSelfAttention", "items": [
      {"id": "in-qkv", "label": "Fused QKV projection", "sub": "Linear(D, 3D) · split · heads"},
      {"id": "in-scores", "label": "Scaled dot product", "kind": "attention", "sub": "q · kᵀ / √hd"},
      {"id": "in-mask", "label": "Causal mask", "kind": "attention", "sub": "tril → −inf"},
      {"id": "in-softmax", "label": "Softmax in float32", "kind": "attention"},
      {"id": "in-wsum", "label": "Weighted sum of values", "sub": "probs @ v · merge heads"},
      {"id": "in-proj", "label": "Output projection", "sub": "Linear(D, D)"}
    ], "note": "Scores of **[B, H, T, T]**, materialised on purpose"}
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
- Dividing by \`√hd\` restores unit variance whatever the head width: the paper's stated reason.
- In code: \`(q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)\` or \`* self.head_dim ** -0.5\`.
- The scale is applied to the scores, before the mask: \`-inf\` scaled is still \`-inf\`, so the order of
  those two does not matter; their order relative to the softmax does.

:::quiz
Q: Why is the scale √hd rather than hd?
- [ ] √hd is cheaper to compute on a GPU
- [x] The variance of a sum of hd unit-variance products is hd, so the standard deviation is √hd
- [ ] Dividing by hd would make the attention non-causal
> Dividing by the standard deviation brings the scores back to unit scale. Dividing by hd would shrink them towards 0 and make every row nearly uniform: the opposite failure.
:::

# Heads are subspaces, and a reshape

Multi-head attention runs \`H\` independent attentions of width \`hd\` instead of one of width \`D\`. Each
head can attend to a different position for a different reason (one tracks the previous token, another
the subject of the sentence), and the output projection mixes what they found. The cost is the same as one
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
- [x] Nothing in FLOPs (B·H·T²·hd equals B·T²·D), but the score tensor is H times larger
- [ ] It divides the memory of the scores by H
> The arithmetic is unchanged, but each head has its own T×T matrix: the scores and probabilities are [B, H, T, T], which is where the memory goes.
:::

# The causal mask, and why it goes before the softmax

Causality is what makes one forward pass train every next-token prediction at once: row \`t\` of the
output must depend on tokens \`0..t\` only. The mask is the lower triangle; the place it is applied is the
whole point. Fill masked scores with \`-inf\`, then softmax: \`exp(-inf) = 0\` exactly, the future gets no
probability, and the denominator sums over the past alone.

Toggle the mask in the heatmap below: with it on, row \`t\` puts all its weight on keys \`0..t\`, the upper
triangle is empty, and every row still sums to 1.

:::widget attention-heatmap {"causal": true}

## A worked example: three tokens

Take \`T = 3\` and one head with \`hd = 4\`, so the scale is \`1/√4 = 1/2\`. Let the keys be one-hot, so each
raw score \`q_t · k_j\` is just entry \`j\` of \`q_t\`, and give each token a one-number value:

\`\`\`text
q0 = [2, 0, 4, 0]    k0 = [1, 0, 0, 0]    v0 = 3
q1 = [0, 2, 2, 0]    k1 = [0, 1, 0, 0]    v1 = 6
q2 = [2, 4, 6, 0]    k2 = [0, 0, 1, 0]    v2 = 9
\`\`\`

Each step, row by row (row \`t\` is query \`t\`, column \`j\` is key \`j\`):

| step | row 0 | row 1 | row 2 |
|---|---|---|---|
| raw \`q · kᵀ\` | 2, 0, 4 | 0, 2, 2 | 2, 4, 6 |
| \`S = q · kᵀ / 2\` | 1, 0, 2 | 0, 1, 1 | 1, 2, 3 |
| tril mask | ✓, ✗, ✗ | ✓, ✓, ✗ | ✓, ✓, ✓ |
| \`masked_fill(-inf)\` | 1, −inf, −inf | 0, 1, −inf | 1, 2, 3 |
| softmax | 1, 0, 0 | 0.269, 0.731, 0 | 0.090, 0.245, 0.665 |
| \`P @ v\` | 3 | 5.19 | 7.73 |

Row 1 by hand: \`exp(0) = 1\`, \`exp(1) = 2.718\`, \`exp(-inf) = 0\`; the sum is 3.718, so the weights are
\`1/3.718 = 0.269\` and \`2.718/3.718 = 0.731\`, and the output is \`0.269 · 3 + 0.731 · 6 = 5.19\`. Token 0
sees only itself and returns its own value, 3, although its query scores key 2 highest.

The failure: mask the *probabilities* instead. Softmax the full rows of \`S\`, then zero the upper triangle:

| query t | mask, then softmax | row sum | softmax, then mask | row sum | \`P @ v\` |
|---|---|---|---|---|---|
| 0 | 1, 0, 0 | 1 | 0.245, 0, 0 | 0.245 | 0.73 (should be 3) |
| 1 | 0.269, 0.731, 0 | 1 | 0.155, 0.422, 0 | 0.578 | 3.00 (should be 5.19) |
| 2 | 0.090, 0.245, 0.665 | 1 | 0.090, 0.245, 0.665 | 1 | 7.73 |

Row 0 keeps only 0.245 because its denominator still summed \`exp\` over keys 1 and 2. Raise the score of key
2 in row 0 from 2 to 4 and the leaked output at position 0 drops from 0.73 to 0.14: position 0 now depends on
token 2. The future leaks through the normaliser.

- The leak is quiet: shapes are right, loss goes down, and the model learns to read the next token through
  the normaliser. At generation time that token does not exist and quality collapses.
- The self-test catches it directly: perturb token 5 and positions \`0..4\` must not move.
- A large finite fill (\`-1e4\`, or \`torch.finfo(dtype).min\` as Hugging Face uses) also gives 0 in practice,
  because \`exp\` underflows to exactly 0 in float32 once a score sits about 104 below the row max. The
  difference is a row with *no* visible key: \`-inf\` softmaxes it to NaN, which you notice; a finite fill
  softmaxes it to a uniform row over padding, which you don't.
- The padding mask masks *keys* (columns) via \`attn_mask[:, None, None, :]\`, ANDed with the tril. With right
  padding every query still sees key 0, so no row is all \`-inf\`.
- The mask is a buffer, not a parameter: it moves with \`.to(device)\`, nothing trains it, and
  \`persistent=False\` keeps it out of the \`state_dict\`.

:::quiz
Q: A model masks with P.masked_fill(~tril, 0) after the softmax. What goes wrong?
- [ ] Nothing: the future weights are zero either way
- [x] The normaliser still includes future scores, so the output at t depends on tokens after t
- [ ] The softmax produces NaN on the first row
> Zeroing a probability after normalisation does not remove its score from the denominator. Row t's remaining weights are scaled by a sum over the future: information leaks.
:::

# Softmax in float32

Mixed-precision training runs the matmuls in bfloat16, but the softmax ends in a sum over a row that can be
thousands of keys long, and a sum is where low precision fails. Once the running total is large, each new
small term falls below half a step of the total and is rounded away. Summing \`exp(s - max)\` over a
4096-key row of random scores (std 2), one term at a time:

| dtype | significand bits | step near 1.0 (eps) | error of the row sum |
|---|---|---|---|
| bfloat16 | 8 | 0.0078 | −32 % (every probability 1.5× too large) |
| float16 | 11 | 0.00098 | −8 % |
| float32 | 24 | 1.2e-7 | ≈ 1e-7 |

\`\`\`python
probs = torch.softmax(scores, dim=-1,
                      dtype=torch.promote_types(scores.dtype, torch.float32)).to(v.dtype)
\`\`\`

- \`dtype=\` casts the input before the softmax, so the max, the \`exp\` and the sum all run in float32.
  PyTorch's own softmax kernel already accumulates half inputs in float32 (on CPU the two calls give
  bit-identical bfloat16 results), so here the argument states the contract; the failure it rules out is a
  hand-written \`exp(s) / exp(s).sum()\` in bfloat16. \`torch.autocast\` on CUDA runs \`softmax\` in float32
  for the same reason.
- \`promote_types\` gives float32 for half inputs and leaves float64 alone. A hard \`dtype=torch.float32\`
  makes the float64 \`gradcheck\` fail with a Jacobian mismatch.
- \`torch.softmax\` subtracts the row max internally, so \`exp\` never overflows; \`-inf\` entries stay 0.
- Cast back to \`v.dtype\` so \`probs @ v\` runs in the model's compute dtype.

:::details Dropout on probabilities
\`nn.Dropout(dropout)\` sits between the softmax and \`probs @ v\`: it zeroes whole attention edges and
rescales the rest by \`1/(1−p)\`, so rows no longer sum to exactly 1 in training. In \`eval()\` it is the
identity (the self-test checks that), and large LLMs usually pretrain with \`dropout=0.0\` anyway. SDPA has no
mode: its \`dropout_p\` drops whenever it is above 0, so a module that calls it passes
\`dropout_p=self.dropout if self.training else 0\`, as nanoGPT does.
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

The same layer as a fused kernel moves very different bytes:

| | this module | a FlashAttention kernel |
|---|---|---|
| scores \`S\`, \`[B, H, T, T]\` | written to HBM, read back for the softmax | one tile at a time in SRAM, never written |
| probabilities \`P\` | written to HBM, read back for \`P @ v\` | computed per tile and folded into the output |
| softmax | over a whole row at once | online: a running max and sum per row, the partial \`O\` rescaled |
| written to HBM | \`S\`, \`P\` and \`O\` | \`O\` only, \`[B, H, T, hd]\` |
| memory beyond q, k, v | \`O(T²)\` | \`O(T)\` |

- [FlashAttention-2](https://arxiv.org/abs/2307.08691) never writes \`S\` or \`P\`: it tiles, keeps per-row
  max and sum, and recomputes probabilities in backward from those statistics.
- With \`is_causal=True\` the kernel skips upper-triangle tiles entirely instead of computing and masking
  them: about half the work.
- [\`F.scaled_dot_product_attention\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
  dispatches to FlashAttention-2, the memory-efficient kernel, cuDNN attention, or a C++ math fallback
  equivalent to this file, depending on dtype, mask and device. It refuses \`attn_mask\` and \`is_causal\`
  together, which is why the self-test builds the full tril-and-padding mask itself.
- Real decoders add a KV cache (past \`k\`, \`v\` kept; one query row per step), grouped-query attention
  (fewer \`k\`/\`v\` heads), RoPE on \`q\` and \`k\` before the scores, and \`torch.compile\` to fuse the reshapes.
  The cache breaks \`is_causal=True\`: for a non-square \`[1, T]\` score matrix SDPA aligns the triangle to the
  top left, so the one new query sees key 0 only. Decode steps pass \`is_causal=False\` (the new token may
  read every cached key).

:::quiz
Q: What does FlashAttention change relative to this module?
- [ ] The result: it is an approximation of attention
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
