import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {trainStepStep} from './steps/1-train-step';

/**
 * Drill: the plumbing around one optimizer step of an LLM run — a warmup-then-cosine learning-rate
 * schedule as a pure function of the step, gradient clipping by the global norm written by hand,
 * and gradient accumulation over micro-batches that reproduces the big-batch gradient exactly.
 */
export const ptLrScheduleClipProblem: Problem = {
  id: 'pt-lr-schedule-clip',
  title: 'Warmup, cosine decay, gradient clipping and accumulation',
  tagline:
    'lr_at(step) by hand, clip_grad_norm_ by hand, and a train_step that accumulates four micro-batches into exactly one big-batch gradient before it clips, sets the LR and steps.',
  difficulty: 'medium',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 45,
  statement: `# Warmup, cosine decay, gradient clipping and accumulation

Every LLM training loop — GPT-2, Llama, nanoGPT, Megatron — has the same twenty lines wrapped around
\`optimizer.step()\`, and they decide whether the run converges or dies in its first thousand steps.
The **learning rate** is not a constant: it ramps linearly from near zero for a few hundred steps
(Adam's moment estimates are noise at the start; a full-size step then is a step off a cliff), peaks,
and decays along a half cosine to a floor by the end of the run. The **gradient** is not applied as
it comes: its global L2 norm is measured, and if it exceeds a bound (1.0 in almost every published
config) the whole gradient is scaled down — the direction kept, the spike removed — and the norm before
clipping is logged, because grad-norm spikes are the earliest sign of a run going wrong. And the
**batch** does not fit on one device: a batch of 0.5M tokens is run as many micro-batches whose
gradients add up in the \`.grad\` buffers before one optimizer step, which is only correct if each
micro-batch loss is scaled by \`1 / accum_steps\` and the buffers are cleared once per step.

The surface is three functions in \`train_step.py\`, pure PyTorch, written by hand:

\`\`\`python
def lr_at(step: int, warmup_steps: int, total_steps: int, max_lr: float, min_lr: float) -> float
def clip_grad_norm_(params: Iterable[torch.Tensor], max_norm: float) -> torch.Tensor   # pre-clip norm
def train_step(model, batch_iter, optimizer, accum_steps, step, *,
               warmup_steps, total_steps, max_lr, min_lr, max_norm=1.0) -> dict[str, float]
# → {"loss": float, "grad_norm": float, "lr": float}
\`\`\`

\`torch.optim.lr_scheduler\` and \`torch.nn.utils.clip_grad_norm_\` are off limits inside the
implementation; the self-test uses the latter as its reference.

## What you build here

1. \`lr_at\` — linear warmup \`max_lr × (step + 1) / warmup_steps\`, then
   \`min_lr + ½(1 + cos(π · progress))(max_lr − min_lr)\` until \`total_steps\`, \`min_lr\` after;
   \`clip_grad_norm_\` — the norm of every parameter's gradient norm, scaled in place by
   \`max_norm / (norm + 1e-6)\` only when that is below 1, the pre-clip norm returned; \`train_step\` —
   \`zero_grad(set_to_none=True)\` once, \`accum_steps\` forward-backward passes with the loss divided by
   \`accum_steps\`, clip, the LR from \`lr_at\` written into every \`param_groups\` entry, \`optimizer.step()\`,
   and the three numbers every training log plots.

## Run it on your machine

\`\`\`bash
python train_step.py
\`\`\`

A passing run prints the schedule at four steps (\`1.00e-04\`, \`1.00e-03\`, \`5.05e-04\`, \`1.00e-05\`), the
pre- and post-clip norm beside \`torch.nn.utils.clip_grad_norm_\`'s (\`0.6876\` → \`0.1000\`), two
\`train_step\` lines of loss, grad norm and LR, and \`PASS\`. The starter stops at the first
\`NotImplementedError\`. CPU only; about a second.

## Left out on purpose

Weight-decay parameter groups (decay on matrices, none on biases and norms — the reason the LR is
written into *every* group), the \`GradScaler.unscale_\` that must precede clipping under fp16, DDP's
\`no_sync()\` around the first \`accum_steps − 1\` micro-batches, FSDP's sharded norm all-reduce,
checkpoint-and-resume of the step counter, and the token-based (rather than step-based) schedules of
recent runs. The schedule, the norm and the accumulation arithmetic are the same.`,
  diagram: {
    nodes: [
      {id: 'batches', kind: 'client', label: 'Micro-batches', sub: 'accum_steps × (x, y)', x: 8, y: 50},
      {id: 'step', kind: 'service', label: 'train_step', sub: 'forward · loss / accum_steps · backward', x: 30, y: 50},
      {id: 'grads', kind: 'db', label: '.grad buffers', sub: 'zeroed once · summed accum_steps times', x: 54, y: 24},
      {
        id: 'clip',
        kind: 'service',
        label: 'clip_grad_norm_ · lr_at',
        sub: 'global norm → scale · warmup → cosine',
        x: 54,
        y: 76,
      },
      {id: 'optimizer', kind: 'service', label: 'optimizer', sub: 'param_groups["lr"] = lr · step()', x: 84, y: 50},
    ],
    edges: [
      {from: 'batches', to: 'step', kind: 'plain', label: 'next(batch_iter)'},
      {from: 'step', to: 'grads', kind: 'plain', label: 'backward() adds'},
      {from: 'grads', to: 'clip', kind: 'plain', label: 'norm of norms · mul_'},
      {from: 'clip', to: 'optimizer', kind: 'plain', label: 'lr · clipped grads'},
      {from: 'optimizer', to: 'step', kind: 'plain', label: '{loss, grad_norm, lr}'},
    ],
  },
  steps: [trainStepStep],
  learn,
};
