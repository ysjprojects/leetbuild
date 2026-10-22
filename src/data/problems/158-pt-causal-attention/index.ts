import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {causalAttentionStep} from './steps/1-causal-attention';

/**
 * Deep-learning drill: the attention layer of a decoder-only transformer written out in PyTorch —
 * one fused qkv projection, heads as a reshape, scaled dot-product scores, a tril buffer applied as
 * -inf before a float32 softmax, dropout, output projection — checked against
 * F.scaled_dot_product_attention(is_causal=True) and gradcheck.
 */
export const ptCausalAttentionProblem: Problem = {
  id: 'pt-causal-attention',
  title: 'Causal multi-head self-attention from scratch',
  tagline:
    'One fused qkv GEMM, heads as a view, q·kᵀ/√hd, a tril buffer as -inf before a float32 softmax, dropout, proj — equal to SDPA(is_causal=True) to 1e-5, gradchecked in float64.',
  difficulty: 'medium',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 45,
  statement: `# Causal multi-head self-attention from scratch

Every decoder-only language model — GPT-2, LLaMA, Mistral, the model answering your prompt — is a stack of
blocks whose first half is this layer. For each position \`t\` it builds a query from the token there,
scores it against the keys of positions \`0..t\`, and returns a weighted sum of their values: the token
reads the past and nothing after it, so one forward pass over a sequence teaches the model every
next-token prediction at once. Multiple heads run that lookup in parallel on slices of the embedding.

The surface is one module, \`CausalSelfAttention(d_model, n_heads, dropout=0.0, max_len=1024)\`, with
\`forward(x, attn_mask=None)\`: \`x\` is \`[B, T, d_model]\` float32 (or bfloat16, or float64), \`attn_mask\` an
optional \`[B, T]\` bool that is \`True\` where the key is a real token, the result \`[B, T, d_model]\`.
Inside: \`qkv = nn.Linear(d_model, 3 * d_model)\`, \`proj = nn.Linear(d_model, d_model)\`, a
\`causal_mask\` buffer of \`torch.tril\` over \`[max_len, max_len]\`, \`head_dim = d_model // n_heads\`.

## What you build here

1. \`CausalSelfAttention\`: fused qkv → split and reshape to \`[B, H, T, hd]\` → \`q @ kᵀ / sqrt(hd)\` →
   \`masked_fill(-inf)\` from the tril buffer (and the padding mask) **before** a float32 softmax →
   attention dropout → \`probs @ v\` → heads merged → output projection. No
   \`F.scaled_dot_product_attention\` inside the module: the self-test uses it as the reference.

## Run it on your machine

\`python causal_attention.py\` with PyTorch 2.x on CPU. A passing run prints \`PASS\`: the output equals
\`F.scaled_dot_product_attention(q, k, v, is_causal=True)\` through the same weights to \`1e-5\`, a change at
token 5 leaves positions \`0..4\` untouched, a right-padded sample matches SDPA with an explicit mask,
\`torch.autograd.gradcheck\` passes in float64 on a \`(d_model=8, n_heads=2)\` instance, and dropout is a
no-op in \`eval()\`. The starter raises \`NotImplementedError\` at the first assertion.

## Left out on purpose

Rotary or learned position embeddings (they belong to the block around this layer), the KV cache and the
one-query-row decode step, grouped-query attention, the FlashAttention tiling that keeps the \`[T, T]\`
scores out of memory, and \`torch.compile\`. This file materialises the full score matrix on purpose — that
is the thing the fused kernels exist to avoid, and you should see it once.`,
  diagram: {
    nodes: [
      {id: 'x', kind: 'client', label: 'x', sub: '[B, T, d_model]', x: 6, y: 50},
      {id: 'qkv', kind: 'service', label: 'qkv', sub: 'Linear(D, 3D) · split · view · transpose', x: 28, y: 50},
      {
        id: 'attn',
        kind: 'service',
        label: 'scores → softmax',
        sub: 'q @ kᵀ / √hd · masked_fill(-inf) · float32 softmax · dropout',
        x: 52,
        y: 50,
      },
      {id: 'mask', kind: 'db', label: 'causal_mask', sub: 'buffer · tril[max_len, max_len] · bool', x: 52, y: 85},
      {id: 'proj', kind: 'service', label: 'probs @ v → proj', sub: 'merge heads · Linear(D, D)', x: 76, y: 50},
      {
        id: 'ref',
        kind: 'external',
        label: 'F.scaled_dot_product_attention',
        sub: 'is_causal=True · allclose 1e-5 · gradcheck',
        x: 96,
        y: 50,
      },
    ],
    edges: [
      {from: 'x', to: 'qkv', kind: 'plain', label: 'x'},
      {from: 'qkv', to: 'attn', kind: 'plain', label: 'q, k, v [B, H, T, hd]'},
      {from: 'mask', to: 'attn', kind: 'plain', label: 'tril[:T, :T] & attn_mask'},
      {from: 'attn', to: 'proj', kind: 'plain', label: 'probs [B, H, T, T]'},
      {from: 'proj', to: 'ref', kind: 'plain', label: 'self-test'},
    ],
  },
  steps: [causalAttentionStep],
  learn,
};
