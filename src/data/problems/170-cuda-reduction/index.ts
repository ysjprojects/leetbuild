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
  figures: [
    {
      title: 'The grid and one block',
      gpu: {
        align: 'end',
        items: [
          {
            id: 'gmem',
            label: 'Global memory',
            sub: 'cudaMalloc · HBM',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'in',
                array: 'in[n] · 2²⁴ floats',
                sub: 'row = pass · column = block',
                cols: 16,
                rows: 8,
                continues: true,
                cells: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
                marks: [{cols: [0, 0], rows: [0, 7], tone: 'register'}],
                detail:
                  'A cell is 256 floats, one block’s slice; a row is one pass of the whole grid, 131,072 floats; 128 rows cover `n` (8 drawn). Thread `blockIdx.x * 256 + threadIdx.x` starts in row 0 and steps by `gridDim.x * blockDim.x`, so block 0 reads column 0 of every row (marked) into its threads’ registers. Each warp load is 32 consecutive floats, one 128-byte transaction, and every element is read once.',
              },
              {
                id: 'out',
                array: 'out',
                sub: '1 float',
                cols: 1,
                detail:
                  'The host `cudaMemset`s it to 0 before **every** launch, because atomics accumulate. 512 blocks finish in any order, so the last bits of the sum vary run to run.',
              },
            ],
          },
          {
            id: 'grid',
            label: 'Kernel grid',
            sub: 'reduce_sum<<<512, 256>>>',
            count: '512 blocks',
            align: 'start',
            items: [
              {
                id: 'block0',
                label: 'Block 0',
                sub: '256 threads · 8 warps',
                layout: 'column',
                items: [
                  {
                    id: 'warps',
                    label: 'Every warp',
                    sub: 'v = warp_reduce_sum(v)',
                    items: [
                      {
                        label: 'Warp 0',
                        layout: 'column',
                        items: [{threads: 8, continues: true, label: '32 lanes'}],
                      },
                      {gap: '…'},
                      {
                        label: 'Warp 7',
                        layout: 'column',
                        items: [{threads: 8, continues: true, label: '32 lanes'}],
                      },
                    ],
                    detail:
                      'Each lane holds its grid-stride partial `v` in a register. `warp_reduce_sum` does `v += __shfl_down_sync(0xffffffff, v, offset)` for offsets 16, 8, 4, 2, 1 (the other figure): registers move lane to lane, no shared memory, no barrier. Lane 0 ends with the warp’s sum.',
                  },
                  {
                    id: 'smem',
                    label: 'Shared memory',
                    sub: '__shared__ float warp_sums[32]',
                    tone: 'shared',
                    stretch: true,
                    layout: 'column',
                    items: [
                      {
                        id: 'warp-sums',
                        array: 'warp_sums',
                        sub: 'one slot per warp',
                        cols: 16,
                        tone: 'shared',
                        cells: 'index',
                        continues: true,
                        marks: [
                          {cols: [0, 7], tone: 'shared', label: 'warps 0–7'},
                          {cols: [8, 15], tone: 'muted', label: 'never written'},
                        ],
                        detail:
                          'Lane 0 (`threadIdx.x % 32 == 0`) of warp `w = threadIdx.x / 32` writes `warp_sums[w]`, then the whole block meets at one `__syncthreads()`. A 256-thread block fills 8 of the 32 slots; shared memory is not initialised, so the other 24 hold whatever was there.',
                      },
                    ],
                  },
                  {
                    id: 'warp0',
                    label: 'Warp 0 sums the slots',
                    sub: 'lane < 8 ? warp_sums[lane] : 0',
                    layout: 'column',
                    items: [{threads: 16, idle: 8, continues: true, label: 'lanes 8–31 read 0'}],
                    detail:
                      'Lane `l` reads `l < blockDim.x / 32 ? warp_sums[l] : 0` and calls `warp_reduce_sum` again. At most 1,024 threads means at most 32 slots, so one warp finishes any block. Lane 0 then holds the block’s total and does the block’s only `atomicAdd`.',
                  },
                ],
                detail:
                  'Three stages in one register `v`: the grid-stride loop, a shuffle reduction per warp into a shared slot, and warp 0 over the slots. Every thread reaches the `__syncthreads()`, including one whose loop ran zero times.',
              },
              {gap: '…'},
              {
                label: 'Block 511',
                layout: 'column',
                items: [{threads: 8, continues: true, label: '256 threads'}],
              },
            ],
            detail:
              '512 × 256 = 131,072 threads, a fixed grid: each thread folds 128 elements before any shuffle. The 64 × 128 launch folds 2,048 each and cannot keep enough loads in flight to saturate HBM.',
          },
        ],
        arrows: [
          {from: 'in', to: 'block0', label: 'grid-stride loads'},
          {from: 'warps', to: 'smem', label: 'lane 0 of each warp'},
          {from: 'smem', to: 'warp0', label: 'after __syncthreads()'},
          {from: 'warp0', to: 'out', label: 'atomicAdd(out, v)'},
        ],
      },
    },
    {
      title: 'One warp’s shuffle tree',
      gpu: {
        items: [
          {
            id: 'shfl',
            label: 'One warp · warp_reduce_sum',
            sub: 'v += __shfl_down_sync(0xffffffff, v, offset)',
            count: '5 shuffles',
            layout: 'column',
            items: [
              {
                id: 'lanes',
                threads: 32,
                label: 'lanes 0–31 · one register v each',
                detail:
                  'All 32 lanes call `warp_reduce_sum`, and the full mask `0xffffffff` says so; `__activemask()` would name only the lanes converged at that instant.',
              },
              {
                id: 'v-in',
                array: 'v',
                sub: 'one partial per lane · lane numbers',
                cols: 32,
                tone: 'register',
                cells: 'index',
                marks: [{cols: [0, 31], tone: 'register'}],
              },
              {
                id: 'off16',
                array: 'after offset 16',
                sub: 'l adds l + 16 · cell: values summed',
                cols: 32,
                tone: 'register',
                cells: Array<string>(16).fill('2'),
                marks: [
                  {cols: [0, 15], tone: 'register'},
                  {cols: [16, 31], tone: 'muted', label: 'never read again'},
                ],
                detail:
                  'Lanes 16–31 also add something (lane `l + 16` is past 31, so they get their own value back), but nobody reads them again. The warp issues once whatever the lanes do.',
              },
              {
                id: 'off8',
                array: 'after offset 8',
                sub: 'l adds l + 8',
                cols: 32,
                tone: 'register',
                cells: Array<string>(8).fill('4'),
                marks: [
                  {cols: [0, 7], tone: 'register'},
                  {cols: [8, 31], tone: 'muted'},
                ],
              },
              {
                id: 'off4',
                array: 'after offset 4',
                sub: 'l adds l + 4',
                cols: 32,
                tone: 'register',
                cells: Array<string>(4).fill('8'),
                marks: [
                  {cols: [0, 3], tone: 'register'},
                  {cols: [4, 31], tone: 'muted'},
                ],
              },
              {
                id: 'off2',
                array: 'after offset 2',
                sub: 'l adds l + 2',
                cols: 32,
                tone: 'register',
                cells: ['16', '16'],
                marks: [
                  {cols: [0, 1], tone: 'register'},
                  {cols: [2, 31], tone: 'muted'},
                ],
              },
              {
                id: 'off1',
                array: 'after offset 1',
                sub: 'l adds l + 1 · lane 0 holds the sum',
                cols: 32,
                tone: 'register',
                cells: ['32'],
                marks: [
                  {cols: [0, 0], tone: 'register'},
                  {cols: [1, 31], tone: 'muted'},
                ],
                detail:
                  'Five register moves replace five shared-memory levels and their barriers. Lane 0 writes this value to `warp_sums[warp]`; in warp 0’s second pass it is the block’s total.',
              },
            ],
            detail:
              'A shuffle reads another lane’s register directly: no shared memory, no `__syncthreads()`, no bank conflicts. Each step halves the lanes whose values still matter.',
          },
        ],
      },
    },
  ],
  steps: [reduceSumStep],
  learn,
};
