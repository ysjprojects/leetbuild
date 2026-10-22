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
  diagram: {
    nodes: [
      {id: 'autograd', kind: 'client', label: 'training loop', sub: 'loss.backward() → p.grad', x: 8, y: 50},
      {id: 'step', kind: 'service', label: 'SGD.step()', sub: 'decay · buffer · look-ahead · update', x: 36, y: 50},
      {id: 'state', kind: 'db', label: 'state[p]', sub: 'momentum_buffer, created lazily', x: 64, y: 22},
      {id: 'params', kind: 'db', label: 'parameters', sub: 'p.mul_(1 − lr·wd) · p.add_(d, alpha=−lr)', x: 64, y: 78},
      {id: 'ref', kind: 'external', label: 'torch.optim.SGD', sub: 'same trajectory at weight_decay=0', x: 92, y: 78},
    ],
    edges: [
      {from: 'autograd', to: 'step', kind: 'plain', label: 'step(closure?)'},
      {from: 'step', to: 'state', kind: 'plain', label: 'buf.mul_(μ).add_(g)'},
      {from: 'step', to: 'params', kind: 'plain', label: 'in place, under no_grad'},
      {from: 'params', to: 'ref', kind: 'plain', label: 'allclose after every step'},
    ],
  },
  steps: [sgdMomentumStep],
  learn,
};
