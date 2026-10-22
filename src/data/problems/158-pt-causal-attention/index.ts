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
  track: 'dllm',
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
  figures: [
    {
      title: 'Causal self-attention',
      architecture: {
        input: 'from LayerNorm 1',
        output: 'into the residual ⊕',
        items: [
          {
            id: 'x',
            label: 'Input embeddings',
            kind: 'io',
            sub: 'x · [B, T, 32]',
            shape: '[B, T, 32]',
            detail:
              'The residual stream entering the layer. The self-test runs `B, T, D, H = 2, 8, 32, 4`, in float32, bfloat16 or float64.',
          },
          {
            tone: 'model',
            label: 'CausalSelfAttention',
            items: [
              {
                id: 'qkv',
                label: 'Fused QKV projection',
                sub: 'qkv · Linear(32, 96)',
                shape: '[B, T, 96]',
                detail:
                  'One `nn.Linear(d_model, 3 * d_model)`: a single GEMM reads `x` once for all three projections. `split(d_model, dim=-1)` cuts its output into `q`, `k`, `v`.',
              },
              {
                columns: [
                  [
                    {
                      columns: [
                        [
                          {
                            id: 'q',
                            label: 'Queries',
                            sub: '4 heads × 8',
                            shape: '[B, 4, T, 8]',
                            detail:
                              '`view(B, T, n_heads, head_dim).transpose(1, 2)`: heads are a reshape of the embedding, not a loop.',
                          },
                        ],
                        [
                          {
                            id: 'k',
                            label: 'Keys',
                            sub: '4 heads × 8',
                            shape: '[B, 4, T, 8]',
                            detail: 'The same view and transpose as the queries.',
                          },
                        ],
                      ],
                    },
                    {
                      id: 'scores',
                      label: 'Scaled dot product',
                      kind: 'attention',
                      sub: 'q · kᵀ / √8',
                      shape: '[B, 4, T, T]',
                      detail:
                        'One batched matmul over `B × H`: every query against every key, divided by `sqrt(head_dim)` so the scores stay at unit scale.',
                    },
                    {
                      id: 'mask',
                      label: 'Causal mask',
                      kind: 'attention',
                      sub: 'masked_fill(~mask, −inf)',
                      shape: '[B, 4, T, T]',
                      side: {
                        label: 'causal_mask buffer',
                        sub: 'tril · [1024, 1024] bool',
                        detail:
                          '`register_buffer(..., persistent=False)`: moves with `.to(device)`, never trained, not saved. `forward` slices `[:T, :T]` and ANDs the padding mask `attn_mask[:, None, None, :]`.',
                      },
                      detail:
                        'Keys after the query get `-inf` **before** the softmax, so `exp` makes their probability exactly 0 and the row normalises over `0..t` alone.',
                    },
                    {
                      id: 'softmax',
                      label: 'Softmax over keys',
                      kind: 'attention',
                      sub: 'float32, cast back to v.dtype',
                      shape: '[B, 4, T, T]',
                      detail:
                        '`torch.softmax(..., dtype=torch.promote_types(scores.dtype, torch.float32))`: float32 for half inputs, float64 kept for `gradcheck`.',
                    },
                    {
                      id: 'dropout',
                      label: 'Attention dropout',
                      detail: '`nn.Dropout(dropout)` on the probabilities; the identity in `eval()`.',
                    },
                  ],
                  [
                    {
                      id: 'v',
                      label: 'Values',
                      sub: '4 heads × 8',
                      shape: '[B, 4, T, 8]',
                      detail: 'The same view and transpose; values are what the weights average.',
                    },
                  ],
                ],
              },
              {
                id: 'wsum',
                label: 'Weighted sum of values',
                kind: 'attention',
                sub: 'probs @ v',
                shape: '[B, 4, T, 8]',
                detail: 'Row `t` of the output is the probability-weighted average of the values at `0..t`.',
              },
              {
                id: 'merge',
                label: 'Merge heads',
                sub: 'transpose · contiguous · view',
                shape: '[B, T, 32]',
                detail:
                  '`transpose(1, 2).contiguous().view(B, T, d_model)`: the only copy in the layer puts the heads side by side again.',
              },
              {
                id: 'proj',
                label: 'Output projection',
                sub: 'proj · Linear(32, 32)',
                shape: '[B, T, 32]',
                detail: '`nn.Linear(d_model, d_model)` mixes what the heads found.',
              },
            ],
          },
        ],
        notes: [
          {at: 'qkv', text: '**One** GEMM for q, k and v', side: 'left'},
          {at: 'scores', text: 'The **[B, H, T, T]** matrix, materialised on purpose'},
          {at: 'mask', text: '**−inf** before the softmax, never 0 after it'},
          {at: 'softmax', text: 'Rows sum to **1** over keys **0..t**'},
          {at: 'v', text: '**4** heads of **8** dimensions'},
        ],
      },
    },
  ],
  steps: [causalAttentionStep],
  learn,
};
