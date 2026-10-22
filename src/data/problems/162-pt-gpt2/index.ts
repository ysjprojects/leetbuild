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
  diagram: {
    nodes: [
      {id: 'tokens', kind: 'client', label: 'Token ids', sub: 'get_batch windows · prompt + sampled ids', x: 8, y: 50},
      {id: 'embed', kind: 'db', label: 'wte + wpe', sub: 'token table (tied) · learned positions', x: 30, y: 25},
      {
        id: 'blocks',
        kind: 'service',
        label: 'Block × n_layer',
        sub: 'ln · causal attn · ln · MLP — KV cache per block',
        x: 55,
        y: 25,
      },
      {id: 'head', kind: 'service', label: 'ln_f · lm_head', sub: 'logits (B, T, V) → loss or sample', x: 80, y: 50},
      {
        id: 'train',
        kind: 'service',
        label: 'Training loop',
        sub: 'AdamW groups · clip 1.0 · warmup + cosine · bf16',
        x: 45,
        y: 80,
      },
    ],
    edges: [
      {from: 'tokens', to: 'embed', kind: 'plain', label: 'idx (B, T)'},
      {from: 'embed', to: 'blocks', kind: 'plain', label: 'x (B, T, d)'},
      {from: 'blocks', to: 'head', kind: 'plain', label: 'residual stream'},
      {from: 'head', to: 'embed', kind: 'plain', label: 'lm_head.weight = wte.weight'},
      {from: 'head', to: 'train', kind: 'plain', label: 'cross-entropy'},
      {from: 'head', to: 'tokens', kind: 'plain', label: 'multinomial → next id'},
    ],
  },
  steps: [gpt2ModelStep, gpt2TrainStep, gpt2GenerateStep],
  learn,
};
