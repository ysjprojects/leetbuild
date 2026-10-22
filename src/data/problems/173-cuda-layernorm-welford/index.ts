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
  architecture: {
    input: 'x, dy · 256 × 1000 fp32 · γ, β',
    output: 'y, dx, dγ, dβ vs a double reference',
    items: [
      {
        id: 'host',
        label: 'Host · main()',
        kind: 'host',
        sub: 'rows 0, 64, 128, 192 at 1000 ± 1',
        detail:
          'Fills `x`, `dy`, `gamma`, `beta`; four rows are `1000 + U(−1, 1)`, the rest `2 · U(−1, 1)`. Launches the three kernels and compares six outputs with a double-precision CPU reference, each `≤ 1e-3`.',
      },
      {
        id: 'gmem-x',
        label: 'Global memory',
        sub: 'x[256, 1000] · 1 MB',
        kind: 'memory',
        shape: 'x[row]: 1000 floats',
        detail: 'Row-major. Each block owns one row of 4 KB and reads it with warp-contiguous strided loads.',
      },
      {
        tone: 'block',
        repeat: '256 ×',
        label: 'layernorm_fwd · one row',
        items: [
          {
            id: 'welford',
            label: 'Welford per thread',
            sub: '(n, mean, M2) · c = t, t + 256, …',
            kind: 'kernel',
            shape: '256 states',
            detail:
              '`welford_update`: `count += 1`, `delta = v − mean`, `mean += delta / count`, `m2 += delta · (v − mean)`. Only products of small deviations, never squares of values near 1000.',
          },
          {
            tone: 'dotted',
            label: 'each of 8 warps',
            items: [
              {
                id: 'warp-merge',
                label: 'Chan merge via shuffles',
                sub: '__shfl_down_sync 16, 8, 4, 2, 1',
                kind: 'kernel',
                shape: 'lane 0: warp state',
                detail:
                  '`warp_welford`: shuffle `count`, `mean` and `m2` down, then `welford_merge`. Chan’s merge is exact, so any tree of merges gives the row’s statistics.',
              },
            ],
          },
          {
            id: 's-warp',
            label: 'Shared s_warp[32]',
            sub: 'one Welford per warp · barrier',
            kind: 'memory',
            shape: '8 states',
            detail: 'Lane 0 of warp `w` writes `s_warp[w]`, then `__syncthreads()`.',
          },
          {
            tone: 'dotted',
            label: 'warp 0',
            items: [
              {
                id: 'warp0',
                label: 'Warp 0 merges 8 states',
                sub: 'rstd = rsqrtf(M2 / N + eps)',
                kind: 'kernel',
                shape: 'mean, rstd',
                detail:
                  'Lanes 8–31 load empty states (`count = 0`), which merge without `0 / 0`. Thread 0 computes the biased variance `m2 / cols` and `rsqrtf`, writes `mean[row]`, `rstd[row]` and two shared floats; a second `__syncthreads()` publishes them.',
              },
            ],
          },
          {
            id: 'norm',
            label: 'Normalise with γ, β',
            sub: 'y = (x − mean)·rstd·γ + β',
            kind: 'kernel',
            shape: 'y[row]: 1000 floats',
            detail:
              'An elementwise pass over the row, served from L1/L2; `gamma` and `beta` are shared by every block.',
            side: {label: 'γ, β', sub: '[1000] · from cache'},
          },
        ],
      },
      {
        id: 'saved',
        label: 'Saved statistics',
        sub: 'mean[row], rstd[row] · y written',
        kind: 'memory',
        detail: 'Two floats per row, so the backward recomputes `x̂` elementwise instead of reducing the row again.',
      },
      {
        id: 'bwd',
        label: 'layernorm_bwd<<<64, 256>>>',
        sub: 'Σ dy·γ, Σ dy·γ·x̂ per row → dx',
        kind: 'kernel',
        detail:
          'Block `b` handles rows `b, b + 64, …`: two block reductions per row, then `dx`, and its own partial row of `dγ` and `dβ`.',
        side: {label: 'dy', sub: '[256, 1000]'},
      },
      {
        id: 'partials',
        label: 'dγ, dβ partial rows',
        sub: '[64, 1000] each · no atomics',
        kind: 'memory',
        detail:
          'Block `b` zeroes row `b` first; thread `t` alone touches the columns `c ≡ t (mod 256)` of it, so `+=` needs no atomic.',
      },
      {
        id: 'reduce',
        label: 'layernorm_bwd_reduce',
        sub: 'one thread per column · 64 rows',
        kind: 'kernel',
        detail: 'Thread `c` sums `partial[p, c]` over the 64 partial rows in a fixed order: the same bits every run.',
      },
      {
        id: 'grads',
        label: 'Global memory',
        sub: 'dx · dγ[1000] · dβ[1000]',
        kind: 'memory',
      },
    ],
    notes: [
      {at: 'gmem-x', text: 'Rows at **1000** ± 1: E[x²] − E[x]² fails here'},
      {at: 'welford', text: 'Up to **4** columns per thread, one read of x'},
      {at: 'warp-merge', text: 'Chan: M2 += **δ²·n_a·n_b / n**'},
      {at: 'saved', text: '**2** floats per row: no second variance', side: 'left'},
      {at: 'partials', text: '**64** partial rows, then a column sum', side: 'left'},
    ],
    insets: [
      {
        for: 'bwd',
        title: 'layernorm_bwd, per row',
        items: [
          {id: 'bwd-load', label: 'Recompute x̂ and g', sub: 'x̂ = (x − mean)·rstd · g = dy·γ', kind: 'kernel'},
          {id: 'sum2', label: 'block_reduce_sum2', sub: 'Σ g, Σ g·x̂ → every thread', kind: 'kernel'},
          {id: 'dx', label: 'Write dx', sub: 'rstd·(g − (Σg + x̂·Σgx̂) / N)', kind: 'kernel'},
          {id: 'acc', label: 'Add to partial row b', sub: '+= dy·x̂, dy · thread owns its c', kind: 'kernel'},
        ],
        note: 'A barrier between the **row totals** and dx',
      },
    ],
  },
  steps: [layernormKernelsStep],
  learn,
};
