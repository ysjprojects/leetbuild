import type {Step} from '@/lib/types';

/** `torch.nn.utils.clip_grad_norm_` used inside the implementation (the self-test may compare against it). */
const LIBRARY_CLIP = /def (?:clip_grad_norm_|train_step)\b(?:(?!\n\S)[\s\S])*?utils\.clip_grad_norm_\(/;

/** A library schedule in place of `lr_at`. */
const LIBRARY_SCHEDULE = /lr_scheduler|CosineAnnealing|LambdaLR|OneCycleLR|get_cosine_schedule/;

export const trainStepStep: Step = {
  id: 'train-step',
  title: 'train_step(): accumulate, clip by the global norm, set the LR, step',
  concept: 'pytorch',
  file: 'train_step',
  focus: ['zero', 'loss', 'backward', 'grads', 'norm', 'clip', 'lr', 'optimizer', 'log', 'warmup', 'cosine', 'floor'],
  task: `## Task

Implement the three functions that wrap one optimizer step of an LLM training loop, by hand, in
\`train_step.py\`. No \`torch.optim.lr_scheduler\`, no \`torch.nn.utils.clip_grad_norm_\` inside the
implementation (the self-test uses it as the reference).

- \`lr_at(step, warmup_steps, total_steps, max_lr, min_lr) -> float\`: **linear warmup** for
  \`step < warmup_steps\` — \`max_lr × (step + 1) / warmup_steps\`, so step 0 is one warmup slice, never
  0 — then **cosine decay**: \`progress = (step − warmup_steps) / (total_steps − warmup_steps)\`,
  \`lr = min_lr + 0.5 × (1 + cos(π × progress)) × (max_lr − min_lr)\`; \`min_lr\` for every
  \`step >= total_steps\`. Pure \`math\`, no tensors.

:::widget lr-schedule {"warmup": 10, "total": 100}

- \`clip_grad_norm_(params, max_norm) -> Tensor\`: the **global** L2 norm of every \`.grad\` that is not
  \`None\` (the norm of the per-tensor norms); \`clip_coef = max_norm / (total_norm + 1e-6)\`; when
  \`clip_coef < 1\` scale every grad **in place** with \`mul_\`; return the norm **before** clipping. Under
  \`torch.no_grad()\`. \`params\` may be a generator — read it once.

:::widget grad-clip

- \`train_step(model, batch_iter, optimizer, accum_steps, step, *, warmup_steps, total_steps, max_lr,
  min_lr, max_norm=1.0) -> dict\`: \`optimizer.zero_grad(set_to_none=True)\` **once**, then
  \`accum_steps\` times \`x, y = next(batch_iter)\`, \`loss = F.cross_entropy(model(x), y) / accum_steps\`,
  \`loss.backward()\`; then \`clip_grad_norm_(model.parameters(), max_norm)\`, \`lr = lr_at(step, …)\`
  written into **every** \`optimizer.param_groups\` entry as \`group["lr"]\`, \`optimizer.step()\`. Return
  \`{"loss": sum of the scaled micro-batch losses, "grad_norm": the pre-clip norm as a float, "lr": lr}\`.
- The self-test at the end of the file checks the schedule at steps 0, 9, 10, 55, 100 and 1000
  (\`warmup 10, total 100, 1e-3 → 1e-5\`), the clipper against \`torch.nn.utils.clip_grad_norm_\` at
  \`max_norm=0.1\` (norm and gradients \`allclose\`, \`atol=1e-6\`), and two \`train_step\`s over four
  micro-batches of 4 against one batch of 16 with plain SGD: same loss, same gradient, same parameters
  after the update. Runs on CPU in a second.

> The gradient of a mean over 16 examples is the mean of four gradients over 4 — only if each
> micro-batch loss is divided by four before \`backward()\` and the \`.grad\` buffers are cleared once
> per optimizer step, not once per micro-batch.`,
  hints: [
    'Three branches in `lr_at`: `step < warmup_steps` → `max_lr * (step + 1) / warmup_steps`; `step >= total_steps` → `min_lr`; otherwise `progress` in `[0, 1)` and `min_lr + 0.5 * (1.0 + math.cos(math.pi * progress)) * (max_lr - min_lr)`. Check it in your head: progress 0 gives `max_lr`, progress 1 gives `min_lr`.',
    'In `clip_grad_norm_`: `grads = [p.grad for p in params if p.grad is not None]` (a generator is consumed once), `total_norm = torch.stack([g.norm(2.0) for g in grads]).norm(2.0)`, `clip_coef = max_norm / (total_norm + 1e-6)`, and `g.mul_(clip_coef)` for every grad only `if clip_coef < 1.0`. Decorate with `@torch.no_grad()` and return the norm you computed before scaling.',
    'In `train_step` the order is everything: `optimizer.zero_grad(set_to_none=True)` before the loop; `F.cross_entropy(logits, y) / accum_steps` then `.backward()` inside it; after the loop clip, compute `lr`, `for group in optimizer.param_groups: group["lr"] = lr`, and only then `optimizer.step()`. `loss.item()` on the scaled loss summed over the loop is the full-batch loss.',
  ],
  checks: [
    {
      id: 'warmup',
      title: 'Linear warmup to max_lr over warmup_steps',
      detail:
        '`lr_at(0)` is `max_lr / warmup_steps`, `lr_at(warmup_steps - 1)` is `max_lr`, and the ramp is monotone — written by hand with `step < warmup_steps` and a division by `warmup_steps`, not with `torch.optim.lr_scheduler`.',
      match: {python: {all: [/step\s*<\s*warmup_steps/, /\/\s*warmup_steps/], none: [LIBRARY_SCHEDULE]}},
    },
    {
      id: 'cosine-decay',
      title: 'Cosine decay to min_lr, constant after total_steps',
      detail:
        'Halfway through the decay the LR is exactly `(max_lr + min_lr) / 2`; at `total_steps` it is `min_lr`, and it stays there — `0.5 × (1 + cos(π × progress))` scaled between the two, with `step >= total_steps` answering `min_lr`.',
      match: {
        python: {
          all: [
            /0\.5\s*\*\s*\(\s*1(?:\.0)?\s*\+\s*math\.cos\(\s*math\.pi|\(\s*1(?:\.0)?\s*\+\s*math\.cos\(\s*math\.pi[^\n]*\)\s*\/\s*2/,
            /step\s*>=\s*total_steps/,
          ],
        },
      },
    },
    {
      id: 'global-norm',
      title: 'Clips by the global L2 norm, in place, by hand',
      detail:
        'The norm is taken over every parameter’s `.grad` together (the norm of the per-tensor norms), the grads are scaled in place with `mul_`, and `torch.nn.utils.clip_grad_norm_` / `clip_grad_value_` do not appear inside `clip_grad_norm_` or `train_step`.',
      match: {
        python: {
          all: [/\.norm\(|torch\.norm\(|vector_norm\(|torch\.sqrt\(/, /\.mul_\(/],
          none: [LIBRARY_CLIP, /clip_grad_value_\(/],
        },
      },
    },
    {
      id: 'pre-clip-norm',
      title: 'Returns the norm before clipping; scales only when over max_norm',
      detail:
        'Against `torch.nn.utils.clip_grad_norm_` at `max_norm=0.1` the returned norm (0.6876 on the self-test) and every gradient afterwards agree to `1e-6`; a norm under `max_norm` leaves the grads untouched. The work runs under `torch.no_grad()`.',
      match: {
        python: {
          all: [/clip_coef\s*<\s*1(?:\.0)?|clamp\([^\n]*max\s*=\s*1(?:\.0)?\s*\)/, /torch\.no_grad\(\)/],
          order: [/total_norm\s*=/, /\.mul_\(/, /return total_norm/],
        },
      },
    },
    {
      id: 'accumulate',
      title: 'Four micro-batches of 4 give the gradient of one batch of 16',
      detail:
        'The `.grad` buffers are cleared with `zero_grad(set_to_none=True)` once, before the loop over `range(accum_steps)`; each micro-batch loss is divided by `accum_steps` before `backward()`, so the sum of the four gradients is the mean-over-16 gradient (`allclose`, `atol=1e-6`).',
      match: {
        python: {
          all: [/range\(\s*accum_steps\s*\)/, /\/\s*accum_steps/],
          order: [/zero_grad\(\s*set_to_none\s*=\s*True\s*\)/, /range\(\s*accum_steps\s*\)/, /\.backward\(\)/],
        },
      },
    },
    {
      id: 'clip-lr-step',
      title: 'Clips after the last backward, sets the LR on every group, then steps',
      detail:
        '`clip_grad_norm_(model.parameters(), max_norm)` runs once, after the accumulation loop; `lr_at(step, …)` is written into `group["lr"]` for every entry of `optimizer.param_groups`; `optimizer.step()` comes last, so the update uses the clipped gradient and this step’s LR.',
      match: {
        python: {
          all: [/lr_at\(\s*step\b/],
          order: [
            /\.backward\(\)/,
            /clip_grad_norm_\(\s*model\.parameters\(\)/,
            /for \w+ in optimizer\.param_groups\s*:/,
            /\[\s*["']lr["']\s*\]\s*=\s*lr\b/,
            /optimizer\.step\(\)/,
          ],
        },
      },
    },
    {
      id: 'report',
      title: 'Reports loss, pre-clip grad_norm and lr as floats',
      detail:
        '`train_step` returns `{"loss", "grad_norm", "lr"}`: the summed scaled losses equal the big-batch loss, `grad_norm` equals the reference norm before clipping, `lr` equals `lr_at(step, …)` and the optimizer’s group LR — the three numbers every training log plots.',
      match: {python: {all: [/["']loss["']\s*:/, /["']grad_norm["']\s*:/, /["']lr["']\s*:/]}},
    },
  ],
  code: {
    python: {
      starter: `"""The plumbing around one optimizer step of an LLM run: warmup + cosine schedule, global-norm clipping, gradient accumulation."""
import copy
import math
from collections.abc import Iterable, Iterator

import torch
import torch.nn as nn
import torch.nn.functional as F


def lr_at(step: int, warmup_steps: int, total_steps: int, max_lr: float, min_lr: float) -> float:
    """Linear warmup to max_lr over warmup_steps, cosine decay to min_lr at total_steps, min_lr for ever after."""
    # TODO: step < warmup_steps → max_lr * (step + 1) / warmup_steps; step >= total_steps → min_lr;
    #       otherwise progress in [0, 1) and min_lr + 0.5 * (1 + cos(pi * progress)) * (max_lr - min_lr)
    raise NotImplementedError("TODO")


@torch.no_grad()
def clip_grad_norm_(params: Iterable[torch.Tensor], max_norm: float) -> torch.Tensor:
    """Scale every .grad in place so their global L2 norm is at most max_norm; return the norm before clipping."""
    # TODO: collect the grads that are not None (params may be a generator), norm of the per-tensor norms,
    #       clip_coef = max_norm / (total_norm + 1e-6), mul_ every grad by it only when clip_coef < 1
    raise NotImplementedError("TODO")


def train_step(
    model: nn.Module,
    batch_iter: Iterator[tuple[torch.Tensor, torch.Tensor]],
    optimizer: torch.optim.Optimizer,
    accum_steps: int,
    step: int,
    *,
    warmup_steps: int,
    total_steps: int,
    max_lr: float,
    min_lr: float,
    max_norm: float = 1.0,
) -> dict[str, float]:
    """One optimizer step over accum_steps micro-batches: accumulate, clip, set the LR, step."""
    # TODO: zero the grads once (set_to_none=True); accum_steps times: next(batch_iter), cross-entropy / accum_steps,
    #       backward; then clip, lr = lr_at(...), write it into every optimizer.param_groups entry, optimizer.step();
    #       return {"loss": summed scaled losses, "grad_norm": pre-clip norm, "lr": lr}
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    WARMUP, TOTAL, MAX_LR, MIN_LR = 10, 100, 1e-3, 1e-5
    sched = lambda s: lr_at(s, WARMUP, TOTAL, MAX_LR, MIN_LR)

    # 1. The schedule: warmup ramp, peak, cosine midpoint, floor, constant after the end.
    assert math.isclose(sched(0), MAX_LR / WARMUP), sched(0)
    assert math.isclose(sched(WARMUP - 1), MAX_LR) and math.isclose(sched(WARMUP), MAX_LR)
    assert math.isclose(sched((WARMUP + TOTAL) // 2), MIN_LR + 0.5 * (MAX_LR - MIN_LR)), sched(55)
    assert math.isclose(sched(TOTAL), MIN_LR) and math.isclose(sched(TOTAL + 900), MIN_LR)
    curve = [sched(s) for s in range(TOTAL + 1)]
    assert all(a <= b for a, b in zip(curve[:WARMUP], curve[1:WARMUP])), "warmup must rise"
    assert all(a >= b for a, b in zip(curve[WARMUP:], curve[WARMUP + 1 :])), "decay must fall"
    print(f"lr: step 0 {sched(0):.2e} · step {WARMUP} {sched(WARMUP):.2e} · step 55 {sched(55):.2e} · step {TOTAL} {sched(TOTAL):.2e}")

    # 2. The clipper against torch's: same norm reported, same gradients left behind.
    model = nn.Sequential(nn.Linear(8, 32), nn.Tanh(), nn.Linear(32, 4))
    x, y = torch.randn(16, 8), torch.randint(0, 4, (16,))
    ours, theirs = model, copy.deepcopy(model)
    for m in (ours, theirs):
        F.cross_entropy(m(x), y).backward()
    norm_ours = clip_grad_norm_(ours.parameters(), 0.1)
    norm_theirs = torch.nn.utils.clip_grad_norm_(theirs.parameters(), 0.1)
    assert norm_ours > 0.1, "pick a case that actually clips"
    assert torch.allclose(norm_ours, norm_theirs, atol=1e-6), (norm_ours, norm_theirs)
    for a, b in zip(ours.parameters(), theirs.parameters()):
        assert torch.allclose(a.grad, b.grad, atol=1e-6)
    clipped = torch.stack([p.grad.norm() for p in ours.parameters()]).norm()
    assert math.isclose(clipped.item(), 0.1, rel_tol=1e-4), clipped
    print(f"clip: pre-clip norm {norm_ours.item():.4f} (torch {norm_theirs.item():.4f}) · post-clip {clipped.item():.4f}")

    # 3. Accumulation over 4 micro-batches of 4 == one batch of 16: same loss, same gradient, same update, twice.
    x, y = torch.randn(32, 8), torch.randint(0, 4, (32,))
    accum = nn.Sequential(nn.Linear(8, 32), nn.Tanh(), nn.Linear(32, 4))
    big = copy.deepcopy(accum)
    opt_accum = torch.optim.SGD(accum.parameters(), lr=0.0)
    opt_big = torch.optim.SGD(big.parameters(), lr=0.0)
    micro = iter((x[i : i + 4], y[i : i + 4]) for i in range(0, 32, 4))
    for k in range(2):
        out = train_step(accum, micro, opt_accum, 4, k, warmup_steps=WARMUP, total_steps=TOTAL, max_lr=MAX_LR, min_lr=MIN_LR, max_norm=1e9)
        for p in big.parameters():
            p.grad = None
        xb, yb = x[16 * k : 16 * (k + 1)], y[16 * k : 16 * (k + 1)]
        loss_big = F.cross_entropy(big(xb), yb)
        loss_big.backward()
        norm_big = torch.nn.utils.clip_grad_norm_(big.parameters(), 1e9)
        for a, b in zip(accum.parameters(), big.parameters()):
            assert torch.allclose(a.grad, b.grad, atol=1e-6), "accumulated gradient differs from the big batch"
        assert math.isclose(out["loss"], loss_big.item(), rel_tol=1e-5), (out["loss"], loss_big.item())
        assert math.isclose(out["grad_norm"], norm_big.item(), rel_tol=1e-5)
        assert math.isclose(out["lr"], sched(k)) and opt_accum.param_groups[0]["lr"] == out["lr"]
        for g in opt_big.param_groups:
            g["lr"] = out["lr"]
        opt_big.step()
        for a, b in zip(accum.parameters(), big.parameters()):
            assert torch.allclose(a, b, atol=1e-6), "update differs from the big batch"
        print(f"step {k}: loss {out['loss']:.4f} · grad_norm {out['grad_norm']:.4f} · lr {out['lr']:.2e}")
    print("PASS")
`,
      solution: `"""The plumbing around one optimizer step of an LLM run: warmup + cosine schedule, global-norm clipping, gradient accumulation."""
import copy
import math
from collections.abc import Iterable, Iterator

import torch
import torch.nn as nn
import torch.nn.functional as F


def lr_at(step: int, warmup_steps: int, total_steps: int, max_lr: float, min_lr: float) -> float:
    """Linear warmup to max_lr over warmup_steps, cosine decay to min_lr at total_steps, min_lr for ever after."""
    if step < warmup_steps:
        return max_lr * (step + 1) / warmup_steps
    if step >= total_steps:
        return min_lr
    progress = (step - warmup_steps) / (total_steps - warmup_steps)
    coeff = 0.5 * (1.0 + math.cos(math.pi * progress))
    return min_lr + coeff * (max_lr - min_lr)


@torch.no_grad()
def clip_grad_norm_(params: Iterable[torch.Tensor], max_norm: float) -> torch.Tensor:
    """Scale every .grad in place so their global L2 norm is at most max_norm; return the norm before clipping."""
    grads = [p.grad for p in params if p.grad is not None]
    if not grads:
        return torch.tensor(0.0)
    total_norm = torch.stack([g.norm(2.0) for g in grads]).norm(2.0)
    clip_coef = max_norm / (total_norm + 1e-6)
    if clip_coef < 1.0:
        for g in grads:
            g.mul_(clip_coef)
    return total_norm


def train_step(
    model: nn.Module,
    batch_iter: Iterator[tuple[torch.Tensor, torch.Tensor]],
    optimizer: torch.optim.Optimizer,
    accum_steps: int,
    step: int,
    *,
    warmup_steps: int,
    total_steps: int,
    max_lr: float,
    min_lr: float,
    max_norm: float = 1.0,
) -> dict[str, float]:
    """One optimizer step over accum_steps micro-batches: accumulate, clip, set the LR, step."""
    optimizer.zero_grad(set_to_none=True)
    loss_sum = 0.0
    for _ in range(accum_steps):
        x, y = next(batch_iter)
        logits = model(x)
        loss = F.cross_entropy(logits, y) / accum_steps
        loss.backward()
        loss_sum += loss.item()
    grad_norm = clip_grad_norm_(model.parameters(), max_norm)
    lr = lr_at(step, warmup_steps, total_steps, max_lr, min_lr)
    for group in optimizer.param_groups:
        group["lr"] = lr
    optimizer.step()
    return {"loss": loss_sum, "grad_norm": grad_norm.item(), "lr": lr}


if __name__ == "__main__":
    torch.manual_seed(0)
    WARMUP, TOTAL, MAX_LR, MIN_LR = 10, 100, 1e-3, 1e-5
    sched = lambda s: lr_at(s, WARMUP, TOTAL, MAX_LR, MIN_LR)

    # 1. The schedule: warmup ramp, peak, cosine midpoint, floor, constant after the end.
    assert math.isclose(sched(0), MAX_LR / WARMUP), sched(0)
    assert math.isclose(sched(WARMUP - 1), MAX_LR) and math.isclose(sched(WARMUP), MAX_LR)
    assert math.isclose(sched((WARMUP + TOTAL) // 2), MIN_LR + 0.5 * (MAX_LR - MIN_LR)), sched(55)
    assert math.isclose(sched(TOTAL), MIN_LR) and math.isclose(sched(TOTAL + 900), MIN_LR)
    curve = [sched(s) for s in range(TOTAL + 1)]
    assert all(a <= b for a, b in zip(curve[:WARMUP], curve[1:WARMUP])), "warmup must rise"
    assert all(a >= b for a, b in zip(curve[WARMUP:], curve[WARMUP + 1 :])), "decay must fall"
    print(f"lr: step 0 {sched(0):.2e} · step {WARMUP} {sched(WARMUP):.2e} · step 55 {sched(55):.2e} · step {TOTAL} {sched(TOTAL):.2e}")

    # 2. The clipper against torch's: same norm reported, same gradients left behind.
    model = nn.Sequential(nn.Linear(8, 32), nn.Tanh(), nn.Linear(32, 4))
    x, y = torch.randn(16, 8), torch.randint(0, 4, (16,))
    ours, theirs = model, copy.deepcopy(model)
    for m in (ours, theirs):
        F.cross_entropy(m(x), y).backward()
    norm_ours = clip_grad_norm_(ours.parameters(), 0.1)
    norm_theirs = torch.nn.utils.clip_grad_norm_(theirs.parameters(), 0.1)
    assert norm_ours > 0.1, "pick a case that actually clips"
    assert torch.allclose(norm_ours, norm_theirs, atol=1e-6), (norm_ours, norm_theirs)
    for a, b in zip(ours.parameters(), theirs.parameters()):
        assert torch.allclose(a.grad, b.grad, atol=1e-6)
    clipped = torch.stack([p.grad.norm() for p in ours.parameters()]).norm()
    assert math.isclose(clipped.item(), 0.1, rel_tol=1e-4), clipped
    print(f"clip: pre-clip norm {norm_ours.item():.4f} (torch {norm_theirs.item():.4f}) · post-clip {clipped.item():.4f}")

    # 3. Accumulation over 4 micro-batches of 4 == one batch of 16: same loss, same gradient, same update, twice.
    x, y = torch.randn(32, 8), torch.randint(0, 4, (32,))
    accum = nn.Sequential(nn.Linear(8, 32), nn.Tanh(), nn.Linear(32, 4))
    big = copy.deepcopy(accum)
    opt_accum = torch.optim.SGD(accum.parameters(), lr=0.0)
    opt_big = torch.optim.SGD(big.parameters(), lr=0.0)
    micro = iter((x[i : i + 4], y[i : i + 4]) for i in range(0, 32, 4))
    for k in range(2):
        out = train_step(accum, micro, opt_accum, 4, k, warmup_steps=WARMUP, total_steps=TOTAL, max_lr=MAX_LR, min_lr=MIN_LR, max_norm=1e9)
        for p in big.parameters():
            p.grad = None
        xb, yb = x[16 * k : 16 * (k + 1)], y[16 * k : 16 * (k + 1)]
        loss_big = F.cross_entropy(big(xb), yb)
        loss_big.backward()
        norm_big = torch.nn.utils.clip_grad_norm_(big.parameters(), 1e9)
        for a, b in zip(accum.parameters(), big.parameters()):
            assert torch.allclose(a.grad, b.grad, atol=1e-6), "accumulated gradient differs from the big batch"
        assert math.isclose(out["loss"], loss_big.item(), rel_tol=1e-5), (out["loss"], loss_big.item())
        assert math.isclose(out["grad_norm"], norm_big.item(), rel_tol=1e-5)
        assert math.isclose(out["lr"], sched(k)) and opt_accum.param_groups[0]["lr"] == out["lr"]
        for g in opt_big.param_groups:
            g["lr"] = out["lr"]
        opt_big.step()
        for a, b in zip(accum.parameters(), big.parameters()):
            assert torch.allclose(a, b, atol=1e-6), "update differs from the big batch"
        print(f"step {k}: loss {out['loss']:.4f} · grad_norm {out['grad_norm']:.4f} · lr {out['lr']:.2e}")
    print("PASS")
`,
    },
  },
  debrief: `Three small functions, and each is shaped by a failure it prevents. The schedule is a pure function of \`step\` rather than a stateful object because a run that restarts from a checkpoint must land on exactly the LR it had — \`lr_at(step)\` needs nothing but the step counter, and writing it into every \`param_groups\` entry is what makes it apply to the weight-decayed and the no-decay groups alike (nanoGPT's \`get_lr\` is this function; HuggingFace's \`get_cosine_schedule_with_warmup\` wraps it in a \`LambdaLR\`). Warmup starts at one slice rather than 0 because a step at LR 0 is a wasted forward-backward, and it exists at all because Adam's second-moment estimate is garbage for the first few hundred steps — a full-size LR then takes a few huge steps that the run never recovers from. Clipping takes the **global** norm, not a per-tensor one, so a spike scales the whole update down without changing its direction; the \`1e-6\` keeps a zero gradient from dividing by zero, the \`clip_coef < 1\` guard keeps a small gradient from being scaled *up*, and the pre-clip norm is returned because it is the single most useful health signal in a training log — loss spikes are preceded by grad-norm spikes, and a run whose norm is clipped on every step has an LR problem, not a clipping solution. Accumulation divides each micro-batch loss by \`accum_steps\` *before* \`backward()\` so the sum of the four gradients is the mean gradient of the whole batch (dividing afterwards would need a pass over \`.grad\`; not dividing gives a gradient four times too large, which the clipper would then silently hide); \`zero_grad(set_to_none=True)\` once per step, not per micro-batch, is what lets the buffers accumulate, and \`set_to_none\` makes the first \`backward\` *assign* rather than add to a zeroed tensor, saving a memset and a read of every gradient. Production loops keep this shape and bolt things on: \`torch.nn.utils.clip_grad_norm_\` with \`foreach=True\` computes the norm in a handful of fused kernels; under mixed precision \`scaler.unscale_(optimizer)\` must come before the clip so the norm is of the real gradients; DDP wraps the first \`accum_steps − 1\` micro-batches in \`no_sync()\` so the all-reduce happens once per step; FSDP's \`clip_grad_norm_\` all-reduces the per-shard norms before scaling; and Megatron logs exactly the three numbers this function returns on every step.`,
};
