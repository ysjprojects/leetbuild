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
\`t\` steps the signal is scaled by \`√ᾱ_t\` and the accumulated noise has variance \`1 − ᾱ_t\` — one
formula, no loop. That is \`q_sample\`: index two buffers with the \`(B,)\` tensor \`t\`, reshape to
\`(B, 1)\`, multiply.

The schedule decides how fast \`ᾱ_t\` falls. Two are standard:

| schedule | definition | ᾱ at t = 0 | middle | end |
|---|---|---|---|---|
| linear (Ho et al.) | \`β = linspace(1e-4, 0.02, T)\` | ≈ 1 | falls fast, ≈ 0.08 at t = 500 | ≈ 4e-5 |
| cosine ([Nichol & Dhariwal](https://arxiv.org/abs/2102.09672)) | \`ᾱ = cos²((t/T + s)/(1 + s) · π/2) / f(0)\`, \`s = 0.008\` | ≈ 1 | ≈ 0.5 near the middle | ≈ 0, β clamped at 0.999 |

Slide the timestep to watch each schedule turn the two moons into noise, and compare where \`ᾱ_t\` falls:

:::widget diffusion-noise

- The linear schedule destroys most of the signal by the middle; its last few hundred steps are almost
  pure noise, so a model trained on them learns little. The cosine schedule spends its steps more evenly.
- The cosine schedule is defined through \`ᾱ\`; \`betas = 1 − ᾱ[1:] / ᾱ[:-1]\` recovers the per-step
  noise, and the clamp at 0.999 stops the final step from being a division by nearly zero.
- Derived constants — \`alphas_cumprod\`, the two square roots, \`posterior_variance = β_t (1 − ᾱ_{t−1}) /
  (1 − ᾱ_t)\` — are computed in float64 and stored as float32 buffers: a product of a thousand factors
  near 1 and the difference \`1 − ᾱ_t\` near \`t = 0\` are where float32 loses digits.
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
Gaussians. Ho et al. noticed that with the reverse mean written in terms of a predicted noise, every
term becomes a weighted \`‖ε − ε_θ‖²\` — and that dropping the weights trains better. \`L_simple\` is
the whole training objective:

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
| \`x_0\` | \`x_0 = (x_t − √(1 − ᾱ_t) ε) / √ᾱ_t\` | at high noise the target is far from the input; errors blow up when divided out |
| \`ε\` (DDPM) | the noise that was added | unit variance at every \`t\`; the target the paper found best |
| \`v = √ᾱ_t ε − √(1 − ᾱ_t) x_0\` | mixes both | well-scaled at both ends; used for distillation and many video models |

- One batch of 512 sees 512 different noise levels; the loss is an average over \`t\` by construction.
- The toy loss starts near 0.55 and settles near 0.25, not 0: at large \`t\` the noise is genuinely
  unpredictable from \`x_t\`, and the minimum of the MSE is the conditional variance.
- The timestep enters through a sinusoidal embedding — the same idea as Transformer positions — so one
  network serves all \`T\` noise levels.

:::quiz
Q: Why does the training loss of a perfect ε-predictor not reach zero?
- [ ] The cosine schedule clamps β at 0.999, adding irreducible noise
- [x] For large t, x_t carries almost no information about which ε was added, so the best prediction is a conditional mean with nonzero error
- [ ] The MSE is averaged over the batch, which biases it upwards
> At t near T, x_t ≈ ε, so ε is predictable; at middle t, many (x_0, ε) pairs give the same x_t. The optimal
> ε_θ is E[ε | x_t], and the loss floor is the variance of ε around it.
:::

# The reverse step from predicted noise

The forward posterior \`q(x_{t−1} | x_t, x_0)\` is Gaussian with a closed-form mean and the variance stored
as \`posterior_variance[t]\`. The sampler does not know \`x_0\`, but \`ε̂\` gives an estimate of it;
substituting yields the mean \`(x_t − β_t / √(1 − ᾱ_t) · ε̂) / √α_t\`. \`sample\` applies this from
\`t = T − 1\` down to \`0\`:

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
- At \`t = 0\` the step returns the mean. \`posterior_variance[0]\` is 0 anyway — \`ᾱ_{−1}\` is defined
  as 1 — and a last draw of noise would only blur the output.
- Ho et al. found \`σ_t² = β_t\` and \`σ_t² = β̃_t\` (the posterior variance) give similar samples; Nichol
  & Dhariwal later learned an interpolation between them to improve likelihoods and cut steps.
- Sampling runs under \`torch.no_grad()\`. Without it, autograd records a thousand model calls and keeps
  every activation; for an image U-Net that is out-of-memory, not merely slow.

:::quiz
Q: The sampler is run with noise added at t = 0 as well. What changes?
- [ ] Nothing: posterior_variance[0] is 0, so no noise is added either way
- [ ] The samples collapse to the data mean
- [x] Nothing measurable here, because σ_0 = 0 — but with σ_t² = β_t the final sample would be blurred by noise of std √β_0
> The skip matters for the β_t choice of variance, where σ_0 = √1e-4 = 0.01. With the posterior variance
> it is zero by construction; the explicit branch keeps the last step correct for either choice.
:::

# DDIM: the same network, a deterministic path

A thousand network calls per sample is the cost of DDPM. Skipping steps naively does not work: \`p_sample\`
assumes the next noise level is one step away, so jumping from \`t\` to \`t − 20\` with its formula
removes one step's worth of noise and adds the wrong amount back.

| sampler on \`t = 980, 960, …\` | what one call does | after 50 calls |
|---|---|---|
| naive: DDPM's one-step mean | removes \`β_t\` worth of noise, not the gap from \`ᾱ_t\` to \`ᾱ_{t−20}\` | still mostly noise |
| DDIM | estimates \`x0_pred\` from \`ε̂\`, then jumps to \`ᾱ_prev\`: \`√ᾱ_prev · x0_pred + √(1 − ᾱ_prev − σ²) · ε̂\` | on the data |

[Song et al.](https://arxiv.org/abs/2010.02502) observed that the training loss only depends on the
marginals \`q(x_t | x_0)\`, not on the chain between them. Any process with the same marginals can use
the same trained network — including non-Markovian ones that jump between arbitrary noise levels:

\`\`\`text
x0_pred = (x − √(1 − ᾱ_t) · ε̂) / √ᾱ_t
σ       = eta · √((1 − ᾱ_prev) / (1 − ᾱ_t) · (1 − ᾱ_t / ᾱ_prev))
x       = √ᾱ_prev · x0_pred + √(1 − ᾱ_prev − σ²) · ε̂ + σ · z        (z only if eta > 0)
\`\`\`

| eta | steps | what it is |
|---|---|---|
| 0 | 50 on \`range(0, T, T // steps)\` | deterministic map x_T → x_0; the self-test's DDIM |
| 0 | T | the same ODE path, finely discretised |
| 1 | T | DDPM ancestral sampling — matches \`sample\` within 1e-4 under one seed |
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
| U-Net or DiT backbone | ε_θ over images or latent patches, with attention | every image and video model |
| latent diffusion | diffuse in a VAE's 8× downsampled latent, decode at the end | Stable Diffusion |
| [classifier-free guidance](https://arxiv.org/abs/2207.12598) | \`ε̂ = ε̂_∅ + w · (ε̂_c − ε̂_∅)\`, two calls per step, \`w ≈ 3–8\` | text-to-image |
| v-prediction, min-SNR weighting | rescale the target and the per-t loss weight | SD 2, Imagen Video, distillation |
| ODE solvers | DPM-Solver, UniPC: higher-order steps on the eta = 0 path, 10–25 calls | default samplers in \`diffusers\` |
| EMA weights | sample with an exponential moving average of θ | all training recipes |

- Guidance trades diversity for prompt adherence; it needs the network trained with the condition
  randomly dropped (≈ 10 % of batches), so one model provides both \`ε̂_c\` and \`ε̂_∅\`.
- Latent diffusion makes each step 48× cheaper at 512² by shrinking the tensor, not by changing the math.
- The sampler loop is many small kernel launches; \`torch.compile\` and CUDA graphs capture it.

:::quiz
Q: What does classifier-free guidance cost per sampling step, and why?
- [ ] Nothing: the guidance scale only multiplies the predicted noise
- [x] A second network evaluation, because it extrapolates from the unconditional prediction ε̂_∅ towards the conditional ε̂_c
- [ ] A separate classifier's gradient, computed by backpropagation
> CFG needs both ε̂_c and ε̂_∅ at every step — two forward passes (usually batched as one of size 2B).
> The classifier-guidance it replaced needed a noisy-image classifier and its gradient.
:::

# What to take away

- The forward process has a closed-form marginal, so training draws a random \`t\`, noises in one step and
  never runs the chain.
- The schedule is a set of per-timestep constants, computed once in float64 and held as buffers; cosine
  spends its steps more evenly than linear.
- The network predicts the added noise; the loss is plain MSE — the paper's \`L_simple\`.
- The reverse step converts ε̂ into the posterior mean and adds posterior-std noise, none at \`t = 0\`.
- DDIM reuses the same network on a strided, deterministic path: 50 calls instead of 1000.

Primary reference: Ho, Jain & Abbeel, [Denoising Diffusion Probabilistic Models](https://arxiv.org/abs/2006.11239) (NeurIPS 2020).
`;
