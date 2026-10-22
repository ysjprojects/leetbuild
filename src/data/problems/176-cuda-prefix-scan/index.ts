import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {blellochScanStep} from './steps/1-blelloch-scan';

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
  track: 'dl',
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
  architecture: {
    input: 'in[n] · n = 1,000,003 int',
    output: 'exclusive and inclusive scans',
    items: [
      {
        id: 'host',
        label: 'Host: exclusive_scan',
        sub: 'blocks = ⌈n/1024⌉ · LAUNCH_CHECK',
        kind: 'host',
        detail:
          'One `scan_block` launch when `n ≤ 1024`; otherwise `scan_block` over the grid, `exclusive_scan` of the block sums by calling itself, then `add_block_offsets`. `main` checks `n = 1, 1023, 1024, 1000003` against a CPU loop.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory',
        sub: 'in[n] · 4 MB of int',
        kind: 'memory',
        shape: '[n] int32',
        detail: 'The input, read once by `scan_block` and once more by `to_inclusive`.',
      },
      {
        tone: 'block',
        repeat: '⌈n/1024⌉ ×',
        label: 'scan_block · 512 threads',
        items: [
          {
            id: 'smem',
            label: 'Shared tile temp[]',
            sub: '1,024 + 31 int · i + (i >> 5)',
            kind: 'memory',
            shape: 'temp: [1,055]',
            detail:
              'Two elements per thread (`tid` and `tid + 512`), zero past `n`. Every index goes through `CONFLICT_FREE_OFFSET(i) = i >> 5`: one wasted word every 32 spreads the tree’s power-of-two strides over all 32 banks.',
          },
          {
            tone: 'dotted',
            repeat: '10 ×',
            label: 'offset 1 → 512',
            items: [
              {
                id: 'up',
                label: 'Up-sweep level',
                sub: '__syncthreads; temp[b] += temp[a]',
                kind: 'kernel',
                detail:
                  'Thread `tid < d` owns `a = offset·(2·tid + 1) − 1`, `b = offset·(2·tid + 2) − 1` (both padded). 512, 256, …, 1 active threads: a reduction tree built in place, `n − 1` adds.',
              },
            ],
          },
          {
            id: 'root',
            label: 'Save the root, clear it',
            sub: 'block_sums[b] = root; root = 0',
            kind: 'kernel',
            detail:
              'Thread 0: the root holds the block total, which the next level of the multi-block scan needs (skipped when `block_sums` is `nullptr`). Clearing it to 0 makes the result exclusive.',
          },
          {
            tone: 'dotted',
            repeat: '10 ×',
            label: 'offset 512 → 1',
            items: [
              {
                id: 'down',
                label: 'Down-sweep level',
                sub: '__syncthreads; a, b = b, a + b',
                kind: 'kernel',
                detail:
                  'The same pairs walked back down: each left child gets its parent’s value, each right child parent + left. 1, 2, …, 512 active threads, a `__syncthreads()` before every level and one before the guarded store.',
              },
            ],
          },
        ],
      },
      {
        columns: [
          [
            {
              id: 'out-part',
              label: 'out[n]: per-block scans',
              sub: 'each block as if it began at 0',
              kind: 'memory',
              shape: '[n] int32',
            },
          ],
          [
            {
              id: 'sums',
              label: 'block_sums[977]',
              sub: 'one total per block',
              kind: 'memory',
              shape: '[977] int32',
            },
            {
              id: 'scan-sums',
              label: 'exclusive_scan(block_sums)',
              sub: 'recursive · <<<1, 512>>>',
              kind: 'kernel',
              shape: 'offsets: [977]',
              detail:
                'The carry each block is missing is the exclusive scan of the block totals: `offsets[b]` = total of blocks `0 … b−1`. 977 sums fit one block, so the recursion bottoms out at once with `block_sums = nullptr`.',
            },
          ],
        ],
      },
      {
        id: 'add',
        label: 'add_block_offsets',
        sub: 'out[i] += offsets[blockIdx.x]',
        kind: 'kernel',
        detail:
          'A separate launch over the same grid: kernel boundaries are the only ordering between blocks the scan relies on.',
      },
      {
        id: 'gmem-out',
        label: 'Global memory',
        sub: 'out[n] · exclusive scan',
        kind: 'memory',
        shape: '[n] int32',
      },
      {
        id: 'incl',
        label: 'to_inclusive',
        sub: 'incl[i] = excl[i] + in[i]',
        kind: 'kernel',
        detail: 'The inclusive scan is the exclusive one shifted by one element; `inclusive_scan` runs it in place.',
      },
    ],
    notes: [
      {at: 'smem', text: '**31** pad words: a 32-way conflict becomes none'},
      {at: 'up', text: '**2(n − 1)** adds: 2,046 per tile, not 9,217'},
      {at: 'root', text: 'The root is the block total, taken before clearing'},
      {at: 'scan-sums', text: '**977** block sums fit one block: 2 levels'},
      {at: 'add', text: 'About **4n** ints of traffic; CUB needs 2n'},
    ],
  },
  steps: [blellochScanStep],
  learn,
};
