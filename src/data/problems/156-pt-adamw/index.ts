import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {adamwStep} from './steps/1-adamw';

/**
 * Deep-learning drill: AdamW as a `torch.optim.Optimizer` subclass — lazily created per-parameter
 * state, bias-corrected first and second moments, decoupled weight decay applied to the parameter
 * rather than the gradient, optional AMSGrad — matched step by step against `torch.optim.AdamW`.
 */
export const ptAdamwProblem: Problem = {
  id: 'pt-adamw',
  title: 'AdamW: bias-corrected moments and decoupled weight decay',
  tagline:
    'Subclass torch.optim.Optimizer: lazy state, EMAs of g and g², bias correction from the step count, weight decay on the parameter — and match torch.optim.AdamW to 1e-7.',
  difficulty: 'medium',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 45,
  statement: `# AdamW: bias-corrected moments and decoupled weight decay

Every frontier language model — GPT, LLaMA, Mistral, Gemma — is trained with AdamW. Adam keeps two
exponential moving averages per parameter: the gradient \`m\` and the squared gradient \`v\`, and moves
each weight by \`m / (√v + ε)\`, so every coordinate gets its own step size. Both averages start at zero
and are biased towards zero for the first few hundred steps; dividing by \`1 − β^t\` corrects that. AdamW
(Loshchilov & Hutter, 2019) changes one thing: weight decay is **decoupled** — the parameter is shrunk
by \`lr × wd\` directly, instead of adding \`wd × p\` to the gradient where Adam's normalisation would
scale it away for weights with large gradients.

The surface is one class, \`AdamW(torch.optim.Optimizer)\`, with the reference's signature:
\`AdamW(params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=1e-2, amsgrad=False)\` and
\`step(closure=None)\`. Per-parameter state lives in \`self.state[p]\` and is created the first time
\`step\` sees the parameter: \`step\` (an \`int\`), \`exp_avg\`, \`exp_avg_sq\`, and \`max_exp_avg_sq\` only
when \`amsgrad\`. Parameters are updated **in place** under \`@torch.no_grad()\`; a parameter whose
\`grad is None\` is skipped; a sparse gradient raises \`RuntimeError\`.

## What you build here

1. \`AdamW.step\`: the closure, the lazy state, \`p.mul_(1 - lr * weight_decay)\` before the update,
   the two moments, bias correction \`1 − β1^t\` / \`1 − β2^t\` from \`state["step"]\`, \`√v̂ + ε\` with
   \`eps\` added **after** the square root, the AMSGrad running maximum, and
   \`p.addcdiv_(exp_avg, denom, value=-step_size)\`.

## Run it on your machine

\`python adamw.py\` — the self-test trains two copies of a small \`float64\` MLP for 25 steps, one with
your optimizer and one with \`torch.optim.AdamW\`, with and without \`amsgrad\`, and asserts every
parameter and every moment agrees after every step (\`torch.allclose(atol=1e-7)\`). It then checks that a
frozen parameter is skipped and gets no state, that \`step(closure)\` returns the loss, and that a sparse
gradient is rejected. A passing run prints \`PASS\`.

## Left out on purpose

Parameter groups with different hyper-parameters (the reference loops over \`self.param_groups\` and so
do you, but the test uses one), \`maximize\`, \`foreach\`/\`fused\` multi-tensor kernels, \`capturable\`
CUDA-graph state, learning-rate schedules, gradient clipping, and ZeRO-style sharding of the optimizer
state across devices.`,
  figures: [
    {
      title: 'One AdamW step',
      architecture: {
        input: 'MLP params · lr = 1e-2 · wd = 0.1',
        items: [
          {
            tone: 'block',
            repeat: 'for each step',
            label: 'Training loop',
            items: [
              {
                id: 'backward',
                label: 'loss.backward()',
                sub: 'mse_loss(model(x), y) → p.grad',
                kind: 'loss',
                detail:
                  'The self-test’s float64 MLP, 8 → 16 → 4. A frozen parameter keeps `grad = None` and is skipped; a sparse gradient raises `RuntimeError`.',
              },
              {
                tone: 'dotted',
                label: 'AdamW.step() · each p with a grad',
                items: [
                  {
                    id: 'grad',
                    label: 'Gradient g_t',
                    sub: 'g = p.grad · skip if None',
                    kind: 'io',
                    shape: 'same shape as p',
                    detail:
                      'Read inside `for group in self.param_groups: for p in group["params"]`, with `lr`, `betas`, `eps`, `weight_decay`, `amsgrad` from `group`.',
                  },
                  {
                    id: 'count',
                    label: 'Step count t',
                    sub: 'state["step"] += 1',
                    kind: 'memory',
                    side: {
                      label: 'self.state[p]',
                      sub: 'created on first sight',
                      detail:
                        'Empty until `step` first meets `p` with a gradient; then `step = 0`, `exp_avg` and `exp_avg_sq` as `zeros_like(p)`, and `max_exp_avg_sq` only when `amsgrad`.',
                    },
                    detail: 'A Python `int` per parameter; the bias correction reads it as the exponent `t`.',
                  },
                  {
                    columns: [
                      [
                        {
                          id: 'm',
                          label: 'First moment m_t',
                          sub: 'm = β₁m + (1 − β₁)g',
                          kind: 'memory',
                          shape: 'same shape as p',
                          detail:
                            '`exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)`: an EMA of the gradient, momentum. In place, so `state_dict()` keeps pointing at it.',
                        },
                      ],
                      [
                        {
                          id: 'v',
                          label: 'Second moment v_t',
                          sub: 'v = β₂v + (1 − β₂)g²',
                          kind: 'memory',
                          shape: 'same shape as p',
                          detail:
                            '`exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)`: an EMA of the squared gradient, so `√v` is each coordinate’s gradient scale.',
                        },
                        {
                          id: 'amsgrad',
                          label: 'AMSGrad running max',
                          sub: 'only when amsgrad=True',
                          kind: 'memory',
                          detail:
                            '`torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)`, then used in place of `exp_avg_sq`: the per-coordinate step can only shrink.',
                        },
                      ],
                    ],
                  },
                  {
                    id: 'bias',
                    label: 'Bias correction',
                    sub: 'bc1 = 1 − β₁ᵗ · bc2 = 1 − β₂ᵗ',
                    detail:
                      'Both moments start at zero and are biased towards it. `step_size = lr / bc1`; `bc2` divides `v` under the root. Without it step 1 moves about 3.2 × too far.',
                  },
                  {
                    id: 'denom',
                    label: 'Denominator',
                    sub: '√v / √bc2 + eps',
                    detail:
                      '`(exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)`: `eps` after the square root. Inside it, `√(v + 1e-8)` would floor the denominator at 1e-4.',
                  },
                  {
                    id: 'decay',
                    label: 'Decoupled weight decay',
                    sub: 'p.mul_(1 − lr·wd)',
                    kind: 'attention',
                    detail:
                      'The one change from Adam: the weight shrinks by `lr · wd` directly, outside `m / √v`. The reference does it first, before the moments; neither moment reads `p`, so the result is the same.',
                  },
                  {
                    id: 'update',
                    label: 'Adam update',
                    sub: 'p.addcdiv_(m, denom, −lr/bc1)',
                    detail:
                      '`p.addcdiv_(exp_avg, denom, value=-step_size)`: `p ← p − (lr / bc1) · m / denom`, in place under `@torch.no_grad()`.',
                  },
                ],
              },
            ],
          },
          {
            id: 'trained',
            label: 'Trained parameters',
            sub: 'p after 25 steps',
            kind: 'io',
            detail:
              'Every parameter and both moments match `torch.optim.AdamW` after every step, with and without `amsgrad` (`atol=1e-7`, float64).',
          },
        ],
        notes: [
          {at: 'v', text: 'Two fp32 moments: **8** bytes per parameter'},
          {at: 'bias', text: 'Uncorrected step 1 is **3.2 ×** too large'},
          {at: 'denom', text: 'eps = **1e-8**, added after the root'},
          {at: 'decay', text: 'The same **lr · wd** shrink for every weight'},
          {at: 'trained', text: 'Within **1e-7** of torch.optim.AdamW'},
        ],
      },
    },
  ],
  steps: [adamwStep],
  learn,
};
