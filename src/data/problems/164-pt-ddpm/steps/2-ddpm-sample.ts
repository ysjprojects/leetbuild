import type {Step} from '@/lib/types';

/** The self-test both the starter and the solution end with. */
const SELF_TEST = `if __name__ == "__main__":
    torch.manual_seed(0)
    s = NoiseSchedule(T=1000, kind="linear")
    model, losses = train_toy(s)
    print(f"trained: loss {sum(losses[:20]) / 20:.3f} -> {sum(losses[-50:]) / 50:.3f}")

    # Shapes and dtypes.
    assert sample(model, (16, 2), s).shape == (16, 2)
    out = ddim_sample(model, (16, 2), s, steps=50)
    assert out.shape == (16, 2) and out.dtype == torch.float32

    # p_sample adds noise for t > 0 and none at t = 0.
    x = torch.randn(8, 2)
    assert torch.equal(p_sample(model, x, 0, s), p_sample(model, x, 0, s))
    assert not torch.equal(p_sample(model, x, 500, s), p_sample(model, x, 500, s))

    # DDIM with eta = 0 is deterministic: same seed, same samples, and no randomness drawn after x_T.
    torch.manual_seed(1)
    a = ddim_sample(model, (64, 2), s, steps=50, eta=0.0)
    after = torch.randn(4)
    torch.manual_seed(1)
    b = ddim_sample(model, (64, 2), s, steps=50, eta=0.0)
    assert torch.equal(a, b)
    torch.manual_seed(1)
    torch.randn(64, 2)
    assert torch.equal(after, torch.randn(4)), "ddim_sample(eta=0) drew noise after x_T"
    torch.manual_seed(1)
    c = ddim_sample(model, (64, 2), s, steps=50, eta=1.0)
    assert not torch.allclose(a, c), "eta = 1 should add noise"

    # DDIM over all T steps with eta = 1 is the DDPM ancestral sampler (same noise draws, same samples).
    torch.manual_seed(2)
    ddpm = sample(model, (64, 2), s)
    torch.manual_seed(2)
    ddim_full = ddim_sample(model, (64, 2), s, steps=s.T, eta=1.0)
    print(f"ddpm vs ddim(T, eta=1) max |diff| {(ddpm - ddim_full).abs().max():.2e}")
    assert torch.allclose(ddpm, ddim_full, atol=1e-3)

    # Samples from the trained model land on the two moons; pure noise does not.
    data = two_moons(4096, seed=0)
    torch.manual_seed(3)
    start = time.perf_counter()
    xs = sample(model, (2000, 2), s)
    t_ddpm = time.perf_counter() - start
    start = time.perf_counter()
    xd = ddim_sample(model, (2000, 2), s, steps=50)
    t_ddim = time.perf_counter() - start
    d_noise = distance_to_data(torch.randn(2000, 2), data).median()
    for name, xx, secs in (("ddpm 1000", xs, t_ddpm), ("ddim 50", xd, t_ddim)):
        d = distance_to_data(xx, data)
        med, q75 = d.median().item(), d.quantile(0.75).item()
        print(f"{name:9s} median distance to data {med:.3f}, 75th percentile {q75:.3f} ({secs:.2f} s)")
        assert med < 0.05 and q75 < 0.1, f"{name}: samples are off the two moons"
        assert med < 0.5 * d_noise
    print(f"pure noise median distance to data {d_noise:.3f}")
    print("PASS")
`;

export const ddpmSampleStep: Step = {
  id: 'ddpm-sample',
  title: 'The reverse step, the T → 0 sampler, and DDIM on a strided schedule',
  concept: 'pytorch',
  file: 'ddpm_sample',
  focus: ['sampler', 'model', 'schedule'],
  task: `## Task

Turn the trained ε-predictor into a generator. \`ddpm_sample.py\` imports \`NoiseSchedule\`, \`train_toy\` and
\`two_moons\` from step 1's \`ddpm_schedule.py\` and adds three functions, all under \`@torch.no_grad()\`.

- \`p_sample(model, x_t, t, schedule)\`: one reverse step \`x_t → x_{t−1}\` for a batch \`x_t: (B, …)\` at one
  integer timestep \`t\`. Call the model with \`torch.full((B,), t, dtype=torch.long)\`, then form the
  posterior mean from the predicted noise, \`mean = (x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t\`, reading
  \`schedule.betas[t]\`, \`schedule.sqrt_one_minus_alphas_cumprod[t]\` and \`schedule.alphas[t]\`. For \`t > 0\`
  return \`mean + √posterior_variance[t] · torch.randn_like(x_t)\`; at \`t == 0\` return \`mean\` with no noise.
- \`sample(model, shape, schedule)\`: Algorithm 2 of the paper — \`x = torch.randn(shape, …)\` on the
  schedule's device, then \`p_sample\` for \`t\` in \`reversed(range(schedule.T))\`. Returns \`(*shape)\` float32.
- \`ddim_sample(model, shape, schedule, steps, eta=0.0)\`: Song et al.'s sampler on the strided subsequence
  \`timesteps = list(range(0, schedule.T, schedule.T // steps))[:steps]\`, walked from the last to the first.
  At each \`t\` with predecessor \`t_prev\` (or \`ᾱ_prev = 1\` after the first), with \`a_t = ᾱ_t\`,
  \`a_prev = ᾱ_prev\`: \`x0_pred = (x − √(1 − a_t) · ε̂) / √a_t\`, \`sigma = eta · √((1 − a_prev) / (1 − a_t) · (1
  − a_t / a_prev))\`, \`x = a_prev.sqrt() * x0_pred + √(1 − a_prev − sigma²) · ε̂\`, plus \`sigma · randn\` only
  when \`eta > 0\`. At \`eta = 0\` the only randomness is \`x_T\`.
- No \`diffusers\`, no scheduler classes, no calls back into training.

The file ends with a self-test: train the toy model with \`train_toy\`; shapes and dtype of both samplers;
\`p_sample\` deterministic at \`t = 0\` and noisy at \`t = 500\`; \`ddim_sample(eta=0)\` reproducible under one
seed and drawing no random numbers after \`x_T\`; \`ddim_sample(steps=T, eta=1)\` equal to \`sample\` under one
seed (\`atol=1e-3\`); and 2 000 samples from each sampler (DDPM 1000 steps, DDIM 50) within a median
distance of \`0.05\` of the two-moons data (75th percentile under \`0.1\`) — then \`PASS\`.

> The network only ever predicts noise; the sampler turns that prediction into an estimate of \`x_0\` and
> walks back along the posterior. DDPM re-injects fresh noise at every one of the T steps; DDIM, at
> \`eta = 0\`, follows a deterministic path through the same marginals and can skip most of the steps.`,
  sequence: {
    participants: ['sample', 'p_sample', 'TinyDenoiser', 'NoiseSchedule'],
    messages: [
      {from: 'sample', to: 'sample', label: 'x_T = torch.randn(shape)  (2000, 2)', kind: 'sync'},
      {
        from: 'sample',
        to: 'p_sample',
        label: 'for t in reversed(range(T)): p_sample(model, x, t, schedule)',
        kind: 'sync',
      },
      {from: 'p_sample', to: 'TinyDenoiser', label: 'model(x_t, full((B,), t))', kind: 'sync'},
      {from: 'TinyDenoiser', to: 'p_sample', label: 'ε̂: (B, 2)', kind: 'reply'},
      {
        from: 'p_sample',
        to: 'NoiseSchedule',
        label: 'betas[t] · sqrt_one_minus_alphas_cumprod[t] · alphas[t]',
        kind: 'sync',
      },
      {from: 'p_sample', to: 'p_sample', label: 'mean = (x_t − β_t/√(1−ᾱ_t) · ε̂) / √α_t', kind: 'sync'},
      {
        from: 'p_sample',
        to: 'sample',
        label: 't > 0: mean + √posterior_variance[t] · z  ·  t = 0: mean',
        kind: 'reply',
      },
    ],
  },
  hints: [
    '`t` is a Python `int` here, so `schedule.betas[t]` is a 0-dim tensor that broadcasts over the whole batch; only the model needs a `(B,)` tensor: `torch.full((x_t.shape[0],), t, dtype=torch.long, device=x_t.device)`.',
    'The posterior mean is `(x_t - schedule.betas[t] / schedule.sqrt_one_minus_alphas_cumprod[t] * eps) / schedule.alphas[t].sqrt()`; the `if t == 0: return mean` branch is what makes the last step clean.',
    'For DDIM, `a_prev` is `schedule.alphas_cumprod[timesteps[i - 1]]` for `i > 0` and `torch.ones(())` at `i == 0`. Compute `x0_pred` first, then `sigma = eta * (...).sqrt()`, then `x = a_prev.sqrt() * x0_pred + (1 - a_prev - sigma**2).clamp(min=0).sqrt() * eps`, and draw `torch.randn_like(x)` only `if eta > 0`.',
  ],
  checks: [
    {
      id: 'posterior-mean',
      title: 'The reverse mean is computed from the predicted noise',
      detail:
        '`p_sample` forms `(x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t` from `betas[t]`, `sqrt_one_minus_alphas_cumprod[t]` and `alphas[t]` — the mean of q(x_{t−1} | x_t, x_0) with x_0 replaced by its ε-estimate; no `diffusers` scheduler supplies it.',
      match: {
        python: {
          all: [
            /\bbetas\[t\]/,
            /sqrt_one_minus_alphas_cumprod\[t\]/,
            /[.\s]alphas\[t\]\.sqrt\(\)|torch\.sqrt\(\s*\w+\.alphas\[t\]/,
          ],
          none: [/diffusers/, /DDPMScheduler/, /DDIMScheduler/],
        },
      },
    },
    {
      id: 'posterior-noise',
      title: 'Noise is scaled by the posterior std, and skipped at t = 0',
      detail:
        'For `t > 0` the step adds `√posterior_variance[t] · torch.randn_like(x_t)`; at `t == 0` it returns the mean, so the final sample is not blurred by a last draw of noise.',
      match: {
        python: {all: [/posterior_variance\[t\]/, /torch\.randn_like\(\s*x_t\s*\)/, /\bt\s*(?:==\s*0|>\s*0|!=\s*0)/]},
      },
    },
    {
      id: 'reverse-loop',
      title: 'Sampling starts from N(0, I) and runs t = T − 1 down to 0',
      detail:
        '`sample` draws `x = torch.randn(shape, …)` and loops `for t in reversed(range(schedule.T))`, calling `p_sample` at every step — Algorithm 2 of the paper.',
      match: {
        python: {
          all: [/torch\.randn\(\s*\*?shape/, /reversed\(\s*range\(\s*\w+\.T\s*\)\s*\)/],
          order: [/torch\.randn\(\s*\*?shape/, /reversed\(\s*range\(\s*\w+\.T\s*\)\s*\)/, /p_sample\(\s*model/],
        },
      },
    },
    {
      id: 'no-grad',
      title: 'Samplers run without building a graph',
      detail:
        'All three functions run under `torch.no_grad()` (decorator or context manager): a thousand model calls recorded for autograd would hold every activation in memory for a backward pass that never comes.',
      match: {
        python: {all: [/@torch\.no_grad\(\)|with torch\.no_grad\(\)/]},
      },
    },
    {
      id: 'ddim-strided',
      title: 'DDIM walks a strided subsequence of the T timesteps',
      detail:
        '`ddim_sample` builds `timesteps = list(range(0, schedule.T, schedule.T // steps))` and walks it backwards, with `ᾱ_prev = 1` after the first entry — 50 model calls instead of 1000.',
      match: {
        python: {
          all: [
            /range\(\s*0\s*,\s*\w+\.T\s*,\s*\w+\.T\s*\/\/\s*steps\s*\)|torch\.linspace\(\s*0\s*,\s*\w+\.T\s*-\s*1\s*,\s*steps/,
            /torch\.ones\(\s*\(\s*\)/,
          ],
        },
      },
    },
    {
      id: 'ddim-update',
      title: 'DDIM predicts x_0, then steps to ᾱ_prev along the predicted noise',
      detail:
        '`x0_pred = (x − √(1 − a_t) · ε̂) / √a_t` comes first, then `x = a_prev.sqrt() * x0_pred + √(1 − a_prev − σ²) · ε̂` — the non-Markovian update of Song et al. that keeps the same marginals as DDPM.',
      match: {
        python: {
          order: [/x0_pred\s*=/, /a_prev\.sqrt\(\)\s*\*\s*x0_pred/],
        },
      },
    },
    {
      id: 'ddim-eta',
      title: 'eta scales σ, and eta = 0 draws no noise after x_T',
      detail:
        '`sigma = eta * √((1 − a_prev) / (1 − a_t) · (1 − a_t / a_prev))` and `torch.randn_like` is called only under `if eta > 0` — at `eta = 0` the sampler is a deterministic map from x_T, at `eta = 1` it is DDPM.',
      match: {
        python: {all: [/sigma\s*=\s*eta\s*\*/, /if\s+eta\s*>\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""DDPM, part 2: ancestral sampling from T to 0 and the deterministic DDIM sampler (Ho et al. 2020; Song et al. 2021)."""

import time

import torch
import torch.nn as nn

from ddpm_schedule import NoiseSchedule, train_toy, two_moons


def p_sample(model: nn.Module, x_t: torch.Tensor, t: int, schedule: NoiseSchedule) -> torch.Tensor:
    """One reverse step x_t -> x_{t-1}: the posterior mean from the predicted noise, plus posterior-std noise."""
    # TODO: under no_grad, predict eps with model(x_t, (B,) long tensor of t); form the posterior mean
    # from betas, sqrt_one_minus_alphas_cumprod and alphas at t; add sqrt(posterior_variance) noise unless t is 0.
    raise NotImplementedError("TODO")


def sample(model: nn.Module, shape: tuple[int, ...], schedule: NoiseSchedule) -> torch.Tensor:
    """Algorithm 2: start from x_T ~ N(0, I) and apply p_sample for t = T-1, ..., 0."""
    # TODO: under no_grad, draw x_T on the schedule's device and walk p_sample from T - 1 down to 0.
    raise NotImplementedError("TODO")


def ddim_sample(
    model: nn.Module, shape: tuple[int, ...], schedule: NoiseSchedule, steps: int, eta: float = 0.0
) -> torch.Tensor:
    """DDIM on the strided subsequence 0, T//steps, ...: deterministic at eta = 0, DDPM-like at eta = 1."""
    # TODO: under no_grad, build the strided timesteps, draw x_T, and walk them backwards: predict x0 from
    # eps, compute sigma from eta, step to abar_prev (1 after the first timestep), add noise only if eta > 0.
    raise NotImplementedError("TODO")


def distance_to_data(points: torch.Tensor, data: torch.Tensor) -> torch.Tensor:
    """Distance from each point to its nearest training point, (N,)."""
    return torch.cdist(points, data).min(dim=1).values


${SELF_TEST}`,
      solution: `"""DDPM, part 2: ancestral sampling from T to 0 and the deterministic DDIM sampler (Ho et al. 2020; Song et al. 2021)."""

import time

import torch
import torch.nn as nn

from ddpm_schedule import NoiseSchedule, train_toy, two_moons


@torch.no_grad()
def p_sample(model: nn.Module, x_t: torch.Tensor, t: int, schedule: NoiseSchedule) -> torch.Tensor:
    """One reverse step x_t -> x_{t-1}: the posterior mean from the predicted noise, plus posterior-std noise."""
    t_batch = torch.full((x_t.shape[0],), t, dtype=torch.long, device=x_t.device)
    eps = model(x_t, t_batch)
    coef = schedule.betas[t] / schedule.sqrt_one_minus_alphas_cumprod[t]
    mean = (x_t - coef * eps) / schedule.alphas[t].sqrt()
    if t == 0:
        return mean
    return mean + schedule.posterior_variance[t].sqrt() * torch.randn_like(x_t)


@torch.no_grad()
def sample(model: nn.Module, shape: tuple[int, ...], schedule: NoiseSchedule) -> torch.Tensor:
    """Algorithm 2: start from x_T ~ N(0, I) and apply p_sample for t = T-1, ..., 0."""
    x = torch.randn(shape, device=schedule.betas.device)
    for t in reversed(range(schedule.T)):
        x = p_sample(model, x, t, schedule)
    return x


@torch.no_grad()
def ddim_sample(
    model: nn.Module, shape: tuple[int, ...], schedule: NoiseSchedule, steps: int, eta: float = 0.0
) -> torch.Tensor:
    """DDIM on the strided subsequence 0, T//steps, ...: deterministic at eta = 0, DDPM-like at eta = 1."""
    device = schedule.betas.device
    timesteps = list(range(0, schedule.T, schedule.T // steps))[:steps]
    x = torch.randn(shape, device=device)
    for i in reversed(range(len(timesteps))):
        t = timesteps[i]
        a_t = schedule.alphas_cumprod[t]
        a_prev = schedule.alphas_cumprod[timesteps[i - 1]] if i > 0 else torch.ones((), device=device)
        eps = model(x, torch.full((shape[0],), t, dtype=torch.long, device=device))
        x0_pred = (x - (1 - a_t).sqrt() * eps) / a_t.sqrt()
        sigma = eta * ((1 - a_prev) / (1 - a_t) * (1 - a_t / a_prev)).sqrt()
        direction = (1 - a_prev - sigma**2).clamp(min=0).sqrt() * eps
        x = a_prev.sqrt() * x0_pred + direction
        if eta > 0:
            x = x + sigma * torch.randn_like(x)
    return x


def distance_to_data(points: torch.Tensor, data: torch.Tensor) -> torch.Tensor:
    """Distance from each point to its nearest training point, (N,)."""
    return torch.cdist(points, data).min(dim=1).values


${SELF_TEST}`,
    },
  },
  debrief: `The reverse step never asks the network for \`x_{t−1}\` directly. It asks for \`ε̂\`, and the posterior of the forward process does the rest: \`q(x_{t−1} | x_t, x_0)\` is Gaussian with a closed-form mean and the variance step 1 stored as \`posterior_variance\`, and substituting \`x_0 = (x_t − √(1 − ᾱ_t) ε̂) / √ᾱ_t\` into that mean gives \`(x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t\`. The noise at \`t = 0\` is skipped because \`posterior_variance[0]\` is 0 by construction and because the last step should output the model's best estimate, not a noisy draw around it. \`torch.no_grad()\` is not decoration: a thousand calls of even a tiny MLP recorded for autograd keep every activation alive, and for an image U-Net that is the difference between sampling and running out of memory. DDIM keeps the trained network and changes only the sampler: the same \`ε̂\` defines an estimate of \`x_0\`, and the update moves to the noise level \`ᾱ_prev\` along the predicted noise direction, with \`eta\` deciding how much fresh noise to add. At \`eta = 0\` the map from \`x_T\` to \`x_0\` is deterministic — which is what lets DDIM skip from 1000 steps to 50, interpolate in latent space and invert an image back to its noise — and at \`steps = T, eta = 1\` it collapses to the DDPM sampler, which the self-test checks to \`1e-3\`. Production samplers go further along the same line: DPM-Solver and UniPC treat the deterministic path as an ODE and solve it with higher-order steps in 10–25 evaluations; Stable Diffusion runs the whole loop in a VAE's latent space, evaluates the U-Net twice per step for classifier-free guidance (\`ε̂ = ε̂_∅ + w · (ε̂_c − ε̂_∅)\`), and is often trained with v-prediction so the target stays well-scaled at both ends of the schedule; \`torch.compile\` or CUDA graphs remove the per-step launch overhead that dominates a loop of small calls.`,
};
