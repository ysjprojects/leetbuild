import type {Step} from '@/lib/types';

/** A runtime call that is not wrapped in CUDA_CHECK: the error it returns is silently dropped. */
const UNCHECKED_CALL = /(?<!CUDA_CHECK\s*\(\s*)\bcuda(Malloc|Memcpy|Free|DeviceSynchronize|GetLastError|Event\w+)\s*\(/;

export const vectorAddStep: Step = {
  id: 'vector-add',
  title: 'vector_add: grid-stride loop, checked launch, timed, compared',
  concept: 'cuda',
  file: 'vector_add',
  focus: ['h-ab', 'grid', 'block0', 'd-ab', 'd-c', 'h-c', 'lanes', 'r-c'],
  task: `## Task

Write \`vector_add.cu\`: a kernel \`__global__ void vector_add(const float* a, const float* b, float* c, int n)\`
computing \`c[i] = a[i] + b[i]\` for every \`i < n\`, the host code around it, and the self-test that proves it.

- **Grid-stride loop.** Each thread starts at \`blockIdx.x * blockDim.x + threadIdx.x\` and advances by
  \`gridDim.x * blockDim.x\` in a \`for\` loop bounded by \`n\`. No thread touches \`c[n]\` or beyond; a grid
  smaller than \`n / blockDim.x\` still covers every element. A kernel that writes \`c[idx]\` once per thread
  without looking at \`n\` is wrong on both counts.
- **\`CUDA_CHECK(call)\`.** A macro that stores the \`cudaError_t\`, and when it is not \`cudaSuccess\` prints
  \`cudaGetErrorString\` with \`__FILE__\` and \`__LINE__\` to \`stderr\` and \`exit\`s with a failure code.
  **Every** runtime call goes through it: \`cudaMalloc\`, \`cudaMemcpy\`, \`cudaFree\`, \`cudaDeviceSynchronize\`,
  \`cudaGetLastError\`, the event calls. A bare \`cudaMemcpy(...)\` statement drops its return value.
- **\`launch_vector_add(d_a, d_b, d_c, n)\`.** With \`constexpr int BLOCK_SIZE = 256\` and
  \`constexpr int MAX_BLOCKS = 1024\`: \`blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE\`, capped at \`MAX_BLOCKS\`
  (and at least 1), then \`vector_add<<<blocks, BLOCK_SIZE>>>(...)\` followed by \`CUDA_CHECK(cudaGetLastError())\`.
  A launch returns no error code; that call is where a bad configuration shows up.
- **\`run_vector_add(h_a, h_b, h_c, n)\` → ms per launch.** \`cudaMalloc\` three device buffers, \`cudaMemcpy\`
  \`a\` and \`b\` host→device, one warm-up launch, \`cudaDeviceSynchronize\`, then \`cudaEventRecord(start)\`,
  \`ITERS = 20\` launches, \`cudaEventRecord(stop)\`, \`cudaEventSynchronize(stop)\`, \`cudaEventElapsedTime\`.
  **\`cudaDeviceSynchronize\` before** the \`cudaMemcpy\` of \`c\` device→host, then \`cudaFree\` all three and
  destroy the events.
- **Self-test in \`main\`.** \`n = (1 << 22) + 37\` (not a multiple of 256, more than
  \`MAX_BLOCKS × BLOCK_SIZE\`), \`h_a[i] = 0.001f · (i mod 1000)\`, \`h_b[i] = 1 − 0.0005f · (i mod 2000)\`, a CPU
  reference \`h_ref[i] = h_a[i] + h_b[i]\`, the max abs error over all \`n\` (must be \`≤ 1e-6\`; a float add is
  the same on both sides, so it is 0), a line with ms per launch and GB/s (\`3 · n · 4\` bytes per launch), and
  \`PASS\`, or \`FAIL\` and exit code 1.
- No Thrust, no cuBLAS, no unified memory: the point is the plain runtime API.

Who handles which element, on a small array: with fewer blocks than \`⌈n / block⌉\` the loop takes extra
passes, and the last pass stops at the bounds.

:::widget cuda-grid {"n": 50, "block": 8}

> A grid is a finite resource and \`n\` is not: the loop, not the grid, covers the data, and every call
> that can fail is checked at the line where it failed.`,
  hints: [
    'The kernel is four lines: `int start = blockIdx.x * blockDim.x + threadIdx.x; int stride = gridDim.x * blockDim.x; for (int i = start; i < n; i += stride) c[i] = a[i] + b[i];`. With 1024 × 256 = 262,144 threads and n = 4,194,341, each thread does 16 or 17 elements.',
    'The macro is a `do { cudaError_t err_ = (call); if (err_ != cudaSuccess) { fprintf(stderr, "... %s:%d: %s\\n", __FILE__, __LINE__, cudaGetErrorString(err_)); exit(EXIT_FAILURE); } } while (0)`, every line of it ending in a backslash. A kernel launch is a statement, not a call: check it with `CUDA_CHECK(cudaGetLastError())` on the next line.',
    'Timing: `cudaEventRecord(start)` goes on the stream before the launches and `cudaEventRecord(stop)` after; `cudaEventSynchronize(stop)` waits, `cudaEventElapsedTime(&ms, start, stop)` reads milliseconds. Divide by ITERS. Warm up with one unmeasured launch first or the first number includes module loading.',
  ],
  checks: [
    {
      id: 'grid-stride-loop',
      title: 'Each thread starts at its global index and strides by the grid',
      detail:
        'The kernel computes `blockIdx.x * blockDim.x + threadIdx.x`, strides by `gridDim.x * blockDim.x`, and loops `for (i = start; i < n; i += stride)`. With 1024 blocks of 256 and n = 4,194,341 every element is covered exactly once because the loop, not the grid, covers n.',
      match: {
        cuda: {
          all: [
            /blockIdx\.x\s*\*\s*blockDim\.x\s*\+\s*threadIdx\.x/,
            /gridDim\.x\s*\*\s*blockDim\.x|blockDim\.x\s*\*\s*gridDim\.x/,
            /for\s*\([^;]*;[^;]*<\s*n\b[^;]*;\s*\w+\s*\+=\s*[^)]+\)/,
          ],
        },
      },
    },
    {
      id: 'bounds-check',
      title: 'No thread writes past n',
      detail:
        'The kernel body compares its index with `n` before touching memory. A one-thread-per-element kernel that writes `c[blockIdx.x * blockDim.x + threadIdx.x]` unconditionally writes 219 floats past the end when n = 4,194,341 is padded to 4,194,560 threads (an illegal address or silent corruption), and leaves everything from `c[262,144]` on unwritten when the grid is capped.',
      match: {
        cuda: {
          all: [/__global__\s+void\s+vector_add\s*\([^)]*\)\s*\{[^}]*\b\w+\s*<\s*n\b/],
          none: [/c\[\s*blockIdx\.x\s*\*\s*blockDim\.x\s*\+\s*threadIdx\.x\s*\]/, /c\[\s*threadIdx\.x\s*\]/],
        },
      },
    },
    {
      id: 'error-macro',
      title: 'CUDA_CHECK names the failing line and stops',
      detail:
        'A `#define CUDA_CHECK(call)` that keeps the `cudaError_t`, compares it with `cudaSuccess`, prints `cudaGetErrorString` with `__FILE__` and `__LINE__`, and `exit`s. Without it a failed `cudaMalloc` leaves a null pointer that the kernel dereferences several calls later, far from the cause.',
      match: {
        cuda: {
          all: [
            /#define\s+CUDA_CHECK\s*\(\s*\w+\s*\)/,
            /!=\s*cudaSuccess|cudaSuccess\s*!=/,
            /cudaGetErrorString\s*\(/,
            /__FILE__/,
            /__LINE__/,
            /\bexit\s*\(/,
          ],
        },
      },
    },
    {
      id: 'every-call-checked',
      title: 'Every runtime call goes through CUDA_CHECK',
      detail:
        '`cudaMalloc`, `cudaMemcpy`, `cudaFree`, `cudaDeviceSynchronize`, `cudaGetLastError` and the event calls are all wrapped; a bare `cudaMemcpy(...)` statement discards the `cudaError_t` it returns and the program carries on with garbage.',
      match: {
        cuda: {
          all: [
            /CUDA_CHECK\s*\(\s*cudaMalloc\s*\(/,
            /CUDA_CHECK\s*\(\s*cudaMemcpy\s*\(/,
            /CUDA_CHECK\s*\(\s*cudaFree\s*\(/,
            /CUDA_CHECK\s*\(\s*cudaDeviceSynchronize\s*\(/,
          ],
          none: [UNCHECKED_CALL],
        },
      },
    },
    {
      id: 'launch-checked',
      title: 'cudaGetLastError right after the launch',
      detail:
        'A `<<<...>>>` launch returns nothing; a block of 2048 threads or a grid of 0 blocks is reported by `cudaGetLastError()` on the next line. Expected `CUDA_CHECK(cudaGetLastError())` after the launch statement: not before, and not only at the end of the program.',
      match: {
        cuda: {
          all: [/CUDA_CHECK\s*\(\s*cudaGetLastError\s*\(\s*\)\s*\)/],
          order: [/<<<[^>]*>>>/, /cudaGetLastError\s*\(/],
        },
      },
    },
    {
      id: 'launch-geometry',
      title: 'Blocks computed from n with a ceiling division, capped at MAX_BLOCKS',
      detail:
        '`BLOCK_SIZE = 256`, `blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE` capped at `MAX_BLOCKS = 1024`, and the launch uses `<<<blocks, BLOCK_SIZE>>>`. `n / BLOCK_SIZE` drops the last partial block; an uncapped grid of 16,385 blocks works here but ties the grid to the data again and makes the loop pointless.',
      match: {
        cuda: {
          all: [
            /BLOCK_SIZE\s*=\s*256\b/,
            /MAX_BLOCKS\s*=\s*1024\b/,
            /\(\s*n\s*\+\s*BLOCK_SIZE\s*-\s*1\s*\)\s*\/\s*BLOCK_SIZE/,
            /<<<\s*\w+\s*,\s*BLOCK_SIZE\s*>>>/,
          ],
        },
      },
    },
    {
      id: 'sync-before-read',
      title: 'Inputs copied in before the launch, device synchronised before c is read back',
      detail:
        '`cudaMemcpy` host→device, then `launch_vector_add`, then `cudaDeviceSynchronize()`, then `cudaMemcpy` device→host. The synchronise is also where an execution error (an illegal address inside the kernel) surfaces; `cudaGetLastError` after the launch only sees configuration errors.',
      match: {
        cuda: {
          order: [
            /cudaMemcpyHostToDevice/,
            /launch_vector_add\s*\(/,
            /cudaDeviceSynchronize\s*\(/,
            /cudaMemcpyDeviceToHost/,
          ],
        },
      },
    },
    {
      id: 'events-timing',
      title: 'Launches timed with cudaEvents, start before and stop after',
      detail:
        'Two `cudaEvent_t`s created, `cudaEventRecord(start)` before the timed launches, `cudaEventRecord(stop)` after, `cudaEventSynchronize(stop)`, `cudaEventElapsedTime`. Events are recorded on the stream, so the interval is GPU time between the two markers, not host wall-clock around an asynchronous launch.',
      match: {
        cuda: {
          all: [/cudaEventCreate\s*\(/, /cudaEventSynchronize\s*\(/, /cudaEventElapsedTime\s*\(/],
          order: [
            /cudaEventRecord\s*\(\s*start\b/,
            /launch_vector_add\s*\(/,
            /cudaEventRecord\s*\(\s*stop\b/,
            /cudaEventElapsedTime\s*\(/,
          ],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// vector_add.cu, the smallest complete CUDA program: launch geometry, a grid-stride loop,
// checked API calls, a timed launch and a CPU reference.
//   nvcc -O2 -o vector_add vector_add.cu && ./vector_add
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

// TODO: on a cudaError_t other than cudaSuccess, print cudaGetErrorString with the file and line
// to stderr and exit(EXIT_FAILURE). Every runtime call below goes through this macro.
#define CUDA_CHECK(call) (call)

constexpr int BLOCK_SIZE = 256;   // threads per block: 8 warps
constexpr int MAX_BLOCKS = 1024;  // grid cap: beyond it the loop, not the grid, covers n
constexpr int ITERS = 20;         // timed launches

/** c[i] = a[i] + b[i] for i < n. */
__global__ void vector_add(const float* a, const float* b, float* c, int n) {
  // TODO: start at blockIdx.x * blockDim.x + threadIdx.x, stride by gridDim.x * blockDim.x, stop at n.
}

/** Blocks from n, capped at MAX_BLOCKS; launches; checks the launch. */
void launch_vector_add(const float* d_a, const float* d_b, float* d_c, int n) {
  // TODO: blocks = ceil(n / BLOCK_SIZE) capped at MAX_BLOCKS (at least 1);
  // vector_add<<<blocks, BLOCK_SIZE>>>(...); CUDA_CHECK(cudaGetLastError()).
  (void)d_a;
  (void)d_b;
  (void)d_c;
  (void)n;
}

/** Allocate, copy in, launch (warm-up, then ITERS timed), synchronise, copy out, free. Returns ms per launch. */
float run_vector_add(const float* h_a, const float* h_b, float* h_c, int n) {
  // TODO: cudaMalloc d_a, d_b, d_c; cudaMemcpy a and b host→device; create two cudaEvents;
  // one warm-up launch and cudaDeviceSynchronize; cudaEventRecord(start), ITERS launches,
  // cudaEventRecord(stop), cudaEventSynchronize(stop), cudaEventElapsedTime;
  // cudaDeviceSynchronize; cudaMemcpy c device→host; destroy the events; cudaFree all three.
  (void)h_a;
  (void)h_b;
  (void)h_c;
  (void)n;
  return 0.0f;
}

int main() {
  const int n = (1 << 22) + 37;  // 4,194,341: not a multiple of 256, more than MAX_BLOCKS * BLOCK_SIZE
  std::vector<float> h_a(n), h_b(n), h_c(n, 0.0f), h_ref(n);
  for (int i = 0; i < n; ++i) {
    h_a[i] = 0.001f * static_cast<float>(i % 1000);
    h_b[i] = 1.0f - 0.0005f * static_cast<float>(i % 2000);
  }
  for (int i = 0; i < n; ++i) h_ref[i] = h_a[i] + h_b[i];

  const float ms = run_vector_add(h_a.data(), h_b.data(), h_c.data(), n);

  float max_err = 0.0f;
  for (int i = 0; i < n; ++i) max_err = fmaxf(max_err, fabsf(h_c[i] - h_ref[i]));
  const double bytes_moved = 3.0 * n * sizeof(float);
  const double gbps = ms > 0.0f ? bytes_moved / (ms * 1e-3) / 1e9 : 0.0;
  printf("n=%d  %.4f ms/launch  %.1f GB/s  max abs err %.3e\\n", n, ms, gbps, max_err);
  if (max_err > 1e-6f) {
    printf("FAIL\\n");
    return 1;
  }
  printf("PASS\\n");
  return 0;
}
`,
      solution: `// vector_add.cu, the smallest complete CUDA program: launch geometry, a grid-stride loop,
// checked API calls, a timed launch and a CPU reference.
//   nvcc -O2 -o vector_add vector_add.cu && ./vector_add
#include <cuda_runtime.h>

#include <cmath>
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

constexpr int BLOCK_SIZE = 256;   // threads per block: 8 warps
constexpr int MAX_BLOCKS = 1024;  // grid cap: beyond it the loop, not the grid, covers n
constexpr int ITERS = 20;         // timed launches

/** c[i] = a[i] + b[i] for i < n. Every thread starts at its global index and strides by the grid. */
__global__ void vector_add(const float* a, const float* b, float* c, int n) {
  int start = blockIdx.x * blockDim.x + threadIdx.x;
  int stride = gridDim.x * blockDim.x;
  for (int i = start; i < n; i += stride) {
    c[i] = a[i] + b[i];
  }
}

/** Blocks from n, capped at MAX_BLOCKS; launches; surfaces a bad configuration right away. */
void launch_vector_add(const float* d_a, const float* d_b, float* d_c, int n) {
  int blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
  if (blocks > MAX_BLOCKS) blocks = MAX_BLOCKS;
  if (blocks < 1) blocks = 1;
  vector_add<<<blocks, BLOCK_SIZE>>>(d_a, d_b, d_c, n);
  CUDA_CHECK(cudaGetLastError());  // a launch has no return value: this is its error code
}

/** Allocate, copy in, launch (warm-up, then ITERS timed), synchronise, copy out, free. Returns ms per launch. */
float run_vector_add(const float* h_a, const float* h_b, float* h_c, int n) {
  const size_t bytes = static_cast<size_t>(n) * sizeof(float);
  float *d_a = nullptr, *d_b = nullptr, *d_c = nullptr;
  CUDA_CHECK(cudaMalloc(&d_a, bytes));
  CUDA_CHECK(cudaMalloc(&d_b, bytes));
  CUDA_CHECK(cudaMalloc(&d_c, bytes));
  CUDA_CHECK(cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_b, h_b, bytes, cudaMemcpyHostToDevice));

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  launch_vector_add(d_a, d_b, d_c, n);  // warm-up: module load and first-launch cost stay out of the timing
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaEventRecord(start));
  for (int it = 0; it < ITERS; ++it) launch_vector_add(d_a, d_b, d_c, n);
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));

  CUDA_CHECK(cudaDeviceSynchronize());  // every launch done; an execution error surfaces here, not later
  CUDA_CHECK(cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost));

  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  CUDA_CHECK(cudaFree(d_a));
  CUDA_CHECK(cudaFree(d_b));
  CUDA_CHECK(cudaFree(d_c));
  return ms / ITERS;
}

int main() {
  const int n = (1 << 22) + 37;  // 4,194,341: not a multiple of 256, more than MAX_BLOCKS * BLOCK_SIZE
  std::vector<float> h_a(n), h_b(n), h_c(n, 0.0f), h_ref(n);
  for (int i = 0; i < n; ++i) {
    h_a[i] = 0.001f * static_cast<float>(i % 1000);
    h_b[i] = 1.0f - 0.0005f * static_cast<float>(i % 2000);
  }
  for (int i = 0; i < n; ++i) h_ref[i] = h_a[i] + h_b[i];

  const float ms = run_vector_add(h_a.data(), h_b.data(), h_c.data(), n);

  float max_err = 0.0f;
  for (int i = 0; i < n; ++i) max_err = fmaxf(max_err, fabsf(h_c[i] - h_ref[i]));
  const double bytes_moved = 3.0 * n * sizeof(float);
  const double gbps = ms > 0.0f ? bytes_moved / (ms * 1e-3) / 1e9 : 0.0;
  printf("n=%d  %.4f ms/launch  %.1f GB/s  max abs err %.3e\\n", n, ms, gbps, max_err);
  if (max_err > 1e-6f) {
    printf("FAIL\\n");
    return 1;
  }
  printf("PASS\\n");
  return 0;
}
`,
    },
  },
  debrief: `Fifty lines of host code around a four-line kernel, and the ratio is honest: the kernel is the easy part. The **grid-stride loop** decouples the grid from the data: a launch of 1024 × 256 threads handles 4 M elements or 37 with the same code and one bounds test per iteration, and the host is free to size the grid from the SM count (a few waves of resident blocks) instead of from \`n / 256\`. **Every call checked** is a discipline, not a style: the runtime API returns \`cudaError_t\` from everything, and a dropped one turns a failed 16 MiB \`cudaMalloc\` into an illegal-address fault three calls later with no line number. The launch itself returns nothing, so \`cudaGetLastError()\` right after it is where a bad block size is reported, while an error *inside* the kernel is asynchronous and surfaces at the next synchronising call: the \`cudaDeviceSynchronize\` before the copy back, which is why that call is checked too and sits before any read of \`c\`. The **timing** uses events because a launch returns to the host before the GPU has started: a wall clock around it measures the launch overhead, not the kernel. The number itself (about 50 MB moved per launch, tens of microseconds on a datacentre GPU, nowhere near its FLOP peak) says vector add is bandwidth-bound, which is the reason frameworks fuse elementwise work into the kernels around it. PyTorch's \`a + b\` is this kernel with vectorised loads and a \`TensorIterator\` that handles strides, broadcasting and dtypes; its launches are followed by \`C10_CUDA_KERNEL_LAUNCH_CHECK()\`, the same \`cudaGetLastError\` under a macro; its caching allocator avoids \`cudaMalloc\` because the call is slow; and \`torch.compile\` and Triton fuse the residual add into the LayerNorm or the GELU so the 16 MiB never makes a round trip to HBM on its own.`,
};
