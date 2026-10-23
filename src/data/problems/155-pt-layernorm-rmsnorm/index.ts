import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {normsStep} from './steps/1-norms';

/**
 * Drill: the two normalisations every transformer block applies to its residual stream, LayerNorm
 * (GPT-2, BERT) and RMSNorm (Llama, Mistral, Gemma), written as nn.Modules from the statistics up,
 * with the float32 upcast that keeps a half-precision row from overflowing.
 */
export const ptLayernormRmsnormProblem: Problem = {
  id: 'pt-layernorm-rmsnorm',
  title: 'LayerNorm and RMSNorm from scratch',
  tagline:
    'Centre and scale a row with the biased variance, or scale it by its root mean square: eps under the root, rsqrt, and the statistic taken in float32 even when the model runs in bfloat16.',
  difficulty: 'easy',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 25,
  statement: `# LayerNorm and RMSNorm from scratch

A transformer block is a residual stream of shape \`(B, T, D)\` and two sublayers that read from it and
add back into it. Before each sublayer the row is **normalised**: every token's \`D\` features are
rescaled to a fixed magnitude, so the attention logits and the MLP's pre-activations see inputs of the
same size at layer 1 and layer 80, whatever the residual stream has accumulated. GPT-2 and BERT use
**LayerNorm**: subtract the row's mean, divide by its standard deviation, then a learned per-feature
scale and shift. Llama, Mistral, Gemma and Qwen use **RMSNorm**: skip the mean, divide by the root mean
square, one learned scale. Pre-norm placement (norm before the sublayer, not after) keeps the gradients
of a deep stack well scaled at initialisation, which is why every current LLM uses it.

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
  figures: [
    {
      title: 'LayerNorm and RMSNorm',
      architecture: {
        input: 'x · (B, T, D) · float32 or bfloat16',
        output: 'x + sublayer(norm(x))',
        items: [
          {
            id: 'stream',
            label: 'Residual stream',
            sub: 'x · one D-vector per token',
            kind: 'io',
            shape: '[B, T, D]',
            detail:
              'Every block reads from it and adds into it, so its rows grow with depth. The norm acts on each of the `B × T` rows on its own; the reduction is over `D` only.',
          },
          {
            columns: [
              [
                {
                  tone: 'dotted',
                  label: 'LayerNorm · GPT-2, BERT',
                  items: [
                    {
                      id: 'ln-mean',
                      label: 'Row mean',
                      sub: 'μ = x.mean(-1, keepdim)',
                      shape: '[B, T, 1]',
                      detail:
                        '`keepdim=True` keeps the reduced axis as size 1 so `x − μ` broadcasts back over the row.',
                    },
                    {
                      id: 'ln-var',
                      label: 'Biased variance',
                      sub: 'σ² = x.var(unbiased=False)',
                      shape: '[B, T, 1]',
                      detail:
                        'Divide by `D`, not `D − 1`: Bessel’s correction shrinks the normalised row by a factor `sqrt(D / (D − 1))`, 0.8% at `D = 64`.',
                    },
                    {
                      id: 'ln-scale',
                      label: 'Centre and scale',
                      sub: '(x − μ) · rsqrt(σ² + 1e-5)',
                      detail:
                        '`eps` keeps a constant row (σ² = 0) finite: without it the row is `0 · rsqrt(0) = 0 · ∞ = NaN`. Inside the root it floors σ at `√eps`, as `F.layer_norm` does. One `rsqrt` per row, then a multiply per element.',
                    },
                    {
                      id: 'ln-affine',
                      label: 'Affine map',
                      sub: '· weight + bias · (D,) each',
                      shape: '[B, T, D]',
                      detail:
                        '`weight` starts at ones and `bias` at zeros: the identity at initialisation, 2·D parameters.',
                    },
                  ],
                },
              ],
              [
                {
                  tone: 'dotted',
                  label: 'RMSNorm · Llama, Mistral',
                  items: [
                    {
                      id: 'rms-up',
                      label: 'Upcast',
                      sub: 'xf = x.float() if 16-bit',
                      detail:
                        'Only `float16`/`bfloat16` are upcast. A float64 input stays float64, which is what lets `gradcheck` see the real Jacobian.',
                    },
                    {
                      id: 'rms-ms',
                      label: 'Mean of squares',
                      sub: 'mean(xf²) · no centring',
                      shape: '[B, T, 1]',
                      detail:
                        '`mean(x²) = σ² + μ²`: one reduction instead of two, and the row is not moved to zero mean.',
                    },
                    {
                      id: 'rms-scale',
                      label: 'Scale',
                      sub: 'xf · rsqrt(ms + 1e-6)',
                      detail: 'The row now has unit root mean square, every value of order 1.',
                    },
                    {
                      id: 'rms-cast',
                      label: 'Cast back',
                      sub: '.type_as(x)',
                      detail:
                        'Before the weight multiply, so the output keeps the input dtype and the next matmul runs in it.',
                    },
                    {
                      id: 'rms-weight',
                      label: 'Scale by weight',
                      sub: '· weight (D,) · no bias',
                      shape: '[B, T, D]',
                      detail: 'One parameter of ones, D values per layer.',
                    },
                  ],
                },
              ],
            ],
          },
          {
            id: 'sublayer',
            label: 'Attention or MLP',
            kind: 'attention',
            sub: 'reads the normalised row',
            shape: '[B, T, D]',
            detail:
              'Either norm feeds the sublayer: GPT-2 uses the left path, Llama the right. Same input magnitude at layer 1 and layer 80.',
          },
          {
            id: 'add',
            op: '+',
            from: 'stream',
            detail:
              'Pre-norm: `x = x + sublayer(norm(x))`. The residual carries the un-normalised `x` around the norm.',
          },
        ],
        notes: [
          {at: 'ln-var', text: 'Divide by **D**, not D − 1', side: 'left'},
          {at: 'ln-scale', text: '**eps** under the root: a flat row gives bias, not NaN', side: 'left'},
          {at: 'rms-up', text: 'fp16 x² overflows at **|x| ≥ 256**'},
          {at: 'rms-ms', text: '**1** reduction instead of 2'},
          {at: 'add', text: 'Pre-norm: the stream itself is never normalised'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Layer Normalization',
      url: 'https://arxiv.org/abs/1607.06450',
      by: 'Jimmy Lei Ba, Jamie Ryan Kiros and Geoffrey E. Hinton',
      date: '2016-07-21',
      venue: 'arXiv',
      takes:
        "`LayerNorm`: the mean and variance of one row's own `D` features, then the learned per-feature `weight` and `bias`.",
    },
    {
      kind: 'paper',
      title: 'Root Mean Square Layer Normalization',
      url: 'https://arxiv.org/abs/1910.07467',
      by: 'Biao Zhang and Rico Sennrich',
      date: '2019-10-16',
      venue: 'NeurIPS 2019',
      takes:
        '`RMSNorm`: drop the mean, divide by the root mean square, keep one learned scale, since re-scaling invariance does the work.',
    },
    {
      kind: 'paper',
      title: 'On Layer Normalization in the Transformer Architecture',
      url: 'https://arxiv.org/abs/2002.04745',
      by: 'Ruibin Xiong et al.',
      date: '2020-02-12',
      venue: 'ICML 2020',
      takes:
        'Why the norm sits before each sublayer: at initialisation post-norm gradients near the output are large and need a learning-rate warm-up, pre-norm ones are well behaved.',
    },
    {
      kind: 'code',
      title: 'rmsnorm',
      url: 'https://github.com/bzhangGo/rmsnorm',
      by: 'Biao Zhang',
      date: '2019-09-24',
      venue: 'GitHub',
      takes: "The authors' RMSNorm implementations, the formula `RMSNorm.forward` reproduces.",
    },
    {
      kind: 'code',
      title: 'llama/model.py',
      url: 'https://github.com/meta-llama/llama/blob/v2/llama/model.py',
      by: 'Meta',
      date: '2023-09-01',
      venue: 'GitHub',
      takes:
        "Llama's `RMSNorm`: `x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps)` on `x.float()`, cast back with `type_as(x)`, the upcast rule the drill tests in `bfloat16`.",
    },
    {
      kind: 'docs',
      title: 'torch.nn.LayerNorm',
      url: 'https://docs.pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html',
      venue: 'PyTorch documentation',
      takes:
        'The reference definition the module matches: the biased variance, `eps` inside the square root, `normalized_shape` as the trailing dims.',
    },
  ],
  steps: [normsStep],
  learn,
};
