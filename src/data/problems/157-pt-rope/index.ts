import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {ropeStep} from './steps/1-rope';

/**
 * Deep-learning drill: rotary position embeddings in the half-split (Llama / GPT-NeoX) layout — a
 * float32 cos/sin cache over positions × frequency pairs, a rotation gathered by explicit positions so a
 * decode step can offset into a KV cache, and a module holding the cache as non-persistent buffers —
 * checked against a complex-number reference and the relative-position property.
 */
export const ptRopeProblem: Problem = {
  id: 'pt-rope',
  title: 'Rotary position embeddings',
  tagline:
    'Precompute cos/sin over positions × frequency pairs, rotate q and k in halves, gather by position for the KV cache — and watch q·k come out a function of the distance alone.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 40,
  statement: `# Rotary position embeddings

Attention by itself is blind to order: permute the tokens and every score permutes with them. GPT-2 fixed
that by adding a learned vector per absolute position to the input. Llama, Mistral, Qwen, Gemma, GPT-NeoX
and most open models since 2022 use **rotary position embeddings** instead (Su et al., *RoFormer*, 2021):
inside every attention layer, just before the scores, each query and key is split into pairs of dimensions
and each pair is rotated by an angle proportional to the token's position \`m\`, pair \`i\` at its own
frequency \`theta_i = base^(−2i / head_dim)\`. Rotations compose, so the dot product of a query rotated by
\`m·theta\` and a key rotated by \`n·theta\` depends only on \`m − n\` — relative position, with no learned
parameter and nothing added to the residual stream.

The surface is two functions and a module in \`rope.py\`, in the half-split convention (dimension \`i\` pairs
with \`i + head_dim // 2\`):

- \`precompute_rope_cache(head_dim, max_seq_len, base=10000.0) -> (cos, sin)\` — float32, each
  \`[max_seq_len, head_dim // 2]\`.
- \`apply_rope(x, cos, sin, positions=None) -> Tensor\` — \`x\` is \`[batch, heads, seq, head_dim]\` in any float
  dtype; \`positions\` is \`[seq]\` int64 and defaults to \`0..seq−1\`; the result has \`x\`'s shape and dtype.
- \`RoPE(nn.Module)\` — \`RoPE(head_dim, max_seq_len, base=10000.0)\` holds \`cos\` and \`sin\` as non-persistent
  buffers; \`forward(x, positions=None)\` rotates with them.

## What you build here

1. \`precompute_rope_cache\`, \`apply_rope\` and \`RoPE\`: the inverse frequencies and the angle table, the
   half-split rotation \`(x1 c − x2 s, x2 c + x1 s)\` with rows gathered by \`positions\` and cast to
   \`x.dtype\`, and the cache registered with \`persistent=False\`.

## Run it on your machine

\`python rope.py\` — with \`torch.manual_seed(0)\` the self-test checks the cache's shape, dtype and
\`cos² + sin² = 1\`; that the module equals \`apply_rope\` with explicit positions; that position 0 is the
identity, norms are preserved, bfloat16 stays bfloat16, and a complex-number reference agrees to \`1e-5\`;
that \`scores[m, n] = q_m · k_n\` is unchanged by shifting both positions by 1, 7 or 40; that a token rotated
alone at offset 44 equals its slot in a sequence rotated at \`37..44\`; and a float64
\`torch.autograd.gradcheck\`. A passing run prints \`PASS\`.

## Left out on purpose

The attention layer around it (projections, scores, softmax, the KV cache itself), the interleaved
\`(2i, 2i + 1)\` layout of the paper and Meta's reference code, partial rotary (rotating only a fraction of
\`head_dim\`, as GPT-NeoX and Phi do), context extension by rescaling the frequencies (position
interpolation, NTK-aware scaling, YaRN, Llama 3's smoothing), multimodal RoPE over 2-D or 3-D positions,
and fused kernels that rotate \`q\` and \`k\` inside the QKV projection.`,
  figures: [
    {
      title: 'Attention with rotary embeddings',
      architecture: {
        input: 'from LayerNorm 1',
        output: 'into the residual ⊕',
        items: [
          {
            id: 'x',
            label: 'Hidden states',
            kind: 'io',
            sub: 'x · positions m = 0..L−1',
            shape: '[B, L, d_model]',
            detail:
              'The tokens entering an attention layer, plus their positions. A decode step passes `positions = arange(offset, offset + L)` so new tokens line up with the KV cache.',
          },
          {
            tone: 'model',
            label: 'Attention layer with RoPE',
            items: [
              {
                columns: [
                  [
                    {
                      columns: [
                        [
                          {
                            id: 'q-proj',
                            label: 'Query projection',
                            sub: 'W_q · 4 heads × 16',
                            shape: '[B, 4, L, 16]',
                            detail: 'An ordinary linear layer, split into heads. RoPE leaves it untouched.',
                          },
                          {
                            id: 'rope-q',
                            label: 'RoPE on q',
                            kind: 'attention',
                            sub: 'pair i turned by m·θᵢ',
                            shape: '[B, 4, L, 16]',
                            side: {
                              label: 'cos / sin cache',
                              sub: '[64, 8] float32',
                              detail:
                                '`precompute_rope_cache(16, 64)`: the angle table `m · θᵢ` for every position and pair, computed once and registered with `persistent=False`. Both rotations gather their rows from it by position.',
                            },
                            detail:
                              '`apply_rope(q, cos, sin, positions)`: dimension `i` pairs with `i + 8`, and each pair is rotated by its position times its own frequency. Length is preserved; only the direction turns.',
                          },
                        ],
                        [
                          {
                            id: 'k-proj',
                            label: 'Key projection',
                            sub: 'W_k · 4 heads × 16',
                            shape: '[B, 4, L, 16]',
                            detail: 'An ordinary linear layer, split into heads.',
                          },
                          {
                            id: 'rope-k',
                            label: 'RoPE on k',
                            kind: 'attention',
                            sub: 'pair i turned by n·θᵢ',
                            shape: '[B, 4, L, 16]',
                            detail:
                              'The same rotation with the same cache. Keys go into the KV cache **already rotated**, at their own positions, and are never rotated again.',
                          },
                        ],
                      ],
                    },
                    {
                      id: 'scores',
                      label: 'Attention scores',
                      sub: 'q_rot · k_rotᵀ / √16',
                      shape: '[B, 4, L, L]',
                      detail:
                        'An ordinary dot product of rotated vectors: `R(mθ)q · R(nθ)k = q · R((n − m)θ)k`, so the score depends on the content and the distance `m − n` alone.',
                    },
                    {
                      id: 'softmax',
                      label: 'Causal softmax',
                      sub: 'over keys 0..m',
                      shape: '[B, 4, L, L]',
                    },
                  ],
                  [
                    {
                      id: 'v-proj',
                      label: 'Value projection',
                      sub: 'W_v · never rotated',
                      shape: '[B, 4, L, 16]',
                      detail:
                        'Values carry content, not position: rotating them would stamp absolute angles into the weighted sum.',
                    },
                  ],
                ],
              },
              {
                id: 'wsum',
                label: 'Weighted sum of values',
                sub: 'probs @ v',
                shape: '[B, 4, L, 16]',
              },
              {
                id: 'out-proj',
                label: 'Output projection',
                sub: 'W_o · heads merged',
                shape: '[B, L, d_model]',
              },
            ],
          },
        ],
        notes: [
          {at: 'rope-q', text: '**8** pairs per head, each at its own θᵢ', side: 'left'},
          {at: 'scores', text: 'The score depends on **m − n** alone', side: 'left'},
          {at: 'x', text: 'A decode step passes its **offset**', side: 'left'},
        ],
        insets: [
          {
            for: 'rope-q',
            title: 'apply_rope, half-split',
            items: [
              {id: 'gather', label: 'Gather cache rows', sub: 'cos[positions], sin[positions]'},
              {id: 'cast', label: 'Cast and broadcast', sub: '.to(x.dtype) · [1, 1, L, 8]'},
              {id: 'halves', label: 'Split into halves', sub: 'x1, x2 = x.chunk(2, dim=-1)'},
              {id: 'rotate', label: 'Rotate every pair', kind: 'attention', sub: 'x1·c − x2·s,  x2·c + x1·s'},
              {id: 'concat', label: 'Concatenate', sub: 'cat(dim=-1) · x’s shape and dtype'},
            ],
            note: '**4** multiplies and **2** adds per pair, nothing transcendental',
          },
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'RoFormer: Enhanced Transformer with Rotary Position Embedding',
      url: 'https://arxiv.org/abs/2104.09864',
      by: 'Jianlin Su et al.',
      date: '2021-04-20',
      venue: 'Neurocomputing 2024',
      takes:
        'Rotary embeddings: pair `i` rotated by `m · theta_i` with `theta_i = base^(−2i / head_dim)`, so `q_m · k_n` depends on `m − n` alone.',
    },
    {
      kind: 'code',
      title: 'roformer',
      url: 'https://github.com/ZhuiyiTechnology/roformer',
      by: 'ZhuiyiTechnology',
      date: '2021-03-22',
      venue: 'GitHub',
      takes:
        "The authors' RoFormer, with the interleaved `(2i, 2i + 1)` pairing this problem swaps for the half split.",
    },
    {
      kind: 'post',
      title: 'Rotary Embeddings: A Relative Revolution',
      url: 'https://blog.eleuther.ai/rotary-embeddings/',
      by: 'Stella Biderman et al.',
      date: '2021-04-20',
      venue: 'EleutherAI Blog',
      takes:
        "The complex-number derivation the self-test's reference uses, and GPT-NeoX's `rotate_half` with a cached cos/sin table, the half-split layout `apply_rope` follows.",
    },
  ],
  steps: [ropeStep],
  learn,
};
