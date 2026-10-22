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
  architecture: {
    input: 'in[n] · n = 2²⁴ floats in [0, 1)',
    output: 'sum, checked against Kahan',
    items: [
      {
        id: 'host',
        label: 'Host · main()',
        kind: 'host',
        sub: 'cudaMemset(out, 0) · launch',
        detail:
          'Copies `N = 1 << 24` floats to the device, zeroes `*out` before **every** launch (atomics accumulate), launches 512 × 256 and 64 × 128 threads and times 20 launches with `cudaEvent`s.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory',
        sub: 'in[n] · 64 MiB',
        kind: 'memory',
        shape: 'float[2²⁴]',
        detail:
          'The input, read exactly once. On every grid-stride iteration the 32 lanes of a warp read 32 consecutive floats: one 128-byte transaction.',
      },
      {
        tone: 'block',
        repeat: '512 ×',
        label: 'Thread block · 256 threads',
        items: [
          {
            id: 'stride',
            label: 'Grid-stride loop',
            sub: 'v += in[i]; i += gridDim·blockDim',
            kind: 'kernel',
            shape: 'v: one float per thread',
            detail:
              'Thread `blockIdx.x * blockDim.x + threadIdx.x` folds every `gridDim.x * blockDim.x`-th element into one register: 128 elements per thread at 512 × 256, 2,048 at 64 × 128. Threads past `n` do zero iterations and hold 0.',
          },
          {
            tone: 'dotted',
            label: 'each of 8 warps',
            items: [
              {
                id: 'shfl',
                label: 'Warp shuffle tree',
                sub: '__shfl_down_sync 16, 8, 4, 2, 1',
                kind: 'kernel',
                shape: 'lane 0: warp sum',
                detail:
                  '`warp_reduce_sum`: `v += __shfl_down_sync(0xffffffff, v, offset)` five times. Registers move lane to lane; no shared memory, no barrier. The full mask, never `__activemask()`.',
              },
            ],
          },
          {
            id: 'smem',
            label: 'Shared memory',
            sub: 'warp_sums[32] · __syncthreads()',
            kind: 'memory',
            shape: 'blockDim.x / 32 floats',
            detail:
              'Lane 0 of warp `w` writes `warp_sums[w]`, then the whole block waits at one `__syncthreads()`. A 256-thread block fills 8 slots; the rest stay unwritten.',
          },
          {
            tone: 'dotted',
            label: 'warp 0',
            items: [
              {
                id: 'warp0',
                label: 'Warp 0 sums the slots',
                sub: 'warp_sums[lane] or 0 → shuffle',
                kind: 'kernel',
                shape: 'lane 0: block sum',
                detail:
                  'Lane `l` reads `l < blockDim.x / 32 ? warp_sums[l] : 0` and calls `warp_reduce_sum` again. At most 1,024 threads means at most 32 slots, so one warp finishes any block.',
              },
            ],
          },
        ],
      },
      {
        id: 'atomic',
        label: 'atomicAdd(out, block sum)',
        sub: 'lane 0 of warp 0 · once per block',
        kind: 'kernel',
        detail:
          'Blocks cannot wait for each other inside a launch, so their totals meet in global memory. Blocks finish in any order, so the last bits of the sum vary run to run.',
      },
      {
        id: 'gmem-out',
        label: 'Global memory',
        sub: 'out · 4 bytes',
        kind: 'memory',
        detail: 'One float, zeroed by the host before each launch and copied back after it.',
      },
      {
        id: 'check',
        label: 'Host check',
        kind: 'host',
        sub: 'rel err ≤ 1e-5 vs Kahan (double)',
        detail:
          'The reference is a Kahan sum in double, so its own error is negligible; the tolerance is relative, `|sum − ref| / |ref|`. The host prints ms per launch, GB/s and `PASS`.',
      },
    ],
    notes: [
      {at: 'gmem-in', text: '**64 MiB** read once: **128** floats per thread', side: 'left'},
      {at: 'shfl', text: '**5** shuffles, no shared memory, no barrier', side: 'left'},
      {at: 'smem', text: '**1** __syncthreads() per block', side: 'left'},
      {at: 'atomic', text: '**512** atomics against **16 M** loads'},
    ],
    insets: [
      {
        for: 'shfl',
        title: 'Warp shuffle tree',
        items: [
          {id: 'off16', label: 'offset 16', sub: 'lanes 0–15 hold 2 values', kind: 'kernel'},
          {id: 'off8', label: 'offset 8', sub: 'lanes 0–7 hold 4', kind: 'kernel'},
          {id: 'off4', label: 'offset 4', sub: 'lanes 0–3 hold 8', kind: 'kernel'},
          {id: 'off2', label: 'offset 2', sub: 'lanes 0–1 hold 16', kind: 'kernel'},
          {id: 'off1', label: 'offset 1', sub: 'lane 0 holds all 32', kind: 'kernel'},
        ],
        note: '**5** register moves replace **5** shared-memory levels',
      },
    ],
  },
  steps: [reduceSumStep],
  learn,
};
