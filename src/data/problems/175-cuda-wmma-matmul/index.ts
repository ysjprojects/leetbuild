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
  architecture: {
    input: 'A[M×K] · B[K×N] fp16',
    output: 'C[M×N] fp32',
    items: [
      {
        id: 'host',
        label: 'Host · pad16 + upload',
        kind: 'host',
        sub: 'cudaMemcpy2D into zeroed buffers',
        detail:
          '`pad16(x) = (x + 15) / 16 * 16` rounds M, N, K up; the real rows are copied into zeroed `Mp × Kp` and `Kp × Np` buffers, so 250 × 375 × 500 runs as 256 × 384 × 512. The zeros add nothing to the products.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory',
        kind: 'memory',
        sub: 'A[Mp×Kp] · B[Kp×Np] half',
        shape: 'A[256×512] · B[512×384]',
        detail:
          'Row-major `half`, every dimension a multiple of 16, so every fragment pointer is 32-byte aligned and every `ldm` a multiple of 8 halves.',
      },
      {
        tone: 'block',
        repeat: '⌈Np/64⌉ · Mp/16 ×',
        label: 'Thread block · 128 threads',
        items: [
          {
            tone: 'dotted',
            label: 'each of 4 warps',
            items: [
              {
                id: 'acc0',
                label: 'Zero the accumulator',
                kind: 'kernel',
                sub: 'fill_fragment(acc, 0.0f)',
                detail:
                  '`warpId = threadIdx.x / warpSize`, `tileRow = blockIdx.y`, `tileCol = blockIdx.x * 4 + warpId`. A warp whose tile is past `N` returns as a whole.',
              },
              {
                tone: 'dotted',
                repeat: 'K/16 ×',
                label: 'k += 16',
                items: [
                  {
                    columns: [
                      [
                        {
                          id: 'frag-a',
                          label: 'load_matrix_sync a',
                          kind: 'kernel',
                          sub: 'A + tileRow·16·K + k · ldm K',
                          detail:
                            '`fragment<matrix_a, 16, 16, 16, half, row_major>`: the warp’s share of a 16 × 16 fp16 tile of `A`, spread over the 32 lanes’ registers in an opaque layout.',
                        },
                      ],
                      [
                        {
                          id: 'frag-b',
                          label: 'load_matrix_sync b',
                          kind: 'kernel',
                          sub: 'B + k·N + tileCol·16 · ldm N',
                          detail:
                            '`fragment<matrix_b, 16, 16, 16, half, row_major>`: a 16 × 16 fp16 tile of `B`. `ldm` is the row length of the matrix it sits in, not the tile width.',
                        },
                      ],
                    ],
                  },
                  {
                    id: 'mma',
                    label: 'mma_sync(acc, a, b, acc)',
                    kind: 'kernel',
                    sub: 'tensor cores · m16n16k16',
                    detail:
                      'Warp-collective: all 32 lanes issue it together. `acc = a · b + acc`, 16 · 16 · 16 = 4,096 multiply-adds per instruction; fp16 products are exact in fp32.',
                  },
                  {
                    id: 'acc',
                    label: 'Accumulator fragment',
                    kind: 'memory',
                    sub: '16 × 16 float · registers',
                    detail:
                      '`fragment<accumulator, 16, 16, 16, float>`: the sum stays in fp32 registers across all K/16 steps, so the only error left is summation order.',
                  },
                ],
              },
              {
                id: 'store',
                label: 'store_matrix_sync',
                kind: 'kernel',
                sub: 'C + tileRow·16·N + tileCol·16',
                detail:
                  'Once per tile: `store_matrix_sync(…, acc, N, wmma::mem_row_major)`. The accumulator has no layout; the store names one.',
              },
            ],
          },
        ],
      },
      {
        id: 'gmem-out',
        label: 'Global memory',
        kind: 'memory',
        sub: 'C[Mp×Np] float · M × N corner back',
        shape: 'C[250×375]',
        detail:
          '`cudaMemcpy2D` copies the real `M × N` corner back; the host checks `max |C − ref| ≤ 2e-5 × K` against an fp32 CPU reference over the same rounded inputs.',
      },
    ],
    notes: [
      {at: 'store', text: 'One warp owns one **16 × 16** tile of C', side: 'left'},
      {at: 'mma', text: '**16 × 16 × 16**: **4,096** multiply-adds', side: 'left'},
      {at: 'frag-a', text: 'fp16 tiles in, **fp32** accumulator', side: 'left'},
      {at: 'gmem-in', text: 'Pointers **32-byte** aligned, ldm a multiple of **8**', side: 'left'},
    ],
    insets: [
      {
        for: 'frag-b',
        title: 'wmma_matmul_smem: staged loads',
        items: [
          {
            tone: 'dotted',
            repeat: 'K/32 ×',
            items: [
              {id: 's-fill', label: 'Cooperative fill', kind: 'kernel', sub: '128 threads · zero past M, N, K'},
              {id: 's-smem', label: 'Shared memory', kind: 'memory', sub: 'As[64][40] · Bs[32][72] half'},
              {id: 's-sync1', label: '__syncthreads()', kind: 'kernel'},
              {id: 's-load', label: 'load_matrix_sync', kind: 'kernel', sub: '2 a (ldm 40) · 2 b (ldm 72)'},
              {id: 's-mma', label: '4 × mma_sync', kind: 'kernel', sub: '2 × 2 accumulators per warp'},
              {id: 's-sync2', label: '__syncthreads()', kind: 'kernel'},
            ],
          },
        ],
        note: '64 × 64 block tile, **32 × 32** per warp: **32** FLOP per byte',
      },
    ],
  },
  steps: [wmmaMatmulStep],
  learn,
};
