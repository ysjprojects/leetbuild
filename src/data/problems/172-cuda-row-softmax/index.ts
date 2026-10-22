import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {rowSoftmaxStep} from './steps/1-row-softmax';

/**
 * Drill: row-wise softmax as one CUDA kernel — one block per row, a block-wide max and a block-wide
 * sum through warp shuffles and shared memory, exp(x − max) so a row of 1e4 logits does not
 * overflow, and a fully masked row that comes out as zeros rather than NaN. The kernel inside every
 * attention score normalisation and every output-head probability.
 */
export const cudaRowSoftmaxProblem: Problem = {
  id: 'cuda-row-softmax',
  title: 'Row-wise softmax: one block per row, two reductions, no overflow',
  tagline:
    'softmax over each row of a 4096 × 1000 fp32 matrix: one block per row, a block max and a block sum through __shfl_xor_sync and shared memory, exp(x − max) so 1e4 logits survive, a masked row of zeros, a CPU reference and PASS.',
  difficulty: 'medium',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 45,
  statement: `# Row-wise softmax: one block per row, two reductions, no overflow

Softmax turns a row of logits into a probability distribution, \`y_c = exp(x_c) / Σ exp(x_k)\`, and a
transformer runs it constantly: over every row of the attention scores \`QKᵀ / √d\` (with a causal or
padding mask written in as \`-inf\`), over the vocabulary at the output head, inside the cross-entropy loss.
Written as the formula it is wrong on a GPU: \`expf\` overflows fp32 above \`x ≈ 88.7\`, and logits pass that
routinely. The fix is a shift by the row max, and the shift is what shapes the kernel — the max must be known
before the first \`exp\`, so softmax is a max reduction, then a sum reduction, then a write.

The surface is one file, \`row_softmax.cu\`, compiled with \`nvcc\`:

- \`__global__ void softmax_rows(const float* x, float* y, int rows, int cols)\` — row-major fp32,
  \`y[r][c] = exp(x[r][c] − m_r) / Σ_c exp(x[r][c] − m_r)\` with \`m_r = max_c x[r][c]\`, any \`cols\`.
- **One block per row**: \`row = blockIdx.x\`, \`THREADS = 256\` threads stride the row by \`blockDim.x\`. The
  host launches \`LAUNCH(softmax_rows, rows, THREADS, d_x, d_y, rows, cols)\` and is written for you.
- **Two block reductions**: a max with \`fmaxf\` and a sum with \`+\`, each across the warp with
  \`__shfl_xor_sync\` (or \`__shfl_down_sync\`), then across the eight warps through \`__shared__\` slots and
  \`__syncthreads()\`.
- **A fully masked row** (all \`-inf\`) comes out as zeros, never NaN.
- No \`cub::\`, \`thrust::\`, cuDNN or cuBLAS; one kernel, one launch.

The self-test fills \`4096 × 1000\` with \`U(−3, 3)\`, puts magnitudes of \`1e4\` in row 0, masks row 1 entirely
and the second half of row 2, and compares against a double-precision CPU reference
(\`max |gpu − cpu| < 1e-5\`, \`max |row sum − 1| < 1e-4\`).

## What you build here

1. \`softmax_rows\`: the block-per-row mapping with a strided loop, a block max and a block sum through warp
   shuffles and shared memory, \`exp(x − m)\` everywhere, the masked-row guards, and the normalised write.

## Run it on your machine

\`\`\`text
nvcc -O2 -o row_softmax row_softmax.cu && ./row_softmax
\`\`\`

A passing run prints the shape, the errors, the timing and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
softmax_rows: 4096 x 1000 fp32, 256 threads per row
max |gpu - cpu| = 3.73e-08   max |row sum - 1| = 4.17e-07   masked row zeros: yes   NaN: no
kernel: 0.0190 ms per launch, 1724 GB/s (read + write)
PASS
\`\`\`

The errors are of the order shown (a few fp32 ulps from \`__expf\` and the float sum); the time and bandwidth
depend on the GPU. The starter's kernel does nothing, so \`y\` comes back as whatever \`cudaMalloc\` left in it
and the run prints \`FAIL\`.

## Left out on purpose

Fp16/bf16 inputs with fp32 accumulation, the warp-per-row and register-resident variants for short rows,
vectorised \`float4\` loads, fusing the scale and mask into the kernel, the backward pass
\`dx = y ⊙ (dy − Σ y ⊙ dy)\`, and the online softmax that fuses max and sum into one pass — the guide covers
it, FlashAttention is built on it.`,
  architecture: {
    input: 'x · 4096 × 1000 fp32 logits',
    output: 'y · every row sums to 1',
    items: [
      {
        id: 'host',
        label: 'Host · main()',
        kind: 'host',
        sub: 'LAUNCH(softmax_rows, rows, 256)',
        detail:
          'Fills `x` with `U(−3, 3)`, row 0 at magnitudes of `1e4`, row 1 all `-inf`, the second half of row 2 `-inf`; one block per row; compares with a double CPU reference and times 50 launches.',
      },
      {
        id: 'gmem-x',
        label: 'Global memory',
        sub: 'x · 4096 × 1000 fp32 · 16.4 MB',
        kind: 'memory',
        shape: 'x[r]: 1000 floats',
        detail:
          'Row-major. A row is 4 KB; on each round of the strided loop a warp reads 32 consecutive floats, one 128-byte transaction.',
      },
      {
        tone: 'block',
        repeat: '4096 ×',
        label: 'Thread block · one row',
        items: [
          {
            tone: 'dotted',
            label: 'pass 1 · max',
            items: [
              {
                id: 'max-local',
                label: 'Strided local max',
                sub: 'fmaxf over c = t, t + 256, …',
                kind: 'kernel',
                detail:
                  '`row = blockIdx.x`; thread `t` starts at `-INFINITY` and visits columns `t, t + blockDim.x, …` below `cols`: 4 rounds for 1000 columns.',
              },
              {
                id: 'max-warp',
                label: 'Warp max',
                sub: 'fmaxf + __shfl_xor_sync 16 … 1',
                kind: 'kernel',
                detail:
                  '`v = fmaxf(v, __shfl_xor_sync(0xffffffff, v, offset))` for offsets 16, 8, 4, 2, 1: a butterfly, every lane ends with the warp max.',
              },
              {
                id: 's-max',
                label: 'Shared s_max[8]',
                sub: 'warp 0 reduces the 8 → m',
                kind: 'memory',
                shape: 'm: one float per row',
                detail:
                  'Lane 0 of each warp writes its slot, `__syncthreads()`, warp 0 reduces them (lanes 8–31 load `-INFINITY`), thread 0 publishes `m`, a second `__syncthreads()`, every thread reads it.',
              },
            ],
          },
          {
            id: 'guard',
            label: 'Masked-row guard',
            sub: 'if (m == -INFINITY) m = 0',
            kind: 'kernel',
            detail:
              'A fully masked row has `m = -inf` and `-inf − (-inf) = NaN`. Shifting by 0 makes every term `__expf(-inf) = 0` instead.',
          },
          {
            tone: 'dotted',
            label: 'pass 2 · sum',
            items: [
              {
                id: 'sum-local',
                label: 'Strided local sum',
                sub: 'Σ __expf(x[c] − m)',
                kind: 'kernel',
                detail:
                  'The same strided walk over the row, now served from L1/L2. Every exponent is at most 0, so every term lies in (0, 1].',
              },
              {
                id: 'sum-warp',
                label: 'Warp sum',
                sub: '+ __shfl_xor_sync 16 … 1',
                kind: 'kernel',
                detail: 'The same five-round butterfly with `+` and identity `0`.',
              },
              {
                id: 's-sum',
                label: 'Shared s_sum[8]',
                sub: 'warp 0 reduces the 8 → sum',
                kind: 'memory',
                shape: 'sum ∈ [1, 1000]',
                detail:
                  'Its own slots, not `s_max`: a fast warp may write its partial sum while a slow one is still reading `m`.',
              },
            ],
          },
          {
            id: 'write',
            label: 'Pass 3 · normalise',
            sub: 'y = __expf(x − m) · inv',
            kind: 'kernel',
            shape: 'y[r]: 1000 floats',
            detail:
              'Recomputes the exponent from the cached row rather than storing it. `inv` is 0 for a fully masked row, so it is written as zeros, never `0 / 0`.',
            side: {label: 'inv', sub: 'sum > 0 ? 1 / sum : 0'},
          },
        ],
      },
      {
        id: 'gmem-y',
        label: 'Global memory',
        sub: 'y · 4096 × 1000 fp32 · 16.4 MB',
        kind: 'memory',
        detail:
          'Copied back and compared: `max |gpu − cpu| < 1e-5`, `max |row sum − 1| < 1e-4`, row 1 all zeros, no NaN.',
      },
    ],
    notes: [
      {at: 'gmem-x', text: '**16.4 MB** from DRAM once; re-reads hit L1/L2'},
      {at: 'max-warp', text: '**5** shuffles per warp, **8** warps per row'},
      {at: 'guard', text: 'All -inf row: shift by **0**, not by -inf'},
      {at: 's-sum', text: 'Sum in **[1, 1000]** when unmasked'},
      {at: 'gmem-y', text: '**8 bytes** per element: memory-bound'},
    ],
  },
  steps: [rowSoftmaxStep],
  learn,
};
