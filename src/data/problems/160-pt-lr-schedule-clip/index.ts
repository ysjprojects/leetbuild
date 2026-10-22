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
  figures: [
    {
      title: 'One training step',
      architecture: {
        input: 'batch_iter · accum_steps = 4',
        items: [
          {
            tone: 'block',
            repeat: 'for each step',
            label: 'train_step(step)',
            items: [
              {
                id: 'zero',
                label: 'Clear the gradients',
                sub: 'zero_grad(set_to_none=True)',
                detail:
                  'Once per optimizer step, before the micro-batch loop. With `set_to_none=True` the first `backward()` assigns `.grad` instead of adding into a zeroed tensor.',
              },
              {
                tone: 'dotted',
                repeat: 'accum_steps ×',
                label: 'Micro-batch',
                items: [
                  {
                    id: 'batch',
                    label: 'Micro-batch (x, y)',
                    sub: 'x, y = next(batch_iter)',
                    kind: 'io',
                    shape: 'x: [4, …] · y: [4]',
                    detail: 'The self-test runs four micro-batches of 4 against one batch of 16.',
                  },
                  {id: 'forward', label: 'Model forward', sub: 'logits = model(x)', kind: 'layer'},
                  {
                    id: 'loss',
                    label: 'Scaled loss',
                    sub: 'cross_entropy(logits, y) / accum',
                    kind: 'loss',
                    detail:
                      'Each micro-batch loss is a mean over 4 examples; divided by `accum_steps`, the four sum to the mean over 16. The returned `"loss"` is that sum.',
                  },
                  {
                    id: 'backward',
                    label: 'Backward',
                    sub: 'loss.backward() · .grad += ∂/∂θ',
                    detail: 'Gradients are linear in the loss, so the summed `.grad` is the big-batch gradient.',
                  },
                ],
              },
              {
                id: 'grads',
                label: '.grad buffers',
                sub: 'the big-batch gradient',
                kind: 'memory',
                detail: 'One gradient tensor per parameter, summed over the `accum_steps` backward passes.',
              },
              {
                id: 'norm',
                label: 'Global grad norm',
                sub: '‖ [‖g₁‖, …, ‖gₙ‖] ‖₂',
                detail:
                  '`torch.stack([g.norm(2.0) for g in grads]).norm(2.0)`: one norm over the whole model, the norm of the per-tensor norms. Returned before clipping and logged.',
              },
              {
                id: 'clip',
                label: 'Clip by the global norm',
                sub: 'g.mul_(max_norm / (‖g‖ + 1e-6))',
                detail:
                  'Only when `clip_coef = max_norm / (total_norm + 1e-6)` is below 1, and in place for every gradient: one factor, so the direction is kept and only the length is bounded.',
              },
              {
                id: 'lr',
                label: 'Set the LR',
                sub: 'group["lr"] = lr_at(step)',
                detail:
                  'A pure function of the step, written into every `optimizer.param_groups` entry before the step: linear warmup, half-cosine decay, then `min_lr`.',
              },
              {
                id: 'optimizer',
                label: 'optimizer.step()',
                sub: 'θ moves along the clipped .grad',
                detail:
                  'Any optimizer; the self-test uses plain SGD so one batch of 16 and four of 4 land on the same parameters.',
              },
            ],
          },
          {
            id: 'log',
            label: 'Training log',
            sub: '{loss, grad_norm, lr}',
            kind: 'io',
            detail:
              'The scaled-loss sum, the pre-clip norm as a float and the LR: the three plots every LLM run watches.',
          },
        ],
        notes: [
          {at: 'zero', text: '**Once** per step, never per micro-batch'},
          {at: 'loss', text: 'Divide by **accum_steps** before backward'},
          {at: 'clip', text: 'max_norm **1.0** in almost every LLM config', side: 'left'},
        ],
        insets: [
          {
            for: 'lr',
            title: 'lr_at(step)',
            items: [
              {id: 'warmup', label: 'Linear warmup', sub: 'max_lr · (step + 1) / warmup'},
              {id: 'cosine', label: 'Cosine decay', sub: 'min + ½(1 + cos πp)(max − min)'},
              {id: 'floor', label: 'Floor', sub: 'min_lr once step ≥ total'},
            ],
            note: 'Halfway: **5.05e-04** at step 55',
          },
        ],
      },
    },
  ],
  steps: [trainStepStep],
  learn,
};
