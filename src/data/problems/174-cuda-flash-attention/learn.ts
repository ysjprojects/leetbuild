/**
 * The learning guide for the FlashAttention drill: why attention is memory-bound (HBM vs SRAM,
 * IO-awareness), the online softmax and its rescale, tiling with two barriers and causal tile
 * skipping, recomputation in the backward pass, and what FlashAttention-2 and -3 add: a figure or
 * a table where one says it faster than prose, a pop quiz per section. Rendered at
 * \`/cuda-flash-attention/learn\`.
 */
export const learn = `# The mechanism at a glance

FlashAttention (Dao, Fu, Ermon, Rudra, Ré, 2022) computes exact attention, \`O = softmax(Q Kᵀ / √d) V\`,
without ever writing the \`T × T\` score matrix to GPU memory. It is not an approximation: it is the same
arithmetic, reordered so that each byte of \`K\` and \`V\` is read from global memory once per block of
queries and the softmax is finished one tile at a time. Most long-context models since 2022 train and
serve on a descendant of it; \`torch.nn.functional.scaled_dot_product_attention\` dispatches to one.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "block", "label": "Thread block 1", "sub": "flash_attn_fwd<<<⌈T/64⌉, 64>>> · rows 64 … 127", "count": "4 blocks", "align": "end", "items": [
      {"id": "smem", "label": "Shared memory", "sub": "2 × 8 KB · tile 2, kv0 = 64", "tone": "shared", "layout": "column", "items": [
        {"id": "ks", "array": "Ks[32][64]", "sub": "a cell = key row kv0 + j", "cols": 16, "rows": 2, "tone": "shared", "detail": "Each K tile is read from HBM once and used by all 64 query rows of the block. Every lane reads the same Ks[j][k]: a broadcast."},
        {"id": "vs", "array": "Vs[32][64]", "sub": "a cell = value row kv0 + j", "cols": 16, "rows": 2, "tone": "shared", "detail": "Staged with Ks; a second __syncthreads() ends the tile before anyone overwrites it."}
      ]},
      {"id": "thread", "label": "Thread 15", "sub": "query row 79", "count": "× 64", "layout": "column", "items": [
        {"threads": 1, "detail": "One thread per query row: row = blockIdx.x · 64 + threadIdx.x."},
        {"id": "regs", "label": "Registers", "sub": "about 160 floats per thread", "tone": "register", "layout": "grid", "columns": 2, "items": [
          {"id": "s", "array": "s[32]", "sub": "q · Ks[j] · a cell = one key", "cols": 16, "rows": 2, "tone": "register", "marks": [{"rows": [0, 0], "cols": [0, 15], "tone": "register", "label": "keys 64 … 79"}, {"rows": [1, 1], "cols": [0, 15], "tone": "muted", "label": "−∞: key > row"}], "detail": "One row of S = Q Kᵀ for this tile. Tile 2 straddles the diagonal: row 79 masks keys 80 … 95 with −∞."},
          {"id": "ml", "array": "m, l", "sub": "running max, running sum", "cols": 2, "cells": ["m", "l"], "tone": "register", "detail": "m = −∞ and l = 0 at the start; one fold per tile."},
          {"id": "o", "array": "o[64]", "sub": "o *= α, then o += p · Vs[j]", "cols": 16, "tone": "register", "detail": "The output accumulator, rescaled whenever the running max rises, divided by l once after the last tile."},
          {"id": "q", "array": "q[64]", "sub": "Q[79] · scale · a cell = 4 floats", "cols": 16, "tone": "register", "detail": "Loaded once, pre-scaled by 1/√d, reused by every score of the row."}
        ]}
      ]}
    ]},
    {"id": "hbm", "label": "Global memory", "sub": "HBM · 64 KB per array", "detail": "T = 256, d = 64: Q, K, V and O are 65,536 bytes each, and there is no T × T buffer.", "tone": "global", "stretch": true, "items": [
      {"id": "g-k", "array": "K", "sub": "a row = one tile", "cols": 8, "rows": 8, "marks": [{"rows": [2, 2], "cols": [0, 7], "tone": "shared", "label": "tile 2"}, {"rows": [4, 7], "cols": [0, 7], "tone": "muted", "label": "causal: skipped"}], "detail": "Walked in tiles of 32 rows. Under the causal mask block 1 stops before tile 4: its last query is row 127."},
      {"id": "g-v", "array": "V", "sub": "a row = one tile", "cols": 8, "rows": 8, "marks": [{"rows": [2, 2], "cols": [0, 7], "tone": "shared", "label": "tile 2"}, {"rows": [4, 7], "cols": [0, 7], "tone": "muted", "label": "causal: skipped"}]},
      {"id": "g-s", "array": "S = Q Kᵀ", "sub": "T × T · 256 KB · never allocated", "cols": 8, "rows": 8, "marks": [{"rows": [0, 7], "cols": [0, 7], "tone": "muted", "label": "not in memory"}], "detail": "Standard attention writes this, reads it for the softmax and again for P V. Here each tile of it lives only in the s registers of 64 threads."},
      {"id": "g-o", "array": "O", "sub": "a row = 32 tokens", "cols": 8, "rows": 8, "marks": [{"rows": [2, 3], "cols": [0, 7], "tone": "register", "label": "written once"}], "detail": "The only output, O[row][k] = o[k] / l."},
      {"id": "g-q", "array": "Q", "sub": "a row = 32 tokens", "cols": 8, "rows": 8, "marks": [{"rows": [2, 3], "cols": [0, 7], "tone": "register", "label": "block 1"}]}
    ]}
  ],
  "arrows": [
    {"from": "g-q", "to": "q", "label": "Q[row] · scale"},
    {"from": "g-k", "to": "smem", "label": "K tile 2"},
    {"from": "g-v", "to": "smem", "label": "V tile 2"},
    {"from": "ks", "to": "s", "label": "q · Ks[j]"},
    {"from": "vs", "to": "o", "label": "p · Vs[j]"},
    {"from": "o", "to": "g-o", "label": "o / l"}
  ]
}
:::

Read it bottom to top. Block 1 owns query rows 64 … 127, one per thread, and copies each row into registers.
It then walks \`K\` and \`V\` one 32-row tile at a time through shared memory; each thread turns a tile into 32
scores and folds them into \`m\`, \`l\` and \`o\` without leaving registers. The \`T × T\` matrix \`S\` has no
address anywhere, and \`O\` is written once.

The contract the drill implements, in one file \`flash_attention.cu\`:

- \`__global__ void flash_attn_fwd(const float* Q, const float* K, const float* V, float* O, int T, int d,
  float scale, bool causal)\`: row-major \`T × d\` arrays, \`scale = 1 / √d\`, \`causal\` masks keys \`j > i\`.
- \`BQ = 64\` query rows per block, one per thread; \`BK = 32\` key/value rows per tile in
  \`__shared__ float Ks[BK][D_MAX]\`, \`Vs[BK][D_MAX]\`; \`D_MAX = 64\`, \`d ≤ D_MAX\`.
- Per thread, in registers: \`q[D_MAX]\` (pre-scaled), \`o[D_MAX]\`, \`s[BK]\`, the running max \`m\` and
  running sum \`l\`.
- \`main()\`: \`T = 256\`, \`d = 64\`, non-causal and causal, max-abs-error against a double CPU reference
  below \`1e-3\`, \`cudaEvent\` timing, a memory note, \`PASS\`.

# Attention is memory-bound: HBM, SRAM and IO-awareness

A GPU has two memories that matter here. **HBM** (global memory) is large and slow; **SRAM** (shared
memory and registers, per SM) is tiny and fast. The FlashAttention paper's numbers for an A100:

| Memory | Size | Bandwidth |
|---|---|---|
| HBM | 40–80 GB | ~1.5–2.0 TB/s |
| SRAM (shared memory, 108 SMs) | 192 KB per SM | ~19 TB/s |
| Registers | 256 KB per SM | faster still |

The standard implementation is three kernels, each a round trip through HBM:

\`\`\`text
S = Q Kᵀ · scale      write T × T
P = softmax(S)        read T × T, write T × T
O = P V               read T × T
\`\`\`

For \`T = 8192\` one head's \`S\` is \`8192² · 4 = 256 MiB\`, moved four times per layer, while \`Q\`, \`K\`, \`V\`, \`O\`
are 2 MiB each at \`d = 64\`. The FLOPs are \`~4 T² d\` either way; what differs is bytes. The paper calls
the remedy **IO-awareness**: count HBM reads and writes, not FLOPs, and arrange the computation so the
big intermediate never leaves SRAM.

| | HBM traffic | Extra memory |
|---|---|---|
| Standard attention | \`Θ(T d + T²)\` | \`T × T\` per head |
| FlashAttention | \`Θ(T² d² / M)\` for SRAM size \`M\` | \`O(T)\` (the statistics) |

With \`d\` in 64–128 and \`M\` around 100 KB, \`d² / M\` is well below 1, so traffic drops many-fold, and the
paper proves no exact algorithm does asymptotically better across the range of \`M\`. In the drill the
memory note makes the same point at \`T = 256\`: 16,384 bytes of shared memory per block against a score
matrix of 262,144 bytes that is never allocated.

:::quiz
Q: Why does fusing attention into one kernel speed it up when it performs the same FLOPs?
- [ ] Shared memory performs floating-point arithmetic faster than global memory
- [x] Attention is limited by HBM bandwidth, and fusion removes the T × T reads and writes
- [ ] The fused kernel skips the scaling by 1/√d
> Standard attention spends its time moving the score matrix through HBM, not multiplying. Removing that traffic is the whole speed-up; the arithmetic is unchanged and the result is exact.
:::

# The online softmax and its rescale

A softmax needs the row's maximum (for stability) and its sum (for normalisation) before any output is
known: apparently the whole row at once. The [online softmax](https://arxiv.org/abs/1805.02867) of
Milakov & Gimelshein removes that requirement with one identity:

\`\`\`text
exp(s − m_new) = exp(s − m_old) · exp(m_old − m_new)
\`\`\`

So a row can keep a running max \`m\`, a running sum \`l\` and an unnormalised accumulator \`o\`, and correct
all three by one multiply whenever a larger score arrives. Per tile of \`BK\` scores:

\`\`\`cuda
m_new = fmaxf(m, tile_max);
alpha = __expf(m - m_new);          // exp(m_old − m_new) ≤ 1
for k: o[k] *= alpha;               // re-express the past under the new max
for j: p = __expf(s[j] - m_new);    // ≤ 1, never overflows
       p_sum += p;  for k: o[k] += p * Vs[j][k];
l = l * alpha + p_sum;
m = m_new;
// after the last tile: O = o / l
\`\`\`

- **First tile.** \`m = -INFINITY\`, so \`alpha = __expf(-inf) = 0\` and the zero accumulator stays zero: no
  special case.
- **Masked scores.** \`s[j] = -INFINITY\` gives \`p = 0\`; padding and the causal mask need no branches in the
  fold.
- **Normalise once.** Dividing by \`l\` at the end instead of every tile saves \`d\` divides per tile and is
  exact: every term was scaled by the same \`exp(−m)\`.
- **The all-masked row.** If a row's first tile were entirely masked, \`m\` and \`tile_max\` would both be
  \`-INFINITY\` and \`m - m_new\` would be \`NaN\`. The drill cannot hit it (tile 0 holds key 0, visible to
  every row), but kernels with arbitrary masks guard it: FlashAttention-2 substitutes 0 for a \`-INFINITY\`
  max before subtracting.

The failure the max avoids is overflow. A naive one-pass softmax that sums \`exp(s)\` directly works
until a score passes about 88, where \`expf\` overflows float. Follow one row when a score of 95 arrives:

| | Naive one pass | Online, with a running max |
|---|---|---|
| Per score | \`l += exp(s[j])\`, \`o += exp(s[j]) · v_j\` | \`m_new = max(m, s[j])\`, \`o, l *= exp(m − m_new)\`, add \`exp(s[j] − m_new)\` |
| \`s = 95\` arrives | \`exp(95) = inf\` | \`m_new = 95\`, every exponent is ≤ 0 |
| Result | \`O = inf / inf = NaN\` for the whole row | \`O = o / l\`, finite and exact |

Step through the fold on one row of scores, tile by tile; the rescale fires whenever a tile raises the
running max:

:::widget online-softmax {"tile": 4}

Forgetting \`o[k] *= alpha\` is the subtler bug: the output is finite but wrong, because contributions
from earlier tiles stay weighted against a stale maximum while \`l\` is corrected.

:::quiz
Q: A new tile raises the running max from 3 to 7. What must happen to the accumulator before the tile's contributions are added?
- [ ] Nothing; the final division by l corrects it
- [x] Multiply it, and l, by exp(3 − 7)
- [ ] Reset it to zero and restart the row
> Past terms were computed as exp(s − 3). To sum them with new terms exp(s − 7) they must be re-expressed under the same max, which is one multiply by exp(3 − 7). The final division only works if numerator and denominator share that scale.
:::

:::details Why __expf rather than expf
\`__expf\` is a multiply by log₂e and one special-function-unit instruction (\`ex2.approx\`); \`expf\` is an
accurate software sequence several times longer. The Programming Guide bounds \`__expf\`'s error at
\`2 + ⌊1.173 · |x|⌋\` ulps. In the drill \`|s| ≤ 64 · 1 · 1 / 8 = 8\`, so \`x ≥ −16\` and the bound is 20 ulps (a
relative \`2.4e-6\`), far inside the \`1e-3\` tolerance. Here the 128 FMAs per score dominate, but once the
matmuls move to tensor cores the exponentials become the bottleneck, which is why FlashAttention-3
works hard to overlap them.
:::

# Tiles, barriers and the causal skip

Tiling is what turns the identity into bandwidth. A block owns \`BQ = 64\` query rows and walks the keys
in tiles of \`BK = 32\`: each tile of \`K\` and \`V\` is read from HBM once into shared memory and used by
all 64 rows, so \`K\` and \`V\` are read \`⌈T / BQ⌉\` times in total instead of \`T\` times. It is the reuse of a
shared-memory tiled matmul (\`S = Q Kᵀ\` is one, with the \`Q\` tile held in registers); step through the
plain matmul version to see the global loads it saves:

:::widget tiled-matmul

| Buffer | Where | Size in the drill |
|---|---|---|
| \`q\`, \`o\` | registers, per thread | 64 floats each |
| \`s\` | registers, per thread | 32 floats |
| \`m\`, \`l\` | registers, per thread | 1 float each |
| \`Ks\`, \`Vs\` | shared, per block | 32 × 64 floats = 8 KB each |

- **Coalesced staging.** The load loop strides \`idx\` by \`BQ\` over \`BK × D_MAX\` with \`j = idx / D_MAX\`,
  \`k = idx % D_MAX\`, so consecutive threads read consecutive floats of one row (see
  [coalesced access](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#coalesced-access-to-global-memory)).
- **Broadcast, not conflict.** In the score loop every thread of a warp reads the same \`Ks[j][k]\`, which
  shared memory serves as a broadcast.
- **Registers only under constant indices.** \`q\`, \`o\` and \`s\` stay in registers because every loop
  over them runs to \`D_MAX\` or \`BK\` under \`#pragma unroll\`. One loop bounded by the runtime \`d\`, such as
  \`for (k = 0; k < d; ++k) O[…] = o[k] * inv\`, indexes \`o\` dynamically, and the compiler moves the whole
  array to local memory (off-chip, cached): every \`o[k] +=\` becomes a load and a store. Hence the final
  write loops to \`D_MAX\` with an \`if (k < d)\` guard. About 160 live floats is also why \`D_MAX\` stops at
  64: at \`d = 128\` this layout would pass the 255-register limit and spill.
- **Two barriers.** \`__syncthreads()\` after the load so no thread reads a half-filled tile, and again
  after the fold so no thread overwrites the tile a neighbour is still reading.

The second barrier is the one people drop. Without it, the race runs like this:

| Time | warp 0 | \`Ks\` / \`Vs\` (shared) | warp 1 |
|---|---|---|---|
| 1 | stages its share of tile 0 | tile 0 filling | stages its share of tile 0 |
| 2 | \`__syncthreads()\` | tile 0 complete | \`__syncthreads()\` |
| 3 | finishes its fold first, loops, stages tile 1 (\`kv0 = 32\`) | rows of tile 1 over tile 0 | still folding tile 0 |
| 4 | | | reads rows of tile 1 as if they were tile 0 |

Warp 1's scores mix two tiles: \`O\` is wrong, and differently wrong from run to run.

**Causal tile skipping.** Under the causal mask query \`i\` sees keys \`0 … i\`. Masking is per element, but
whole tiles can be dropped: with \`q_last = min(blockIdx.x × BQ + BQ, T) − 1\`, a tile with
\`kv0 > q_last\` is entirely above the diagonal, so \`if (causal && kv0 > q_last) break;\` ends the loop.

- The condition depends on \`blockIdx\` only, so every thread of the block breaks together and no
  \`__syncthreads()\` is reached by half a block, which hangs or corrupts the block.
- Tiles straddling the diagonal keep the per-element test \`causal && key > row\` → \`-INFINITY\`.
- Close to half the tiles of a long causal head are never loaded.
- Threads with \`row ≥ T\` skip the arithmetic but still load and reach every barrier, for the same reason.

At the drill's \`T = 256\` the grid has four blocks, and the break leaves block 0 with two tiles and block 3
with eight: 20 of the 32 tiles are loaded, and the share skipped approaches half as \`T\` grows. The drill's
causal *time* barely moves, though: four blocks run side by side, and the kernel lasts as long as block 3,
which walks all eight tiles. The saving shows once the grid has more blocks than the GPU runs at once
(long \`T\`, batch × heads), when a short block's slot goes to the next block.

:::gpu
{
  "items": [
    {"id": "grid", "label": "Grid · causal", "sub": "flash_attn_fwd<<<4, 64>>> · T = 256", "count": "20 of 32 tiles", "detail": "The break depends on blockIdx only, so each block leaves its loop as a whole.", "items": [
      {"id": "blk0", "label": "Block 0", "sub": "queries 0 … 63", "layout": "column", "items": [
        {"threads": 8, "continues": true, "label": "64 threads, one query each"},
        {"id": "tiles0", "array": "K/V tiles", "sub": "a cell = 32 keys", "cols": 8, "cells": "index", "tone": "shared", "marks": [{"cols": [0, 1], "tone": "register", "label": "diag"}, {"cols": [2, 7], "tone": "muted", "label": "skip"}], "detail": "q_last = 63: tile 2 starts at key 64 and breaks the loop."}
      ]},
      {"id": "blk1", "label": "Block 1", "sub": "queries 64 … 127", "layout": "column", "items": [
        {"threads": 8, "continues": true, "label": "64 threads, one query each"},
        {"id": "tiles1", "array": "K/V tiles", "sub": "a cell = 32 keys", "cols": 8, "cells": "index", "tone": "shared", "marks": [{"cols": [0, 1], "tone": "shared", "label": "full"}, {"cols": [2, 3], "tone": "register", "label": "diag"}, {"cols": [4, 7], "tone": "muted", "label": "skip"}], "detail": "Tiles 0 and 1 are below the diagonal for every row; tiles 2 and 3 straddle it and are masked per key."}
      ]},
      {"id": "blk2", "label": "Block 2", "sub": "queries 128 … 191", "layout": "column", "items": [
        {"threads": 8, "continues": true, "label": "64 threads, one query each"},
        {"id": "tiles2", "array": "K/V tiles", "sub": "a cell = 32 keys", "cols": 8, "cells": "index", "tone": "shared", "marks": [{"cols": [0, 3], "tone": "shared", "label": "full"}, {"cols": [4, 5], "tone": "register", "label": "diag"}, {"cols": [6, 7], "tone": "muted", "label": "skip"}]}
      ]},
      {"id": "blk3", "label": "Block 3", "sub": "queries 192 … 255", "layout": "column", "items": [
        {"threads": 8, "continues": true, "label": "64 threads, one query each"},
        {"id": "tiles3", "array": "K/V tiles", "sub": "a cell = 32 keys", "cols": 8, "cells": "index", "tone": "shared", "marks": [{"cols": [0, 5], "tone": "shared", "label": "full"}, {"cols": [6, 7], "tone": "register", "label": "diag"}], "detail": "The last block sees every key: all eight tiles, four times the work of block 0."}
      ]}
    ]}
  ]
}
:::

:::quiz
Q: Why must the causal skip be decided per block rather than per thread?
- [ ] Per-thread decisions would produce the wrong mask
- [x] A thread that leaves the loop early would miss a __syncthreads() its block-mates still wait on
- [ ] Shared memory cannot be read after a break
> The tile loop contains barriers, and every thread of a block must reach the same barriers. A block-uniform condition keeps the block in lockstep; the per-thread mask is applied by writing -INFINITY instead of branching around the barrier.
:::

# The backward pass: recompute rather than store

Training needs gradients, and the gradient of softmax needs \`P\`. Storing it would bring back the \`T × T\`
matrix. FlashAttention stores only \`O\` and one number per row, \`logsumexp = m + log l\`, and in the
backward pass **recomputes** \`S\` and \`P = exp(S − logsumexp)\` tile by tile from \`Q\` and \`K\`.

| Saved for backward | Standard | FlashAttention |
|---|---|---|
| Scores / probabilities | \`T × T\` | none |
| Per-row statistics | none | \`T\` floats (\`logsumexp\`) |
| Extra FLOPs | none | one more \`Q Kᵀ\` |

- The extra matmul costs less than the HBM traffic it replaces, so the backward is faster as well as
  smaller: the same IO argument as the forward.
- \`D_i = rowsum(dO_i ∘ O_i)\` replaces the softmax Jacobian's row sum, so no full row is needed.
- The drill leaves this out; its kernel would need only to write \`m + logf(l)\` beside \`O\`.

:::quiz
Q: Why does FlashAttention recompute the attention probabilities in the backward pass instead of saving them?
- [x] Saving them costs T × T memory and HBM traffic that outweigh one extra matmul
- [ ] The probabilities change between the forward and backward pass
- [ ] Recomputation is required for numerical stability
> Recompute trades cheap FLOPs for expensive bytes. With logsumexp per row, P is exactly reconstructible tile by tile, so nothing quadratic is ever stored.
:::

# What FlashAttention-2 and -3 add

The drill keeps the algorithm and simplifies the hardware mapping: one thread per row, float, CUDA
cores. Production kernels keep the tiles, the online softmax and the causal skip and change who does
which work:

| | FlashAttention | [FlashAttention-2](https://arxiv.org/abs/2307.08691) | [FlashAttention-3](https://arxiv.org/abs/2407.08608) |
|---|---|---|---|
| Loop order | outer over K/V, inner over Q | outer over Q blocks, inner over K/V | same as FA-2 |
| Parallelism | batch × heads | + sequence (Q blocks) | + producer/consumer warpgroups |
| Within a block | warps split K/V, reduce via shared memory | warps split Q, no cross-warp reduction | warp specialisation, TMA loads |
| Normalisation | rescale O every tile | keep O unnormalised, divide once | same, overlapped with matmul |
| Matmuls | tensor cores, fp16/bf16 | tensor cores, \`mma.sync\` | Hopper \`wgmma\`, async, FP8 option |
| Reported utilisation | ~25–40% of A100 peak | ~50–73% of A100 peak | up to ~75% of H100 peak (FP16) |

- **Fewer non-matmul FLOPs.** FA-2 drops per-tile normalisation (as the drill does) because exponentials
  and divides run at a small fraction of tensor-core throughput.
- **Work partitioning.** Parallelising over query blocks fills the GPU even at batch 1 with long
  sequences; giving each warp its own query rows removes shared-memory reductions.
- **Asynchrony.** FA-3 lets producer warps load the next tile with TMA while consumer warps compute, and
  ping-pongs the softmax of one warpgroup against the matmul of another.
- **Frameworks.** PyTorch's [\`scaled_dot_product_attention\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
  chooses a FlashAttention or memory-efficient backend; FlexAttention generates masked variants from a
  Python function; inference engines add paged KV-cache layouts.

:::quiz
Q: What is FlashAttention-2's main change relative to the original kernel?
- [ ] It approximates the softmax to save FLOPs
- [x] It parallelises over query blocks and splits work across warps by query rows, cutting non-matmul work
- [ ] It stores the score matrix in L2 cache
> FA-2 is the same exact algorithm with a better mapping: query blocks as an extra grid axis, warps that own rows so their row reductions stay inside the warp, and one normalisation at the end.
:::

# What to take away

- Attention is bound by HBM bandwidth, not FLOPs; IO-awareness means counting bytes moved.
- The online softmax identity lets a row be finished tile by tile: running max, running sum, and one
  rescale \`alpha = exp(m_old − m_new)\` of the accumulator.
- Tiles of \`K\`/\`V\` in shared memory are read once per block of queries; two barriers fence each tile's
  lifetime, and the causal skip must be block-uniform.
- The backward pass recomputes probabilities from \`logsumexp\` instead of storing \`T × T\` values.
- FA-2 and FA-3 keep the algorithm and add work partitioning, warp specialisation and tensor-core
  asynchrony.

Primary reference: Dao et al., [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135).
`;
