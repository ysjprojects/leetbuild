/**
 * The learning guide for the LR-schedule-and-clipping drill: why warmup exists, cosine decay, global-norm
 * clipping against per-parameter clipping, gradient accumulation and its loss division, where zero_grad
 * goes, and what production loops add. Rendered at `/pt-lr-schedule-clip/learn`.
 */
export const learn = `# The mechanism at a glance

Around every \`optimizer.step()\` of an LLM run sit the same few lines: the learning rate for this step
is computed from a schedule, the gradient is accumulated over several micro-batches, its global norm
is measured and clipped, and only then does the optimizer move the weights. nanoGPT, Llama and
Megatron all do it in this order. The drill writes the three pieces by hand in \`train_step.py\`:

- \`lr_at(step, warmup_steps, total_steps, max_lr, min_lr) -> float\` — linear warmup, half-cosine
  decay, then a floor; pure \`math\`.
- \`clip_grad_norm_(params, max_norm) -> Tensor\` — the global L2 norm of every \`.grad\`, the grads
  scaled in place when it exceeds \`max_norm\`, the pre-clip norm returned.
- \`train_step(model, batch_iter, optimizer, accum_steps, step, *, warmup_steps, total_steps, max_lr,
  min_lr, max_norm=1.0)\` — returns \`{"loss", "grad_norm", "lr"}\`.

:::diagram
{
  "nodes": [
    {"id": "batches", "kind": "client", "label": "Micro-batches", "sub": "accum_steps × (x, y) from batch_iter", "x": 8, "y": 50},
    {"id": "step", "kind": "service", "label": "train_step", "sub": "forward · loss / accum_steps · backward", "x": 30, "y": 50},
    {"id": "grads", "kind": "db", "label": ".grad buffers", "sub": "cleared once per step · summed accum_steps times", "x": 54, "y": 24},
    {"id": "clip", "kind": "service", "label": "clip_grad_norm_ · lr_at", "sub": "one global norm → one scale · step → LR", "x": 54, "y": 76},
    {"id": "optimizer", "kind": "service", "label": "optimizer", "sub": "every param_groups[\\"lr\\"] = lr · step()", "x": 84, "y": 50}
  ],
  "edges": [
    {"from": "batches", "to": "step", "kind": "plain", "label": "next(batch_iter)"},
    {"from": "step", "to": "grads", "kind": "plain", "label": "backward() adds"},
    {"from": "grads", "to": "clip", "kind": "plain", "label": "norm of norms · mul_"},
    {"from": "clip", "to": "optimizer", "kind": "plain", "label": "lr · clipped grads"},
    {"from": "optimizer", "to": "step", "kind": "plain", "label": "{loss, grad_norm, lr}"}
  ]
}
:::

The order inside one call is fixed, and each position is there for a reason the rest of this guide
explains:

\`\`\`python
optimizer.zero_grad(set_to_none=True)          # once, before the loop
for _ in range(accum_steps):
    x, y = next(batch_iter)
    loss = F.cross_entropy(model(x), y) / accum_steps
    loss.backward()                            # .grad += ∂(loss / accum_steps)/∂θ
grad_norm = clip_grad_norm_(model.parameters(), max_norm)
lr = lr_at(step, warmup_steps, total_steps, max_lr, min_lr)
for group in optimizer.param_groups:
    group["lr"] = lr
optimizer.step()
\`\`\`

# Why the learning rate starts small

At step 0 an Adam-family optimizer knows almost nothing about the gradient's scale. Its second-moment
estimate \`v\` is built from one or two samples; bias correction removes the bias towards zero but not
the noise. The update \`m / √v\` divides by that noisy estimate, so a coordinate whose first gradients
happened to be small gets a huge step. At full learning rate a few such steps push the weights into a
region where activations blow up, attention logits saturate and the loss never comes back.

Two lines of work explain the fix:

- [Goyal et al. 2017](https://arxiv.org/abs/1706.02677) (ImageNet in one hour) used a linear
  **warmup** to make very large batches train with SGD: start at a fraction of the target LR, ramp up
  over the first epochs, while the network leaves its unstable random-initialisation regime.
- [Liu et al. 2019 (RAdam)](https://arxiv.org/abs/1908.03265) showed that for Adam the problem is the
  variance of the adaptive LR itself, which is unbounded in the first steps; warmup is a hand-made
  variance reduction, and RAdam builds the same correction into the optimizer.

Transformers are especially sensitive (post-LN models barely train without warmup), so every LLM
recipe warms up — a few hundred to a few thousand steps. The drill's ramp:

\`\`\`text
step < warmup_steps:   lr = max_lr × (step + 1) / warmup_steps
\`\`\`

The \`+ 1\` makes step 0 one warmup slice rather than 0: a step at LR 0 is a wasted forward-backward.
With the self-test's settings (\`warmup 10, total 100, max_lr 1e-3, min_lr 1e-5\`):

| step | phase | lr |
|---|---|---|
| 0 | warmup, first slice | 1.00e-04 |
| 9 | warmup, last slice | 1.00e-03 |
| 10 | decay, progress 0 | 1.00e-03 |
| 55 | decay, progress 0.5 | 5.05e-04 |
| 100 | at total_steps | 1.00e-05 |
| 1000 | past the end | 1.00e-05 |

:::quiz
Q: Why does warmup help Adam even though Adam already has bias correction?
- [ ] Bias correction is only applied after warmup ends
- [x] Bias correction fixes the mean of the second-moment estimate, not its variance — early on it is built from a few samples, so the per-coordinate step size is noisy and occasionally huge
- [ ] Warmup lets the weight decay act before the gradient does
> Bias correction rescales \`v\` so it is unbiased, but an unbiased estimate from two samples is still wild. A small LR keeps those noisy early steps small until \`v\` has averaged over enough gradients.
:::

# Cosine decay to a floor

After warmup the LR must come down: a large LR explores, a small one settles into a minimum.
[Loshchilov & Hutter's SGDR](https://arxiv.org/abs/1608.03983) introduced cosine annealing (with
warm restarts); LLM training uses a single half-cosine without restarts, from \`max_lr\` at the end of
warmup to \`min_lr\` at \`total_steps\`:

\`\`\`text
progress = (step − warmup_steps) / (total_steps − warmup_steps)        in [0, 1)
lr       = min_lr + 0.5 × (1 + cos(π × progress)) × (max_lr − min_lr)
step >= total_steps:  lr = min_lr
\`\`\`

- Progress 0 gives \`cos 0 = 1\`, so \`max_lr\`; progress 1 gives \`cos π = −1\`, so \`min_lr\`; halfway it is
  exactly \`(max_lr + min_lr) / 2\` — the self-test's \`5.05e-04\`.
- The curve is flat at both ends: it lingers near the peak, drops fastest in the middle, and eases into
  the floor. A linear decay spends equal time at every LR.
- The floor is typically a tenth of \`max_lr\` (Chinchilla, Llama) — here a hundredth. Training past
  \`total_steps\` stays there instead of the cosine swinging back up.

The schedule is a **pure function of the step**, not a stateful scheduler object. A run restored from
a checkpoint needs nothing but its step counter to land on exactly the LR it had; nanoGPT's \`get_lr\`
is this function, and HuggingFace's \`get_cosine_schedule_with_warmup\` wraps the same formula in a
\`LambdaLR\`. The LR is written into **every** \`param_groups\` entry because real runs have at least two
groups — weight-decayed matrices and undecayed biases and norms — and both must follow the schedule.

:::details Warmup-stable-decay: the schedule that does not need total_steps
A cosine fixes the run length up front: to train longer you must restart the decay. WSD schedules
(used by MiniCPM, DeepSeek and others) warm up, hold \`max_lr\` constant for most of the run, and decay
over only the last ~10–20% of steps. Any checkpoint from the stable phase can be branched off and
cooled down, so one long run yields models at several token budgets, and the final loss matches a
cosine of the same length.
:::

:::quiz
Q: Why is the LR computed as \`lr_at(step)\` and assigned each step rather than kept in a scheduler object that is stepped?
- [ ] A function is faster than a scheduler object
- [x] A pure function of the step counter gives the exact LR after a restart from a checkpoint, and assigning it to every param group keeps all groups on the schedule
- [ ] PyTorch optimizers ignore schedulers when there are multiple param groups
> Stateful schedulers must have their own state saved and restored in sync with the optimizer; getting that wrong silently shifts the schedule. \`lr_at(step)\` has no state to lose.
:::

# Clipping by the global norm

[Pascanu, Mikolov & Bengio 2013](https://arxiv.org/abs/1211.5063) studied exploding gradients in
recurrent nets: occasionally the loss surface has a cliff, the gradient there is enormous, and one
step throws the weights far away. Their fix is to rescale the gradient when its norm is too large —
keep the direction, bound the length. Transformers inherited it; \`max_norm = 1.0\` is in almost every
published LLM config.

The drill computes one norm over the whole model — the norm of the per-tensor norms:

\`\`\`python
grads = [p.grad for p in params if p.grad is not None]   # params may be a generator: read once
total_norm = torch.stack([g.norm(2.0) for g in grads]).norm(2.0)
clip_coef = max_norm / (total_norm + 1e-6)
if clip_coef < 1.0:
    for g in grads:
        g.mul_(clip_coef)
return total_norm                                         # before clipping
\`\`\`

| choice | global norm (the drill) | per-parameter norm | clip by value |
|---|---|---|---|
| what is bounded | the whole update vector | each tensor separately | each element |
| direction of the update | unchanged | changed: tensors rescaled by different factors | changed |
| a spike in one layer | scales every layer down together | shrinks only that layer | flattens the spike's elements |
| PyTorch | \`clip_grad_norm_\` | loop of \`clip_grad_norm_\` per tensor | \`clip_grad_value_\` |

- Global clipping is a step-length limit: the optimizer still goes downhill in the gradient's
  direction, just not as far. Per-tensor or per-element clipping changes which way it goes.
- The \`1e-6\` keeps a zero gradient from dividing by zero; the \`clip_coef < 1\` guard keeps a small
  gradient from being scaled *up* to \`max_norm\`.
- The pre-clip norm is returned and logged because it is the earliest warning in a training log: loss
  spikes are usually preceded by grad-norm spikes, and a run that clips on every step has an LR
  problem, not a clipping solution.
- On the self-test the norm is \`0.6876\` and \`max_norm=0.1\`, so every grad is multiplied by about
  0.145 and the post-clip norm is \`0.1000\`, matching \`torch.nn.utils.clip_grad_norm_\`.

:::quiz
Q: One layer's gradient spikes to 100× its usual size. What does global-norm clipping do that per-parameter clipping does not?
- [ ] It zeroes the spiking layer's gradient
- [ ] It clips only the spiking layer and leaves the others at full size
- [x] It scales every layer's gradient by the same factor, so the update keeps its direction and only its length is bounded
> One scale factor for the whole gradient vector preserves direction. Per-tensor clipping would shrink the spiking layer alone, changing the relative sizes of the layers' updates.
:::

# Accumulation and the division by accum_steps

A 0.5M-token batch does not fit on one GPU. Gradient accumulation runs it as several micro-batches and
lets \`backward()\` add into the \`.grad\` buffers before one optimizer step. It is exact, but only with
two details right:

- **Divide each micro-batch loss by** \`accum_steps\` **before** \`backward()\`. \`cross_entropy\` is a
  mean over its micro-batch; the mean over 16 examples is the mean of four means over 4, i.e. the sum
  of four losses each divided by four. Gradients are linear, so the summed gradient is the big-batch
  gradient.
- **Clear the buffers once per optimizer step**, before the loop — \`zero_grad\` inside the loop would
  throw away all but the last micro-batch.

\`set_to_none=True\` makes the first \`backward\` *assign* \`.grad\` instead of adding into a zeroed
tensor, saving a memset and a read of every gradient. The returned \`"loss"\` is the sum of the scaled
micro-batch losses — exactly the big-batch loss.

The failure the division prevents, with \`accum_steps = 4\` and the division forgotten:

:::sequence
{
  "participants": ["train_step", "model", ".grad buffers", "clip_grad_norm_", "optimizer"],
  "messages": [
    {"from": "train_step", "to": ".grad buffers", "label": "zero_grad(set_to_none=True)", "kind": "sync"},
    {"from": "train_step", "to": "model", "label": "4 × forward · loss (not / 4) · backward()", "kind": "sync"},
    {"from": "model", "to": ".grad buffers", "label": ".grad = g₁ + g₂ + g₃ + g₄ = 4 × big-batch gradient", "kind": "async"},
    {"from": "train_step", "to": "clip_grad_norm_", "label": "norm is 4× too large", "kind": "sync"},
    {"from": "clip_grad_norm_", "to": ".grad buffers", "label": "clips far more often — hides the bug, distorts the step", "kind": "async"},
    {"from": "train_step", "to": "optimizer", "label": "step(): SGD moves 4× too far; logged loss 4× too high", "kind": "sync"}
  ]
}
:::

- With plain SGD the effective LR is multiplied by \`accum_steps\`; changing \`accum_steps\` to fit a new
  GPU silently changes the training dynamics.
- Adam is nearly scale-invariant (\`m / √v\`), so the step is roughly unchanged — which is why the bug
  survives — but \`eps\` and the clipping threshold are no longer calibrated, and the logged grad norm
  and loss are wrong.
- The drill's self-test catches it directly: four micro-batches of 4 must give the same loss, gradient
  and parameters (with SGD) as one batch of 16.

:::quiz
Q: Where must \`optimizer.zero_grad(set_to_none=True)\` go in an accumulating step?
- [ ] Inside the micro-batch loop, before each \`backward()\`
- [x] Once, before the loop, so all \`accum_steps\` backward passes add into the same buffers
- [ ] After \`optimizer.step()\` only, never before the loop
> Inside the loop it would discard every micro-batch's gradient but the last. Clearing once per optimizer step is what makes the buffers accumulate.
:::

# What production loops add

The shape stays; the pieces get faster and distributed:

| addition | what it does |
|---|---|
| fused clipping | \`torch.nn.utils.clip_grad_norm_(..., foreach=True)\` computes all norms and the scale in a handful of multi-tensor kernels instead of one per parameter |
| mixed precision | under fp16 \`scaler.unscale_(optimizer)\` must come before the clip, so the norm is of the real gradients, not the loss-scaled ones |
| DDP | the first \`accum_steps − 1\` micro-batches run under \`no_sync()\` so the gradient all-reduce happens once per optimizer step |
| FSDP / ZeRO | each rank holds a shard of the gradient; the per-shard squared norms are all-reduced before the scale is applied |
| WSD and token-based schedules | the LR is a function of tokens seen or held flat for most of the run, decayed only at the end |
| loss-spike handling | grad-norm and loss monitored every step; on a spike, runs (PaLM, OPT) rewind to an earlier checkpoint and skip the offending data batches |

Megatron and nanoGPT log exactly the three numbers \`train_step\` returns — loss, pre-clip grad norm,
LR — on every step; they are the first plots anyone looks at when a run misbehaves.

# What to take away

- Warmup exists because an adaptive optimizer's step-size estimate is noise in the first steps; ramp
  linearly from \`max_lr / warmup_steps\`, never from 0.
- Cosine decay is a pure function of the step — \`min_lr + 0.5 × (1 + cos(π × progress)) × (max_lr −
  min_lr)\`, \`min_lr\` after \`total_steps\` — written into every param group.
- Clip by the global norm: one scale for the whole gradient keeps its direction; scale only when over
  \`max_norm\`, and log the norm before clipping.
- Accumulate by dividing each micro-batch loss by \`accum_steps\` before \`backward()\` and clearing the
  buffers once per step; forgetting the division multiplies the gradient by \`accum_steps\`.
- Order: zero once, accumulate, clip, set the LR, step.

Primary reference: [Pascanu, Mikolov & Bengio, On the difficulty of training recurrent neural networks](https://arxiv.org/abs/1211.5063).
`;
