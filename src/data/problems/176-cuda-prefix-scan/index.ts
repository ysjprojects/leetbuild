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
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · exclusive_scan',
        sub: '⌈n/1024⌉ blocks · recurse on block sums · CPU check',
        x: 8,
        y: 50,
      },
      {
        id: 'scan',
        kind: 'service',
        label: 'scan_block<<<blocks, 512>>>',
        sub: 'padded tile · up-sweep · clear root · down-sweep',
        x: 36,
        y: 25,
      },
      {id: 'sums', kind: 'db', label: 'block_sums → offsets', sub: 'one total per block, scanned', x: 64, y: 25},
      {
        id: 'add',
        kind: 'service',
        label: 'add_block_offsets<<<blocks, 512>>>',
        sub: 'out[i] += offsets[blockIdx.x]',
        x: 64,
        y: 75,
      },
      {id: 'dmem', kind: 'db', label: 'Device memory', sub: 'in[n] · out[n]', x: 92, y: 50},
    ],
    edges: [
      {from: 'host', to: 'scan', kind: 'plain', label: 'launch · LAUNCH_CHECK'},
      {from: 'scan', to: 'sums', kind: 'plain', label: 'root of each tile'},
      {from: 'sums', to: 'host', kind: 'plain', label: 'exclusive_scan(sums, offsets, blocks)'},
      {from: 'sums', to: 'add', kind: 'plain', label: 'offsets[b]'},
      {from: 'scan', to: 'dmem', kind: 'plain', label: 'per-block exclusive scan'},
      {from: 'add', to: 'dmem', kind: 'plain', label: 'carry added'},
    ],
  },
  steps: [blellochScanStep],
  learn,
};
