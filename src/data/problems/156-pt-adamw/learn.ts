/**
 * The learning guide for the AdamW drill: Adam's two moments and their bias correction, why L2 added to
 * the gradient is not weight decay under Adam, the decoupled decay of Loshchilov & Hutter, where eps
 * goes, AMSGrad, a worked two-step example, and the memory the optimizer state costs, plus what
 * foreach/fused kernels and sharding add. Rendered at `/pt-adamw/learn`.
 */
export const learn = `# The mechanism at a glance

AdamW is the default optimizer for transformer training (GPT-1 and LLaMA, among many). It is Adam, a
per-coordinate step size from running averages of the gradient and its square, with one change from
Loshchilov & Hutter's *Decoupled Weight Decay Regularization*: weight decay shrinks the parameter
directly instead of being added to the gradient. The drill implements \`AdamW.step(self, closure=None)\` on a
\`torch.optim.Optimizer\` subclass whose constructor already stores \`lr\`, \`betas\`, \`eps\`,
\`weight_decay\` and \`amsgrad\` as group defaults. One training step through it, read bottom to top, with
what AdamW changes in the accent colour:

:::architecture
{
  "input": "MLP params · lr = 1e-2 · wd = 0.1",
  "items": [
    {"tone": "block", "repeat": "for each step", "label": "Training loop", "items": [
      {"id": "backward", "label": "loss.backward()", "sub": "mse_loss(model(x), y) → p.grad", "kind": "loss"},
      {"tone": "dotted", "label": "AdamW.step() · each p with a grad", "items": [
        {"id": "grad", "label": "Gradient g_t", "sub": "g = p.grad · skip if None", "kind": "io"},
        {"id": "count", "label": "Step count t", "sub": "state[\\"step\\"] += 1", "kind": "memory",
         "side": {"label": "self.state[p]", "sub": "created on first sight"},
         "detail": "Empty until \`step\` first meets \`p\` with a gradient; then \`step = 0\` and zero tensors for the moments."},
        {"columns": [
          [{"id": "m", "label": "First moment m_t", "sub": "m = β₁m + (1 − β₁)g", "kind": "memory",
            "detail": "\`exp_avg\`: an EMA of the gradient, momentum."}],
          [{"id": "v", "label": "Second moment v_t", "sub": "v = β₂v + (1 − β₂)g²", "kind": "memory",
            "detail": "\`exp_avg_sq\`: an EMA of the squared gradient; \`√v\` is the coordinate's gradient scale."},
           {"id": "amsgrad", "label": "AMSGrad running max", "sub": "only when amsgrad=True", "kind": "memory",
            "detail": "\`max_exp_avg_sq\`, used in place of \`exp_avg_sq\` in the denominator."}]
        ]},
        {"id": "bias", "label": "Bias correction", "sub": "bc1 = 1 − β₁ᵗ · bc2 = 1 − β₂ᵗ",
         "detail": "\`step_size = lr / bc1\`; \`bc2\` divides \`v\` under the root."},
        {"id": "denom", "label": "Denominator", "sub": "√v / √bc2 + eps",
         "detail": "\`eps\` is added after the square root, a floor on the gradient scale."},
        {"id": "decay", "label": "Decoupled weight decay", "sub": "p.mul_(1 − lr·wd)", "kind": "attention",
         "detail": "The one change from Adam. The reference runs it first; neither moment reads \`p\`, so the result is the same."},
        {"id": "update", "label": "Adam update", "sub": "p.addcdiv_(m, denom, −lr/bc1)",
         "detail": "\`p ← p − (lr / bc1) · m / denom\`, in place under \`@torch.no_grad()\`."}
      ]}
    ]},
    {"id": "trained", "label": "Trained parameters", "sub": "p after 25 steps", "kind": "io"}
  ],
  "notes": [
    {"at": "v", "text": "Two fp32 moments: **8** bytes per parameter"},
    {"at": "bias", "text": "Uncorrected step 1 is **3.2 ×** too large"},
    {"at": "denom", "text": "eps = **1e-8**, added after the root"},
    {"at": "decay", "text": "The same **lr · wd** shrink for every weight"},
    {"at": "trained", "text": "Within **1e-7** of torch.optim.AdamW"}
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

What \`self.state[p]\` holds over a run:

| When | \`step\` | \`exp_avg\` | \`exp_avg_sq\` | \`max_exp_avg_sq\` |
|---|---|---|---|---|
| before its first gradient | absent | absent | absent | absent |
| first sight, before the update | \`0\` | \`zeros_like(p)\` | \`zeros_like(p)\` | \`zeros_like(p)\`, only with \`amsgrad\` |
| after step \`t\` | \`t\` | \`m_t\` | \`v_t\` | \`max(v_1, …, v_t)\` |
| a frozen parameter, ever | absent | absent | absent | absent |

# Two moments and why they need correcting

[Adam](https://arxiv.org/abs/1412.6980) (Kingma & Ba) keeps two exponential moving averages per
coordinate.

**Refresher: an exponential moving average (EMA).** \`a ← β · a + (1 − β) · x\` blends each new sample
\`x\` into a running value. A sample's weight decays by \`β\` per step, so the average remembers roughly the
last \`1 / (1 − β)\` samples: 10 steps for \`β1 = 0.9\`, 1,000 for \`β2 = 0.999\`.

\`m\` estimates the gradient's mean (momentum). \`v\` estimates its uncentred second moment, so \`√v\` is
the typical size of that coordinate's gradient. The step \`m / √v\` is then roughly unit-sized whatever
the gradient's scale: a coordinate with tiny gradients moves as far as one with huge ones, and \`lr\`
becomes a step length in parameter units. Compare Adam's path with plain SGD's and momentum's on an
ill-conditioned loss:

:::widget optimizer-paths

Both averages start at zero, so early on they are biased towards zero. After \`t\` steps of a constant
gradient \`g\`, \`m = (1 − β1^t) · g\` and \`v = (1 − β2^t) · g²\` (the missing weight \`β^t\` is still on
the zero start). Dividing by those factors removes the bias exactly. Without it, the step for a constant
gradient is \`bc1 / √bc2\` times too large:

| step t | bc1 = 1 − 0.9^t | bc2 = 1 − 0.999^t | uncorrected step ÷ corrected = bc1 / √bc2 |
|---|---|---|---|
| 1 | 0.1 | 0.001 | 3.2 |
| 12 | 0.72 | 0.012 | 6.6 (the peak) |
| 100 | ≈ 1.0 | 0.095 | 3.2 |
| 1000 | 1.0 | 0.63 | 1.26 |
| 5000 | 1.0 | 0.993 | 1.003 |

- \`bc1\` folds into the step size: \`step_size = lr / bias_correction1\`.
- \`bc2\` divides the second moment before the root: \`√(v / bc2) = √v / √bc2\`, written as
  \`exp_avg_sq.sqrt() / math.sqrt(bias_correction2)\`.
- With correction, step 1 moves every coordinate by about \`lr\`: exactly \`lr · g / (|g| + eps)\`, so
  \`lr · sign(g)\` up to eps.
- \`m\` is unbiased within a few dozen steps, \`v\` only after a few thousand (its memory is 1,000 steps).
  Even corrected, \`v\` from a handful of samples is a noisy scale estimate, one reason LLM runs warm
  the learning rate up (LLaMA: 2,000 steps).

The moments are updated in place (\`exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)\` and
\`exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)\`), never rebound to new tensors, so the
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

**Refresher: L2 regularisation.** Adding \`wd/2 · ‖p‖²\` to the loss adds \`wd · p\` to the gradient. For
plain SGD (no momentum), that gradient term and shrinking \`p\` by \`lr · wd\` per step are the same thing.
Under Adam they are not: whatever is added to the gradient also passes through \`m / √v\`. The decay
term is divided by the coordinate's gradient scale, so weights with large gradients are barely decayed
and weights with tiny gradients are decayed hard. That is L2-regularised Adam,
\`torch.optim.Adam(weight_decay=…)\`; set it beside the AdamW figure at the top:

:::architecture
{
  "input": "p.grad",
  "items": [
    {"id": "g", "label": "Loss gradient g", "sub": "g = p.grad", "kind": "io"},
    {"id": "l2", "label": "L2 term added", "sub": "g ← g + wd·p", "kind": "attention",
     "side": {"label": "wd · p", "sub": "from the weight"},
     "detail": "The gradient of \`wd/2 · ‖p‖²\`: the decay now travels with the gradient."},
    {"columns": [
      [{"id": "m", "label": "First moment", "sub": "m = β₁m + (1 − β₁)g", "kind": "memory"}],
      [{"id": "v", "label": "Second moment", "sub": "v = β₂v + (1 − β₂)g²", "kind": "memory"}]
    ]},
    {"id": "norm", "label": "Normalised step", "sub": "m̂ / (√v̂ + eps)",
     "detail": "Whatever entered \`g\` is divided by the coordinate's own gradient scale, the decay term included."},
    {"id": "update", "label": "Update", "sub": "p.addcdiv_(m, denom, −lr/bc1)", "kind": "io"}
  ],
  "notes": [
    {"at": "l2", "text": "The decay enters **m** and **v**"},
    {"at": "norm", "text": "Decay ÷ **√v**: large-gradient weights barely shrink"}
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
  The paper's Algorithm 2 scales \`λ\` by the schedule multiplier \`η_t\` but not by the base rate \`α\`;
  PyTorch multiplies by the full \`lr = α · η_t\`, so its \`weight_decay\` is the paper's \`λ / α\`.
- Never add \`weight_decay * p\` to \`grad\`: with \`weight_decay=0.1\` the trajectories split at step 1.

:::details Then what does torch.optim.Adam's weight_decay do?
\`torch.optim.Adam(weight_decay=…)\` is the L2 form: it adds \`wd · p\` to the gradient. Since PyTorch
2.7, \`Adam\` also takes \`decoupled_weight_decay=True\`, and \`AdamW\` is that subclass with a
default \`weight_decay\` of \`1e-2\` instead of \`0\`. Swapping L2 for decoupled decay at the same
\`weight_decay\` changes training: one is divided by \`√v\` and the other is not, so the useful values
differ by orders of magnitude.
:::

:::quiz
Q: A weight's gradient is consistently 100× larger than its neighbour's, and the two weights are equal. Under L2-regularised Adam, how does its decay compare?
- [ ] Equal: the decay term wd·p does not depend on the gradient
- [x] About 100× weaker, because the decay term is divided by √v, which is dominated by the large gradient
- [ ] About 100× stronger, because the decay term is multiplied by the gradient scale
> Adam normalises each coordinate by its own √v. Once wd·p is part of the gradient it is normalised too,
> so large-gradient weights get almost no decay. AdamW applies lr·wd to the parameter directly.
:::

# Two steps by hand

One scalar weight, \`p = 1.0\`, with \`lr = 0.1\`, \`wd = 0.1\` and the default betas and eps. The gradient
is \`0.5\` at step 1 and \`−0.1\` at step 2.

| line | step 1 (g = 0.5) | step 2 (g = −0.1) |
|---|---|---|
| decay \`p ← p · (1 − lr · wd)\` | 1.0 · 0.99 = 0.99 | 0.89 · 0.99 = 0.8811 |
| \`m ← 0.9 m + 0.1 g\` | 0.05 | 0.045 − 0.01 = 0.035 |
| \`v ← 0.999 v + 0.001 g²\` | 0.00025 | 0.00024975 + 0.00001 = 0.00025975 |
| \`bc1\`, \`bc2\` | 0.1, 0.001 | 0.19, 0.001999 |
| \`m̂ = m / bc1\` | 0.5 | 0.1842 |
| \`denom = √v / √bc2 + eps\` | 0.5 | 0.3605 |
| \`p ← p − lr · m̂ / denom\` | 0.99 − 0.1 = **0.89** | 0.8811 − 0.0511 = **0.8300** |

\`torch.optim.AdamW(lr=0.1, weight_decay=0.1)\` gives \`0.890000\` and \`0.829997\`. Three things to read
off the table:

- **Step 1 is exactly \`lr\`** (plus the decay): \`m̂ = g\` and \`√v̂ = |g|\`, whatever the size of \`g\`.
- **Momentum outlasts a sign flip.** At step 2 the gradient points the other way, yet \`m\` is still
  positive and \`p\` keeps falling. The step shrinks to 0.051: \`m̂\` has fallen to 0.18 while \`v̂\` still
  remembers the larger gradient of step 1.
- **The decay is visible.** Each step removes 1% of \`p\` on top of the Adam move.

The same two steps with L2 instead (\`torch.optim.Adam(lr=0.1, weight_decay=0.1)\`) feed \`g + wd · p\`
into the moments:

| | step 1 | step 2 |
|---|---|---|
| gradient seen | 0.5 + 0.1 · 1.0 = 0.6 | −0.1 + 0.1 · 0.9 = −0.01 |
| \`p\` after the step | 1.0 − 0.1 = **0.9** | **0.8342** |

At step 1 the decay disappears completely: \`m̂ / √v̂ = 0.6 / 0.6 = 1\`, the same unit step as without any
decay. Normalisation divides out whatever entered the gradient, decay included. Without bias correction,
step 1 would instead have been \`0.99 − 0.1 · 0.05 / √0.00025 = 0.99 − 0.316 = 0.674\`, the 3.2× overshoot.

:::quiz
Q: In the AdamW table, why is the step-2 move (0.051) smaller than lr = 0.1?
- [ ] Weight decay subtracted part of the step
- [x] m̂ has shrunk (the gradient changed sign) while v̂ still remembers the larger step-1 gradient
- [ ] Bias correction divides by a smaller bc1 at step 2
> m̂ = 0.035 / 0.19 = 0.184 and √v̂ = 0.36: the mean of the recent gradients is small but their scale is not.
> The decay is a separate 1% shrink, and bc1 grows from 0.1 to 0.19, which makes m̂ smaller, not the step larger.
:::

# Where eps goes, and AMSGrad

\`eps\` keeps the division finite when \`v\` is near zero. It goes **after** the square root:

\`\`\`python
denom = (exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)   # √v̂ + eps
\`\`\`

| form | eps acts as | effect with eps = 1e-8 |
|---|---|---|
| \`√v̂ + eps\` (Adam's Algorithm 1, PyTorch) | a floor on the denominator | invisible unless the gradient scale is ≲ 1e-8 |
| \`√v + ε̂\` (Adam's "efficient" form, Keras's \`epsilon\`) | the same floor, on the uncorrected \`√v\` | like PyTorch eps = ε̂ / √bc2: 32× larger at step 1, the same once bc2 ≈ 1 |
| \`√(v̂ + eps)\` | a perturbation of the variance | a floor of 1e-4 on the denominator: a different optimizer |

- \`sqrt(v + eps)\` does not match the reference, and \`eps\` there behaves like a much larger constant.
- Large \`eps\` (1e-6 to 1e-3) is a real tuning knob: it caps the step for near-zero-gradient coordinates
  and turns Adam towards momentum SGD (\`denom ≈ eps\`). With half-precision optimizer state it has to
  rise anyway: \`1e-8\` rounds to \`0\` in fp16, whose smallest subnormal is about 6e-8.

[AMSGrad](https://openreview.net/forum?id=ryQu7f-RZ) (Reddi et al., *On the Convergence of Adam and
Beyond*) built a simple convex problem on which Adam does not converge to the optimum: a rare large
gradient is forgotten too fast, \`v\` decays and the effective step grows again.
The fix keeps the running maximum of \`v\`:

\`\`\`python
torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)
denom = (max_exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)
\`\`\`

- In the paper, which drops bias correction, the per-coordinate rate \`lr / √v̂\` can then only shrink,
  which gives back a convergence guarantee. PyTorch keeps the maximum of the raw \`v\` and still divides
  by \`bc2\`, so the rate can still grow while \`bc2\` climbs towards 1.
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
with their own \`lr\`, \`betas\`, \`weight_decay\`, e.g. no decay for norms and biases) and \`state\`, a
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

The two moments weigh twice a \`float32\` model: 8 bytes per parameter on top of the 2 or 4 the weight
takes. Mixed-precision training usually adds an fp32 master copy of bf16 or fp16 weights (4 more bytes),
which is how [ZeRO](https://arxiv.org/abs/1910.02054) counts 16 bytes per parameter for mixed-precision
Adam with fp16 weights and gradients. That is why ZeRO and FSDP shard the optimizer state across
data-parallel ranks first, and why 8-bit and factored optimizers exist.

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
([docs](https://docs.pytorch.org/docs/stable/generated/torch.optim.AdamW.html)) has faster paths with the
same arithmetic:

| implementation | what it does | why it is faster |
|---|---|---|
| for-loop (this drill) | one op at a time per parameter | baseline |
| \`foreach\` (default on CUDA) | each op once over the list of all parameters | a few launches per op instead of one per tensor |
| \`fused\` | the whole update in one kernel | one read and write of p, m, v per step |

- The docs call both "typically faster" than the for-loop, with \`fused\` theoretically fastest;
  \`foreach\` costs about one extra parameter-sized buffer of peak memory.
- \`capturable\` keeps \`state["step"]\` as a tensor on device so the step can be recorded into a CUDA graph
  (here it is a Python \`int\`).
- The reference uses \`lerp_\` for \`m\`; in \`float32\` that differs from \`mul_().add_()\` in the last ulp,
  which is why the drill compares in \`float64\`.
- \`maximize\` flips the sign for gradient ascent; distributed training shards the state (ZeRO/FSDP).

LLM recipes change the hyper-parameters, not the algorithm. [LLaMA](https://arxiv.org/abs/2302.13971)
trains with \`betas=(0.9, 0.95)\`, \`weight_decay=0.1\`, gradient clipping at 1.0 and 2,000 warm-up steps;
the lower \`β2\` shortens \`v\`'s memory from about 1,000 steps to 20, so it follows a sudden change in
gradient scale within tens of steps. Codebases such as nanoGPT put matrices and embeddings in a decayed
group and biases and norm gains in a \`weight_decay=0\` group.

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
- Bias correction (\`1 − β1^t\`, \`1 − β2^t\`) fixes the zero-initialised moments; without it step 1 is 3.2× too large, and \`v\` stays biased for thousands of steps.
- L2 added to the gradient is divided by \`√v\` and stops being decay; AdamW shrinks \`p\` by \`lr · wd\` directly.
- \`eps\` goes after the square root; AMSGrad keeps a running maximum of \`v\` in state.
- The state costs two fp32 tensors per parameter: ZeRO sharding makes it fit, foreach/fused kernels make the update fast.

Primary reference: Loshchilov & Hutter, [Decoupled Weight Decay Regularization](https://arxiv.org/abs/1711.05101) (ICLR 2019).
`;
