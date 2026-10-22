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
  diagram: {
    nodes: [
      {id: 'loop', kind: 'client', label: 'Training loop', sub: 'zero_grad · backward · step(closure)', x: 10, y: 50},
      {
        id: 'optim',
        kind: 'service',
        label: 'AdamW.step()',
        sub: 'decay · moments · bias-correct · update',
        x: 40,
        y: 50,
      },
      {id: 'params', kind: 'db', label: 'Parameters', sub: 'p · p.grad', x: 70, y: 25},
      {
        id: 'state',
        kind: 'db',
        label: 'self.state[p]',
        sub: 'step · exp_avg · exp_avg_sq · max_exp_avg_sq',
        x: 70,
        y: 75,
      },
      {id: 'ref', kind: 'external', label: 'torch.optim.AdamW', sub: 'same model copy · allclose 1e-7', x: 40, y: 90},
    ],
    edges: [
      {from: 'loop', to: 'optim', kind: 'plain', label: 'step(closure)'},
      {from: 'optim', to: 'params', kind: 'plain', label: 'read grad · mul_ · addcdiv_'},
      {from: 'optim', to: 'state', kind: 'plain', label: 'create once · update in place'},
      {from: 'loop', to: 'ref', kind: 'plain', label: 'same batch, compare every step'},
    ],
  },
  steps: [adamwStep],
  learn,
};
