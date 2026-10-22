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
  track: 'dl',
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
  diagram: {
    nodes: [
      {id: 'inputs', kind: 'client', label: 'q · k · v', sub: '[B, H, T, hd] float32', x: 6, y: 50},
      {id: 'qloop', kind: 'service', label: 'query tiles', sub: 'rows q0:q1 · block_q', x: 30, y: 50},
      {id: 'kloop', kind: 'service', label: 'key/value tiles', sub: 's = q kᵀ/√hd · mask · exp', x: 54, y: 50},
      {id: 'stats', kind: 'db', label: 'm · l · o', sub: 'per row: max · sum · accumulator', x: 78, y: 26},
      {id: 'ref', kind: 'external', label: 'F.scaled_dot_product_attention', sub: 'self-test reference', x: 78, y: 74},
    ],
    edges: [
      {from: 'inputs', to: 'qloop', kind: 'plain', label: 'q[:, :, q0:q1]'},
      {from: 'qloop', to: 'kloop', kind: 'plain', label: 'k, v [k0:k1] · skip if k0 ≥ q1'},
      {from: 'kloop', to: 'stats', kind: 'plain', label: 'alpha = exp(m − m_new) · l, o rescaled'},
      {from: 'stats', to: 'qloop', kind: 'plain', label: 'o / l'},
      {from: 'inputs', to: 'ref', kind: 'plain', label: 'allclose · gradcheck'},
    ],
  },
  steps: [flashAttentionStep],
  learn,
};
