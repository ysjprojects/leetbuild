import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {flashAttentionStep} from './steps/1-flash-attention';

/**
 * Drill: exact causal attention computed in query/key tiles with an online softmax — the
 * FlashAttention algorithm written as a PyTorch loop, so the [T, T] score matrix never exists and
 * the running max, running sum and rescaling that make streaming exact are the learner's to write.
 */
export const ptFlashAttentionTiledProblem: Problem = {
  id: 'pt-flash-attention-tiled',
  title: 'Tiled attention with online softmax (FlashAttention in PyTorch)',
  tagline:
    'Exact causal attention one [block_q, block_k] tile at a time: a running max and sum per row, rescaled by exp(m_old − m_new), the causal mask inside the tile, never a [T, T] matrix.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# Tiled attention with online softmax (FlashAttention in PyTorch)

Attention is \`softmax(q kᵀ / √hd) v\`. Written as three ops it materialises the score matrix — \`[B, H, T, T]\`
in float32, read and written several times — and at \`T = 32k\` that matrix, not the model, is what fills the
GPU. FlashAttention's observation is that the softmax of a row can be computed **in pieces**: walk the keys in
tiles, keep the max and the sum seen so far, and rescale what was accumulated under the old max when a new tile
raises it. The output is exact, the intermediates are one tile, and the kernel never leaves on-chip memory. Every
frontier model trains and serves through a kernel of this shape — \`F.scaled_dot_product_attention\` dispatches
to one on CUDA.

Here the algorithm is written as a PyTorch loop, which is what the kernel does with tensor cores and shared
memory, minus the hardware: the shape of the computation is the lesson.

The surface is one function and one test helper:

- \`flash_attention(q, k, v, block_q, block_k, causal=True) -> out\` over \`q\`, \`k\`, \`v\` of shape \`[B, H, T, hd]\`,
  computed in float32 (float64 kept for \`gradcheck\`), returned in the input dtype, never holding a \`[T, T]\`
  tensor — scores are \`[B, H, block_q, block_k]\` tiles, the causal mask is applied inside a tile and
  fully masked tiles are skipped.
- \`NoFullScores(T)\`, a \`TorchFunctionMode\` the self-test wraps the call in: it raises if any op returns a
  tensor whose trailing shape is \`[T, T]\`.

## What you build here

1. \`flash_attention\`: two loops (query tiles, key/value tiles), the per-row running max \`m\`, running sum \`l\`
   and accumulator \`o\`, \`alpha = exp(m - m_new)\` rescaling when the max moves, the in-tile causal mask from
   \`torch.arange\` positions, \`1 / sqrt(hd)\` scaling, one \`o / l\` per query tile.

## Run it on your machine

\`\`\`
python flash_attention.py
\`\`\`

Needs PyTorch 2.x, CPU is enough. A passing run prints \`PASS\`: four causal tile shapes on \`T = 37\` (not a
multiple of any of them) match \`F.scaled_dot_product_attention(is_causal=True)\` within \`atol=1e-5\` with no
\`[T, T]\` tensor ever created, a tile larger than \`T\` degenerates to one tile, the non-causal variant matches
the unmasked reference, and \`torch.autograd.gradcheck\` in float64 passes on a \`[1, 2, 7, 4]\` case.

## Left out on purpose

The backward pass with recomputation (autograd here saves every tile, so training memory stays \`O(T²)\`),
padding and attention masks beyond causal, multi-query / grouped-query heads, dropout, the SRAM/HBM
accounting that picks \`block_q\` and \`block_k\` on a real GPU, and the FlashAttention-2 loop order and warp
partitioning — the kernel engineering on top of the algorithm written here.`,
  figures: [
    {
      title: 'Tiled attention, online softmax',
      architecture: {
        input: 'from the QKV projection',
        output: 'exact softmax(q kᵀ / √hd) v',
        items: [
          {
            id: 'inputs',
            label: 'Queries, keys, values',
            kind: 'io',
            sub: 'q, k, v · [2, 3, 37, 16]',
            shape: '[B, H, T, hd]',
            detail:
              'The self-test runs `B, H, T, hd = 2, 3, 37, 16`, with `T` a multiple of no tile size. Computed in float32 (float64 kept for `gradcheck`).',
          },
          {
            tone: 'block',
            repeat: '⌈T / block_q⌉ ×',
            label: 'Query tile q0:q1',
            items: [
              {
                id: 'qtile',
                label: 'Q tile in SRAM',
                kind: 'memory',
                sub: 'q[:, :, q0:q1] · [B, H, 8, 16]',
                shape: '[B, H, block_q, hd]',
                detail:
                  'Loaded once per query tile and reused against every key tile. The last tile is shorter when `T` is not a multiple of `block_q`.',
              },
              {
                id: 'init',
                label: 'Running statistics',
                sub: 'm = −inf, l = 0, o = 0',
                detail:
                  'Per query row: `m` the largest score so far `[B, H, bq, 1]`, `l` the sum of exponentials under `m` `[B, H, bq, 1]`, `o` the unnormalised output `[B, H, bq, hd]`.',
              },
              {
                tone: 'block',
                repeat: 'while k0 < q1',
                label: 'Key/value tile k0:k1',
                items: [
                  {
                    id: 'kvtile',
                    label: 'K, V tiles in SRAM',
                    kind: 'memory',
                    sub: 'k, v[:, :, k0:k1] · [B, H, 8, 16]',
                    detail:
                      'Key tiles are walked in order; the first one with `k0 >= q1` lies entirely after the query tile, so the loop breaks.',
                  },
                  {
                    id: 'scores',
                    label: 'Tile scores',
                    kind: 'attention',
                    sub: 's = q kᵀ / √16 · [8, 8]',
                    shape: '[B, H, block_q, block_k]',
                    side: {
                      label: 'Causal mask',
                      sub: 'cols > rows → −inf',
                      detail:
                        'Only a tile crossing the diagonal needs it, built from `arange(q0, q1)` and `arange(k0, k1)`: a `[block_q, block_k]` mask, never a `[T, T]` `tril`.',
                    },
                    detail: 'One small matmul; this tile is the only score matrix that ever exists.',
                  },
                  {
                    id: 'rowmax',
                    label: 'New running max',
                    sub: 'm_new = max(m, s.amax(-1))',
                    detail: 'The largest score seen so far in each row, this tile included.',
                  },
                  {
                    id: 'rescale',
                    label: 'Rescale factor',
                    kind: 'attention',
                    sub: 'alpha = exp(m − m_new)',
                    detail:
                      '1 when the max did not move, below 1 when it did, 0 on the first tile (`m = -inf`). It converts sums taken under the old max to the new one.',
                  },
                  {
                    id: 'exp',
                    label: 'Exponentials',
                    sub: 'p = exp(s − m_new)',
                    shape: '[B, H, block_q, block_k]',
                    detail: 'Every argument is `≤ 0`, so nothing overflows; masked entries become exactly 0.',
                  },
                  {
                    id: 'accumulate',
                    label: 'Rescale and accumulate',
                    kind: 'attention',
                    sub: 'l = αl + Σp · o = αo + p v',
                    shape: '[B, H, block_q, hd]',
                    detail:
                      '`l = alpha * l + p.sum(-1)`, `o = alpha * o + p @ v_tile`, `m = m_new`: what was accumulated under the old max is shrunk before the new tile is added.',
                  },
                ],
              },
              {
                id: 'normalise',
                label: 'Normalise once',
                sub: 'out[:, :, q0:q1] = o / l',
                shape: '[B, H, block_q, hd]',
                detail: 'One division per query tile, after the last key tile: `l` is only complete then.',
              },
            ],
          },
          {
            id: 'out',
            label: 'Output',
            kind: 'io',
            sub: 'out · [2, 3, 37, 16] · input dtype',
            shape: '[B, H, T, hd]',
            detail:
              'Equal to `F.scaled_dot_product_attention(is_causal=True)` within `atol=1e-5` for every tile shape.',
          },
        ],
        notes: [
          {at: 'scores', text: '**[8, 8]** tiles, never **[T, T]**'},
          {at: 'rescale', text: 'alpha ≤ **1**: only ever shrinks what came before'},
          {at: 'kvtile', text: 'Tiles past the diagonal skipped: about **half** the work', side: 'left'},
          {at: 'normalise', text: '**One** division per query tile'},
        ],
      },
    },
    {
      title: 'Tiles in on-chip memory',
      gpu: {
        align: 'center',
        items: [
          {
            id: 'hbm',
            label: 'HBM',
            sub: 'per (b, h) · T = 37, hd = 16',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'q-hbm',
                array: 'q',
                sub: 'cell = 8-row tile',
                cols: 5,
                cells: 'index',
                marks: [{cols: [1, 1], tone: 'shared', label: 'q0:q1'}],
                detail:
                  'Query tile 1, rows 8 … 15, is loaded once and stays on chip while every key tile up to the diagonal streams past it. The last tile holds rows 32 … 36.',
              },
              {
                id: 'k-hbm',
                array: 'k',
                sub: 'cell = 8-row tile',
                cols: 5,
                cells: 'index',
                marks: [
                  {cols: [1, 1], tone: 'shared', label: 'k0:k1'},
                  {cols: [2, 4], tone: 'muted'},
                ],
                detail:
                  'Key tiles are read in order. Tile 2 starts at `k0 = 16 = q1`, entirely in the future of every query in the tile: the loop breaks and never reads tiles 2 … 4.',
              },
              {
                id: 'v-hbm',
                array: 'v',
                sub: 'cell = 8-row tile',
                cols: 5,
                cells: 'index',
                marks: [
                  {cols: [1, 1], tone: 'shared', label: 'k0:k1'},
                  {cols: [2, 4], tone: 'muted'},
                ],
                detail: 'The value tile always travels with its key tile: `p @ v[:, :, k0:k1]`.',
              },
              {
                id: 'out-hbm',
                array: 'out',
                sub: 'once per q tile',
                cols: 5,
                cells: 'index',
                marks: [
                  {cols: [1, 1], tone: 'register', label: 'o / l'},
                  {cols: [2, 4], tone: 'muted'},
                ],
                detail:
                  'Tile 0 is already written. Tile 1 is written once, `o / l`, after its last key tile: nothing about the scores ever reaches HBM.',
              },
            ],
          },
          {
            id: 'chip',
            label: 'On chip',
            sub: 'one query tile',
            tone: 'compute',
            layout: 'column',
            items: [
              {
                id: 'smem',
                label: 'Shared memory',
                sub: 'Q once, K and V every inner step',
                tone: 'shared',
                layout: 'column',
                items: [
                  {
                    id: 'q-tile',
                    array: 'Q tile',
                    sub: '[block_q, hd] = [8, 16]',
                    rows: 8,
                    cols: 16,
                    tone: 'shared',
                    detail: 'Read from HBM once per query tile and reused against every key tile.',
                  },
                  {
                    id: 'kv-tile',
                    array: 'K, V tiles',
                    sub: '2 × [block_k, hd] = 2 × [8, 16]',
                    rows: 8,
                    cols: 16,
                    tone: 'shared',
                    detail:
                      'Replaced on every inner iteration. On a real GPU `block_q` and `block_k` are chosen so these tiles fit in shared memory: 64 to 128 rows each.',
                  },
                ],
              },
              {
                id: 'regs',
                label: 'Registers',
                sub: 'per query row',
                tone: 'register',
                align: 'start',
                items: [
                  {
                    id: 'o-reg',
                    array: 'o',
                    sub: 'unnormalised · [8, 16]',
                    rows: 8,
                    cols: 16,
                    tone: 'register',
                    detail:
                      '`o = alpha · o + p @ v_tile`: the output under the current max, divided by `l` once at the end.',
                  },
                  {
                    id: 'm-reg',
                    array: 'm',
                    rows: 8,
                    cols: 1,
                    tone: 'register',
                    detail: 'Running max per query row, `-inf` before the first key tile.',
                  },
                  {
                    id: 'l-reg',
                    array: 'l',
                    rows: 8,
                    cols: 1,
                    tone: 'register',
                    detail:
                      'Running sum of `exp(s − m)` per row, rescaled by `alpha = exp(m − m_new)` whenever `m` moves.',
                  },
                  {
                    id: 's-tile',
                    array: 's',
                    sub: '[8, 8]',
                    rows: 8,
                    cols: 8,
                    tone: 'register',
                    marks: [
                      {cols: [1, 7], rows: [0, 0], tone: 'muted', label: '−inf'},
                      {cols: [2, 7], rows: [1, 1], tone: 'muted'},
                      {cols: [3, 7], rows: [2, 2], tone: 'muted'},
                      {cols: [4, 7], rows: [3, 3], tone: 'muted'},
                      {cols: [5, 7], rows: [4, 4], tone: 'muted'},
                      {cols: [6, 7], rows: [5, 5], tone: 'muted'},
                      {cols: [7, 7], rows: [6, 6], tone: 'muted'},
                    ],
                    detail:
                      'The only scores that ever exist: `q kᵀ / √16` for 8 queries and 8 keys. This tile straddles the diagonal, so `cols > rows` is filled with `-inf` and becomes exactly 0 in `p`. It is folded into `m`, `l` and `o`, then overwritten by the next tile.',
                  },
                ],
              },
            ],
          },
          {
            id: 'scores-map',
            label: 'Scores q kᵀ · [T, T]',
            sub: 'never stored',
            layout: 'column',
            items: [
              {
                id: 'tile-map',
                array: 'tile grid',
                sub: 'cell = [8, 8] tile',
                rows: 5,
                cols: 5,
                tone: 'register',
                marks: [
                  {cols: [1, 4], rows: [0, 0], tone: 'muted', label: 'skipped'},
                  {cols: [2, 4], rows: [1, 1], tone: 'muted'},
                  {cols: [3, 4], rows: [2, 2], tone: 'muted'},
                  {cols: [4, 4], rows: [3, 3], tone: 'muted'},
                  {cols: [1, 1], rows: [1, 1], tone: 'register'},
                ],
                detail:
                  'Rows are query tiles, columns key tiles. The 15 tiles on and below the diagonal are computed, each in registers and one at a time; the 10 above it are never visited. The outlined tile is the one in `s` now.',
              },
            ],
            detail:
              'A `[37, 37]` matrix per head that no op ever returns: the self-test’s `NoFullScores` mode raises if one does.',
          },
        ],
        arrows: [
          {from: 'hbm', to: 'smem', label: 'q, k, v tiles'},
          {from: 'o-reg', to: 'out-hbm', label: 'o / l, once'},
        ],
      },
    },
  ],
  steps: [flashAttentionStep],
  learn,
};
