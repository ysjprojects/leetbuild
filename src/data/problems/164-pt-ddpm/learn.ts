/**
 * The learning guide for the DDPM problem: the forward process in closed form and its linear and cosine
 * schedules, the ε-prediction loss, the reverse step from predicted noise, DDIM's deterministic strided
 * sampler, and what production diffusion adds (classifier-free guidance, latent diffusion,
 * v-prediction, ODE solvers). Rendered at `/pt-ddpm/learn`.
 */
export const learn = `# The mechanism at a glance

A denoising diffusion probabilistic model ([Ho et al. 2020](https://arxiv.org/abs/2006.11239)) has three
parts. A **fixed** forward process adds a little Gaussian noise at each of \`T = 1000\` steps until the
data is indistinguishable from \`N(0, I)\`. A **learned** network \`ε_θ(x_t, t)\` predicts the noise in a
noised sample. A **sampler** starts from pure noise and uses that prediction to walk back to data. The
problem builds all three over 2-D points: \`NoiseSchedule\` with \`q_sample\` and \`ddpm_loss\`, then
\`p_sample\`, \`sample\` and \`ddim_sample\`.

:::architecture
{"output": "2,000 samples on the two moons", "items": [
  {"id": "x0", "label": "Clean data x₀", "kind": "io", "sub": "two_moons · (512, 2) batches"},
  {"tone": "block", "repeat": "3,000 ×", "label": "Training step · ddpm_loss", "items": [
    {"id": "draw", "label": "Draw t and ε", "sub": "t ~ U{0 … 999} · ε ~ N(0, I)"},
    {"id": "q-sample", "label": "Forward process q(x_t | x₀)", "kind": "attention", "sub": "√ᾱ_t · x₀ + √(1 − ᾱ_t) · ε", "side": {"label": "NoiseSchedule", "sub": "7 buffers · (T,) fp32"}, "detail": "\`q_sample\`: index two buffers with the \`(B,)\` tensor \`t\`, reshape to \`(B, 1)\`, multiply."},
    {"id": "eps-train", "label": "Noise predictor ε_θ(x_t, t)", "kind": "ffn", "sub": "TinyDenoiser · the learned part", "side": {"label": "Timestep embedding", "sub": "sinusoidal · 64"}},
    {"id": "loss", "label": "MSE(ε̂, ε)", "kind": "loss", "sub": "L_simple · Adam on the loss", "shape": "trained ε_θ"}
  ]},
  {"tone": "block", "repeat": "1,000 ×", "label": "Reverse step · p_sample", "items": [
    {"id": "eps-pred", "label": "Trained ε_θ(x_t, t)", "kind": "ffn", "sub": "t = 999, 998, … 0", "side": {"label": "Pure noise x_T", "sub": "randn · (2,000, 2)"}},
    {"id": "mean", "label": "Posterior mean μ", "kind": "attention", "sub": "(x_t − β_t/√(1−ᾱ_t)·ε̂) / √α_t"},
    {"id": "noise-step", "label": "Add posterior noise", "kind": "attention", "sub": "x_{t−1} = μ + σ_t · z", "side": {"label": "z ~ N(0, I)", "sub": "σ_t² from the buffers"}}
  ]},
  {"id": "samples", "label": "Samples x₀", "kind": "io", "sub": "1,000 calls, or 50 with DDIM"}
],
"notes": [
  {"at": "x0", "text": "Training noises to any t in **one** step", "side": "left"},
  {"at": "eps-pred", "text": "Sampling always runs the chain, from x_T"},
  {"at": "noise-step", "text": "σ_t = **0** at t = 0: the mean is the sample"}
],
"insets": [
  {"for": "eps-train", "title": "TinyDenoiser", "items": [
    {"id": "td-cat", "label": "Concatenate [x_t, emb(t)]", "sub": "2 + 64 = 66"},
    {"id": "td-fc1", "label": "Linear + SiLU", "sub": "66 → 256"},
    {"id": "td-fc2", "label": "Linear + SiLU", "sub": "256 → 256"},
    {"id": "td-out", "label": "Linear", "sub": "256 → 2 · predicted ε"}
  ], "note": "**83,458** parameters serve all **1,000** noise levels"}
]}
:::

Read it bottom to top: training teaches one network to predict the noise in a sample noised in a single
step; sampling hands it pure noise \`x_T\` from the side and runs it once per timestep.

The whole method in five lines of math:

\`\`\`text
forward step   q(x_t | x_{t-1}) = N(√(1 − β_t) x_{t-1}, β_t I)          α_t = 1 − β_t,  ᾱ_t = Π α_s
marginal       x_t = √ᾱ_t x_0 + √(1 − ᾱ_t) ε,   ε ~ N(0, I)              q_sample
loss           L = ‖ε − ε_θ(x_t, t)‖²,  t ~ U{0 … T−1}                   ddpm_loss
reverse mean   μ = (x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t                  p_sample
reverse step   x_{t-1} = μ + σ_t z  (σ_t² = posterior_variance[t], z = 0 at t = 0)
\`\`\`

- Training never runs the chain: it picks one \`t\` per sample and noises in one step.
- Sampling always runs a chain: \`T\` network calls for DDPM, \`steps\` calls for DDIM.
- Everything the two need besides the network is a per-timestep constant, so it is precomputed.

# The forward process in one step

Each forward step scales the signal by \`√α_t\` and adds variance \`β_t\`. Gaussians compose, so after
\`t\` steps the signal is scaled by \`√ᾱ_t\` and the accumulated noise has variance \`1 − ᾱ_t\`: one
formula, no loop. That is \`q_sample\`: index two buffers with the \`(B,)\` tensor \`t\`, reshape to
\`(B, 1)\`, multiply.

The schedule decides how fast \`ᾱ_t\` falls. Two are standard:

| schedule | definition | ᾱ at t = 0 | middle | end |
|---|---|---|---|---|
| linear (Ho et al.) | \`β = linspace(1e-4, 0.02, T)\` | ≈ 1 | falls fast, ≈ 0.08 at t = 500 | ≈ 4e-5 |
| cosine ([Nichol & Dhariwal](https://arxiv.org/abs/2102.09672)) | \`ᾱ = f(t) / f(0)\`, \`f(t) = cos²((t/T + s)/(1 + s) · π/2)\`, \`s = 0.008\` | ≈ 1 | ≈ 0.49 at t = 500, falling linearly | ≈ 2e-9, last β clamped at 0.999 |

Slide the timestep to watch each schedule turn the two moons into noise, and compare where \`ᾱ_t\` falls:

:::widget diffusion-noise

- The linear schedule destroys most of the signal by the middle; its last steps are almost pure noise.
  Nichol & Dhariwal found a linear-schedule model barely loses FID when the noisiest 20 % of the
  reverse process is skipped. The cosine schedule spends its steps more evenly.
- The cosine schedule is defined through \`ᾱ\`; \`betas = 1 − ᾱ[1:] / ᾱ[:-1]\` recovers the per-step
  noise. Without the offset \`s\`, \`β_0\` would be about 2.5e-6: noise too small for the network to
  predict. Nichol & Dhariwal chose \`s = 0.008\` so that \`√β_0\` (0.0064) sits just under the 8-bit
  pixel bin \`1/127.5\` (0.0078).
- \`f(T) = cos²(π/2) = 0\`, so the last ratio would give \`β = 1\`, \`α = 0\`, and the reverse step's
  \`1/√α_t\` would be singular. The clamp at 0.999 touches only that one β.
- \`alphas_cumprod\`, the two square roots and \`posterior_variance = β_t (1 − ᾱ_{t−1}) / (1 − ᾱ_t)\` are
  computed in float64, as the authors' code does, and stored as float32 buffers. The cumulative product
  itself is benign (3.6e-7 relative error in float32 on the linear schedule); the cancellation in
  \`1 − ᾱ_t\` near \`t = 0\` is not: 1.7e-4 relative error at \`t = 0\`, carried into \`posterior_variance\`.
- Buffers move with \`schedule.to(device)\` and live in \`state_dict\`; they are not parameters.

:::quiz
Q: Why can training pick any timestep t without simulating the t − 1 steps before it?
- [ ] Because the network is shared across timesteps
- [x] Because a sum of independent Gaussian steps is itself Gaussian, so x_t given x_0 has the closed form √ᾱ_t x_0 + √(1 − ᾱ_t) ε
- [ ] Because the loss is averaged over t, so the order of steps does not matter
> Each step multiplies by √α_s and adds independent Gaussian noise; the means multiply and the variances
> add, giving mean √ᾱ_t x_0 and variance 1 − ᾱ_t. q_sample is that marginal, drawn in one step.
:::

# Predicting the noise: the simple loss

The variational bound on the likelihood decomposes into one KL term per step, each comparing two
Gaussians. With the reverse mean written in terms of a predicted noise, Ho et al. showed that each term
is a weighted squared error (their Eq. 12):

\`\`\`text
L_{t−1} = β_t² / (2 σ_t² α_t (1 − ᾱ_t)) · ‖ε − ε_θ(x_t, t)‖² + const
L_simple = ‖ε − ε_θ(x_t, t)‖²,   t ~ U{0 … T−1}
\`\`\`

With \`σ_t² = β_t\` on the linear schedule that weight is 0.5 at the first step, 0.27 at the second and
about 0.01 from \`t = 100\` on. \`L_simple\` sets every weight to 1, which down-weights the small-\`t\`
terms by up to 50× relative to the rest. Those are easy denoising tasks (an ε-error turns into an
\`x_0\`-error scaled by \`√(1 − ᾱ_t) / √ᾱ_t\`, 0.01 at \`t = 0\`), so the network spends its capacity on
the larger \`t\`. The paper reports better samples (FID 3.17 on CIFAR-10) and slightly worse
log-likelihoods than training on the bound:

:::architecture
{"items": [
  {"tone": "block", "repeat": "3,000 ×", "label": "train_toy step", "items": [
    {"columns": [
      [{"id": "l-x0", "label": "x₀ batch", "kind": "io", "sub": "(512, 2)"}],
      [{"id": "l-t", "label": "t ~ U{0 … 999}", "kind": "io", "sub": "(512,) int64"}],
      [{"id": "l-eps", "label": "noise ~ N(0, I)", "kind": "io", "sub": "(512, 2) · also the target"}]
    ]},
    {"id": "l-q", "label": "q_sample(x₀, t, noise)", "kind": "attention", "sub": "√ᾱ_t · x₀ + √(1 − ᾱ_t) · noise", "side": {"label": "Buffers at t", "sub": "two (B,) gathers"}},
    {"id": "l-net", "label": "model(x_t, t)", "kind": "ffn", "sub": "TinyDenoiser · ε̂ (512, 2)"},
    {"id": "l-loss", "label": "F.mse_loss(ε̂, noise)", "kind": "loss", "sub": "one scalar"},
    {"id": "l-adam", "label": "backward · Adam step", "sub": "lr 2e-3"}
  ]}
],
"notes": [
  {"at": "l-q", "text": "**512** samples, **512** noise levels"},
  {"at": "l-loss", "text": "About **0.55** at the start, **0.25** at the end"}
]}
:::

The network could predict three things; given \`x_t\` and \`t\` they are affine in each other:

| target | relation to the others | behaviour |
|---|---|---|
| \`x_0\` | \`x_0 = (x_t − √(1 − ᾱ_t) ε) / √ᾱ_t\` | at low noise the target is almost the input; Ho et al. found it gave worse samples |
| \`ε\` (DDPM) | the noise that was added | unit variance at every \`t\`; the implied \`x̂_0\` divides ε̂'s error by \`√ᾱ_t\`, which blows up as \`ᾱ_t → 0\` |
| \`v = √ᾱ_t ε − √(1 − ᾱ_t) x_0\` | mixes both | well-scaled at both ends; introduced for progressive distillation, used by SD 2 and Imagen Video |

- One batch of 512 sees 512 different noise levels; the loss is an average over \`t\` by construction.
- The toy loss starts near 0.55 and settles near 0.25, not 0. The minimum of the MSE is the variance of
  \`ε\` given \`x_t\`, and it depends on \`t\`: the trained model scores about 1.0 at \`t = 0\`, 0.6 at
  \`t = 200\`, 0.04 at \`t = 600\` and under 0.01 at \`t = 999\`.
- The timestep enters through a sinusoidal embedding (the same idea as Transformer positions), so one
  network serves all \`T\` noise levels.

:::quiz
Q: The trained toy model's ε-loss is about 1.0 at t = 0 and under 0.01 at t = 999. Why is it largest at small t?
- [ ] The linear schedule's β is smallest there, so the gradients vanish
- [x] At t = 0 the added noise (std 0.01) is far below the data's own spread around the moons (std about 0.08), so x_t says almost nothing about which ε was drawn
- [ ] The sinusoidal embedding cannot tell t = 0 from t = 1
> The best ε_θ is E[ε | x_t], and the loss floor is the variance of ε around it. At small t, ε is buried in
> the detail of x_0 and the floor is near 1; at large t, x_t ≈ ε and the floor is near 0. Nichol &
> Dhariwal's offset s keeps the first β from being even smaller for the same reason.
:::

# The reverse step from predicted noise

The forward posterior \`q(x_{t−1} | x_t, x_0)\` is Gaussian. The sampler does not know \`x_0\`, but \`ε̂\`
gives an estimate of it, and substituting that estimate collapses the two posterior-mean coefficients
into one expression in \`ε̂\`:

\`\`\`text
posterior mean   μ̃ = √ᾱ_{t−1} β_t / (1 − ᾱ_t) · x_0  +  √α_t (1 − ᾱ_{t−1}) / (1 − ᾱ_t) · x_t
x_0 from ε̂      x̂_0 = (x_t − √(1 − ᾱ_t) ε̂) / √ᾱ_t
substituted      μ = (x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t
posterior var    β̃_t = β_t (1 − ᾱ_{t−1}) / (1 − ᾱ_t)      posterior_variance[t]
\`\`\`

\`sample\` applies this from \`t = T − 1\` down to \`0\`:

:::architecture
{"input": "x_T ~ N(0, I) · (2,000, 2)", "items": [
  {"tone": "block", "repeat": "1,000 ×", "label": "p_sample · t = 999 … 0", "items": [
    {"id": "r-net", "label": "model(x_t, full((B,), t))", "kind": "ffn", "sub": "ε̂ · under torch.no_grad()"},
    {"id": "r-mean", "label": "Posterior mean", "kind": "attention", "sub": "(x_t − β_t/√(1−ᾱ_t)·ε̂) / √α_t", "side": {"label": "Buffers at t", "sub": "β_t · α_t · √(1 − ᾱ_t)"}},
    {"id": "r-noise", "label": "Add σ_t · z when t > 0", "kind": "attention", "sub": "σ_t² = posterior_variance[t]"}
  ]},
  {"id": "r-out", "label": "Samples x₀", "kind": "io", "sub": "after the t = 0 step"}
],
"notes": [
  {"at": "r-net", "text": "**1,000** network calls per sample batch"},
  {"at": "r-noise", "text": "At t = 0, σ_0 = **0**: return the mean"}
]}
:::

- The noise injected at each step is what makes this *ancestral* sampling: every run from the same
  \`x_T\` ends somewhere different, and the samples cover the distribution rather than collapsing to its mean.
- At \`t = 0\` the step returns the mean (the paper displays \`μ_θ(x_1, 1)\` "noiselessly").
  \`posterior_variance[0]\` is 0 here, since \`ᾱ_{−1}\` is defined as 1.
- Ho et al. found \`σ_t² = β_t\` and \`σ_t² = β̃_t\` give similar samples: the first is optimal when
  \`x_0 ~ N(0, I)\`, the second when \`x_0\` is a single point. Nichol & Dhariwal later learned an
  interpolation between them in the log domain, which improves likelihoods and sampling with fewer steps.
- The authors' code computes the mean through the two coefficients above with \`x̂_0\` clipped to
  \`[−1, 1]\`, the pixel range. That keeps an image sample in range at high noise, where \`x̂_0\` is
  least reliable; the one-line \`ε̂\` form here cannot clip.
- Sampling runs under \`torch.no_grad()\`. Without it, autograd records a thousand model calls and keeps
  every activation; for an image U-Net that is out-of-memory, not merely slow.

:::quiz
Q: The authors' code stores the log of the posterior variance with index 0 replaced by index 1, since log 0 is −∞. What does its t == 0 mask then prevent?
- [ ] Nothing: the posterior variance at t = 0 is 0 either way
- [ ] A division by zero in the posterior mean
- [x] Adding noise of std √β̃_1 to the final sample, which the clipped log-variance would otherwise inject
> With the clipped table, exp(½ · log β̃) at t = 0 is √β̃_1, not 0. The mask (\`p_sample\`'s \`t == 0\`
> branch here) is what makes the last step return the mean, whichever variance table is used.
:::

# DDIM: the same network, a deterministic path

A thousand network calls per sample is the cost of DDPM. Skipping steps naively does not work: \`p_sample\`
assumes the next noise level is one step away, so jumping from \`t\` to \`t − 20\` with its formula
removes one step's worth of noise and adds the wrong amount back.

| sampler on \`t = 980, 960, …\` | what one call does | after 50 calls |
|---|---|---|
| naive: DDPM's one-step mean | removes \`β_t\` worth of noise, not the gap from \`ᾱ_t\` to \`ᾱ_{t−20}\` | still noise: median distance to the moons 0.16, pure noise 0.17 |
| DDIM | estimates \`x0_pred\` from \`ε̂\`, then jumps to \`ᾱ_prev\`: \`√ᾱ_prev · x0_pred + √(1 − ᾱ_prev − σ²) · ε̂\` | on the data: median distance 0.018 |

[Song et al.](https://arxiv.org/abs/2010.02502) observed that the training loss only depends on the
marginals \`q(x_t | x_0)\`, not on the chain between them. Any process with the same marginals can use
the same trained network, including non-Markovian ones that jump between arbitrary noise levels:

\`\`\`text
x0_pred = (x − √(1 − ᾱ_t) · ε̂) / √ᾱ_t
σ       = eta · √((1 − ᾱ_prev) / (1 − ᾱ_t) · (1 − ᾱ_t / ᾱ_prev))
x       = √ᾱ_prev · x0_pred + √(1 − ᾱ_prev − σ²) · ε̂ + σ · z        (z only if eta > 0)
\`\`\`

| eta | steps | what it is |
|---|---|---|
| 0 | 50 on \`range(0, T, T // steps)\` | deterministic map x_T → x_0; the self-test's DDIM |
| 0 | T | the same ODE path, finely discretised |
| 1 | T | DDPM ancestral sampling: σ² becomes \`posterior_variance[t]\`; matches \`sample\` to 1e-3 under one seed (2.5e-5 measured) |
| 1 | fewer | DDPM's posterior over the strided chain; at 10 to 100 steps Song et al. report clearly worse FID than eta = 0 |
| between | any | interpolates between the two |

- At \`eta = 0\` the only randomness is \`x_T\`: the same seed gives bit-identical samples, which makes
  latent interpolation and inversion (image → its \`x_T\`) possible.
- The last step jumps to \`ᾱ_prev = 1\`, returning \`x0_pred\` itself.
- On the toy, 50 DDIM calls land as close to the moons as 1000 DDPM calls, in about a twentieth of the time.

:::quiz
Q: Why can DDIM reuse a network trained with the DDPM loss without retraining?
- [ ] DDIM retrains the last layer on the strided timesteps
- [x] The loss only depends on the marginals q(x_t | x_0), and DDIM's process has the same marginals, so the same ε-predictor is optimal for it
- [ ] DDIM uses the same one-step posterior as DDPM, just fewer times
> L_simple samples x_t from the marginal and never sees the chain. Any generative process consistent with
> those marginals is served by the same ε_θ; DDIM picks a deterministic one that can take large jumps.
:::

# What production diffusion adds

The toy has every moving part of a production sampler; real systems change the network, the space, the
target and the solver.

| addition | what it does | where |
|---|---|---|
| U-Net or DiT backbone | ε_θ over images or latent patches, with attention | image and video models |
| latent diffusion | diffuse in a VAE's 8× downsampled latent, decode at the end | Stable Diffusion |
| [classifier-free guidance](https://arxiv.org/abs/2207.12598) | \`ε̂ = ε̂_∅ + w · (ε̂_c − ε̂_∅)\`, two calls per step, \`w ≈ 3–8\` | text-to-image |
| v-prediction, min-SNR weighting | rescale the target and the per-t loss weight | v: distillation, SD 2, Imagen Video |
| ODE solvers | DPM-Solver, UniPC: higher-order steps on the eta = 0 path, 10–25 calls | \`DPMSolverMultistepScheduler\`, \`UniPCMultistepScheduler\` in \`diffusers\` |
| EMA weights | sample with an exponential moving average of θ | standard since DDPM (decay 0.9999) |

- Guidance trades diversity for prompt adherence; it needs the network trained with the condition
  randomly dropped (≈ 10 % of batches), so one model provides both \`ε̂_c\` and \`ε̂_∅\`.
- Latent diffusion shrinks the tensor 48× at 512² (64 × 64 × 4 instead of 512 × 512 × 3); the math of
  every step is unchanged.
- The sampler loop is many small kernel launches; \`torch.compile\` and CUDA graphs capture it.

:::quiz
Q: What does classifier-free guidance cost per sampling step, and why?
- [ ] Nothing: the guidance scale only multiplies the predicted noise
- [x] A second network evaluation, because it extrapolates from the unconditional prediction ε̂_∅ towards the conditional ε̂_c
- [ ] A separate classifier's gradient, computed by backpropagation
> CFG needs both ε̂_c and ε̂_∅ at every step: two forward passes (usually batched as one of size 2B).
> The classifier-guidance it replaced needed a noisy-image classifier and its gradient.
:::

# What to take away

- The forward process has a closed-form marginal, so training draws a random \`t\`, noises in one step and
  never runs the chain.
- The schedule is a set of per-timestep constants, computed once in float64 and held as buffers; cosine
  spends its steps more evenly than linear.
- The network predicts the added noise; the loss is plain MSE, the paper's \`L_simple\`.
- The reverse step converts ε̂ into the posterior mean and adds posterior-std noise, none at \`t = 0\`.
- DDIM reuses the same network on a strided, deterministic path: 50 calls instead of 1000.

Primary reference: Ho, Jain & Abbeel, [Denoising Diffusion Probabilistic Models](https://arxiv.org/abs/2006.11239) (NeurIPS 2020).
`;
