/**
 * The learning guide for the mixed-precision drill: fp32/fp16/bf16 ranges, why fp16 gradients underflow
 * and how loss scaling fixes it, the dynamic scaler's backoff and growth, fp32 master weights and what
 * torch.autocast casts, and fp8 as what production adds. Rendered at `/pt-mixed-precision/learn`.
 */
export const learn = `# The mechanism at a glance

Mixed precision runs the expensive part of training — the matmuls of the forward and backward — in a
16-bit float, and everything that accumulates small changes in float32. Micikevicius et al.,
[*Mixed Precision Training*](https://arxiv.org/abs/1710.03740) (Baidu and NVIDIA, ICLR 2018), gave the
recipe every framework still follows: an fp32 **master copy** of the weights, 16-bit products accumulated
in fp32, and **loss scaling** so small gradients survive fp16. The drill writes the training step and the
scaler by hand: \`train_step(model, batch, optimizer, scaler, dtype=torch.bfloat16, max_norm=1.0)\` and
\`DynamicLossScaler(init_scale=2.0**16, growth_factor=2.0, backoff_factor=0.5, growth_interval=2000)\`
with \`scale\`, \`unscale_\`, \`step\`, \`state_dict\` and \`load_state_dict\`. One training step, read bottom
to top, with the scaler's stages in the accent colour:

:::architecture
{
  "input": "batch (x, y) · 16→32→4 MLP",
  "output": "(loss, grad_norm, stepped)",
  "items": [
    {"id": "master", "label": "fp32 master weights", "sub": "p and p.grad stay float32", "kind": "io", "detail": "The optimizer only ever updates float32 weights; 16-bit copies exist only inside the forward."},
    {"tone": "block", "repeat": "for each step", "label": "train_step", "items": [
      {"id": "zero", "label": "zero_grad", "sub": "set_to_none=True"},
      {"id": "forward", "label": "Forward under autocast", "sub": "matmuls in bf16 · logits bf16", "kind": "ffn",
       "side": {"label": "bf16 weight copies", "sub": "cast once per region", "detail": "Each fp32 parameter is cast for matmul-like ops and the copy cached; the cast's backward delivers an fp32 grad."},
       "detail": "Linear layers run on 16-bit copies; activations are 16-bit; the parameters are untouched."},
      {"id": "loss", "label": "Cross-entropy in fp32", "sub": "F.cross_entropy(logits.float(), y)", "kind": "loss"},
      {"id": "scale", "label": "Scale the loss", "sub": "scaler.scale(loss) = loss × S", "kind": "attention", "detail": "Backpropagation is linear in the loss, so every gradient carries the factor S."},
      {"id": "backward", "label": "Backward", "sub": "every .grad fp32, × S"},
      {"id": "unscale", "label": "unscale_", "sub": "grads ÷ S in place", "kind": "attention", "detail": "At most once per step; a second call raises RuntimeError."},
      {"id": "check", "label": "Overflow check", "sub": "one isfinite per param group", "kind": "attention", "detail": "Stack isfinite(g).all() over the group and reduce once: records found_inf."},
      {"id": "clip", "label": "clip_grad_norm_", "sub": "max_norm=1.0 on true grads", "detail": "Returned as grad_norm."},
      {"columns": [
        [{"id": "skip", "label": "inf / NaN: skip", "sub": "no optimizer.step()", "kind": "attention"}],
        [{"id": "step", "label": "Finite: step", "sub": "optimizer.step() on fp32", "kind": "attention"}]
      ]},
      {"id": "update", "label": "Update the scale", "sub": "× 0.5 and reset, or count; × 2", "kind": "attention", "detail": "Overflow: scale × backoff_factor and the counter to 0. Otherwise count, and after growth_interval good steps in a row, scale × growth_factor."}
    ]}
  ],
  "notes": [
    {"at": "scale", "text": "S = **65,536** lifts a 2^-30 gradient to fp16’s 2^-14"},
    {"at": "check", "text": "**1** host sync per parameter group"},
    {"at": "clip", "text": "Scaled norms would be **65,536×** too large"},
    {"at": "skip", "text": "Skipped: every weight **bit-equal**", "side": "left"},
    {"at": "update", "text": "**× 0.5** on overflow, **× 2** after 2,000 clean steps"}
  ]
}
:::

The order of a step is fixed by what each stage needs to see:

| Stage | What it sees | Why it sits here |
| --- | --- | --- |
| \`optimizer.zero_grad(set_to_none=True)\` | last step's gradients | backward accumulates into \`.grad\` |
| \`model(x)\` under \`torch.autocast(device_type, dtype)\` | bf16 copies of fp32 weights | matmuls at the 16-bit rate, parameters untouched |
| \`cross_entropy(logits.float(), y)\` | fp32 logits | a sum of logs and exponentials needs fp32 |
| \`scaler.scale(loss).backward()\` | every grad × 65536, in fp32 | small gradients must be lifted before the chain rule runs |
| \`scaler.unscale_(optimizer)\` | grads ÷ 65536 in place, one \`isfinite\` per group | the clipper and the optimizer need true gradients |
| \`clip_grad_norm_(parameters, 1.0)\` | true gradients | the norm of scaled ones is 65536× too large |
| \`scaler.step(optimizer)\` | \`found_inf\` | finite: \`step()\`; otherwise skip and halve the scale |

- Parameters and their \`.grad\` are float32 from start to end; only activations are 16-bit.
- \`unscale_\` runs before \`clip_grad_norm_\`: the norm of scaled gradients is 65536× too large.
- \`step\` returns whether the optimizer stepped; \`train_step\` returns \`(loss, grad_norm, stepped)\`.

# Three formats, three ranges

A float spends its bits on an exponent (range) and a mantissa (precision). The two 16-bit formats spend
them differently:

| format | exp / mantissa bits | largest | smallest normal | smallest subnormal | spacing at 1.0 |
|---|---|---|---|---|---|
| float32 | 8 / 23 | 3.4e38 | 1.2e-38 | 1.4e-45 | 2**-23 ≈ 1.2e-7 |
| float16 | 5 / 10 | 65504 | 2**-14 ≈ 6.1e-5 | 2**-24 ≈ 6.0e-8 | 2**-10 ≈ 9.8e-4 |
| bfloat16 | 8 / 7 | 3.4e38 | 1.2e-38 | 9.2e-41 | 2**-7 ≈ 7.8e-3 |

- **fp16** (IEEE half) has more precision but a range of about 2**-24 to 2**16. Activations fit; many
  gradients do not.
- **bf16** (Google Brain's "brain float") is float32 with the mantissa cut to 7 bits: the same exponent,
  so the same range, and about three significant decimal digits. Converting fp32 → bf16 is a truncation of
  the low 16 bits (with rounding).
- Both run at the same tensor-core rate on A100/H100; V100 and earlier have fp16 tensor cores only. That
  hardware history is why fp16 plus a loss scaler came first and why recent pretraining runs (Llama,
  GPT-NeoX) use bf16 without one.

:::quiz
Q: Why does bf16 training usually work without a loss scaler while fp16 training does not?
- [ ] bf16 has more mantissa bits, so small gradients are represented exactly
- [x] bf16 keeps fp32's 8-bit exponent, so gradients down to about 1e-38 stay representable
- [ ] bf16 matmuls accumulate in fp64
> Underflow is a range problem, not a precision problem. bf16 has fewer mantissa bits than fp16 (7 against
> 10) but fp32's exponent, so a gradient of 1e-9 is representable in bf16 and flushes to zero in fp16.
:::

# Why gradients underflow, and why scaling fixes it

Gradients of a deep network are small and get smaller with depth and over training. The paper's
histograms show it: in a Mandarin speech model about 5% of weight-gradient values had exponents below
-24 — zero in fp16 — and in an SSD detector most activation gradients sat below fp16's range while the
top of the range went unused.

The widget draws the same picture. At a loss scale of 1 the left tail of the gradient histogram sits below
fp16's smallest subnormal, \`2**-24\`: a true gradient of \`2**-30\` rounds to \`0.0\` and the weight it belongs
to never moves, silently. Raise the scale and the tail lifts into range:

:::widget float-formats

Backpropagation is linear in the loss, so multiplying the loss by \`S\` multiplies every gradient of the
chain rule by \`S\`. Choose \`S\` a power of two and the multiplication and the later division are exact —
only the exponent changes:

\`\`\`text
scaled = scaler.scale(loss)            # loss * S, S = 2**16
scaled.backward()                      # every grad is S * g:  2**-30 * 2**16 = 2**-14, fp16's smallest normal
grads /= S   (in place, in fp32)       # unscale_: the optimizer and the clipper see g
\`\`\`

- The paper used a constant \`S\` (8 was enough for SSD to match fp32); any value works as long as the
  largest scaled gradient stays below 65504.
- Division happens on fp32 gradients, so nothing underflows on the way back down.
- Clipping, logging the gradient norm and the optimizer all need true gradients — so all of them come after
  \`unscale_\`.

:::quiz
Q: Why is the scale a power of two rather than, say, 50000?
- [ ] Optimizers require integer-valued scales
- [x] Multiplying and dividing by a power of two only shifts the exponent, so scaling adds no rounding error
- [ ] Powers of two are the only values that never overflow fp16
> S × g changes only the exponent bits when S = 2**k; the mantissa is untouched, so g / S recovers g
> exactly unless the product left the range. Any other S rounds every gradient twice.
:::

# Dynamic scaling: back off on overflow, grow after N good steps

A scale that is too large turns a gradient into \`inf\` (or an \`inf - inf\` into \`nan\`). That is not a bug
to raise on; it is the signal that \`S\` is too big. The scaler checks after \`unscale_\`, once per
parameter group, with one \`torch.isfinite\` reduction over the group's gradients:

:::architecture
{
  "input": "scaled grads after backward",
  "output": "next step",
  "items": [
    {"id": "d-unscale", "label": "unscale_", "sub": "grads ÷ S in place", "kind": "attention"},
    {"id": "d-check", "label": "isfinite, once per group", "sub": "found_inf = any non-finite", "kind": "attention", "detail": "Without this check the optimizer applies the inf: w − lr·inf = −inf, and the next forward is nan."},
    {"columns": [
      [
        {"id": "d-skip", "label": "Non-finite: skip", "sub": "no optimizer.step() · bit-equal"},
        {"id": "d-back", "label": "Back off", "sub": "scale × 0.5 · counter = 0"}
      ],
      [
        {"id": "d-step", "label": "Finite: optimizer.step()", "sub": "counter += 1"},
        {"id": "d-grow", "label": "Grow at the interval", "sub": "N in a row: scale × 2, reset"}
      ]
    ]},
    {"id": "d-clear", "label": "Clear found_inf", "sub": "unscale_ allowed again", "kind": "io"}
  ],
  "notes": [
    {"at": "d-check", "text": "No check: w − lr·inf = **−inf**, then nan"},
    {"at": "d-skip", "text": "Costs **one batch**, not the run", "side": "left"},
    {"at": "d-grow", "text": "N = **2,000** by default, **4** in the self-test"}
  ]
}
:::

The self-test's trajectory with \`growth_interval=4\`:

| step | gradients | stepped | scale after | good-step counter |
|---|---|---|---|---|
| 1 | finite | yes | 65536 | 1 |
| 2 | one \`inf\` injected | no | 32768 | 0 |
| 3–5 | finite | yes | 32768 | 1, 2, 3 |
| 6 | finite | yes | 65536 | 0 |

- A skipped step costs one batch; an applied \`inf\` costs the run. Skipping leaves every weight bit-equal.
- Growth exists because gradients shrink as the loss falls: a scale that was right at step 100 may be too
  small at step 100 000. The PyTorch defaults (×2 every 2000 good steps, ×0.5 on overflow) keep \`S\` just
  under the overflow edge.
- In fp16 a scaled gradient of 1.0 at \`S = 2**16\` is 65536 > 65504, so the first few steps of a run often
  skip while the scale finds its level.
- \`unscale_\` runs at most once per step and \`step\` calls it when the caller did not; a second call raises
  \`RuntimeError\`, because dividing twice would hand the clipper gradients 65536× too small.
- \`state_dict\` holds \`scale\`, \`growth_factor\`, \`backoff_factor\`, \`growth_interval\` and
  \`growth_tracker\`: a resumed run that restarts at 2**16 overflows its first steps again.

:::details Why one check per group, not one per tensor
\`bool(t)\` or \`t.item()\` on a GPU tensor waits for every queued kernel to finish. A 7B model has hundreds
of parameter tensors; an \`.item()\` per tensor would drain the GPU queue hundreds of times a step. Stacking
the per-tensor \`isfinite(g).all()\` results and reducing once costs one sync per group. \`GradScaler\`
goes further: it keeps \`found_inf\` and the scale on the device and lets \`optimizer.step\` be skipped
without the host ever looking.
:::

:::quiz
Q: The scaler sees an inf gradient on step 2 of a run with growth_interval=4, after one good step. When does the scale next double?
- [ ] After three more good steps, since one good step was already counted
- [x] After four more good steps, because the overflow reset the counter to zero
- [ ] Never, because a scale that once overflowed is not grown again
> Growth requires growth_interval consecutive finite steps. The overflow halves the scale and resets the
> counter, so steps 3–6 are needed and the scale is back at 65536 after step 6.
:::

# Master weights, and what autocast casts

The second failure is in the update, not the gradient. bf16 has about three significant digits: the
spacing between representable values near 1.0 is 2**-7 ≈ 0.0078. An SGD update of \`1e-4\` to a weight of
\`1.0\` stored in bf16 (or fp16, spacing 9.8e-4) rounds back to \`1.0\` — every step. The paper puts the
limit at an update-to-weight ratio of 2**-11 for fp16. Hence the master copy: the optimizer updates fp32
weights, and only the forward sees 16-bit copies. Casting the model with \`.half()\` or \`.bfloat16()\`
throws that away.

\`torch.autocast\` ([docs](https://pytorch.org/docs/stable/amp.html)) does the casting per op, inside the
\`with\` block only:

| op class | examples | runs in |
|---|---|---|
| matmul-like, tensor-core friendly | \`linear\`, \`matmul\`, \`mm\`, \`bmm\`, \`addmm\`, \`conv2d\` | the autocast dtype |
| range- or accumulation-sensitive | \`softmax\`, \`log_softmax\`, \`layer_norm\`, \`exp\`, \`log\`, \`pow\`, \`sum\`, \`nll_loss\` | float32 (on CUDA) |
| multi-input | \`cat\`, \`stack\`, \`addcmul\`, \`index_put\` | the widest input dtype |
| everything else | \`relu\`, \`gelu\`, \`add\`, \`dropout\` | whatever comes in |

- The fp32 parameter is cast once per region and cached; its bf16 copy feeds the matmul, and the backward
  of the cast delivers an fp32 \`.grad\` to the parameter.
- The lists differ between devices (CPU autocast has its own); the drill computes the loss on
  \`logits.float()\` so it is fp32 everywhere.
- The backward runs outside the \`with\` block: autograd replays each op in the dtype its forward used.
- Memory per parameter with Adam is 16 bytes either way: fp32 weight, fp32 gradient and two fp32 moments
  here; fp16 weight and gradient plus fp32 master, \`m\` and \`v\` in the paper's layout. The saving is in
  activations, which dominate at long sequence lengths.

:::quiz
Q: A model is cast with model.bfloat16() and trained with AdamW at lr=1e-5. What goes wrong first?
- [ ] The forward overflows, because bf16 cannot hold activations above 65504
- [x] Small updates round away: a weight near 1.0 cannot move by less than about 0.004 in bf16
- [ ] Nothing: bf16 has fp32's range, so no master copy is needed
> bf16 fixes range, not precision. With spacing 2**-7 near 1.0, any update below half of that rounds back
> to the old value. The fp32 master copy keeps the small updates and only the matmuls see bf16.
:::

# What production adds: fused checks and fp8

- **On-device scale.** \`torch.amp.GradScaler\` keeps the scale and \`found_inf\` as tensors, unscales and
  checks in one fused kernel (\`_amp_foreach_non_finite_check_and_unscale_\`), and its \`update()\` resizes
  the scale on the device: no host sync at all.
- **Sharded master weights.** FSDP's \`MixedPrecision\` policy keeps each rank's shard of the fp32
  weights and all-gathers bf16 copies for the forward; ZeRO does the same for the optimizer state.
- **fp8.** Hopper tensor cores multiply 8-bit floats at twice the bf16 rate. Two formats
  ([Micikevicius et al., 2022](https://arxiv.org/abs/2209.05433)): E4M3 (max 448) for weights and
  activations, E5M2 (max 57344) for gradients. Their range is so narrow that one loss scale is not enough:
  Transformer Engine scales **every tensor** by its own factor, chosen from a history of its recent
  absolute maxima (delayed scaling), and DeepSeek-V3 went to per-tile scales. It is the same game as the
  loss scaler, played per tensor.

| | loss scaler (fp16) | fp8 per-tensor scaling |
|---|---|---|
| what is scaled | the loss, hence every gradient | each weight, activation and gradient tensor |
| how the factor is chosen | backoff on overflow, growth after N good steps | from the tensor's recent amax |
| what overflow costs | one skipped step | a saturated or clipped tensor |

:::quiz
Q: Why does fp8 training need a scale per tensor rather than the loss scaler's single factor?
- [ ] fp8 has no exponent bits, so every value must be rescaled
- [x] Its range is so narrow that tensors with different magnitudes cannot share one factor without some overflowing and others underflowing
- [ ] fp8 gradients are computed in fp32 and only stored in fp8
> E4M3 spans roughly 2**-9 to 448. Activations, weights and gradients differ by orders of magnitude, so each
> tensor gets its own factor, picked from its own amax history.
:::

# What to take away

- fp16 has the range of about 2**-24 to 65504; gradients below it flush to zero. bf16 has fp32's range and
  rarely needs scaling.
- Loss scaling multiplies the loss by a power of two before \`backward\` and divides the gradients in place
  before clipping and the step — exact, because only exponents change.
- A dynamic scaler treats \`inf\`/\`nan\` as a signal: skip the step, multiply by \`backoff_factor\`, reset
  the counter; grow by \`growth_factor\` after \`growth_interval\` clean steps.
- Weights and their gradients stay fp32; \`torch.autocast\` casts per op, matmuls to 16 bits, reductions
  and losses kept in fp32.
- fp8 plays the same game per tensor; on-device scales and fused checks remove the host sync.

Primary reference: Micikevicius et al., [Mixed Precision Training](https://arxiv.org/abs/1710.03740) (ICLR 2018); see also NVIDIA's [mixed precision training guide](https://docs.nvidia.com/deeplearning/performance/mixed-precision-training/index.html).
`;
