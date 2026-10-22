import type {Step} from '@/lib/types';

export const fusedGeluStep: Step = {
  id: 'fused-gelu',
  title: 'gelu_bias_kernel: bias + GELU in one pass, sixteen bytes at a time',
  concept: 'cuda',
  file: 'fused_gelu',
  focus: ['fused', 'x', 'bias', 'thread', 'v', 'r', 'y'],
  task: `## Task

Implement \`y[i] = gelu(x[i] + bias[i % cols])\` for \`0 ≤ i < n\` as one fused, vectorised kernel plus a
scalar tail, with the **tanh approximation** of GELU that GPT-2 and BERT use.

- \`__device__ __forceinline__ float gelu_tanh(float v)\`:
  \`0.5f * v * (1.0f + tanhf(0.79788456f * (v + 0.044715f * v * v * v)))\`. Single precision, \`tanhf\` — not
  \`tanh\`, not \`erff\`.
- \`__global__ void gelu_bias_kernel(const float4* __restrict__ x, const float4* __restrict__ bias, float4* __restrict__ y, int n4, int cols4)\`:
  thread \`i = blockIdx.x * blockDim.x + threadIdx.x\` returns when \`i >= n4\`; otherwise **one** \`float4\`
  load of \`x[i]\`, one of \`bias[i % cols4]\`, four \`gelu_tanh\` calls on \`v.x + b.x … v.w + b.w\`, **one**
  \`float4\` store to \`y[i]\`. All three pointers are \`__restrict__\`.
- \`__global__ void gelu_bias_tail_kernel(const float* __restrict__ x, const float* __restrict__ bias, float* __restrict__ y, int start, int n, int cols)\`:
  the scalar version for element \`i = start + blockIdx.x * blockDim.x + threadIdx.x\`, guarded by \`i >= n\`.
- \`void gelu_bias(const float* x, const float* bias, float* y, int n, int cols)\` on the host:
  \`n4 = n / 4\`, launch the vector kernel over \`n4\` threads (256 per block) with the buffers
  \`reinterpret_cast\` to \`float4*\` and \`cols4 = cols / 4\`; then \`tail = n % 4\`, and only when it is
  non-zero, \`gelu_bias_tail_kernel<<<1, tail>>>(x, bias, y, 4 * n4, n, cols)\`. \`cudaGetLastError()\` after
  each launch. Precondition: \`cols % 4 == 0\` and \`cudaMalloc\`'d pointers (256-byte aligned).
- Forbidden: a \`gelu_bias_kernel\` that takes \`const float*\` (scalar-only), \`erff\`/\`normcdff\` (the exact
  GELU — different numbers), double-precision math on the device.
- The file ends with \`main()\`: \`n = 4096 × 3072\` (GPT-2 small's MLP activation, no tail) timed over 20
  launches between \`cudaEvent\`s and reported in GB/s as \`8 × n\` bytes per launch, then \`n = 1 000 003\`
  (a tail of 3); both compared against a double-precision CPU reference with **max abs error < 1e-5**;
  prints \`PASS\`.

What one \`float4\` per thread does to a warp's memory requests: compare the contiguous scalar pattern with
the \`float4\` one. Every fetched byte is still used, and each load instruction now moves four times the bytes.

:::widget coalescing

> A GELU is a dozen instructions per element against eight bytes of HBM traffic. The kernel is bound by
> bytes, so the whole design is about touching them once — and sixteen at a time.`,
  hints: [
    'Cast the buffers once on the host: `reinterpret_cast<const float4*>(x)`. `cudaMalloc` memory is 256-byte aligned, so every `float4` index is a legal 16-byte load. With `cols % 4 == 0`, the four lanes of `x[i]` sit in columns `4 · (i % cols4) … + 3` — exactly the four lanes of `bias[i % cols4]`.',
    'Write `gelu_tanh` once as `__device__ __forceinline__ float` and call it four times on `v.x + b.x … v.w + b.w`; build a local `float4 r` and store it with one `y[i] = r`. Use `tanhf`: `tanh` is the double routine, a different and far slower instruction sequence.',
    'On the host: `n4 = n / 4`, `tail = n % 4`. Launch the vector kernel over `n4` threads (256 per block, guard `i >= n4`); then, only `if (tail > 0)`, `gelu_bias_tail_kernel<<<1, tail>>>(x, bias, y, 4 * n4, n, cols)`. Follow each launch with `CUDA_CHECK(cudaGetLastError())`.',
  ],
  checks: [
    {
      id: 'vector-kernel',
      title: 'The main kernel loads and stores float4s',
      detail:
        '`gelu_bias_kernel` takes `const float4*` and reads `x[i]` and `bias[i % cols4]` as whole `float4`s — one 16-byte load each, four elements per thread. A scalar `const float*` kernel issues four times the memory instructions for the same bytes.',
      match: {
        cuda: {
          all: [
            /__global__\s+void\s+gelu_bias_kernel\s*\(\s*const\s+float4\s*\*/,
            /float4\s+\w+\s*=\s*x\s*\[/,
            /float4\s+\w+\s*=\s*bias\s*\[/,
          ],
          none: [/__global__\s+void\s+gelu_bias_kernel\s*\(\s*const\s+float\s*\*/],
        },
      },
    },
    {
      id: 'four-lanes',
      title: 'Bias is added to all four lanes before the GELU',
      detail:
        'Each of `.x`, `.y`, `.z`, `.w` of the loaded vector gets its own lane of the bias vector added (`v.x + b.x` …) and goes through `gelu_tanh`; the result is assembled into one `float4` and stored once.',
      match: {
        cuda: {
          all: [
            /\.x\s*\+\s*\w+\.x/,
            /\.y\s*\+\s*\w+\.y/,
            /\.z\s*\+\s*\w+\.z/,
            /\.w\s*\+\s*\w+\.w/,
            /y\s*\[\s*\w+\s*\]\s*=\s*\w+\s*;/,
          ],
        },
      },
    },
    {
      id: 'restrict',
      title: 'The pointers are __restrict__',
      detail:
        '`x`, `bias` and `y` are declared `__restrict__` in `gelu_bias_kernel`: the compiler may then assume the store to `y` never aliases the loads and can issue both loads up front and route them through the read-only path.',
      match: {
        cuda: {
          all: [
            /const\s+float4\s*\*\s*__restrict__\s+x\b/,
            /const\s+float4\s*\*\s*__restrict__\s+bias\b/,
            /float4\s*\*\s*__restrict__\s+y\b/,
          ],
        },
      },
    },
    {
      id: 'tanh-formula',
      title: 'GELU is the single-precision tanh approximation',
      detail:
        'The device formula is `0.5f * v * (1.0f + tanhf(0.79788456f * (v + 0.044715f * v³)))` — `tanhf` with the `sqrt(2/π)` and `0.044715` constants as `float` literals. `erff` is the exact GELU (other numbers); `tanh` without the `f` is the double routine.',
      match: {
        cuda: {
          all: [/tanhf\s*\(/, /0\.79788456f/, /0\.044715f/, /0\.5f\s*\*/],
          none: [/\berff?\s*\(/, /\bnormcdff?\s*\(/],
        },
      },
    },
    {
      id: 'bounds',
      title: 'Threads past the end do nothing',
      detail:
        'The last block is partial: the vector kernel returns when `i >= n4` and the tail kernel when `i >= n`. Without the guards the last threads read and write past the buffers — silently, or as an illegal-address error at the next synchronisation.',
      match: {
        cuda: {
          all: [/if\s*\(\s*\w+\s*>=\s*n4\s*\)/, /if\s*\(\s*\w+\s*>=\s*n\s*\)/],
        },
      },
    },
    {
      id: 'vector-launch',
      title: 'The host launches n / 4 vector threads over reinterpret_cast buffers',
      detail:
        "`gelu_bias` computes `n4 = n / 4`, casts the `float*` buffers to `float4*` with `reinterpret_cast` and launches `gelu_bias_kernel` over `n4` threads; a kernel that casts per element or recomputes the split inside is doing the host's job.",
      match: {
        cuda: {
          all: [/n\s*\/\s*4/, /reinterpret_cast\s*<\s*const\s+float4\s*\*\s*>/, /gelu_bias_kernel\s*<<</],
        },
      },
    },
    {
      id: 'tail',
      title: 'The n % 4 remainder is finished by the scalar kernel',
      detail:
        '`tail = n % 4` elements remain after the last full `float4`; `gelu_bias_tail_kernel<<<1, tail>>>` handles them from `start = 4 * n4`, only when there are any. The ragged case in `main` (n = 1 000 003) is wrong or out of bounds without it.',
      match: {
        cuda: {
          all: [
            /__global__\s+void\s+gelu_bias_tail_kernel\s*\(\s*const\s+float\s*\*/,
            /n\s*%\s*4/,
            /gelu_bias_tail_kernel\s*<<</,
          ],
          order: [/gelu_bias_kernel\s*<<</, /gelu_bias_tail_kernel\s*<<</],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// fused_gelu.cu — bias + GELU (tanh approximation) in one pass over float4s.
// nvcc -O2 -o fused_gelu fused_gelu.cu && ./fused_gelu
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                         \\
  do {                                                                                           \\
    cudaError_t err_ = (call);                                                                   \\
    if (err_ != cudaSuccess) {                                                                   \\
      std::fprintf(stderr, "CUDA error %s at %s:%d\\n", cudaGetErrorString(err_), __FILE__, __LINE__); \\
      std::exit(1);                                                                              \\
    }                                                                                            \\
  } while (0)

// GELU, tanh approximation: 0.5 v (1 + tanh(sqrt(2/pi) (v + 0.044715 v^3))). Single precision only.
__device__ __forceinline__ float gelu_tanh(float v) {
  // TODO
  return 0.0f;
}

// One thread per float4: y[i] = gelu(x[i] + bias[i % cols4]), lane by lane. n4 = n / 4, cols4 = cols / 4.
__global__ void gelu_bias_kernel(const float4* __restrict__ x, const float4* __restrict__ bias,
                                 float4* __restrict__ y, int n4, int cols4) {
  // TODO: guard i >= n4, one float4 load of x and of bias, four gelu_tanh, one float4 store
}

// Scalar version for the last n % 4 elements: i runs from start to n.
__global__ void gelu_bias_tail_kernel(const float* __restrict__ x, const float* __restrict__ bias,
                                      float* __restrict__ y, int start, int n, int cols) {
  // TODO
}

// y[i] = gelu(x[i] + bias[i % cols]) for i < n. Requires cols % 4 == 0 and cudaMalloc'd (aligned) pointers.
void gelu_bias(const float* x, const float* bias, float* y, int n, int cols) {
  // TODO: n4 float4s through gelu_bias_kernel (256 threads per block), the remainder through the tail
  // kernel, cudaGetLastError() after each launch
  (void)x;
  (void)bias;
  (void)y;
  (void)n;
  (void)cols;
}

// ---- self-test -------------------------------------------------------------------------------------

static double gelu_ref(double v) {
  return 0.5 * v * (1.0 + std::tanh(0.7978845608028654 * (v + 0.044715 * v * v * v)));
}

// One shape: x ~ U(-3, 3), bias ~ U(-1, 1), launch, compare with the CPU reference, optionally time it.
static bool run_case(int n, int cols, bool timed) {
  std::vector<float> hx(n), hb(cols), hy(n);
  unsigned s = 12345u;
  auto uniform = [&s]() {
    s = s * 1664525u + 1013904223u;
    return (s >> 8) * (1.0f / 16777216.0f);
  };
  for (int i = 0; i < n; i++) hx[i] = 6.0f * uniform() - 3.0f;
  for (int j = 0; j < cols; j++) hb[j] = 2.0f * uniform() - 1.0f;

  float *dx, *db, *dy;
  CUDA_CHECK(cudaMalloc(&dx, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&db, cols * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&dy, n * sizeof(float)));
  CUDA_CHECK(cudaMemcpy(dx, hx.data(), n * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(db, hb.data(), cols * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(dy, 0, n * sizeof(float)));

  gelu_bias(dx, db, dy, n, cols);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaMemcpy(hy.data(), dy, n * sizeof(float), cudaMemcpyDeviceToHost));

  double max_err = 0.0;
  for (int i = 0; i < n; i++) {
    const double ref = gelu_ref((double)hx[i] + (double)hb[i % cols]);
    max_err = std::fmax(max_err, std::fabs(ref - (double)hy[i]));
  }

  if (timed) {
    cudaEvent_t start, stop;
    CUDA_CHECK(cudaEventCreate(&start));
    CUDA_CHECK(cudaEventCreate(&stop));
    const int iters = 20;
    CUDA_CHECK(cudaEventRecord(start));
    for (int it = 0; it < iters; it++) gelu_bias(dx, db, dy, n, cols);
    CUDA_CHECK(cudaEventRecord(stop));
    CUDA_CHECK(cudaEventSynchronize(stop));
    float ms = 0.0f;
    CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
    ms /= iters;
    const double bytes = 2.0 * n * sizeof(float);  // x read once, y written once; bias stays in L2
    std::printf("n=%d cols=%d  %.4f ms  %.1f GB/s  max abs err %.2e\\n", n, cols, ms, bytes / (ms * 1e6), max_err);
    CUDA_CHECK(cudaEventDestroy(start));
    CUDA_CHECK(cudaEventDestroy(stop));
  } else {
    std::printf("n=%d cols=%d  max abs err %.2e\\n", n, cols, max_err);
  }

  CUDA_CHECK(cudaFree(dx));
  CUDA_CHECK(cudaFree(db));
  CUDA_CHECK(cudaFree(dy));
  return max_err < 1e-5;
}

int main() {
  const int cols = 3072;                                // GPT-2 small: 4 * d_model = 4 * 768
  const bool full = run_case(4096 * cols, cols, true);  // 12 582 912 elements, no tail
  const bool ragged = run_case(1000003, cols, false);   // 250 000 float4s and a tail of 3
  if (full && ragged) {
    std::printf("PASS\\n");
    return 0;
  }
  std::printf("FAIL\\n");
  return 1;
}
`,
      solution: `// fused_gelu.cu — bias + GELU (tanh approximation) in one pass over float4s.
// nvcc -O2 -o fused_gelu fused_gelu.cu && ./fused_gelu
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                         \\
  do {                                                                                           \\
    cudaError_t err_ = (call);                                                                   \\
    if (err_ != cudaSuccess) {                                                                   \\
      std::fprintf(stderr, "CUDA error %s at %s:%d\\n", cudaGetErrorString(err_), __FILE__, __LINE__); \\
      std::exit(1);                                                                              \\
    }                                                                                            \\
  } while (0)

// GELU, tanh approximation: 0.5 v (1 + tanh(sqrt(2/pi) (v + 0.044715 v^3))). Single precision only.
__device__ __forceinline__ float gelu_tanh(float v) {
  const float u = 0.79788456f * (v + 0.044715f * v * v * v);
  return 0.5f * v * (1.0f + tanhf(u));
}

// One thread per float4: y[i] = gelu(x[i] + bias[i % cols4]), lane by lane. n4 = n / 4, cols4 = cols / 4.
// cols % 4 == 0 puts the four lanes of x[i] in columns 4 * (i % cols4) .. + 3 — the four lanes of one bias float4.
__global__ void gelu_bias_kernel(const float4* __restrict__ x, const float4* __restrict__ bias,
                                 float4* __restrict__ y, int n4, int cols4) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n4) return;
  const float4 v = x[i];              // one 16-byte load
  const float4 b = bias[i % cols4];   // 12 KB of bias: served from L1/L2
  float4 r;
  r.x = gelu_tanh(v.x + b.x);
  r.y = gelu_tanh(v.y + b.y);
  r.z = gelu_tanh(v.z + b.z);
  r.w = gelu_tanh(v.w + b.w);
  y[i] = r;                           // one 16-byte store
}

// Scalar version for the last n % 4 elements: i runs from start to n.
__global__ void gelu_bias_tail_kernel(const float* __restrict__ x, const float* __restrict__ bias,
                                      float* __restrict__ y, int start, int n, int cols) {
  const int i = start + blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  y[i] = gelu_tanh(x[i] + bias[i % cols]);
}

// y[i] = gelu(x[i] + bias[i % cols]) for i < n. Requires cols % 4 == 0 and cudaMalloc'd (aligned) pointers.
void gelu_bias(const float* x, const float* bias, float* y, int n, int cols) {
  const int n4 = n / 4;
  const int tail = n % 4;
  const int threads = 256;
  if (n4 > 0) {
    const int blocks = (n4 + threads - 1) / threads;
    gelu_bias_kernel<<<blocks, threads>>>(reinterpret_cast<const float4*>(x),
                                          reinterpret_cast<const float4*>(bias),
                                          reinterpret_cast<float4*>(y), n4, cols / 4);
    CUDA_CHECK(cudaGetLastError());
  }
  if (tail > 0) {
    gelu_bias_tail_kernel<<<1, tail>>>(x, bias, y, 4 * n4, n, cols);
    CUDA_CHECK(cudaGetLastError());
  }
}

// ---- self-test -------------------------------------------------------------------------------------

static double gelu_ref(double v) {
  return 0.5 * v * (1.0 + std::tanh(0.7978845608028654 * (v + 0.044715 * v * v * v)));
}

// One shape: x ~ U(-3, 3), bias ~ U(-1, 1), launch, compare with the CPU reference, optionally time it.
static bool run_case(int n, int cols, bool timed) {
  std::vector<float> hx(n), hb(cols), hy(n);
  unsigned s = 12345u;
  auto uniform = [&s]() {
    s = s * 1664525u + 1013904223u;
    return (s >> 8) * (1.0f / 16777216.0f);
  };
  for (int i = 0; i < n; i++) hx[i] = 6.0f * uniform() - 3.0f;
  for (int j = 0; j < cols; j++) hb[j] = 2.0f * uniform() - 1.0f;

  float *dx, *db, *dy;
  CUDA_CHECK(cudaMalloc(&dx, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&db, cols * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&dy, n * sizeof(float)));
  CUDA_CHECK(cudaMemcpy(dx, hx.data(), n * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(db, hb.data(), cols * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(dy, 0, n * sizeof(float)));

  gelu_bias(dx, db, dy, n, cols);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaMemcpy(hy.data(), dy, n * sizeof(float), cudaMemcpyDeviceToHost));

  double max_err = 0.0;
  for (int i = 0; i < n; i++) {
    const double ref = gelu_ref((double)hx[i] + (double)hb[i % cols]);
    max_err = std::fmax(max_err, std::fabs(ref - (double)hy[i]));
  }

  if (timed) {
    cudaEvent_t start, stop;
    CUDA_CHECK(cudaEventCreate(&start));
    CUDA_CHECK(cudaEventCreate(&stop));
    const int iters = 20;
    CUDA_CHECK(cudaEventRecord(start));
    for (int it = 0; it < iters; it++) gelu_bias(dx, db, dy, n, cols);
    CUDA_CHECK(cudaEventRecord(stop));
    CUDA_CHECK(cudaEventSynchronize(stop));
    float ms = 0.0f;
    CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
    ms /= iters;
    const double bytes = 2.0 * n * sizeof(float);  // x read once, y written once; bias stays in L2
    std::printf("n=%d cols=%d  %.4f ms  %.1f GB/s  max abs err %.2e\\n", n, cols, ms, bytes / (ms * 1e6), max_err);
    CUDA_CHECK(cudaEventDestroy(start));
    CUDA_CHECK(cudaEventDestroy(stop));
  } else {
    std::printf("n=%d cols=%d  max abs err %.2e\\n", n, cols, max_err);
  }

  CUDA_CHECK(cudaFree(dx));
  CUDA_CHECK(cudaFree(db));
  CUDA_CHECK(cudaFree(dy));
  return max_err < 1e-5;
}

int main() {
  const int cols = 3072;                                // GPT-2 small: 4 * d_model = 4 * 768
  const bool full = run_case(4096 * cols, cols, true);  // 12 582 912 elements, no tail
  const bool ragged = run_case(1000003, cols, false);   // 250 000 float4s and a tail of 3
  if (full && ragged) {
    std::printf("PASS\\n");
    return 0;
  }
  std::printf("FAIL\\n");
  return 1;
}
`,
    },
  },
  debrief: `The kernel is shaped by one number: its arithmetic intensity. Per element it reads four bytes, writes four, and spends a dozen instructions on \`tanhf\` and a few multiplies — far below the flop-per-byte ratio at which a GPU stops waiting on memory, so the only lever is bytes. **Fusing** the bias add into the GELU removes a whole round trip of the activation through HBM: eager PyTorch's \`x + b\` then \`F.gelu(...)\` reads and writes the 48 MiB tensor twice, this kernel once. **Vectorising** does not change the byte count but changes how it is requested: one \`LDG.E.128\` per thread instead of four \`LDG.E.32\`, four elements of work per load instruction, more bytes in flight per warp, fewer instructions to issue — the difference between a kernel that approaches HBM bandwidth and one that sits at a fraction of it. The price is alignment: \`reinterpret_cast<float4*>\` is only legal because \`cudaMalloc\` hands back 256-byte-aligned memory, and the \`n % 4\` tail is the honest way to vectorise a buffer whose length is not a multiple of four — the aligned prefix goes wide, the last one to three floats go scalar. \`__restrict__\` tells the compiler the store to \`y\` cannot alias the loads, so both loads can be issued before any arithmetic and \`x\`/\`bias\` can go through the read-only data path. The CPU reference runs in double with the long form of \`sqrt(2/π)\`; the max abs error is set by \`tanhf\`'s few ulps and the float rounding of the cubic, well inside 1e-5. Production stacks move this epilogue into the GEMM itself — cuBLASLt's \`CUBLASLT_EPILOGUE_GELU_BIAS\`, CUTLASS epilogue functors, Triton's fused \`matmul + gelu\` — so the activation is never written un-GELU'd at all; \`torch.compile\` generates exactly this kind of vectorised, fused elementwise kernel for whatever chain of pointwise ops it finds; and on Turing and later a hardware \`tanh.approx.f32\` (MUFU) is available through inline PTX when the last ulp does not matter.`,
};
