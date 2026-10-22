import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {blellochScanStep} from './steps/1-blelloch-scan';

/** The 977 tiles of `n = 1,000,003`, a few drawn: the first ten and the last. */
const TILE_CELLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '…', '976'];

/**
 * Drill: a work-efficient (Blelloch) exclusive scan of any length — an up-sweep and a down-sweep
 * over a bank-conflict-free shared tile per block, the block totals scanned recursively and added
 * back, an inclusive variant on top, a CPU reference and PASS. The kernel behind MoE expert offsets,
 * cu_seqlens and stream compaction.
 */
export const cudaPrefixScanProblem: Problem = {
  id: 'cuda-prefix-scan',
  title: 'Work-efficient parallel prefix sum across blocks',
  tagline:
    'Exclusive scan of a million ints: an up-sweep and a down-sweep over a padded shared tile per block, block totals scanned by the same function and added back, 2n adds instead of n log n, max abs error 0 and PASS.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# Work-efficient parallel prefix sum across blocks

A **prefix sum** (scan) turns \`[3, 1, 7, 0, 4]\` into \`[0, 3, 4, 11, 11]\` (exclusive) or
\`[3, 4, 11, 11, 15]\` (inclusive). It is the primitive that turns counts into offsets, and a GPU model
stack runs it everywhere: the token-to-expert offsets a mixture-of-experts layer scatters by, the
\`cu_seqlens\` of a variable-length FlashAttention batch, the compaction of kept tokens in a sampling
loop, radix sort, \`torch.cumsum\`. It looks sequential — every output depends on every input before it —
but addition is associative, so two trees over the array do it in 2·log₂n parallel levels and 2n adds.
This drill writes the GPU Gems 3 version of that scan, extended to any length.

The surface is one file, \`prefix_scan.cu\`, compiled with \`nvcc\`. \`BLOCK_THREADS = 512\` and
\`ELEMS_PER_BLOCK = 2 * BLOCK_THREADS = 1024\` are given:

- \`__global__ void scan_block(const int* in, int* out, int* block_sums, int n)\` — one block scans 1024
  consecutive \`int\`s (zero past \`n\`) in a padded \`__shared__\` tile: up-sweep, the root saved to
  \`block_sums[blockIdx.x]\` (unless \`nullptr\`) and cleared, down-sweep, guarded store. Shared indices go
  through \`CONFLICT_FREE_OFFSET(i) = i >> LOG_NUM_BANKS\` with \`LOG_NUM_BANKS = 5\`.
- \`__global__ void add_block_offsets(int* out, const int* offsets, int n)\` — adds the scanned total of the
  blocks before it to every element of block \`b\`.
- \`__global__ void to_inclusive(const int* in, const int* excl, int* incl, int n)\` — \`incl[i] = excl[i] + in[i]\`.
- \`static void exclusive_scan(const int* d_in, int* d_out, int n)\` — one \`scan_block\` launch when
  \`n ≤ 1024\`; otherwise \`scan_block\` over \`⌈n / 1024⌉\` blocks, \`exclusive_scan\` of the block sums by
  calling itself, then \`add_block_offsets\`. \`LAUNCH_CHECK()\` after every launch.
- \`main\` (given) — \`n = 1, 1023, 1024, 1000003\` against a CPU loop for both variants, the max abs error
  (must be 0), the \`cudaEvent\` time of each exclusive scan, \`PASS\`.

## What you build here

1. \`scan_block\`, \`add_block_offsets\`, \`to_inclusive\` and \`exclusive_scan\`: the Blelloch up-sweep and
   down-sweep with a barrier per level, conflict-free padding of every shared index, the root handed to
   \`block_sums\` and cleared, the zero-padded tail block, and the recursive carry across blocks.

## Run it on your machine

\`\`\`text
nvcc -O2 -o prefix_scan prefix_scan.cu && ./prefix_scan
\`\`\`

A passing run prints one line per size and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
n=1  blocks=1  max abs error 0  exclusive scan 0.021 ms  (0.0 GB/s)
n=1023  blocks=1  max abs error 0  exclusive scan 0.012 ms  (0.7 GB/s)
n=1024  blocks=1  max abs error 0  exclusive scan 0.010 ms  (0.8 GB/s)
n=1000003  blocks=977  max abs error 0  exclusive scan 0.110 ms  (72.7 GB/s)
PASS
\`\`\`

The times depend on the GPU and include the \`cudaMalloc\`/\`cudaFree\` of the block sums; the error is
exactly 0 because integer addition is associative and the inputs are small enough never to overflow. The
starter prints \`FAIL\`: \`d_out\` comes back as the zeros it was set to.

## Left out on purpose

Single-pass scan with decoupled look-back (what CUB's \`DeviceScan\` does), warp-shuffle scans in
registers, several elements per thread, preallocated scratch instead of a \`cudaMalloc\` per level,
segmented scans, operators other than \`+\`, 64-bit sums and \`n\` beyond \`int\`.`,
  figures: [
    {
      title: 'One block’s padded tile',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'block',
            label: 'Thread block 2',
            sub: 'scan_block<<<977, 512>>> · elements 2048 … 3071',
            count: '977 blocks',
            layout: 'column',
            items: [
              {
                id: 'threads',
                threads: 16,
                continues: true,
                label: '512 threads · elements tid and tid + 512',
                detail:
                  'Two elements per thread: the busiest tree level combines 512 pairs, so 512 threads cover it. Loads and stores at `tid` and `tid + 512` stay coalesced.',
              },
              {
                id: 'smem',
                label: 'Shared memory',
                sub: 'int temp[1024 + 31] · 4,220 bytes',
                tone: 'shared',
                items: [
                  {
                    id: 'temp',
                    array: 'temp[]',
                    sub: 'first 128 words · a column = one bank',
                    cols: 32,
                    rows: 4,
                    tone: 'shared',
                    marks: [
                      {rows: [1, 1], cols: [0, 0], tone: 'muted'},
                      {rows: [2, 2], cols: [1, 1], tone: 'muted'},
                      {rows: [3, 3], cols: [2, 2], tone: 'muted'},
                      {rows: [0, 0], cols: [15, 15], tone: 'register'},
                      {rows: [1, 1], cols: [16, 16], tone: 'register'},
                      {rows: [2, 2], cols: [17, 17], tone: 'register'},
                      {rows: [3, 3], cols: [18, 18], tone: 'register'},
                    ],
                    detail:
                      'Element `i` lives at `i + (i >> 5)`: one wasted word (grey) after every 32, so each row of 32 elements starts one bank later than the last. At offset 16, thread `t` reads `a = 32t + 15`, stored at `33t + 15` (highlighted): bank `(t + 15) mod 32`, 32 lanes in 32 banks instead of a 32-way conflict on bank 15. The up-sweep and the down-sweep run in place here, a `__syncthreads()` before every level.',
                  },
                ],
              },
            ],
          },
          {
            id: 'hbm',
            label: 'Global memory',
            sub: 'HBM',
            detail:
              '`n = 1,000,003` ints. A cell of `in` and `out` is one 1,024-element tile; a cell of `block_sums` one int.',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'g-in',
                array: 'in[n]',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [
                  {cols: [2, 2], tone: 'shared', label: 'tile 2'},
                  {cols: [11, 11], tone: 'bad', label: '579'},
                ],
                detail:
                  'Block `b` loads elements `b · 1024 … b · 1024 + 1023`. The last tile holds only 579 elements; its block loads zeros past `n`, the identity of `+`, and guards its stores.',
              },
              {
                id: 'g-out',
                array: 'out[n]',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [{cols: [2, 2], tone: 'shared', label: 'from 0'}],
                detail:
                  'After this launch every tile holds its own exclusive scan, as if it began the array: tile 2 is still missing the totals of tiles 0 and 1.',
              },
              {
                id: 'g-sums',
                array: 'block_sums[977]',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [{cols: [2, 2], tone: 'shared', label: 'root'}],
                detail:
                  'Between the sweeps thread 0 copies the root, the tile’s total, to `block_sums[blockIdx.x]` (skipped when it is `nullptr`) and clears it to 0, which makes the scan exclusive.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'g-in', to: 'temp', label: '2 ints per thread'},
          {from: 'temp', to: 'g-out', label: 'guarded store'},
          {from: 'temp', to: 'g-sums', label: 'thread 0: root'},
        ],
      },
    },
    {
      title: 'Carry across blocks',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'stream',
            label: 'exclusive_scan(in, out, n)',
            sub: 'three launches on one stream · LAUNCH_CHECK after each',
            items: [
              {
                id: 'launch1',
                label: '1 · scan_block',
                sub: '<<<977, 512>>> · tiles from 0',
                tone: 'compute',
                detail:
                  'Every block scans its own tile and writes its total. Blocks run in any order and never wait for each other.',
              },
              {
                id: 'launch2',
                label: '2 · exclusive_scan(sums)',
                sub: 'scan_block<<<1, 512>>>',
                tone: 'compute',
                detail:
                  'The carry is itself a scan: `exclusive_scan` calls itself on the 977 block sums. They fit one block, so the recursion bottoms out with `block_sums = nullptr`; a billion elements would take one more level.',
              },
              {
                id: 'launch3',
                label: '3 · add_block_offsets',
                sub: '<<<977, 512>>> · out += offsets[b]',
                tone: 'compute',
                detail:
                  'Adds `offsets[blockIdx.x]` to the block’s 1,024 elements, guarded by `n`. Then `to_inclusive` can add `in[i]` for the inclusive variant.',
              },
            ],
            detail:
              'Kernel boundaries on one stream are the only ordering between blocks the scan relies on: launch 2 starts after every block of launch 1 has written its sum.',
          },
          {
            id: 'hbm2',
            label: 'Global memory',
            sub: 'HBM',
            detail:
              'A cell of `out` is one 1,024-element tile; a cell of `block_sums` and `offsets` is one int, one per tile.',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'out-part',
                array: 'out[n]',
                sub: 'after launch 1 · from 0',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                detail: 'Each tile’s exclusive scan, starting from 0.',
              },
              {
                id: 'sums',
                array: 'block_sums[977]',
                sub: 'one per tile',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [
                  {cols: [0, 0], tone: 'register', label: 's0'},
                  {cols: [1, 1], tone: 'register', label: 's1'},
                ],
                detail: '`block_sums[b]`, written `s_b` here, is the total of tile `b`: the root of its up-sweep.',
              },
              {
                id: 'offsets',
                array: 'offsets[977]',
                sub: 'scan of the sums',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [{cols: [2, 2], tone: 'register', label: 's0 + s1'}],
                detail:
                  '`offsets[b] = s0 + … + s(b − 1)`: the total of every tile before `b`, the carry tile `b` is missing.',
              },
              {
                id: 'out-final',
                array: 'out[n]',
                sub: 'after launch 3 · final',
                cols: TILE_CELLS.length,
                cells: TILE_CELLS,
                marks: [{cols: [2, 2], tone: 'register', label: '+ (s0 + s1)'}],
                detail:
                  'The exclusive scan of the whole array. About `4n` ints of traffic in all: `scan_block` reads and writes `n`, `add_block_offsets` does it again.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'launch1', to: 'launch2', dashed: true},
          {from: 'launch2', to: 'launch3', dashed: true},
          {from: 'launch1', to: 'out-part'},
          {from: 'launch1', to: 'sums', label: 'roots'},
          {from: 'sums', to: 'launch2'},
          {from: 'launch2', to: 'offsets', label: 'scan'},
          {from: 'offsets', to: 'launch3'},
          {from: 'launch3', to: 'out-final'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Prefix Sums and Their Applications',
      url: 'https://www.cs.cmu.edu/~scandal/papers/CMU-CS-90-190.html',
      by: 'Guy E. Blelloch',
      date: '1990-11',
      venue: 'CMU technical report CMU-CS-90-190',
      takes:
        'The work-efficient exclusive scan: an up-sweep that builds partial sums in a tree, the root cleared, and a down-sweep that hands each node its prefix, 2n adds in 2·log₂n levels.',
    },
    {
      kind: 'paper',
      title: 'Parallel Prefix Sum (Scan) with CUDA',
      url: 'https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda',
      by: 'Mark Harris, Shubhabrata Sengupta and John D. Owens',
      date: '2007-08',
      venue: 'GPU Gems 3',
      takes:
        'The kernel `scan_block` follows: 512 threads scanning 1024 elements in shared memory, `CONFLICT_FREE_OFFSET` padding against bank conflicts, and block sums scanned then added back for any length.',
    },
    {
      kind: 'paper',
      title: 'Single-pass Parallel Prefix Scan with Decoupled Look-back',
      url: 'https://research.nvidia.com/publication/2016-03_single-pass-parallel-prefix-scan-decoupled-look-back',
      by: 'Duane Merrill and Michael Garland',
      date: '2016-03',
      venue: 'NVIDIA technical report NVR-2016-002',
      takes:
        'What replaces the recursive carry of `exclusive_scan` in production: one pass in which each block looks back at its predecessors’ published aggregates, about 2n data movement instead of 3n.',
    },
    {
      kind: 'code',
      title: 'CCCL',
      url: 'https://github.com/NVIDIA/cccl',
      by: 'NVIDIA',
      date: '2020-09-17',
      venue: 'GitHub',
      takes:
        "CUB's `cub::DeviceScan::ExclusiveSum` and `cub::BlockScan`, the decoupled look-back scan the self-test's times can be compared against.",
    },
    {
      kind: 'docs',
      title: 'Shared Memory Bank Conflicts',
      url: 'https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/writing-cuda-kernels.html#writing-cuda-kernels-shared-memory-bank-conflicts',
      venue: 'CUDA Programming Guide',
      takes:
        'The 32 banks behind `LOG_NUM_BANKS = 5`, and why the tree’s power-of-two strides serialise a warp unless every index is padded by `i >> 5`.',
    },
  ],
  steps: [blellochScanStep],
  learn,
};
