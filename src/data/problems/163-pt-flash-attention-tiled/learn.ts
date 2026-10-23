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
matrix: it walks the keys in tiles and keeps, per query row, three running quantities that are enough to finish
the softmax later: the largest score seen so far, the sum of exponentials under that max, and the output
accumulated under that max. The drill writes that loop in PyTorch:

\`flash_attention(q, k, v, block_q, block_k, causal=True) -> out\`: scores exist only as
\`[B, H, block_q, block_k]\` tiles, the causal mask is applied inside a tile, tiles entirely after the query
tile are skipped, the arithmetic is float32, and \`torch.autograd.gradcheck\` passes through the loop.

The same loop in the shape of a kernel, with the tiles in on-chip memory and the per-tile update opened up on
the right:

:::architecture
{
  "input": "from the QKV projection",
  "output": "exact softmax(q kᵀ / √hd) v",
  "items": [
    {"id": "hbm-in", "label": "q, k, v in HBM", "kind": "memory", "sub": "Q once · K, V per query tile", "detail": "\`[B, H, T, hd]\`; the self-test runs \`B, H, T, hd = 2, 3, 37, 16\`. Each query tile streams every key and value tile it needs, so K and V are read ⌈T / block_q⌉ times: that re-reading dominates the HBM traffic."},
    {"tone": "block", "repeat": "⌈T / block_q⌉ ×", "label": "One query tile", "items": [
      {"id": "q-sram", "label": "Q tile in SRAM", "kind": "memory", "sub": "[block_q, hd]", "detail": "Loaded once and reused against every key tile; \`m = −inf\`, \`l = 0\`, \`o = 0\` per row."},
      {"tone": "block", "repeat": "while k0 < q1", "label": "One key/value tile", "items": [
        {"id": "kv-sram", "label": "K, V tiles in SRAM", "kind": "memory", "sub": "[block_k, hd] each"},
        {"id": "s-tile", "label": "Score tile", "kind": "attention", "sub": "q kᵀ / √hd · [block_q, block_k]", "side": {"label": "Causal mask", "sub": "diagonal tiles only"}, "detail": "The only scores that ever exist: one \`[block_q, block_k]\` tile, masked in place when it crosses the diagonal."},
        {"id": "online", "label": "Online softmax update", "kind": "attention", "sub": "m, l, o rescaled by alpha", "detail": "Fold the tile into the three per-row statistics; nothing is written back to HBM."}
      ]},
      {"id": "divide", "label": "Normalise once", "sub": "o / l", "detail": "After the last key tile, when \`l\` is complete."}
    ]},
    {"id": "hbm-out", "label": "Output in HBM", "kind": "memory", "sub": "[B, H, T, hd] · written once"}
  ],
  "notes": [
    {"at": "hbm-in", "text": "No **[T, T]** tensor anywhere"},
    {"at": "hbm-out", "text": "Extra memory: **O(T)**, not **O(T²)**"}
  ],
  "insets": [
    {"for": "online", "title": "Online softmax update", "items": [
      {"id": "u-max", "label": "New running max", "sub": "m_new = max(m, rowmax s)"},
      {"id": "u-alpha", "label": "Rescale factor", "kind": "attention", "sub": "alpha = exp(m − m_new)"},
      {"id": "u-exp", "label": "Exponentials", "sub": "p = exp(s − m_new)"},
      {"id": "u-acc", "label": "Rescale and add", "kind": "attention", "sub": "l = alpha·l + Σp · o = alpha·o + p v"}
    ], "note": "**alpha ≤ 1**: it only shrinks what came before"}
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

The matmuls in attention are not the bottleneck; the traffic around the score matrix is. On an A100 the
high-bandwidth memory (HBM) is 40 to 80 GB at 1.5 to 2.0 TB/s; the on-chip SRAM is 192 KB per streaming
multiprocessor, 20 MB across all 108, at roughly 19 TB/s. Written as three ops, attention is three kernels, and
everything between them goes through HBM:

:::gpu
{
  "align": "center",
  "items": [
    {"id": "n-hbm", "label": "HBM", "sub": "per (b, h)", "tone": "global", "layout": "column", "items": [
      {"id": "n-s", "array": "s = q kᵀ / √hd", "sub": "[T, T] float32", "rows": 6, "cols": 6, "marks": [{"cols": [0, 5], "tone": "bad", "label": "T²"}], "detail": "Written by the first matmul, read back whole by the softmax. At T = 32k and 32 batch-heads this one tensor is 137 GB."},
      {"id": "n-p", "array": "p = softmax(s)", "sub": "[T, T] float32", "rows": 6, "cols": 6, "marks": [{"cols": [0, 5], "tone": "bad", "label": "T²"}], "detail": "Written by the softmax, read back whole by the second matmul."}
    ]},
    {"id": "n-kernels", "label": "Three kernels", "sub": "one after another", "layout": "column", "items": [
      {"id": "n-mm1", "label": "matmul q kᵀ", "sub": "reads q, k: T · hd", "tone": "compute"},
      {"id": "n-soft", "label": "softmax", "sub": "row by row", "tone": "compute"},
      {"id": "n-mm2", "label": "matmul p v", "sub": "writes out: T · hd", "tone": "compute"}
    ]}
  ],
  "arrows": [
    {"from": "n-mm1", "to": "n-s", "label": "write T²"},
    {"from": "n-s", "to": "n-soft", "label": "read T²"},
    {"from": "n-soft", "to": "n-p", "label": "write T²"},
    {"from": "n-p", "to": "n-mm2", "label": "read T²"}
  ]
}
:::

Four full passes over \`T²\` numbers, against \`T · hd\` for the inputs and the output: at \`hd = 64\` and
\`T = 4096\` the score traffic is 64 times the rest. The problem's figure **Tiles in on-chip memory** is the
other side: the tiles of \`q\`, \`k\` and \`v\` cross to the chip, the scores never leave it.

| T | B·H | scores in float32 | one 128 × 128 tile per head |
| --- | --- | --- | --- |
| 4 096 | 32 | 2.1 GB | 2 MB total |
| 32 768 | 32 | 137 GB | 2 MB total |
| 37 (the self-test) | 6 | 33 KB | one \`[8, 8]\` tile: 1.5 KB |

The FLOPs are the same either way: \`4 · B · H · T² · hd\` for \`q kᵀ\` and \`p v\`, about half of it when causal
tiles are skipped. What tiling changes is the **bytes**. Per batch-head, with \`M\` the SRAM size
([FlashAttention](https://arxiv.org/abs/2205.14135), Theorems 1 and 2):

| | HBM accesses | memory beyond q, k, v, out |
| --- | --- | --- |
| three ops | \`Θ(T · hd + T²)\` | \`O(T²)\`: \`s\` and \`p\` |
| tiled | \`Θ(T² · hd² / M)\` | \`O(T)\`: per-row statistics |

The tiled count is the cost of re-reading. Each query tile is read once, but it needs every key and value tile up
to it, so \`k\` and \`v\` are streamed \`T / block_q\` times; SRAM caps the tile at \`block_q = Θ(M / hd)\` rows, so
the reads total \`Θ(T · hd · T · hd / M)\`. With \`hd\` of 64 to 128 and \`M\` around 100 KB, \`hd²\` is many times
smaller than \`M\`: many times fewer accesses than \`T²\`. A larger SRAM means fewer passes, and the paper proves no
exact algorithm can do asymptotically better for every \`M\` between \`hd\` and \`T · hd\` (Proposition 3).
Measured forward plus backward on GPT-2 medium (\`T = 1024\`, \`hd = 64\`, A100): HBM traffic 40.3 GB to 4.4 GB
and runtime 41.7 ms to 7.3 ms, while the FLOPs went **up**, 66.6 to 75.2 GFLOPs, from the backward's
recomputation.

In PyTorch the same loop does not save bandwidth (every tensor still lives in device memory), but it has the
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

The same factor applies to the accumulator, because \`o\` is \`Σ p_j · v_j\` with the same \`p_j\`. Milakov and
Gimelshein rescale only the normaliser, then take a second pass to produce the outputs; FlashAttention rescales
\`o\` too, which is what lets softmax and \`p v\` fuse into one pass. So each key tile does:

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
| \`[1, 3]\` | 3 | \`e⁻² + e⁰ = 1.1353\` | |
| \`[5, 2]\` | 5 | \`e⁻² · 1.1353 + e⁰ + e⁻³ = 1.2034\` | \`e⁻⁴ + e⁻² + e⁰ + e⁻³ = 1.2034\` |

Step through a longer row in the widget: the running max, the running sum and the rescale of what was already
accumulated, tile by tile, ending at the full softmax.

:::widget online-softmax {"tile": 4}

The properties that make this safe:

- Every argument to \`exp\` is \`≤ 0\`, so no tile can overflow, whatever the scores are.
- \`alpha ≤ 1\` always; it only ever **shrinks** what was accumulated under a smaller max.
- \`m = -inf\` at the start makes the first tile's \`alpha = exp(-inf) = 0\`: there is no first-iteration
  special case, and \`l\`, \`o\` start at zero.
- The division \`o / l\` happens **once** per query tile. \`l\` and \`o\` are unnormalised partial sums that
  rescale by the same factor; dividing per tile normalises against a sum that is not finished, so every later
  step must first undo it (FlashAttention-1 does exactly that, at a cost described below).

:::quiz
Q: A later key tile raises a row's max from 3 to 5. What happens to the output accumulated so far?
- [ ] It is discarded and recomputed under the new max
- [x] It is multiplied by exp(3 − 5): the same factor that converts the running sum to the new max
- [ ] Nothing: the max only matters for the final division
> o and l were both computed as sums of exp(s − 3) terms. Multiplying each by exp(3 − 5) turns them into sums of exp(s − 5) terms, which is exactly what the new tile's p is computed against. Nothing is redone.
:::

# The causal mask, tile by tile

A decoder's query at position \`i\` may attend to keys \`j ≤ i\`. The usual implementation builds a \`[T, T]\`
lower-triangular mask with \`torch.tril\`, which is the matrix the drill forbids. In a tiled loop the mask is a
property of **absolute positions**, and a tile knows where it sits:

- Tile of queries \`q0:q1\` against keys \`k0:k1\` with \`k0 ≥ q1\`: every key is after every query. Skip it,
  and every later key tile too (\`break\`).
- \`k1 ≤ q0 + 1\`: every key is at or before every query. No mask.
- Otherwise the tile crosses the diagonal: \`rows = arange(q0, q1)[:, None]\`, \`cols = arange(k0, k1)[None, :]\`,
  \`s.masked_fill(cols > rows, -inf)\`: a \`[block_q, block_k]\` mask, built from two small index vectors.

For \`T = 37\` and \`8 × 8\` tiles, the loop's work over the tile grid (rows are query tiles, columns key tiles):

| | keys 0:8 | 8:16 | 16:24 | 24:32 | 32:37 |
| --- | --- | --- | --- | --- | --- |
| **queries 0:8** | mask | break | · | · | · |
| **8:16** | full | mask | break | · | · |
| **16:24** | full | full | mask | break | · |
| **24:32** | full | full | full | mask | break |
| **32:37** | full | full | full | full | mask |

*full*: computed with no mask; *mask*: crosses the diagonal and is masked inside the tile; *break*: the first
tile with \`k0 ≥ q1\`, where the inner loop stops; *·*: never visited. Query rows 8..15 in detail:

| key tile | test | what the loop does | alpha |
| --- | --- | --- | --- |
| 0:8 | k1 = 8 ≤ q0 + 1 = 9 | no mask; l = Σp, o = p v₀₋₇ | 0, since m was −inf |
| 8:16 | crosses the diagonal | mask cols > rows; l = αl + Σp, o = αo + p v₈₋₁₅ | exp(m − m_new) ≤ 1 |
| 16:24 | k0 = 16 ≥ q1 = 16 | \`break\`, then out[8:16] = o / l | none |

Masked entries become \`exp(-inf − m_new) = 0\` in \`p\`: they add nothing to \`l\` or \`o\`. A row that is entirely
masked in some tile has \`s.amax = -inf\`, so \`m_new = m\` and \`alpha = 1\`: harmless. The one case that
produces \`NaN\` is a row with **no** visible key in its first visited tile: \`m\` and \`m_new\` are both \`-inf\`, so
\`alpha = exp(-inf + inf) = NaN\`, and \`p\` is \`NaN\` too. Causal self-attention never has one, because key 0 is
visible to every query; padding masks do, which is why real kernels guard the fully masked row.

Skipping is not an optimisation of the mask: it is half the work. With \`n = T / block\` tiles per side, a causal
loop computes \`(n² + n) / 2\` of the \`n²\` tiles, and with square tiles only the \`n\` diagonal ones need a mask.
[FlashAttention-2](https://arxiv.org/abs/2307.08691) measures the skip at 1.7 to 1.8 times faster than the same
kernel without the causal mask.

:::quiz
Q: Why can the loop \`break\` at the first key tile with k0 ≥ q1 rather than \`continue\`?
- [x] Key tiles are visited in increasing order, so every later tile is also entirely after the query tile
- [ ] Because the running max would otherwise become −inf
- [ ] It cannot; \`continue\` is required for correctness
> The visibility condition is monotone in the key position: once a tile starts past the end of the query tile, so does every tile after it. \`continue\` would also be correct, but would walk every remaining tile only to skip it; \`break\` stops at the first.
:::

# Where the obvious version breaks

Two naive streaming attempts, both wrong, show what the three statistics are for.

**No running max.** Accumulate \`l += Σ exp(s)\` and \`o += exp(s) v\` directly and divide at the end. The
algebra is right; the arithmetic is not: a float32 \`exp\` overflows past \`s ≈ 88.7\` (float16 past 11.1), and
nothing bounds the logits. One \`inf\` in \`l\` makes the row \`0\` or \`NaN\`.

**A max but no rescaling.** Subtract each tile's own max before \`exp\`, then add the tiles together. Every term is
now safe, but terms from different tiles are measured against different maxes and cannot be summed.

The same row as above, scores \`[1, 3]\` then \`[5, 2]\`, both ways:

| | tile A, scores 1 and 3 | tile B, scores 5 and 2 | final l | weight of score 1 | weight of score 5 |
| --- | --- | --- | --- | --- | --- |
| no rescale | 1.1353, under max 3 | 1.0498, under max 5 | 2.1851 | 0.0619 | 0.4576 |
| online | 1.1353 × e⁻² = 0.1537 | 1.0498 | 1.2034 | 0.0152 | 0.8310 |
| one-shot softmax | | | 1.2034 | 0.0152 | 0.8310 |

Without the rescale, every tile A term counts \`e² ≈ 7.4\` times too much against tile B's, and the row is not a
softmax under any max; with it, every term is under max 5 and the weights match the one-shot softmax.

The self-test catches both. The first fails its large-logit case, \`q · 30\` with scores up to 126, where \`exp\`
returns \`inf\`; the small \`randn\` cases (scores below 5) cannot see it. The second fails the plain comparison
against \`F.scaled_dot_product_attention\` at \`atol=1e-5\` across tile shapes that split rows differently
(\`(8, 8)\`, \`(16, 4)\`, \`(5, 7)\`, \`(32, 16)\` on \`T = 37\`): earlier tiles are overweighted by \`e^(Δm)\` on every
row whose max moved, for every tile shape but the one-tile case \`(64, 64)\`. \`gradcheck\` in float64 adds the
property that matters for training: the gradient of the loop equals the gradient of the formula, through
\`maximum\`, \`masked_fill\` and the rescaling alike.

:::quiz
Q: A learner subtracts each tile's own row max before exp, sums the tiles, and divides once at the end. What goes wrong?
- [ ] exp overflows on the first tile
- [x] Terms from different tiles are scaled by different constants and cannot be added; rows whose max moved between tiles are wrong by exp(Δm)
- [ ] Nothing: the division at the end cancels the constants
> The division cancels one constant, not two. Tile A contributed exp(s − 3) terms and tile B exp(s − 5) terms; their sum is not a softmax under any max. The rescale by exp(m_old − m_new) is what puts all terms under the same max before they are added.
:::

# What the kernel adds

The PyTorch loop is the algorithm; the papers' contribution is making it fast on a GPU.

| Concern | This loop | The kernel |
| --- | --- | --- |
| Where a tile lives | device memory, like every tensor | Q, K, V tiles in shared memory, \`s\`, \`p\`, \`o\`, \`m\`, \`l\` in registers |
| Backward pass | autograd saves every \`p\` tile: \`O(T²)\` activations | saves \`out\` and per-row statistics only (FlashAttention-1: \`m\` and \`l\`; FlashAttention-2: one logsumexp); recomputes \`p\` tile by tile |
| Division \`o / l\` | once per query tile | FlashAttention-1: every inner step, writing a normalised \`O\` back to HBM; FlashAttention-2: once, at the end |
| Causal work | tiles past the diagonal skipped | the same; the mask applied in registers on diagonal tiles only |
| Loop order | query tiles outside, keys inside | FlashAttention-1: keys outside, queries inside, so \`O\`, \`m\`, \`l\` go through HBM every step; FlashAttention-2 flips it (as Phil Tillet's Triton kernel did first), so one thread block owns a query tile |

The division row is where the two papers differ most. FlashAttention-1 keeps \`O\` normalised, so each step
multiplies by \`l_old / l_new\` to undo the last division before adding the new tile: correct, but extra non-matmul
work, which on an A100 costs 16 times a matmul FLOP (19.5 against 312 TFLOP/s). FlashAttention-2 keeps \`o\`
unnormalised, as this loop does, and divides once.

Recomputation is the second half of the memory story: the backward pass needs \`p\` to form \`dv = pᵀ do\` and
\`ds = p ∘ (dp − D)\`, and storing it would reinstate the \`[T, T]\`. Keeping one row-statistic
(\`logsumexp = m + log l\`) lets the backward rebuild \`p = exp(s − logsumexp)\` from \`q\` and \`k\` on the fly: more
FLOPs, far fewer bytes, and faster in practice because the forward's problem was bytes. \`D = rowsum(do ∘ out)\` is
why \`out\` is saved too.

:::details Why one logsumexp rather than m and l separately
The forward's \`m\` and \`l\` are needed only in the combination \`exp(s − m) / l = exp(s − (m + log l))\`. Storing
\`m + log l\` per row halves the saved state and turns \`exp(s − m) / l\` into one subtraction and one \`exp\`.
PyTorch's flash backend (\`aten._scaled_dot_product_flash_attention\`) returns this \`logsumexp\` alongside the output
and saves it for the backward; the public \`scaled_dot_product_attention\` returns only the output.
:::

In practice: [\`torch.nn.functional.scaled_dot_product_attention\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
picks the flash kernel when the dtype, head size and mask allow it and otherwise falls back to the
memory-efficient, cuDNN or materialised math backend; the \`flash-attn\` package ships the kernels themselves;
Triton lets the loop above be written almost line for line and compiled to a fused kernel; \`torch.compile\`
fuses what it can around the call. The loop order, the tile sizes (typically 64 to 128 on both sides) and the
warp layout are the parts that need the hardware in front of you; the algorithm written here is the same in all
of them.

:::quiz
Q: FlashAttention's backward needs \`p\` for every tile but never stored it. What does it keep from the forward, and why is recomputing \`p\` faster than reading it?
- [ ] Every \`p\` tile in fp16; halving the precision halves the bytes
- [x] The output and one logsumexp per row; rebuilding \`p = exp(s − L)\` from \`q\` and \`k\` in SRAM costs FLOPs, while reading a stored \`[T, T]\` costs HBM traffic, the scarcer resource
- [ ] Only \`m\`; \`l\` can be recovered from \`out\`
> Storing \`p\` would bring back the \`O(T²)\` memory and the HBM traffic the forward avoided. With \`L = m + log l\` per row, each tile's \`p\` is one matmul and one \`exp\` away. On GPT-2 medium the recomputation raised the FLOPs from 66.6 to 75.2 G and still cut forward plus backward from 41.7 to 7.3 ms.
:::

# What to take away

- Attention at long context is bound by the bytes of the \`[T, T]\` score matrix, not by its FLOPs; tiling removes
  the matrix, not the arithmetic.
- A softmax can be finished incrementally with three per-row quantities (running max \`m\`, running sum \`l\`,
  accumulator \`o\`) because a sum of exponentials under one max converts to another max by a single factor
  \`exp(m_old − m_new)\`.
- Every exponential is taken against the max seen so far, so nothing overflows; \`alpha ≤ 1\` only ever shrinks
  what came before; the division happens once, at the end of a row.
- The causal mask is a comparison of absolute positions inside a tile; tiles entirely past the diagonal are not
  computed at all: half the work of a decoder's attention.
- The kernel's remaining tricks are about memory, not math: tiles in SRAM, re-reads of K and V bounded by the SRAM
  size, one logsumexp per row saved for the backward, \`p\` recomputed rather than stored.

The primary reference is [*FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*](https://arxiv.org/abs/2205.14135)
(Dao, Fu, Ermon, Rudra, Ré, 2022): Algorithm 1 is this loop with the loops swapped and \`O\` normalised every
step, Section 3.2 is the IO argument, and Appendix B is the backward with recomputation, which this drill leaves
out. FlashAttention-2's Algorithm 1 is the loop order written here.
`;
