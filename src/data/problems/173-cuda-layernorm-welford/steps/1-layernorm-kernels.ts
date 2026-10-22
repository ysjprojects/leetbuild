import type {Step} from '@/lib/types';

/** Host code, CUDA_CHECK, the launches, the CPU reference and the self-test: identical in starter and solution. */
const HOST = `/** One block per row: every row's statistics are reduced inside one block, no inter-block traffic. */
void launch_layernorm_fwd(const float* d_x, const float* d_gamma, const float* d_beta, float* d_y, float* d_mean,
                          float* d_rstd, int rows, int cols, float eps) {
  layernorm_fwd<<<rows, BLOCK_SIZE>>>(d_x, d_gamma, d_beta, d_y, d_mean, d_rstd, rows, cols, eps);
  CUDA_CHECK(cudaGetLastError());
}

/** Backward: min(rows, MAX_PARTS) blocks write one row of partials each, then one thread per column sums them. */
void launch_layernorm_bwd(const float* d_dy, const float* d_x, const float* d_gamma, const float* d_mean,
                          const float* d_rstd, float* d_dx, float* d_dgamma_partial, float* d_dbeta_partial,
                          float* d_dgamma, float* d_dbeta, int rows, int cols) {
  const int parts = rows < MAX_PARTS ? rows : MAX_PARTS;
  layernorm_bwd<<<parts, BLOCK_SIZE>>>(d_dy, d_x, d_gamma, d_mean, d_rstd, d_dx, d_dgamma_partial, d_dbeta_partial,
                                       rows, cols);
  CUDA_CHECK(cudaGetLastError());
  const int reduce_blocks = (cols + BLOCK_SIZE - 1) / BLOCK_SIZE;
  layernorm_bwd_reduce<<<reduce_blocks, BLOCK_SIZE>>>(d_dgamma_partial, d_dbeta_partial, d_dgamma, d_dbeta, parts,
                                                      cols);
  CUDA_CHECK(cudaGetLastError());
}

struct Timings {
  float fwd_ms;
  float bwd_ms;
};

/** Allocate, copy in, warm up, time ITERS forward and ITERS backward launches, copy every output back, free. */
Timings run_layernorm(const std::vector<float>& x, const std::vector<float>& gamma, const std::vector<float>& beta,
                      const std::vector<float>& dy, std::vector<float>& y, std::vector<float>& mean,
                      std::vector<float>& rstd, std::vector<float>& dx, std::vector<float>& dgamma,
                      std::vector<float>& dbeta, int rows, int cols, float eps) {
  const size_t mat = static_cast<size_t>(rows) * cols * sizeof(float);
  const size_t vec = static_cast<size_t>(cols) * sizeof(float);
  const size_t per_row = static_cast<size_t>(rows) * sizeof(float);
  const size_t partial = static_cast<size_t>(MAX_PARTS) * cols * sizeof(float);
  float *d_x, *d_gamma, *d_beta, *d_y, *d_mean, *d_rstd, *d_dy, *d_dx, *d_dgp, *d_dbp, *d_dgamma, *d_dbeta;
  CUDA_CHECK(cudaMalloc(&d_x, mat));
  CUDA_CHECK(cudaMalloc(&d_y, mat));
  CUDA_CHECK(cudaMalloc(&d_dy, mat));
  CUDA_CHECK(cudaMalloc(&d_dx, mat));
  CUDA_CHECK(cudaMalloc(&d_gamma, vec));
  CUDA_CHECK(cudaMalloc(&d_beta, vec));
  CUDA_CHECK(cudaMalloc(&d_dgamma, vec));
  CUDA_CHECK(cudaMalloc(&d_dbeta, vec));
  CUDA_CHECK(cudaMalloc(&d_mean, per_row));
  CUDA_CHECK(cudaMalloc(&d_rstd, per_row));
  CUDA_CHECK(cudaMalloc(&d_dgp, partial));
  CUDA_CHECK(cudaMalloc(&d_dbp, partial));
  CUDA_CHECK(cudaMemcpy(d_x, x.data(), mat, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_dy, dy.data(), mat, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_gamma, gamma.data(), vec, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_beta, beta.data(), vec, cudaMemcpyHostToDevice));
  // Outputs start at zero so a kernel that writes nothing is visible as a large error, not as stale memory.
  CUDA_CHECK(cudaMemset(d_y, 0, mat));
  CUDA_CHECK(cudaMemset(d_dx, 0, mat));
  CUDA_CHECK(cudaMemset(d_mean, 0, per_row));
  CUDA_CHECK(cudaMemset(d_rstd, 0, per_row));
  CUDA_CHECK(cudaMemset(d_dgamma, 0, vec));
  CUDA_CHECK(cudaMemset(d_dbeta, 0, vec));
  CUDA_CHECK(cudaMemset(d_dgp, 0, partial));
  CUDA_CHECK(cudaMemset(d_dbp, 0, partial));

  cudaEvent_t start, mid, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&mid));
  CUDA_CHECK(cudaEventCreate(&stop));
  // Warm-up: module load and first-launch cost stay out of the timing.
  launch_layernorm_fwd(d_x, d_gamma, d_beta, d_y, d_mean, d_rstd, rows, cols, eps);
  launch_layernorm_bwd(d_dy, d_x, d_gamma, d_mean, d_rstd, d_dx, d_dgp, d_dbp, d_dgamma, d_dbeta, rows, cols);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaEventRecord(start));
  for (int it = 0; it < ITERS; ++it) launch_layernorm_fwd(d_x, d_gamma, d_beta, d_y, d_mean, d_rstd, rows, cols, eps);
  CUDA_CHECK(cudaEventRecord(mid));
  for (int it = 0; it < ITERS; ++it)
    launch_layernorm_bwd(d_dy, d_x, d_gamma, d_mean, d_rstd, d_dx, d_dgp, d_dbp, d_dgamma, d_dbeta, rows, cols);
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  Timings t{0.0f, 0.0f};
  CUDA_CHECK(cudaEventElapsedTime(&t.fwd_ms, start, mid));
  CUDA_CHECK(cudaEventElapsedTime(&t.bwd_ms, mid, stop));
  t.fwd_ms /= ITERS;
  t.bwd_ms /= ITERS;

  CUDA_CHECK(cudaDeviceSynchronize());  // an execution error inside a kernel surfaces here
  CUDA_CHECK(cudaMemcpy(y.data(), d_y, mat, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(dx.data(), d_dx, mat, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(mean.data(), d_mean, per_row, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(rstd.data(), d_rstd, per_row, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(dgamma.data(), d_dgamma, vec, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(dbeta.data(), d_dbeta, vec, cudaMemcpyDeviceToHost));

  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(mid));
  CUDA_CHECK(cudaEventDestroy(stop));
  CUDA_CHECK(cudaFree(d_x));
  CUDA_CHECK(cudaFree(d_gamma));
  CUDA_CHECK(cudaFree(d_beta));
  CUDA_CHECK(cudaFree(d_y));
  CUDA_CHECK(cudaFree(d_mean));
  CUDA_CHECK(cudaFree(d_rstd));
  CUDA_CHECK(cudaFree(d_dy));
  CUDA_CHECK(cudaFree(d_dx));
  CUDA_CHECK(cudaFree(d_dgp));
  CUDA_CHECK(cudaFree(d_dbp));
  CUDA_CHECK(cudaFree(d_dgamma));
  CUDA_CHECK(cudaFree(d_dbeta));
  return t;
}

/** CPU oracle in double: two passes (mean, then squared deviations), the textbook backward. */
void layernorm_reference(const std::vector<float>& x, const std::vector<float>& gamma, const std::vector<float>& beta,
                         const std::vector<float>& dy, int rows, int cols, double eps, std::vector<double>& ref_y,
                         std::vector<double>& ref_mean, std::vector<double>& ref_rstd, std::vector<double>& ref_dx,
                         std::vector<double>& ref_dgamma, std::vector<double>& ref_dbeta) {
  ref_dgamma.assign(cols, 0.0);
  ref_dbeta.assign(cols, 0.0);
  for (int r = 0; r < rows; ++r) {
    const float* xr = &x[static_cast<size_t>(r) * cols];
    const float* dyr = &dy[static_cast<size_t>(r) * cols];
    double m = 0.0;
    for (int c = 0; c < cols; ++c) m += xr[c];
    m /= cols;
    double var = 0.0;
    for (int c = 0; c < cols; ++c) {
      const double d = xr[c] - m;
      var += d * d;
    }
    var /= cols;
    const double rs = 1.0 / std::sqrt(var + eps);
    ref_mean[r] = m;
    ref_rstd[r] = rs;
    double acc_g = 0.0, acc_gx = 0.0;
    for (int c = 0; c < cols; ++c) {
      const double xh = (xr[c] - m) * rs;
      const double g = static_cast<double>(dyr[c]) * gamma[c];
      ref_y[static_cast<size_t>(r) * cols + c] = xh * gamma[c] + beta[c];
      acc_g += g;
      acc_gx += g * xh;
      ref_dgamma[c] += dyr[c] * xh;
      ref_dbeta[c] += dyr[c];
    }
    for (int c = 0; c < cols; ++c) {
      const double xh = (xr[c] - m) * rs;
      const double g = static_cast<double>(dyr[c]) * gamma[c];
      ref_dx[static_cast<size_t>(r) * cols + c] = rs * (g - (acc_g + xh * acc_gx) / cols);
    }
  }
}

/** Absolute error below 1, relative above: a mean near 1000 is held to the same 1e-3 as a y near 1. */
double max_scaled_err(const std::vector<float>& got, const std::vector<double>& ref) {
  double worst = 0.0;
  for (size_t i = 0; i < got.size(); ++i) {
    const double e = std::fabs(got[i] - ref[i]) / std::fmax(1.0, std::fabs(ref[i]));
    if (!(e <= worst)) worst = e;  // a NaN poisons the result instead of being skipped
  }
  return worst;
}

static uint32_t g_state = 0x12345678u;
/** Deterministic uniform in [-1, 1). */
static float uniform() {
  g_state = g_state * 1664525u + 1013904223u;
  return static_cast<float>(g_state >> 8) * (2.0f / 16777216.0f) - 1.0f;
}

int main() {
  const int rows = 256, cols = 1000;  // cols not a multiple of BLOCK_SIZE: threads own 3 or 4 columns
  const float eps = 1e-5f;
  const double tol = 1e-3;
  const size_t n = static_cast<size_t>(rows) * cols;
  std::vector<float> x(n), dy(n), gamma(cols), beta(cols);
  for (int r = 0; r < rows; ++r)
    for (int c = 0; c < cols; ++c) {
      const float u = uniform();
      // Every 64th row sits at 1000 + U(-1, 1): mean 1000, variance 1/3. E[x^2] - E[x]^2 in float loses it.
      x[static_cast<size_t>(r) * cols + c] = (r % 64 == 0) ? 1000.0f + u : 2.0f * u;
    }
  for (int c = 0; c < cols; ++c) gamma[c] = 1.0f + 0.1f * uniform();
  for (int c = 0; c < cols; ++c) beta[c] = 0.1f * uniform();
  for (size_t i = 0; i < n; ++i) dy[i] = uniform();

  std::vector<double> ref_y(n), ref_mean(rows), ref_rstd(rows), ref_dx(n), ref_dgamma, ref_dbeta;
  layernorm_reference(x, gamma, beta, dy, rows, cols, eps, ref_y, ref_mean, ref_rstd, ref_dx, ref_dgamma, ref_dbeta);

  std::vector<float> y(n), mean(rows), rstd(rows), dx(n), dgamma(cols), dbeta(cols);
  const Timings t = run_layernorm(x, gamma, beta, dy, y, mean, rstd, dx, dgamma, dbeta, rows, cols, eps);

  const double errs[6] = {max_scaled_err(y, ref_y),   max_scaled_err(mean, ref_mean),
                          max_scaled_err(rstd, ref_rstd), max_scaled_err(dx, ref_dx),
                          max_scaled_err(dgamma, ref_dgamma), max_scaled_err(dbeta, ref_dbeta)};
  printf("rows=%d cols=%d  fwd %.4f ms  bwd %.4f ms\\n", rows, cols, t.fwd_ms, t.bwd_ms);
  printf("max err  y %.2e  mean %.2e  rstd %.2e  dx %.2e  dgamma %.2e  dbeta %.2e\\n", errs[0], errs[1], errs[2],
         errs[3], errs[4], errs[5]);
  const double var0 = rstd[0] > 0.0f ? 1.0 / (static_cast<double>(rstd[0]) * rstd[0]) : 0.0;
  const double ref_var0 = 1.0 / (ref_rstd[0] * ref_rstd[0]);
  printf("row 0 (mean %.4f): var %.6f, reference %.6f\\n", mean[0], var0 - eps, ref_var0 - eps);
  for (double e : errs)
    if (!(e <= tol)) {
      printf("FAIL\\n");
      return 1;
    }
  printf("PASS\\n");
  return 0;
}
`;

/** File header, CUDA_CHECK, constants and the Welford state: identical in starter and solution. */
const HEADER = `// layernorm_kernels.cu — LayerNorm forward and backward on the GPU: one block per row, one-pass mean
// and variance by Welford merged across threads with Chan's formula, the statistics saved for the
// backward, and the backward's two row reductions plus per-column gamma/beta partials.
//   nvcc -O2 -o layernorm_kernels layernorm_kernels.cu && ./layernorm_kernels
#include <cuda_runtime.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

/** Every runtime call goes through this: a failure names the call site and stops the program. */
#define CUDA_CHECK(call)                                                             \\
  do {                                                                               \\
    cudaError_t err_ = (call);                                                       \\
    if (err_ != cudaSuccess) {                                                       \\
      fprintf(stderr, "CUDA error at %s:%d: %s (%s)\\n", __FILE__, __LINE__,          \\
              cudaGetErrorString(err_), #call);                                      \\
      exit(EXIT_FAILURE);                                                            \\
    }                                                                                \\
  } while (0)

constexpr int BLOCK_SIZE = 256;             // threads per row: 8 warps
constexpr int MAX_PARTS = 64;               // backward blocks, each owning one row of gamma/beta partials
constexpr int ITERS = 20;                   // timed launches
constexpr unsigned FULL_MASK = 0xffffffffu; // every lane of the warp takes part in a shuffle

/** Running statistics of a set of values: how many, their mean, the sum of squared deviations from it. */
struct Welford {
  float count;
  float mean;
  float m2;
};
`;

export const layernormKernelsStep: Step = {
  id: 'layernorm-kernels',
  title: 'layernorm_fwd and layernorm_bwd: Welford, Chan merge, saved statistics, two reductions',
  concept: 'cuda',
  file: 'layernorm_kernels',
  focus: [
    'x',
    'welford',
    'warp-merge',
    's-warp',
    'warp0',
    'norm',
    'saved',
    'y',
    'bwd',
    'dy-x',
    'bwd-load',
    'sum2',
    'dx',
    'acc',
    'dx-out',
    'partials',
    'reduce',
    'grads',
  ],
  task: `## Task

Write \`layernorm_kernels.cu\`: LayerNorm over the last dimension of a row-major \`float\` matrix
\`x[rows, cols]\`, \`y = (x − mean) · rstd · gamma + beta\` with \`rstd = 1 / sqrt(var + eps)\` and the biased
variance \`var = Σ (x − mean)² / cols\`, forward and backward. The header (\`CUDA_CHECK\`, \`BLOCK_SIZE = 256\`,
\`MAX_PARTS = 64\`, \`FULL_MASK\`, \`struct Welford {float count, mean, m2;}\`), the launches, the CPU reference
and the self-test are given; the device code is yours.

- **\`welford_update(Welford& s, float v)\`.** One value into the running state: \`s.count += 1\`,
  \`delta = v − s.mean\`, \`s.mean += delta / s.count\`, \`s.m2 += delta * (v − s.mean)\` — the deviation from the
  old mean times the deviation from the new one. Each thread folds its columns \`threadIdx.x, + blockDim.x, …\`
  of the row in one pass over \`x\`.
- **\`Welford welford_merge(const Welford& a, const Welford& b)\`.** Chan's parallel combination:
  \`count = a.count + b.count\`, \`delta = b.mean − a.mean\`, \`mean = a.mean + delta * b.count / count\`,
  \`m2 = a.m2 + b.m2 + delta * delta * a.count * b.count / count\`. Two empty states (\`count == 0\`, threads
  past the end of a short row) merge to an empty state, not to \`0 / 0\`.

One step of the warp tree: lane \`l\` receives lane \`l + offset\`'s state through three shuffles and merges it
into its own, all in registers:

:::gpu
{
  "align": "start",
  "items": [
    {"id": "cm-lane", "label": "Lane l", "layout": "column", "items": [
      {"threads": 1},
      {"id": "cm-a", "array": "a", "sub": "its own state", "cols": 3, "tone": "register", "cells": ["n", "μ", "M2"]},
      {"id": "cm-merge", "label": "welford_merge(a, b)", "tone": "register", "layout": "column", "items": [
        {"label": "n", "sub": "n_a + n_b", "tone": "register", "stretch": true},
        {"label": "δ", "sub": "mean_b − mean_a", "tone": "register", "stretch": true},
        {"label": "mean", "sub": "mean_a + δ·n_b / n", "tone": "register", "stretch": true},
        {"label": "M2", "sub": "M2_a + M2_b + δ²·n_a·n_b / n", "tone": "register", "stretch": true, "detail": "The last term is the spread between the two means, weighted by how many values sit on each side; it only adds, never subtracts."}
      ], "detail": "If n_a + n_b is 0 (two empty lanes past the end of a short row), return a unchanged instead of dividing 0 by 0."}
    ]},
    {"id": "cm-other", "label": "Lane l + offset", "layout": "column", "items": [
      {"threads": 1},
      {"id": "cm-b", "array": "b", "sub": "its state", "cols": 3, "tone": "register", "cells": ["n", "μ", "M2"]}
    ]}
  ],
  "arrows": [
    {"from": "cm-b", "to": "cm-a", "label": "__shfl_down_sync × 3"}
  ]
}
:::

- **\`warp_welford(Welford s)\`.** A tree over \`offset = 16, 8, 4, 2, 1\`: \`__shfl_down_sync(FULL_MASK, …)\` of
  \`s.count\`, \`s.mean\` and \`s.m2\`, then \`welford_merge\`; lane 0 ends with the warp's statistics.
- **\`__global__ void layernorm_fwd(x, gamma, beta, y, mean, rstd, rows, cols, eps)\`.** One block per row
  (\`blockIdx.x\` is the row). Per-thread Welford, \`warp_welford\`, lane 0 of each warp writes a
  \`__shared__ Welford\` slot, \`__syncthreads()\`, warp 0 merges the eight slots, and thread 0 computes
  \`var = m2 / cols\` and \`rstd = rsqrtf(var + eps)\`, **writes \`mean[row]\` and \`rstd[row]\`** to global memory
  for the backward and to shared memory for the block; after a second \`__syncthreads()\` every thread writes
  \`y[row, c] = (x[row, c] − mean) * rstd * gamma[c] + beta[c]\`.
- **\`__device__ void block_reduce_sum2(float& a, float& b)\`.** Block-wide sums of two values, returned to
  every thread (\`__shfl_xor_sync\` within warps, a \`__shared__\` slot per warp, a \`__syncthreads()\` before the
  writes so a previous call's readers are done).
- **\`__global__ void layernorm_bwd(dy, x, gamma, mean, rstd, dx, dgamma_partial, dbeta_partial, rows, cols)\`.**
  \`min(rows, MAX_PARTS)\` blocks; block \`b\` handles rows \`b, b + gridDim.x, …\`. For each row it **reads
  \`mean[row]\` and \`rstd[row]\`** (no second variance), forms \`xhat = (x − mean) * rstd\` and \`g = dy * gamma\`,
  accumulates **\`sum_g += g\`** and **\`sum_gx += g * xhat\`**, calls \`block_reduce_sum2(sum_g, sum_gx)\`, then
  writes \`dx = rstd * (g − (sum_g + xhat * sum_gx) / cols)\`. Into its own partial row
  \`dgamma_partial[blockIdx.x * cols + c]\` (zeroed at the start) it adds \`dy * xhat\`, into
  \`dbeta_partial[…]\` it adds \`dy\`.
- **\`__global__ void layernorm_bwd_reduce(dgamma_partial, dbeta_partial, dgamma, dbeta, parts, cols)\`.** One
  thread per column, \`for (p = 0; p < parts; ++p)\` over the partial rows: \`dgamma[c]\`, \`dbeta[c]\`.
- **Forbidden:** \`E[x²] − E[x]²\` in any form (a running \`sum_sq\`, \`… − mean * mean\`, \`powf(…, 2)\`), a
  two-pass mean-then-variance in the kernel, \`1.0f / sqrtf(…)\`, \`atomicAdd\` for \`dgamma\`, cuDNN, Apex.
- **Self-test (given).** \`rows = 256\`, \`cols = 1000\`, \`eps = 1e-5\`; rows 0, 64, 128, 192 are \`1000 + U(−1, 1)\`,
  the rest \`2 · U(−1, 1)\`. A double-precision CPU reference; the max of \`|gpu − ref| / max(1, |ref|)\` over
  \`y\`, \`mean\`, \`rstd\`, \`dx\`, \`dgamma\`, \`dbeta\` must each be \`≤ 1e-3\`; it prints the timings, the six errors,
  row 0's variance against the reference, and \`PASS\`.

Why the naive formula is forbidden: the same variance in float32, both ways, as the offset grows:

:::widget variance-cancellation

> A row's variance is not \`E[x²] − E[x]²\` on a GPU: in float that is two numbers near 10⁶ subtracted to find
> one near 0.33. Welford keeps deviations small, and Chan's merge lets 256 threads combine theirs exactly.`,
  hints: [
    'Welford and Chan are five lines each: update `count += 1; delta = v - mean; mean += delta / count; m2 += delta * (v - mean);`, merge `delta = b.mean - a.mean; mean = a.mean + delta * b.count / count; m2 = a.m2 + b.m2 + delta * delta * a.count * b.count / count`. Return `a` when `a.count + b.count == 0` — empty lanes exist whenever `cols < blockDim.x` and the warp tree merges them.',
    'The forward reduction: `warp_welford` shuffles the three fields with `__shfl_down_sync(FULL_MASK, s.count, offset)` and merges; lane 0 of warp `w` writes `s_warp[w]` (a `__shared__ Welford s_warp[32]`); `__syncthreads()`; warp 0 loads `s_warp[lane]` for `lane < 8` (an empty state otherwise) and runs `warp_welford` again; thread 0 writes `mean[row]`, `rstd[row] = rsqrtf(w.m2 / cols + eps)` and two `__shared__` floats; a second `__syncthreads()` before anyone reads them.',
    'The backward from `y = γ·xhat + β`: with `g = dy·γ`, `dx = rstd · (g − mean(g) − xhat · mean(g·xhat))` — the two means are your two block reductions, done once per row before the loop that writes `dx`. Each backward block zeroes its own partial row first, then only thread `t` ever touches column `c ≡ t (mod 256)` of it, so `+=` needs no atomics; `layernorm_bwd_reduce` sums the 64 partial rows column by column (coalesced across threads).',
  ],
  checks: [
    {
      id: 'welford-update',
      title: 'Each thread folds its columns with Welford’s one-pass update',
      detail:
        'A `__device__` `welford_update` that does `s.mean += delta / s.count` and `s.m2 += delta * (v - s.mean)` — the deviation from the old mean times the deviation from the new one. One read of `x` per element, and `m2` only ever accumulates products of small deviations, never squares of values near 1000.',
      match: {
        cuda: {
          all: [
            /__device__[^{;]*\bwelford_update\s*\(/,
            /\.mean\s*\+=\s*\w+\s*\/\s*\w+\.count\b/,
            /\.m2\s*\+=\s*\w+\s*\*\s*\(\s*\w+\s*-\s*\w+\.mean\s*\)/,
          ],
        },
      },
    },
    {
      id: 'chan-merge',
      title: 'Two partial states combine with Chan’s formula',
      detail:
        '`welford_merge` computes `delta = b.mean - a.mean`, `mean = a.mean + delta * b.count / count` and `m2 = a.m2 + b.m2 + delta * delta * a.count * b.count / count`. Adding the two `m2`s alone drops the spread *between* the halves; the `delta² · n_a · n_b / n` term restores it exactly.',
      match: {
        cuda: {
          all: [
            /\bwelford_merge\s*\(/,
            /\w+\.mean\s*-\s*\w+\.mean\b/,
            /\w+\.mean\s*\+\s*\w+\s*\*\s*\w+\.count\s*\/\s*\w+/,
            /\w+\.m2\s*\+\s*\w+\.m2\s*\+\s*\w+\s*\*\s*[^;]*\w+\.count\s*\*\s*\w+\.count\s*\/\s*\w+/,
          ],
        },
      },
    },
    {
      id: 'warp-block-merge',
      title: 'States merged across the warp by shuffles and across warps through shared memory',
      detail:
        'All three fields travel through `__shfl_down_sync` (or `__shfl_xor_sync`) and are merged with `welford_merge`; lane 0 of each warp writes a `__shared__ Welford` slot and a `__syncthreads()` separates those writes from warp 0 reading them. Shuffling `mean` alone, or averaging the per-warp variances, is not a merge.',
      match: {
        cuda: {
          all: [
            /__shfl_(down|xor)_sync\s*\(\s*FULL_MASK\s*,\s*\w+\.count\b/,
            /__shfl_(down|xor)_sync\s*\(\s*FULL_MASK\s*,\s*\w+\.mean\b/,
            /__shfl_(down|xor)_sync\s*\(\s*FULL_MASK\s*,\s*\w+\.m2\b/,
            /__shared__\s+Welford\s+\w+\s*\[/,
            /__syncthreads\s*\(\s*\)/,
          ],
        },
      },
    },
    {
      id: 'rsqrtf',
      title: 'rstd = rsqrtf(m2 / cols + eps): biased variance, one hardware reciprocal square root',
      detail:
        'The variance is `m2 / cols` (LayerNorm normalises by the population variance, not `count - 1`), and the reciprocal standard deviation is `rsqrtf(var + eps)` — one SFU instruction instead of `1.0f / sqrtf(...)`, a square root and a division.',
      match: {
        cuda: {
          all: [/\.m2\s*\/\s*[^;]*\bcols\b/, /\brsqrtf\s*\(\s*[\w.]+\s*\+\s*eps\s*\)/],
          none: [/\/\s*sqrtf\s*\(/, /\.m2\s*\/\s*\(\s*[\w.]*count\s*-\s*1/],
        },
      },
    },
    {
      id: 'saved-stats',
      title: 'The forward saves mean[row] and rstd[row]; the backward reads them',
      detail:
        'Thread 0 of the forward block writes `mean[row]` and `rstd[row]` to global memory; `layernorm_bwd` loads `mean[row]` and `rstd[row]` instead of reducing the row again. That is what PyTorch saves for `native_layer_norm_backward`: two floats per row buy back a whole reduction.',
      match: {
        cuda: {
          all: [
            /\bmean\s*\[\s*row\s*\]\s*=(?!=)/,
            /\brstd\s*\[\s*row\s*\]\s*=(?!=)/,
            /=\s*mean\s*\[\s*row\s*\]/,
            /=\s*rstd\s*\[\s*row\s*\]/,
          ],
        },
      },
    },
    {
      id: 'bwd-two-reductions',
      title: 'The backward reduces Σ dy·γ and Σ dy·γ·xhat per row before writing dx',
      detail:
        '`sum_g += g` and `sum_gx += g * xhat` over the row, both reduced across the block, and then `dx = rstd * (g - (sum_g + xhat * sum_gx) / cols)`. Writing `dx` before the reduction finishes, or with only one of the sums, is the gradient of a different function.',
      match: {
        cuda: {
          all: [/\bsum_g\s*\+=\s*\w+/, /\bsum_gx\s*\+=\s*(\w+\s*\*\s*xhat|xhat\s*\*\s*\w+)\b/],
          order: [/\bsum_gx\s*\+=/, /\bdx\s*\[[^\]]*\]\s*=[^;]*\bsum_g\b[^;]*\bsum_gx\b/],
        },
      },
    },
    {
      id: 'dgamma-partials',
      title: 'dgamma and dbeta as per-block partial rows plus a column reduce',
      detail:
        'Each backward block adds `dy * xhat` and `dy` into its own row `blockIdx.x * cols` of `dgamma_partial` / `dbeta_partial`, and `layernorm_bwd_reduce` loops `p < parts` to sum them per column. No `atomicAdd`: 256 rows hammering 1000 addresses serialise, and float atomics make the result depend on the order they land in.',
      match: {
        cuda: {
          all: [
            /blockIdx\.x\s*\)?\s*\*\s*cols\b/,
            /\[\s*\w+\s*\]\s*\+=\s*\w+\s*\*\s*xhat\b/,
            /__global__\s+void\s+layernorm_bwd_reduce\s*\(/,
            /for\s*\([^;]*;\s*\w+\s*<\s*parts\b/,
          ],
          none: [/\batomicAdd\s*\(/],
        },
      },
    },
    {
      id: 'no-naive-variance',
      title: 'No E[x²] − E[x]² anywhere',
      detail:
        'The merge is used (`welford_merge(s, other)`), and nothing subtracts a squared mean (`... - mean * mean`), keeps a `sum_sq`, or calls `powf(..., 2)`. On a row at 1000 + U(−1, 1), `E[x²]` and `E[x]²` are both about 10⁶ and differ only in the seventh significant digit — the last one a float holds — so the variance that should be 0.328 comes out as 0.375 on row 0 and up to 31% off on the others, and on a flatter row as a negative number that `rsqrtf` turns into NaN.',
      match: {
        cuda: {
          all: [/\bwelford_merge\s*\(\s*\w+\s*,\s*\w+\s*\)/],
          none: [/-\s*([A-Za-z_][\w.]*)\s*\*\s*\1\b/, /\bsum_?sq\w*\b/, /\bpowf?\s*\(\s*[^,]+,\s*2(\.0f?)?\s*\)/],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `${HEADER}
/** Welford (1962): fold one value into the running statistics. */
__device__ __forceinline__ void welford_update(Welford& s, float v) {
  // TODO: count += 1; delta = v - mean; mean += delta / count; m2 += delta * (v - mean).
}

/** Chan, Golub and LeVeque (1979): combine the statistics of two disjoint sets. */
__device__ __forceinline__ Welford welford_merge(const Welford& a, const Welford& b) {
  // TODO: count = a.count + b.count (two empty states stay empty); delta = b.mean - a.mean;
  // mean = a.mean + delta * b.count / count; m2 = a.m2 + b.m2 + delta * delta * a.count * b.count / count.
  return a;
}

/** Tree-merge a warp's 32 states; lane 0 ends with the warp's statistics. */
__device__ __forceinline__ Welford warp_welford(Welford s) {
  // TODO: for offset = 16, 8, 4, 2, 1: __shfl_down_sync(FULL_MASK, ...) of count, mean and m2, then merge.
  return s;
}

/** Block-wide sums of a and b, returned to every thread. */
__device__ void block_reduce_sum2(float& a, float& b) {
  // TODO: __shfl_xor_sync within each warp; one __shared__ slot per warp (with a __syncthreads() before
  // the writes and one after); every warp then sums the per-warp totals.
}

/** One block per row: Welford per thread, merged across the block; saves mean and rstd; writes y. */
__global__ void layernorm_fwd(const float* __restrict__ x, const float* __restrict__ gamma,
                              const float* __restrict__ beta, float* __restrict__ y, float* __restrict__ mean,
                              float* __restrict__ rstd, int rows, int cols, float eps) {
  // TODO: row = blockIdx.x; per-thread welford_update over columns threadIdx.x, + blockDim.x, ...;
  // warp_welford; lane 0 -> __shared__ Welford slot; __syncthreads(); warp 0 merges the slots; thread 0
  // writes mean[row] and rstd[row] = rsqrtf(m2 / cols + eps) (and shares them); __syncthreads();
  // y = (x - mean) * rstd * gamma + beta.
}

/** Rows blockIdx.x, + gridDim.x, ...: dx from the two row reductions; dgamma/dbeta into this block's partial row. */
__global__ void layernorm_bwd(const float* __restrict__ dy, const float* __restrict__ x,
                              const float* __restrict__ gamma, const float* __restrict__ mean,
                              const float* __restrict__ rstd, float* __restrict__ dx,
                              float* __restrict__ dgamma_partial, float* __restrict__ dbeta_partial, int rows,
                              int cols) {
  // TODO: zero this block's partial rows; for each row read the saved mean and rstd, accumulate
  // sum_g += dy * gamma and sum_gx += dy * gamma * xhat, block_reduce_sum2(sum_g, sum_gx), then
  // dx = rstd * (g - (sum_g + xhat * sum_gx) / cols), partials += dy * xhat and dy.
}

/** One thread per column: sum the partial rows. */
__global__ void layernorm_bwd_reduce(const float* __restrict__ dgamma_partial, const float* __restrict__ dbeta_partial,
                                     float* __restrict__ dgamma, float* __restrict__ dbeta, int parts, int cols) {
  // TODO: for each column c: dgamma[c] = sum over p of dgamma_partial[p * cols + c]; dbeta[c] likewise.
}

${HOST}`,
      solution: `${HEADER}
/** Welford (1962): fold one value into the running statistics. */
__device__ __forceinline__ void welford_update(Welford& s, float v) {
  s.count += 1.0f;
  const float delta = v - s.mean;
  s.mean += delta / s.count;
  s.m2 += delta * (v - s.mean);  // old deviation times new deviation: small numbers, never negative
}

/** Chan, Golub and LeVeque (1979): combine the statistics of two disjoint sets. */
__device__ __forceinline__ Welford welford_merge(const Welford& a, const Welford& b) {
  const float count = a.count + b.count;
  if (count == 0.0f) return a;  // two empty states: lanes past the end of a short row
  const float delta = b.mean - a.mean;
  Welford out;
  out.count = count;
  out.mean = a.mean + delta * b.count / count;
  out.m2 = a.m2 + b.m2 + delta * delta * a.count * b.count / count;  // the spread between the halves
  return out;
}

/** Tree-merge a warp's 32 states; lane 0 ends with the warp's statistics. */
__device__ __forceinline__ Welford warp_welford(Welford s) {
  for (int offset = 16; offset > 0; offset >>= 1) {
    Welford other;
    other.count = __shfl_down_sync(FULL_MASK, s.count, offset);
    other.mean = __shfl_down_sync(FULL_MASK, s.mean, offset);
    other.m2 = __shfl_down_sync(FULL_MASK, s.m2, offset);
    s = welford_merge(s, other);
  }
  return s;
}

/** Butterfly sum: every lane ends with the same total (float addition is commutative, so bit-identical). */
__device__ __forceinline__ float warp_sum(float v) {
  for (int offset = 16; offset > 0; offset >>= 1) v += __shfl_xor_sync(FULL_MASK, v, offset);
  return v;
}

/** Block-wide sums of a and b, returned to every thread. */
__device__ void block_reduce_sum2(float& a, float& b) {
  __shared__ float s_a[32];
  __shared__ float s_b[32];
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const int num_warps = (blockDim.x + 31) >> 5;
  a = warp_sum(a);
  b = warp_sum(b);
  __syncthreads();  // the previous call's readers are done with s_a and s_b
  if (lane == 0) {
    s_a[warp] = a;
    s_b[warp] = b;
  }
  __syncthreads();
  a = warp_sum(lane < num_warps ? s_a[lane] : 0.0f);  // every warp sums the per-warp totals
  b = warp_sum(lane < num_warps ? s_b[lane] : 0.0f);
}

/** One block per row: Welford per thread, merged across the block; saves mean and rstd; writes y. */
__global__ void layernorm_fwd(const float* __restrict__ x, const float* __restrict__ gamma,
                              const float* __restrict__ beta, float* __restrict__ y, float* __restrict__ mean,
                              float* __restrict__ rstd, int rows, int cols, float eps) {
  __shared__ Welford s_warp[32];
  __shared__ float s_mean;
  __shared__ float s_rstd;
  const int row = blockIdx.x;
  if (row >= rows) return;  // the whole block leaves together: no thread is left waiting at a barrier
  const float* xr = x + static_cast<size_t>(row) * cols;
  float* yr = y + static_cast<size_t>(row) * cols;
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const int num_warps = (blockDim.x + 31) >> 5;

  Welford s = {0.0f, 0.0f, 0.0f};
  for (int c = threadIdx.x; c < cols; c += blockDim.x) welford_update(s, xr[c]);  // one pass, coalesced

  s = warp_welford(s);
  if (lane == 0) s_warp[warp] = s;
  __syncthreads();
  if (warp == 0) {
    Welford w = lane < num_warps ? s_warp[lane] : Welford{0.0f, 0.0f, 0.0f};
    w = warp_welford(w);
    if (lane == 0) {
      const float var = w.m2 / static_cast<float>(cols);  // biased: LayerNorm uses the population variance
      const float r = rsqrtf(var + eps);
      mean[row] = w.mean;  // saved for the backward
      rstd[row] = r;
      s_mean = w.mean;
      s_rstd = r;
    }
  }
  __syncthreads();
  const float mu = s_mean;
  const float r = s_rstd;
  for (int c = threadIdx.x; c < cols; c += blockDim.x) yr[c] = (xr[c] - mu) * r * gamma[c] + beta[c];
}

/** Rows blockIdx.x, + gridDim.x, ...: dx from the two row reductions; dgamma/dbeta into this block's partial row. */
__global__ void layernorm_bwd(const float* __restrict__ dy, const float* __restrict__ x,
                              const float* __restrict__ gamma, const float* __restrict__ mean,
                              const float* __restrict__ rstd, float* __restrict__ dx,
                              float* __restrict__ dgamma_partial, float* __restrict__ dbeta_partial, int rows,
                              int cols) {
  float* dg_part = dgamma_partial + static_cast<size_t>(blockIdx.x) * cols;
  float* db_part = dbeta_partial + static_cast<size_t>(blockIdx.x) * cols;
  // Thread t only ever touches columns t, t + blockDim.x, ... of this block's row: no atomics, no barrier.
  for (int c = threadIdx.x; c < cols; c += blockDim.x) {
    dg_part[c] = 0.0f;
    db_part[c] = 0.0f;
  }
  const float inv_cols = 1.0f / static_cast<float>(cols);
  for (int row = blockIdx.x; row < rows; row += gridDim.x) {
    const size_t base = static_cast<size_t>(row) * cols;
    const float mu = mean[row];  // the forward's statistics: no second reduction over x
    const float r = rstd[row];
    float sum_g = 0.0f;
    float sum_gx = 0.0f;
    for (int c = threadIdx.x; c < cols; c += blockDim.x) {
      const float xhat = (x[base + c] - mu) * r;
      const float g = dy[base + c] * gamma[c];
      sum_g += g;
      sum_gx += g * xhat;
    }
    block_reduce_sum2(sum_g, sum_gx);
    for (int c = threadIdx.x; c < cols; c += blockDim.x) {
      const float xhat = (x[base + c] - mu) * r;
      const float d = dy[base + c];
      const float g = d * gamma[c];
      dx[base + c] = r * (g - (sum_g + xhat * sum_gx) * inv_cols);
      dg_part[c] += d * xhat;
      db_part[c] += d;
    }
  }
}

/** One thread per column: sum the partial rows. */
__global__ void layernorm_bwd_reduce(const float* __restrict__ dgamma_partial, const float* __restrict__ dbeta_partial,
                                     float* __restrict__ dgamma, float* __restrict__ dbeta, int parts, int cols) {
  for (int c = blockIdx.x * blockDim.x + threadIdx.x; c < cols; c += gridDim.x * blockDim.x) {
    float sg = 0.0f;
    float sb = 0.0f;
    for (int p = 0; p < parts; ++p) {  // adjacent threads read adjacent columns of each partial row
      sg += dgamma_partial[static_cast<size_t>(p) * cols + c];
      sb += dbeta_partial[static_cast<size_t>(p) * cols + c];
    }
    dgamma[c] = sg;
    dbeta[c] = sb;
  }
}

${HOST}`,
    },
  },
  debrief: `Three choices carry the kernel, and each one is there because the obvious version fails. **One block per row** keeps a row's statistics inside one SM: 256 threads read 1000 contiguous floats coalesced, reduce through shuffles and 32 slots of shared memory, and never talk to another block — LayerNorm rows are independent, so the grid is just \`rows\`. **Welford plus Chan** is the numerics: the textbook \`E[x²] − E[x]²\` reads \`x\` once too, but on a row at 1000 it subtracts two float sums near 10⁶ that differ only in their seventh digit, and the variance of 0.328 comes back as 0.375 — a 6% error in \`rstd\` on every element of the row, or a negative variance and a NaN on a flatter one. Welford's update only ever multiplies small deviations, and Chan's \`delta² · n_a · n_b / n\` term merges two partial states *exactly* in real arithmetic, so the tree of 256 → 8 → 1 merges adds only a few roundings to what the per-thread passes did; the two-pass alternative is as accurate but reads the row twice. **Saving \`mean\` and \`rstd\`** costs 2 KB for 256 rows and spares the backward a whole reduction; \`rsqrtf\` is the one SFU instruction that gives \`rstd\` directly. The backward is two more row reductions — \`Σ dy·γ\` and \`Σ dy·γ·xhat\`, the two terms the chain rule leaves after differentiating through the mean and the variance — and a column reduction for \`dγ\` and \`dβ\`, done as 64 partial rows then one thread per column so nothing is atomic and the sum is deterministic run to run. Production kernels keep this shape and add the rest: PyTorch's \`vectorized_layer_norm_kernel\` and Apex's \`FusedLayerNorm\` use the same Welford-and-Chan merge (Apex calls them \`cuWelfordOnlineSum\` and \`cuChanOnlineSum\`), load vectors of four floats or eight halves, and accumulate in float while reading bf16 or fp16; Apex's contrib \`FastLayerNorm\` keeps the whole row in registers for the hidden sizes it supports, and Apex's \`cuComputePartGradGammaBeta\` / \`cuComputeGradGammaBeta\` is the same partials-then-reduce split. Triton's LayerNorm tutorial loops over the row twice for the mean and the variance and a third time to normalise, and accumulates \`dγ\` in a lock-protected buffer of partial rows — another way to avoid \`atomicAdd\` on every column. And in a real model the residual add and the dropout before it are fused into the same kernel, because LayerNorm is bandwidth-bound: 8 bytes per element forward and 12 backward for a handful of FLOPs.`,
};
