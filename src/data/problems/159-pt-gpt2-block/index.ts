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
  track: 'dl',
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
  diagram: {
    nodes: [
      {id: 'x', kind: 'client', label: 'residual stream', sub: 'x · (B, T, C) · float32', x: 10, y: 50},
      {id: 'attn', kind: 'service', label: 'ln_1 → attn → + x', sub: 'causal self-attention (given)', x: 35, y: 30},
      {
        id: 'mlp',
        kind: 'service',
        label: 'ln_2 → mlp → + x',
        sub: 'c_fc 4C · gelu_tanh · c_proj · dropout',
        x: 60,
        y: 30,
      },
      {
        id: 'params',
        kind: 'db',
        label: 'parameters',
        sub: 'N(0, 0.02) · c_proj ÷ √(2·n_layer) · LN = 1, 0',
        x: 48,
        y: 75,
      },
      {
        id: 'ref',
        kind: 'external',
        label: 'self-test',
        sub: 'SDPA(is_causal) · F.gelu(tanh) · gradcheck',
        x: 85,
        y: 50,
      },
    ],
    edges: [
      {from: 'x', to: 'attn', kind: 'plain', label: 'x'},
      {from: 'attn', to: 'mlp', kind: 'plain', label: 'x + a'},
      {from: 'params', to: 'attn', kind: 'plain', label: 'c_attn · c_proj · ln_1'},
      {from: 'params', to: 'mlp', kind: 'plain', label: 'c_fc · c_proj · ln_2'},
      {from: 'mlp', to: 'ref', kind: 'plain', label: 'allclose · equal'},
    ],
  },
  steps: [gpt2BlockStep],
  learn,
};
