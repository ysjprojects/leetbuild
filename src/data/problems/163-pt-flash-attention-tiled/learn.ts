/**
 * The learning guide for tiled attention with an online softmax: where FlashAttention's algorithm
 * comes from, why the score matrix is the thing to avoid, the rescaling that makes streaming exact,
 * the causal mask inside a tile, and what the real kernel adds on top of the loop written here.
 * Rendered at `/pt-flash-attention-tiled/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

Attention over \`q\`, \`k\`, \`v\` of shape \`[B, H, T, hd]\` is \`softmax(q kᵀ / √hd) v\`. The textbook version
builds the \`[T, T]\` score matrix, takes a softmax over each row, and multiplies by \`v\`.
[FlashAttention](https://arxiv.org/abs/2205.14135) (Dao et al., 2022) computes the same output without the
matrix: it walks the keys in tiles and keeps, per query row, three numbers that are enough to finish the softmax
later — the largest score seen so far, the sum of exponentials under that max, and the output accumulated under
that max. The drill writes that loop in PyTorch:

\`flash_attention(q, k, v, block_q, block_k, causal=True) -> out\` — scores exist only as
\`[B, H, block_q, block_k]\` tiles, the causal mask is applied inside a tile, tiles entirely after the query
tile are skipped, the arithmetic is float32, and \`torch.autograd.gradcheck\` passes through the loop.

:::diagram
{
  "nodes": [
    {"id": "inputs", "kind": "client", "label": "q · k · v", "sub": "[B, H, T, hd] · T = 37 in the self-test", "x": 6, "y": 50},
    {"id": "qloop", "kind": "service", "label": "query tiles", "sub": "rows q0:q1 · one output tile each", "x": 30, "y": 50},
    {"id": "kloop", "kind": "service", "label": "key/value tiles", "sub": "s = q kᵀ/√hd · mask · p = exp(s − m_new)", "x": 54, "y": 50},
    {"id": "stats", "kind": "db", "label": "m · l · o", "sub": "running max · running sum · accumulator", "x": 78, "y": 26},
    {"id": "ref", "kind": "external", "label": "F.scaled_dot_product_attention", "sub": "the fused kernel the test compares against", "x": 78, "y": 74}
  ],
  "edges": [
    {"from": "inputs", "to": "qloop", "kind": "plain", "label": "q[:, :, q0:q1]"},
    {"from": "qloop", "to": "kloop", "kind": "plain", "label": "k, v [k0:k1] · skip if k0 ≥ q1"},
    {"from": "kloop", "to": "stats", "kind": "plain", "label": "alpha = exp(m − m_new) · l, o rescaled"},
    {"from": "stats", "to": "qloop", "kind": "plain", "label": "o / l"},
    {"from": "inputs", "to": "ref", "kind": "plain", "label": "allclose(atol=1e-5) · gradcheck"}
  ]
}
:::

- **Outer loop** over query tiles of \`block_q\` rows; the last tile is shorter when \`T\` is not a multiple.
- **Inner loop** over key/value tiles of \`block_k\` rows: one small matmul, one mask, one exponential, one
  rescale of the statistics.
- **Statistics** \`m\` (starts \`-inf\`), \`l\` (starts 0) and \`o\` (starts 0) live per query row, shaped
  \`[B, H, block_q, 1]\` and \`[B, H, block_q, hd]\`; the tile's output is \`o / l\` after the last key tile.
- **Exactness**: the result equals the three-op version to rounding; nothing is approximated.

# Why the score matrix is the thing to avoid

The matmuls in attention are not the bottleneck; the traffic around the score matrix is. A GPU's high-bandwidth
memory (HBM) holds the tensors; the on-chip SRAM each streaming multiprocessor works from is a few hundred
kilobytes. The naive version writes \`s\` to HBM, reads it back for the softmax, writes \`p\`, reads it back for
the multiply by \`v\` — every pass over \`T²\` numbers.

| T | B·H | scores in float32 | one 128 × 128 tile per head |
| --- | --- | --- | --- |
| 4 096 | 32 | 2.1 GB | 2 MB total |
| 32 768 | 32 | 137 GB | 2 MB total |
| 37 (the self-test) | 6 | 33 KB | one \`[8, 8]\` tile: 1.5 KB |

The FLOPs are the same either way — \`4 · B · H · T² · hd\` for \`q kᵀ\` and \`p v\`, half of it under a causal mask
— and they grow as \`T²\` regardless. What tiling changes is the **bytes**: the kernel loads a tile of \`q\`, \`k\`
and \`v\` into SRAM, computes the tile of scores there, folds it into \`m\`, \`l\` and \`o\`, and never writes the
scores anywhere. Memory for intermediates becomes \`O(T · block_k)\` per batch-head in flight instead of
\`O(T²)\`, which is the difference between a 32k context fitting on one device and not.

In PyTorch the same loop does not save bandwidth — every tensor still lives in device memory — but it has the
same shape, and the self-test pins the one property a reader can check without a profiler: wrapped in a
\`TorchFunctionMode\` that inspects every result, no op ever returns a tensor ending in \`[T, T]\`.

:::quiz
Q: Tiling does not reduce the number of multiply-adds in attention. Why is it still faster on a GPU?
- [ ] The tiles are small enough for the tensor cores to skip the zeros under the causal mask
- [x] The score matrix is never written to or read back from HBM; the work is bound by memory traffic, not arithmetic
- [ ] Each tile is computed in lower precision
> Attention at long context is memory-bound: a naive implementation moves the [T, T] matrix through HBM several times. Keeping each tile in SRAM and folding it into three per-row statistics removes that traffic; the FLOPs are unchanged.
:::

# The online softmax: finishing a row you have not seen

A softmax row needs its maximum before any exponential is taken, or \`exp\` overflows. Streaming over tiles
means the max of the row is not known until the last tile. The [online softmax](https://arxiv.org/abs/1805.02867)
(Milakov & Gimelshein, 2018) resolves this with one identity: a sum of exponentials under one max can be
converted to the same sum under a larger max by one multiplication.

\`\`\`
l under m_old   =  Σ exp(s_j − m_old)
l under m_new   =  exp(m_old − m_new) · Σ exp(s_j − m_old)   =  alpha · l
\`\`\`

The same factor applies to the accumulator, because \`o\` is \`Σ p_j · v_j\` with the same \`p_j\`. So each key
tile does:

\`\`\`python
m_new = torch.maximum(m, s.amax(dim=-1, keepdim=True))
alpha = torch.exp(m - m_new)          # 1 when the max did not move, < 1 when it did, 0 on the first tile
p     = torch.exp(s - m_new)
l     = alpha * l + p.sum(dim=-1, keepdim=True)
o     = alpha * o + p @ v_tile
m     = m_new
\`\`\`

A row whose scores arrive as \`[1, 3]\` then \`[5, 2]\`:

| After tile | m | l | compare with the one-shot sum |
| --- | --- | --- | --- |
| \`[1, 3]\` | 3 | \`e⁻² + e⁰ = 1.1353\` | — |
| \`[5, 2]\` | 5 | \`e⁻² · 1.1353 + e⁰ + e⁻³ = 1.2035\` | \`e⁻⁴ + e⁻² + e⁰ + e⁻³ = 1.2035\` |

The properties that make this safe:

- Every argument to \`exp\` is \`≤ 0\`, so no tile can overflow, whatever the scores are.
- \`alpha ≤ 1\` always; it only ever **shrinks** what was accumulated under a smaller max.
- \`m = -inf\` at the start makes the first tile's \`alpha = exp(-inf) = 0\`: there is no first-iteration
  special case, and \`l\`, \`o\` start at zero.
- The division \`o / l\` happens **once** per query tile. \`l\` and \`o\` are unnormalised partial sums that
  rescale by the same factor; dividing per tile would normalise against a sum that is not finished.

:::quiz
Q: A later key tile raises a row's max from 3 to 5. What happens to the output accumulated so far?
- [ ] It is discarded and recomputed under the new max
- [x] It is multiplied by exp(3 − 5): the same factor that converts the running sum to the new max
- [ ] Nothing — the max only matters for the final division
> o and l were both computed as sums of exp(s − 3) terms. Multiplying each by exp(3 − 5) turns them into sums of exp(s − 5) terms, which is exactly what the new tile's p is computed against. Nothing is redone.
:::

# The causal mask, tile by tile

A decoder's query at position \`i\` may attend to keys \`j ≤ i\`. The usual implementation builds a \`[T, T]\`
lower-triangular mask with \`torch.tril\` — which is the matrix the drill forbids. In a tiled loop the mask is a
property of **absolute positions**, and a tile knows where it sits:

- Tile of queries \`q0:q1\` against keys \`k0:k1\` with \`k0 ≥ q1\`: every key is after every query. Skip it,
  and every later key tile too (\`break\`).
- \`k1 ≤ q0 + 1\`: every key is at or before every query. No mask.
- Otherwise the tile crosses the diagonal: \`rows = arange(q0, q1)[:, None]\`, \`cols = arange(k0, k1)[None, :]\`,
  \`s.masked_fill(cols > rows, -inf)\` — an \`[block_q, block_k]\` mask, built from two small index vectors.

:::sequence
{
  "participants": ["flash_attention", "keys 0..7", "keys 8..15", "keys 16..23", "m · l · o"],
  "messages": [
    {"from": "flash_attention", "to": "m · l · o", "label": "query rows 8..15: m = −inf, l = 0, o = 0", "kind": "sync"},
    {"from": "flash_attention", "to": "keys 0..7", "label": "s = q₈₋₁₅ k₀₋₇ᵀ / √hd — k1 = 8 ≤ q0 + 1: no mask", "kind": "sync"},
    {"from": "keys 0..7", "to": "m · l · o", "label": "alpha = 0 · l = Σp · o = p v₀₋₇", "kind": "sync"},
    {"from": "flash_attention", "to": "keys 8..15", "label": "crosses the diagonal → masked_fill(col > row, −inf)", "kind": "sync"},
    {"from": "keys 8..15", "to": "m · l · o", "label": "alpha = exp(m − m_new) · l = alpha l + Σp · o = alpha o + p v₈₋₁₅", "kind": "sync"},
    {"from": "flash_attention", "to": "keys 16..23", "label": "k0 = 16 ≥ q1 = 16 → break", "kind": "async"},
    {"from": "m · l · o", "to": "flash_attention", "label": "out[8:16] = o / l", "kind": "reply"}
  ]
}
:::

Masked entries become \`exp(-inf − m_new) = 0\` in \`p\`: they add nothing to \`l\` or \`o\`. A row that is entirely
masked in some tile has \`s.amax = -inf\`, so \`m_new = m\` and \`alpha = 1\` — harmless. The one case that would
produce \`NaN\` is a row with **no** visible key in its first tile (\`m\` and \`m_new\` both \`-inf\`, \`0 / 0\` at
the end); causal self-attention never has one, because key 0 is visible to every query.

Skipping is not an optimisation of the mask — it is half the work. With \`T / block\` tiles per side, a causal
loop computes about \`(n² + n) / 2\` of the \`n²\` tiles, and the ones it does compute need the mask only on the
diagonal.

:::quiz
Q: Why can the loop \`break\` at the first key tile with k0 ≥ q1 rather than \`continue\`?
- [x] Key tiles are visited in increasing order, so every later tile is also entirely after the query tile
- [ ] Because the running max would otherwise become −inf
- [ ] It cannot; \`continue\` is required for correctness
> The visibility condition is monotone in the key position: once a tile starts past the end of the query tile, so does every tile after it. Breaking skips them all; continuing would compute masks full of −inf that contribute zeros.
:::

# Where the obvious version breaks

Two naive streaming attempts, both wrong, show what the three statistics are for.

**No running max.** Accumulate \`l += Σ exp(s)\` and \`o += exp(s) v\` directly and divide at the end. The
algebra is right; the arithmetic is not: a float32 \`exp\` overflows past \`s ≈ 88\`, and attention logits in a
trained model, scaled by \`1 / √hd\`, routinely exceed that at a few positions. One \`inf\` in \`l\` makes the row
\`0\` or \`NaN\`.

**A max but no rescaling.** Subtract each tile's own max before \`exp\`, then add the tiles together. Every term is
now safe, but terms from different tiles are measured against different maxes and cannot be summed.

:::sequence
{
  "participants": ["naive loop", "tile A (max 3)", "tile B (max 5)", "sum"],
  "messages": [
    {"from": "naive loop", "to": "tile A (max 3)", "label": "p = exp(s − 3) · l += Σp · o += p v", "kind": "sync"},
    {"from": "naive loop", "to": "tile B (max 5)", "label": "p = exp(s − 5) · l += Σp · o += p v", "kind": "sync"},
    {"from": "sum", "to": "naive loop", "label": "o / l mixes exp(s − 3) and exp(s − 5) terms: tile A weighted e² too high", "kind": "reply"},
    {"from": "naive loop", "to": "tile A (max 3)", "label": "online: p = exp(s − 3), m = 3", "kind": "sync"},
    {"from": "naive loop", "to": "tile B (max 5)", "label": "online: alpha = exp(3 − 5) · l = alpha l + Σ exp(s − 5) · o = alpha o + p v", "kind": "sync"},
    {"from": "sum", "to": "naive loop", "label": "o / l — every term under max 5, equal to the one-shot softmax", "kind": "reply"}
  ]
}
:::

The self-test catches both: the first by comparing against \`F.scaled_dot_product_attention\` at \`atol=1e-5\`
across tile shapes that split rows differently (\`(8, 8)\`, \`(16, 4)\`, \`(5, 7)\`, \`(32, 16)\` on \`T = 37\`),
the second by the same comparison — a missing \`alpha\` is off by a factor of \`e^(Δm)\` on some rows for every
tile shape but the one-tile case \`(64, 64)\`. \`gradcheck\` in float64 adds the property that matters for
training: the gradient of the loop equals the gradient of the formula, through \`maximum\`, \`masked_fill\` and
the rescaling alike.

:::quiz
Q: A learner subtracts each tile's own row max before exp, sums the tiles, and divides once at the end. What goes wrong?
- [ ] exp overflows on the first tile
- [x] Terms from different tiles are scaled by different constants and cannot be added; rows whose max moved between tiles are wrong by exp(Δm)
- [ ] Nothing — the division at the end cancels the constants
> The division cancels one constant, not two. Tile A contributed exp(s − 3) terms and tile B exp(s − 5) terms; their sum is not a softmax under any max. The rescale by exp(m_old − m_new) is what puts all terms under the same max before they are added.
:::

# What the kernel adds

The PyTorch loop is the algorithm; the paper's contribution is making it fast on a GPU.

| Concern | This loop | The kernel |
| --- | --- | --- |
| Where a tile lives | device memory, like every tensor | SRAM, loaded once per inner iteration |
| Backward pass | autograd saves every \`p\` tile: \`O(T²)\` activations | saves only \`m\` and \`l\` (as one logsumexp per row); recomputes \`p\` tile by tile |
| Division \`o / l\` | once per query tile | once per query tile, in registers |
| Causal work | tiles past the diagonal skipped | the same, plus the mask fused into the exponential |
| Loop order | query tiles outside, keys inside | FlashAttention-1: keys outside, queries inside; [FlashAttention-2](https://arxiv.org/abs/2307.08691) flips it so one thread block owns a query tile and the statistics never leave registers |

Recomputation is the second half of the memory story: the backward pass needs \`p\` to form \`dv\` and \`ds\`, and
storing it would reinstate the \`[T, T]\`. Keeping one row-statistic (\`logsumexp = m + log l\`) lets the backward
rebuild \`p = exp(s − logsumexp)\` from \`q\` and \`k\` on the fly — more FLOPs, far fewer bytes, and faster in
practice because the forward's problem was bytes.

:::details Why one logsumexp rather than m and l separately
The forward's \`m\` and \`l\` are needed only in the combination \`exp(s − m) / l = exp(s − (m + log l))\`. Storing
\`m + log l\` per row halves the saved state and removes a division from the backward's inner loop. PyTorch's
\`scaled_dot_product_attention\` returns this \`logsumexp\` from its flash backend for the same reason.
:::

In practice: [\`torch.nn.functional.scaled_dot_product_attention\`](https://pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
picks the flash kernel when the dtype, head size and mask allow it and falls back to the materialised version
otherwise; the \`flash-attn\` package ships the kernels themselves; Triton lets the loop above be written almost
line for line and compiled to a fused kernel; \`torch.compile\` fuses what it can around the call. The loop
order, the tile sizes (typically 64–128 on both sides) and the warp layout are the parts that need the hardware
in front of you; the algorithm written here is the same in all of them.

# What to take away

- Attention at long context is bound by the bytes of the \`[T, T]\` score matrix, not by its FLOPs; tiling removes
  the matrix, not the arithmetic.
- A softmax can be finished incrementally with three per-row numbers — running max \`m\`, running sum \`l\`,
  accumulator \`o\` — because a sum of exponentials under one max converts to another max by a single factor
  \`exp(m_old − m_new)\`.
- Every exponential is taken against the max seen so far, so nothing overflows; \`alpha ≤ 1\` only ever shrinks
  what came before; the division happens once, at the end of a row.
- The causal mask is a comparison of absolute positions inside a tile; tiles entirely past the diagonal are not
  computed at all — half the work of a decoder's attention.
- The kernel's remaining tricks are about memory, not math: tiles in SRAM, a single logsumexp per row saved for
  the backward, \`p\` recomputed rather than stored.

The primary reference is [*FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*](https://arxiv.org/abs/2205.14135)
(Dao, Fu, Ermon, Rudra, Ré, 2022): Algorithm 1 is the loop in this drill, Section 3 is the IO argument, and the
backward with recomputation is the part this drill leaves out.
`;
