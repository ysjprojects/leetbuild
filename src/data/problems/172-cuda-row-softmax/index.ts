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
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · main()',
        sub: 'U(−3,3) · row 0 at 1e4 · masked rows · CPU double ref · PASS',
        x: 8,
        y: 50,
      },
      {
        id: 'kernel',
        kind: 'service',
        label: 'softmax_rows<<<rows, 256>>>',
        sub: 'block r owns row r · max → sum → write',
        x: 38,
        y: 50,
      },
      {id: 'smem', kind: 'db', label: 'Shared memory', sub: 's_max[8] · s_sum[8] warp partials', x: 66, y: 22},
      {id: 'hbm', kind: 'db', label: 'Global memory', sub: 'd_x · d_y · 4096 × 1000 fp32 (16 MB each)', x: 66, y: 78},
    ],
    edges: [
      {from: 'host', to: 'hbm', kind: 'plain', label: 'cudaMemcpy x in · y out'},
      {from: 'host', to: 'kernel', kind: 'plain', label: 'LAUNCH · 50 timed launches'},
      {from: 'kernel', to: 'smem', kind: 'plain', label: 'lane 0 partials · __syncthreads'},
      {from: 'kernel', to: 'hbm', kind: 'plain', label: 'read x (×3, cached) · write y'},
    ],
  },
  steps: [rowSoftmaxStep],
  learn,
};
