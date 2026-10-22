import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {reduceSumStep} from './steps/1-reduce-sum';

/**
 * Deep-learning drill, in CUDA: the parallel sum every normalisation, softmax, loss and gradient
 * norm rests on — a grid-stride partial per thread, a warp reduced with shuffles, one shared slot
 * per warp, one atomic per block — checked against a Kahan reference and timed against the bus.
 */
export const cudaReductionProblem: Problem = {
  id: 'cuda-reduction',
  title: 'Parallel reduction: shared memory, warp shuffles, two stages',
  tagline:
    'Sum 16 M floats at memory bandwidth: a grid-stride partial per thread, __shfl_down_sync across the warp, one shared slot per warp, one atomicAdd per block — checked against a Kahan sum.',
  difficulty: 'medium',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 45,
  statement: `# Parallel reduction: shared memory, warp shuffles, two stages

A **reduction** folds \`n\` values into one with an associative operator: a sum, a max, a dot product.
It is the inner loop of almost every non-matmul kernel in a transformer: the mean and variance of
LayerNorm, the sum of squares of RMSNorm, the row max and the row sum of softmax, the cross-entropy loss
over a batch, the global norm that gradient clipping divides by, the per-tensor \`absmax\` that FP8 and
INT8 quantisation scale with. Each of those is \`torch.sum\` or \`torch.max\` over a dimension, and each is
limited by the same thing: the data has to be read once from HBM, and nothing else may cost as much.

On a GPU, "fold n values" is a question of *where* each partial lives. A thread holds a register; 32
threads of a warp can pass registers to each other with a shuffle; the threads of a block share a few
kilobytes of on-chip memory and can wait for each other at a barrier; blocks share only global memory
and atomics. A good reduction uses each level once, in that order, and moves as little as possible to
the next.

The surface is one kernel and one helper, in \`reduce_sum.cu\`:

- \`__device__ float warp_reduce_sum(float v)\` — \`__shfl_down_sync(0xffffffff, v, offset)\` for
  \`offset = 16, 8, 4, 2, 1\`; lane 0 ends with the sum of the 32 lanes.
- \`__global__ void reduce_sum(const float* in, float* out, int n)\` — \`*out\` is 0 on entry and the sum
  of \`in[0..n)\` on exit; \`blockDim.x\` is a multiple of 32, at most 1024; any grid size works.

## What you build here

1. \`reduce_sum\`: every thread accumulates a **grid-stride** slice of \`in\` into a register; the warp is
   reduced with **shuffles**; lane 0 of each warp writes a **shared** slot and the block hits
   \`__syncthreads()\`; warp 0 reduces the slots and lane 0 adds the block's total to \`*out\` with **one
   \`atomicAdd\`**. The host runs 512 × 256 and 64 × 128 threads, compares each against a Kahan-summed
   double reference at a relative tolerance of \`1e-5\`, and reports ms per launch and GB/s.

## Run it on your machine

\`\`\`bash
nvcc -O2 -o reduce_sum reduce_sum.cu && ./reduce_sum
\`\`\`

A passing run prints one line per configuration and then \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
 512 blocks x  256 threads: sum 8387366.500 (ref 8387366.363, rel err 1.63e-08)  0.0912 ms/launch  735.9 GB/s  ok
  64 blocks x  128 threads: sum 8387366.000 (ref 8387366.363, rel err 4.33e-08)  0.6210 ms/launch  108.1 GB/s  ok
PASS
\`\`\`

The numbers after \`sum\` and the timings depend on the GPU; the rel err stays below \`1e-5\`; the starter's
empty kernel leaves \`*out\` at 0 and prints \`MISMATCH\` twice and \`FAIL\`.

## Left out on purpose

Vectorised \`float4\` loads and several accumulators per thread, the deterministic two-stage variant
(\`out[blockIdx.x] = v\`, then a second launch over the partials), \`cub::DeviceReduce\` and
\`cooperative_groups::reduce\`, reductions over one dimension of a 2-D tensor (one block per row, the shape
LayerNorm and softmax use), half-precision inputs with float accumulators, and the segmented and
multi-GPU (all-reduce) forms.`,
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host',
        sub: 'fills 2^24 floats · 2 launch configs · Kahan reference',
        x: 8,
        y: 50,
      },
      {id: 'gmem', kind: 'db', label: 'Global memory', sub: 'in[n] (64 MiB) · out (one float, zeroed)', x: 36, y: 22},
      {
        id: 'kernel',
        kind: 'service',
        label: 'reduce_sum<<<blocks, threads>>>',
        sub: 'grid-stride · shuffles · warp 0 · atomicAdd',
        x: 62,
        y: 50,
      },
      {id: 'smem', kind: 'db', label: 'Shared memory', sub: 'warp_sums[32] · __syncthreads()', x: 88, y: 50},
      {id: 'cpu', kind: 'external', label: 'CPU reference', sub: 'Kahan sum in double · rel tol 1e-5', x: 36, y: 78},
    ],
    edges: [
      {from: 'host', to: 'gmem', kind: 'plain', label: 'cudaMemcpy H2D · cudaMemset(out, 0)'},
      {from: 'host', to: 'kernel', kind: 'plain', label: 'launch · cudaEvent timing'},
      {from: 'kernel', to: 'gmem', kind: 'plain', label: 'coalesced in[i] · atomicAdd(out)'},
      {from: 'kernel', to: 'smem', kind: 'plain', label: 'one slot per warp'},
      {from: 'host', to: 'cpu', kind: 'plain', label: 'compare D2H result'},
    ],
  },
  steps: [reduceSumStep],
  learn,
};
