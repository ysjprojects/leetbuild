/**
 * The learning guide for the SGD drill: what momentum does to a gradient step, how Nesterov's
 * look-ahead differs from it in PyTorch's formulation, why decoupled weight decay is not L2
 * regularisation once a buffer is involved, and the `torch.optim.Optimizer` contract (groups, lazy
 * state, in-place updates under no_grad, the closure) — figures where they say it faster than prose,
 * a pop quiz per section. Rendered at `/pt-sgd-momentum/learn`.
 */
export const learn = `# The mechanism at a glance

A training step is \`loss.backward()\` followed by \`optimizer.step()\`. The first fills \`p.grad\` for
every parameter; the second turns those gradients into new parameter values and is the only place the
weights ever change. **SGD with momentum** keeps one extra tensor per parameter — a decaying sum of past
gradients — and steps along it; **Nesterov** steps along the gradient plus that sum; **decoupled weight
decay** shrinks the weight itself before the step. All three are a few lines inside one subclass of
\`torch.optim.Optimizer\`, the base class that AdamW, Lion, Muon and every other optimizer share. One
training step through it, read bottom to top:

:::architecture
{
  "input": "params, lr = 0.02, μ = 0.9",
  "items": [
    {"tone": "block", "repeat": "for each step", "label": "Training loop", "items": [
      {"id": "backward", "label": "loss.backward()", "sub": "fills p.grad", "kind": "loss",
       "detail": "Autograd writes \`p.grad\` for every parameter the loss touched; one it never touched keeps \`grad = None\`."},
      {"tone": "dotted", "label": "SGD.step() · each p with a grad", "items": [
        {"id": "grad", "label": "Gradient g", "sub": "g = p.grad · skip if None", "kind": "io",
         "detail": "Read inside \`for group in self.param_groups: for p in group['params']\`; hyper-parameters come from \`group\`."},
        {"id": "buffer", "label": "Momentum buffer", "sub": "buf.mul_(μ).add_(g)", "kind": "memory",
         "side": {"label": "state[p]", "sub": "clone(g) on step 1"},
         "detail": "\`buf ← μ · buf + g\`, in place; the running sum of gradients and the only state SGD keeps."},
        {"columns": [
          [{"id": "classical", "label": "Classical momentum", "sub": "d = buf"}],
          [{"id": "nesterov", "label": "Nesterov look-ahead", "sub": "d = g.add(buf, alpha=μ)",
            "detail": "\`d = g + μ · buf\`: same buffer, a different direction."}]
        ]},
        {"id": "decay", "label": "Decoupled weight decay", "sub": "p.mul_(1 − lr·wd)",
         "detail": "On the weight, before the update; the gradient and the buffer never see it."},
        {"id": "update", "label": "In-place update", "sub": "p.add_(d, alpha=−lr)",
         "detail": "\`p ← p − lr · d\` under \`@torch.no_grad()\`."}
      ]}
    ]},
    {"id": "trained", "label": "Trained parameters", "sub": "p after 25 steps", "kind": "io",
     "detail": "Compared with \`torch.optim.SGD\` at \`weight_decay=0\` after every step."}
  ],
  "notes": [
    {"at": "buffer", "text": "μ = **0.9**: steady state **10 × g**"},
    {"at": "nesterov", "text": "Newest gradient weighs **1 + μ**"},
    {"at": "decay", "text": "**wd · p** never enters the buffer"},
    {"at": "trained", "text": "Same as torch.optim.SGD for **25** steps"}
  ]
}
:::

The contract the drill implements, for every parameter \`p\` with gradient \`g\` and hyper-parameters
\`lr\`, \`momentum\` (μ), \`nesterov\`, \`weight_decay\` (wd):

\`\`\`text
p   ← p · (1 − lr · wd)                      only when wd ≠ 0; the gradient is untouched
buf ← g                     first step        state[p]["momentum_buffer"], created lazily
buf ← μ · buf + g           later steps       buf.mul_(μ).add_(g), in place
d   ← g + μ · buf   if nesterov   else   buf  (d = g when μ = 0: no buffer at all)
p   ← p − lr · d                              p.add_(d, alpha=-lr), in place
\`\`\`

- \`SGD(params, lr=1e-2, momentum=0.0, nesterov=False, weight_decay=0.0)\` subclasses
  \`torch.optim.Optimizer\`; \`param_groups\`, \`state\`, \`zero_grad()\` and \`state_dict()\` are inherited.
- \`step(closure=None)\` runs under \`@torch.no_grad()\`, evaluates a closure under \`enable_grad\` and returns
  its loss, and skips any parameter whose \`grad is None\`.
- With \`weight_decay=0\` the trajectory is bit-for-bit the one \`torch.optim.SGD\` produces; with it, the
  two differ from the second step on — that difference is the point of the last two sections.

# Momentum: a heavy ball, not a bigger step

Plain gradient descent, \`p ← p − lr · g\`, forgets everything between steps. On a loss surface shaped like
a ravine — steep across, shallow along, which is what every deep net's loss looks like in most directions —
the gradient points mostly across; the step zig-zags and the walk along the floor is slow. Polyak's
[heavy-ball method](https://distill.pub/2017/momentum/) adds velocity:

\`\`\`text
buf_t = μ · buf_(t−1) + g_t
p_t   = p_(t−1) − lr · buf_t
\`\`\`

Run plain SGD, momentum and Nesterov down such a ravine and compare the paths:

:::widget optimizer-paths

Across the ravine the gradient flips sign every step and the sum cancels; along it the gradient keeps its
sign and the sum grows. For a constant gradient the buffer converges to \`g / (1 − μ)\`, so the effective
step is amplified by a factor that depends only on μ:

| μ | Steady-state buffer | Effective step | Memory of the last k gradients |
| --- | --- | --- | --- |
| 0 | \`g\` | \`lr · g\` | none |
| 0.9 | \`10 · g\` | \`10 · lr · g\` | half the weight sits in the last ~7 steps |
| 0.99 | \`100 · g\` | \`100 · lr · g\` | half in the last ~69 steps |

Two consequences for the code:

- \`lr\` and \`μ\` are not independent knobs: \`lr = 0.1, μ = 0.9\` moves like \`lr = 1.0\` without momentum
  on a smooth direction. Recipes that change μ mid-training rescale \`lr\` with it.
- The buffer is *the* state. It is one tensor per parameter, the same shape and dtype as \`p\`, and the
  update is elementwise — which is why the drill's \`buf.mul_(μ).add_(g)\` works unchanged for a
  3-vector and for a 4096 × 4096 weight.

PyTorch's \`torch.optim.SGD\` writes the buffer exactly this way (its \`dampening\` argument scales the
\`g\` term and is 0 in the drill), and initialises it to \`g\` on the first step rather than to zero —
otherwise the first \`μ\` steps would be scaled down by \`1 − μ^t\`, the bias Adam corrects explicitly.

:::quiz
Q: With lr = 0.01 and μ = 0.9, the gradient is a constant g for a long time. How far does each step move?
- [ ] 0.01 · g — momentum only smooths noise, it does not change the step size
- [x] About 0.1 · g — the buffer converges to g / (1 − μ) = 10 g
- [ ] 0.9 · g — the step is μ times the gradient
> The buffer is a geometric sum: g + μg + μ²g + … = g / (1 − μ). At μ = 0.9 that is 10 g, so the effective learning rate on a consistent direction is ten times lr. On a direction whose gradient flips sign every step the terms cancel instead.
:::

# Nesterov: look where the ball is going

Nesterov's accelerated gradient evaluates the gradient *after* the momentum step rather than before it —
at \`p + μ · buf\` instead of at \`p\`. For deep nets, [Sutskever et al. (2013)](https://proceedings.mlr.press/v28/sutskever13.html)
showed that this look-ahead, with momentum well scheduled, closed much of the gap to second-order methods,
and rewrote it so the gradient is still evaluated at the current parameters:

\`\`\`text
buf ← μ · buf + g              the buffer is identical to classical momentum
d   ← g + μ · buf              classical: d ← buf
p   ← p − lr · d
\`\`\`

That is the formulation in \`torch.optim.SGD\` and in the drill: the parameters it stores are the
look-ahead point, and the only change from classical momentum is one out-of-place \`add\` —
\`d = g.add(buf, alpha=μ)\`. Expand it and the difference is a term of \`μ · g\` added immediately, rather
than only entering through the buffer one step later:

| | Classical, \`d = buf\` | Nesterov, \`d = g + μ · buf\` |
| --- | --- | --- |
| Step 1 (buf = g) | \`lr · g₁\` | \`lr · (1 + μ) · g₁\` |
| Step 2 | \`lr · (μ g₁ + g₂)\` | \`lr · (μ² g₁ + (1 + μ) g₂)\` |
| Current gradient's weight | \`1\` | \`1 + μ\` |
| Oldest gradient's weight | \`μ^(t−1)\` | \`μ^t\` |

The newest gradient counts more and the oldest less: the correction arrives one step earlier, which is
what damps the overshoot at the bottom of a ravine. The buffer must stay the classical one — adding the
look-ahead *into* the buffer compounds it every step and the trajectory leaves \`torch.optim.SGD\`'s at
step 2.

:::quiz
Q: Where does Nesterov differ from classical momentum in the drill's code?
- [ ] The buffer update: buf.mul_(μ).add_(g, alpha=1 + μ)
- [x] Only the step direction: d = g + μ · buf instead of d = buf; the buffer is the same
- [ ] The gradient is recomputed at p + μ · buf before the update
> PyTorch's formulation keeps the buffer as the classical momentum sum and changes only what is subtracted from p. Recomputing the gradient at a look-ahead point is the textbook form; it is equivalent after a change of variables but needs a second forward/backward, which nobody pays for.
:::

# Weight decay, coupled and decoupled

Weight decay pulls every weight toward zero a little each step. The classical way to get it is L2
regularisation: add \`wd/2 · ‖p‖²\` to the loss, so the gradient gains a term \`wd · p\` and the optimizer
never knows. For plain SGD that is the same as shrinking the weight by \`1 − lr · wd\`. With a momentum
buffer it is not, because \`wd · p\` goes *into the buffer* and is replayed:

| Two steps with momentum μ | Coupled: \`torch.optim.SGD(weight_decay=wd)\` | Decoupled: the drill |
| --- | --- | --- |
| Buffer after step 1 | \`g₁ + wd·p₀\` | \`g₁\`, the bare gradient |
| Parameter after step 1 | \`p₀ − lr·(g₁ + wd·p₀)\` | \`p₀·(1 − lr·wd) − lr·g₁\`, the same value |
| Buffer after step 2 | \`μ·(g₁ + wd·p₀) + g₂ + wd·p₁\` | \`μ·g₁ + g₂\` |
| Parameter after step 2 | \`p₁ − lr·buf\`: carries \`μ·wd·p₀\`, the decay replayed | \`p₁·(1 − lr·wd) − lr·(μ·g₁ + g₂)\`: each decay applied once |

The two agree on step 1 — \`p₀ − lr · wd · p₀ − lr · g₁\` either way, which is why the drill's hand check
looks at the *buffer* after step 1 and at the parameters after step 2. From then on the coupled version
applies each step's decay again and again with weights \`μ, μ², …\`, a total of \`1 / (1 − μ)\` times, one
step late each time. In SGD that is a rescaling of \`wd\` by about 10 at μ = 0.9 plus a lag; in Adam the
buffered decay term is also divided by the running RMS of the gradient, so weights with large gradients
are decayed *less* — the observation of
[Loshchilov & Hutter, *Decoupled Weight Decay Regularization*](https://arxiv.org/abs/1711.05101), who
introduced SGDW and AdamW. Decoupled decay is one line on the parameter, before the update:

\`\`\`python
p.mul_(1 - lr * weight_decay)   # then the momentum update, then p.add_(d, alpha=-lr)
\`\`\`

- The gradient and the buffer carry only gradients; \`wd\` and \`lr\` can be tuned independently.
- It still scales with \`lr\`: a scheduler that decays the learning rate decays the decay too, which is
  what the paper's AdamW does (and what \`torch.optim.AdamW\` does with \`param.mul_(1 - lr * weight_decay)\`).
- \`torch.optim.SGD\`'s \`weight_decay\` argument is the *coupled* kind, which is why the drill compares
  trajectories at \`weight_decay=0\` only. Production recipes also exclude biases and normalisation
  gains from decay by putting them in a second param group with \`weight_decay=0\`.

:::details Why "equals L2" is only true for plain SGD
With no momentum, \`p − lr · (g + wd · p) = p · (1 − lr · wd) − lr · g\` exactly: the gradient of
\`wd/2 · ‖p‖²\` and a multiplicative shrink are the same step. Any optimizer that transforms the gradient
before applying it — a momentum buffer, Adam's per-coordinate normalisation, Shampoo's preconditioner —
transforms the decay term with it, and the equivalence breaks. The transformation is the whole point of
those optimizers, so the fix is to keep the decay outside it.
:::

:::quiz
Q: After one step with lr = 0.1, μ = 0.9 and wd = 0.5, the decoupled optimizer and torch.optim.SGD(weight_decay=0.5) hold the same parameters. Where do they differ?
- [ ] They do not; decoupled decay is a rename of L2 regularisation
- [x] In the momentum buffer: one holds g, the other g + wd · p₀, so step 2 is different
- [ ] In the learning rate: decoupled decay divides lr by (1 − μ)
> Step 1 is identical because the buffer starts as a copy of whatever was fed in. The coupled version fed g + wd · p₀, and that term is replayed with weight μ on step 2, μ² on step 3, …; the decoupled version's buffer is the bare gradient and the decay is applied once per step, on the weight.
:::

# The Optimizer contract: groups, state, in place, under no_grad

\`torch.optim.Optimizer\` is the small amount of machinery every optimizer shares, so that schedulers,
checkpoints and training loops can treat them alike. The subclass supplies \`defaults\` and \`step\`:

| Piece | Who provides it | What it holds |
| --- | --- | --- |
| \`param_groups\` | base class, from \`params\` and \`defaults\` | a list of dicts, each \`{"params": [...], "lr": …, "momentum": …}\`; one group per set of hyper-parameters |
| \`state\` | base class, empty | \`state[p]\` is a dict per parameter; \`momentum_buffer\` lives here |
| \`zero_grad()\` | base class | sets every \`p.grad\` to \`None\` (default) or zero |
| \`state_dict()\` / \`load_state_dict()\` | base class | the groups and the state, with parameters replaced by indices |
| \`step(closure=None)\` | **the subclass** | the update rule |

The rule is the loop \`for group in self.param_groups: for p in group["params"]:\`, reading each
hyper-parameter from \`group\`, because that is where a scheduler writes the new \`lr\` and where a second
group with \`weight_decay=0\` lives. Four details decide whether the loop is correct:

- **Skip** \`grad is None\`. A frozen parameter, or one the batch did not use, has no gradient; touching
  it would decay it for nothing and allocate a buffer it does not need.
- **State is lazy** and lives in \`self.state\`. Nothing is allocated in \`__init__\`; the buffer appears the first
  time a gradient does, as a detached clone of it. Keeping it in \`state[p]\` rather than on the module or
  the optimizer object is what makes \`state_dict()\` save it and a resumed run continue the trajectory.
- **In place.** \`buf.mul_(μ).add_(g)\` and \`p.add_(d, alpha=-lr)\` write into the existing tensors. A
  checkpoint references those tensors; \`p = p - lr * d\` rebinds a local and the model never changes;
  \`p.data\` escapes autograd's bookkeeping and is the pre-0.4 idiom the base class warns against.
- **No autograd:** \`@torch.no_grad()\`. The parameters are leaf tensors that require grad; an in-place write to
  one of them with grad mode on is a \`RuntimeError\`, and the buffer arithmetic would otherwise build a
  graph that is never freed:

| Inside \`step()\` | Grad mode | What happens |
| --- | --- | --- |
| \`p.mul_(1 - lr * wd)\`, no decorator | on | \`RuntimeError\`: a leaf Variable that requires grad is being used in an in-place operation |
| \`closure()\` under \`with torch.enable_grad():\`, decorated | on again | zero the grads, forward, backward: the loss and a fresh \`p.grad\` |
| \`mul_\` / \`add_\` on \`p\` and \`buf\`, decorated with \`@torch.no_grad()\` | off | the update, recorded nowhere; \`step\` returns the closure's loss |

The closure is the one exception to "no graph here": an optimizer that re-evaluates the loss (LBFGS does,
several times per step) receives a function that zeroes the gradients, runs forward and backward and
returns the loss. \`step\` calls it inside \`with torch.enable_grad():\` and hands the loss back, so a
training loop can write \`loss = opt.step(closure)\` for any optimizer.

What the state costs, in fp32 and per parameter — the reason optimizer state is sharded across GPUs
(ZeRO, FSDP) before anything else is:

| Optimizer | Parameter | Gradient | State | Total | For 7 B parameters |
| --- | --- | --- | --- | --- | --- |
| SGD, μ = 0 | 4 B | 4 B | 0 | 8 B | 56 GB |
| SGD with momentum | 4 B | 4 B | 4 B (buffer) | 12 B | 84 GB |
| Adam / AdamW | 4 B | 4 B | 8 B (two moments) | 16 B | 112 GB |

:::quiz
Q: Why is the momentum buffer kept in self.state[p] instead of as an attribute on the optimizer, say self.buffers = []?
- [ ] Attributes on an Optimizer subclass are read-only
- [x] state_dict() serialises self.state, so a checkpoint carries the buffer and a resumed run continues the same trajectory
- [ ] A list would be slower to index than a dict
> The base class knows about param_groups and state and nothing else. Anything in state[p] is saved by state_dict(), remapped to the right parameter by load_state_dict(), and moved with the parameters; a private attribute is lost at the first checkpoint.
:::

# What to take away

- **Momentum is a geometric sum of gradients.** \`buf ← μ · buf + g\`; a constant gradient gives
  \`g / (1 − μ)\`, so μ = 0.9 is a tenfold step on consistent directions and cancellation on oscillating
  ones. One tensor per parameter, the same shape, updated elementwise in place.
- **Nesterov changes the direction, not the buffer.** \`d = g + μ · buf\` instead of \`d = buf\` — one
  out-of-place \`add\` — gives the newest gradient weight \`1 + μ\` and the correction one step earlier.
- **Decouple the decay.** \`p.mul_(1 − lr · wd)\` before the update keeps \`wd · p\` out of the buffer, where
  it would be replayed \`1 / (1 − μ)\` times; coupled and decoupled agree on step 1 and part on step 2.
  AdamW is this idea applied to Adam.
- **The contract is small.** \`defaults\` and \`super().__init__\`; a loop over \`param_groups\` reading
  hyper-parameters from the group; \`state[p]\` created lazily so \`state_dict()\` carries it; \`grad is
  None\` skipped; \`mul_\`/\`add_\` under \`@torch.no_grad()\`; the closure under \`enable_grad\`, its loss
  returned.
- **Frameworks change the machinery, not the maths.** \`foreach\` and \`fused\` kernels update a whole
  group at once, \`torch.compile\` fuses the step, and ZeRO/FSDP shard the 4–8 bytes of state per
  parameter that this loop would otherwise keep on every rank.

The primary reference is Loshchilov & Hutter,
[*Decoupled Weight Decay Regularization*](https://arxiv.org/abs/1711.05101) (ICLR 2019), which
introduced SGDW and AdamW; the update rules and the optimizer contract are documented on the
[\`torch.optim.SGD\`](https://pytorch.org/docs/stable/generated/torch.optim.SGD.html) and
[\`torch.optim\`](https://pytorch.org/docs/stable/optim.html) pages, and Goh's
[*Why Momentum Really Works*](https://distill.pub/2017/momentum/) is the picture of the heavy ball in a
ravine.
`;
