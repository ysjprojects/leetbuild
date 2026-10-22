/**
 * The learning guide for the LayerNorm-kernels problem: LayerNorm as a row reduction and where it
 * sits in a transformer, why E[x²] − E[x]² fails in float (drawn as a failure), Welford's update and
 * Chan's parallel merge across a block, the backward's two row reductions and the column sums for
 * gamma and beta, and what fused production kernels add — a figure or a table where one says it
 * faster than prose, a pop quiz per section. Rendered at \`/cuda-layernorm-welford/learn\`.
 */
export const learn = `# The mechanism at a glance

LayerNorm normalises each row of activations to zero mean and unit variance, then rescales it with two
learned vectors. A transformer applies it before every attention and every MLP, so a 32-layer model runs
it 64 times per token forward and 64 times backward. On a GPU it is one block per row: a reduction for the
row's statistics, then an elementwise pass.

Three kernels, bottom to top:

:::architecture
{
  "input": "x, γ, β · 256 × 1000 fp32",
  "output": "compared with a double reference",
  "items": [
    {"id": "g-host", "label": "Host · main()", "sub": "4 rows at 1000 · CPU reference", "kind": "host"},
    {"id": "g-x", "label": "Global memory", "sub": "x[256, 1000] · γ, β [1000]", "kind": "memory"},
    {"id": "g-fwd", "label": "layernorm_fwd<<<256, 256>>>", "sub": "Welford · Chan merge · rsqrtf", "kind": "kernel", "detail": "One block per row: Welford per thread, Chan's merge across the warp and through shared memory, then y = x̂ · γ + β."},
    {"id": "g-stats", "label": "mean[row], rstd[row]", "sub": "saved · y[256, 1000] written", "kind": "memory", "detail": "Two floats per row, kept for the backward."},
    {"id": "g-bwd", "label": "layernorm_bwd<<<64, 256>>>", "sub": "Σ dy·γ, Σ dy·γ·x̂ → dx", "kind": "kernel", "side": {"label": "dy", "sub": "[256, 1000]"}, "detail": "Block b handles rows b, b + 64, …: two row reductions, then dx and a partial row of dγ, dβ."},
    {"id": "g-part", "label": "dγ, dβ partial rows", "sub": "[64, 1000] · dx written", "kind": "memory"},
    {"id": "g-red", "label": "layernorm_bwd_reduce", "sub": "one thread per column", "kind": "kernel", "detail": "Thread c sums the 64 partial rows of column c."},
    {"id": "g-out", "label": "dγ, dβ", "sub": "[1000] each", "kind": "memory"}
  ],
  "notes": [
    {"at": "g-fwd", "text": "**256** blocks, one per row"},
    {"at": "g-stats", "text": "**2** floats per row: no second variance"},
    {"at": "g-part", "text": "**64** partial rows instead of atomics"}
  ]
}
:::

The contract, in one file \`layernorm_kernels.cu\`, row-major \`float\`, \`eps = 1e-5\`:

- \`welford_update(Welford& s, float v)\` and \`welford_merge(a, b)\` over \`struct Welford {count, mean, m2}\`;
  \`warp_welford\` merges a warp's 32 states with \`__shfl_down_sync\`.
- \`layernorm_fwd(x, gamma, beta, y, mean, rstd, rows, cols, eps)\`: one block of 256 per row,
  \`rstd = rsqrtf(m2 / cols + eps)\`, \`mean[row]\` and \`rstd[row]\` saved, \`y = (x − mean) · rstd · γ + β\`.
- \`layernorm_bwd(dy, x, gamma, mean, rstd, dx, dgamma_partial, dbeta_partial, rows, cols)\`: 64 blocks, per row
  \`sum_g = Σ dy·γ\` and \`sum_gx = Σ dy·γ·x̂\`, then \`dx\`; per block one partial row of \`dγ\` and \`dβ\`.
- \`layernorm_bwd_reduce\`: one thread per column, the sum over the partial rows.
- The self-test: 256 × 1000, rows 0, 64, 128, 192 at \`1000 + U(−1, 1)\`, six errors against a double CPU
  reference, each \`≤ 1e-3\`, then \`PASS\`.

# LayerNorm is a row reduction

[Ba, Kiros and Hinton (2016)](https://arxiv.org/abs/1607.06450) normalise over the features of one example
instead of over the batch, so the statistics need no batch, behave the same at training and inference, and
work at batch size 1 — the reason every transformer uses it (or its mean-free cousin RMSNorm). Per row of
\`cols\` features:

\`\`\`text
mean = (1/N) Σ x_i                 var  = (1/N) Σ (x_i − mean)²      (biased: N, not N − 1)
rstd = 1 / sqrt(var + eps)         x̂_i = (x_i − mean) · rstd
y_i  = γ_i · x̂_i + β_i
\`\`\`

This matches [\`torch.nn.LayerNorm\`](https://pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html) over
the last dimension, including the biased variance. In memory, for the self-test's 256 × 1000:

| Tensor | Shape | Bytes | Read / written by |
| --- | --- | --- | --- |
| \`x\`, \`y\` | [256, 1000] | 1.0 MB each | forward reads \`x\` once, writes \`y\` |
| \`gamma\`, \`beta\` | [1000] | 4 KB each | every block, from cache |
| \`mean\`, \`rstd\` | [256] | 1 KB each | forward writes, backward reads |
| \`dy\`, \`dx\` | [256, 1000] | 1.0 MB each | backward reads \`dy\` and \`x\`, writes \`dx\` |
| \`dgamma_partial\`, \`dbeta_partial\` | [64, 1000] | 256 KB each | backward writes, reduce reads |

- **One block per row.** Rows are independent, so a block owns a row and no block talks to another; 256
  threads cover 1000 columns with 3 or 4 each, strided by 256 so a warp's loads are contiguous.
- **Bandwidth-bound.** About 8 bytes moved per element forward and 12 backward, for a handful of FLOPs. The
  kernel's speed is how few times it touches HBM; its correctness is all in the reduction.

LayerNorm beside its mean-free cousin RMSNorm, on one vector of activations:

:::widget norm-compare

:::quiz
Q: Why does the forward write mean[row] and rstd[row] to global memory when y is all the next layer needs?
- [ ] cuDNN requires them as outputs
- [x] The backward needs x̂ = (x − mean) · rstd, and two floats per row are far cheaper than reducing the row again
- [ ] They are needed to normalise the next row
> The backward's dx and dγ both depend on x̂. With the statistics saved, the backward recomputes x̂ elementwise from x; without them it would repeat the forward's whole reduction, for 8 bytes per row of storage saved.
:::

# Why E[x²] − E[x]² fails in float

The one-pass formula everyone writes first is \`var = Σx²/N − (Σx/N)²\`. It is exact in real numbers and
useless in float when the mean is large next to the spread. Row 0 of the self-test is \`1000 + U(−1, 1)\`, and
the naive kernel goes through it like this:

| Stage, row 0 in float | What the kernel holds |
| --- | --- |
| Per thread | \`sum += x\`, \`sumsq += x * x\`, each \`x²\` ≈ 10⁶ |
| After the block reduction | Σx ≈ 999 994, Σx² ≈ 9.9999·10⁸, where the float spacing is 64 |
| Thread 0 | E[x²] ≈ 999 989.3, E[x]² ≈ 999 988.9, on a float grid 0.0625 apart |
| Result | var = 0.375 against a true 0.328: \`rstd\` 6% off on every element |
| A flatter row, 1000 ± 0.01 | var = −0.125, and \`rsqrtf\` returns NaN |

This is catastrophic cancellation:
two large numbers that agree in most of their digits are subtracted, and what is left is the rounding error
of each. A float carries 24 bits, about seven decimal digits; near 10⁶ adjacent floats are 0.0625 apart, so
the difference of two such numbers can only be a multiple of 0.0625 before any accumulation error is
counted. The two float32 formulas, side by side as the offset grows:

:::widget variance-cancellation

| Row | True variance | \`E[x²] − E[x]²\` in float | Welford + Chan in float |
| --- | --- | --- | --- |
| \`2 · U(−1, 1)\`, mean ≈ 0 | 1.33 | correct to ~1e-6 | correct to ~1e-6 |
| \`1000 + U(−1, 1)\` (row 0) | 0.328432 | 0.375 | 0.328432 |
| \`1000 + U(−1, 1)\`, all four such rows | 0.33 | up to 31% off | ≤ 6e-6 relative |
| \`1000 + 0.01 · U(−1, 1)\` | 3.3e-5 | −0.125, so \`rstd\` is NaN | 0.1% off |

- **It is not a corner case.** Activations drift, and a residual stream with a large per-row offset puts
  the mean far from zero next to a small spread. The kernel must be right for any row, not for the test's.
- **Doubles only postpone it.** In double the grid near 10⁶ is 1e-10 apart; the same failure returns once
  the mean nears 10⁸ (its square near 10¹⁶, where adjacent doubles are 2 apart), and a GPU's double
  throughput is a fraction of its float throughput.
- **Two passes fix it** — reduce the mean, then \`Σ (x − mean)²\` — at the price of reading the row twice.
  Welford fixes it in one.

:::quiz
Q: A row has mean 1000 and variance 0.33. Why does accumulating Σx² in double, but subtracting in float, not help?
- [ ] Because double sums are slower
- [x] E[x²] and E[x]² are both ≈ 999 989; rounded to float they sit on a grid 0.0625 apart, so their difference has almost no correct digits
- [ ] Because the variance must be computed with N − 1
> The information is lost at the subtraction: two numbers near 10⁶ stored in 24 bits keep only the first seven digits, and the variance lives in the seventh and beyond. Only keeping deviations from the mean small — Welford, or two passes — avoids it.
:::

# Welford's update and Chan's merge

[Welford (1962)](https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance)
keeps three numbers — the count, the running mean and \`m2\`, the sum of squared deviations from it — and
updates them one value at a time:

\`\`\`cuda
s.count += 1.0f;
const float delta = v - s.mean;          // deviation from the old mean
s.mean += delta / s.count;
s.m2 += delta * (v - s.mean);            // times the deviation from the new mean
\`\`\`

Every product is of two small deviations, never of two values near 1000, and \`m2\` only grows. That is a
per-thread loop; 256 threads end with 256 states over disjoint sets of columns. Chan, Golub and LeVeque
(1979) give the **exact** combination of two such states:

\`\`\`cuda
count = a.count + b.count;
delta = b.mean - a.mean;
mean  = a.mean + delta * b.count / count;
m2    = a.m2 + b.m2 + delta * delta * a.count * b.count / count;   // the spread between the halves
\`\`\`

The last term is what a naive "add the two variances" misses: two halves with the same spread but
different means have a larger combined variance. The merge is associative in real arithmetic, so any
tree of merges gives the same answer, which is what lets a block reduce it like a sum. Inside one warp of
the self-test's 1000-column row, each cell is the count \`n\` a lane's state covers after each shuffle and
merge; lane 0 of every warp then hands its state to shared memory:

:::gpu
{
  "align": "end",
  "items": [
    {"id": "w-block", "label": "One block · one row", "sub": "1000 columns · 256 threads", "count": "× 256", "align": "end", "items": [
      {"id": "w-warp", "label": "Warp 0 · warp_welford", "sub": "shfl n, mean, M2 down, then merge", "count": "5 merges", "layout": "column", "items": [
        {"threads": 32, "label": "lanes 0–31 · a Welford state (n, mean, M2) each"},
        {"id": "w-n0", "array": "after welford_update", "sub": "4 columns each", "cols": 32, "tone": "register", "cells": ["4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4"], "detail": "Thread t folds columns t, t + 256, t + 512, t + 768 with welford_update; threads 232–255 get only 3, since the row ends at 1000."},
        {"id": "w-n16", "array": "offset 16", "sub": "lane l merges lane l + 16", "cols": 32, "tone": "register", "cells": ["8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8", "8"], "marks": [{"cols": [16, 31], "tone": "muted", "label": "never read again"}]},
        {"id": "w-n8", "array": "offset 8", "cols": 32, "tone": "register", "cells": ["16", "16", "16", "16", "16", "16", "16", "16"], "marks": [{"cols": [8, 31], "tone": "muted"}]},
        {"id": "w-n4", "array": "offset 4", "cols": 32, "tone": "register", "cells": ["32", "32", "32", "32"], "marks": [{"cols": [4, 31], "tone": "muted"}]},
        {"id": "w-n2", "array": "offset 2", "cols": 32, "tone": "register", "cells": ["64", "64"], "marks": [{"cols": [2, 31], "tone": "muted"}]},
        {"id": "w-n1", "array": "offset 1", "sub": "lane 0: the warp's 128 values", "cols": 32, "tone": "register", "cells": ["128"], "marks": [{"cols": [1, 31], "tone": "muted"}], "detail": "Chan's merge is exact, so lane 0 holds the count, mean and m2 of all 128 values the warp read."}
      ]},
      {"id": "w-right", "label": "Across the warps", "sub": "2 barriers per row", "layout": "column", "items": [
        {"id": "w-slots", "label": "Shared memory", "sub": "__shared__ Welford s_warp[32]", "tone": "shared", "layout": "column", "items": [
          {"array": "s_warp", "sub": "n: 128 each, 104 in warp 7", "cols": 8, "tone": "shared", "cells": "index"}
        ], "detail": "Lane 0 of warp w writes s_warp[w], then __syncthreads(). Warp 7's lanes 8–31 got 3 columns, so its state covers 104 values; the eight add up to 1000."},
        {"id": "w-merge", "label": "Warp 0 merges 8 states", "sub": "rstd = rsqrtf(M2 / 1000 + eps)", "layout": "column", "items": [
          {"threads": 16, "idle": 8, "continues": true, "label": "lanes 8–31: count = 0"}
        ], "detail": "Lanes past the warp count load empty states, which merge to the other state, not to 0 / 0. Thread 0 writes mean[row], rstd[row] and two shared floats; after a second barrier every thread writes y."}
      ]}
    ]}
  ],
  "arrows": [
    {"from": "w-warp", "to": "w-slots", "label": "lane 0 of each warp"},
    {"from": "w-slots", "to": "w-merge"}
  ]
}
:::

| Property | Why it holds |
| --- | --- |
| One pass over \`x\` | each element is read once into \`welford_update\`; the second loop that writes \`y\` hits L1/L2 |
| No cancellation | \`m2\` accumulates products of deviations; the merge adds a \`delta²\` term, never subtracts |
| Empty states are safe | lanes past the end of a short row, and lanes 8–31 of the final warp, have \`count = 0\`; \`0 + 0\` returns early instead of \`0 / 0\` |
| Biased variance | \`m2 / cols\`, matching \`torch.nn.LayerNorm\`; \`m2 / (count − 1)\` would be the sample variance |
| \`rsqrtf\` | one special-function-unit instruction for \`1 / sqrt\`; \`1.0f / sqrtf(…)\` is a square root and a division |

The shuffles are the [warp shuffle functions](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#warp-shuffle-functions):
\`__shfl_down_sync(FULL_MASK, v, offset)\` hands each lane the value of lane \`+ offset\` without touching
shared memory, and a lane whose source is out of range gets its own value back — which only the lanes
whose result is discarded ever see.

:::quiz
Q: Two halves of a row each have m2 = 10 over 500 values, one with mean 999 and one with mean 1001. What is the combined m2?
- [ ] 20 — the two m2 values add
- [x] 1020 — 10 + 10 + 2² · 500 · 500 / 1000
- [ ] 10 — the halves have the same spread
> The δ² · n_a · n_b / n term is the squared distance between the halves' means, weighted by how many values sit on each side. Dropping it reports the spread within each half and forgets the gap between them.
:::

# The backward: two reductions and the column sums

With \`g = dy · γ\` (the gradient reaching \`x̂\`), differentiating through \`x̂ = (x − mean) · rstd\` — where
\`mean\` and \`rstd\` depend on every element of the row — leaves two row-wide terms:

\`\`\`text
sum_g  = Σ_j g_j                    sum_gx = Σ_j g_j · x̂_j
dx_i   = rstd · (g_i − (sum_g + x̂_i · sum_gx) / N)
dγ_c   = Σ_rows dy · x̂             dβ_c   = Σ_rows dy
\`\`\`

The \`sum_g\` term comes from the mean (shifting every input shifts the mean), the \`sum_gx\` term from the
variance (stretching the row changes \`rstd\`). So the backward has the forward's shape twice over: per row, a
block reduction of two sums, then an elementwise pass; and across rows, a reduction per column for \`dγ\` and
\`dβ\`.

One backward block's row loop, the partial rows the 64 blocks leave in global memory, and the column
reduce that sums them:

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "k-grid", "label": "layernorm_bwd", "sub": "<<<64, 256>>>", "count": "64 blocks", "items": [
      {"id": "k-block", "label": "Block 0", "sub": "rows 0, 64, 128, 192", "layout": "column", "items": [
        {"id": "k-load", "label": "Per row: x̂ and g", "sub": "x̂ = (x − mean)·rstd · g = dy·γ", "layout": "column", "items": [
          {"threads": 12, "continues": true, "label": "sum_g, sum_gx per thread"}
        ], "detail": "Each thread reads dy and x for its columns plus the saved mean[row] and rstd[row], and accumulates sum_g += g and sum_gx += g · x̂ in registers."},
        {"id": "k-sum", "label": "block_reduce_sum2", "sub": "barrier · totals to every thread", "tone": "shared", "stretch": true, "detail": "Shuffles within each warp, a shared slot per warp, warp 0 over the slots. dx needs the row totals, so this barrier separates the sums from their use."},
        {"id": "k-dx", "label": "Then dx, and partial row 0", "sub": "a second loop over the columns", "layout": "column", "items": [
          {"threads": 12, "continues": true, "label": "thread t owns c ≡ t (mod 256)"}
        ], "detail": "dx = rstd · (g − (sum_g + x̂ · sum_gx) / N), then dy · x̂ and dy added to the block's own partial row, which only this thread touches at these columns."}
      ]},
      {"label": "Block 1", "sub": "rows 1, 65, …", "layout": "column", "items": [{"threads": 8, "continues": true}]},
      {"gap": "…"},
      {"label": "Block 63", "sub": "rows 63, 127, …", "layout": "column", "items": [{"threads": 8, "continues": true}]}
    ]},
    {"id": "k-gmem", "label": "Global memory", "tone": "global", "stretch": true, "align": "end", "items": [
      {"id": "k-part", "array": "dγ, dβ partial · 64 × 1000", "sub": "a row per block", "cols": 16, "rows": 8, "marks": [
        {"cols": [0, 15], "rows": [0, 0], "tone": "global", "label": "block 0"},
        {"cols": [5, 5], "rows": [0, 7], "tone": "register"}
      ], "detail": "Two [64, 1000] arrays, 256 KB each; 8 of the 64 rows drawn. No atomics: every cell has exactly one writer."},
      {"id": "k-out", "array": "dγ, dβ · [1000]", "cols": 16, "marks": [{"cols": [5, 5], "tone": "register", "label": "c"}]}
    ]},
    {"id": "k-red", "label": "layernorm_bwd_reduce", "sub": "one thread per column", "count": "1,000 threads", "layout": "column", "items": [
      {"threads": 12, "continues": true, "label": "thread c sums column c of the 64 rows"}
    ], "detail": "64 partials per column in a fixed order: the same bits every run. Adjacent threads read adjacent columns, so each row's loads coalesce."}
  ],
  "arrows": [
    {"from": "k-block", "to": "k-part", "label": "row 0"},
    {"from": "k-part", "to": "k-red", "label": "column c"},
    {"from": "k-red", "to": "k-out", "label": "dγ[c], dβ[c]"}
  ]
}
:::

| Choice | Alternative | Why the kernel does this |
| --- | --- | --- |
| reduce both sums, then write \`dx\` | write \`dx\` in the same loop | \`dx_i\` needs the row totals; a barrier must separate the sums from their use |
| read saved \`mean\`, \`rstd\` | recompute them | one load per row instead of a Welford reduction |
| 64 partial rows + a column reduce | \`atomicAdd(&dgamma[c], …)\` from 256 rows | atomics on 1000 addresses serialise, and float atomics sum in arrival order, so \`dγ\` changes run to run |
| \`block_reduce_sum2\` syncs before writing its slots | reuse the slots straight away | the previous row's readers may still be reading \`s_a\` — a write-after-read race |

:::quiz
Q: The backward writes dx[i] inside the same loop that accumulates sum_g and sum_gx. What goes wrong?
- [ ] Nothing — the sums are only needed for dγ
- [x] dx[i] uses partial sums from one thread's columns instead of the row totals, so it is the gradient of a different function
- [ ] Only the last row is wrong
> Every dx_i depends on Σ over the whole row of g and g·x̂. Those totals exist only after the block reduction — after a __syncthreads() inside block_reduce_sum2 — so dx needs a second loop.
:::

# What fused production kernels add

The kernel here is the skeleton the production ones share; they add memory traffic savings and dtype
handling around the same Welford-and-Chan reduction.

| System | What it adds |
| --- | --- |
| PyTorch \`layer_norm_kernel.cu\` | \`vectorized_layer_norm_kernel\`: vector loads, bf16/fp16 in with float accumulation, Welford merge across the block; a separate kernel for \`dγ\`, \`dβ\` |
| Apex \`FusedLayerNorm\` | \`cuWelfordOnlineSum\` / \`cuChanOnlineSum\` are this update and merge; \`cuComputePartGradGammaBeta\` then \`cuComputeGradGammaBeta\` is the partials-then-reduce split |
| Apex contrib \`FastLayerNorm\` | the whole row in registers for the hidden sizes it supports, so the backward reads \`x\` once |
| [Triton tutorial](https://triton-lang.org/main/getting-started/tutorials/05-layer-norm.html) | forward in a few dozen lines with two passes over the row; \`dγ\` accumulated in a lock-protected buffer of partial rows |
| Fused residual LayerNorm | the residual add and dropout before it computed in the same kernel, so the summed row never round-trips to HBM |

:::quiz
Q: RMSNorm computes rstd = 1 / sqrt(mean(x²) + eps) with a plain sum of squares. Why is that safe when E[x²] − E[x]² was not?
- [ ] Because RMSNorm runs in double
- [x] It never subtracts: Σx² of large values is large and accurate to float precision; only the difference of two such sums loses digits
- [ ] Because RMSNorm rows have zero mean by construction
> Rounding error in Σx² is relative to Σx² itself, about 1e-7 of it. RMSNorm divides by that, so the relative error stays 1e-7; LayerNorm's naive variance subtracts E[x]², leaving an absolute error of 1e-7 · 10⁶ on a result of 0.33.
:::

# What to take away

- **LayerNorm is a row reduction plus an elementwise pass.** One block per row, statistics through warp
  shuffles and shared memory, \`rstd = rsqrtf(m2 / cols + eps)\`, \`mean\` and \`rstd\` saved.
- **Never the naive formula in float.** Near a mean of 1000, \`E[x²]\` and \`E[x]²\` sit on a grid 0.0625 apart and the
  variance of 0.33 comes back 0.375 — or negative.
- **Welford per thread, Chan across threads.** Small deviations only, and
  \`m2 = a.m2 + b.m2 + δ² · n_a · n_b / n\` merges any two states exactly, so a tree of merges is a reduction.
- **The backward is two more reductions.** \`Σ dy·γ\` and \`Σ dy·γ·x̂\` per row before \`dx\`; \`dγ\`, \`dβ\` as
  per-block partial rows and a column reduce, with no atomics and a deterministic sum.
- **Production kernels add bandwidth, not math.** Vector loads, half-precision inputs, the row held in
  registers, the residual fused in — around the same merge.

The primary reference is [Ba, Kiros and Hinton, *Layer Normalization*](https://arxiv.org/abs/1607.06450); the
variance algorithms are collected in
[*Algorithms for calculating variance*](https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance).
`;
