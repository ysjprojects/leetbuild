import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {gpt2ModelStep} from './steps/1-gpt2-model';
import {gpt2TrainStep} from './steps/2-gpt2-train';
import {gpt2GenerateStep} from './steps/3-gpt2-generate';

/**
 * Deep-learning problem: GPT-2 end to end in PyTorch, after nanoGPT — the model with a tied head and
 * residual-scaled init, the training loop (decay groups, warmup + cosine, clipping, bf16, checkpoints),
 * and sampling with temperature, top-k, nucleus and a per-block KV cache.
 */
export const ptGpt2Problem: Problem = {
  id: 'pt-gpt2',
  title: 'GPT-2 end to end: model, training loss, generation',
  tagline:
    'Write GPT-2 small as nanoGPT does — tied head, residual-scaled init, cross-entropy over every position — then train it with AdamW, warmup + cosine and bf16, and sample from it with top-k, nucleus and a KV cache.',
  difficulty: 'hard',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 90,
  statement: `# GPT-2 end to end: model, training loss, generation

GPT-2 (Radford et al., 2019) is the decoder-only Transformer every later LLM starts from: token and
learned position embeddings, a stack of pre-norm blocks of causal self-attention and a GELU MLP, a final
LayerNorm, and a vocabulary projection that shares its weight with the token table. It is trained on
one objective — predict every next token, cross-entropy at every position — and used by sampling one
token at a time. LLaMA, Mistral and GPT-4 change the parts (RMSNorm, rotary positions, SwiGLU,
grouped-query attention) but not the loop: embed, \`n_layer\` residual blocks, head, loss; warmup,
AdamW, clip; prefill, decode, sample.

You write three files after Karpathy's nanoGPT, each importing the previous one:

- \`gpt2_model.py\`: \`GPTConfig\` (\`vocab_size=50257\`, \`block_size=1024\`, \`n_layer=12\`, \`n_head=12\`,
  \`n_embd=768\`, \`dropout\`, \`bias\`), \`CausalSelfAttention\`, \`MLP\`, \`Block\`, and
  \`GPT.forward(idx (B, T) long, targets=None) -> (logits (B, T, V), loss | None)\` with
  \`lm_head.weight\` **the same tensor** as \`transformer.wte.weight\`, GPT-2's \`N(0, 0.02)\` init with
  \`c_proj\` weights at \`0.02 / sqrt(2 · n_layer)\`, and \`num_params()\` without the position table.
- \`gpt2_train.py\`: \`configure_optimizers(model, weight_decay, lr, betas)\`, \`get_batch(data,
  block_size, batch_size)\`, \`get_lr\`, \`estimate_loss\` and \`train(…)\` — AdamW with decay on matrices
  only, global-norm clipping at 1.0, linear warmup then cosine, bf16 autocast when the GPU has it, and
  checkpoints \`{model, optimizer, config, step}\`.
- \`gpt2_generate.py\`: \`generate(model, idx, max_new_tokens, temperature=1.0, top_k=None, top_p=None)\`
  and \`generate_cached(…)\` with a preallocated per-block KV cache that draws the same tokens as the
  uncached loop under the same seed.

## What you build here

1. **The model** — embeddings, causal attention with a \`tril\` mask, pre-norm blocks, the tied head,
   residual-scaled init, the loss over every position, the parameter count.
2. **Training** — parameter groups, random windows, warmup + cosine, clipping, bf16 autocast,
   evaluation without a graph, checkpoints; overfit a tiny sequence to prove the loop learns.
3. **Generation** — temperature, top-k, nucleus, the \`block_size\` crop, and a KV cache with prefill
   and one-token decode steps.

## Run it on your machine

Put the three files in one directory and run \`python gpt2_model.py\`, \`python gpt2_train.py\` and
\`python gpt2_generate.py\` (PyTorch ≥ 2.1, CPU is enough; each takes seconds). Each self-test prints
\`PASS\`: the model's against a manual log-softmax and the closed-form parameter count, training by
taking a periodic token stream from a loss near ln 16 to below 0.05, generation by matching cached and
uncached samples token for token.

## Left out on purpose

The BPE tokenizer (\`tiktoken\`), loading OpenAI's checkpoint (its \`Conv1D\` weights are transposed
relative to \`nn.Linear\`), \`F.scaled_dot_product_attention\` / FlashAttention, \`torch.compile\`,
gradient accumulation, DDP/FSDP, data loading from a memory-mapped token file, and serving concerns —
continuous batching, paged KV caches, speculative decoding.`,
  architecture: {
    input: 'Every effort moves you',
    output: 'next-token logits',
    items: [
      {
        id: 'tokens',
        label: 'Tokenized text',
        kind: 'io',
        sub: 'BPE ids',
        shape: '[B, T] int64',
        detail:
          'GPT-2 byte-level BPE: 50,257 token ids. Training windows come from `get_batch`; generation feeds the prompt plus every sampled id.',
      },
      {
        tone: 'model',
        items: [
          {
            id: 'wte',
            label: 'Token embedding layer',
            kind: 'embed',
            sub: 'wte · 50,257 × 768',
            shape: '[B, T, 768]',
            detail:
              'A lookup table: row `i` is token `i`’s vector. The same matrix is the output layer’s weight (tied), so 38.6 M parameters serve twice.',
          },
          {
            id: 'wpe',
            label: 'Positional embedding layer',
            kind: 'embed',
            sub: 'wpe · 1,024 × 768',
            shape: '[B, T, 768]',
            detail:
              'Learned absolute positions, added to the token vectors. Their 1,024 rows are the context length: a 1,025th position has no row.',
          },
          {id: 'drop0', label: 'Dropout', shape: '[B, T, 768]'},
          {
            tone: 'block',
            repeat: '12 ×',
            label: 'Transformer block',
            items: [
              {
                id: 'ln1',
                label: 'LayerNorm 1',
                kind: 'norm',
                detail:
                  'Pre-norm: the sublayer sees a normalised copy; the residual stream itself is never normalised inside the block.',
              },
              {
                id: 'attn',
                label: 'Masked multi-head attention',
                kind: 'attention',
                sub: '12 heads × 64',
                shape: '[B, T, 768]',
                detail:
                  'One fused `c_attn` projection to Q, K, V; 12 heads of 64 dims; a causal mask so position `t` sees `0..t`; `c_proj` back to 768. The KV cache keeps K and V for every past position.',
              },
              {id: 'drop1', label: 'Dropout'},
              {
                id: 'add1',
                op: '+',
                from: 'ln1',
                detail: '`x = x + attn(ln_1(x))`: the residual stream carries the input around the sublayer.',
              },
              {id: 'ln2', label: 'LayerNorm 2', kind: 'norm'},
              {
                id: 'mlp',
                label: 'Feed forward',
                kind: 'ffn',
                sub: '768 → 3,072 → 768',
                detail:
                  'Two linear layers with a GELU between, applied to every position independently: two thirds of the block’s parameters.',
              },
              {id: 'drop2', label: 'Dropout'},
              {id: 'add2', op: '+', from: 'ln2', detail: '`x = x + mlp(ln_2(x))`'},
            ],
          },
          {id: 'lnf', label: 'Final LayerNorm', kind: 'norm', shape: '[B, T, 768]'},
          {
            id: 'head',
            label: 'Linear output layer',
            kind: 'head',
            sub: '768 → 50,257 · tied to wte',
            shape: '[B, T, 50,257]',
            detail:
              'Logits for every position: training scores all T positions against the shifted targets with cross-entropy; generation reads only the last row.',
          },
        ],
      },
    ],
    notes: [
      {at: 'head', text: 'Vocabulary size of **50,257**'},
      {at: 'attn', text: '**12** heads of **64** dimensions'},
      {at: 'wpe', text: 'Context length of **1,024** tokens, learned absolute positions'},
      {at: 'wte', text: 'Embedding dimension of **768**', side: 'left'},
      {at: 'add1', text: 'Residual stream', side: 'left'},
    ],
    insets: [
      {
        for: 'mlp',
        title: 'Feed forward',
        items: [
          {id: 'fc', label: 'Linear layer', sub: 'c_fc · 768 → 3,072'},
          {id: 'gelu', label: 'GELU activation', sub: 'nn.GELU() · exact erf form'},
          {id: 'proj', label: 'Linear layer', sub: 'c_proj · 3,072 → 768'},
        ],
        note: 'Hidden layer dimension of **3,072**',
      },
    ],
  },
  steps: [gpt2ModelStep, gpt2TrainStep, gpt2GenerateStep],
  learn,
};
