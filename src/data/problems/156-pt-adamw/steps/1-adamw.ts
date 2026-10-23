import type {Step} from '@/lib/types';

/** The step counter, whichever way the solution spells it: `step` or `state["step"]`. */
const STEP = String.raw`(?:step|state\[\s*["']step["']\s*\])`;

/** The shared tail of the self-test, identical in the starter and the solution. */
const SELF_TEST = `

def make_model():
    torch.manual_seed(0)
    return nn.Sequential(nn.Linear(8, 16), nn.Tanh(), nn.Linear(16, 4)).double()


def match_reference(amsgrad, steps=25):
    """Two copies of one model, ours against torch.optim.AdamW: every parameter and moment agrees after every step."""
    torch.manual_seed(0)
    x = torch.randn(32, 8, dtype=torch.float64)
    y = torch.randn(32, 4, dtype=torch.float64)
    ours_model = make_model()
    ref_model = copy.deepcopy(ours_model)
    kwargs = dict(lr=1e-2, betas=(0.9, 0.999), eps=1e-8, weight_decay=0.1, amsgrad=amsgrad)
    ours = AdamW(ours_model.parameters(), **kwargs)
    ref = torch.optim.AdamW(ref_model.parameters(), **kwargs)
    for t in range(1, steps + 1):
        for model, opt in ((ours_model, ours), (ref_model, ref)):
            opt.zero_grad()
            nn.functional.mse_loss(model(x), y).backward()
            opt.step()
        for (name, a), b in zip(ours_model.named_parameters(), ref_model.parameters()):
            assert torch.allclose(a, b, rtol=0, atol=1e-7), (
                f"amsgrad={amsgrad} step {t} {name}: max |delta| = {(a - b).abs().max():.3e}"
            )
    for a, b in zip(ours_model.parameters(), ref_model.parameters()):
        ours_state, ref_state = ours.state[a], ref.state[b]
        assert ours_state["step"] == steps and int(ref_state["step"]) == steps
        assert ("max_exp_avg_sq" in ours_state) == amsgrad
        assert torch.allclose(ours_state["exp_avg"], ref_state["exp_avg"], rtol=0, atol=1e-7)
        assert torch.allclose(ours_state["exp_avg_sq"], ref_state["exp_avg_sq"], rtol=0, atol=1e-7)


if __name__ == "__main__":
    match_reference(amsgrad=False)
    match_reference(amsgrad=True)

    # A parameter without a gradient is skipped and gets no state; the closure's loss comes back.
    torch.manual_seed(0)
    model = make_model()
    model[2].weight.requires_grad_(False)
    frozen = model[2].weight.clone()
    opt = AdamW(model.parameters(), lr=1e-2, weight_decay=0.1)
    x, y = torch.randn(4, 8, dtype=torch.float64), torch.randn(4, 4, dtype=torch.float64)

    def closure():
        opt.zero_grad()
        loss = nn.functional.mse_loss(model(x), y)
        loss.backward()
        return loss

    loss = opt.step(closure)
    assert isinstance(loss, torch.Tensor) and loss.dim() == 0
    assert torch.equal(model[2].weight, frozen), "a parameter with grad None must not move"
    assert len(opt.state[model[2].weight]) == 0, "a skipped parameter gets no state"
    assert opt.state[model[0].weight]["step"] == 1

    # Sparse gradients are rejected.
    emb = nn.Embedding(10, 4, sparse=True)
    sparse_opt = AdamW(emb.parameters(), lr=1e-2)
    emb(torch.tensor([1, 2])).sum().backward()
    try:
        sparse_opt.step()
        raise AssertionError("a sparse gradient was accepted")
    except RuntimeError as e:
        assert "sparse" in str(e)

    print("PASS")
`;

/** The head of the file: imports and the constructor, which the learner keeps. */
const HEAD = `"""AdamW from scratch: bias-corrected moments and decoupled weight decay, matched step by step against torch.optim.AdamW."""
import copy
import math

import torch
import torch.nn as nn


class AdamW(torch.optim.Optimizer):
    """Adam with decoupled weight decay (Loshchilov & Hutter, 2019): the optimizer under GPT and LLaMA training."""

    def __init__(self, params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=1e-2, amsgrad=False):
        if lr < 0.0:
            raise ValueError(f"Invalid learning rate: {lr}")
        if eps < 0.0:
            raise ValueError(f"Invalid epsilon value: {eps}")
        if not 0.0 <= betas[0] < 1.0 or not 0.0 <= betas[1] < 1.0:
            raise ValueError(f"Invalid betas: {betas}")
        if weight_decay < 0.0:
            raise ValueError(f"Invalid weight_decay value: {weight_decay}")
        defaults = dict(lr=lr, betas=betas, eps=eps, weight_decay=weight_decay, amsgrad=amsgrad)
        super().__init__(params, defaults)
`;

export const adamwStep: Step = {
  id: 'adamw',
  title: 'AdamW.step(): lazy state, two moments, bias correction, decoupled decay',
  concept: 'pytorch',
  file: 'adamw',
  focus: ['count', 'm', 'v', 'amsgrad', 'bias', 'denom', 'decay', 'update'],
  task: `## Task

Implement \`AdamW.step(self, closure=None)\` on the given \`torch.optim.Optimizer\` subclass. The constructor
already stores \`lr\`, \`betas\`, \`eps\`, \`weight_decay\` and \`amsgrad\` as group defaults; everything below
reads them from \`group\` while looping over \`self.param_groups\` and \`group["params"]\`.

- Decorate \`step\` with \`@torch.no_grad()\`. If \`closure\` is given, call it under \`with torch.enable_grad():\`
  and return its loss (\`None\` otherwise).
- Skip a parameter whose \`p.grad is None\`; raise \`RuntimeError\` when \`grad.is_sparse\`.
- **Lazy state.** \`state = self.state[p]\`; when it is empty, create \`state["step"] = 0\` (an \`int\`),
  \`state["exp_avg"]\` and \`state["exp_avg_sq"]\` with \`torch.zeros_like(p, memory_format=torch.preserve_format)\`,
  and \`state["max_exp_avg_sq"]\` only when \`amsgrad\`. Then \`state["step"] += 1\`.
- **Decoupled weight decay first**: \`p.mul_(1 - lr * weight_decay)\`. Never add \`weight_decay * p\` to the gradient.
- **Moments**, in place: \`exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)\` and
  \`exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)\`.
- **Bias correction** from the step count: \`bias_correction1 = 1 - beta1**step\`,
  \`bias_correction2 = 1 - beta2**step\`, \`step_size = lr / bias_correction1\`.
- **Denominator**: \`denom = (exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)\`; \`eps\` goes in
  **after** the square root. With \`amsgrad\`, first \`torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)\`
  and use \`max_exp_avg_sq\` in place of \`exp_avg_sq\`.
- **Update** in place: \`p.addcdiv_(exp_avg, denom, value=-step_size)\`. No \`p.data\`, no reassignment of \`p\`.
- The file ends with the self-test: 25 steps on a \`float64\` MLP against \`torch.optim.AdamW\`, with and
  without \`amsgrad\`, every parameter and moment within \`atol=1e-7\` after every step; a frozen parameter
  untouched and stateless; \`step(closure)\` returning the loss; a sparse gradient rejected. It prints \`PASS\`.

> Adam normalises each coordinate's step by its own gradient scale. Weight decay added to the gradient
> goes through that normalisation too and all but vanishes for weights with large gradients. Applied to
> the parameter directly, it shrinks every weight by the same factor \`1 − lr × wd\`: that one move is AdamW.

Turn the weight decay up below and compare Adam's path with AdamW's on an ill-conditioned loss:

:::widget optimizer-paths`,
  hints: [
    'Shape of the loop: `for group in self.param_groups:` unpack `lr`, `beta1, beta2 = group["betas"]`, `eps`, `weight_decay`, `amsgrad`; then `for p in group["params"]:` with `if p.grad is None: continue` and `grad = p.grad`. `state = self.state[p]` is a dict that is empty the first time: fill it then.',
    'Order inside the parameter loop: `state["step"] += 1`, then `p.mul_(1 - lr * weight_decay)`, then the two moments in place, then `bias_correction1` and `bias_correction2` from the new step count, then `denom`, then `p.addcdiv_`. Incrementing first means step 1 uses `t = 1` and never divides by `1 - beta1**0 = 0`.',
    'Reading a failure: off at step 1 by about `lr · wd · p` means the decay went into the gradient (or was skipped); off by a factor near 3 means a missing bias correction; differences only where gradients are tiny mean `eps` sits inside the square root; a mismatch that appears only in the `amsgrad=True` run means the maximum was taken over the corrected `v` or not stored in state.',
  ],
  checks: [
    {
      id: 'lazy-state',
      title: 'State is created the first time a parameter is seen',
      detail:
        'An empty `self.state[p]` gets `state["step"] = 0` (an int) and `state["exp_avg"]`, `state["exp_avg_sq"]` as `torch.zeros_like(p, …)`; after one step a frozen parameter still has `len(opt.state[p]) == 0` and an updated one has `state["step"] == 1`.',
      match: {
        python: {
          all: [
            /state\[\s*["']step["']\s*\]\s*=\s*0\b/,
            /state\[\s*["']exp_avg["']\s*\]\s*=\s*torch\.zeros_like\(\s*p\b/,
            /state\[\s*["']exp_avg_sq["']\s*\]\s*=\s*torch\.zeros_like\(\s*p\b/,
            /state\[\s*["']step["']\s*\]\s*\+=\s*1\b/,
          ],
        },
      },
    },
    {
      id: 'moments',
      title: 'Running averages of the gradient and its square, in place',
      detail:
        '`exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)` and `exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)`: the state tensors are updated in place, never replaced, so `exp_avg` and `exp_avg_sq` agree with the reference’s within 1e-7 after 25 steps.',
      match: {
        python: {
          all: [
            /exp_avg\s*\.\s*(?:mul_\(\s*beta1\s*\)\s*\.\s*add_\(\s*grad\s*,\s*alpha\s*=\s*1\s*-\s*beta1\s*\)|lerp_\(\s*grad\s*,\s*1\s*-\s*beta1\s*\))/,
            /exp_avg_sq\s*\.\s*mul_\(\s*beta2\s*\)\s*\.\s*addcmul_\(\s*grad\s*,\s*grad(?:\.conj\(\))?\s*,\s*value\s*=\s*1\s*-\s*beta2\s*\)/,
          ],
          none: [/exp_avg\s*=\s*beta1\s*\*/, /exp_avg_sq\s*=\s*beta2\s*\*/],
        },
      },
    },
    {
      id: 'bias-correction',
      title: 'Both moments are bias-corrected from the step count',
      detail:
        '`1 - beta1**step` and `1 - beta2**step` from `state["step"]`; the step size is `lr / bias_correction1` and the second moment is divided by `bias_correction2` before the square root is taken. Step 1 then moves every coordinate by about `lr`, not by `lr × (1 − β1) / √(1 − β2) ≈ 3.2 lr`.',
      match: {
        python: {
          all: [
            new RegExp(String.raw`1\s*-\s*beta1\s*\*\*\s*${STEP}`),
            new RegExp(String.raw`1\s*-\s*beta2\s*\*\*\s*${STEP}`),
            /lr\s*\/\s*bias_correction1\b/,
            /math\.sqrt\(\s*bias_correction2\s*\)|bias_correction2\s*\*\*\s*0\.5/,
          ],
        },
      },
    },
    {
      id: 'decoupled-decay',
      title: 'Weight decay shrinks the parameter, before the update, never the gradient',
      detail:
        '`p.mul_(1 - lr * weight_decay)` runs before `p.addcdiv_`, and `weight_decay * p` is never added to `grad`: that would be L2-regularised Adam, which the reference’s `weight_decay=0.1` run would catch at the first step.',
      match: {
        python: {
          all: [/p\.mul_\(\s*1\s*-\s*lr\s*\*\s*weight_decay\s*\)/],
          none: [/grad\s*\.?\s*add_?\(\s*p\b/, /weight_decay\s*\*\s*p\b/, /p\s*\*\s*weight_decay\b/],
          order: [/p\.mul_\(\s*1\s*-\s*lr\s*\*\s*weight_decay\s*\)/, /p\.addcdiv_\(/],
        },
      },
    },
    {
      id: 'eps-after-sqrt',
      title: 'eps is added after the square root; the update is one in-place addcdiv_',
      detail:
        '`denom = (exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)` then `p.addcdiv_(exp_avg, denom, value=-step_size)`. `sqrt(v + eps)` is a different optimizer (and does not match the reference); `p = p - …` or `p.data` would replace the leaf or dodge autograd’s bookkeeping.',
      match: {
        python: {
          all: [
            /\.sqrt\(\)\s*\/\s*(?:math\.sqrt\(\s*bias_correction2\s*\)|bias_correction2_sqrt)\s*\)\s*\.add_\(\s*eps\s*\)/,
            /p\.addcdiv_\(\s*exp_avg\s*,\s*denom\s*,\s*value\s*=\s*-\s*step_size\s*\)/,
          ],
          none: [/\+\s*eps\s*\)\s*\.sqrt\(\)/, /sqrt\(\s*exp_avg_sq\s*\+\s*eps/, /p\.data\b/, /\bp\s*=\s*p\s*-/],
        },
      },
    },
    {
      id: 'amsgrad',
      title: 'amsgrad keeps a running maximum of the second moment in state',
      detail:
        'With `amsgrad=True` the state also holds `max_exp_avg_sq`, updated by `torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)` and used in the denominator instead of `exp_avg_sq`; without it the key is absent (`("max_exp_avg_sq" in state) == amsgrad`).',
      match: {
        python: {
          all: [
            /if amsgrad:\s*\n\s*state\[\s*["']max_exp_avg_sq["']\s*\]\s*=\s*torch\.zeros_like\(\s*p\b/,
            /torch\.maximum\(\s*max_exp_avg_sq\s*,\s*exp_avg_sq\s*,\s*out\s*=\s*max_exp_avg_sq\s*\)/,
            /max_exp_avg_sq\.sqrt\(\)/,
          ],
        },
      },
    },
    {
      id: 'no-grad-skip-sparse',
      title: 'Runs under no_grad, skips grad None, rejects sparse gradients',
      detail:
        '`step` is decorated `@torch.no_grad()` so the in-place `mul_`/`addcdiv_` on leaf tensors are legal and untracked; `if p.grad is None: continue` leaves a frozen parameter untouched and stateless; `grad.is_sparse` raises `RuntimeError` instead of producing a dense update from a sparse one.',
      match: {
        python: {
          all: [
            /@torch\.no_grad\(\)\s*\n\s*def step\(\s*self\s*,\s*closure\s*=\s*None\s*\)/,
            /if p\.grad is None:\s*\n\s*continue\b/,
            /if grad\.is_sparse:\s*\n\s*raise RuntimeError\(/,
          ],
        },
      },
    },
    {
      id: 'closure',
      title: 'A closure runs with grad enabled and its loss is returned',
      detail:
        '`step(closure)` calls `closure()` inside `with torch.enable_grad():` (`step` itself is under `no_grad`, and the closure has to build a graph and call `backward`) and returns what it returned (`None` when there is no closure).',
      match: {
        python: {
          all: [/with torch\.enable_grad\(\):\s*\n\s*loss = closure\(\)/, /return loss\b/],
          order: [/loss = None/, /loss = closure\(\)/, /for group in self\.param_groups:/, /return loss\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `${HEAD}
    def step(self, closure=None):
        """One update of every parameter that has a gradient; returns the closure's loss, if any."""
        # TODO: decorate with @torch.no_grad(); if closure is given, run it under torch.enable_grad() and keep its loss
        # TODO: for each group and each p with a gradient (skip grad None, reject grad.is_sparse):
        #   - first sight: state["step"] = 0, state["exp_avg"], state["exp_avg_sq"] (zeros_like p), and
        #     state["max_exp_avg_sq"] when amsgrad
        #   - state["step"] += 1
        #   - decoupled weight decay on p itself, before the update
        #   - exp_avg, exp_avg_sq: exponential moving averages of grad and grad*grad
        #   - bias_correction1 / bias_correction2 from the step count
        #   - denom = sqrt(v_hat) + eps (amsgrad: running max of exp_avg_sq, kept in state)
        #   - p.addcdiv_(exp_avg, denom, value=-step_size)
        # TODO: return loss
        raise NotImplementedError("TODO")
${SELF_TEST}`,
      solution: `${HEAD}
    @torch.no_grad()
    def step(self, closure=None):
        """One update of every parameter that has a gradient; returns the closure's loss, if any."""
        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()

        for group in self.param_groups:
            lr = group["lr"]
            beta1, beta2 = group["betas"]
            eps = group["eps"]
            weight_decay = group["weight_decay"]
            amsgrad = group["amsgrad"]

            for p in group["params"]:
                if p.grad is None:
                    continue
                grad = p.grad
                if grad.is_sparse:
                    raise RuntimeError("AdamW does not support sparse gradients")

                state = self.state[p]
                if len(state) == 0:
                    state["step"] = 0
                    state["exp_avg"] = torch.zeros_like(p, memory_format=torch.preserve_format)
                    state["exp_avg_sq"] = torch.zeros_like(p, memory_format=torch.preserve_format)
                    if amsgrad:
                        state["max_exp_avg_sq"] = torch.zeros_like(p, memory_format=torch.preserve_format)

                state["step"] += 1
                step = state["step"]
                exp_avg, exp_avg_sq = state["exp_avg"], state["exp_avg_sq"]

                # Decoupled weight decay: shrink the parameter itself; the gradient is never touched.
                p.mul_(1 - lr * weight_decay)

                # m_t = b1 * m_{t-1} + (1 - b1) * g_t        v_t = b2 * v_{t-1} + (1 - b2) * g_t^2
                exp_avg.mul_(beta1).add_(grad, alpha=1 - beta1)
                exp_avg_sq.mul_(beta2).addcmul_(grad, grad, value=1 - beta2)

                bias_correction1 = 1 - beta1**step
                bias_correction2 = 1 - beta2**step

                # denom = sqrt(v_t / (1 - b2^t)) + eps: eps is added after the square root.
                if amsgrad:
                    max_exp_avg_sq = state["max_exp_avg_sq"]
                    torch.maximum(max_exp_avg_sq, exp_avg_sq, out=max_exp_avg_sq)
                    denom = (max_exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)
                else:
                    denom = (exp_avg_sq.sqrt() / math.sqrt(bias_correction2)).add_(eps)

                # p -= lr / (1 - b1^t) * m_t / denom
                step_size = lr / bias_correction1
                p.addcdiv_(exp_avg, denom, value=-step_size)

        return loss
${SELF_TEST}`,
    },
  },
  debrief: `The whole optimizer is about forty lines because \`torch.optim.Optimizer\` already owns the two things that are not arithmetic: \`param_groups\` (each a dict of parameters plus hyper-parameters, filled from \`defaults\`) and \`state\`, a per-parameter dict that is empty until \`step\` first meets the parameter. That is why the moments are created lazily inside the loop and why a frozen parameter never acquires any. The order inside the loop is the reference's: the decoupled decay \`p.mul_(1 - lr * wd)\` **before** the Adam update, so the shrink is on the parameter the gradient was computed from (as in Algorithm 2 of the paper); then the two moments as in-place EMAs; then bias correction, which with \`β2 = 0.999\` matters for the first few thousand steps (\`1 - 0.999**t\` is still 0.63 at \`t = 1000\`) and without which the first update would be \`(1 − β1) / √(1 − β2) ≈ 3.2×\` too large per unit of \`lr\`; and \`eps\` after the square root, where it is a floor on the denominator rather than a perturbation of the variance. \`@torch.no_grad()\` is what makes the in-place \`mul_\`/\`addcdiv_\` on leaf tensors legal, and \`torch.enable_grad()\` re-enables autograd just for the closure, the LBFGS-style contract every optimizer honours. The self-test compares in \`float64\` so the arithmetic rather than rounding order decides: in \`float32\` the reference's \`lerp_\` and your \`mul_().add_()\` differ in the last ulp. What PyTorch adds on top: \`state["step"]\` as a tensor (on the device with \`capturable\`, so the step can be recorded into a CUDA graph); \`foreach\` (one kernel launch per op over all parameters, the default on CUDA) and \`fused\` (one kernel for the whole update) implementations, which its docs call typically faster than this per-parameter loop; \`maximize\`; and, in distributed training, ZeRO/FSDP sharding of \`exp_avg\`/\`exp_avg_sq\`, which weigh twice a \`float32\` model: 8 bytes per parameter on top of the 2 or 4 the weight takes. In current PyTorch, \`AdamW\` is a thin subclass of \`Adam\` that passes \`decoupled_weight_decay=True\`; apart from that flag, only the default \`weight_decay\` differs (\`1e-2\` against \`0\`).`,
};
