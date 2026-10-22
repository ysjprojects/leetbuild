import type {Step} from '@/lib/types';

/** `__expf(a - b)` / `expf(a - b)`: the exponent is taken of a difference, one level of parentheses allowed inside. */
const EXP_OF_DIFFERENCE = /_{0,2}expf\(\s*[^()\s](?:[^()]|\([^()]*\))*?\s*-\s*(?:[^()]|\([^()]*\))+\)/;

/** `exp` of a bare element load — the row max was not subtracted. */
const RAW_EXP = /_{0,2}expf\(\s*\w+\s*\[[^\]]*\]\s*\)/;

/** A warp shuffle, butterfly or tree. */
const SHUFFLE = /__shfl_(xor|down)_sync\(/;

/** The row max going through a shuffle: `fmaxf(v, __shfl_xor_sync(…))` or `fmaxf(__shfl_xor_sync(…), v)`. */
const MAX_SHUFFLE = /fmaxf\((?=[^;]*__shfl_(xor|down)_sync\()/;

/** The sum going through a shuffle: `v += __shfl_…` / `v + __shfl_…` / `__shfl_…(…) + v`. */
const SUM_SHUFFLE = /\+=?\s*__shfl_(xor|down)_sync\(|__shfl_(xor|down)_sync\([^;]*\)\s*\+/;

export const rowSoftmaxStep: Step = {
  id: 'row-softmax',
  title: 'softmax_rows: one block per row, two block reductions, exp(x − max)',
  concept: 'cuda',
  file: 'row_softmax',
  focus: ['x', 'pass-max', 's-max', 'guard', 'pass-sum', 's-sum', 'write', 'inv', 'y'],
  task: `## Task

Implement \`__global__ void softmax_rows(const float* x, float* y, int rows, int cols)\`: \`y[r][c] = exp(x[r][c] − m_r) / Σ_c exp(x[r][c] − m_r)\`
with \`m_r = max_c x[r][c]\`, for a row-major fp32 matrix of \`rows × cols\`, any \`cols\`. The host launches
**one block per row** (\`LAUNCH(softmax_rows, rows, THREADS, …)\`, \`THREADS = 256\`) and is written for you.

- **Thread → row**: \`row = blockIdx.x\`; each thread walks \`c = threadIdx.x, threadIdx.x + blockDim.x, …\`
  while \`c < cols\`. A row is never split across blocks and a block never touches another row.
- **Pass 1, the max**: a per-thread local max (start at \`-INFINITY\`), then a block-wide max: \`fmaxf\` across
  the warp with \`__shfl_xor_sync\` (or \`__shfl_down_sync\`), lane 0 of each warp into \`__shared__\` memory,
  \`__syncthreads()\`, one warp reduces the partials, and every thread reads the result back.

The warp level in its \`__shfl_down_sync\` tree form, stepped through as a sum; the max is the same tree with \`fmaxf\`:

:::widget warp-reduce

- **Pass 2, the sum**: each thread accumulates \`__expf(x − m)\` (or \`expf\`) over its elements — write the
  subtraction *inside* the call — then a second block reduction, \`+\` instead of \`fmaxf\`, through its own
  shared slots.
- **Pass 3, the write**: \`y = __expf(x − m) / sum\`. Recompute the exponent (the row sits in L1/L2 by now) or
  keep the values in registers when \`cols\` fits a per-thread budget; either is accepted.
- **A fully masked row** (every element \`-INFINITY\`, as a padding mask leaves it) has \`m = -inf\`,
  \`-inf − (-inf) = NaN\`, \`sum = 0\`: it must come out as **zeros**, no NaN anywhere. A partially masked row
  is ordinary: \`exp(-inf − m) = 0\`.
- One kernel, one launch, no \`cub::\`, \`thrust::\`, cuDNN or cuBLAS, no \`exp\` on an element before the max
  is known.
- The self-test at the end of the file (do not change it) fills \`4096 × 1000\` with \`U(−3, 3)\`, sets row 0 to
  magnitudes of \`1e4\` (\`exp(1e4)\` overflows fp32; only the shifted form survives), row 1 to all \`-inf\` and
  the second half of row 2 to \`-inf\`, compares against a double-precision CPU reference
  (\`max |gpu − cpu| < 1e-5\`, \`max |row sum − 1| < 1e-4\`, masked row all zeros, no NaN), times 50 launches
  with \`cudaEvent\`s and prints \`PASS\`.

> \`exp(x − m) / Σ exp(x − m)\` is the same number as \`exp(x) / Σ exp(x)\` — the shift cancels — but its largest
> exponent is \`0\`, so nothing overflows and the sum sits in \`[1, cols]\`. That one subtraction is why the
> row max has to be known before the first \`exp\`, and why softmax is two reductions, not one.`,
  hints: [
    'Write `warp_max(v)` and `warp_sum(v)` first: five rounds of `v = fmaxf(v, __shfl_xor_sync(0xffffffff, v, offset))` (or `v +=`) for `offset = 16, 8, 4, 2, 1`. After the loop every lane holds the warp’s result, so lane 0 can write it to `shared[warp]` with no further exchange.',
    'A block reduction is: warp reduce → `if (lane == 0) shared[warp] = v` → `__syncthreads()` → warp 0 loads `shared[lane]` (or the identity, `-INFINITY` / `0.f`, for lanes past the warp count) and warp-reduces again → thread 0 writes `shared[0]` → `__syncthreads()` → everyone returns `shared[0]`. Give the max and the sum separate shared arrays so the second never races the first.',
    'Handle the masked row with two guards after the reductions: `if (m == -INFINITY) m = 0.f;` so `exp(-inf − m)` is `0`, and `inv = sum > 0.f ? 1.f / sum : 0.f;` so the write is `0 × 0`, not `0 / 0`. Then `y = __expf(x − m) * inv`.',
  ],
  checks: [
    {
      id: 'one-block-per-row',
      title: 'One block owns one row; threads stride the row',
      detail:
        'The row index is `blockIdx.x`, each thread visits `c = threadIdx.x, threadIdx.x + blockDim.x, …` below `cols`, and the launch is `LAUNCH(softmax_rows, rows, THREADS, …)` — any `cols` works, including 1000 with 256 threads, and no two blocks share a row.',
      match: {
        cuda: {all: [/=\s*blockIdx\.x\s*;/, /\+=\s*blockDim\.x\b/, /LAUNCH\(\s*softmax_rows\s*,\s*rows\b/]},
      },
    },
    {
      id: 'max-before-exp',
      title: 'exp is taken of x − m, after the row max is known',
      detail:
        'Every `__expf`/`expf` call takes a difference, `x[c] − m`, and the block-wide `fmaxf` reduction appears before the first `exp` — `exp` of a raw element overflows at 88.7 (row 0 reaches 1e4), and double `exp(` is forbidden in the kernel.',
      match: {
        cuda: {
          all: [EXP_OF_DIFFERENCE],
          order: [/fmaxf\(/, /_{0,2}expf\(/],
          none: [RAW_EXP, /(?<![\w:.])exp\(/],
        },
      },
    },
    {
      id: 'warp-shuffles',
      title: 'Both reductions go through warp shuffles',
      detail:
        'The max is reduced with `fmaxf` over `__shfl_xor_sync`/`__shfl_down_sync` and the sum with `+` over the same — no `cub::BlockReduce`, `thrust::`, cuDNN or cuBLAS. Shuffles keep the first 5 rounds of each reduction in registers, no shared memory and no barrier.',
      match: {
        cuda: {all: [SHUFFLE, MAX_SHUFFLE, SUM_SHUFFLE], none: [/cub::|thrust::|cudnn|cublas/i]},
      },
    },
    {
      id: 'block-reduce-shared',
      title: 'Warp partials cross the block through shared memory and barriers',
      detail:
        'Lane 0 of each warp writes its partial to `__shared__ float` slots, a `__syncthreads()` separates the write from the read, and a second barrier publishes the final value — at least two barriers in the file, one per hand-off. Without them a warp reads a slot another warp has not written yet.',
      match: {
        cuda: {all: [/__shared__\s+float/, /__syncthreads\(\)[\s\S]*__syncthreads\(\)/]},
      },
    },
    {
      id: 'masked-row',
      title: 'A fully masked row gives zeros, not NaN',
      detail:
        'The local max starts at `-INFINITY` and the kernel guards the all-`-inf` case: `m == -INFINITY`, `isinf(m)`, or a test of the sum against zero before the division — row 1 of the self-test must come back as zeros and the output must contain no NaN.',
      match: {
        cuda: {
          all: [
            /-\s*INFINITY|__int_as_float\(\s*0xff800000\s*\)/i,
            /==\s*-\s*INFINITY|isinf\(|\b(sum|denom|total|den|z|s)\s*(==|<=|!=|>)\s*0\b|>\s*0\.?f?\s*\?|==\s*0\.?f?\s*\?/,
          ],
        },
      },
    },
    {
      id: 'self-test',
      title: 'The host launches, copies back after the kernel, compares and times',
      detail:
        'The `LAUNCH` of `softmax_rows` precedes the `cudaMemcpy … cudaMemcpyDeviceToHost`, the run is timed between `cudaEventRecord`s with `cudaEventElapsedTime`, and a correct run prints `PASS`.',
      match: {
        cuda: {
          order: [/LAUNCH\(\s*softmax_rows/, /cudaMemcpy\([^;]*cudaMemcpyDeviceToHost/],
          all: [/cudaEventRecord\(/, /cudaEventElapsedTime\(/, /"PASS/],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// row_softmax.cu — row-wise softmax: one block per row, two block reductions, exp(x - max) so nothing overflows.
//   nvcc -O2 -o row_softmax row_softmax.cu && ./row_softmax
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                \\
    cudaError_t err__ = (call);                                                                       \\
    if (err__ != cudaSuccess) {                                                                       \\
      std::fprintf(stderr, "CUDA error: %s at %s:%d\\n", cudaGetErrorString(err__), __FILE__, __LINE__); \\
      std::exit(1);                                                                                   \\
    }                                                                                                 \\
  } while (0)

// Launch, then surface a configuration error (bad grid, too much shared memory) at the launch site.
#define LAUNCH(kernel, grid, block, ...)          \\
  do {                                            \\
    kernel<<<grid, block>>>(__VA_ARGS__);         \\
    CUDA_CHECK(cudaGetLastError());               \\
  } while (0)

constexpr int THREADS = 256;  // threads per block = per row; a multiple of 32

// y[r][c] = exp(x[r][c] - m_r) / sum_c exp(x[r][c] - m_r), m_r = max_c x[r][c]. One block per row.
__global__ void softmax_rows(const float* __restrict__ x, float* __restrict__ y, int rows, int cols) {
  // TODO: row = blockIdx.x; threads stride the row: c = threadIdx.x; c < cols; c += blockDim.x.
  // TODO: pass 1 — local max from -INFINITY, warp max with fmaxf + __shfl_xor_sync, lane 0 of each warp
  //       into __shared__ memory, __syncthreads, warp 0 reduces the partials, every thread reads m back.
  // TODO: pass 2 — local sum of __expf(x - m), a second block reduction with + through its own shared slots.
  // TODO: a fully masked row (m == -INFINITY, sum == 0) must come out as zeros, not NaN.
  // TODO: pass 3 — y = __expf(x - m) / sum.
}

// ---- self-test: do not change below this line ----------------------------------------------------

// Double-precision reference with the same shift; a masked row is zeros.
static void softmax_rows_cpu(const std::vector<float>& x, std::vector<double>& y, int rows, int cols) {
  for (int r = 0; r < rows; ++r) {
    const float* xr = x.data() + (size_t)r * cols;
    double* yr = y.data() + (size_t)r * cols;
    double m = -INFINITY;
    for (int c = 0; c < cols; ++c) m = std::max(m, (double)xr[c]);
    if (!(m > -INFINITY)) m = 0;
    double acc = 0;
    for (int c = 0; c < cols; ++c) {
      yr[c] = std::exp((double)xr[c] - m);
      acc += yr[c];
    }
    double inv = 0;
    if (acc > 0) inv = 1 / acc;
    for (int c = 0; c < cols; ++c) yr[c] *= inv;
  }
}

int main() {
  const int rows = 4096, cols = 1000;  // cols is not a multiple of THREADS on purpose
  const size_t n = (size_t)rows * cols;
  std::vector<float> h_x(n), h_y(n);
  std::vector<double> ref(n);
  std::srand(0);
  for (size_t i = 0; i < n; ++i) h_x[i] = 6.f * std::rand() / RAND_MAX - 3.f;  // U(-3, 3)
  // Row 0: magnitudes of 1e4 — exp(1e4) is inf in fp32; only exp(x - max) survives.
  for (int c = 0; c < cols; ++c) h_x[c] = 1e4f * (2.f * std::rand() / RAND_MAX - 1.f);
  // Row 1: fully masked, as a padding mask leaves it; must come out as zeros, not NaN.
  std::fill(h_x.begin() + (size_t)1 * cols, h_x.begin() + (size_t)2 * cols, -INFINITY);
  // Row 2: second half masked, as a causal mask leaves it.
  std::fill(h_x.begin() + (size_t)2 * cols + cols / 2, h_x.begin() + (size_t)3 * cols, -INFINITY);

  float *d_x = nullptr, *d_y = nullptr;
  CUDA_CHECK(cudaMalloc(&d_x, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_y, n * sizeof(float)));
  CUDA_CHECK(cudaMemcpy(d_x, h_x.data(), n * sizeof(float), cudaMemcpyHostToDevice));

  LAUNCH(softmax_rows, rows, THREADS, d_x, d_y, rows, cols);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaMemcpy(h_y.data(), d_y, n * sizeof(float), cudaMemcpyDeviceToHost));

  softmax_rows_cpu(h_x, ref, rows, cols);
  double max_err = 0, max_row_err = 0;
  bool nan_seen = false, masked_zero = true;
  for (int r = 0; r < rows; ++r) {
    double row_sum = 0;
    for (int c = 0; c < cols; ++c) {
      const float v = h_y[(size_t)r * cols + c];
      if (std::isnan(v)) nan_seen = true;
      if (r == 1 && v != 0.f) masked_zero = false;
      max_err = std::max(max_err, std::fabs((double)v - ref[(size_t)r * cols + c]));
      row_sum += v;
    }
    if (r != 1) max_row_err = std::max(max_row_err, std::fabs(row_sum - 1.0));
  }

  // Timing: 50 launches between two events, reported as bytes read + written per second.
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  const int iters = 50;
  CUDA_CHECK(cudaEventRecord(t0));
  for (int i = 0; i < iters; ++i) LAUNCH(softmax_rows, rows, THREADS, d_x, d_y, rows, cols);
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  ms /= iters;
  const double gbs = 2.0 * n * sizeof(float) / (ms * 1e-3) / 1e9;

  std::printf("softmax_rows: %d x %d fp32, %d threads per row\\n", rows, cols, THREADS);
  std::printf("max |gpu - cpu| = %.3g   max |row sum - 1| = %.3g   masked row zeros: %s   NaN: %s\\n", max_err,
              max_row_err, masked_zero ? "yes" : "no", nan_seen ? "yes" : "no");
  std::printf("kernel: %.4f ms per launch, %.0f GB/s (read + write)\\n", ms, gbs);
  const bool ok = max_err < 1e-5 && max_row_err < 1e-4 && masked_zero && !nan_seen;
  std::printf(ok ? "PASS\\n" : "FAIL\\n");

  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  CUDA_CHECK(cudaFree(d_x));
  CUDA_CHECK(cudaFree(d_y));
  return ok ? 0 : 1;
}
`,
      solution: `// row_softmax.cu — row-wise softmax: one block per row, two block reductions, exp(x - max) so nothing overflows.
//   nvcc -O2 -o row_softmax row_softmax.cu && ./row_softmax
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                \\
    cudaError_t err__ = (call);                                                                       \\
    if (err__ != cudaSuccess) {                                                                       \\
      std::fprintf(stderr, "CUDA error: %s at %s:%d\\n", cudaGetErrorString(err__), __FILE__, __LINE__); \\
      std::exit(1);                                                                                   \\
    }                                                                                                 \\
  } while (0)

// Launch, then surface a configuration error (bad grid, too much shared memory) at the launch site.
#define LAUNCH(kernel, grid, block, ...)          \\
  do {                                            \\
    kernel<<<grid, block>>>(__VA_ARGS__);         \\
    CUDA_CHECK(cudaGetLastError());               \\
  } while (0)

constexpr int THREADS = 256;  // threads per block = per row; a multiple of 32
constexpr int WARPS = THREADS / 32;

// Butterfly reductions: after five rounds every lane of the warp holds the result.
__device__ __forceinline__ float warp_max(float v) {
  for (int offset = 16; offset > 0; offset >>= 1) v = fmaxf(v, __shfl_xor_sync(0xffffffff, v, offset));
  return v;
}

__device__ __forceinline__ float warp_sum(float v) {
  for (int offset = 16; offset > 0; offset >>= 1) v += __shfl_xor_sync(0xffffffff, v, offset);
  return v;
}

// Block-wide max of one value per thread; every thread receives it. scratch holds WARPS floats.
__device__ float block_max(float v, float* scratch) {
  const int lane = threadIdx.x & 31, warp = threadIdx.x >> 5;
  v = warp_max(v);
  if (lane == 0) scratch[warp] = v;
  __syncthreads();
  if (warp == 0) {
    v = lane < WARPS ? scratch[lane] : -INFINITY;
    v = warp_max(v);
    if (lane == 0) scratch[0] = v;
  }
  __syncthreads();
  return scratch[0];
}

// Same shape with + and identity 0.
__device__ float block_sum(float v, float* scratch) {
  const int lane = threadIdx.x & 31, warp = threadIdx.x >> 5;
  v = warp_sum(v);
  if (lane == 0) scratch[warp] = v;
  __syncthreads();
  if (warp == 0) {
    v = lane < WARPS ? scratch[lane] : 0.f;
    v = warp_sum(v);
    if (lane == 0) scratch[0] = v;
  }
  __syncthreads();
  return scratch[0];
}

// y[r][c] = exp(x[r][c] - m_r) / sum_c exp(x[r][c] - m_r), m_r = max_c x[r][c]. One block per row.
__global__ void softmax_rows(const float* __restrict__ x, float* __restrict__ y, int rows, int cols) {
  __shared__ float s_max[WARPS];
  __shared__ float s_sum[WARPS];  // separate slots: the sum reduction never races the max broadcast
  const int row = blockIdx.x;
  if (row >= rows) return;
  const float* xr = x + (size_t)row * cols;
  float* yr = y + (size_t)row * cols;

  // Pass 1: the row max. Every thread strides the row; consecutive threads read consecutive floats.
  float m = -INFINITY;
  for (int c = threadIdx.x; c < cols; c += blockDim.x) m = fmaxf(m, xr[c]);
  m = block_max(m, s_max);
  if (m == -INFINITY) m = 0.f;  // fully masked row: shift by 0 so exp(-inf - m) is 0, not -inf - (-inf) = NaN

  // Pass 2: the denominator. Every exponent is <= 0, so nothing overflows and sum is in [0, cols].
  float sum = 0.f;
  for (int c = threadIdx.x; c < cols; c += blockDim.x) sum += __expf(xr[c] - m);
  sum = block_sum(sum, s_sum);
  const float inv = sum > 0.f ? 1.f / sum : 0.f;  // masked row: sum == 0; write 0 * 0, not 0 / 0

  // Pass 3: the write. The row is in L1/L2 by now; recomputing __expf is cheaper than spilling registers.
  for (int c = threadIdx.x; c < cols; c += blockDim.x) yr[c] = __expf(xr[c] - m) * inv;
}

// ---- self-test: do not change below this line ----------------------------------------------------

// Double-precision reference with the same shift; a masked row is zeros.
static void softmax_rows_cpu(const std::vector<float>& x, std::vector<double>& y, int rows, int cols) {
  for (int r = 0; r < rows; ++r) {
    const float* xr = x.data() + (size_t)r * cols;
    double* yr = y.data() + (size_t)r * cols;
    double m = -INFINITY;
    for (int c = 0; c < cols; ++c) m = std::max(m, (double)xr[c]);
    if (!(m > -INFINITY)) m = 0;
    double acc = 0;
    for (int c = 0; c < cols; ++c) {
      yr[c] = std::exp((double)xr[c] - m);
      acc += yr[c];
    }
    double inv = 0;
    if (acc > 0) inv = 1 / acc;
    for (int c = 0; c < cols; ++c) yr[c] *= inv;
  }
}

int main() {
  const int rows = 4096, cols = 1000;  // cols is not a multiple of THREADS on purpose
  const size_t n = (size_t)rows * cols;
  std::vector<float> h_x(n), h_y(n);
  std::vector<double> ref(n);
  std::srand(0);
  for (size_t i = 0; i < n; ++i) h_x[i] = 6.f * std::rand() / RAND_MAX - 3.f;  // U(-3, 3)
  // Row 0: magnitudes of 1e4 — exp(1e4) is inf in fp32; only exp(x - max) survives.
  for (int c = 0; c < cols; ++c) h_x[c] = 1e4f * (2.f * std::rand() / RAND_MAX - 1.f);
  // Row 1: fully masked, as a padding mask leaves it; must come out as zeros, not NaN.
  std::fill(h_x.begin() + (size_t)1 * cols, h_x.begin() + (size_t)2 * cols, -INFINITY);
  // Row 2: second half masked, as a causal mask leaves it.
  std::fill(h_x.begin() + (size_t)2 * cols + cols / 2, h_x.begin() + (size_t)3 * cols, -INFINITY);

  float *d_x = nullptr, *d_y = nullptr;
  CUDA_CHECK(cudaMalloc(&d_x, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_y, n * sizeof(float)));
  CUDA_CHECK(cudaMemcpy(d_x, h_x.data(), n * sizeof(float), cudaMemcpyHostToDevice));

  LAUNCH(softmax_rows, rows, THREADS, d_x, d_y, rows, cols);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaMemcpy(h_y.data(), d_y, n * sizeof(float), cudaMemcpyDeviceToHost));

  softmax_rows_cpu(h_x, ref, rows, cols);
  double max_err = 0, max_row_err = 0;
  bool nan_seen = false, masked_zero = true;
  for (int r = 0; r < rows; ++r) {
    double row_sum = 0;
    for (int c = 0; c < cols; ++c) {
      const float v = h_y[(size_t)r * cols + c];
      if (std::isnan(v)) nan_seen = true;
      if (r == 1 && v != 0.f) masked_zero = false;
      max_err = std::max(max_err, std::fabs((double)v - ref[(size_t)r * cols + c]));
      row_sum += v;
    }
    if (r != 1) max_row_err = std::max(max_row_err, std::fabs(row_sum - 1.0));
  }

  // Timing: 50 launches between two events, reported as bytes read + written per second.
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  const int iters = 50;
  CUDA_CHECK(cudaEventRecord(t0));
  for (int i = 0; i < iters; ++i) LAUNCH(softmax_rows, rows, THREADS, d_x, d_y, rows, cols);
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  ms /= iters;
  const double gbs = 2.0 * n * sizeof(float) / (ms * 1e-3) / 1e9;

  std::printf("softmax_rows: %d x %d fp32, %d threads per row\\n", rows, cols, THREADS);
  std::printf("max |gpu - cpu| = %.3g   max |row sum - 1| = %.3g   masked row zeros: %s   NaN: %s\\n", max_err,
              max_row_err, masked_zero ? "yes" : "no", nan_seen ? "yes" : "no");
  std::printf("kernel: %.4f ms per launch, %.0f GB/s (read + write)\\n", ms, gbs);
  const bool ok = max_err < 1e-5 && max_row_err < 1e-4 && masked_zero && !nan_seen;
  std::printf(ok ? "PASS\\n" : "FAIL\\n");

  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  CUDA_CHECK(cudaFree(d_x));
  CUDA_CHECK(cudaFree(d_y));
  return ok ? 0 : 1;
}
`,
    },
  },
  debrief: `Softmax is two reductions and a map, and the whole design follows from the order they must run in. \`exp(x)\` overflows fp32 at \`x > 88.7\`, and attention logits, output-head logits and loss inputs routinely exceed that; \`exp(x − m) / Σ exp(x − m)\` is algebraically the same number with its largest exponent pinned at \`0\`, so the max has to be known before the first \`exp\` can be taken — pass 1 is the max, pass 2 the sum, pass 3 the write. **One block per row** makes each reduction a block reduction with no global atomics and no second launch: the threads of the block stride the row so consecutive threads read consecutive floats (coalesced), the first five rounds of each reduction stay in registers through \`__shfl_xor_sync\` — a butterfly, so every lane ends with the result and lane 0 needs no extra exchange — and the eight warp partials cross through shared memory with a \`__syncthreads()\` on each side. The two reductions get **separate shared slots** because the sum's first write would otherwise race the max's last read; the alternative is a third barrier. Reading the row three times costs almost nothing: 4 KB per row sits in L1/L2 after pass 1, so the kernel moves 8 bytes per element through HBM and runs at memory bandwidth. The **masked row** is the edge every attention kernel meets — a padding mask sets a whole row to \`-inf\`, \`fmaxf\` gives \`m = -inf\`, and \`-inf − (-inf)\` is NaN — so the kernel shifts by \`0\` instead and writes \`0 × 0\` rather than \`0 / 0\`. \`__expf\` is the SFU's \`ex2.approx\` with a multiply, a few ulp off \`expf\` but five times cheaper; the self-test's \`1e-5\` tolerance is loose enough for it. PyTorch's \`torch.softmax\` runs this shape (\`cunn_SoftMaxForward\`) for wide rows and a **persistent** variant for \`dim ≤ 1024\` that keeps the row in registers across all three passes; Triton's fused-softmax tutorial is the same kernel in a dozen lines. FlashAttention never materialises the row at all: the **online softmax** of Milakov and Gimelshein keeps a running max and rescales the running sum by \`exp(m_old − m_new)\` each time the max moves, folding both reductions into one pass over the tiles of \`QKᵀ\`.`,
};
