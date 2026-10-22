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
  diagram: {
    nodes: [
      {id: 'data', kind: 'client', label: 'two_moons · train_toy', sub: 'x0: (512, 2) batches · Adam', x: 10, y: 30},
      {
        id: 'forward',
        kind: 'service',
        label: 'q_sample · ddpm_loss',
        sub: 'x_t = √ᾱ_t x0 + √(1−ᾱ_t) ε · MSE(ε̂, ε)',
        x: 40,
        y: 30,
      },
      {id: 'model', kind: 'service', label: 'TinyDenoiser', sub: 'ε_θ(x_t, t): MLP + timestep embedding', x: 70, y: 30},
      {
        id: 'schedule',
        kind: 'db',
        label: 'NoiseSchedule buffers',
        sub: 'betas · alphas_cumprod · posterior_variance (T,)',
        x: 40,
        y: 75,
      },
      {
        id: 'sampler',
        kind: 'service',
        label: 'sample · ddim_sample',
        sub: 'x_T ~ N(0, I) → x_0 · 1000 or 50 steps',
        x: 75,
        y: 75,
      },
    ],
    edges: [
      {from: 'data', to: 'forward', kind: 'plain', label: 'x0'},
      {from: 'forward', to: 'model', kind: 'plain', label: 'model(x_t, t)'},
      {from: 'schedule', to: 'forward', kind: 'plain', label: 'ᾱ_t[t]'},
      {from: 'sampler', to: 'model', kind: 'plain', label: 'ε̂ per step'},
      {from: 'schedule', to: 'sampler', kind: 'plain', label: 'β_t · α_t · σ_t'},
    ],
  },
  steps: [ddpmForwardStep, ddpmSampleStep],
  learn,
};
