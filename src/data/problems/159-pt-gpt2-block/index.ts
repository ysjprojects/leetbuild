import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {gpt2BlockStep} from './steps/1-gpt2-block';

/**
 * Deep-learning drill: the layer GPT-2 stacks twelve to forty-eight times — pre-LayerNorm, a residual
 * around causal attention and around a 4× GELU MLP, and the initialisation (N(0, 0.02), zero biases,
 * unit LayerNorms, residual projections scaled by 1/√(2·n_layer)) that lets the stack train.
 */
export const ptGpt2BlockProblem: Problem = {
  id: 'pt-gpt2-block',
  title: 'A GPT-2 transformer block',
  tagline:
    'Pre-LN, two residuals, a 4× MLP with the tanh GELU, and the init GPT-2 ships with — one Block that a model repeats n_layer times.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 40,
  statement: `# A GPT-2 transformer block

A decoder-only language model is an embedding, \`n_layer\` copies of one block, a final LayerNorm and an
unembedding. Everything the model learns about language lives in the blocks, and every block is the same
two sentences: *read the context* (causal self-attention) and *think about each position* (a two-layer
MLP), each applied to a normalised copy of the residual stream and added back. GPT-2 (2019) fixed the
form that Llama, Mistral and the GPT-4 family still use: **pre-LayerNorm**, a **4× hidden MLP** with
**GELU**, and an initialisation whose one non-obvious rule — shrink the projections that write into the
residual stream by \`1/√(2·n_layer)\` — is what lets forty-eight of them train in a stack.

The surface, over a \`GPTConfig(n_embd, n_head, n_layer, block_size, dropout)\`:

- \`gelu_tanh(x) -> Tensor\`: \`0.5 · x · (1 + tanh(√(2/π) · (x + 0.044715 · x³)))\`, element-wise.
- \`class MLP(nn.Module)\`: \`c_fc: Linear(C, 4C)\`, \`c_proj: Linear(4C, C)\`, \`dropout\`;
  \`forward(x: (B, T, C)) -> (B, T, C)\`.
- \`class Block(nn.Module)\`: \`ln_1\`, \`attn\` (a \`CausalSelfAttention\`, given), \`ln_2\`, \`mlp\`;
  \`forward(x: (B, T, C)) -> (B, T, C)\` is \`x = x + attn(ln_1(x)); x = x + mlp(ln_2(x))\`;
  \`__init__\` applies GPT-2's init: linears \`N(0, 0.02)\`, biases \`0\`, LayerNorm weight \`1\` / bias \`0\`,
  then every \`c_proj.weight\` re-drawn at \`std = 0.02 / √(2·n_layer)\`.

Float32 throughout; the gradient check runs the MLP in float64.

## What you build here

1. \`gelu_tanh\`, \`MLP\` and \`Block\` with its \`_init_weights\`, against a self-test that compares the block to a
   functional reference built on \`F.scaled_dot_product_attention(is_causal=True)\` and
   \`F.gelu(approximate="tanh")\`, checks causality, the residual identity with both \`c_proj\` zeroed, the
   init statistics on a 256-wide block, and \`torch.autograd.gradcheck\` of the MLP.

## Run it on your machine

\`python gpt2_block.py\` with PyTorch 2.x (CPU is enough; it takes a second). A passing run prints \`PASS\`;
the starter raises \`NotImplementedError\` at the first assertion, and each wrong piece trips the assertion
named after it (\`"reference"\` for post-LN, \`"residual identity"\` for adding the normalised stream,
\`"c_proj std"\` for a missing or overwritten scaling).

## Left out on purpose

The attention itself (given here; its own problem), the embeddings, the final LayerNorm and the tied
unembedding, weight decay groups and the optimiser, the KV cache, FlashAttention, mixed precision and
\`torch.compile\`. The block is the unit; the model is a \`nn.ModuleList\` of it.`,
  figures: [
    {
      title: 'GPT-2 block',
      architecture: {
        input: 'from the embedding or the block below',
        output: 'to the next block, or ln_f',
        items: [
          {
            id: 'x-in',
            label: 'Residual stream',
            kind: 'io',
            sub: 'x · C = n_embd = 64',
            shape: '[2, 16, 64]',
            detail:
              'One vector per position, only ever added to: the self-test feeds `B = 2`, `T = 16` at `n_embd = 64`, float32.',
          },
          {
            tone: 'block',
            repeat: '12 ×',
            label: 'Block · gpt2_block.py',
            items: [
              {
                id: 'ln1',
                label: 'LayerNorm ln_1',
                kind: 'norm',
                sub: 'nn.LayerNorm(64) · γ = 1, β = 0',
                shape: '[2, 16, 64]',
                detail:
                  'Pre-LN: a normalised copy for the attention to read. The stream `x` itself is not touched; `ln_1(x + …)` (post-LN) fails the reference.',
              },
              {
                id: 'attn',
                label: 'Causal self-attention',
                kind: 'attention',
                sub: '4 heads × 16 · given',
                shape: '[2, 16, 64]',
                side: {
                  label: 'tril mask',
                  sub: 'block_size 32',
                  detail:
                    'A non-persistent `(1, 1, 32, 32)` boolean buffer; future scores become `-inf` before the softmax.',
                },
                detail:
                  '`c_attn` 64 → 192 splits into q, k, v; scores `q @ kᵀ / √16`, masked, softmax, `@ v`; `c_proj` 64 → 64 and `resid_dropout`. Given in the file; its `c_proj.weight` takes the rescaled init too.',
              },
              {
                id: 'add1',
                op: '+',
                from: 'ln1',
                detail: '`x = x + attn(ln_1(x))`: with `attn.c_proj` zeroed this adds exactly zero.',
              },
              {
                id: 'ln2',
                label: 'LayerNorm ln_2',
                kind: 'norm',
                sub: 'nn.LayerNorm(64) · γ = 1, β = 0',
                shape: '[2, 16, 64]',
                detail: 'The MLP’s normalised copy of the stream, after the attention’s write.',
              },
              {
                id: 'mlp',
                label: 'MLP',
                kind: 'ffn',
                sub: '64 → 256 → 64',
                shape: '[2, 16, 64]',
                detail:
                  '`c_fc` to `4 · n_embd`, `gelu_tanh`, `c_proj` back, dropout; each position on its own. 33,088 of the block’s 49,984 parameters.',
              },
              {
                id: 'add2',
                op: '+',
                from: 'ln2',
                detail: '`x = x + mlp(ln_2(x))`: the second write into the stream.',
              },
            ],
          },
          {
            id: 'x-out',
            label: 'Residual stream',
            kind: 'io',
            sub: 'x + attn(…) + mlp(…)',
            shape: '[2, 16, 64]',
            detail:
              'Same shape as the input: the block is a function from the stream to the stream, stacked `n_layer` times.',
          },
        ],
        notes: [
          {at: 'attn', text: 'c_proj std **0.02 / √24 ≈ 0.0041**'},
          {at: 'mlp', text: '**2/3** of the block’s **49,984** parameters', side: 'left'},
          {at: 'ln1', text: 'Pre-LN: normalise the **input**, add to the raw stream'},
          {at: 'add1', text: 'Residual stream, never normalised', side: 'left'},
        ],
        insets: [
          {
            for: 'mlp',
            title: 'MLP',
            items: [
              {id: 'c-fc', label: 'Linear c_fc', sub: '64 → 256 · N(0, 0.02)', shape: '[2, 16, 256]'},
              {
                id: 'gelu',
                label: 'gelu_tanh',
                sub: 'tanh(√(2/π)(x + 0.044715x³))',
                detail: 'Written out with `torch.tanh`; held to `F.gelu(approximate="tanh")` at `1e-12` in float64.',
              },
              {id: 'c-proj', label: 'Linear c_proj', sub: '256 → 64 · N(0, 0.02/√24)', shape: '[2, 16, 64]'},
              {id: 'mlp-drop', label: 'Dropout', sub: 'cfg.dropout = 0.0'},
            ],
            note: 'Hidden width **4 × 64 = 256**; linears **N(0, 0.02)**, biases **0**',
          },
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Language Models are Unsupervised Multitask Learners',
      url: 'https://cdn.openai.com/better-language-models/language_models_are_unsupervised_multitask_learners.pdf',
      by: 'Alec Radford et al.',
      date: '2019-02-14',
      venue: 'OpenAI technical report',
      takes:
        "GPT-2's block: LayerNorm moved to the input of each sub-block, and residual-layer weights scaled at initialisation by `1/√N`, the `0.02 / √(2·n_layer)` on every `c_proj`.",
    },
    {
      kind: 'paper',
      title: 'Gaussian Error Linear Units (GELUs)',
      url: 'https://arxiv.org/abs/1606.08415',
      by: 'Dan Hendrycks and Kevin Gimpel',
      date: '2016-06-27',
      venue: 'arXiv',
      takes:
        'GELU `x · Φ(x)` and its tanh approximation `0.5 · x · (1 + tanh(√(2/π) · (x + 0.044715 · x³)))`, which `gelu_tanh` computes.',
    },
    {
      kind: 'paper',
      title: 'On Layer Normalization in the Transformer Architecture',
      url: 'https://arxiv.org/abs/2002.04745',
      by: 'Ruibin Xiong et al.',
      date: '2020-02-12',
      venue: 'ICML 2020',
      takes:
        'Why `x = x + attn(ln_1(x))` and not post-LN: pre-LN gradients at initialisation stay well behaved, so the block stacks without a warm-up crutch.',
    },
    {
      kind: 'code',
      title: 'gpt-2',
      url: 'https://github.com/openai/gpt-2',
      by: 'OpenAI',
      date: '2019-02-11',
      venue: 'GitHub',
      takes:
        "OpenAI's released TensorFlow model: the pre-LN block, `c_fc`/`c_proj` names and the tanh GELU the drill keeps.",
    },
    {
      kind: 'code',
      title: 'nanoGPT',
      url: 'https://github.com/karpathy/nanoGPT',
      by: 'Andrej Karpathy',
      date: '2022-12-28',
      venue: 'GitHub',
      takes:
        'The same `Block`, `MLP` and `_init_weights` in PyTorch, including the `c_proj.weight` re-draw at `std = 0.02 / √(2·n_layer)`.',
    },
  ],
  steps: [gpt2BlockStep],
  learn,
};
