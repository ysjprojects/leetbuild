import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {lossScalerStep} from './steps/1-loss-scaler';

/**
 * Deep-learning drill: mixed-precision training by hand: the forward under `torch.autocast` with
 * float32 master weights, and a dynamic loss scaler (scale, unscale in place, one overflow check per
 * parameter group, skip and back off, grow after N good steps) matched against `torch.amp.GradScaler`.
 */
export const ptMixedPrecisionProblem: Problem = {
  id: 'pt-mixed-precision',
  title: 'Mixed precision: autocast and a dynamic loss scaler by hand',
  tagline:
    'Run the forward in bf16 under torch.autocast, keep the weights in fp32, and write the loss scaler: scale, unscale in place, detect inf/nan, skip and back off, grow after N clean steps.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# Mixed precision: autocast and a dynamic loss scaler by hand

Every large model is trained in mixed precision: the matmuls run in 16-bit floats (on an A100, 312
TFLOPS against 156 for TF32 and 19.5 for plain fp32; half the activation memory) while the weights the
optimizer updates stay in float32. Micikevicius et al. (*Mixed Precision Training*, 2017) named the three
pieces: an fp32 **master copy** of the weights, 16-bit arithmetic that accumulates in fp32, and **loss
scaling**. fp16 has a narrow exponent range: gradient values up to \`2**-25\` (half its smallest
subnormal, \`2**-24\`) round to zero. Multiplying the loss by a large power of two before \`backward\`
lifts every gradient into range; dividing by it afterwards restores the true values. A **dynamic** scaler
picks that power by itself: an \`inf\` or \`nan\` gradient means the scale is too high, so the step is
skipped and the scale halves; a long run of clean steps means it may be too low, so it doubles. bfloat16
has fp32's exponent range and rarely needs the scaler, so the self-test injects the overflow.

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

\`python mixed_precision.py\` (about 2 s on a laptop CPU) trains a 16→32→4 MLP with SGD. The first step must see bfloat16
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
  figures: [
    {
      title: 'One mixed-precision step',
      architecture: {
        input: 'batch (x, y) · 16→32→4 MLP',
        output: '(loss, grad_norm, stepped)',
        items: [
          {
            id: 'master',
            label: 'fp32 master weights',
            sub: 'p and p.grad stay float32',
            kind: 'io',
            detail:
              'The optimizer only ever updates float32 weights. Casting the model with `.half()` or `.bfloat16()` would round small updates away: bf16’s spacing near 1.0 is `2**-7`.',
          },
          {
            tone: 'block',
            repeat: 'for each step',
            label: 'train_step',
            items: [
              {id: 'zero', label: 'zero_grad', sub: 'set_to_none=True'},
              {
                id: 'forward',
                label: 'Forward under autocast',
                sub: 'matmuls in bf16 · logits bf16',
                kind: 'ffn',
                side: {
                  label: 'bf16 weight copies',
                  sub: 'cast once per region',
                  detail:
                    'Autocast casts each fp32 parameter to the autocast dtype for matmul-like ops and caches the copy; the backward of the cast delivers an fp32 `.grad`.',
                },
                detail:
                  '`with torch.autocast(device_type=x.device.type, dtype=dtype)`: linear layers run on 16-bit copies, activations are 16-bit, the parameters are untouched.',
              },
              {
                id: 'loss',
                label: 'Cross-entropy in fp32',
                sub: 'F.cross_entropy(logits.float(), y)',
                kind: 'loss',
                detail:
                  'The loss is a sum of logs and exponentials: computed on upcast logits so it is float32 on every device.',
              },
              {
                id: 'scale',
                label: 'Scale the loss',
                sub: 'scaler.scale(loss) = loss × S',
                kind: 'attention',
                detail:
                  'Backpropagation is linear in the loss, so every gradient is multiplied by `S`. A power of two only shifts exponents: no rounding.',
              },
              {
                id: 'backward',
                label: 'Backward',
                sub: 'every .grad fp32, × S',
                detail:
                  'Autograd replays each op in the dtype its forward used; the gradients that land on the parameters are float32 and carry the factor `S`.',
              },
              {
                id: 'unscale',
                label: 'unscale_',
                sub: 'grads ÷ S in place',
                kind: 'attention',
                detail:
                  'Every `p.grad` of every parameter group divided by the scale, in place. At most once per step: a second call raises `RuntimeError`.',
              },
              {
                id: 'check',
                label: 'Overflow check',
                sub: 'one isfinite per param group',
                kind: 'attention',
                detail:
                  'Stack `isfinite(g).all()` over the group and reduce once: one host sync per group, not one per tensor. Records `found_inf`.',
              },
              {
                id: 'clip',
                label: 'clip_grad_norm_',
                sub: 'max_norm=1.0 on true grads',
                detail: 'After `unscale_`, so the norm is of the real gradients; returned as `grad_norm`.',
              },
              {
                columns: [
                  [
                    {
                      id: 'skip',
                      label: 'inf / NaN: skip',
                      sub: 'no optimizer.step()',
                      kind: 'attention',
                      detail:
                        'A skipped step costs one batch and leaves every weight bit-equal; an applied `inf` would cost the run.',
                    },
                  ],
                  [
                    {
                      id: 'step',
                      label: 'Finite: step',
                      sub: 'optimizer.step() on fp32',
                      kind: 'attention',
                      detail: 'SGD updates the float32 master weights with the unscaled, clipped gradients.',
                    },
                  ],
                ],
              },
              {
                id: 'update',
                label: 'Update the scale',
                sub: '× 0.5 and reset, or count; × 2',
                kind: 'attention',
                detail:
                  'Overflow: `scale × backoff_factor`, good-step counter to 0. Otherwise the counter grows, and after `growth_interval` consecutive good steps the scale is multiplied by `growth_factor` and the counter resets.',
              },
            ],
          },
        ],
        notes: [
          {at: 'scale', text: 'S = **65,536** lifts a 2^-30 gradient to fp16’s 2^-14'},
          {at: 'check', text: '**1** host sync per parameter group'},
          {at: 'clip', text: 'Scaled norms would be **65,536×** too large'},
          {at: 'skip', text: 'Skipped: every weight **bit-equal**', side: 'left'},
          {at: 'update', text: '**× 0.5** on overflow, **× 2** after 2,000 clean steps'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Mixed Precision Training',
      url: 'https://arxiv.org/abs/1710.03740',
      by: 'Paulius Micikevicius et al.',
      date: '2017-10-10',
      venue: 'ICLR 2018',
      takes:
        'The three pieces `train_step` puts together: fp32 master weights, 16-bit arithmetic accumulated in fp32, and loss scaling for the gradients fp16 would flush to zero.',
    },
    {
      kind: 'paper',
      title: 'A Study of BFLOAT16 for Deep Learning Training',
      url: 'https://arxiv.org/abs/1905.12322',
      by: 'Dhiraj Kalamkar et al.',
      date: '2019-05-29',
      venue: 'arXiv',
      takes:
        "Why the default `dtype=torch.bfloat16` rarely needs the scaler: bfloat16 has fp32's range, so training converges with no extra tuning, where fp16 needs it.",
    },
    {
      kind: 'code',
      title: 'torch/amp/grad_scaler.py',
      url: 'https://github.com/pytorch/pytorch/blob/v2.3.0/torch/amp/grad_scaler.py',
      by: 'PyTorch',
      date: '2024-04-24',
      venue: 'GitHub',
      takes:
        'The `GradScaler` the self-test matches over six steps: `init_scale=2**16`, `growth_factor`, `backoff_factor`, `growth_interval`, and `unscale_` then `step` that skips on inf or nan.',
    },
    {
      kind: 'docs',
      title: 'Automatic Mixed Precision package - torch.amp',
      url: 'https://docs.pytorch.org/docs/stable/amp.html',
      venue: 'PyTorch documentation',
      takes:
        '`torch.autocast` and its op lists: which ops run in the 16-bit type and which stay in float32, while the parameters remain float32.',
    },
    {
      kind: 'docs',
      title: 'Train With Mixed Precision',
      url: 'https://docs.nvidia.com/deeplearning/performance/mixed-precision-training/index.html',
      venue: 'NVIDIA Deep Learning Performance docs',
      takes:
        'The dynamic loss-scaling recipe the scaler follows: skip the step and lower the scale on overflow, raise it after N clean iterations.',
    },
  ],
  steps: [lossScalerStep],
  learn,
};
