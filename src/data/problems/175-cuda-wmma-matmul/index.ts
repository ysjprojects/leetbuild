import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {wmmaMatmulStep} from './steps/1-wmma-matmul';

/**
 * Drill: a matmul on tensor cores through `nvcuda::wmma`: fp16 inputs, fp32 accumulation, one warp
 * per 16 × 16 output tile, the leading dimensions and alignment the fragment loads demand, a
 * shared-memory-staged variant with 64 × 64 block tiles, host-side padding to multiples of 16, and a
 * benchmark against a plain tiled fp32 kernel. The warp-level contract cuBLAS and CUTLASS are built on.
 */
export const cudaWmmaMatmulProblem: Problem = {
  id: 'cuda-wmma-matmul',
  title: 'Matmul on tensor cores with WMMA',
  tagline:
    'C = A · B with fp16 inputs and fp32 accumulation on tensor cores: wmma fragments of 16 × 16 × 16, one warp per output tile, the right leading dimensions, a shared-memory-staged 64 × 64 block tile, padding to multiples of 16, a CPU reference and a TFLOP/s line against tiled fp32.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# Matmul on tensor cores with WMMA

Almost every FLOP a transformer spends is a matrix multiply (the Q/K/V and output projections, the two MLP
matrices, the logits), and since Volta those FLOPs run on **tensor cores**: units that multiply small fp16
(later bf16, tf32, fp8) tiles and accumulate in fp32, at 8 to 16 times the peak of the ordinary fp32
pipeline on data-center GPUs. \`torch.matmul\` reaches them through cuBLAS; the lowest level of CUDA C++ that reaches them
directly is \`nvcuda::wmma\` (\`#include <mma.h>\`), the *warp matrix* API: a warp loads a 16 × 16 tile of A and
of B into **fragments**, issues \`mma_sync\`, and stores a 16 × 16 tile of C. This drill writes that kernel,
then stages it through shared memory, and measures both against a plain tiled fp32 kernel.

The surface is one file, \`wmma_matmul.cu\`, compiled with \`nvcc -arch=sm_80\` (use your GPU's \`sm_XY\`, 70 or later). \`A\` is
\`M × K\`, \`B\` is \`K × N\`, both \`half\` and row-major; \`C\` is \`M × N\` \`float\`:

- \`__global__ void wmma_matmul(const half* A, const half* B, float* C, int M, int N, int K)\`: one warp per
  16 × 16 tile of \`C\`, 4 warps per 128-thread block along a row of tiles, fragments loaded straight from
  global memory with \`ldm = K\` for \`A\` and \`ldm = N\` for \`B\`, \`K / 16\` calls of \`mma_sync(acc, a, b, acc)\`,
  one \`store_matrix_sync(…, N, wmma::mem_row_major)\`.
- \`__global__ void wmma_matmul_smem(…same signature…)\`: a 64 × 64 block tile; the 128 threads fill
  \`__shared__ __align__(32) half As[64][40]\` and \`Bs[32][72]\` in steps of 32 along K, each of the 2 × 2 warps
  multiplies its 32 × 32 quarter as 2 × 2 accumulators, two \`__syncthreads()\` per step.
- \`pad16\`, \`upload_padded\`, \`download\`: every dimension rounded up to a multiple of 16, the inputs copied into
  zeroed padded buffers with \`cudaMemcpy2D\` and the \`M × N\` corner of \`C\` copied back.
- \`main\`: fp16 inputs from a fixed-seed generator, an fp32 CPU reference over the same rounded values, the
  max abs error against \`2e-5 × K\` for both kernels at 256 × 384 × 512 and 250 × 375 × 500, a 1024³ timing of
  the tiled fp32 kernel and both WMMA kernels in TFLOP/s, and \`PASS\`.

## What you build here

1. \`wmma_matmul\`, \`wmma_matmul_smem\` and the padding around them: fragments of the right shape, type and
   layout, a zeroed accumulator that \`mma_sync\` accumulates into, the K loop in steps of 16 with the right
   leading dimensions, the row-major store, the warp-per-tile mapping, the aligned shared tiles between two
   barriers, and \`pad16\` with \`cudaMemcpy2D\` on the host. No cuBLAS, no CUTLASS.

## Run it on your machine

\`\`\`text
nvcc -O2 -arch=sm_80 -o wmma_matmul wmma_matmul.cu && ./wmma_matmul
\`\`\`

A passing run prints the device, one \`ok\` line per kernel and shape, the benchmark and \`PASS\`; the shape of
the output is

\`\`\`text
<device name> (sm_80)
wmma_matmul       M=256 N=384 K=512  max|C - ref| = <error>  (tol 1.0e-02)  ok
wmma_matmul_smem  M=256 N=384 K=512  max|C - ref| = <error>  (tol 1.0e-02)  ok
wmma_matmul       M=250 N=375 K=500  max|C - ref| = <error>  (tol 1.0e-02)  ok
wmma_matmul_smem  M=250 N=375 K=500  max|C - ref| = <error>  (tol 1.0e-02)  ok
1024^3  tiled fp32 <ms> ms = <x> TFLOP/s | wmma <ms> ms = <x> TFLOP/s (<n>x) | wmma smem <ms> ms = <x> TFLOP/s (<n>x)
1024^3  max|wmma smem - tiled fp32| = <error>  (tol 2.0e-02)  ok
PASS
\`\`\`

The errors are fp32 accumulation noise, far below the tolerance; the timings and speed-ups depend on the
GPU (expect the WMMA kernels to run several times faster than tiled fp32). The starter
compiles and runs but its kernels write nothing, so \`C\` comes back as zeros, every line says \`FAIL\`, and so
does the last one.

## Left out on purpose

\`cp.async\` and multi-stage pipelines, 128 × 128 block tiles and register double-buffering, swizzled shared
memory, \`ldmatrix\` and the PTX \`mma.sync\` instructions, Hopper's \`wgmma\` and TMA, bf16/tf32/fp8 inputs,
split-K, fused epilogues (bias, activation, residual) and transposed operands. These are what cuBLAS and
CUTLASS add on top of the warp-level contract written here.`,
  figures: [
    {
      title: 'Block tile, warp tiles, fragments',
      gpu: {
        items: [
          {
            id: 'gmem',
            label: 'Global memory',
            sub: 'HBM · every dimension padded to ×16',
            tone: 'global',
            layout: 'column',
            align: 'start',
            items: [
              {
                id: 'mat-a',
                array: 'A · 256 × 512 half',
                sub: 'a cell = 64 × 32',
                rows: 4,
                cols: 16,
                marks: [
                  {cols: [0, 15], rows: [1, 1], tone: 'global'},
                  {cols: [3, 3], rows: [1, 1], tone: 'shared', label: 'k0'},
                ],
                detail:
                  'Row-major `half`. Block row `by = 1` walks its 64 × K strip in steps of `BK = 32`. `pad16` and `cudaMemcpy2D` put a 250 × 500 input into a zeroed 256 × 512 buffer, so every pointer is 32-byte aligned; the zeros add nothing.',
              },
              {
                id: 'mat-b',
                array: 'B · 512 × 384 half',
                sub: 'a cell = 32 × 64',
                rows: 16,
                cols: 6,
                marks: [
                  {cols: [2, 2], rows: [0, 15], tone: 'global'},
                  {cols: [2, 2], rows: [3, 3], tone: 'shared', label: 'k0'},
                ],
                detail:
                  'Row-major `half`. Block column `bx = 2` needs the K × 64 strip of columns 128 … 191, the same `k0` rows as `A`.',
              },
              {
                id: 'mat-c',
                array: 'C · 256 × 384 float',
                sub: 'a cell = 64 × 64',
                rows: 4,
                cols: 6,
                marks: [{cols: [2, 2], rows: [1, 1], tone: 'register'}],
                detail:
                  'One block per 64 × 64 tile: a 6 × 4 grid. Each warp stores its four 16 × 16 accumulators with `ldm = N`; the host copies the real `M × N` corner back.',
              },
            ],
          },
          {
            id: 'block',
            label: 'Thread block (2, 1)',
            sub: 'wmma_matmul_smem · 128 threads',
            count: '24 blocks',
            layout: 'column',
            items: [
              {
                id: 'smem',
                label: 'Shared memory',
                sub: '__align__(32) half · 9.5 KB',
                tone: 'shared',
                layout: 'column',
                align: 'start',
                items: [
                  {
                    id: 'as',
                    array: 'As[64][40]',
                    sub: 'a cell = 16 × 8 halves',
                    tone: 'shared',
                    rows: 4,
                    cols: 5,
                    marks: [
                      {cols: [4, 4], tone: 'muted', label: 'skew'},
                      {cols: [0, 1], rows: [0, 1], tone: 'register', label: 'a'},
                    ],
                    detail:
                      'The 64 × 32 slab of `A`, filled by all 128 threads, zero past `M` and `K`. Rows are 40 halves (80 bytes): the 8-half skew keeps `ldm = 40` legal and shifts consecutive rows across the banks. Warp 0 reads `a[0]`, `a[1]` from `&As[i·16][kk]`.',
                  },
                  {
                    id: 'bs',
                    array: 'Bs[32][72]',
                    sub: 'a cell = 16 × 8 halves',
                    tone: 'shared',
                    rows: 2,
                    cols: 9,
                    marks: [
                      {cols: [8, 8], tone: 'muted'},
                      {cols: [0, 3], rows: [0, 0], tone: 'register', label: 'b'},
                    ],
                    detail:
                      'The 32 × 64 slab of `B`, rows of 72 halves (144 bytes). Warp 0 reads `b[0]`, `b[1]` from `&Bs[kk][j·16]` with `ldm = 72`.',
                  },
                ],
                detail:
                  'Filled once per `k0` step and read by all four warps: 8 KiB of operands feed 262,144 FLOPs, 32 per byte against 8 for the direct kernel. A `__syncthreads()` after the fill and one after the `mma_sync` loop.',
              },
              {
                id: 'warps',
                label: '2 × 2 warps',
                sub: '32 × 32 each · a cell = 16 × 16',
                layout: 'grid',
                columns: 2,
                items: [
                  {
                    id: 'w0',
                    label: 'Warp 0',
                    sub: 'rows 0–31 · cols 0–31',
                    align: 'start',
                    items: [
                      {
                        id: 'w0-a',
                        array: 'a[2]',
                        tone: 'register',
                        rows: 2,
                        cols: 1,
                        detail:
                          '`fragment<matrix_a, 16, 16, 16, half, row_major>`, two of them: rows 0–15 and 16–31 of the warp tile, reloaded for each `kk`.',
                      },
                      {
                        id: 'w0-b',
                        array: 'b[2]',
                        tone: 'register',
                        cols: 2,
                        detail:
                          '`fragment<matrix_b, 16, 16, 16, half, row_major>`, two of them: columns 0–15 and 16–31 of the warp tile.',
                      },
                      {
                        id: 'w0-acc',
                        array: 'acc[2][2]',
                        tone: 'register',
                        rows: 2,
                        cols: 2,
                        detail:
                          '`fragment<accumulator, 16, 16, 16, float>`, 2 × 2 of them, zeroed once with `fill_fragment` and kept in fp32 registers across all of K: `acc[i][j] += a[i] · b[j]`.',
                      },
                    ],
                    detail:
                      '`warpId = threadIdx.x / 32`, `warpRow = warpId / 2`, `warpCol = warpId % 2`: rows 0–31, columns 0–31 of the block tile. Each fragment is the warp’s share of a 16 × 16 tile spread over its 32 lanes’ registers; per 16 of `kk`, two `a`, two `b`, four `mma_sync`.',
                  },
                  {
                    label: 'Warp 1',
                    sub: 'rows 0–31 · cols 32–63',
                    align: 'start',
                    items: [
                      {array: 'a[2]', tone: 'register', rows: 2, cols: 1},
                      {array: 'b[2]', tone: 'register', cols: 2},
                      {array: 'acc[2][2]', tone: 'register', rows: 2, cols: 2},
                    ],
                  },
                  {
                    label: 'Warp 2',
                    sub: 'rows 32–63 · cols 0–31',
                    align: 'start',
                    items: [
                      {array: 'a[2]', tone: 'register', rows: 2, cols: 1},
                      {array: 'b[2]', tone: 'register', cols: 2},
                      {array: 'acc[2][2]', tone: 'register', rows: 2, cols: 2},
                    ],
                  },
                  {
                    label: 'Warp 3',
                    sub: 'rows 32–63 · cols 32–63',
                    align: 'start',
                    items: [
                      {array: 'a[2]', tone: 'register', rows: 2, cols: 1},
                      {array: 'b[2]', tone: 'register', cols: 2},
                      {array: 'acc[2][2]', tone: 'register', rows: 2, cols: 2},
                    ],
                  },
                ],
                detail:
                  'The 64 × 64 block tile split four ways. In the direct kernel `wmma_matmul` the block is instead 4 warps along a row of 16 × 16 tiles, each loading its fragments straight from global memory with `ldm = K` and `ldm = N`.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'mat-a', to: 'as', label: 'fill · 128 threads'},
          {from: 'mat-b', to: 'bs', label: 'fill · 128 threads'},
          {from: 'smem', to: 'warps', label: 'load_matrix_sync'},
          {from: 'w0', to: 'mat-c', label: 'store_matrix_sync'},
        ],
      },
    },
    {
      title: 'mma_sync on the tensor cores',
      gpu: {
        items: [
          {
            id: 'mma-warp',
            label: 'Warp 0',
            sub: 'mma_sync(acc[i][j], a[i], b[j], acc[i][j])',
            layout: 'column',
            items: [
              {threads: 32, label: 'all 32 lanes issue it together'},
              {
                id: 'tc',
                label: 'Tensor cores',
                sub: 'm16n16k16 · a cell = 2 × 2 elements',
                tone: 'compute',
                items: [
                  {
                    id: 'mma-d',
                    array: 'acc · D',
                    sub: 'float',
                    tone: 'register',
                    rows: 8,
                    cols: 8,
                    marks: [{cols: [5, 5], rows: [2, 2], tone: 'register'}],
                    detail:
                      'The result, back into the same fp32 accumulator fragment. Each element is a 16-long dot product of a row of `a` and a column of `b`, plus its old value.',
                  },
                  {gap: '='},
                  {
                    id: 'mma-a',
                    array: 'a',
                    sub: 'half',
                    tone: 'register',
                    rows: 8,
                    cols: 8,
                    marks: [{cols: [0, 7], rows: [2, 2], tone: 'register', label: 'row i'}],
                    detail:
                      'A 16 × 16 fp16 tile of `A` in registers. fp16 keeps 11 significant bits, so a product of two has at most 22: exact in fp32.',
                  },
                  {gap: '@'},
                  {
                    id: 'mma-b',
                    array: 'b',
                    sub: 'half',
                    tone: 'register',
                    rows: 8,
                    cols: 8,
                    marks: [{cols: [5, 5], rows: [0, 7], tone: 'register', label: 'col j'}],
                    detail: 'A 16 × 16 fp16 tile of `B`, `row_major` because `B` is row-major in memory.',
                  },
                  {gap: '+'},
                  {
                    id: 'mma-c',
                    array: 'acc · C',
                    sub: 'float',
                    tone: 'register',
                    rows: 8,
                    cols: 8,
                    marks: [{cols: [5, 5], rows: [2, 2], tone: 'register'}],
                    detail:
                      'The running sum from the previous steps of K, zeroed once by `fill_fragment(acc, 0.0f)`. Accumulating in fp32 leaves the order and rounding of the sum as the only error.',
                  },
                ],
                detail:
                  'One warp-collective `mma_sync`: 16 · 16 · 16 = 4,096 multiply-adds, against 32 for an fp32 FMA instruction across a warp. A lane-dependent `if` around it is undefined behaviour.',
              },
            ],
            detail:
              'The warp is the unit of work: every WMMA call is executed by all 32 lanes with the same arguments, and each fragment is spread over all 32 lanes’ registers.',
          },
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Mixed Precision Training',
      url: 'https://arxiv.org/abs/1710.03740',
      by: 'Paulius Micikevicius et al.',
      date: '2017-10-10',
      venue: 'ICLR 2018',
      takes:
        'The split the kernel relies on: `half` inputs multiplied, products accumulated in an fp32 `accumulator` fragment.',
    },
    {
      kind: 'code',
      title: 'CUTLASS',
      url: 'https://github.com/NVIDIA/cutlass',
      by: 'NVIDIA',
      date: '2017-11-30',
      venue: 'GitHub',
      takes:
        'The block tile, warp tile and `mma` hierarchy that `wmma_matmul_smem` sketches with a 64 × 64 block tile split into 2 × 2 warps of 32 × 32.',
    },
    {
      kind: 'post',
      title: 'Programming Tensor Cores in CUDA 9',
      url: 'https://developer.nvidia.com/blog/programming-tensor-cores-cuda-9/',
      by: 'Jeremy Appleyard and Scott Yokim',
      date: '2017-10-17',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The `nvcuda::wmma` pattern of `wmma_matmul`: one warp per 16 × 16 tile of `C`, `fill_fragment` to zero, `load_matrix_sync` with the leading dimension, `mma_sync` along K and `store_matrix_sync`.',
    },
    {
      kind: 'post',
      title: 'CUTLASS: Fast Linear Algebra in CUDA C++',
      url: 'https://developer.nvidia.com/blog/cutlass-linear-algebra-cuda/',
      by: 'Andrew Kerr et al.',
      date: '2017-12-05',
      venue: 'NVIDIA Technical Blog',
      takes:
        'Why the shared-memory version is faster: tiles of A and B staged once per block and reused by every warp, as the GEMM hierarchy from block to warp to tensor-core instruction.',
    },
    {
      kind: 'docs',
      title: 'Warp Matrix Functions',
      url: 'https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/cpp-language-extensions.html#warp-matrix-functions',
      venue: 'CUDA Programming Guide',
      takes:
        'The fragment types `matrix_a`, `matrix_b` and `accumulator`, the `m16n16k16` shape for `half`, `ldm` a multiple of 8 and the 256-bit alignment that `__align__(32)` gives the shared tiles.',
    },
  ],
  steps: [wmmaMatmulStep],
  learn,
};
