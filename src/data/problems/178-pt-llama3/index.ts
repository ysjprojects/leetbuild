import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {llamaLayersStep} from './steps/1-llama-layers';
import {llamaAttentionStep} from './steps/2-llama-attention';
import {llamaModelStep} from './steps/3-llama-model';

/**
 * Deep-learning project: Llama 3 from scratch after Meta's reference model.py. RMSNorm, RoPE with the
 * Llama 3.1 frequency scaling and SwiGLU; grouped-query attention with a preallocated KV cache and an
 * offset causal mask; the Transformer, cached generation with top-p, and the closed-form parameter count.
 */
export const ptLlama3Problem: Problem = {
  id: 'pt-llama3',
  title: 'Llama 3 from scratch',
  tagline:
    "Write Llama 3 the way Meta's reference model.py does: RMSNorm, RoPE with the 3.1 scaling, SwiGLU, grouped-query attention over a preallocated KV cache, cached generation, and the 8B's 8,030,261,248 parameters counted in closed form.",
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 60,
  statement: `# Llama 3 from scratch

Llama 3 (Meta, 2024) is the open-weights decoder-only Transformer most of today's open models are measured
against, and the architecture many of them copy. Its 8B model is GPT-2's skeleton with every part swapped:
RMSNorm instead of LayerNorm, rotary position embeddings instead of a learned position table, a SwiGLU
feed-forward instead of GELU, **grouped-query attention** (32 query heads sharing 8 key/value heads) instead
of multi-head attention, no biases, and an untied output layer over a 128,256-token vocabulary. Llama 3.1
stretched the context from 8K to 128K tokens by rescaling RoPE's frequencies and continuing pretraining on
long documents. Inference engines (vLLM, llama.cpp, TensorRT-LLM) all implement this exact block; Meta's own
reference is about 300 lines of PyTorch, \`models/llama3/model.py\` in
[llama-models](https://github.com/meta-llama/llama-models).

You write that file, without fairscale, in three parts, each importing the previous one:

- \`llama_layers.py\`:
  - \`RMSNorm(dim, eps=1e-5)\`, statistics in float32 and the result cast back;
  - \`RopeScaling\`, \`scale_rope_freqs(freqs, scaling)\`, \`precompute_rope(head_dim, max_seq_len,
    theta=500000.0, scaling=RopeScaling()) -> (max_seq_len, head_dim // 2) complex64\` and
    \`apply_rope(xq, xk, freqs_cis)\` on adjacent pairs;
  - \`ffn_hidden_dim(hidden_dim, multiple_of, ffn_dim_multiplier)\` and \`FeedForward\` (SwiGLU, \`w1\`, \`w2\`, \`w3\`).
- \`llama_attention.py\`:
  - \`repeat_kv(x, n_rep)\`, \`causal_mask(seqlen, start_pos) -> (seqlen, start_pos + seqlen)\`,
    \`kv_cache_bytes_per_token(n_layers, n_kv_heads, head_dim, bytes_per_elem=2)\`;
  - \`Attention(dim, n_heads, n_kv_heads, max_batch_size, max_seq_len)\` with \`cache_k\` and \`cache_v\`
    buffers \`(max_batch_size, max_seq_len, n_kv_heads, head_dim)\` and
    \`forward(x (B, T, dim), start_pos, freqs_cis, mask) -> (B, T, dim)\`.
- \`llama_model.py\`:
  - \`ModelArgs\` (8B defaults), \`TransformerBlock\`, \`Transformer.forward(tokens (B, T) long, start_pos) ->
    (B, T, vocab_size) float32\`;
  - \`sample_top_p\`, \`generate(model, prompt, max_new_tokens, temperature=0.6, top_p=0.9, use_cache=True)\`;
  - \`num_params(args)\`: 8,030,261,248 for 8B, without allocating it.

## What you build here

1. **The layers**: RMSNorm with the float32 upcast, the RoPE table with Llama 3.1's wavelength-based
   scaling (\`factor=8\`, \`low_freq_factor=1\`, \`high_freq_factor=4\`, 8,192 original positions), the
   complex-number rotation, and SwiGLU with Meta's hidden-width rule (14,336 for 8B).
2. **Grouped-query attention**: \`wq\` for 32 heads, \`wk\`/\`wv\` for 8, \`repeat_kv\`, a KV cache written at
   \`start_pos\` and read up to \`start_pos + seqlen\`, a causal mask offset by \`start_pos\`, and the cache's
   cost: 128 KiB per token for 8B in bf16.
3. **The model**: pre-norm blocks, the untied head, a forward that serves prefill, chunked prefill and
   decode, generation with temperature and top-p, and the parameter count in closed form.

## Run it on your machine

Put the three files in one directory and run \`python llama_layers.py\`, \`python llama_attention.py\` and
\`python llama_model.py\` (Python 3.10 and PyTorch 2.1 or later, CPU only, no downloads; each takes a few
seconds on a laptop). Each prints \`PASS\`. The layers' test proves the formulas, that the rotation preserves norms and
that \`q·k\` depends only on the distance; the attention's test proves GQA equals an explicit multi-head
reference and that token-by-token decoding equals the full forward; the model's test proves cached
greedy generation equals uncached and the closed-form count equals \`sum(p.numel())\`.

## Left out on purpose

The tiktoken tokenizer and chat template, loading Meta's checkpoint (the module names here match it, so
\`load_state_dict\` would work on the 16 GB of bf16 weights), fairscale's tensor-parallel layers, ragged
batches with padding and stop tokens, bf16 and \`torch.compile\`, FlashAttention, paged KV caches and
continuous batching, and the 3.2 vision adapters.`,
  figures: [
    {
      title: 'Llama 3 8B',
      architecture: {
        input: 'The capital of France is',
        output: 'next-token logits',
        items: [
          {
            id: 'tokens',
            label: 'Tokenized text',
            kind: 'io',
            sub: 'tiktoken BPE ids',
            shape: '[B, T] int64',
            detail:
              'Llama 3 replaced SentencePiece with a tiktoken BPE of 128,256 ids (100K from tiktoken plus 28K for other languages). `forward(tokens, start_pos)` takes them at positions `start_pos …`.',
          },
          {
            tone: 'model',
            items: [
              {
                id: 'tok-emb',
                label: 'Token embedding',
                kind: 'embed',
                sub: 'tok_embeddings · 128,256 × 4,096',
                shape: '[B, T, 4,096]',
                detail:
                  'A lookup table of 525 M parameters. No position table is added: positions enter inside attention, through RoPE.',
              },
              {
                tone: 'block',
                repeat: '32 ×',
                label: 'Transformer block',
                items: [
                  {
                    id: 'attn-norm',
                    label: 'RMSNorm',
                    kind: 'norm',
                    sub: 'attention_norm · eps 1e-5',
                    detail:
                      '`x · rsqrt(mean(x²) + eps) · weight`, computed in float32 and cast back. No mean subtraction, no bias.',
                  },
                  {
                    id: 'attn',
                    label: 'Grouped-query attention',
                    kind: 'attention',
                    sub: '32 q heads · 8 kv heads · 128',
                    shape: '[B, T, 4,096]',
                    side: {
                      id: 'rope',
                      label: 'RoPE',
                      sub: 'θ 500,000 · scaled ×8',
                      detail:
                        'Rotates adjacent pairs of q and k by `position · freq_j`. Llama 3.1 divides the frequencies whose wavelength exceeds 8,192 tokens by 8 and blends the band between 2,048 and 8,192.',
                    },
                    detail:
                      '`wq` 4,096 → 4,096, `wk` and `wv` 4,096 → 1,024, `wo` back to 4,096, no biases. Keys and values are cached for 8 heads only; each serves 4 query heads through `repeat_kv`.',
                  },
                  {
                    id: 'add1',
                    op: '+',
                    from: 'attn-norm',
                    detail: '`h = x + attention(attention_norm(x), start_pos, freqs_cis, mask)`',
                  },
                  {id: 'ffn-norm', label: 'RMSNorm', kind: 'norm', sub: 'ffn_norm'},
                  {
                    id: 'ffn',
                    label: 'SwiGLU feed-forward',
                    kind: 'ffn',
                    sub: '4,096 → 14,336 → 4,096',
                    detail:
                      '`w2(silu(w1(x)) · w3(x))`: three bias-free matrices, 176 M parameters per block, 70 % of the model.',
                  },
                  {
                    id: 'add2',
                    op: '+',
                    from: 'ffn-norm',
                    detail: '`out = h + feed_forward(ffn_norm(h))`',
                  },
                ],
              },
              {id: 'final-norm', label: 'Final RMSNorm', kind: 'norm', sub: 'norm', shape: '[B, T, 4,096]'},
              {
                id: 'output',
                label: 'Linear output layer',
                kind: 'head',
                sub: '4,096 → 128,256 · untied',
                shape: '[B, T, 128,256]',
                detail:
                  'Its own weight, not the embedding table: 525 M more parameters. Logits come back in float32; generation reads the last row only.',
              },
            ],
          },
        ],
        notes: [
          {at: 'output', text: 'Vocabulary of **128,256**, untied'},
          {at: 'attn', text: '**32** query heads share **8** KV heads', side: 'left'},
          {at: 'ffn', text: 'Hidden dimension of **14,336**', side: 'left'},
          {at: 'tok-emb', text: 'Embedding dimension of **4,096**', side: 'left'},
        ],
        insets: [
          {
            for: 'attn',
            title: 'Grouped-query attention',
            items: [
              {
                columns: [
                  [{id: 'wq', label: 'wq', sub: '4,096 → 32 × 128'}],
                  [{id: 'wk', label: 'wk', sub: '4,096 → 8 × 128'}],
                  [{id: 'wv', label: 'wv', sub: '4,096 → 8 × 128'}],
                ],
              },
              {
                id: 'rope-qk',
                label: 'RoPE on q and k',
                sub: 'freqs_cis[start_pos : +T]',
                detail: 'Keys are rotated before they are cached, so a cached key never changes.',
              },
              {
                id: 'kv-write',
                label: 'Write the KV cache',
                kind: 'io',
                sub: 'cache[:B, start_pos : +T]',
                detail: 'Then read rows `0 … start_pos + T − 1`: every cached key plus the new ones.',
              },
              {id: 'repeat', label: 'repeat_kv', sub: '8 → 32 heads · ×4'},
              {
                id: 'scores',
                label: 'Masked softmax',
                kind: 'attention',
                sub: 'qkᵀ/√128 + mask · float32',
                detail: 'The mask is `(T, start_pos + T)`: zero columns for the cache, a triangle for the new tokens.',
              },
              {id: 'wo', label: 'wo', sub: '32 × 128 → 4,096'},
            ],
            note: 'KV cache of **128 KiB** per token in bf16',
          },
          {
            for: 'ffn',
            title: 'SwiGLU',
            items: [
              {
                columns: [
                  [
                    {id: 'w1', label: 'w1 · gate', sub: '4,096 → 14,336'},
                    {id: 'silu', label: 'SiLU', sub: 'x · σ(x)'},
                  ],
                  [{id: 'w3', label: 'w3 · up', sub: '4,096 → 14,336'}],
                ],
              },
              {id: 'gate-mul', op: '×'},
              {id: 'w2', label: 'w2 · down', sub: '14,336 → 4,096'},
            ],
            note: '**2/3 · 4d × 1.3**, rounded up',
          },
        ],
      },
    },
    {
      title: 'Heads and the KV cache',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'heads',
            label: 'One layer’s heads',
            sub: 'n_rep = 32 / 8 = 4',
            layout: 'column',
            items: [
              {
                id: 'q-heads',
                array: 'query heads · wq',
                sub: '32 × 128 · one per cell',
                cols: 32,
                tone: 'global',
                cells: 'index',
                marks: [0, 1, 2, 3, 4, 5, 6, 7].map(g => ({
                  cols: [4 * g, 4 * g + 3] as [number, number],
                  tone: g % 2 === 0 ? ('a' as const) : ('b' as const),
                  label: `kv ${g}`,
                })),
                detail:
                  'Query head `h` reads key/value head `h // 4`. `repeat_kv` builds the 32-head view (`expand`, then a `reshape` that copies) for the matmul only; the cache never holds it.',
              },
              {
                id: 'kv-heads',
                array: 'key/value heads · wk, wv',
                sub: '8 × 128 each · cached',
                cols: 8,
                tone: 'global',
                cells: 'index',
                marks: [0, 1, 2, 3, 4, 5, 6, 7].map(g => ({
                  cols: [g, g] as [number, number],
                  tone: g % 2 === 0 ? ('a' as const) : ('b' as const),
                })),
                detail:
                  'Only these are projected and cached: `wk` and `wv` are 4,096 × 1,024, a quarter of `wq`. MHA would have 32 here; MQA would have 1. The colours are the groups: KV head `g` and the four query heads that read it.',
              },
            ],
          },
          {
            id: 'cache',
            label: 'KV cache · one layer',
            sub: '[max_batch, max_seq, 8, 128] × 2',
            tone: 'global',
            layout: 'row',
            items: [
              {
                id: 'cache-k',
                array: 'cache_k[b]',
                sub: 'kv head × position',
                rows: 8,
                cols: 16,
                continues: true,
                marks: [
                  {cols: [0, 9], rows: [0, 7], tone: 'global', label: 'cached 0 … 9'},
                  {cols: [10, 10], rows: [0, 7], tone: 'c', label: 'new'},
                  {cols: [11, 15], rows: [0, 7], tone: 'muted', label: 'empty'},
                ],
                detail:
                  'Written at `[:bsz, start_pos : start_pos + seqlen]`, read at `[:bsz, : start_pos + seqlen]`; here `start_pos = 10` and one decode token. Each position (a column) holds 8 heads × 128 values: 2 KiB per layer for K in bf16.',
              },
              {
                id: 'cache-v',
                array: 'cache_v[b]',
                sub: 'same layout',
                rows: 8,
                cols: 16,
                continues: true,
                marks: [
                  {cols: [0, 9], rows: [0, 7], tone: 'global', label: 'cached 0 … 9'},
                  {cols: [10, 10], rows: [0, 7], tone: 'c', label: 'new'},
                  {cols: [11, 15], rows: [0, 7], tone: 'muted', label: 'empty'},
                ],
                detail:
                  'K and V together: 2 · 8 · 128 · 2 B = 4 KiB per token per layer, × 32 layers = 128 KiB per token for Llama 3 8B.',
              },
            ],
          },
        ],
        arrows: [{from: 'kv-heads', to: 'cache', label: 'rotated k, v at start_pos'}],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'The Llama 3 Herd of Models',
      url: 'https://arxiv.org/abs/2407.21783',
      by: 'Aaron Grattafiori et al.',
      date: '2024-07-31',
      venue: 'arXiv',
      takes:
        'The 8B configuration in `ModelArgs` (32 layers, 4,096 wide, 8 KV heads, 14,336 FFN, 128,256 tokens) and the RoPE base of 500,000.',
    },
    {
      kind: 'paper',
      title: 'GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints',
      url: 'https://arxiv.org/abs/2305.13245',
      by: 'Joshua Ainslie et al.',
      date: '2023-05-22',
      venue: 'EMNLP 2023',
      takes:
        'Grouped-query attention: `n_kv_heads` key/value heads shared by groups of query heads, which `repeat_kv` and the 128 KiB-per-token cache implement.',
    },
    {
      kind: 'paper',
      title: 'RoFormer: Enhanced Transformer with Rotary Position Embedding',
      url: 'https://arxiv.org/abs/2104.09864',
      by: 'Jianlin Su et al.',
      date: '2021-04-20',
      venue: 'Neurocomputing 2024',
      takes:
        'The rotation of adjacent pairs by `m · theta^(-2j/d)` that `precompute_rope` and `apply_rope` build, and the proof that `q·k` depends only on `m - n`.',
    },
    {
      kind: 'paper',
      title: 'GLU Variants Improve Transformer',
      url: 'https://arxiv.org/abs/2002.05202',
      by: 'Noam Shazeer',
      date: '2020-02-12',
      venue: 'arXiv',
      takes: 'SwiGLU, `w2(silu(w1(x)) * w3(x))`, and the 2/3 width that keeps three matrices at the cost of two.',
    },
    {
      kind: 'paper',
      title: 'Root Mean Square Layer Normalization',
      url: 'https://arxiv.org/abs/1910.07467',
      by: 'Biao Zhang and Rico Sennrich',
      date: '2019-10-16',
      venue: 'NeurIPS 2019',
      takes: 'The `RMSNorm` formula: scale by the root mean square, no re-centring and no bias.',
    },
    {
      kind: 'code',
      title: 'Llama Models',
      url: 'https://github.com/meta-llama/llama-models',
      by: 'Meta Llama',
      date: '2024-06-27',
      venue: 'GitHub',
      takes:
        "Meta's reference `models/llama3/model.py`: `apply_scaling` with its 8 / 1 / 4 / 8,192 constants, `repeat_kv`, the cache written at `start_pos`, the offset mask and the module names every step reuses.",
    },
  ],
  steps: [llamaLayersStep, llamaAttentionStep, llamaModelStep],
  learn,
};
