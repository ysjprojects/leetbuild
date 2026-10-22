import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {ddpmForwardStep} from './steps/1-ddpm-forward';
import {ddpmSampleStep} from './steps/2-ddpm-sample';

/**
 * Deep-learning problem: a DDPM over 2-D points — the linear and cosine noise schedules as buffers,
 * the closed-form forward process and the ε-prediction loss, then the ancestral T → 0 sampler and the
 * deterministic DDIM sampler on a strided subsequence, checked against a toy two-moons manifold.
 */
export const ptDdpmProblem: Problem = {
  id: 'pt-ddpm',
  title: 'DDPM: the noise schedule, the training loss, the sampler',
  tagline:
    'Precompute ᾱ_t as buffers, noise x_0 to any t in one step, train an ε-predictor with plain MSE — then sample T → 0 and with 50-step DDIM onto two moons.',
  difficulty: 'hard',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 80,
  statement: `# DDPM: the noise schedule, the training loss, the sampler

Diffusion models generate by learning to undo noise. A fixed forward process destroys data in \`T\` small
Gaussian steps until nothing but \`N(0, I)\` is left; a network learns to predict the noise added at any
step; and a sampler starts from pure noise and removes it, one predicted step at a time. Ho et al.'s
*Denoising Diffusion Probabilistic Models* (2020) made this work with a striking simplification — the
network predicts \`ε\` and the loss is plain MSE — and every image, video and audio diffusion model since
(Stable Diffusion, Imagen, DALL·E 3, Sora's video DiT) is trained on that recipe and sampled with the
descendants of its sampler, starting with DDIM.

The surface, over 2-D points so it runs on a CPU in seconds:

- \`NoiseSchedule(T=1000, kind="linear" | "cosine", beta_start=1e-4, beta_end=0.02)\` — an \`nn.Module\`
  holding seven \`(T,)\` float32 buffers (\`betas\`, \`alphas\`, \`alphas_cumprod\`, \`alphas_cumprod_prev\`,
  \`sqrt_alphas_cumprod\`, \`sqrt_one_minus_alphas_cumprod\`, \`posterior_variance\`), with
  \`q_sample(x0, t, noise)\` and \`ddpm_loss(model, x0, t=None)\`.
- \`TinyDenoiser\`, \`two_moons\` and \`train_toy\` are provided: an MLP \`ε_θ(x_t, t)\` with a sinusoidal
  timestep embedding, \`(B, 2)\` toy data, and an Adam loop.
- \`p_sample(model, x_t, t, schedule)\`, \`sample(model, shape, schedule)\` and
  \`ddim_sample(model, shape, schedule, steps, eta=0.0)\`.

## What you build here

1. \`ddpm_schedule.py\`: the linear and cosine schedules computed in float64 and registered as buffers,
   \`q_sample\` as the one-step marginal \`√ᾱ_t x_0 + √(1 − ᾱ_t) ε\`, and \`ddpm_loss\` as
   \`F.mse_loss(model(x_t, t), noise)\` with \`t\` drawn uniformly.
2. \`ddpm_sample.py\`: the reverse step from predicted noise with posterior-std noise (none at \`t = 0\`),
   the \`T → 0\` sampler under \`torch.no_grad()\`, and DDIM on \`range(0, T, T // steps)\` — deterministic
   at \`eta = 0\`, equal to DDPM at \`steps = T, eta = 1\`.

## Run it on your machine

\`python ddpm_schedule.py\` checks both schedules, the forward marginals over 200 000 draws and that the
loss falls under training; \`python ddpm_sample.py\` (same directory) trains the toy model, checks the
samplers' shapes, DDIM's determinism, DDIM(T, eta=1) against DDPM, and that 2 000 samples from each land
within a median distance of 0.05 of the two moons. Each prints \`PASS\`; the second takes about 15 s on a
laptop CPU.

## Left out on purpose

The U-Net or DiT backbone, learned variances (Nichol & Dhariwal's \`L_hybrid\`), EMA weights, loss
weighting (min-SNR) and v-prediction, conditioning and classifier-free guidance, latent diffusion's VAE,
and higher-order ODE solvers (DPM-Solver, UniPC).`,
  architecture: {
    output: '2,000 samples on the two moons',
    items: [
      {
        id: 'x0',
        label: 'Clean data x₀',
        kind: 'io',
        sub: 'two_moons · (512, 2) batches',
        shape: 'x₀ (512, 2)',
        detail:
          '`train_toy` draws 512 rows per step from 4,096 two-moons points, centred and scaled to about unit variance.',
      },
      {
        tone: 'block',
        repeat: '3,000 ×',
        label: 'Training step · ddpm_loss',
        items: [
          {
            id: 'draw',
            label: 'Draw t and ε',
            sub: 't ~ U{0 … 999} · ε ~ N(0, I)',
            shape: 't (512,) · ε (512, 2)',
            detail:
              'One timestep per sample, uniformly: a batch of 512 sees 512 noise levels, so the loss averages over `t` by construction.',
          },
          {
            id: 'q-sample',
            label: 'Forward process q(x_t | x₀)',
            kind: 'attention',
            sub: '√ᾱ_t · x₀ + √(1 − ᾱ_t) · ε',
            shape: 'x_t (512, 2)',
            side: {
              label: 'NoiseSchedule',
              sub: '7 buffers · (T,) fp32',
              detail:
                '`betas`, `alphas`, `alphas_cumprod`, `alphas_cumprod_prev`, the two square roots and `posterior_variance`: computed once in float64, stored as float32 buffers that move with `.to(device)`.',
            },
            detail:
              '`q_sample`: the marginal after `t` forward steps, drawn in one step. Gaussians compose, so the mean is `√ᾱ_t x₀` and the variance `1 − ᾱ_t`; the chain is never simulated.',
          },
          {
            id: 'eps-train',
            label: 'Noise predictor ε_θ(x_t, t)',
            kind: 'ffn',
            sub: 'TinyDenoiser · 66 → 256 → 256 → 2',
            shape: 'ε̂ (512, 2)',
            side: {label: 'Timestep embedding', sub: 'sinusoidal · 64'},
            detail:
              'An MLP over the point concatenated with a 64-dim sinusoidal embedding of `t`, SiLU between layers, 83,458 parameters. One network serves all 1,000 noise levels.',
          },
          {
            id: 'loss',
            label: 'MSE(ε̂, ε)',
            kind: 'loss',
            sub: 'L_simple · Adam lr 2e-3',
            shape: 'trained ε_θ',
            detail:
              '`F.mse_loss(model(x_t, t), noise)`: the unweighted ε loss of Algorithm 1. It falls from about 0.55 to about 0.25, not 0: at large `t` the noise is unpredictable from `x_t`.',
          },
        ],
      },
      {
        tone: 'block',
        repeat: '1,000 ×',
        label: 'Reverse step · p_sample',
        items: [
          {
            id: 'eps-pred',
            label: 'Trained ε_θ(x_t, t)',
            kind: 'ffn',
            sub: 't = 999, 998, … 0',
            shape: 'ε̂ (2,000, 2)',
            side: {
              label: 'Pure noise x_T',
              sub: 'randn · (2,000, 2)',
              detail:
                'Sampling starts from `N(0, I)`, the distribution the forward process ends in; it is `x_t` at the first step.',
            },
            detail:
              'The same network, called once per step under `torch.no_grad()` with `torch.full((B,), t)`. DDIM calls it 50 times on `range(0, 1000, 20)` instead.',
          },
          {
            id: 'mean',
            label: 'Posterior mean μ',
            kind: 'attention',
            sub: '(x_t − β_t/√(1 − ᾱ_t) · ε̂) / √α_t',
            shape: 'μ (2,000, 2)',
            detail:
              'The mean of `q(x_{t−1} | x_t, x₀)` with `x₀` replaced by its estimate from `ε̂`. Reads `betas[t]`, `sqrt_one_minus_alphas_cumprod[t]` and `alphas[t]`.',
          },
          {
            id: 'noise-step',
            label: 'Add posterior noise',
            kind: 'attention',
            sub: 'x_{t−1} = μ + σ_t · z',
            shape: 'x_{t−1} (2,000, 2)',
            side: {
              label: 'z ~ N(0, I)',
              sub: 'σ_t² from the buffers',
              detail: '`σ_t² = posterior_variance[t]`, the variance of `q(x_{t−1} | x_t, x₀)`.',
            },
            detail:
              'Fresh noise at every step makes this ancestral sampling. At `t = 0` the step returns `μ` alone: `posterior_variance[0]` is 0.',
          },
        ],
      },
      {
        id: 'samples',
        label: 'Samples x₀',
        kind: 'io',
        sub: 'median distance < 0.05',
        detail:
          'The self-test checks that 2,000 samples from each sampler land within a median distance of 0.05 of the two moons.',
      },
    ],
    notes: [
      {at: 'q-sample', text: 'Any t in **one** step: no chain in training'},
      {at: 'loss', text: 'Loss settles near **0.25**, not 0'},
      {at: 'eps-pred', text: '**1,000** network calls; DDIM needs **50**'},
      {at: 'noise-step', text: 'No noise at **t = 0**'},
    ],
  },
  steps: [ddpmForwardStep, ddpmSampleStep],
  learn,
};
