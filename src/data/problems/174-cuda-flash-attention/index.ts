import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {flashAttentionStep} from './steps/1-flash-attention';

/**
 * Drill: the forward pass of FlashAttention for one head as one CUDA kernel — K/V tiles staged in
 * shared memory, scores in registers, softmax finished one tile at a time with a running max and
 * sum, the causal mask applied inside a tile and whole tiles above the diagonal skipped, the T × T
 * score matrix never written anywhere.
 */
export const cudaFlashAttentionProblem: Problem = {
  id: 'cuda-flash-attention',
  title: 'A FlashAttention-style fused attention kernel',
  tagline:
    'softmax(QKᵀ)V for one head in one kernel: K/V tiles in shared memory, scores in registers, online softmax with a running max and sum, causal tiles skipped — no T × T matrix ever hits global memory.',
  difficulty: 'hard',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# A FlashAttention-style fused attention kernel

Every transformer layer computes, per head, \`O = softmax(Q Kᵀ / √d) V\` over a sequence of \`T\` tokens.
Written as three matrix operations it is \`T × T\` scores to global memory, a softmax that reads and
rewrites them, and a second matmul that reads them again: for \`T = 8192\` that is 256 MB per head per
layer travelling through HBM three times while the arithmetic is cheap. Attention on a GPU is
memory-bound, and the fix — the kernel behind \`torch.nn.functional.scaled_dot_product_attention\`,
vLLM, and every long-context model since 2022 — is **FlashAttention**: compute the scores one tile at
a time, finish the softmax incrementally with a running max and a running sum, and write only \`O\`.

You write that kernel's forward pass for one head, in plain CUDA, for \`float\` inputs:

\`\`\`cuda
__global__ void flash_attn_fwd(const float* Q, const float* K, const float* V, float* O,
                               int T, int d, float scale, bool causal);
\`\`\`

\`Q\`, \`K\`, \`V\`, \`O\` are row-major \`T × d\`; \`scale = 1 / √d\`; \`causal\` masks \`j > i\`. Each block owns
\`BQ = 64\` query rows, one per thread, and loops over the keys in tiles of \`BK = 32\` rows staged in
\`__shared__\` memory; every thread keeps its query row, its \`BK\` scores, its output accumulator and
the running max \`m\` and sum \`l\` in registers. \`d ≤ D_MAX = 64\`.

## What you build here

1. \`flash_attn_fwd\`: the tile loop with two \`__syncthreads()\`, the scores in registers with the
   causal mask, the online-softmax fold (\`m_new\`, \`alpha = __expf(m − m_new)\`, rescale, accumulate,
   \`l\`), the block-uniform skip of tiles above the diagonal, and one normalised write of \`O\`.

## Run it on your machine

\`\`\`sh
nvcc -O2 -o flash_attention flash_attention.cu && ./flash_attention
\`\`\`

A passing run prints one line per case with the max absolute error against a double-precision CPU
reference (materialised softmax) and the kernel time from \`cudaEvent\`s, a memory note, and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
non-causal max|err| = 3.4e-07  kernel 0.052 ms
causal     max|err| = 2.9e-07  kernel 0.031 ms
memory: Q K V O 65536 bytes each on the device, 16384 bytes of shared memory per block for the K/V tiles, scores in registers (a 256 x 256 score matrix would be 262144 bytes; none allocated)
PASS
\`\`\`

The starter compiles and prints \`FAIL\` — the kernel writes nothing and \`O\` stays zero.

## Left out on purpose

The backward pass and the \`logsumexp\` it needs, multiple heads and a batch dimension (one more grid
axis), bf16/fp16 inputs and tensor-core matmuls (\`wmma\`, \`mma.sync\`), warp-level work partitioning
and the register-tile sizes of FlashAttention-2, the asynchronous pipelining of FlashAttention-3,
dropout, ALiBi/sliding-window masks, and the KV-cache layout of inference.`,
  figures: [
    {
      title: 'One block over Q, K and V',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'block',
            label: 'Thread block 1',
            sub: 'flash_attn_fwd<<<⌈T/64⌉, 64>>> · rows 64 … 127',
            count: '4 blocks',
            align: 'end',
            items: [
              {
                id: 'smem',
                label: 'Shared memory',
                sub: '2 × 8 KB · tile 2, kv0 = 64',
                tone: 'shared',
                layout: 'column',
                items: [
                  {
                    id: 'ks',
                    array: 'Ks[32][64]',
                    sub: 'a cell = key row kv0 + j',
                    cols: 16,
                    rows: 2,
                    tone: 'shared',
                    detail:
                      'Staged by the whole block, `idx` striding by 64 over `32 × 64` floats, zero past `T` and `d`, then `__syncthreads()`. In the score loop every lane reads the same `Ks[j][k]`: a broadcast, not a bank conflict.',
                  },
                  {
                    id: 'vs',
                    array: 'Vs[32][64]',
                    sub: 'a cell = value row kv0 + j',
                    cols: 16,
                    rows: 2,
                    tone: 'shared',
                    detail:
                      'Staged with `Ks`. A second `__syncthreads()` after the fold keeps a fast warp from overwriting the tile while a slow one still reads it.',
                  },
                ],
              },
              {
                id: 'thread',
                label: 'Thread 15',
                sub: 'query row 79',
                count: '× 64',
                layout: 'column',
                items: [
                  {
                    threads: 1,
                    detail:
                      'One thread per query row: `row = blockIdx.x · 64 + threadIdx.x`. Every one of the block’s 64 threads holds the same set of registers for its own row.',
                  },
                  {
                    id: 'regs',
                    label: 'Registers',
                    sub: 'about 160 floats per thread',
                    tone: 'register',
                    layout: 'grid',
                    columns: 2,
                    items: [
                      {
                        id: 's',
                        array: 's[32]',
                        sub: 'q · Ks[j] · a cell = one key',
                        cols: 16,
                        rows: 2,
                        tone: 'register',
                        marks: [
                          {rows: [0, 0], cols: [0, 15], tone: 'register', label: 'keys 64 … 79'},
                          {rows: [1, 1], cols: [0, 15], tone: 'muted', label: '−∞: key > row'},
                        ],
                        detail:
                          'One row of `S = Q Kᵀ` for this tile: 32 dot products of length `d`. Tile 2 straddles the diagonal, so row 79 keeps keys 64 … 79 and writes `-INFINITY` for keys 80 … 95, which then weigh `exp(−∞) = 0`. The row never leaves registers.',
                      },
                      {
                        id: 'ml',
                        array: 'm, l',
                        sub: 'running max, running sum',
                        cols: 2,
                        cells: ['m', 'l'],
                        tone: 'register',
                        detail:
                          'Start at `m = −∞`, `l = 0`. Per tile: `m_new = fmaxf(m, tile_max)`, `alpha = __expf(m − m_new)`, then `l = l · alpha + Σ p` and `m = m_new`.',
                      },
                      {
                        id: 'o',
                        array: 'o[64]',
                        sub: 'o *= α, then o += p · Vs[j]',
                        cols: 16,
                        tone: 'register',
                        detail:
                          'The output accumulator, rescaled by `alpha` when the running max rises, then `o[k] += p · Vs[j][k]` with `p = __expf(s[j] − m_new) ≤ 1`. Divided by `l` once, after the last tile.',
                      },
                      {
                        id: 'q',
                        array: 'q[64]',
                        sub: 'Q[79] · scale · a cell = 4 floats',
                        cols: 16,
                        tone: 'register',
                        detail:
                          'Loaded once before the tile loop, already multiplied by `scale = 1/√d`, zero past `d`. Every score of the row reuses it.',
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: 'hbm',
            label: 'Global memory',
            sub: 'HBM · 64 KB per array',
            detail: '`T = 256`, `d = 64`: `Q`, `K`, `V`, `O` are 65,536 bytes each, and there is no `T × T` buffer.',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'g-k',
                array: 'K',
                sub: 'a row = one tile',
                cols: 8,
                rows: 8,
                marks: [
                  {rows: [2, 2], cols: [0, 7], tone: 'shared', label: 'tile 2'},
                  {rows: [4, 7], cols: [0, 7], tone: 'muted', label: 'causal: skipped'},
                ],
                detail:
                  'Walked in tiles of `BK = 32` rows. With `causal`, block 1’s last query is row 127, so `kv0 > 127` breaks the loop before tiles 4 … 7 are loaded. The test reads `blockIdx` only: the whole block leaves together.',
              },
              {
                id: 'g-v',
                array: 'V',
                sub: 'a row = one tile',
                cols: 8,
                rows: 8,
                marks: [
                  {rows: [2, 2], cols: [0, 7], tone: 'shared', label: 'tile 2'},
                  {rows: [4, 7], cols: [0, 7], tone: 'muted', label: 'causal: skipped'},
                ],
                detail: 'Staged tile by tile beside `K`, and skipped with it.',
              },
              {
                id: 'g-s',
                array: 'S = Q Kᵀ',
                sub: 'T × T · 256 KB · never allocated',
                cols: 8,
                rows: 8,
                marks: [{rows: [0, 7], cols: [0, 7], tone: 'muted', label: 'not in memory'}],
                detail:
                  'Where standard attention would write its `T × T` scores, read them for the softmax and read them again for `P V`. Here each 64 × 32 tile of `S` exists only as the `s[32]` registers of 64 threads, one tile at a time.',
              },
              {
                id: 'g-o',
                array: 'O',
                sub: 'a row = 32 tokens',
                cols: 8,
                rows: 8,
                marks: [{rows: [2, 3], cols: [0, 7], tone: 'register', label: 'written once'}],
                detail:
                  'The only output: after the last tile, `O[row · d + k] = o[k] / l` for `k < d`, only for `row < T`. Threads past `T` still reached every barrier.',
              },
              {
                id: 'g-q',
                array: 'Q',
                sub: 'a row = 32 tokens',
                cols: 8,
                rows: 8,
                marks: [{rows: [2, 3], cols: [0, 7], tone: 'register', label: 'block 1'}],
                detail: 'Row-major `T × d`. Block 1’s 64 query rows are read once, one row per thread, into registers.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'g-q', to: 'q', label: 'Q[row] · scale'},
          {from: 'g-k', to: 'smem', label: 'K tile 2'},
          {from: 'g-v', to: 'smem', label: 'V tile 2'},
          {from: 'ks', to: 's', label: 'q · Ks[j]'},
          {from: 'vs', to: 'o', label: 'p · Vs[j]'},
          {from: 'o', to: 'g-o', label: 'o / l'},
        ],
      },
    },
    {
      title: 'Causal tiles per block',
      gpu: {
        items: [
          {
            id: 'grid',
            label: 'Grid · causal',
            sub: 'flash_attn_fwd<<<4, 64>>> · T = 256',
            count: '20 of 32 tiles',
            items: [
              {
                id: 'blk0',
                label: 'Block 0',
                sub: 'queries 0 … 63',
                layout: 'column',
                items: [
                  {
                    threads: 8,
                    continues: true,
                    label: '64 threads, one query each',
                    detail:
                      'Every thread of the block walks the same tiles: the loop bound depends on `blockIdx` only, never on the thread’s own row.',
                  },
                  {
                    id: 'tiles0',
                    array: 'K/V tiles',
                    sub: 'a cell = 32 keys',
                    cols: 8,
                    cells: 'index',
                    tone: 'shared',
                    marks: [
                      {cols: [0, 1], tone: 'register', label: 'diag'},
                      {cols: [2, 7], tone: 'muted', label: 'skip'},
                    ],
                    detail:
                      '`q_last = 63`: tiles 0 and 1 hold the diagonal, tile 2 starts at key 64 > 63 and breaks the loop. Two tiles loaded.',
                  },
                ],
              },
              {
                id: 'blk1',
                label: 'Block 1',
                sub: 'queries 64 … 127',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '64 threads, one query each'},
                  {
                    id: 'tiles1',
                    array: 'K/V tiles',
                    sub: 'a cell = 32 keys',
                    cols: 8,
                    cells: 'index',
                    tone: 'shared',
                    marks: [
                      {cols: [0, 1], tone: 'shared', label: 'full'},
                      {cols: [2, 3], tone: 'register', label: 'diag'},
                      {cols: [4, 7], tone: 'muted', label: 'skip'},
                    ],
                    detail:
                      'Tiles 0 and 1 are below the diagonal for every row of the block: no score is masked. Tiles 2 and 3 straddle it, so each thread writes `-INFINITY` for the keys past its own row. Four tiles loaded.',
                  },
                ],
              },
              {
                id: 'blk2',
                label: 'Block 2',
                sub: 'queries 128 … 191',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '64 threads, one query each'},
                  {
                    id: 'tiles2',
                    array: 'K/V tiles',
                    sub: 'a cell = 32 keys',
                    cols: 8,
                    cells: 'index',
                    tone: 'shared',
                    marks: [
                      {cols: [0, 3], tone: 'shared', label: 'full'},
                      {cols: [4, 5], tone: 'register', label: 'diag'},
                      {cols: [6, 7], tone: 'muted', label: 'skip'},
                    ],
                    detail: '`q_last = 191`: tile 6 starts at key 192 and breaks the loop. Six tiles loaded.',
                  },
                ],
              },
              {
                id: 'blk3',
                label: 'Block 3',
                sub: 'queries 192 … 255',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '64 threads, one query each'},
                  {
                    id: 'tiles3',
                    array: 'K/V tiles',
                    sub: 'a cell = 32 keys',
                    cols: 8,
                    cells: 'index',
                    tone: 'shared',
                    marks: [
                      {cols: [0, 5], tone: 'shared', label: 'full'},
                      {cols: [6, 7], tone: 'register', label: 'diag'},
                    ],
                    detail:
                      'The last block sees every key up to 255: all eight tiles, the last two masked per key. It does four times the work of block 0.',
                  },
                ],
              },
            ],
            detail:
              'The skip `if (causal && kv0 > q_last) break;` depends on `blockIdx` only, so each block leaves its loop as a whole and no `__syncthreads()` is reached by half a block. Across the grid 20 of 32 tiles are loaded, which is the causal speed-up in the timing line.',
          },
        ],
      },
    },
  ],
  steps: [flashAttentionStep],
  learn,
};
