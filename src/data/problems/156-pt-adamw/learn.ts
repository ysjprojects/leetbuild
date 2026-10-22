/**
 * The learning guide for the AdamW drill: Adam's two moments and their bias correction, why L2 added to
 * the gradient is not weight decay under Adam, the decoupled decay of Loshchilov & Hutter, where eps
 * goes, AMSGrad, and the memory the optimizer state costs — plus what foreach/fused kernels and
 * sharding add. Rendered at `/pt-adamw/learn`.
 */
export const learn = `# The mechanism at a glance

AdamW is the optimizer under GPT, LLaMA and ViT training. It is Adam — a per-coordinate step size from
running averages of the gradient and its square — with one change from Loshchilov & Hutter's
*Decoupled Weight Decay Regularization*: weight decay shrinks the parameter directly instead of being
added to the gradient. The drill implements \`AdamW.step(self, closure=None)\` on a
\`torch.optim.Optimizer\` subclass whose constructor already stores \`lr\`, \`betas\`, \`eps\`,
\`weight_decay\` and \`amsgrad\` as group defaults.

:::diagram
{
  "nodes": [
    {"id": "loop", "kind": "client", "label": "Training loop", "sub": "zero_grad · backward · step(closure)", "x": 10, "y": 50},
    {"id": "optim", "kind": "service", "label": "AdamW.step()", "sub": "decay · moments · bias-correct · update, under no_grad", "x": 40, "y": 50},
    {"id": "params", "kind": "db", "label": "Parameters", "sub": "p shrinks by (1 − lr·wd), then moves by addcdiv_", "x": 70, "y": 25},
    {"id": "state", "kind": "db", "label": "self.state[p]", "sub": "step · exp_avg · exp_avg_sq (· max_exp_avg_sq) — 2× the params", "x": 70, "y": 75},
    {"id": "ref", "kind": "external", "label": "torch.optim.AdamW", "sub": "the same trajectory, within 1e-7 in float64", "x": 40, "y": 90}
  ],
  "edges": [
    {"from": "loop", "to": "optim", "kind": "plain", "label": "step(closure)"},
    {"from": "optim", "to": "params", "kind": "plain", "label": "read grad · mul_ · addcdiv_"},
    {"from": "optim", "to": "state", "kind": "plain", "label": "create once · update in place"},
    {"from": "loop", "to": "ref", "kind": "plain", "label": "same batch, compare every step"}
  ]
}
:::

The whole update, per parameter \`p\` with gradient \`g\` at step \`t\`:

\`\`\`text
p     ← p · (1 − lr · wd)                       decoupled decay, on the parameter
m     ← β1 · m + (1 − β1) · g                   exp_avg
v     ← β2 · v + (1 − β2) · g²                  exp_avg_sq
bc1   = 1 − β1^t        bc2 = 1 − β2^t
denom = √v / √bc2 + eps                         eps after the square root
p     ← p − (lr / bc1) · m / denom              p.addcdiv_(exp_avg, denom, value=-step_size)
\`\`\`

- Defaults: \`lr=1e-3\`, \`betas=(0.9, 0.999)\`, \`eps=1e-8\`, \`weight_decay=1e-2\`, \`amsgrad=False\`.
- State is lazy: \`self.state[p]\` is empty until \`step\` first meets \`p\` with a gradient; then
  \`step = 0\` and zero tensors for \`exp_avg\`, \`exp_avg_sq\` (and \`max_exp_avg_sq\` with \`amsgrad\`).
- A parameter whose \`p.grad is None\` is skipped and never gets state; a sparse gradient raises
  \`RuntimeError\`.
- Everything is in place under \`@torch.no_grad()\`; a closure runs under \`torch.enable_grad()\` and
  its loss is returned.

:::sequence
{
  "participants": ["training loop", "AdamW.step", "self.state[p]", "parameter p"],
  "messages": [
    {"from": "training loop", "to": "AdamW.step", "label": "step(closure) — under torch.no_grad()", "kind": "sync"},
    {"from": "AdamW.step", "to": "training loop", "label": "closure() under enable_grad → loss, p.grad", "kind": "reply"},
    {"from": "AdamW.step", "to": "self.state[p]", "label": "first sight: step=0, exp_avg=0, exp_avg_sq=0", "kind": "sync"},
    {"from": "AdamW.step", "to": "self.state[p]", "label": "step += 1 → t", "kind": "sync"},
    {"from": "AdamW.step", "to": "parameter p", "label": "p.mul_(1 − lr·wd)", "kind": "sync"},
    {"from": "AdamW.step", "to": "self.state[p]", "label": "m, v updated in place", "kind": "sync"},
    {"from": "AdamW.step", "to": "parameter p", "label": "p.addcdiv_(m, denom, value=−lr/bc1)", "kind": "sync"},
    {"from": "AdamW.step", "to": "training loop", "label": "loss", "kind": "reply"}
  ]
}
:::

# Two moments and why they need correcting

[Adam](https://arxiv.org/abs/1412.6980) (Kingma & Ba) keeps two exponential moving averages per
coordinate. \`m\` estimates the gradient's mean — momentum. \`v\` estimates its uncentred second
moment, so \`√v\` is the typical size of that coordinate's gradient. The step \`m / √v\` is then roughly
unit-sized whatever the gradient's scale: a coordinate with tiny gradients moves as far as one with huge
ones, and \`lr\` becomes a step length in parameter units.

Both averages start at zero, so early on they are biased towards zero. After \`t\` steps of a constant
gradient \`g\`, \`m = (1 − β1^t) · g\` and \`v = (1 − β2^t) · g²\`. Dividing by those factors removes the
bias exactly:

| step t | bc1 = 1 − 0.9^t | bc2 = 1 − 0.999^t | uncorrected first step per unit lr |
|---|---|---|---|
| 1 | 0.1 | 0.001 | (1 − β1) / √(1 − β2) ≈ 3.2× too large |
| 10 | 0.65 | 0.010 | still far off |
| 100 | ≈ 1.0 | 0.095 | v still under-estimated ~10× |
| 1000 | 1.0 | 0.63 | close |

- \`bc1\` folds into the step size: \`step_size = lr / bias_correction1\`.
- \`bc2\` divides the second moment before the root: \`√(v / bc2) = √v / √bc2\`, written as
  \`exp_avg_sq.sqrt() / math.sqrt(bias_correction2)\`.
- With correction, step 1 moves every coordinate by about \`lr\` — exactly \`lr · sign(g)\` up to eps.
- Correction matters for the first few hundred steps only, which is also why warm-up schedules exist:
  even corrected, \`v\` from a handful of samples is a noisy scale estimate.

The moments are updated in place — \`exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)\` and
\`exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)\` — never rebound to new tensors, so the
state dict keeps pointing at the same storage and no step allocates.

:::quiz
Q: Without bias correction, what happens on the very first step with the default betas?
- [ ] Nothing: the moments start at zero, so the parameter does not move
- [x] Every coordinate moves about 3.2× further than lr, because m is shrunk by 0.1 but √v by √0.001
- [ ] The step is 10× too small, because m is multiplied by 1 − β1 = 0.1
> m = 0.1·g and √v = √0.001·|g| ≈ 0.0316·|g|, so m / √v ≈ 3.16·sign(g). The second moment is biased
> more strongly than the first, and the ratio overshoots; dividing m by bc1 and v by bc2 brings it to 1.
:::

# Why L2 in the gradient is not weight decay under Adam

For plain SGD, adding \`wd · p\` to the gradient and shrinking \`p\` by \`lr · wd\` are the same thing.
Under Adam they are not: whatever is added to the gradient also passes through \`m / √v\`. The decay
term is divided by the coordinate's gradient scale, so weights with large gradients — the ones that
most need regularising — are barely decayed, and weights with tiny gradients are decayed hard.

:::sequence
{
  "participants": ["AdamW.step", "grad", "self.state[p]", "parameter p"],
  "messages": [
    {"from": "AdamW.step", "to": "grad", "label": "naive: g ← g + wd·p (L2 regularised Adam)", "kind": "sync"},
    {"from": "AdamW.step", "to": "self.state[p]", "label": "wd·p enters m and v", "kind": "sync"},
    {"from": "self.state[p]", "to": "AdamW.step", "label": "decay term divided by √v — large-gradient weights barely shrink", "kind": "reply"},
    {"from": "AdamW.step", "to": "parameter p", "label": "AdamW: p.mul_(1 − lr·wd) — same shrink for every weight", "kind": "sync"},
    {"from": "AdamW.step", "to": "self.state[p]", "label": "moments see only the loss gradient", "kind": "sync"}
  ]
}
:::

| | L2-regularised Adam | AdamW |
|---|---|---|
| where wd acts | added to \`grad\` | \`p.mul_(1 - lr * weight_decay)\` |
| goes through \`m / √v\` | yes | no |
| shrink per step | depends on the coordinate's gradient history | \`lr · wd\` for every weight |
| moments contaminated by decay | yes | no |
| optimal wd depends on lr | strongly | much less (the paper's main empirical finding) |

- The decay runs **before** the moment updates and \`addcdiv_\`, as in \`torch.optim.AdamW\`: the shrink
  applies to the parameter the gradient was computed from.
- The decay is scaled by \`lr\`, so a cosine or warm-up schedule anneals decay together with the step.
- Never add \`weight_decay * p\` to \`grad\`: with \`weight_decay=0.1\` the trajectories split at step 1.

:::details Then what does torch.optim.Adam's weight_decay do?
\`torch.optim.Adam(weight_decay=…)\` is the L2 form: it adds \`wd · p\` to the gradient. That is why
AdamW exists as a separate class rather than a flag, and why swapping one for the other at the same
\`weight_decay\` changes training: the useful values differ by orders of magnitude.
:::

:::quiz
Q: A weight's gradient is consistently 100× larger than its neighbour's. Under L2-regularised Adam, how does its decay compare?
- [ ] Equal: the decay term wd·p does not depend on the gradient
- [x] About 100× weaker, because the decay term is divided by √v, which is dominated by the large gradient
- [ ] About 100× stronger, because the decay term is multiplied by the gradient scale
> Adam normalises each coordinate by its own √v. Once wd·p is part of the gradient it is normalised too,
> so large-gradient weights get almost no decay. AdamW applies lr·wd to the parameter directly.
:::

# Where eps goes, and AMSGrad

\`eps\` keeps the division finite when \`v\` is near zero. It goes **after** the square root:

\`\`\`python
denom = (exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)   # √v̂ + eps
\`\`\`

| form | eps acts as | effect with eps = 1e-8 |
|---|---|---|
| \`√v̂ + eps\` (Adam, PyTorch) | a floor on the denominator | invisible unless the gradient scale is ≲ 1e-8 |
| \`√(v̂ + eps)\` | a perturbation of the variance | a floor of 1e-4 on the denominator — a different optimizer |

- \`sqrt(v + eps)\` does not match the reference, and \`eps\` there behaves like a much larger constant.
- Large \`eps\` (1e-6 to 1e-3) is a real tuning knob: it caps the step for near-zero-gradient coordinates
  and turns Adam towards momentum SGD. Low-precision training often raises it because \`v\` underflows.

[AMSGrad](https://openreview.net/forum?id=ryQu7f-RZ) (Reddi et al., *On the Convergence of Adam and
Beyond*) showed Adam can fail to converge when a rare large gradient is forgotten too fast: \`v\`
decays, the effective step grows again. The fix keeps the running maximum of \`v\`:

\`\`\`python
torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)
denom = (max_exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)
\`\`\`

- The per-coordinate step can then only shrink over time, which restores the convergence proof.
- \`max_exp_avg_sq\` exists in state only when \`amsgrad=True\`: \`("max_exp_avg_sq" in state) == amsgrad\`.
- In practice it is rarely enabled for LLM training; it costs a third state tensor.

:::quiz
Q: Why is sqrt(exp_avg_sq + eps) not a harmless rewrite of sqrt(exp_avg_sq) + eps?
- [ ] It is harmless; the two differ only in the last ulp
- [ ] It divides by zero when the gradient is zero
- [x] The square root of eps = 1e-8 is 1e-4, so the denominator gets a floor 10,000× larger and small-gradient steps shrink
> Inside the root, eps is added to a variance and its square root becomes the floor: √1e-8 = 1e-4. Outside,
> it is a 1e-8 floor on the gradient scale. Same symbol, different optimizer.
:::

# The Optimizer contract and the state it costs

\`torch.optim.Optimizer\` owns the parts that are not arithmetic: \`param_groups\` (lists of parameters
with their own \`lr\`, \`betas\`, \`weight_decay\` — e.g. no decay for norms and biases) and \`state\`, a
dict keyed by parameter. The step loops over \`self.param_groups\` and \`group["params"]\`.

- \`@torch.no_grad()\` makes \`p.mul_\` and \`p.addcdiv_\` on leaf tensors legal and untracked.
  \`p.data\` or \`p = p - …\` would dodge autograd's bookkeeping or replace the leaf the model holds.
- The closure contract (from LBFGS) re-evaluates the loss: \`with torch.enable_grad(): loss = closure()\`.
- Lazy state means a frozen parameter costs nothing, and \`state_dict()\` saves only what exists.

The memory is the real cost:

| tensor | per parameter, fp32 state | 7B model |
|---|---|---|
| weight (bf16 / fp32) | 2 / 4 bytes | 14 / 28 GB |
| \`exp_avg\` | 4 bytes | 28 GB |
| \`exp_avg_sq\` | 4 bytes | 28 GB |
| \`max_exp_avg_sq\` (amsgrad) | 4 bytes | 28 GB |

The two moments weigh twice the model in \`float32\` — 8 bytes per parameter on top of the 2 or 4 the
weight takes. That is why [ZeRO](https://arxiv.org/abs/1910.02054) and FSDP shard \`exp_avg\` and
\`exp_avg_sq\` across data-parallel ranks first, and why 8-bit and factored optimizers exist.

:::quiz
Q: For a 7B-parameter model with bf16 weights, how does AdamW's state compare with the weights?
- [ ] About the same: one moment per weight
- [x] About 4× the weights: two fp32 moments are 8 bytes against the weight's 2
- [ ] Negligible: state is created lazily
> Lazy creation only skips parameters without gradients. Every trained parameter gets exp_avg and exp_avg_sq,
> 4 bytes each in fp32: 56 GB against 14 GB of bf16 weights.
:::

# What production implementations add

The drill's per-parameter Python loop launches several small kernels per tensor. \`torch.optim.AdamW\`
([docs](https://pytorch.org/docs/stable/generated/torch.optim.AdamW.html)) has faster paths with the
same arithmetic:

| implementation | what it does | why it is faster |
|---|---|---|
| for-loop (this drill) | one op at a time per parameter | — |
| \`foreach\` (default on CUDA) | each op once over the list of all parameters | one launch per op instead of per tensor |
| \`fused\` | the whole update in one kernel | one read and write of p, m, v per step |

- Together these are 2–10× faster than the per-parameter loop.
- \`capturable\` keeps \`state["step"]\` as a tensor on device so the step can be recorded into a CUDA graph
  (here it is a Python \`int\`).
- The reference uses \`lerp_\` for \`m\`; in \`float32\` that differs from \`mul_().add_()\` in the last ulp,
  which is why the drill compares in \`float64\`.
- \`maximize\` flips the sign for gradient ascent; distributed training shards the state (ZeRO/FSDP).

:::quiz
Q: Why is the foreach implementation faster when the arithmetic is identical?
- [ ] It skips bias correction after warm-up
- [x] It launches one kernel per operation over all parameters instead of one per parameter, removing launch overhead
- [ ] It stores the moments in bf16
> A model has hundreds of parameter tensors; the loop pays a kernel launch for each op on each of them.
> foreach batches the list; fused goes further and does the whole update in one pass over memory.
:::

# What to take away

- Adam divides an EMA of the gradient by the root of an EMA of its square: a unit-sized step per coordinate.
- Bias correction (\`1 − β1^t\`, \`1 − β2^t\`) fixes the zero-initialised moments; without it step 1 is ~3.2× too large.
- L2 added to the gradient is divided by \`√v\` and stops being decay; AdamW shrinks \`p\` by \`lr · wd\` directly.
- \`eps\` goes after the square root; AMSGrad keeps a running maximum of \`v\` in state.
- The state costs two fp32 tensors per parameter; foreach/fused kernels and ZeRO sharding are what make it cheap.

Primary reference: Loshchilov & Hutter, [Decoupled Weight Decay Regularization](https://arxiv.org/abs/1711.05101) (ICLR 2019).
`;
