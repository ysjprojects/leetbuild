import type {Step} from '@/lib/types';

/** `lr` as the step reads it: a local or the group entry. */
const LR = String.raw`(?:lr|group\[\s*['"]lr['"]\s*\])`;
/** `momentum`, the same two ways. */
const MOMENTUM = String.raw`(?:momentum|group\[\s*['"]momentum['"]\s*\])`;
/** `weight_decay`, as the group entry or the usual locals. */
const WD = String.raw`(?:weight_decay|wd|group\[\s*['"]weight_decay['"]\s*\])`;

/** `p.mul_(1 - lr * weight_decay)`: the decay applied to the parameter, not folded into the gradient. */
const DECOUPLED_DECAY = new RegExp(String.raw`\.mul_\(\s*1(?:\.0)?\s*-\s*${LR}\s*\*\s*${WD}\s*\)`);
/** `p.add_(d, alpha=-lr)`: the in-place parameter update. */
const PARAM_UPDATE = new RegExp(String.raw`\.add_\(\s*\w+\s*,\s*alpha\s*=\s*-\s*${LR}\s*\)`);

export const sgdMomentumStep: Step = {
  id: 'sgd-momentum',
  title: 'SGD.step(): decay the weight, update the buffer, look ahead, add in place',
  concept: 'pytorch',
  file: 'sgd_momentum',
  focus: ['buffer', 'classical', 'nesterov', 'decay', 'update'],
  task: `## Task

Implement \`class SGD(torch.optim.Optimizer)\` with \`__init__(self, params, lr=1e-2, momentum=0.0, nesterov=False,
weight_decay=0.0)\` and \`step(self, closure=None)\`. One call of \`step\` updates every parameter \`p\` that has a
gradient, in place, as:

\`\`\`text
p   ← p · (1 − lr · weight_decay)                      decoupled decay, skipped when weight_decay = 0
buf ← g                 on the first step              state[p]["momentum_buffer"], created lazily
buf ← momentum · buf + g                               in place: buf.mul_(momentum).add_(g)
d   ← g + momentum · buf   if nesterov   else   buf    (d = g when momentum = 0)
p   ← p − lr · d                                       in place: p.add_(d, alpha=-lr)
\`\`\`

What those five lines buy, on a ravine-shaped loss: plain SGD zig-zags across, momentum runs along the floor, and
Nesterov damps the overshoot.

:::widget optimizer-paths

- \`__init__\` validates (\`lr\`, \`momentum\`, \`weight_decay\` ≥ 0; \`nesterov\` needs \`momentum > 0\`), builds
  \`defaults = dict(lr=…, momentum=…, nesterov=…, weight_decay=…)\` and calls \`super().__init__(params, defaults)\`.
  Everything else (\`param_groups\`, \`state\`, \`zero_grad\`, \`state_dict\`) is inherited.
- \`step\` is decorated \`@torch.no_grad()\`. If a \`closure\` is given, call it under \`with torch.enable_grad():\`
  and return its loss; otherwise return \`None\`.
- Read \`lr\`, \`momentum\`, \`nesterov\`, \`weight_decay\` from each \`group\` of \`self.param_groups\`; a parameter
  whose \`grad is None\` is skipped (\`continue\`), its state untouched.
- The momentum buffer lives in \`self.state[p]["momentum_buffer"]\`: absent until the first step that sees a
  gradient, then a detached \`clone\` of the gradient, then updated in place. No buffer is created when
  \`momentum = 0\`.
- Weight decay is **decoupled**: \`p.mul_(1 - lr * weight_decay)\` before the update; it never enters the
  gradient or the buffer (no \`g + weight_decay * p\`, no \`alpha=weight_decay\`).
- In place only: \`mul_\`, \`add_\`; never \`p = p - …\`, never \`.data\`.
- No \`torch.optim.SGD\` inside the class, no \`torch.optim._functional\`.

The self-test at the end of the file (keep it) builds a quadratic \`0.5 · ‖A w + c − b‖²\` with a third parameter
that never receives a gradient, runs 25 steps for \`momentum ∈ {0, 0.9}\` and \`nesterov\`, and compares every
parameter after every step with \`torch.optim.SGD\` under the same settings (\`weight_decay=0\`, where the two
agree) with \`torch.allclose(rtol=1e-5, atol=1e-6)\`; runs 10 steps through a closure; then checks one decayed
step by hand (\`w1 = w0 · (1 − lr · wd) − lr · g\`, buffer equal to \`g\`) and that two steps of coupled
\`torch.optim.SGD(weight_decay=wd)\` land elsewhere. It prints \`PASS\`.

> The optimizer is a loop over \`param_groups\` that mutates \`p\` and \`state[p]\` in place under \`no_grad\`;
> decoupling the decay means it multiplies the *weight*, so the momentum buffer only ever carries gradients.`,
  hints: [
    'The skeleton is two loops and a skip: `for group in self.param_groups:` → `for p in group["params"]:` → `if p.grad is None: continue`. Read `lr`, `momentum`, `nesterov`, `weight_decay` from `group` (not from `self.defaults`, which a scheduler never updates), and keep the buffer in `self.state[p]`, a dict that starts empty.',
    'Per parameter, with `g = p.grad`: if `weight_decay != 0`, `p.mul_(1 - lr * weight_decay)`. If `momentum != 0`: `buf = state.get("momentum_buffer")`; if it is `None`, `buf = state["momentum_buffer"] = torch.clone(g).detach()`, else `buf.mul_(momentum).add_(g)`; then `d = g.add(buf, alpha=momentum) if nesterov else buf`. With `momentum == 0`, `d = g` and no buffer. Last, `p.add_(d, alpha=-lr)`.',
    'Around the loops: decorate `step` with `@torch.no_grad()`, start with `loss = None`, then `if closure is not None:` → `with torch.enable_grad(): loss = closure()` (the closure runs `backward()`, which needs the grad mode the decorator turned off), and end with `return loss`.',
  ],
  checks: [
    {
      id: 'optimizer-subclass',
      title: 'An Optimizer subclass with the four hyper-parameters as defaults',
      detail:
        '`class SGD(Optimizer)` (or `torch.optim.Optimizer`) whose `__init__` builds `defaults` with `lr`, `momentum`, `nesterov`, `weight_decay` and calls `super().__init__(params, defaults)`: that is what gives it `param_groups`, `state`, `zero_grad` and `state_dict` for free.',
      match: {
        python: {
          all: [
            /class SGD\(\s*(?:torch\.optim\.)?Optimizer\s*\)/,
            /super\(\)\.__init__\(\s*params\s*,\s*defaults\s*\)/,
            /weight_decay\s*=\s*weight_decay/,
          ],
        },
      },
    },
    {
      id: 'no-grad-step',
      title: 'step runs under torch.no_grad()',
      detail:
        '`@torch.no_grad()` directly above `def step(self, closure=None)`: an in-place write to a leaf tensor that requires grad is an autograd error otherwise, and the update must not be recorded in any graph.',
      match: {
        python: {all: [/@torch\.no_grad\(\)\s*\n\s*def step\(\s*self\s*,\s*closure\s*=\s*None\s*\)/]},
      },
    },
    {
      id: 'closure',
      title: 'The closure is evaluated with grad enabled and its loss returned',
      detail:
        '`with torch.enable_grad(): loss = closure()` inside the no-grad `step`, then `return loss`: a closure calls `backward()`, which needs the grad mode the decorator disabled, and LBFGS-style callers and `torch.optim` conventions expect the loss back.',
      match: {
        python: {
          all: [/with torch\.enable_grad\(\)\s*:\s*\n\s*loss\s*=\s*closure\(\)/, /return loss\b/],
        },
      },
    },
    {
      id: 'skip-no-grad',
      title: 'A parameter without a gradient is left alone',
      detail:
        '`if p.grad is None: continue` before touching `p` or its state: a frozen or unused parameter (the self-test has one) must keep its value and get no momentum buffer.',
      match: {python: {all: [/\.grad is None\s*:\s*\n\s*continue\b/]}},
    },
    {
      id: 'lazy-buffer',
      title: 'The momentum buffer is created lazily in self.state[p]',
      detail:
        '`self.state[p]["momentum_buffer"]` set to a detached `clone` of the gradient on the first step that sees one, nothing allocated in `__init__`, so `state_dict()` carries it and a parameter that never gets a gradient never gets a buffer.',
      match: {
        python: {
          all: [
            /self\.state\[\s*p\s*\]/,
            /['"]momentum_buffer['"]\s*\]\s*=\s*(?:torch\.clone\(|\w+(?:\.grad)?\.clone\(\))/,
          ],
        },
      },
    },
    {
      id: 'momentum-in-place',
      title: 'Buffer and parameter are updated in place',
      detail:
        '`buf.mul_(momentum).add_(g)` and `p.add_(d, alpha=-lr)`: no fresh tensors, no `p = p - …`, no `.data`, no delegation to `torch.optim._functional` or `sgd(...)`. The buffer tensor must stay the one `state[p]` holds.',
      match: {
        python: {
          all: [new RegExp(String.raw`\.mul_\(\s*${MOMENTUM}\s*\)\s*\.add_\(`), PARAM_UPDATE],
          none: [/\bp\s*=\s*p\b/, /\.data\b/, /torch\.optim\._functional/, /\bsgd\(/],
        },
      },
    },
    {
      id: 'nesterov',
      title: 'Nesterov adds the look-ahead without touching the buffer',
      detail:
        '`d = g.add(buf, alpha=momentum) if nesterov else buf`: with `nesterov` the step uses `g + momentum · buf` (an out-of-place `add`), while the buffer keeps `momentum · buf + g`, exactly as in `torch.optim.SGD(nesterov=True)`.',
      match: {
        python: {
          all: [
            new RegExp(String.raw`\.add\(\s*\w+\s*,\s*alpha\s*=\s*${MOMENTUM}\s*\)`),
            /\bif (?:group\[\s*['"]nesterov['"]\s*\]|nesterov)\b/,
          ],
        },
      },
    },
    {
      id: 'decoupled-decay',
      title: 'Weight decay multiplies the parameter, before the update, never the gradient',
      detail:
        '`p.mul_(1 - lr * weight_decay)` ahead of `p.add_(d, alpha=-lr)`, and no `g + weight_decay * p` / `alpha=weight_decay` anywhere: after one step `w1 = w0 · (1 − lr · wd) − lr · g` and the momentum buffer equals `g`; coupled decay would agree on step 1 and drift from step 2.',
      match: {
        python: {
          all: [DECOUPLED_DECAY],
          none: [
            new RegExp(String.raw`alpha\s*=\s*${WD}`),
            new RegExp(String.raw`\b${WD}\s*\*\s*p\b`),
            new RegExp(String.raw`\bp\s*\*\s*${WD}`),
          ],
          order: [DECOUPLED_DECAY, PARAM_UPDATE],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""SGD with momentum, Nesterov look-ahead and decoupled weight decay, as a torch.optim.Optimizer."""
import torch
from torch.optim import Optimizer


class SGD(Optimizer):
    """p ← p·(1 − lr·wd) − lr·d, with d the gradient, the momentum buffer, or the Nesterov look-ahead."""

    def __init__(self, params, lr=1e-2, momentum=0.0, nesterov=False, weight_decay=0.0):
        if lr < 0.0:
            raise ValueError(f"invalid learning rate: {lr}")
        if momentum < 0.0:
            raise ValueError(f"invalid momentum: {momentum}")
        if weight_decay < 0.0:
            raise ValueError(f"invalid weight decay: {weight_decay}")
        if nesterov and momentum <= 0.0:
            raise ValueError("Nesterov momentum needs momentum > 0")
        defaults = dict(lr=lr, momentum=momentum, nesterov=nesterov, weight_decay=weight_decay)
        super().__init__(params, defaults)

    def step(self, closure=None):  # TODO: run under torch.no_grad()
        """One update of every parameter that has a gradient; returns the closure's loss if one was given."""
        # TODO: closure under torch.enable_grad(); for every group, every p with a grad: decoupled decay on p,
        #       lazy state[p]["momentum_buffer"], buf.mul_(momentum).add_(g), Nesterov look-ahead, p.add_(d, alpha=-lr)
        raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    A = torch.randn(4, 3)
    b = torch.randn(4)
    w0 = torch.randn(3)
    c0 = torch.randn(4)
    u0 = torch.randn(2)

    def fresh():
        """The quadratic's parameters from the same start: w and c get gradients, u never does."""
        return w0.clone().requires_grad_(), c0.clone().requires_grad_(), u0.clone().requires_grad_()

    def loss_of(w, c):
        r = A @ w + c - b
        return 0.5 * (r * r).sum()

    # 1. Same trajectory as torch.optim.SGD wherever the semantics coincide (weight_decay = 0).
    for cfg in (dict(momentum=0.0), dict(momentum=0.9), dict(momentum=0.9, nesterov=True)):
        mine_params, ref_params = fresh(), fresh()
        mine = SGD(mine_params, lr=0.02, **cfg)
        ref = torch.optim.SGD(ref_params, lr=0.02, **cfg)
        assert len(mine.state) == 0, "state is created lazily, on the first step"
        first = loss_of(mine_params[0], mine_params[1]).item()
        for _ in range(25):
            for opt, (w, c, _u) in ((mine, mine_params), (ref, ref_params)):
                opt.zero_grad()
                loss_of(w, c).backward()
                opt.step()
            for x, y in zip(mine_params, ref_params):
                assert torch.allclose(x, y, rtol=1e-5, atol=1e-6), f"{cfg}: trajectory diverged from torch.optim.SGD"
        assert loss_of(mine_params[0], mine_params[1]).item() < first, f"{cfg}: the loss did not go down"
        assert mine_params[2].grad is None and torch.equal(mine_params[2], u0), "a parameter without a gradient is skipped"
        if cfg["momentum"] != 0.0:
            buf = mine.state[mine_params[0]]["momentum_buffer"]
            assert buf.shape == w0.shape and not buf.requires_grad, "one buffer per parameter, outside autograd"

    # 2. The closure: evaluated under enable_grad, its loss returned.
    mine_params, ref_params = fresh(), fresh()
    mine = SGD(mine_params, lr=0.02, momentum=0.9, nesterov=True)
    ref = torch.optim.SGD(ref_params, lr=0.02, momentum=0.9, nesterov=True)
    for _ in range(10):
        for opt, (w, c, _u) in ((mine, mine_params), (ref, ref_params)):

            def closure():
                opt.zero_grad()
                loss = loss_of(w, c)
                loss.backward()
                return loss

            loss = opt.step(closure)
            assert isinstance(loss, torch.Tensor), "step(closure) returns the closure's loss"
    for x, y in zip(mine_params, ref_params):
        assert torch.allclose(x, y, rtol=1e-5, atol=1e-6), "closure trajectory diverged from torch.optim.SGD"

    # 3. Decoupled decay, by hand: the weight shrinks by (1 − lr·wd), the buffer holds the bare gradient.
    lr, wd = 0.1, 0.5
    w, c, _u = fresh()
    opt = SGD([w, c], lr=lr, momentum=0.9, weight_decay=wd)
    opt.zero_grad()
    loss_of(w, c).backward()
    g = w.grad.clone()
    opt.step()
    expected = w0 * (1.0 - lr * wd) - lr * g
    assert torch.allclose(w, expected, rtol=1e-5, atol=1e-6), "step 1: w1 = w0·(1 − lr·wd) − lr·g"
    assert torch.equal(opt.state[w]["momentum_buffer"], g), "the decay never enters the momentum buffer"
    # Coupled decay (torch.optim.SGD's weight_decay) agrees on step 1 and parts ways on step 2.
    cw, cc, _u = fresh()
    coupled = torch.optim.SGD([cw, cc], lr=lr, momentum=0.9, weight_decay=wd)
    for _ in range(2):
        for o, (x, y) in ((opt, (w, c)), (coupled, (cw, cc))):
            o.zero_grad()
            loss_of(x, y).backward()
            o.step()
    assert not torch.allclose(w, cw, rtol=1e-5, atol=1e-6), "decoupled and coupled decay must differ once the buffer carries history"

    print("PASS")
`,
      solution: `"""SGD with momentum, Nesterov look-ahead and decoupled weight decay, as a torch.optim.Optimizer."""
import torch
from torch.optim import Optimizer


class SGD(Optimizer):
    """p ← p·(1 − lr·wd) − lr·d, with d the gradient, the momentum buffer, or the Nesterov look-ahead."""

    def __init__(self, params, lr=1e-2, momentum=0.0, nesterov=False, weight_decay=0.0):
        if lr < 0.0:
            raise ValueError(f"invalid learning rate: {lr}")
        if momentum < 0.0:
            raise ValueError(f"invalid momentum: {momentum}")
        if weight_decay < 0.0:
            raise ValueError(f"invalid weight decay: {weight_decay}")
        if nesterov and momentum <= 0.0:
            raise ValueError("Nesterov momentum needs momentum > 0")
        defaults = dict(lr=lr, momentum=momentum, nesterov=nesterov, weight_decay=weight_decay)
        super().__init__(params, defaults)

    @torch.no_grad()
    def step(self, closure=None):
        """One update of every parameter that has a gradient; returns the closure's loss if one was given."""
        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()
        for group in self.param_groups:
            lr = group["lr"]
            momentum = group["momentum"]
            nesterov = group["nesterov"]
            weight_decay = group["weight_decay"]
            for p in group["params"]:
                if p.grad is None:
                    continue
                d_p = p.grad
                if weight_decay != 0.0:
                    p.mul_(1.0 - lr * weight_decay)
                if momentum != 0.0:
                    state = self.state[p]
                    buf = state.get("momentum_buffer")
                    if buf is None:
                        buf = state["momentum_buffer"] = torch.clone(d_p).detach()
                    else:
                        buf.mul_(momentum).add_(d_p)
                    d_p = d_p.add(buf, alpha=momentum) if nesterov else buf
                p.add_(d_p, alpha=-lr)
        return loss


if __name__ == "__main__":
    torch.manual_seed(0)
    A = torch.randn(4, 3)
    b = torch.randn(4)
    w0 = torch.randn(3)
    c0 = torch.randn(4)
    u0 = torch.randn(2)

    def fresh():
        """The quadratic's parameters from the same start: w and c get gradients, u never does."""
        return w0.clone().requires_grad_(), c0.clone().requires_grad_(), u0.clone().requires_grad_()

    def loss_of(w, c):
        r = A @ w + c - b
        return 0.5 * (r * r).sum()

    # 1. Same trajectory as torch.optim.SGD wherever the semantics coincide (weight_decay = 0).
    for cfg in (dict(momentum=0.0), dict(momentum=0.9), dict(momentum=0.9, nesterov=True)):
        mine_params, ref_params = fresh(), fresh()
        mine = SGD(mine_params, lr=0.02, **cfg)
        ref = torch.optim.SGD(ref_params, lr=0.02, **cfg)
        assert len(mine.state) == 0, "state is created lazily, on the first step"
        first = loss_of(mine_params[0], mine_params[1]).item()
        for _ in range(25):
            for opt, (w, c, _u) in ((mine, mine_params), (ref, ref_params)):
                opt.zero_grad()
                loss_of(w, c).backward()
                opt.step()
            for x, y in zip(mine_params, ref_params):
                assert torch.allclose(x, y, rtol=1e-5, atol=1e-6), f"{cfg}: trajectory diverged from torch.optim.SGD"
        assert loss_of(mine_params[0], mine_params[1]).item() < first, f"{cfg}: the loss did not go down"
        assert mine_params[2].grad is None and torch.equal(mine_params[2], u0), "a parameter without a gradient is skipped"
        if cfg["momentum"] != 0.0:
            buf = mine.state[mine_params[0]]["momentum_buffer"]
            assert buf.shape == w0.shape and not buf.requires_grad, "one buffer per parameter, outside autograd"

    # 2. The closure: evaluated under enable_grad, its loss returned.
    mine_params, ref_params = fresh(), fresh()
    mine = SGD(mine_params, lr=0.02, momentum=0.9, nesterov=True)
    ref = torch.optim.SGD(ref_params, lr=0.02, momentum=0.9, nesterov=True)
    for _ in range(10):
        for opt, (w, c, _u) in ((mine, mine_params), (ref, ref_params)):

            def closure():
                opt.zero_grad()
                loss = loss_of(w, c)
                loss.backward()
                return loss

            loss = opt.step(closure)
            assert isinstance(loss, torch.Tensor), "step(closure) returns the closure's loss"
    for x, y in zip(mine_params, ref_params):
        assert torch.allclose(x, y, rtol=1e-5, atol=1e-6), "closure trajectory diverged from torch.optim.SGD"

    # 3. Decoupled decay, by hand: the weight shrinks by (1 − lr·wd), the buffer holds the bare gradient.
    lr, wd = 0.1, 0.5
    w, c, _u = fresh()
    opt = SGD([w, c], lr=lr, momentum=0.9, weight_decay=wd)
    opt.zero_grad()
    loss_of(w, c).backward()
    g = w.grad.clone()
    opt.step()
    expected = w0 * (1.0 - lr * wd) - lr * g
    assert torch.allclose(w, expected, rtol=1e-5, atol=1e-6), "step 1: w1 = w0·(1 − lr·wd) − lr·g"
    assert torch.equal(opt.state[w]["momentum_buffer"], g), "the decay never enters the momentum buffer"
    # Coupled decay (torch.optim.SGD's weight_decay) agrees on step 1 and parts ways on step 2.
    cw, cc, _u = fresh()
    coupled = torch.optim.SGD([cw, cc], lr=lr, momentum=0.9, weight_decay=wd)
    for _ in range(2):
        for o, (x, y) in ((opt, (w, c)), (coupled, (cw, cc))):
            o.zero_grad()
            loss_of(x, y).backward()
            o.step()
    assert not torch.allclose(w, cw, rtol=1e-5, atol=1e-6), "decoupled and coupled decay must differ once the buffer carries history"

    print("PASS")
`,
    },
  },
  debrief: `The whole optimizer is a loop over \`param_groups\` that mutates two things in place, the parameter and its entry in \`self.state\`, and that is why it is shaped the way it is. \`@torch.no_grad()\` is not a nicety: an in-place write to a leaf tensor that requires grad is an autograd error outside it. The closure gets \`enable_grad\` back because it has to call \`backward()\`. The buffer is created lazily and kept in \`self.state[p]\` rather than as an attribute so that \`state_dict()\` serialises it and \`load_state_dict()\` restores it; a parameter that never sees a gradient never costs a buffer. In-place \`mul_\`/\`add_\` keep the buffer the same tensor across steps (\`state_dict()\` returns references to it, not copies) and avoid allocating per step. Nesterov is one extra out-of-place \`add\` (the buffer is identical to classical momentum, only the step direction differs), the change of variables of Bengio et al. that PyTorch uses instead of the textbook "evaluate the gradient at the look-ahead point". Decoupling the decay means multiplying the weight before the update: with the gradient-folded version the term \`wd · p\` enters the buffer and is replayed with a geometric tail of \`1 / (1 − momentum)\`, so the effective decay depends on the momentum and, in Adam, on the second-moment normalisation: the observation behind AdamW (Loshchilov & Hutter). Production optimizers differ in machinery, not maths: on CUDA, \`torch.optim.SGD\` defaults to a \`foreach\` implementation that updates every tensor of a group with multi-tensor kernels, and \`fused=True\` runs one kernel that reads each parameter once; \`torch.compile\` fuses the whole step; distributed trainers shard the optimizer state across ranks (ZeRO, FSDP) because at fp32 the buffer is another 4 bytes per parameter.`,
};
