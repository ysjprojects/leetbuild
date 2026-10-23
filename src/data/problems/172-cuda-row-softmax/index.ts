import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {rowSoftmaxStep} from './steps/1-row-softmax';

/**
 * Drill: row-wise softmax as one CUDA kernel: one block per row, a block-wide max and a block-wide
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
  track: 'dllm',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 45,
  statement: `# Row-wise softmax: one block per row, two reductions, no overflow

Softmax turns a row of logits into a probability distribution, \`y_c = exp(x_c) / Σ exp(x_k)\`, and a
transformer runs it constantly: over every row of the attention scores \`QKᵀ / √d\` (with a causal or
padding mask written in as \`-inf\`), over the vocabulary at the output head, inside the cross-entropy loss.
Written as the formula it is wrong on a GPU: \`expf\` overflows fp32 above \`x ≈ 88.7\`, and logits pass that
routinely. The fix is a shift by the row max, and the shift is what shapes the kernel: the max must be known
before the first \`exp\`, so softmax is a max reduction, then a sum reduction, then a write.

The surface is one file, \`row_softmax.cu\`, compiled with \`nvcc\`:

- \`__global__ void softmax_rows(const float* x, float* y, int rows, int cols)\`: row-major fp32,
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
\`dx = y ⊙ (dy − Σ y ⊙ dy)\`, and the online softmax that fuses max and sum into one pass (the guide covers
it; FlashAttention is built on it).`,
  figures: [
    {
      title: 'One block per row',
      gpu: {
        align: 'end',
        items: [
          {
            id: 'gmem',
            label: 'Global memory',
            sub: 'row-major fp32 · 16.4 MB each',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'x',
                array: 'x · 4096 × 1000',
                sub: 'row = one block · cell = 32 floats',
                cols: 32,
                rows: 6,
                cells: Array.from({length: 32}, (_, k) => `w${k % 8}`),
                marks: [
                  {cols: [0, 31], rows: [0, 0], tone: 'a'},
                  {cols: [0, 31], rows: [1, 1], tone: 'muted', label: 'row 1: all -inf'},
                  {cols: [16, 31], rows: [2, 2], tone: 'muted', label: 'masked half'},
                ],
                detail:
                  'Block `r` owns row `r` (4 KB) and nobody else touches it. A cell is 32 floats, one warp’s load: in each round of the strided loop warp `w` reads cell `w`, the 8 warps cover 256 columns, and 4 rounds cover 1,000 (the last cell holds only 8). The self-test puts magnitudes of `1e4` in row 0, masks row 1 entirely and the second half of row 2.',
              },
              {
                id: 'y',
                array: 'y · same shape',
                sub: 'every row sums to 1',
                cols: 32,
                rows: 6,
                marks: [{cols: [0, 31], rows: [1, 1], tone: 'muted', label: 'zeros, never NaN'}],
                detail:
                  'Copied back and compared with a double reference: `max |gpu − cpu| < 1e-5`, `max |row sum − 1| < 1e-4`, row 1 all zeros, no NaN anywhere. 8 bytes of DRAM traffic per element: memory-bound.',
              },
            ],
          },
          {
            id: 'grid',
            label: 'Kernel grid',
            sub: 'softmax_rows<<<4096, 256>>>',
            count: '4,096 blocks',
            items: [
              {
                id: 'block0',
                label: 'Block 0 · row 0',
                sub: '256 threads · 8 warps',
                layout: 'column',
                items: [
                  {
                    id: 'pass-max',
                    label: 'Pass 1 · row max',
                    sub: 'fmaxf in registers, then shuffles',
                    align: 'end',
                    stretch: true,
                    items: [
                      {
                        id: 'max-local',
                        threads: 8,
                        continues: true,
                        label: 'v = local max, 4 rounds',
                        detail:
                          '`row = blockIdx.x`; thread `t` starts at `-INFINITY` and visits columns `t, t + blockDim.x, …` below `cols`. Then `v = fmaxf(v, __shfl_xor_sync(0xffffffff, v, offset))` for offsets 16, 8, 4, 2, 1: every lane ends with its warp’s max.',
                      },
                      {
                        id: 's-max',
                        array: 's_max',
                        sub: 'one slot per warp',
                        cols: 8,
                        tone: 'shared',
                        cells: 'index',
                        detail:
                          'Lane 0 of each warp writes its slot, `__syncthreads()`, warp 0 reduces the 8 (lanes 8–31 load `-INFINITY`), thread 0 writes `m` to `s_max[0]`, a second `__syncthreads()`, every thread reads it.',
                      },
                    ],
                  },
                  {
                    id: 'pass-sum',
                    label: 'Pass 2 · row sum',
                    sub: 'Σ __expf(x − m), then shuffles',
                    align: 'end',
                    stretch: true,
                    items: [
                      {
                        id: 'guard',
                        label: 'm',
                        sub: 's_max[0] · -inf → 0',
                        tone: 'register',
                        detail:
                          'A fully masked row has `m = -inf`, and `-inf − (-inf)` is NaN. `if (m == -INFINITY) m = 0` makes every term `__expf(-inf) = 0` instead.',
                      },
                      {
                        id: 'sum-local',
                        threads: 8,
                        continues: true,
                        label: 'v = local sum, 4 rounds',
                        detail:
                          'The same strided walk over the row, now served from L1/L2. Every exponent is at most 0, so every term lies in (0, 1]. Then the same five-round butterfly with `+` and identity `0`.',
                      },
                      {
                        id: 's-sum',
                        array: 's_sum',
                        sub: 'its own slots',
                        cols: 8,
                        tone: 'shared',
                        cells: 'index',
                        detail:
                          'Not `s_max`: a fast warp may write its partial sum while a slow one is still reading `m` from `s_max[0]`. The total lies in `[1, 1000]` for an unmasked row.',
                      },
                    ],
                  },
                  {
                    id: 'write',
                    label: 'Pass 3 · write',
                    sub: 'y = __expf(x − m) · inv',
                    align: 'end',
                    stretch: true,
                    items: [
                      {
                        id: 'inv',
                        label: 'inv',
                        sub: 'sum > 0 ? 1 / sum : 0',
                        tone: 'register',
                        detail: 'A fully masked row has `sum = 0`; `inv = 0` writes `0 × 0`, never `0 / 0`.',
                      },
                      {
                        threads: 8,
                        continues: true,
                        label: 'one y per element',
                      },
                    ],
                    detail:
                      'Recomputes the exponent from the cached row rather than storing it: the kernel is memory-bound, and a few SFU cycles are cheaper than registers or a round trip to DRAM.',
                  },
                ],
                detail:
                  'One block per row: both reductions stay inside the block, so there are no atomics, no second launch and no other block to wait for. Four barriers per row, two per reduction.',
              },
              {gap: '…'},
            ],
            detail: '4,096 rows, 4,096 blocks: enough to keep every SM busy several times over.',
          },
        ],
        arrows: [
          {from: 'x', to: 'block0', label: 'x[r], each pass'},
          {from: 'write', to: 'y', label: 'y[r]'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Online normalizer calculation for softmax',
      url: 'https://arxiv.org/abs/1805.02867',
      by: 'Maxim Milakov and Natalia Gimelshein',
      date: '2018-05-08',
      venue: 'arXiv',
      takes:
        'The safe softmax `exp(x − m) / Σ exp(x − m)` that `softmax_rows` computes with a max pass, a sum pass and a write, and the one-pass online normaliser that would fuse the first two.',
    },
    {
      kind: 'code',
      title: 'online-softmax',
      url: 'https://github.com/NVIDIA/online-softmax',
      by: 'NVIDIA',
      date: '2018-07-26',
      venue: 'GitHub',
      takes:
        'The paper’s CUDA benchmark: naive, safe and online softmax kernels over a row per block, the same layout as `softmax_rows`.',
    },
    {
      kind: 'post',
      title: 'Faster Parallel Reductions on Kepler',
      url: 'https://developer.nvidia.com/blog/faster-parallel-reductions-kepler/',
      by: 'Justin Luitjens',
      date: '2014-02-13',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The block reduction used twice, once with `fmaxf` and once with `+`: shuffle within each warp, one shared slot per warp, then the eight slots reduced by one warp.',
    },
    {
      kind: 'docs',
      title: 'Warp Shuffle Functions',
      url: 'https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/cpp-language-extensions.html#warp-shuffle-functions',
      venue: 'CUDA Programming Guide',
      takes:
        '`__shfl_xor_sync` and `__shfl_down_sync`: the butterfly that leaves the row max in every lane, against the tree that leaves it only in lane 0.',
    },
    {
      kind: 'docs',
      title: 'Fused Softmax',
      url: 'https://triton-lang.org/main/getting-started/tutorials/02-fused-softmax.html',
      venue: 'Triton documentation',
      takes:
        'The same row-per-program softmax in Triton, with the bandwidth argument for keeping the row on chip between the max, the sum and the write.',
    },
  ],
  steps: [rowSoftmaxStep],
  learn,
};
