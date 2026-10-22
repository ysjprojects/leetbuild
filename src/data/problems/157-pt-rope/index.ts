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
  track: 'dl',
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
  diagram: {
    nodes: [
      {id: 'attn', kind: 'client', label: 'Attention layer', sub: 'q, k [B, H, L, D] · positions', x: 10, y: 50},
      {id: 'rope', kind: 'service', label: 'RoPE / apply_rope', sub: 'gather · chunk · rotate · cat', x: 42, y: 50},
      {id: 'cache', kind: 'db', label: 'cos / sin buffers', sub: '[max_seq_len, D/2] float32', x: 75, y: 25},
      {id: 'kv', kind: 'db', label: 'KV cache', sub: 'keys rotated at their own positions', x: 75, y: 75},
      {id: 'ref', kind: 'external', label: 'Complex reference', sub: 'pair × e^{i m theta} · float64', x: 42, y: 90},
    ],
    edges: [
      {from: 'attn', to: 'rope', kind: 'plain', label: 'q, k, arange(offset, offset + L)'},
      {from: 'rope', to: 'cache', kind: 'plain', label: 'cos[positions], sin[positions]'},
      {from: 'rope', to: 'kv', kind: 'plain', label: 'k_rot appended'},
      {from: 'attn', to: 'ref', kind: 'plain', label: 'same x, allclose 1e-5'},
    ],
  },
  steps: [ropeStep],
  learn,
};
