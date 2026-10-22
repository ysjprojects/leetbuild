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
  track: 'dllm',
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
  figures: [
    {
      title: "One block's tile of C",
      gpu: {
        items: [
          {
            id: 'gmem',
            label: 'Global memory',
            sub: 'HBM · a cell = a 32 × 32 tile',
            tone: 'global',
            layout: 'column',
            align: 'start',
            items: [
              {
                id: 'mat-a',
                array: 'A · 97 × 131',
                sub: '5 slabs of K',
                rows: 4,
                cols: 5,
                marks: [
                  {cols: [0, 4], rows: [1, 1], tone: 'global'},
                  {cols: [2, 2], rows: [1, 1], tone: 'shared', label: 't'},
                ],
                detail:
                  'Block row `by = 1` needs the 32 × K strip of rows 32 … 63 and takes it one 32 × 32 tile per slab `t`. `K = 131` is 5 slabs; the last holds 3 real columns and 29 zeros, loaded as `0.0f` past the edge.',
              },
              {
                id: 'mat-b',
                array: 'B · 131 × 75',
                sub: 'the same slab t',
                rows: 5,
                cols: 3,
                marks: [
                  {cols: [1, 1], rows: [0, 4], tone: 'global'},
                  {cols: [1, 1], rows: [2, 2], tone: 'shared', label: 't'},
                ],
                detail:
                  'Block column `bx = 1` needs the K × 32 strip of columns 32 … 63, the same slab `t` of rows as `A`. A warp (fixed `ty`) reads 32 consecutive floats of one row of it: coalesced.',
              },
              {
                id: 'mat-c',
                array: 'C · 97 × 75',
                sub: '4 × 3 tiles: 12 blocks',
                rows: 4,
                cols: 3,
                marks: [{cols: [1, 1], rows: [1, 1], tone: 'register'}],
                detail:
                  'One block per 32 × 32 tile: `grid((75 + 31) / 32, (97 + 31) / 32)` = 3 × 4. Edge tiles hang over the matrix; their outside threads compute zeros and skip the store.',
              },
            ],
          },
          {
            id: 'block',
            label: 'Thread block (1, 1)',
            sub: 'dim3 block(32, 32) · 1,024 threads',
            count: '12 blocks',
            layout: 'column',
            items: [
              {
                id: 'smem',
                label: 'Shared memory',
                sub: '2 × 4 KB · one slab at a time',
                tone: 'shared',
                layout: 'column',
                items: [
                  {
                    id: 'as',
                    array: 'As[32][32]',
                    sub: 'a cell = 8 × 8 floats',
                    tone: 'shared',
                    rows: 4,
                    cols: 4,
                    marks: [{cols: [0, 3], rows: [1, 1], tone: 'register', label: 'row ty'}],
                    detail:
                      '`As[ty][tx] = A[row][t·32 + tx]`, or `0.0f` past the edge: each thread writes one slot. Thread `(ty, tx)` then reads row `ty`, the same 32 floats as the other 31 lanes of its warp: one broadcast per `k`.',
                  },
                  {
                    id: 'bs',
                    array: 'Bs[32][32]',
                    sub: 'a cell = 8 × 8 floats',
                    tone: 'shared',
                    rows: 4,
                    cols: 4,
                    marks: [{cols: [2, 2], rows: [0, 3], tone: 'register', label: 'col tx'}],
                    detail:
                      '`Bs[ty][tx] = B[t·32 + ty][col]`, or `0.0f` past the edge. Thread `(ty, tx)` reads column `tx`; across a warp `Bs[k][0 … 31]` hits 32 consecutive banks: no conflict.',
                  },
                ],
                detail:
                  'On-chip, per block. Every float staged here is read by 32 threads, so global traffic per output drops from `2K` to `2K / 32` floats.',
              },
              {
                id: 'warp',
                label: 'Warp ty',
                count: '32 warps',
                layout: 'column',
                items: [
                  {
                    id: 'acc',
                    label: 'Registers',
                    sub: 'float acc: one per thread',
                    tone: 'register',
                    stretch: true,
                    detail:
                      'Each thread keeps its running sum in a register for the whole slab loop: `acc += As[ty][k] * Bs[k][tx]`, 32 FMAs per slab, nothing written to memory until the end.',
                  },
                  {threads: 16, continues: true, label: 'lanes tx = 0 … 31 · one output each'},
                ],
                detail:
                  '`row = blockIdx.y * 32 + ty`, `col = blockIdx.x * 32 + tx`. A warp is one value of `ty` and `tx = 0 … 31`: 32 adjacent columns of one row, so its loads and its store are coalesced.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'mat-a', to: 'as', label: 'one float per thread'},
          {from: 'mat-b', to: 'bs', label: 'one float per thread'},
          {from: 'smem', to: 'warp', label: '32 FMAs per slab'},
          {from: 'acc', to: 'mat-c', label: 'one store'},
        ],
      },
    },
    {
      title: 'One slab, two barriers',
      gpu: {
        items: [
          {
            id: 'slab-loop',
            label: 'for (t = 0; t < 5; ++t)',
            sub: 'K = 131 in slabs of 32',
            count: '5 slabs',
            items: [
              {
                id: 'load',
                label: 'Load slab t',
                sub: 'As[ty][tx], Bs[ty][tx]',
                layout: 'column',
                items: [
                  {threads: 12, continues: true, label: '1,024 threads · 2 loads each'},
                  {label: 'As, Bs', sub: 'being written', tone: 'shared', stretch: true},
                ],
                detail:
                  'Every thread writes one slot of each tile, zero past the edge. No thread returns early: an out-of-range one loads zeros and stays for both barriers.',
              },
              {
                id: 'sync1',
                label: '__syncthreads()',
                sub: 'read after write',
                detail:
                  'No thread multiplies until all 1,024 have written their slots of `As` and `Bs`. Without it a thread reads a neighbour’s slot from the previous slab.',
              },
              {
                id: 'fma',
                label: 'Multiply',
                sub: 'k = 0 … 31',
                layout: 'column',
                items: [
                  {label: 'As, Bs', sub: 'read only', tone: 'shared', stretch: true},
                  {
                    label: 'Warps, out of step',
                    layout: 'row',
                    items: [
                      {
                        label: 'Warp 0',
                        layout: 'column',
                        items: [{threads: 6, continues: true, label: 'k = 31: done'}],
                      },
                      {gap: '…'},
                      {
                        id: 'slow-warp',
                        label: 'Warp 31',
                        layout: 'column',
                        items: [{threads: 6, continues: true, label: 'k = 0: reading'}],
                        detail:
                          'The 32 warps of a block are scheduled independently: when warp 0 finishes its 32 FMAs, warp 31 may still be at `k = 0`.',
                      },
                    ],
                  },
                  {label: 'acc', sub: '+= As[ty][k] · Bs[k][tx]', tone: 'register', stretch: true},
                ],
                detail:
                  '32 multiply-adds per thread out of shared memory into a register. `As[ty][k]` is one address per warp (a broadcast), `Bs[k][tx]` spans 32 banks.',
              },
              {
                id: 'sync2',
                label: '__syncthreads()',
                sub: 'write after read',
                detail:
                  'No thread loads slab `t + 1` over `As` and `Bs` while a slower warp is still reading slab `t`. Dropping it gives results that are wrong only sometimes.',
              },
            ],
          },
          {
            id: 'store',
            label: 'After the loop',
            sub: 'if (row < M && col < N)',
            layout: 'column',
            items: [
              {label: 'acc', sub: 'the finished dot product', tone: 'register', stretch: true},
              {label: 'C[row][col]', sub: 'one store per output', tone: 'global', stretch: true},
            ],
            detail:
              'One guarded, coalesced store per output. Threads outside `M × N` took part in every barrier and only now drop out.',
          },
        ],
      },
    },
  ],
  steps: [tiledMatmulStep],
  learn,
};
