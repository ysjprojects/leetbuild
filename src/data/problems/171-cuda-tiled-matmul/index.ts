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
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'host',
        sub: 'main() · fill A, B · cudaEvent timing · CPU reference',
        x: 8,
        y: 50,
      },
      {id: 'gmem', kind: 'db', label: 'global memory', sub: 'A[M×K] · B[K×N] · C[M×N]', x: 40, y: 20},
      {id: 'tiled', kind: 'service', label: 'matmul_tiled', sub: 'grid ⌈N/32⌉ × ⌈M/32⌉ · block 32 × 32', x: 40, y: 60},
      {id: 'smem', kind: 'db', label: 'shared memory', sub: 'As[32][32] · Bs[32][32] · 8 KB per block', x: 72, y: 60},
      {
        id: 'naive',
        kind: 'external',
        label: 'matmul_naive',
        sub: 'baseline · 2K global loads per output',
        x: 72,
        y: 20,
      },
    ],
    edges: [
      {from: 'host', to: 'gmem', kind: 'plain', label: 'cudaMemcpy H2D · D2H'},
      {from: 'host', to: 'tiled', kind: 'plain', label: '<<<grid, block>>>'},
      {from: 'tiled', to: 'gmem', kind: 'plain', label: '1 coalesced load of A and B per thread per slab · 1 store'},
      {from: 'tiled', to: 'smem', kind: 'plain', label: 'load slab · __syncthreads · 32 FMAs · __syncthreads'},
      {from: 'host', to: 'naive', kind: 'plain', label: 'same grid · timed for comparison'},
      {from: 'naive', to: 'gmem', kind: 'plain', label: 'A and B re-read per output'},
    ],
  },
  steps: [tiledMatmulStep],
  learn,
};
