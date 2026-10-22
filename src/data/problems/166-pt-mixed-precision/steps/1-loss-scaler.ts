import type {Step} from '@/lib/types';

/** The scaler is written by hand: PyTorch's own one may only appear after the self-test's `if __name__` guard. */
const GRAD_SCALER_IN_IMPLEMENTATION = [
  /from torch\.(cuda\.)?amp import[^\n]*GradScaler/,
  /class DynamicLossScaler\b[\s\S]*GradScaler[\s\S]*\nif __name__/,
];

/** Casting the model or its parameters to half precision — the master weights must stay float32. */
const HALF_MODEL = [/\.half\(\)/, /\.bfloat16\(\)/, /\.to\(\s*(dtype\s*=\s*)?torch\.(bfloat16|float16|half)\s*\)/];

export const lossScalerStep: Step = {
  id: 'loss-scaler',
  title: 'autocast forward, scaled backward, unscale, clip, step — or skip',
  concept: 'pytorch',
  file: 'mixed_precision',
  focus: ['autocast', 'scaler', 'optimizer'],
  task: `## Task

Implement \`class DynamicLossScaler\` and \`train_step(model, batch, optimizer, scaler, dtype=torch.bfloat16, max_norm=1.0)\`
in \`mixed_precision.py\`. The parameters are float32 throughout; only the forward runs in \`dtype\`.

- \`DynamicLossScaler(init_scale=2.0**16, growth_factor=2.0, backoff_factor=0.5, growth_interval=2000)\`,
  the PyTorch defaults. \`get_scale()\` returns the current scale as a float.
- \`scale(loss)\` → \`loss * scale\`: the tensor the caller runs \`.backward()\` on.
- \`unscale_(optimizer)\` → \`bool\`: divides every \`p.grad\` of every \`optimizer.param_groups\` entry by the
  scale **in place**, and records whether any gradient is non-finite with **one** \`torch.isfinite\`
  reduction (one host sync) **per parameter group**, not one per tensor. Calling it twice before
  \`step\` raises \`RuntimeError\`.
- \`step(optimizer)\` → \`bool\` (did it step): calls \`unscale_\` itself if the caller did not; on a
  non-finite gradient it **skips** \`optimizer.step()\`, multiplies the scale by \`backoff_factor\` and resets
  the good-step counter; otherwise it steps, counts, and after \`growth_interval\` consecutive good steps
  multiplies the scale by \`growth_factor\` and resets the counter. Either way the next step starts fresh.
- \`state_dict()\` → \`{"scale", "growth_factor", "backoff_factor", "growth_interval", "growth_tracker"}\`;
  \`load_state_dict(state)\` restores them.
- \`train_step\`: \`optimizer.zero_grad(set_to_none=True)\`; the forward under
  \`torch.autocast(device_type=x.device.type, dtype=dtype)\` with the cross-entropy computed on
  \`logits.float()\`; \`scaler.scale(loss).backward()\`; \`scaler.unscale_(optimizer)\`;
  \`torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm)\`; \`scaler.step(optimizer)\`. Returns
  \`(loss.detach().float(), grad_norm, stepped)\`.
- Forbidden: \`torch.amp.GradScaler\` / \`torch.cuda.amp.GradScaler\` anywhere in the implementation (the
  self-test uses it as a reference, after the \`if __name__\` guard, where it runs on CPU); \`.half()\`,
  \`.bfloat16()\`, \`.to(torch.bfloat16)\` on the model or its parameters.
- The self-test (CPU, \`torch.manual_seed(0)\`, a 16→32→4 MLP, SGD \`lr=0.1\`, \`growth_interval=4\`): a good
  step sees bfloat16 activations, float32 parameters, and an update within \`rtol=5e-2, atol=2e-4\` of an
  unscaled float32 step; a step whose last-layer gradient is made infinite is skipped, leaves the weights
  untouched and halves the scale to \`2**15\`; four good steps double it back; \`state_dict\` round-trips;
  where \`torch.amp.GradScaler("cpu")\` exists, six steps with an overflow in the middle give the same
  weights and the same scale. It prints \`PASS\`.

> Multiply the loss by a large power of two so no gradient underflows in half precision, divide the
> gradients by it before the optimizer sees them, and let an overflow — a gradient that is \`inf\` or \`nan\`
> — skip the step and shrink the scale: that is all mixed precision adds to a training loop.`,
  sequence: {
    participants: ['train_step', 'autocast', 'model (fp32 weights)', 'DynamicLossScaler', 'optimizer'],
    messages: [
      {from: 'train_step', to: 'optimizer', label: 'zero_grad(set_to_none=True)', kind: 'sync'},
      {from: 'train_step', to: 'autocast', label: 'with torch.autocast("cpu", dtype=bfloat16): model(x)', kind: 'sync'},
      {
        from: 'autocast',
        to: 'model (fp32 weights)',
        label: 'Linear: fp32 weight → bf16 copy, bf16 matmul',
        kind: 'sync',
      },
      {
        from: 'model (fp32 weights)',
        to: 'train_step',
        label: 'logits bf16 → cross_entropy(logits.float(), y) fp32',
        kind: 'reply',
      },
      {from: 'train_step', to: 'DynamicLossScaler', label: 'scale(loss) → loss × 65536', kind: 'sync'},
      {
        from: 'train_step',
        to: 'model (fp32 weights)',
        label: '.backward(): every .grad is fp32, × 65536',
        kind: 'sync',
      },
      {
        from: 'train_step',
        to: 'DynamicLossScaler',
        label: 'unscale_(optimizer): grads ÷ 65536 in place · isfinite per group',
        kind: 'sync',
      },
      {
        from: 'train_step',
        to: 'model (fp32 weights)',
        label: 'clip_grad_norm_(parameters, 1.0) on true gradients',
        kind: 'sync',
      },
      {from: 'train_step', to: 'DynamicLossScaler', label: 'step(optimizer)', kind: 'sync'},
      {
        from: 'DynamicLossScaler',
        to: 'optimizer',
        label: 'finite → step(); good steps += 1; 2000 in a row → scale × 2',
        kind: 'sync',
      },
      {
        from: 'DynamicLossScaler',
        to: 'train_step',
        label: 'inf/nan → no step, scale × 0.5, counter = 0 → stepped = False',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Keep three numbers: the scale, the count of consecutive good steps, and whether the current step overflowed (`None` until `unscale_` ran). `scale(loss)` is `loss * self._scale`; `step` consults the flag, acts, and sets it back to `None`.',
    'In `unscale_`, per group: `grads = [p.grad for p in group["params"] if p.grad is not None]`, then `torch._foreach_div_(grads, self._scale)` (or `g.div_` in a loop) and one reduction: `torch.stack([torch.isfinite(g).all() for g in grads]).all()` — `bool(...)` of that is the group\'s single host sync.',
    'The order in `train_step` is fixed by what each stage needs: `zero_grad` → autocast forward → `scaler.scale(loss).backward()` → `scaler.unscale_(optimizer)` → `clip_grad_norm_` (the norm of scaled gradients would be 65536× too large) → `scaler.step(optimizer)`. Loss in float32: `F.cross_entropy(logits.float(), y)`.',
  ],
  checks: [
    {
      id: 'autocast-forward',
      title: 'The forward runs under torch.autocast in the requested dtype; the parameters stay float32',
      detail:
        'A forward hook on the last Linear sees bfloat16 output and every parameter is float32 after the step. `torch.autocast(device_type=..., dtype=dtype)` wraps the forward only — `zero_grad` before it, `backward` after it — and nothing calls `.half()`, `.bfloat16()` or `.to(torch.bfloat16)` on the model.',
      match: {
        python: {
          all: [/torch\.autocast\(/, /device_type\s*=/, /dtype\s*=\s*dtype/],
          none: HALF_MODEL,
          order: [/optimizer\.zero_grad\(/, /torch\.autocast\(/, /\.backward\(\)/],
        },
      },
    },
    {
      id: 'scaled-backward',
      title: 'backward() runs on the loss multiplied by the scale',
      detail:
        'Every gradient comes out of `.backward()` multiplied by 65536, which is what keeps small fp16 gradients above the subnormal range. `train_step` calls `scaler.scale(loss).backward()` — never `loss.backward()`.',
      match: {
        python: {
          all: [/scaler\.scale\(\s*loss\s*\)/, /def scale\(self, loss/],
          none: [/(?<!scaler\.scale\()loss\.backward\(\)/],
          order: [/scaler\.scale\(/, /\.backward\(\)/],
        },
      },
    },
    {
      id: 'unscale-in-place',
      title: 'Gradients are divided by the scale in place, before clipping, before the step',
      detail:
        'After `unscale_` each `p.grad` equals the true gradient within float32 rounding (the same `.grad` tensors, divided in place: `torch._foreach_div_` or `g.div_`/`g.mul_`); `clip_grad_norm_` then clips true gradients, and the scaler steps last.',
      match: {
        python: {
          all: [/_foreach_(div|mul)_\(|\.(div|mul)_\(/],
          order: [/scaler\.unscale_\(optimizer\)/, /clip_grad_norm_\(/, /scaler\.step\(optimizer\)/],
        },
      },
    },
    {
      id: 'overflow-check',
      title: 'Non-finite gradients are found with one torch.isfinite reduction per parameter group',
      detail:
        "An `inf` in one gradient makes `unscale_` return `True`. The check walks `optimizer.param_groups`, reduces `torch.isfinite(...)` over all of a group's gradients and syncs once — not `.item()` per tensor, which would stall the GPU once per parameter.",
      match: {
        python: {
          all: [/torch\.isfinite\(/, /optimizer\.param_groups/],
          none: [/for\s+\w+\s+in\s+grads\s*:[^\n]*\n\s+if\s+not\s+torch\.isfinite/],
        },
      },
    },
    {
      id: 'skip-and-backoff',
      title: 'An overflow skips optimizer.step() and halves the scale',
      detail:
        'The step with an infinite gradient leaves every weight exactly as it was and the scale goes 65536 → 32768. `step` branches on the recorded flag: `optimizer.step()` only on the finite side, `scale *= backoff_factor` and counter reset on the other. The scaler is written by hand: no `torch.amp.GradScaler` before the self-test.',
      match: {
        python: {
          all: [/\*=?\s*self\.backoff_factor\b/, /optimizer\.step\(\)/],
          none: GRAD_SCALER_IN_IMPLEMENTATION,
        },
      },
    },
    {
      id: 'growth',
      title: 'growth_interval consecutive good steps double the scale',
      detail:
        'With `growth_interval=4`, four good steps after the skipped one bring the scale from 32768 back to 65536 — and the overflow had reset the counter, so the two good steps before it do not count.',
      match: {
        python: {
          all: [/\*=?\s*self\.growth_factor\b/, /(>=|==)\s*self\.growth_interval\b|self\.growth_interval\s*(<=|==)/],
        },
      },
    },
    {
      id: 'state-dict',
      title: 'state_dict / load_state_dict round-trip the scale and the good-step counter',
      detail:
        'A fresh scaler loaded from `scaler.state_dict()` reports the same scale and the same dict — a checkpoint resumed mid-run must not restart at 2**16 and overflow its first 20 steps. Keys: `scale`, `growth_factor`, `backoff_factor`, `growth_interval`, `growth_tracker`.',
      match: {
        python: {
          all: [/["']scale["']\s*:/, /["']growth_tracker["']\s*:/, /def load_state_dict\(self, /],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Mixed precision by hand: autocast for the forward, a dynamic loss scaler for the backward, fp32 master weights."""
import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class DynamicLossScaler:
    """Multiplies the loss by a scale before backward, divides the gradients by it before the step.

    A non-finite gradient means the scale was too large: the step is skipped and the scale backs off.
    growth_interval consecutive good steps mean it may be too small: the scale grows.
    """

    def __init__(
        self,
        init_scale: float = 2.0**16,
        growth_factor: float = 2.0,
        backoff_factor: float = 0.5,
        growth_interval: int = 2000,
    ) -> None:
        self._scale = float(init_scale)
        self.growth_factor = growth_factor
        self.backoff_factor = backoff_factor
        self.growth_interval = growth_interval
        self._growth_tracker = 0  # consecutive good steps since the last change of scale
        self._found_inf: bool | None = None  # None until unscale_() ran for the current step

    def get_scale(self) -> float:
        return self._scale

    def scale(self, loss: torch.Tensor) -> torch.Tensor:
        """The loss to call backward() on: every gradient comes out multiplied by the scale."""
        raise NotImplementedError("TODO")

    def unscale_(self, optimizer: torch.optim.Optimizer) -> bool:
        """Divide every gradient by the scale in place; record (and return) whether any is non-finite."""
        # TODO: raise if already unscaled this step; per param group: grads ÷ scale in place,
        #       one torch.isfinite reduction, one bool() sync; remember the result
        raise NotImplementedError("TODO")

    def step(self, optimizer: torch.optim.Optimizer) -> bool:
        """optimizer.step() unless a gradient overflowed; then update the scale. Returns whether it stepped."""
        # TODO: unscale_ if the caller did not; overflow → skip, scale *= backoff, counter = 0;
        #       else step, counter += 1, growth_interval reached → scale *= growth, counter = 0; reset the flag
        raise NotImplementedError("TODO")

    def state_dict(self) -> dict:
        raise NotImplementedError("TODO")  # TODO: scale, growth_factor, backoff_factor, growth_interval, growth_tracker

    def load_state_dict(self, state: dict) -> None:
        raise NotImplementedError("TODO")


def train_step(
    model: nn.Module,
    batch: tuple[torch.Tensor, torch.Tensor],
    optimizer: torch.optim.Optimizer,
    scaler: DynamicLossScaler,
    dtype: torch.dtype = torch.bfloat16,
    max_norm: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, bool]:
    """One mixed-precision step: autocast forward, scaled backward, unscale, clip, (maybe) step.

    Returns (loss in float32, gradient norm before clipping, whether the optimizer stepped).
    """
    # TODO: zero_grad → forward under torch.autocast(device_type, dtype) with the loss on logits.float()
    #       → scaler.scale(loss).backward() → scaler.unscale_(optimizer) → clip_grad_norm_ → scaler.step(optimizer)
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = nn.Sequential(nn.Linear(16, 32), nn.GELU(), nn.Linear(32, 4)).to(device)
    x = torch.randn(8, 16, device=device)
    y = torch.randint(0, 4, (8,), device=device)
    batch = (x, y)

    # 1. A good step: bf16 activations, fp32 master weights, and the update of an unscaled fp32 step.
    model_amp = copy.deepcopy(model)
    model_ref = copy.deepcopy(model)
    opt_amp = torch.optim.SGD(model_amp.parameters(), lr=0.1)
    opt_ref = torch.optim.SGD(model_ref.parameters(), lr=0.1)
    scaler = DynamicLossScaler(init_scale=2.0**16, growth_interval=4)
    seen = []
    hook = model_amp[2].register_forward_hook(lambda m, i, o: seen.append(o.dtype))
    loss, grad_norm, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
    hook.remove()
    assert seen == [torch.bfloat16], f"forward not in bfloat16: {seen}"
    assert loss.dtype == torch.float32 and math.isfinite(loss.item())
    assert stepped and scaler.get_scale() == 2.0**16
    assert all(p.dtype == torch.float32 for p in model_amp.parameters()), "master weights must stay float32"
    opt_ref.zero_grad(set_to_none=True)
    F.cross_entropy(model_ref(x), y).backward()
    torch.nn.utils.clip_grad_norm_(model_ref.parameters(), 1.0)
    opt_ref.step()
    for p0, p_amp, p_ref in zip(model.parameters(), model_amp.parameters(), model_ref.parameters()):
        update_amp, update_ref = p_amp - p0, p_ref - p0
        assert torch.allclose(update_amp, update_ref, rtol=5e-2, atol=2e-4), (
            f"update differs: max abs {(update_amp - update_ref).abs().max().item():.3e}"
        )

    # 2. An overflow: one gradient is made infinite; the step is skipped and the scale halves.
    before = [p.detach().clone() for p in model_amp.parameters()]
    hook = model_amp[2].weight.register_hook(lambda g: g * float("inf"))
    _, _, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
    hook.remove()
    assert not stepped, "an overflowed step must be skipped"
    assert scaler.get_scale() == 2.0**15, scaler.get_scale()
    assert all(torch.equal(a, b) for a, b in zip(before, model_amp.parameters())), "skipped step changed weights"

    # 3. growth_interval consecutive good steps double the scale; the overflow reset the count.
    for _ in range(4):
        _, _, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
        assert stepped
    assert scaler.get_scale() == 2.0**16, scaler.get_scale()

    # 4. state_dict round-trips the scale and the counter.
    scaler2 = DynamicLossScaler()
    scaler2.load_state_dict(scaler.state_dict())
    assert scaler2.get_scale() == scaler.get_scale() and scaler2.state_dict() == scaler.state_dict()

    # 5. Against torch.amp.GradScaler where it runs on CPU (PyTorch >= 2.3): same weights, same scale.
    try:
        ref = torch.amp.GradScaler("cpu", init_scale=2.0**16, growth_interval=4)
    except (AttributeError, TypeError, RuntimeError):
        ref = None
    if ref is not None:

        class TorchScaler:  # adapter: GradScaler's update() folded into step(), as the hand-written one does
            def __init__(self, inner):
                self.inner = inner

            def scale(self, loss):
                return self.inner.scale(loss)

            def unscale_(self, opt):
                self.inner.unscale_(opt)

            def step(self, opt):
                self.inner.step(opt)
                self.inner.update()
                return True

        model_t = copy.deepcopy(model)
        model_h = copy.deepcopy(model)
        opt_t = torch.optim.SGD(model_t.parameters(), lr=0.1)
        opt_h = torch.optim.SGD(model_h.parameters(), lr=0.1)
        hand = DynamicLossScaler(init_scale=2.0**16, growth_interval=4)
        torch_scaler = TorchScaler(ref)
        for i in range(6):
            hooks = []
            if i == 2:  # overflow on both
                hooks = [m[2].weight.register_hook(lambda g: g * float("inf")) for m in (model_t, model_h)]
            train_step(model_t, batch, opt_t, torch_scaler, torch.bfloat16)
            train_step(model_h, batch, opt_h, hand, torch.bfloat16)
            for h in hooks:
                h.remove()
            assert ref.get_scale() == hand.get_scale(), (i, ref.get_scale(), hand.get_scale())
        for p_t, p_h in zip(model_t.parameters(), model_h.parameters()):
            assert torch.allclose(p_t, p_h, rtol=1e-5, atol=1e-6)
        print("matches torch.amp.GradScaler")

    print("PASS")
`,
      solution: `"""Mixed precision by hand: autocast for the forward, a dynamic loss scaler for the backward, fp32 master weights."""
import copy
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class DynamicLossScaler:
    """Multiplies the loss by a scale before backward, divides the gradients by it before the step.

    A non-finite gradient means the scale was too large: the step is skipped and the scale backs off.
    growth_interval consecutive good steps mean it may be too small: the scale grows.
    """

    def __init__(
        self,
        init_scale: float = 2.0**16,
        growth_factor: float = 2.0,
        backoff_factor: float = 0.5,
        growth_interval: int = 2000,
    ) -> None:
        self._scale = float(init_scale)
        self.growth_factor = growth_factor
        self.backoff_factor = backoff_factor
        self.growth_interval = growth_interval
        self._growth_tracker = 0  # consecutive good steps since the last change of scale
        self._found_inf: bool | None = None  # None until unscale_() ran for the current step

    def get_scale(self) -> float:
        return self._scale

    def scale(self, loss: torch.Tensor) -> torch.Tensor:
        """The loss to call backward() on: every gradient comes out multiplied by the scale."""
        return loss * self._scale

    def unscale_(self, optimizer: torch.optim.Optimizer) -> bool:
        """Divide every gradient by the scale in place; record (and return) whether any is non-finite."""
        if self._found_inf is not None:
            raise RuntimeError("unscale_() already called since the last step()")
        found_inf = False
        for group in optimizer.param_groups:
            grads = [p.grad for p in group["params"] if p.grad is not None]
            if not grads:
                continue
            torch._foreach_div_(grads, self._scale)
            finite = torch.stack([torch.isfinite(g).all() for g in grads]).all()  # one host sync per group
            if not bool(finite):
                found_inf = True
        self._found_inf = found_inf
        return found_inf

    def step(self, optimizer: torch.optim.Optimizer) -> bool:
        """optimizer.step() unless a gradient overflowed; then update the scale. Returns whether it stepped."""
        if self._found_inf is None:
            self.unscale_(optimizer)
        stepped = not self._found_inf
        if self._found_inf:
            self._scale *= self.backoff_factor
            self._growth_tracker = 0
        else:
            optimizer.step()
            self._growth_tracker += 1
            if self._growth_tracker >= self.growth_interval:
                self._scale *= self.growth_factor
                self._growth_tracker = 0
        self._found_inf = None
        return stepped

    def state_dict(self) -> dict:
        return {
            "scale": self._scale,
            "growth_factor": self.growth_factor,
            "backoff_factor": self.backoff_factor,
            "growth_interval": self.growth_interval,
            "growth_tracker": self._growth_tracker,
        }

    def load_state_dict(self, state: dict) -> None:
        self._scale = float(state["scale"])
        self.growth_factor = state["growth_factor"]
        self.backoff_factor = state["backoff_factor"]
        self.growth_interval = state["growth_interval"]
        self._growth_tracker = int(state["growth_tracker"])
        self._found_inf = None


def train_step(
    model: nn.Module,
    batch: tuple[torch.Tensor, torch.Tensor],
    optimizer: torch.optim.Optimizer,
    scaler: DynamicLossScaler,
    dtype: torch.dtype = torch.bfloat16,
    max_norm: float = 1.0,
) -> tuple[torch.Tensor, torch.Tensor, bool]:
    """One mixed-precision step: autocast forward, scaled backward, unscale, clip, (maybe) step.

    Returns (loss in float32, gradient norm before clipping, whether the optimizer stepped).
    """
    x, y = batch
    optimizer.zero_grad(set_to_none=True)
    with torch.autocast(device_type=x.device.type, dtype=dtype):
        logits = model(x)  # matmuls run in dtype; the parameters stay float32
        loss = F.cross_entropy(logits.float(), y)
    scaler.scale(loss).backward()
    scaler.unscale_(optimizer)
    grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm)
    stepped = scaler.step(optimizer)
    return loss.detach().float(), grad_norm, stepped


if __name__ == "__main__":
    torch.manual_seed(0)
    device = torch.device("cpu")
    model = nn.Sequential(nn.Linear(16, 32), nn.GELU(), nn.Linear(32, 4)).to(device)
    x = torch.randn(8, 16, device=device)
    y = torch.randint(0, 4, (8,), device=device)
    batch = (x, y)

    # 1. A good step: bf16 activations, fp32 master weights, and the update of an unscaled fp32 step.
    model_amp = copy.deepcopy(model)
    model_ref = copy.deepcopy(model)
    opt_amp = torch.optim.SGD(model_amp.parameters(), lr=0.1)
    opt_ref = torch.optim.SGD(model_ref.parameters(), lr=0.1)
    scaler = DynamicLossScaler(init_scale=2.0**16, growth_interval=4)
    seen = []
    hook = model_amp[2].register_forward_hook(lambda m, i, o: seen.append(o.dtype))
    loss, grad_norm, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
    hook.remove()
    assert seen == [torch.bfloat16], f"forward not in bfloat16: {seen}"
    assert loss.dtype == torch.float32 and math.isfinite(loss.item())
    assert stepped and scaler.get_scale() == 2.0**16
    assert all(p.dtype == torch.float32 for p in model_amp.parameters()), "master weights must stay float32"
    opt_ref.zero_grad(set_to_none=True)
    F.cross_entropy(model_ref(x), y).backward()
    torch.nn.utils.clip_grad_norm_(model_ref.parameters(), 1.0)
    opt_ref.step()
    for p0, p_amp, p_ref in zip(model.parameters(), model_amp.parameters(), model_ref.parameters()):
        update_amp, update_ref = p_amp - p0, p_ref - p0
        assert torch.allclose(update_amp, update_ref, rtol=5e-2, atol=2e-4), (
            f"update differs: max abs {(update_amp - update_ref).abs().max().item():.3e}"
        )

    # 2. An overflow: one gradient is made infinite; the step is skipped and the scale halves.
    before = [p.detach().clone() for p in model_amp.parameters()]
    hook = model_amp[2].weight.register_hook(lambda g: g * float("inf"))
    _, _, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
    hook.remove()
    assert not stepped, "an overflowed step must be skipped"
    assert scaler.get_scale() == 2.0**15, scaler.get_scale()
    assert all(torch.equal(a, b) for a, b in zip(before, model_amp.parameters())), "skipped step changed weights"

    # 3. growth_interval consecutive good steps double the scale; the overflow reset the count.
    for _ in range(4):
        _, _, stepped = train_step(model_amp, batch, opt_amp, scaler, torch.bfloat16)
        assert stepped
    assert scaler.get_scale() == 2.0**16, scaler.get_scale()

    # 4. state_dict round-trips the scale and the counter.
    scaler2 = DynamicLossScaler()
    scaler2.load_state_dict(scaler.state_dict())
    assert scaler2.get_scale() == scaler.get_scale() and scaler2.state_dict() == scaler.state_dict()

    # 5. Against torch.amp.GradScaler where it runs on CPU (PyTorch >= 2.3): same weights, same scale.
    try:
        ref = torch.amp.GradScaler("cpu", init_scale=2.0**16, growth_interval=4)
    except (AttributeError, TypeError, RuntimeError):
        ref = None
    if ref is not None:

        class TorchScaler:  # adapter: GradScaler's update() folded into step(), as the hand-written one does
            def __init__(self, inner):
                self.inner = inner

            def scale(self, loss):
                return self.inner.scale(loss)

            def unscale_(self, opt):
                self.inner.unscale_(opt)

            def step(self, opt):
                self.inner.step(opt)
                self.inner.update()
                return True

        model_t = copy.deepcopy(model)
        model_h = copy.deepcopy(model)
        opt_t = torch.optim.SGD(model_t.parameters(), lr=0.1)
        opt_h = torch.optim.SGD(model_h.parameters(), lr=0.1)
        hand = DynamicLossScaler(init_scale=2.0**16, growth_interval=4)
        torch_scaler = TorchScaler(ref)
        for i in range(6):
            hooks = []
            if i == 2:  # overflow on both
                hooks = [m[2].weight.register_hook(lambda g: g * float("inf")) for m in (model_t, model_h)]
            train_step(model_t, batch, opt_t, torch_scaler, torch.bfloat16)
            train_step(model_h, batch, opt_h, hand, torch.bfloat16)
            for h in hooks:
                h.remove()
            assert ref.get_scale() == hand.get_scale(), (i, ref.get_scale(), hand.get_scale())
        for p_t, p_h in zip(model_t.parameters(), model_h.parameters()):
            assert torch.allclose(p_t, p_h, rtol=1e-5, atol=1e-6)
        print("matches torch.amp.GradScaler")

    print("PASS")
`,
    },
  },
  debrief: `The scaler is three numbers — the scale, a count of consecutive good steps, and whether the current step overflowed — and the whole of mixed precision is where the three touch the loop. The loss is multiplied *before* \`backward\` so every gradient of the chain rule carries the factor and none of the small ones underflows in fp16 (\`2**16\` lifts \`2**-30\` into range); the gradients are divided *before* clipping and the step, so the optimizer and the clipper only ever see true gradients. A \`.grad\` that is \`inf\` or \`nan\` is not a bug to raise on but a signal: the scale is too high, so the step is dropped and the scale halves — a lost batch costs nothing, a poisoned weight costs the run. The growth schedule (×2 after 2000 clean steps) pushes the scale back up as the gradients shrink over training, which is why it is *dynamic*: a fixed scale is either too small at the start or overflows at the end. The parameters never leave float32 — \`torch.autocast\` casts a bf16 *copy* of each weight for the matmul and the fp32 master copy takes the update, so an update of \`1e-4\` on a weight of \`1.0\` is not rounded away (bf16 has three significant digits). Two engineering details are what \`torch.amp.GradScaler\` also does: the overflow check is one reduction and one host sync per parameter group, not an \`.item()\` per tensor (a 7B model has hundreds of tensors and each sync drains the GPU queue), and \`unscale_\` runs at most once per step so clipping cannot be applied to doubly unscaled gradients. Note what the self-test quietly shows: with bfloat16 the overflow has to be injected, because bf16 shares fp32's exponent range and almost never needs loss scaling — which is why Llama, GPT-NeoX and most recent pretraining runs use bf16 without a scaler, while fp16 on V100-era hardware cannot do without one. Production stacks go further: \`GradScaler\` fuses the unscale and the check into one kernel (\`_amp_foreach_non_finite_check_and_unscale_\`) and keeps the scale on the device so nothing syncs at all; FSDP's \`MixedPrecision\` policy keeps the sharded master weights in fp32 and all-gathers bf16; Transformer Engine does the matmuls in fp8 with per-tensor scaling that plays the same game at the level of individual activations.`,
};
