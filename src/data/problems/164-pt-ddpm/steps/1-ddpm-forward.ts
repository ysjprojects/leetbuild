import type {Step} from '@/lib/types';

export const ddpmForwardStep: Step = {
  id: 'ddpm-forward',
  title: 'The schedule, q(x_t | x_0) in one step, and the simple loss',
  concept: 'pytorch',
  file: 'ddpm_schedule',
  focus: ['x0', 'draw', 'q-sample', 'eps-train', 'loss'],
  task: `## Task

Implement the training half of a DDPM (Ho et al. 2020) over 2-D points: a \`NoiseSchedule(nn.Module)\`
that precomputes every per-timestep constant as a buffer, the closed-form forward process \`q_sample\`,
and the simple ε-prediction loss \`ddpm_loss\`. \`TinyDenoiser\`, the two-moons data and \`train_toy\` are
provided and must stay as they are.

- \`NoiseSchedule(T=1000, kind="linear", beta_start=1e-4, beta_end=0.02)\`. **Linear**: \`betas =
  torch.linspace(beta_start, beta_end, T, dtype=torch.float64)\`. **Cosine** (Nichol & Dhariwal, \`s =
  0.008\`): \`f(k) = cos²((k/T + s) / (1 + s) · π/2)\` on \`k = 0 … T\`, \`alphas_bar = f / f[0]\`,
  \`betas = 1 − alphas_bar[1:] / alphas_bar[:-1]\`, clamped with \`.clamp(max=0.999)\`. Any other \`kind\`
  raises \`ValueError\`.
- From \`betas\` derive \`alphas = 1 − betas\`, \`alphas_cumprod = torch.cumprod(alphas, dim=0)\`,
  \`alphas_cumprod_prev\` (a leading \`1\`, then \`alphas_cumprod[:-1]\`), \`sqrt_alphas_cumprod\`,
  \`sqrt_one_minus_alphas_cumprod\`, and \`posterior_variance = betas * (1 − alphas_cumprod_prev) / (1 −
  alphas_cumprod)\`. Compute in float64, store each with \`self.register_buffer(name, value.float())\`:
  all seven are \`(T,)\` float32 and move with \`.to(device)\`. Keep \`self.T\`.
- \`q_sample(x0, t, noise)\`: \`x0\` and \`noise\` are \`(B, …)\`, \`t\` is \`(B,)\` long in \`[0, T)\`. Return
  \`sqrt_alphas_cumprod[t] · x0 + sqrt_one_minus_alphas_cumprod[t] · noise\`, the marginal in one step,
  never a loop over the chain. \`broadcast_to(values, like)\` reshapes a \`(B,)\` vector to \`(B, 1, …)\`.
- \`ddpm_loss(model, x0, t=None)\`: when \`t\` is \`None\` draw \`t = torch.randint(0, self.T, (B,))\`
  uniformly; draw \`noise = torch.randn_like(x0)\`; form \`x_t = self.q_sample(x0, t, noise)\`; return
  \`F.mse_loss(model(x_t, t), noise)\`. The network predicts the noise, not \`x0\`, and the loss is the
  unweighted MSE of the paper's Algorithm 1.
- No \`diffusers\` and no scheduler classes; the constants are yours.

The schedule decides how fast the signal fades. Drag the timestep and compare the two schedules' \`ᾱ_t\`:

:::widget diffusion-noise {"schedule": "cosine"}

The file ends with a self-test: \`alphas_cumprod\` strictly decreasing in \`(0, 1]\` for both kinds,
\`posterior_variance[0] == 0\` and \`≤ betas\`, \`q_sample\` marginal statistics over 200 000 draws (mean
\`√ᾱ_t · x0\`, variance \`1 − ᾱ_t\`, both to \`1e-2\`), and the loss falling to under 70 % of its first
twenty steps after \`train_toy\`, then \`PASS\`.

> One formula replaces the chain: because every step adds independent Gaussian noise, \`x_t\` given \`x_0\`
> is itself Gaussian with mean \`√ᾱ_t x_0\` and variance \`1 − ᾱ_t\`, so training picks any \`t\` at random
> and never simulates the \`t − 1\` steps before it.`,
  hints: [
    'Build everything in float64 from `betas`: `alphas = 1 - betas`, `alphas_cumprod = torch.cumprod(alphas, dim=0)`, `alphas_cumprod_prev = torch.cat([torch.ones(1, dtype=torch.float64), alphas_cumprod[:-1]])`. Put the seven tensors in a dict and loop `self.register_buffer(name, value.float())`.',
    'The cosine schedule is defined through ᾱ, not β: compute `f` on `T + 1` grid points, normalise by `f[0]`, and take `betas = 1 - alphas_bar[1:] / alphas_bar[:-1]`. The last ratio is `f(T) / f(T - 1)` with `f(T) = cos²(π/2) ≈ 0`, hence the clamp at 0.999.',
    'In `q_sample`, index the buffers with the `(B,)` tensor `t` and reshape with `broadcast_to(self.sqrt_alphas_cumprod[t], x0)` before multiplying. `ddpm_loss` is four lines: sample `t` if missing, sample `noise`, `q_sample`, `F.mse_loss(model(x_t, t), noise)`.',
  ],
  checks: [
    {
      id: 'linear-betas',
      title: 'Linear betas run from beta_start to beta_end over T steps',
      detail:
        'The linear schedule is `torch.linspace(beta_start, beta_end, T, …)`: 1e-4 to 0.02 over 1000 steps in the paper; no `diffusers` scheduler supplies it.',
      match: {
        python: {
          all: [/torch\.linspace\(\s*beta_start\s*,\s*beta_end\s*,\s*T\b/],
          none: [/diffusers/, /DDPMScheduler/, /DDIMScheduler/],
        },
      },
    },
    {
      id: 'cosine-betas',
      title: 'Cosine betas come from the ratio of consecutive ᾱ, clamped at 0.999',
      detail:
        "The cosine schedule defines `alphas_bar = cos²(…) / f[0]` and derives `betas = 1 − alphas_bar[1:] / alphas_bar[:-1]`, clamped with `.clamp(max=0.999)`: the last ratio would give β = 1, so α = 0 and the reverse step's 1/√α_t would be singular.",
      match: {
        python: {all: [/torch\.cos\(/, /\[1:\]\s*\/\s*\w+\[:-1\]/, /\.clamp\(\s*max\s*=\s*0\.999\s*\)/]},
      },
    },
    {
      id: 'cumprod-buffers',
      title: 'ᾱ_t is a cumulative product stored as a buffer',
      detail:
        '`alphas_cumprod = torch.cumprod(alphas, dim=0)` and every constant is registered with `self.register_buffer(...)`, so it moves with `.to(device)` and is saved in `state_dict` without being a parameter.',
      match: {
        python: {all: [/torch\.cumprod\(/, /self\.register_buffer\(/]},
      },
    },
    {
      id: 'posterior-variance',
      title: 'Posterior variance is β_t (1 − ᾱ_{t−1}) / (1 − ᾱ_t)',
      detail:
        '`alphas_cumprod_prev` starts with a 1 and `posterior_variance = betas * (1 - alphas_cumprod_prev) / (1 - alphas_cumprod)`: the variance of q(x_{t−1} | x_t, x_0) the sampler in step 2 uses; it is 0 at t = 0.',
      match: {
        python: {
          all: [
            /torch\.cat\(\s*\[\s*torch\.ones\(\s*1/,
            /betas\s*\*\s*\(\s*1(?:\.0)?\s*-\s*alphas_cumprod_prev\s*\)\s*\/\s*\(\s*1(?:\.0)?\s*-\s*alphas_cumprod\s*\)/,
          ],
        },
      },
    },
    {
      id: 'q-sample-closed-form',
      title: 'q_sample is the one-step marginal, not a loop over the chain',
      detail:
        '`q_sample` multiplies `x0` by `self.sqrt_alphas_cumprod[t]` and `noise` by `self.sqrt_one_minus_alphas_cumprod[t]`; it never iterates `t` steps of the Markov chain.',
      match: {
        python: {
          all: [/self\.sqrt_alphas_cumprod\[t\]/, /self\.sqrt_one_minus_alphas_cumprod\[t\]/],
          none: [/def q_sample(?:(?!\n {4}def )[\s\S])*?for \w+ in range\(/],
        },
      },
    },
    {
      id: 'epsilon-mse',
      title: 'The loss is the MSE between the drawn noise and the predicted noise',
      detail:
        '`ddpm_loss` samples `t` with `torch.randint(0, self.T, …)` when none is given, draws `noise = torch.randn_like(x0)`, forms `x_t` with `self.q_sample`, and returns `F.mse_loss(model(x_t, t), noise)`: predicting ε, not x_0, with no per-timestep weight.',
      match: {
        python: {
          all: [/torch\.randint\(\s*0\s*,\s*self\.T\s*,/, /torch\.randn_like\(\s*x0\s*\)/, /mse_loss\(/],
          order: [/torch\.randn_like\(\s*x0\s*\)/, /self\.q_sample\(/, /mse_loss\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""DDPM, part 1: the noise schedule, the closed-form forward process and the simple epsilon loss (Ho et al. 2020)."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def broadcast_to(values: torch.Tensor, like: torch.Tensor) -> torch.Tensor:
    """(B,) per-sample constants → (B, 1, …, 1) so they multiply a (B, …) batch."""
    return values.view(-1, *([1] * (like.dim() - 1)))


class NoiseSchedule(nn.Module):
    """Every per-timestep constant of DDPM, precomputed once in float64 and stored as float32 buffers."""

    def __init__(self, T: int = 1000, kind: str = "linear", beta_start: float = 1e-4, beta_end: float = 0.02):
        super().__init__()
        self.T = T
        # TODO: betas for kind "linear" (linspace) and "cosine" (ratio of consecutive alphas_bar, clamped);
        # derive alphas, alphas_cumprod, alphas_cumprod_prev, the two square roots and posterior_variance
        # in float64, then register each as a float32 buffer.
        raise NotImplementedError("TODO")

    def q_sample(self, x0: torch.Tensor, t: torch.Tensor, noise: torch.Tensor) -> torch.Tensor:
        """x_t = sqrt(abar_t) x0 + sqrt(1 - abar_t) noise: the forward process in one step, no chain."""
        raise NotImplementedError("TODO")

    def ddpm_loss(self, model: nn.Module, x0: torch.Tensor, t: torch.Tensor | None = None) -> torch.Tensor:
        """L_simple = E ||eps - eps_theta(x_t, t)||^2 with t ~ Uniform{0..T-1} when not given."""
        raise NotImplementedError("TODO")


# ---- provided: the toy denoiser, the toy data and the training loop ---------------------------------


def timestep_embedding(t: torch.Tensor, dim: int) -> torch.Tensor:
    """Sinusoidal embedding of integer timesteps, (B,) → (B, dim), as in Transformer positions."""
    half = dim // 2
    freqs = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32, device=t.device) / half)
    args = t.float()[:, None] * freqs[None, :]
    return torch.cat([args.sin(), args.cos()], dim=-1)


class TinyDenoiser(nn.Module):
    """eps_theta(x_t, t): an MLP over a 2-D point concatenated with its timestep embedding."""

    def __init__(self, dim: int = 2, hidden: int = 256, emb: int = 64):
        super().__init__()
        self.emb = emb
        self.net = nn.Sequential(
            nn.Linear(dim + emb, hidden),
            nn.SiLU(),
            nn.Linear(hidden, hidden),
            nn.SiLU(),
            nn.Linear(hidden, dim),
        )

    def forward(self, x: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([x, timestep_embedding(t, self.emb)], dim=-1))


def two_moons(n: int, noise: float = 0.05, seed: int = 0) -> torch.Tensor:
    """n points on two interleaving half-circles, centred and scaled by 1 / 0.6, (n, 2)."""
    g = torch.Generator().manual_seed(seed)
    half = n // 2
    theta = torch.rand(half, generator=g) * math.pi
    upper = torch.stack([theta.cos(), theta.sin()], dim=-1)
    lower = torch.stack([1.0 - theta.cos(), 0.5 - theta.sin()], dim=-1)
    x = torch.cat([upper, lower]) + noise * torch.randn(2 * half, 2, generator=g)
    return (x - torch.tensor([0.5, 0.25])) / 0.6


def train_toy(
    schedule: NoiseSchedule, steps: int = 3000, batch: int = 512, seed: int = 0
) -> tuple[TinyDenoiser, list[float]]:
    """Trains a TinyDenoiser on two moons with Adam; returns the model and the loss per step."""
    torch.manual_seed(seed)
    data = two_moons(4096, seed=seed)
    model = TinyDenoiser()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)
    losses: list[float] = []
    for _ in range(steps):
        x0 = data[torch.randint(0, data.shape[0], (batch,))]
        loss = schedule.ddpm_loss(model, x0)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return model, losses


if __name__ == "__main__":
    torch.manual_seed(0)
    for kind in ("linear", "cosine"):
        s = NoiseSchedule(T=1000, kind=kind)
        ac = s.alphas_cumprod
        assert ac.shape == (1000,) and s.betas.shape == (1000,)
        assert (ac[1:] < ac[:-1]).all(), f"{kind}: alphas_cumprod not strictly decreasing"
        assert ac.min() > 0 and ac.max() <= 1.0, f"{kind}: alphas_cumprod outside (0, 1]"
        assert s.posterior_variance[0] == 0 and (s.posterior_variance <= s.betas + 1e-7).all()
        assert torch.allclose(
            s.sqrt_alphas_cumprod**2 + s.sqrt_one_minus_alphas_cumprod**2, torch.ones(1000), atol=1e-6
        )
        print(f"{kind:7s} abar[0]={ac[0]:.5f} abar[499]={ac[499]:.5f} abar[999]={ac[999]:.2e}")

    # q_sample marginals: over many draws, mean -> sqrt(abar_t) x0 and variance -> 1 - abar_t.
    s = NoiseSchedule(T=1000, kind="linear")
    n = 200_000
    x0 = torch.tensor([1.5, -0.5]).expand(n, 2)
    for ti in (10, 300, 900):
        t = torch.full((n,), ti, dtype=torch.long)
        x_t = s.q_sample(x0, t, torch.randn(n, 2))
        want_mean = s.sqrt_alphas_cumprod[ti] * x0[0]
        want_var = 1.0 - s.alphas_cumprod[ti]
        assert torch.allclose(x_t.mean(0), want_mean, atol=1e-2), (ti, x_t.mean(0), want_mean)
        assert torch.allclose(x_t.var(0), want_var.expand(2), atol=1e-2), (ti, x_t.var(0), want_var)
    assert torch.equal(
        s.q_sample(x0[:4], torch.full((4,), 500), torch.zeros(4, 2)), s.sqrt_alphas_cumprod[500] * x0[:4]
    )

    # The simple loss is finite and falls when the toy denoiser trains.
    model, losses = train_toy(s)
    early, late = sum(losses[:20]) / 20, sum(losses[-50:]) / 50
    assert all(math.isfinite(v) for v in losses)
    assert late < 0.7 * early, f"loss did not fall: {early:.3f} -> {late:.3f}"
    print(f"loss {early:.3f} -> {late:.3f} over {len(losses)} steps")
    print("PASS")
`,
      solution: `"""DDPM, part 1: the noise schedule, the closed-form forward process and the simple epsilon loss (Ho et al. 2020)."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def broadcast_to(values: torch.Tensor, like: torch.Tensor) -> torch.Tensor:
    """(B,) per-sample constants → (B, 1, …, 1) so they multiply a (B, …) batch."""
    return values.view(-1, *([1] * (like.dim() - 1)))


class NoiseSchedule(nn.Module):
    """Every per-timestep constant of DDPM, precomputed once in float64 and stored as float32 buffers."""

    def __init__(self, T: int = 1000, kind: str = "linear", beta_start: float = 1e-4, beta_end: float = 0.02):
        super().__init__()
        self.T = T
        if kind == "linear":
            betas = torch.linspace(beta_start, beta_end, T, dtype=torch.float64)
        elif kind == "cosine":
            s = 0.008
            grid = torch.arange(T + 1, dtype=torch.float64) / T
            f = torch.cos((grid + s) / (1 + s) * math.pi / 2) ** 2
            alphas_bar = f / f[0]
            betas = (1 - alphas_bar[1:] / alphas_bar[:-1]).clamp(max=0.999)
        else:
            raise ValueError(f"unknown schedule kind {kind!r}")
        alphas = 1.0 - betas
        alphas_cumprod = torch.cumprod(alphas, dim=0)
        alphas_cumprod_prev = torch.cat([torch.ones(1, dtype=torch.float64), alphas_cumprod[:-1]])
        posterior_variance = betas * (1.0 - alphas_cumprod_prev) / (1.0 - alphas_cumprod)
        buffers = {
            "betas": betas,
            "alphas": alphas,
            "alphas_cumprod": alphas_cumprod,
            "alphas_cumprod_prev": alphas_cumprod_prev,
            "sqrt_alphas_cumprod": alphas_cumprod.sqrt(),
            "sqrt_one_minus_alphas_cumprod": (1.0 - alphas_cumprod).sqrt(),
            "posterior_variance": posterior_variance,
        }
        for name, value in buffers.items():
            self.register_buffer(name, value.float())

    def q_sample(self, x0: torch.Tensor, t: torch.Tensor, noise: torch.Tensor) -> torch.Tensor:
        """x_t = sqrt(abar_t) x0 + sqrt(1 - abar_t) noise: the forward process in one step, no chain."""
        a = broadcast_to(self.sqrt_alphas_cumprod[t], x0)
        b = broadcast_to(self.sqrt_one_minus_alphas_cumprod[t], x0)
        return a * x0 + b * noise

    def ddpm_loss(self, model: nn.Module, x0: torch.Tensor, t: torch.Tensor | None = None) -> torch.Tensor:
        """L_simple = E ||eps - eps_theta(x_t, t)||^2 with t ~ Uniform{0..T-1} when not given."""
        if t is None:
            t = torch.randint(0, self.T, (x0.shape[0],), device=x0.device)
        noise = torch.randn_like(x0)
        x_t = self.q_sample(x0, t, noise)
        return F.mse_loss(model(x_t, t), noise)


# ---- provided: the toy denoiser, the toy data and the training loop ---------------------------------


def timestep_embedding(t: torch.Tensor, dim: int) -> torch.Tensor:
    """Sinusoidal embedding of integer timesteps, (B,) → (B, dim), as in Transformer positions."""
    half = dim // 2
    freqs = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32, device=t.device) / half)
    args = t.float()[:, None] * freqs[None, :]
    return torch.cat([args.sin(), args.cos()], dim=-1)


class TinyDenoiser(nn.Module):
    """eps_theta(x_t, t): an MLP over a 2-D point concatenated with its timestep embedding."""

    def __init__(self, dim: int = 2, hidden: int = 256, emb: int = 64):
        super().__init__()
        self.emb = emb
        self.net = nn.Sequential(
            nn.Linear(dim + emb, hidden),
            nn.SiLU(),
            nn.Linear(hidden, hidden),
            nn.SiLU(),
            nn.Linear(hidden, dim),
        )

    def forward(self, x: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([x, timestep_embedding(t, self.emb)], dim=-1))


def two_moons(n: int, noise: float = 0.05, seed: int = 0) -> torch.Tensor:
    """n points on two interleaving half-circles, centred and scaled by 1 / 0.6, (n, 2)."""
    g = torch.Generator().manual_seed(seed)
    half = n // 2
    theta = torch.rand(half, generator=g) * math.pi
    upper = torch.stack([theta.cos(), theta.sin()], dim=-1)
    lower = torch.stack([1.0 - theta.cos(), 0.5 - theta.sin()], dim=-1)
    x = torch.cat([upper, lower]) + noise * torch.randn(2 * half, 2, generator=g)
    return (x - torch.tensor([0.5, 0.25])) / 0.6


def train_toy(
    schedule: NoiseSchedule, steps: int = 3000, batch: int = 512, seed: int = 0
) -> tuple[TinyDenoiser, list[float]]:
    """Trains a TinyDenoiser on two moons with Adam; returns the model and the loss per step."""
    torch.manual_seed(seed)
    data = two_moons(4096, seed=seed)
    model = TinyDenoiser()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)
    losses: list[float] = []
    for _ in range(steps):
        x0 = data[torch.randint(0, data.shape[0], (batch,))]
        loss = schedule.ddpm_loss(model, x0)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return model, losses


if __name__ == "__main__":
    torch.manual_seed(0)
    for kind in ("linear", "cosine"):
        s = NoiseSchedule(T=1000, kind=kind)
        ac = s.alphas_cumprod
        assert ac.shape == (1000,) and s.betas.shape == (1000,)
        assert (ac[1:] < ac[:-1]).all(), f"{kind}: alphas_cumprod not strictly decreasing"
        assert ac.min() > 0 and ac.max() <= 1.0, f"{kind}: alphas_cumprod outside (0, 1]"
        assert s.posterior_variance[0] == 0 and (s.posterior_variance <= s.betas + 1e-7).all()
        assert torch.allclose(
            s.sqrt_alphas_cumprod**2 + s.sqrt_one_minus_alphas_cumprod**2, torch.ones(1000), atol=1e-6
        )
        print(f"{kind:7s} abar[0]={ac[0]:.5f} abar[499]={ac[499]:.5f} abar[999]={ac[999]:.2e}")

    # q_sample marginals: over many draws, mean -> sqrt(abar_t) x0 and variance -> 1 - abar_t.
    s = NoiseSchedule(T=1000, kind="linear")
    n = 200_000
    x0 = torch.tensor([1.5, -0.5]).expand(n, 2)
    for ti in (10, 300, 900):
        t = torch.full((n,), ti, dtype=torch.long)
        x_t = s.q_sample(x0, t, torch.randn(n, 2))
        want_mean = s.sqrt_alphas_cumprod[ti] * x0[0]
        want_var = 1.0 - s.alphas_cumprod[ti]
        assert torch.allclose(x_t.mean(0), want_mean, atol=1e-2), (ti, x_t.mean(0), want_mean)
        assert torch.allclose(x_t.var(0), want_var.expand(2), atol=1e-2), (ti, x_t.var(0), want_var)
    assert torch.equal(
        s.q_sample(x0[:4], torch.full((4,), 500), torch.zeros(4, 2)), s.sqrt_alphas_cumprod[500] * x0[:4]
    )

    # The simple loss is finite and falls when the toy denoiser trains.
    model, losses = train_toy(s)
    early, late = sum(losses[:20]) / 20, sum(losses[-50:]) / 50
    assert all(math.isfinite(v) for v in losses)
    assert late < 0.7 * early, f"loss did not fall: {early:.3f} -> {late:.3f}"
    print(f"loss {early:.3f} -> {late:.3f} over {len(losses)} steps")
    print("PASS")
`,
    },
  },
  debrief: `The schedule is a module with **buffers**, not a dict of Python floats, for two reasons the paper does not spell out: the constants must sit on the same device as the batch (\`schedule.to("cuda")\` moves all seven; indexing with a CUDA \`t\` then costs one gather, no host sync), and they are computed **once** in float64, as the authors' code does. The cumulative product is not the risk (float32 gets it to 4e-7 relative error here); the cancellation in \`1 − ᾱ_t\` near \`t = 0\` is (2e-4 relative error at \`t = 0\`, carried into \`posterior_variance\`). The forward process is a single formula because Gaussian noise composes: \`x_t | x_0\` is \`N(√ᾱ_t x_0, (1 − ᾱ_t) I)\`, which is why training can draw \`t\` uniformly and never simulate the chain, and why one batch sees every noise level at once. The loss is the paper's \`L_simple\`: the bound's per-step weights \`β_t² / (2σ_t² α_t (1 − ᾱ_t))\` are dropped, which down-weights the easy small-\`t\` terms; the network predicts \`ε\` rather than \`x_0\` or the posterior mean (the three are affine in each other, and Ho et al. found ε gave the best samples under the unweighted loss); and the result is plain MSE. Production stacks keep this shape (\`diffusers\`' \`DDPMScheduler\` keeps \`betas\`, \`alphas\` and \`alphas_cumprod\` under the same names, as float32 tensors moved to the sample's device on use) and add what the toy leaves out: a U-Net or a DiT in place of the MLP, an EMA copy of the weights for sampling, v-prediction or the min-SNR weighting that re-weights the loss by timestep, and the cosine schedule for low-resolution images where the linear one wastes its last steps on pure noise.`,
};
