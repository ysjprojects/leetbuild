import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {sgdMomentumStep} from './steps/1-sgd-momentum';

/**
 * Drill: SGD with momentum, Nesterov and decoupled weight decay as a `torch.optim.Optimizer` — the
 * loop over `param_groups`, the lazily created `state[p]` buffer, in-place `mul_`/`add_` under
 * `no_grad`, the closure — checked step by step against `torch.optim.SGD` and by hand.
 */
export const ptSgdMomentumProblem: Problem = {
  id: 'pt-sgd-momentum',
  title: 'SGD with momentum, Nesterov and decoupled weight decay',
  tagline:
    'A torch.optim.Optimizer from scratch: param groups, a lazy momentum buffer in state[p], in-place updates under no_grad, a closure — matching torch.optim.SGD step for step.',
  difficulty: 'easy',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 25,
  statement: `# SGD with momentum, Nesterov and decoupled weight decay

Every training loop ends the same way: \`loss.backward()\` fills \`p.grad\`, and an optimizer turns those
gradients into new parameters. Stochastic gradient descent with **momentum** — keep a running sum of
gradients and step along it — trained every ResNet and still trains vision and speech models; the
**Nesterov** variant steps along the gradient plus the momentum, a look-ahead that Sutskever et al. showed
matters for deep nets. **Decoupled weight decay** — shrink the weight directly instead of adding \`wd · p\`
to the gradient — is the "W" of AdamW, the optimizer behind GPT, Llama and nearly every LLM; it was
introduced on SGD first (SGDW) and is cleanest to see there.

All of them, and Adam, Lion, Muon and Shampoo, share one contract: \`torch.optim.Optimizer\`. It owns the
\`param_groups\` (each with its own hyper-parameters), a \`state\` dict keyed by parameter that
\`state_dict()\` checkpoints, \`zero_grad()\`, and a \`step(closure=None)\` the subclass fills in. This drill
is that subclass.

The surface is one class:

- \`SGD(params, lr=1e-2, momentum=0.0, nesterov=False, weight_decay=0.0)\`, a \`torch.optim.Optimizer\`.
- \`step(closure=None)\` under \`@torch.no_grad()\`: for every parameter \`p\` with a gradient \`g\`, in place,
  \`p ← p · (1 − lr · wd)\`; \`buf ← momentum · buf + g\` with \`buf = state[p]["momentum_buffer"]\` created on
  first use as a clone of \`g\`; \`d = g + momentum · buf\` if Nesterov else \`buf\`; \`p ← p − lr · d\`. A
  parameter with \`grad is None\` is skipped. Any dtype, any shape — the update is elementwise.

## What you build here

1. \`SGD.step()\`: the decoupled decay, the lazy in-place momentum buffer, the Nesterov look-ahead, the
   in-place update with \`add_(…, alpha=-lr)\`, the closure — matching \`torch.optim.SGD\` (\`weight_decay=0\`)
   after every one of 25 steps, and the decoupled step checked by hand.

## Run it on your machine

\`\`\`bash
python sgd_momentum.py
\`\`\`

It needs PyTorch 2.x on a CPU (no GPU required). A passing run prints \`PASS\`; a failing one stops at the
first \`AssertionError\` with the configuration that diverged.

## Left out on purpose

\`dampening\`, \`maximize\`, the \`foreach\` and \`fused\` multi-tensor paths, learning-rate schedulers,
gradient clipping, \`add_param_group\` with per-group overrides (inherited and unused), and sharding the
optimizer state across devices.`,
  architecture: {
    input: 'params, lr = 0.02, μ = 0.9',
    items: [
      {
        tone: 'block',
        repeat: 'for each step',
        label: 'Training loop',
        items: [
          {
            id: 'backward',
            label: 'loss.backward()',
            sub: '0.5·‖A w + c − b‖² → p.grad',
            kind: 'loss',
            detail:
              'The self-test’s quadratic. Autograd fills `p.grad` for every parameter the loss touched; a third parameter never gets one and stays `None`.',
          },
          {
            tone: 'dotted',
            label: 'SGD.step() · each p with a grad',
            items: [
              {
                id: 'grad',
                label: 'Gradient g',
                sub: 'g = p.grad · skip if None',
                kind: 'io',
                shape: 'same shape as p',
                detail:
                  'Read from `p.grad` inside `for group in self.param_groups: for p in group["params"]`. A parameter whose `grad is None` is skipped: no decay, no buffer.',
              },
              {
                id: 'buffer',
                label: 'Momentum buffer',
                sub: 'buf.mul_(μ).add_(g)',
                kind: 'memory',
                shape: 'same shape as p',
                side: {
                  label: 'state[p]',
                  sub: 'clone(g) on step 1',
                  detail:
                    'Created lazily the first time `p` has a gradient, as `torch.clone(g).detach()`; absent when `momentum = 0`.',
                },
                detail:
                  '`buf ← μ · buf + g`, in place in `self.state[p]["momentum_buffer"]`, so `state_dict()` saves it. A constant gradient drives it to `g / (1 − μ)`.',
              },
              {
                columns: [
                  [
                    {
                      id: 'classical',
                      label: 'Classical momentum',
                      sub: 'd = buf',
                      detail: 'Heavy ball: step along the buffer. With `momentum = 0` there is no buffer and `d = g`.',
                    },
                  ],
                  [
                    {
                      id: 'nesterov',
                      label: 'Nesterov look-ahead',
                      sub: 'd = g.add(buf, alpha=μ)',
                      detail:
                        'With `nesterov=True`: `d = g + μ · buf`, one out-of-place `add`. The buffer is the classical one; only the direction changes.',
                    },
                  ],
                ],
              },
              {
                id: 'decay',
                label: 'Decoupled weight decay',
                sub: 'p.mul_(1 − lr·wd)',
                detail:
                  'Shrinks the weight itself, before the update and outside the buffer. Folded into the gradient instead (`g + wd · p`), the decay would be replayed by the buffer `1 / (1 − μ)` times.',
              },
              {
                id: 'update',
                label: 'In-place update',
                sub: 'p.add_(d, alpha=−lr)',
                detail:
                  '`p ← p − lr · d` under `@torch.no_grad()`, writing into the leaf tensor the model holds. No `p = p − …`, no `.data`.',
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
          'The self-test compares every parameter after every step with `torch.optim.SGD` at `weight_decay=0` (`allclose`, `rtol=1e-5`), then checks one decayed step by hand.',
      },
    ],
    notes: [
      {at: 'buffer', text: 'μ = **0.9**: steady state **10 × g**'},
      {at: 'nesterov', text: 'Newest gradient weighs **1 + μ**'},
      {at: 'decay', text: '**wd · p** never enters the buffer'},
      {at: 'trained', text: 'Same as torch.optim.SGD for **25** steps'},
    ],
  },
  steps: [sgdMomentumStep],
  learn,
};
