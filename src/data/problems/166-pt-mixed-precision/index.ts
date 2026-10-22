import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {lossScalerStep} from './steps/1-loss-scaler';

/**
 * Deep-learning drill: mixed-precision training by hand — the forward under `torch.autocast` with
 * float32 master weights, and a dynamic loss scaler (scale, unscale in place, one overflow check per
 * parameter group, skip and back off, grow after N good steps) matched against `torch.amp.GradScaler`.
 */
export const ptMixedPrecisionProblem: Problem = {
  id: 'pt-mixed-precision',
  title: 'Mixed precision: autocast and a dynamic loss scaler by hand',
  tagline:
    'Run the forward in bf16 under torch.autocast, keep the weights in fp32, and write the loss scaler: scale, unscale in place, detect inf/nan, skip and back off, grow after N clean steps.',
  difficulty: 'hard',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# Mixed precision: autocast and a dynamic loss scaler by hand

Every large model is trained in mixed precision: the matmuls run in 16-bit floats — twice the
throughput on tensor cores, half the activation memory — while the weights the optimizer updates stay in
float32. Micikevicius et al. (*Mixed Precision Training*, 2017) named the three pieces: an fp32 **master
copy** of the weights, 16-bit arithmetic that accumulates in fp32, and **loss scaling**. fp16 has a
narrow exponent range: gradients below \`2**-24\` flush to zero. Multiplying the loss by a large power of
two before \`backward\` lifts every gradient into range; dividing by it afterwards restores the true
values. A **dynamic** scaler picks that power by itself: an \`inf\` or \`nan\` gradient means the scale is
too high, so the step is skipped and the scale halves; a long run of clean steps means it may be too low,
so it doubles. bfloat16 has fp32's exponent range and rarely needs the scaler — the self-test therefore
injects the overflow.

The surface, in \`mixed_precision.py\`:

- \`DynamicLossScaler(init_scale=2.0**16, growth_factor=2.0, backoff_factor=0.5, growth_interval=2000)\`
  with \`get_scale()\`, \`scale(loss)\`, \`unscale_(optimizer) -> bool\` (found a non-finite gradient),
  \`step(optimizer) -> bool\` (did the optimizer step), \`state_dict()\` and \`load_state_dict(state)\`.
- \`train_step(model, batch, optimizer, scaler, dtype=torch.bfloat16, max_norm=1.0)\` returning
  \`(loss, grad_norm, stepped)\`: \`zero_grad\`, the forward under \`torch.autocast\`, the loss in float32,
  scaled \`backward\`, \`unscale_\`, \`clip_grad_norm_\`, \`scaler.step\`. Parameters and gradients are
  float32 throughout; only the forward's activations are in \`dtype\`.

## What you build here

1. The scaler and the training step: \`loss * scale\` before \`backward\`; gradients divided in place
   before clipping, with one \`torch.isfinite\` reduction per parameter group; \`optimizer.step()\` skipped
   and the scale multiplied by \`backoff_factor\` on overflow; \`growth_interval\` consecutive good steps
   multiply it by \`growth_factor\`; the forward under \`torch.autocast\`, the model never cast to 16 bits.

## Run it on your machine

\`python mixed_precision.py\` — on CPU, a 16→32→4 MLP with SGD: the first step must see bfloat16
activations, float32 parameters and an update within \`rtol=5e-2, atol=2e-4\` of a plain float32 step; a
step with an infinite gradient must leave the weights untouched and halve the scale to \`2**15\`; four good
steps must double it back; \`state_dict\` must round-trip; and where \`torch.amp.GradScaler("cpu")\` exists
(PyTorch ≥ 2.3), six steps with an overflow in the middle must give its weights and its scale. A passing
run prints \`PASS\`.

## Left out on purpose

fp16 on a GPU (the mechanism is the same; the test runs anywhere), keeping the scale on the device so the
overflow check never syncs, the fused \`_amp_foreach_non_finite_check_and_unscale_\` kernel, multiple
optimizers sharing one scaler, gradient accumulation across micro-batches, FSDP's \`MixedPrecision\`
policy, and fp8 matmuls with per-tensor scaling (Transformer Engine).`,
  diagram: {
    nodes: [
      {id: 'loop', kind: 'client', label: 'train_step', sub: 'zero_grad · forward · backward · step', x: 10, y: 50},
      {
        id: 'autocast',
        kind: 'service',
        label: 'torch.autocast',
        sub: 'bf16 matmuls · loss on logits.float()',
        x: 40,
        y: 20,
      },
      {
        id: 'scaler',
        kind: 'service',
        label: 'DynamicLossScaler',
        sub: 'scale · unscale_ · isfinite · backoff · growth',
        x: 40,
        y: 75,
      },
      {
        id: 'optimizer',
        kind: 'db',
        label: 'fp32 master weights',
        sub: 'p · p.grad (fp32) · SGD step',
        x: 72,
        y: 50,
      },
      {id: 'ref', kind: 'external', label: 'torch.amp.GradScaler', sub: 'same weights · same scale', x: 72, y: 90},
    ],
    edges: [
      {from: 'loop', to: 'autocast', kind: 'plain', label: 'forward in dtype'},
      {from: 'autocast', to: 'optimizer', kind: 'plain', label: 'bf16 copy of each weight'},
      {from: 'loop', to: 'scaler', kind: 'plain', label: 'scale(loss) · unscale_ · step'},
      {from: 'scaler', to: 'optimizer', kind: 'plain', label: 'grads ÷ scale · step or skip'},
      {from: 'scaler', to: 'ref', kind: 'plain', label: 'compared on CPU'},
    ],
  },
  steps: [lossScalerStep],
  learn,
};
