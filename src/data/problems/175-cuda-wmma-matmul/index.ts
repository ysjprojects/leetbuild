import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {wmmaMatmulStep} from './steps/1-wmma-matmul';

/**
 * Drill: a matmul on tensor cores through `nvcuda::wmma` — fp16 inputs, fp32 accumulation, one warp
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
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# Matmul on tensor cores with WMMA

Almost every FLOP a transformer spends is a matrix multiply — the Q/K/V and output projections, the two MLP
matrices, the logits — and since Volta those FLOPs run on **tensor cores**: units that multiply small fp16
(later bf16, tf32, fp8) tiles and accumulate in fp32, an order of magnitude faster than the ordinary fp32
pipeline. \`torch.matmul\` reaches them through cuBLAS; the lowest level of CUDA C++ that reaches them
directly is \`nvcuda::wmma\` (\`#include <mma.h>\`), the *warp matrix* API: a warp loads a 16 × 16 tile of A and
of B into **fragments**, issues \`mma_sync\`, and stores a 16 × 16 tile of C. This drill writes that kernel,
then stages it through shared memory, and measures both against a plain tiled fp32 kernel.

The surface is one file, \`wmma_matmul.cu\`, compiled with \`nvcc -arch=sm_80\` (\`sm_70\` or later). \`A\` is
\`M × K\`, \`B\` is \`K × N\`, both \`half\` and row-major; \`C\` is \`M × N\` \`float\`:

- \`__global__ void wmma_matmul(const half* A, const half* B, float* C, int M, int N, int K)\` — one warp per
  16 × 16 tile of \`C\`, 4 warps per 128-thread block along a row of tiles, fragments loaded straight from
  global memory with \`ldm = K\` for \`A\` and \`ldm = N\` for \`B\`, \`K / 16\` calls of \`mma_sync(acc, a, b, acc)\`,
  one \`store_matrix_sync(…, N, wmma::mem_row_major)\`.
- \`__global__ void wmma_matmul_smem(…same signature…)\` — a 64 × 64 block tile: the 128 threads fill
  \`__shared__ __align__(32) half As[64][40]\` and \`Bs[32][72]\` in steps of 32 along K, each of the 2 × 2 warps
  multiplies its 32 × 32 quarter as 2 × 2 accumulators, two \`__syncthreads()\` per step.
- \`pad16\`, \`upload_padded\`, \`download\` — every dimension rounded up to a multiple of 16, the inputs copied into
  zeroed padded buffers with \`cudaMemcpy2D\` and the \`M × N\` corner of \`C\` copied back.
- \`main\` — fp16 inputs from a fixed-seed generator, an fp32 CPU reference over the same rounded values, the
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

The errors are fp32 accumulation-order noise, far below the tolerance; the timings and speed-ups depend on the
GPU (the WMMA kernels should be several times faster than tiled fp32 on any tensor-core part). The starter
compiles and runs but its kernels write nothing, so \`C\` comes back as zeros, every line says \`FAIL\`, and so
does the last one.

## Left out on purpose

\`cp.async\` and multi-stage pipelines, 128 × 128 block tiles and register double-buffering, swizzled shared
memory, \`ldmatrix\` and the PTX \`mma.sync\` instructions, Hopper's \`wgmma\` and TMA, bf16/tf32/fp8 inputs,
split-K, fused epilogues (bias, activation, residual) and transposed operands. These are what cuBLAS and
CUTLASS add on top of the warp-level contract written here.`,
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · main()',
        sub: 'fp16 inputs · pad16 · CPU reference · TFLOP/s · PASS',
        x: 8,
        y: 50,
      },
      {
        id: 'gmem',
        kind: 'db',
        label: 'Global memory',
        sub: 'A Mp×Kp · B Kp×Np (half) · C Mp×Np (float)',
        x: 34,
        y: 50,
      },
      {
        id: 'smem',
        kind: 'db',
        label: 'Shared memory',
        sub: 'As[64][32+8] · Bs[32][64+8], 32-byte aligned',
        x: 60,
        y: 22,
      },
      {
        id: 'kernel',
        kind: 'service',
        label: 'wmma_matmul / _smem',
        sub: 'one warp per 16×16 tile · fragments a, b, acc',
        x: 60,
        y: 78,
      },
      {
        id: 'tc',
        kind: 'service',
        label: 'Tensor cores',
        sub: 'mma_sync: 16×16×16, fp16 in, fp32 acc',
        x: 90,
        y: 50,
      },
    ],
    edges: [
      {from: 'host', to: 'gmem', kind: 'plain', label: 'cudaMemcpy2D into zeroed, padded buffers'},
      {from: 'gmem', to: 'smem', kind: 'plain', label: 'cooperative fill, zero past M/N/K'},
      {from: 'gmem', to: 'kernel', kind: 'plain', label: 'load_matrix_sync (ldm K, N) · store (ldm N)'},
      {from: 'smem', to: 'kernel', kind: 'plain', label: 'load_matrix_sync (ldm 40, 72)'},
      {from: 'kernel', to: 'tc', kind: 'plain', label: 'mma_sync(acc, a, b, acc)'},
    ],
  },
  steps: [wmmaMatmulStep],
  learn,
};
