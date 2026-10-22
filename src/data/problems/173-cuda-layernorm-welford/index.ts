import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {layernormKernelsStep} from './steps/1-layernorm-kernels';

/**
 * Hard: LayerNorm forward and backward as CUDA kernels — one block per row, a one-pass mean and
 * variance by Welford merged across threads with Chan's parallel combination through warp shuffles
 * and shared memory, rsqrtf, the saved per-row statistics, the backward's two row reductions and
 * per-column gamma/beta partials with a final reduce, checked against a double CPU reference on
 * rows offset by 1000 where E[x²] − E[x]² falls apart.
 */
export const cudaLayernormWelfordProblem: Problem = {
  id: 'cuda-layernorm-welford',
  title: "LayerNorm forward and backward kernels with Welford's variance",
  tagline:
    'One block per row: Welford per thread, Chan’s merge through warp shuffles and shared memory, rsqrtf, mean and rstd saved for a backward that reduces Σ dy·γ and Σ dy·γ·x̂ per row and sums dγ, dβ from per-block partials — exact on rows at 1000 where E[x²] − E[x]² is not.',
  difficulty: 'hard',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 80,
  statement: `# LayerNorm forward and backward kernels with Welford's variance

Every transformer block normalises its activations twice — before attention and before the MLP in a
pre-LN model like GPT-2, Llama (as RMSNorm) or a ViT — so LayerNorm runs 2 × layers times per token in the
forward pass and as many again in the backward. It is the per-row normalisation of Ba, Kiros and Hinton,
*Layer Normalization* (2016):

\`\`\`text
mean = Σ x / cols        var = Σ (x − mean)² / cols        rstd = 1 / sqrt(var + eps)
y    = (x − mean) · rstd · gamma + beta
\`\`\`

The kernel is a row reduction followed by an elementwise pass, and the reduction is where the trouble is.
The one-pass formula \`var = E[x²] − E[x]²\` is what a first kernel writes, and in float it is wrong whenever
the mean is large next to the spread: a row at 1000 ± 1 subtracts two numbers near 10⁶ that differ in their
seventh digit. Welford's update and Chan's merge compute the same variance in one pass without the
subtraction, and they merge across threads, warps and blocks — which is how PyTorch's and Apex's fused
LayerNorm kernels do it.

The surface is one file, \`layernorm_kernels.cu\`, row-major \`float\` throughout (\`x\`, \`y\`, \`dy\`, \`dx\` are
\`[rows, cols]\`; \`gamma\`, \`beta\`, \`dgamma\`, \`dbeta\` are \`[cols]\`; \`mean\`, \`rstd\` are \`[rows]\`):

- \`struct Welford {float count, mean, m2;}\` (given), \`welford_update(Welford&, float)\`,
  \`welford_merge(const Welford&, const Welford&)\` — Chan's \`delta² · n_a · n_b / n\` — and \`warp_welford\`, a
  \`__shfl_down_sync\` tree of merges.
- \`__global__ void layernorm_fwd(x, gamma, beta, y, mean, rstd, rows, cols, eps)\` — \`<<<rows, 256>>>\`, one
  block per row; per-thread Welford, merged across the warp and through \`__shared__\` slots across the block;
  \`rstd = rsqrtf(m2 / cols + eps)\`; \`mean[row]\` and \`rstd[row]\` saved; \`y\` written.
- \`__global__ void layernorm_bwd(dy, x, gamma, mean, rstd, dx, dgamma_partial, dbeta_partial, rows, cols)\` —
  \`<<<min(rows, 64), 256>>>\`; per row the two reductions \`Σ dy·γ\` and \`Σ dy·γ·x̂\` and
  \`dx = rstd · (dy·γ − (Σ dy·γ + x̂ · Σ dy·γ·x̂) / cols)\`; per block a partial row of \`dγ = Σ dy·x̂\` and
  \`dβ = Σ dy\`.
- \`__global__ void layernorm_bwd_reduce(dgamma_partial, dbeta_partial, dgamma, dbeta, parts, cols)\` — one
  thread per column sums the partial rows.

Host code — \`CUDA_CHECK\`, the launch helpers, event timing, a double-precision CPU reference and the
comparison — is given.

## What you build here

1. The Welford update and Chan merge, the warp and block reductions over them, \`layernorm_fwd\` with
   \`rsqrtf\` and the saved statistics, \`block_reduce_sum2\`, \`layernorm_bwd\` with its two row reductions and
   per-block \`dγ\`/\`dβ\` partials, and \`layernorm_bwd_reduce\` — compared against the CPU on rows at 1000.

## Run it on your machine

\`\`\`text
nvcc -O2 -o layernorm_kernels layernorm_kernels.cu && ./layernorm_kernels
\`\`\`

A passing run prints the timings, the six errors, the variance of row 0 (one of the rows at 1000) and
\`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
rows=256 cols=1000  fwd 0.0071 ms  bwd 0.0162 ms
max err  y 9.12e-05  mean 4.65e-08  rstd 2.99e-06  dx 8.93e-06  dgamma 1.92e-04  dbeta 1.91e-06
row 0 (mean 999.9944): var 0.328432, reference 0.328432
PASS
\`\`\`

The times depend on the GPU and the errors move in their last digit with it (each is
\`|gpu − ref| / max(1, |ref|)\`, and all six must be \`≤ 1e-3\`). The same kernel with \`E[x²] − E[x]²\` prints a
variance of 0.375 for row 0 and a \`y\` error near 0.3. The starter prints \`FAIL\` with every error at 1: its
kernels write nothing, so every output is still the zeros it was set to.

## Left out on purpose

bf16/fp16 inputs with float accumulation, \`float4\` vectorised loads, keeping the row in registers or shared
memory so the backward reads \`x\` once, a warp-per-row layout for small \`cols\`, fusing the residual add and
dropout into the same kernel, RMSNorm (the same kernel without the mean), and the PyTorch
\`torch.autograd.Function\` / C++ extension that would wire these kernels into a model. Each one sits on the
reduction written here.`,
  figures: [
    {
      title: 'Forward: one block per row',
      gpu: {
        align: 'center',
        items: [
          {
            id: 'gmem',
            label: 'Global memory',
            sub: 'row-major float',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'x',
                array: 'x · 256 × 1000',
                sub: 'cell = 100 floats',
                cols: 10,
                rows: 14,
                marks: [{cols: [0, 9], rows: [0, 0], tone: 'register', label: '1000 ± 1'}],
                detail:
                  'Row `r` belongs to block `r`. Rows 0, 64, 128, 192 are `1000 + U(−1, 1)` (row 0 marked), where `E[x²] − E[x]²` falls apart; the rest `2 · U(−1, 1)`. Block `r` reads its row once, with warp-contiguous strided loads, into its threads’ Welford states.',
              },
              {
                id: 'gb',
                array: 'γ, β · [1000]',
                sub: 'all blocks',
                cols: 10,
                rows: 2,
                detail: 'Read by every block for its `y` pass, so they stay in L2 (and L1).',
              },
              {
                id: 'saved',
                array: 'mean, rstd · [256]',
                sub: 'kept',
                cols: 10,
                rows: 2,
                marks: [{cols: [0, 0], rows: [0, 1], tone: 'global'}],
                detail:
                  'Two floats per row (row 0’s marked), saved so the backward recomputes `x̂` elementwise instead of reducing the row again.',
              },
              {
                id: 'y',
                array: 'y · 256 × 1000',
                cols: 10,
                rows: 14,
                marks: [{cols: [0, 9], rows: [0, 0], tone: 'global'}],
                detail: 'Compared with a double-precision CPU reference: `|gpu − ref| / max(1, |ref|) ≤ 1e-3`.',
              },
            ],
          },
          {
            id: 'grid',
            label: 'Kernel grid',
            sub: 'layernorm_fwd<<<256, 256>>>',
            count: '256 blocks',
            items: [
              {
                id: 'block0',
                label: 'Block 0 · row 0',
                sub: '256 threads · 8 warps',
                layout: 'column',
                items: [
                  {
                    id: 'welford',
                    label: 'Welford per thread',
                    sub: 'c = t, t + 256, … · 3 or 4 values',
                    items: [
                      {
                        label: 'Thread 0',
                        align: 'end',
                        items: [{threads: 1}, {array: 's', cols: 3, tone: 'register', cells: ['n', 'μ', 'M2']}],
                      },
                      {
                        label: 'Thread 1',
                        align: 'end',
                        items: [{threads: 1}, {array: 's', cols: 3, tone: 'register', cells: ['n', 'μ', 'M2']}],
                      },
                      {gap: '…'},
                      {
                        label: 'Thread 255',
                        align: 'end',
                        items: [{threads: 1}, {array: 's', cols: 3, tone: 'register', cells: ['n', 'μ', 'M2']}],
                      },
                    ],
                    detail:
                      '`welford_update`: `count += 1`, `delta = v − mean`, `mean += delta / count`, `m2 += delta · (v − mean)`. Three registers per thread, and only products of small deviations, never squares of values near 1000.',
                  },
                  {
                    id: 'warp-merge',
                    label: 'Chan merge per warp',
                    sub: 'shfl n, μ, M2 down 16 … 1, merge',
                    layout: 'column',
                    items: [{threads: 16, continues: true, label: 'lane 0 ends with the warp’s state'}],
                    detail:
                      '`warp_welford`: `__shfl_down_sync(FULL_MASK, …)` of `count`, `mean` and `m2`, then `welford_merge`, `m2 = a.m2 + b.m2 + δ² · n_a · n_b / n`. Chan’s merge is exact, so any tree of merges gives the row’s statistics.',
                  },
                  {
                    id: 's-warp',
                    label: 'Shared memory',
                    sub: '__shared__ Welford s_warp[32]',
                    tone: 'shared',
                    stretch: true,
                    layout: 'column',
                    items: [
                      {
                        id: 's-warp-slots',
                        array: 's_warp',
                        sub: 'one state per warp',
                        cols: 16,
                        continues: true,
                        tone: 'shared',
                        cells: 'index',
                        marks: [
                          {cols: [0, 7], tone: 'shared', label: 'warps 0–7'},
                          {cols: [8, 15], tone: 'muted', label: 'unused'},
                        ],
                        detail:
                          'Lane 0 of warp `w` writes `s_warp[w]`, then `__syncthreads()`. The block also keeps two shared floats, the row’s `mean` and `rstd`, published behind a second barrier.',
                      },
                    ],
                  },
                  {
                    id: 'warp0',
                    label: 'Warp 0 merges the 8 states',
                    sub: 'rstd = rsqrtf(M2 / cols + eps)',
                    layout: 'column',
                    items: [{threads: 16, idle: 8, continues: true, label: 'lanes 8–31: count = 0'}],
                    detail:
                      'Lanes 8–31 load empty states (`count = 0`), which merge without `0 / 0`. Thread 0 computes the biased variance `m2 / cols` and `rsqrtf`, writes `mean[row]`, `rstd[row]` and the two shared floats; a second `__syncthreads()` publishes them.',
                  },
                  {
                    id: 'norm',
                    label: 'Every thread writes y',
                    sub: 'y = (x − mean) · rstd · γ + β',
                    layout: 'column',
                    items: [{threads: 16, continues: true, label: 'its own columns again'}],
                    detail:
                      'An elementwise pass over the row, served from L1/L2; `gamma` and `beta` are shared by every block.',
                  },
                ],
                detail: 'One block per row: rows are independent, so no block talks to another. Two barriers per row.',
              },
            ],
            detail: 'One block per row, 256 rows: block 0 is drawn; the others run the same code on their own rows.',
          },
        ],
        arrows: [
          {from: 'x', to: 'welford', label: 'x[row], once'},
          {from: 'warp-merge', to: 's-warp', label: 'lane 0 of each warp'},
          {from: 's-warp', to: 'warp0', label: 'after __syncthreads()'},
          {from: 'warp0', to: 'saved', label: 'mean, rstd'},
          {from: 'norm', to: 'y', label: 'y[row]'},
        ],
      },
    },
    {
      title: 'Backward: partial rows, then columns',
      gpu: {
        align: 'end',
        items: [
          {
            id: 'bwd',
            label: 'layernorm_bwd',
            sub: '<<<64, 256>>> · rows b, b + 64, …',
            count: '64 blocks',
            items: [
              {
                id: 'bwd-block0',
                label: 'Block 0',
                sub: 'rows 0, 64, 128, 192',
                layout: 'column',
                items: [
                  {
                    id: 'bwd-load',
                    label: 'Per row: x̂ and g',
                    sub: 'x̂ = (x − mean)·rstd · g = dy·γ',
                    layout: 'column',
                    items: [{threads: 12, continues: true, label: 'sum_g, sum_gx in registers'}],
                    detail:
                      'Reads the saved `mean[row]` and `rstd[row]`: no second variance. Each thread accumulates `sum_g += g` and `sum_gx += g · x̂` over its columns.',
                  },
                  {
                    id: 'sum2',
                    label: 'block_reduce_sum2',
                    sub: 'Σ g, Σ g·x̂ → every thread',
                    tone: 'shared',
                    stretch: true,
                    detail:
                      '`__shfl_xor_sync` within each warp, a `__shared__` slot per warp for each sum, warp 0 over the slots. It syncs before writing the slots, so the previous row’s readers are done.',
                  },
                  {
                    id: 'dx',
                    label: 'Write dx',
                    sub: 'rstd·(g − (Σg + x̂·Σgx̂) / cols)',
                    layout: 'column',
                    items: [{threads: 12, continues: true, label: 'a second loop over the row'}],
                    detail:
                      'Every `dx_i` needs the row totals, which exist only after the block reduction and its barrier: writing `dx` in the first loop would use one thread’s partial sums.',
                  },
                  {
                    id: 'acc',
                    label: 'Add to partial row 0',
                    sub: '+= dy·x̂ and += dy',
                    layout: 'column',
                    items: [{threads: 12, continues: true, label: 'thread t owns c ≡ t (mod 256)'}],
                    detail:
                      'Block `b` zeroes partial row `b` first; thread `t` alone touches its columns of that row, so `+=` needs no atomic.',
                  },
                ],
              },
              {gap: '…'},
            ],
          },
          {
            id: 'bwd-gmem',
            label: 'Global memory',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'dy-x',
                array: 'dy, x · 256 × 1000',
                sub: 'with saved mean, rstd',
                cols: 16,
                rows: 4,
                marks: [{cols: [0, 15], rows: [0, 0], tone: 'register', label: 'row 0 → block 0'}],
                detail:
                  'Block `b` takes rows `b, b + 64, …`: four rows each for 256 rows. It also reads `gamma` and the two saved statistics of each row.',
              },
              {
                id: 'dx-out',
                array: 'dx · 256 × 1000',
                cols: 16,
                rows: 4,
              },
              {
                id: 'partials',
                array: 'dγ, dβ partial · 64 × 1000',
                sub: 'one row per block',
                cols: 16,
                rows: 4,
                marks: [
                  {cols: [0, 15], rows: [0, 0], tone: 'global', label: 'block 0'},
                  {cols: [3, 3], rows: [0, 3], tone: 'register'},
                ],
                detail:
                  'Two `[64, 1000]` arrays, 256 KB each. Row `b` belongs to block `b`; the marked column is what one thread of the reduce kernel sums.',
              },
              {
                id: 'grads',
                array: 'dγ, dβ · [1000]',
                cols: 16,
                marks: [{cols: [3, 3], tone: 'register', label: 'column c'}],
              },
            ],
          },
          {
            id: 'reduce',
            label: 'layernorm_bwd_reduce',
            sub: 'one thread per column',
            count: '1,000 threads',
            layout: 'column',
            items: [{threads: 12, continues: true, label: 'thread c: Σ over 64 rows'}],
            detail:
              'Thread `c` sums `partial[p, c]` over the 64 partial rows in a fixed order: the same bits every run, unlike float `atomicAdd`s in arrival order. Adjacent threads read adjacent columns, so the loads coalesce.',
          },
        ],
        arrows: [
          {from: 'dy-x', to: 'bwd-block0', label: 'dy, x[row]'},
          {from: 'dx', to: 'dx-out', label: 'dx[row]'},
          {from: 'acc', to: 'partials', label: 'partial row 0'},
          {from: 'partials', to: 'reduce', label: 'column c'},
          {from: 'reduce', to: 'grads', label: 'dγ[c], dβ[c]'},
        ],
      },
    },
  ],
  steps: [layernormKernelsStep],
  learn,
};
