import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {tiledMatmulStep} from './steps/1-tiled-matmul';

/**
 * Drill: the shared-memory tiled GEMM — one block per 32 × 32 output tile, the K dimension walked
 * in 32-wide slabs staged in shared memory, two barriers per slab, one coalesced load per thread
 * per slab and one store per output. The kernel every dense layer, attention projection and LM
 * head reduces to, and the one cuBLAS and CUTLASS start from.
 */
export const cudaTiledMatmulProblem: Problem = {
  id: 'cuda-tiled-matmul',
  title: 'Tiled matrix multiply with shared memory',
  tagline:
    'C = A · B with 32 × 32 tiles staged in shared memory: coalesced loads, zero padding at the edges, two __syncthreads() per tile, 32× less global traffic than the naive kernel.',
  difficulty: 'medium',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 45,
  statement: `# Tiled matrix multiply with shared memory

Almost every FLOP a transformer spends is a matrix multiply: the Q, K, V and output projections, the
two MLP matrices, the LM head, and \`Q · Kᵀ\` and \`P · V\` inside attention. A 7B-parameter model is
roughly 7 billion multiply-adds of GEMM per token. PyTorch hands them to cuBLAS, which runs a descendant
of the kernel you write here: the output is cut into tiles, one thread block per tile, and the block
walks the shared dimension \`K\` in slabs that it stages in **shared memory** so that every float fetched
from DRAM is reused \`TILE\` times instead of once.

The naive kernel gives one thread one output element and has it read \`2K\` floats straight from global
memory. Those reads are the problem: a GEMM has \`2MNK\` FLOPs but only \`(MK + KN + MN)\` floats, so done
right it is compute-bound; done naively it is a memory benchmark. The tiled kernel keeps the same one
thread per output but makes the block cooperate: each thread loads **one** element of \`A\` and one of \`B\`
per slab into \`As[32][32]\` and \`Bs[32][32]\`, a \`__syncthreads()\` makes the slab visible to all 1024
threads, each thread multiplies its row of \`As\` by its column of \`Bs\` out of shared memory, and a
second \`__syncthreads()\` protects the slab until everyone has finished with it.

The surface is one kernel plus the host that proves it:

- \`__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K)\` —
  row-major float32, \`A[M×K]\`, \`B[K×N]\`, \`C[M×N]\`, \`constexpr int TILE = 32\`, launched with
  \`dim3 block(TILE, TILE)\` and \`dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE)\`.
- \`matmul_naive\` with the same signature, kept as the baseline.
- A \`main()\` that checks both kernels against a CPU reference on \`97 × 75 × 131\` (no dimension a
  multiple of 32, so the edge padding is exercised), then times both on \`1024³\` with \`cudaEvent\`s and
  prints GFLOP/s.

## What you build here

1. \`matmul_tiled\`: the two shared tiles, the slab loop over \`K\` with bounds-checked, zero-padded,
   coalesced loads, the two barriers, a register accumulator and one guarded store per output — and
   the \`dim3\` geometry that launches it.

## Run it on your machine

\`\`\`bash
nvcc -O2 -o tiled_matmul tiled_matmul.cu && ./tiled_matmul
\`\`\`

A passing run prints the max absolute error of each kernel against the CPU reference on the small
case, the GFLOP/s of both kernels on \`1024³\` and the tiled-vs-naive discrepancy, then \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
correctness 97x75x131: tiled max|err| 3.8e-06  naive max|err| 3.8e-06  (tol 1e-03)
bench 1024x1024x1024: naive 1830.2 GFLOP/s  tiled 5912.7 GFLOP/s (3.2x)  max|tiled - naive| 0.0e+00
PASS
\`\`\`

The GFLOP/s depend on the GPU; the ratio should be comfortably above 1. With the starter the tiled
kernel writes nothing, the error on the small case is the size of the reference, and the last line is
\`FAIL\`.

## Left out on purpose

Register tiling (each thread computing a 4 × 4 or 8 × 8 micro-tile), larger block tiles with warp
tiling, double-buffered loads (\`cp.async\`, TMA), tensor cores (\`mma.sync\`, \`wmma\`), swizzled
shared-memory layouts, split-K, transposed and batched layouts, half precision — everything that takes
this kernel from a few times the naive one to cuBLAS. Each of those sits on top of exactly the tile
loop and the two barriers you write here.`,
  architecture: {
    input: 'A[M×K] · B[K×N] float32',
    output: 'C = A · B',
    items: [
      {
        id: 'host',
        label: 'Host · main()',
        kind: 'host',
        sub: 'cudaMemcpy H2D · launch',
        detail:
          'Fills `A` and `B`, copies them to the device, launches `matmul_tiled<<<grid, block>>>` with `block(32, 32)` and `grid(⌈N/32⌉, ⌈M/32⌉)`, then checks against a CPU reference and times both kernels on `1024³`.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory',
        kind: 'memory',
        sub: 'A[M×K] · B[K×N] float32',
        shape: 'A[97×131] · B[131×75]',
        detail:
          'Off-chip DRAM (HBM): large and slow. The naive kernel reads `2K` floats from here per output; the tiled one reads `2K / 32`.',
      },
      {
        tone: 'block',
        repeat: '⌈N/32⌉ · ⌈M/32⌉ ×',
        label: 'Thread block · 32 × 32',
        items: [
          {
            id: 'index',
            label: 'Thread → output element',
            kind: 'kernel',
            sub: 'row = by·32 + ty, col = bx·32 + tx',
            detail:
              '`row = blockIdx.y * TILE + threadIdx.y`, `col = blockIdx.x * TILE + threadIdx.x`: `x` runs along columns, so a warp (fixed `ty`) covers 32 consecutive columns and every global access is coalesced.',
          },
          {
            tone: 'dotted',
            repeat: '⌈K/32⌉ ×',
            label: 'slab t of K',
            items: [
              {
                columns: [
                  [
                    {
                      id: 'as',
                      label: 'Shared tile As',
                      kind: 'memory',
                      sub: 'As[ty][tx] = A[row][32t + tx]',
                      detail:
                        '`__shared__ float As[32][32]`. Each thread loads one float, `0.0f` past the edge. A warp (fixed `ty`) reads 32 consecutive floats of one row of `A`: one coalesced transaction.',
                    },
                  ],
                  [
                    {
                      id: 'bs',
                      label: 'Shared tile Bs',
                      kind: 'memory',
                      sub: 'Bs[ty][tx] = B[32t + ty][col]',
                      detail:
                        '`__shared__ float Bs[32][32]`. Each thread loads one float, `0.0f` past the edge. A warp reads 32 consecutive floats of one row of `B`: coalesced.',
                    },
                  ],
                ],
              },
              {
                id: 'sync1',
                label: '__syncthreads()',
                kind: 'kernel',
                sub: 'slab written: read after write',
                detail: 'No thread multiplies until all 1,024 threads have written their slot of `As` and `Bs`.',
              },
              {
                id: 'fma',
                label: 'FMA loop in registers',
                kind: 'kernel',
                sub: 'acc += As[ty][k] · Bs[k][tx]',
                side: {label: 'acc', sub: 'float register'},
                detail:
                  '`for k = 0…31`: 32 multiply-adds out of shared memory into a register accumulator. `As[ty][k]` is a broadcast per warp, `Bs[k][tx]` spans 32 banks: no bank conflicts.',
              },
              {
                id: 'sync2',
                label: '__syncthreads()',
                kind: 'kernel',
                sub: 'all done: write after read',
                detail:
                  'No thread overwrites `As`/`Bs` with slab `t + 1` while a slower warp is still reading slab `t`. Dropping it gives results that are wrong only sometimes.',
              },
            ],
          },
          {
            id: 'store',
            label: 'Store C once',
            kind: 'kernel',
            sub: 'if (row < M && col < N) C = acc',
            detail:
              'One guarded, coalesced store per output after the slab loop. No early `return`: every thread reaches every barrier.',
          },
        ],
      },
      {
        id: 'gmem-out',
        label: 'Global memory',
        kind: 'memory',
        sub: 'C[M×N] float32',
        shape: 'C[97×75]',
        detail: 'Copied back to the host and compared with the CPU reference: max abs error `< 1e-3`.',
      },
    ],
    notes: [
      {at: 'gmem-in', text: 'Global reads per output: **2K** naive, **2K / 32** tiled'},
      {at: 'as', text: 'Two **32 × 32** float tiles: **8 KB** per block', side: 'left'},
      {at: 'fma', text: 'Each staged float is reused **32** times'},
      {at: 'sync2', text: 'The second barrier stops a write-after-read race'},
      {at: 'store', text: '**97 × 75 × 131**: **12** blocks, **5** slabs', side: 'left'},
    ],
  },
  steps: [tiledMatmulStep],
  learn,
};
