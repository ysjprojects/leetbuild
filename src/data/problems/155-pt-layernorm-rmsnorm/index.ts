import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {normsStep} from './steps/1-norms';

/**
 * Drill: the two normalisations every transformer block applies to its residual stream — LayerNorm
 * (GPT-2, BERT) and RMSNorm (Llama, Mistral, Gemma) — written as nn.Modules from the statistics up,
 * with the float32 upcast that keeps a half-precision row from overflowing.
 */
export const ptLayernormRmsnormProblem: Problem = {
  id: 'pt-layernorm-rmsnorm',
  title: 'LayerNorm and RMSNorm from scratch',
  tagline:
    'Centre and scale a row with the biased variance, or scale it by its root mean square — eps under the root, rsqrt, and the statistic taken in float32 even when the model runs in bfloat16.',
  difficulty: 'easy',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 25,
  statement: `# LayerNorm and RMSNorm from scratch

A transformer block is a residual stream of shape \`(B, T, D)\` and two sublayers that read from it and
add back into it. Before each sublayer the row is **normalised**: every token's \`D\` features are
rescaled to a fixed magnitude, so the attention logits and the MLP's pre-activations see inputs of the
same size at layer 1 and layer 80, whatever the residual stream has accumulated. GPT-2 and BERT use
**LayerNorm** — subtract the row's mean, divide by its standard deviation, then a learned per-feature
scale and shift. Llama, Mistral, Gemma and Qwen use **RMSNorm** — skip the mean, divide by the root mean
square, one learned scale. Pre-norm placement (norm before the sublayer, not after) is what lets models
with a hundred blocks train without warm-up tricks.

Both are a handful of lines, and the lines are where the numerics live: the variance is biased, \`eps\`
goes inside the square root, the root is a reciprocal square root, and a \`bfloat16\` row is normalised in
\`float32\` and cast back.

The surface is two modules in \`norms.py\`:

- \`LayerNorm(normalized_shape, eps=1e-5)\` with parameters \`weight\` (ones) and \`bias\` (zeros) of
  \`normalized_shape\`; \`forward(x)\` normalises the trailing \`len(normalized_shape)\` dims and returns a
  tensor of \`x\`'s shape and dtype.
- \`RMSNorm(dim, eps=1e-6)\` with one parameter \`weight\` of shape \`(dim,)\`; \`forward(x)\` returns
  \`x · rsqrt(mean(x²) + eps) · weight\` over the last dim, the statistic in float32 for \`float16\`/\`bfloat16\`
  inputs and the result cast back to the input dtype.

## What you build here

1. \`LayerNorm\` and \`RMSNorm\` as \`nn.Module\`s with no call to \`nn.LayerNorm\`, \`F.layer_norm\` or
   \`F.rms_norm\` inside them, and the self-test that holds them against those references in float32,
   in \`bfloat16\` and \`float16\` (the upcast rule), and under \`gradcheck\` in float64.

## Run it on your machine

\`\`\`bash
python norms.py
\`\`\`

A passing run prints \`PASS\`. Needs PyTorch ≥ 2.4 (\`F.rms_norm\`); CPU is enough. The starter raises
\`NotImplementedError\` at the first \`LayerNorm(D)\`.

## Left out on purpose

The hand-written backward (autograd derives it; the fused kernels in \`F.layer_norm\` write it by hand),
the fused residual-add-plus-norm kernels inference engines use, QK-norm inside attention, Gemma's
\`(1 + weight)\` parameterisation, and \`elementwise_affine=False\`. The two modules here are the shape
every one of those starts from.`,
  diagram: {
    nodes: [
      {id: 'x', kind: 'client', label: 'residual stream', sub: 'x (B, T, D) · float32 | bfloat16', x: 8, y: 50},
      {id: 'ln', kind: 'service', label: 'LayerNorm', sub: '(x − mean) · rsqrt(var + eps)', x: 36, y: 26},
      {
        id: 'rms',
        kind: 'service',
        label: 'RMSNorm',
        sub: 'x.float() · rsqrt(mean(x²) + eps) → type_as(x)',
        x: 36,
        y: 74,
      },
      {id: 'params', kind: 'db', label: 'parameters', sub: 'weight (ones) · bias (zeros)', x: 64, y: 50},
      {
        id: 'ref',
        kind: 'external',
        label: 'torch.nn.functional',
        sub: 'layer_norm · rms_norm · gradcheck',
        x: 90,
        y: 50,
      },
    ],
    edges: [
      {from: 'x', to: 'ln', kind: 'plain', label: 'forward(x)'},
      {from: 'x', to: 'rms', kind: 'plain', label: 'forward(x)'},
      {from: 'ln', to: 'params', kind: 'plain', label: '· weight + bias'},
      {from: 'rms', to: 'params', kind: 'plain', label: '· weight'},
      {from: 'params', to: 'ref', kind: 'plain', label: 'allclose · gradcheck'},
    ],
  },
  steps: [normsStep],
  learn,
};
