import type {Step} from '@/lib/types';

/** Everything of the file that is not the tiled kernel: the baseline, the launch geometry, the self-test. */
const HOST = `
typedef void (*MatmulKernel)(const float*, const float*, float*, int, int, int);

// One launch: TILE x TILE threads per block, one block per output tile, rounded up at the edges.
static void launch(MatmulKernel kernel, const float* dA, const float* dB, float* dC, int M, int N, int K) {
  dim3 block(TILE, TILE);
  dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE);
  kernel<<<grid, block>>>(dA, dB, dC, M, N, K);
  CUDA_CHECK(cudaGetLastError());
}

// GFLOP/s over iters back-to-back launches, timed with events on the stream.
static double gflops(MatmulKernel kernel, const float* dA, const float* dB, float* dC, int M, int N, int K, int iters) {
  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  launch(kernel, dA, dB, dC, M, N, K);  // warm-up
  CUDA_CHECK(cudaEventRecord(start));
  for (int i = 0; i < iters; ++i) launch(kernel, dA, dB, dC, M, N, K);
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  return 2.0 * M * N * K * iters / (ms * 1e-3) / 1e9;
}

// Deterministic uniform values in [-1, 1): an LCG, so every run and every machine sees the same inputs.
static void fill(std::vector<float>& v, unsigned seed) {
  unsigned x = seed;
  for (float& f : v) {
    x = x * 1664525u + 1013904223u;
    f = (float)(x >> 8) / 16777216.0f * 2.0f - 1.0f;
  }
}

static void matmul_cpu(const std::vector<float>& A, const std::vector<float>& B, std::vector<float>& C, int M, int N, int K) {
  for (int i = 0; i < M; ++i)
    for (int j = 0; j < N; ++j) {
      float acc = 0.0f;
      for (int k = 0; k < K; ++k) acc += A[(size_t)i * K + k] * B[(size_t)k * N + j];
      C[(size_t)i * N + j] = acc;
    }
}

// Largest |x - y|; a NaN anywhere is returned as is so that it fails the tolerance test.
static float max_abs_error(const std::vector<float>& x, const std::vector<float>& y) {
  float worst = 0.0f;
  for (size_t i = 0; i < x.size(); ++i) {
    float d = std::fabs(x[i] - y[i]);
    if (std::isnan(d)) return d;
    if (d > worst) worst = d;
  }
  return worst;
}

struct DeviceMatrices {
  float* A;
  float* B;
  float* C;
  size_t c_bytes;
};

static DeviceMatrices upload(const std::vector<float>& hA, const std::vector<float>& hB, size_t c_elems) {
  DeviceMatrices d;
  d.c_bytes = c_elems * sizeof(float);
  CUDA_CHECK(cudaMalloc(&d.A, hA.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d.B, hB.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d.C, d.c_bytes));
  CUDA_CHECK(cudaMemcpy(d.A, hA.data(), hA.size() * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d.B, hB.data(), hB.size() * sizeof(float), cudaMemcpyHostToDevice));
  return d;
}

static void release(DeviceMatrices& d) {
  CUDA_CHECK(cudaFree(d.A));
  CUDA_CHECK(cudaFree(d.B));
  CUDA_CHECK(cudaFree(d.C));
}

// Runs one kernel into a zeroed C and brings the result back.
static void run_and_download(MatmulKernel kernel, DeviceMatrices& d, std::vector<float>& out, int M, int N, int K) {
  CUDA_CHECK(cudaMemset(d.C, 0, d.c_bytes));
  launch(kernel, d.A, d.B, d.C, M, N, K);
  CUDA_CHECK(cudaMemcpy(out.data(), d.C, d.c_bytes, cudaMemcpyDeviceToHost));
}

// Both kernels against the CPU reference on an awkward shape: no dimension is a multiple of TILE.
static bool correctness(int M, int N, int K, float tol) {
  std::vector<float> hA((size_t)M * K), hB((size_t)K * N), ref((size_t)M * N);
  std::vector<float> tiled((size_t)M * N), naive((size_t)M * N);
  fill(hA, 1u);
  fill(hB, 2u);
  matmul_cpu(hA, hB, ref, M, N, K);
  DeviceMatrices d = upload(hA, hB, ref.size());
  run_and_download(matmul_tiled, d, tiled, M, N, K);
  run_and_download(matmul_naive, d, naive, M, N, K);
  release(d);
  float err_tiled = max_abs_error(tiled, ref);
  float err_naive = max_abs_error(naive, ref);
  std::printf("correctness %dx%dx%d: tiled max|err| %.1e  naive max|err| %.1e  (tol %.0e)\\n", M, N, K, err_tiled,
              err_naive, tol);
  return err_tiled < tol && err_naive < tol;
}

// n x n x n: GFLOP/s of both kernels, and the tiled result checked against the naive one.
static bool bench(int n, int iters, float tol) {
  std::vector<float> hA((size_t)n * n), hB((size_t)n * n);
  std::vector<float> tiled((size_t)n * n), naive((size_t)n * n);
  fill(hA, 3u);
  fill(hB, 4u);
  DeviceMatrices d = upload(hA, hB, tiled.size());
  double naive_gflops = gflops(matmul_naive, d.A, d.B, d.C, n, n, n, iters);
  run_and_download(matmul_naive, d, naive, n, n, n);
  double tiled_gflops = gflops(matmul_tiled, d.A, d.B, d.C, n, n, n, iters);
  run_and_download(matmul_tiled, d, tiled, n, n, n);
  release(d);
  float diff = max_abs_error(tiled, naive);
  std::printf("bench %dx%dx%d: naive %.1f GFLOP/s  tiled %.1f GFLOP/s (%.1fx)  max|tiled - naive| %.1e\\n", n, n, n,
              naive_gflops, tiled_gflops, tiled_gflops / naive_gflops, diff);
  return diff < tol;
}

int main() {
  bool ok = correctness(97, 75, 131, 1e-3f);
  ok = bench(1024, 20, 1e-2f) && ok;
  std::printf("%s\\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
`;

const PREAMBLE = `// Tiled matrix multiply: C[M x N] = A[M x K] * B[K x N], row-major float32, one block per 32 x 32 output tile.
// Build and run:  nvcc -O2 -o tiled_matmul tiled_matmul.cu && ./tiled_matmul
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                 \\
    cudaError_t err_ = (call);                                                                         \\
    if (err_ != cudaSuccess) {                                                                         \\
      std::fprintf(stderr, "%s:%d: %s failed: %s\\n", __FILE__, __LINE__, #call, cudaGetErrorString(err_)); \\
      std::exit(EXIT_FAILURE);                                                                         \\
    }                                                                                                  \\
  } while (0)

constexpr int TILE = 32;

// Baseline: one thread per output, every multiply-add fetches both operands from global memory.
__global__ void matmul_naive(const float* A, const float* B, float* C, int M, int N, int K) {
  int row = blockIdx.y * blockDim.y + threadIdx.y;
  int col = blockIdx.x * blockDim.x + threadIdx.x;
  if (row >= M || col >= N) return;
  float acc = 0.0f;
  for (int k = 0; k < K; ++k) acc += A[row * K + k] * B[k * N + col];
  C[row * N + col] = acc;
}
`;

export const tiledMatmulStep: Step = {
  id: 'tiled-matmul',
  title: 'matmul_tiled: 32 × 32 shared tiles, two barriers per slab of K',
  concept: 'cuda',
  file: 'tiled_matmul',
  focus: ['mat-a', 'mat-b', 'as', 'bs', 'acc', 'mat-c', 'sync1', 'sync2'],
  task: `## Task

Implement \`__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K)\`:
\`C = A · B\` for row-major float32 \`A[M×K]\`, \`B[K×N]\`, \`C[M×N]\`, one thread per output element,
\`constexpr int TILE = 32\`. The host (\`launch\`, the timing, the CPU reference, \`main\`) and the baseline
\`matmul_naive\` are given; only the kernel body is missing.

- **Geometry.** \`dim3 block(TILE, TILE)\` and \`dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE)\`:
  \`x\` runs along columns, \`y\` along rows. In the kernel \`tx = threadIdx.x\`, \`ty = threadIdx.y\`,
  \`row = blockIdx.y * TILE + ty\`, \`col = blockIdx.x * TILE + tx\`.
- **Tiles.** \`__shared__ float As[TILE][TILE]\` and \`__shared__ float Bs[TILE][TILE]\`; 8 KB per block.
- **Slab loop.** \`for (int t = 0; t < (K + TILE - 1) / TILE; ++t)\`. Each thread loads **one** element
  of each operand into its own slot \`[ty][tx]\`, zero outside the matrices:
  \`As[ty][tx] = (row < M && a_col < K) ? A[row * K + a_col] : 0.0f\` with \`a_col = t * TILE + tx\`, and
  \`Bs[ty][tx] = (b_row < K && col < N) ? B[b_row * N + col] : 0.0f\` with \`b_row = t * TILE + ty\`.
  A warp (fixed \`ty\`, \`tx = 0…31\`) therefore reads 32 consecutive floats of \`A\` and 32 consecutive
  floats of \`B\`: both loads are coalesced.
- **Two barriers.** \`__syncthreads()\` after the loads, then \`acc += As[ty][k] * Bs[k][tx]\` for
  \`k = 0…TILE-1\` from a register accumulator \`float acc = 0.0f\`, then \`__syncthreads()\` again before
  the next slab overwrites the tiles.
- **One store.** After the loop, \`if (row < M && col < N) C[row * N + col] = acc;\`. No early
  \`return\` for out-of-range threads: they load zeros and take part in both barriers like everyone else.
- **Forbidden:** cuBLAS, cuBLASLt, CUTLASS or any library GEMM: the tiles are the point.
- **Self-test** (given): both kernels on \`97 × 75 × 131\` against the CPU reference with max abs error
  \`< 1e-3\`; \`1024³\` timed with \`cudaEvent\`s for 20 iterations, GFLOP/s \`= 2MNK / s\`, tiled and naive
  results within \`1e-2\` of each other; prints \`PASS\`. Build with
  \`nvcc -O2 -o tiled_matmul tiled_matmul.cu && ./tiled_matmul\`.

Step through one output tile below: per slab, the block loads one \`TILE × TILE\` tile of \`A\` and one of \`B\`,
and every float in them feeds \`TILE\` outputs (32 in the drill). The global-load count compares naive against
tiled.

:::widget tiled-matmul

> The naive kernel fetches \`2K\` floats from global memory per output; the tiled one fetches \`2K / TILE\`.
> That 32× cut in global loads is where the speedup comes from, and the two barriers are what make sharing a slab safe.`,
  hints: [
    'Index math first: `row = blockIdx.y * TILE + ty`, `col = blockIdx.x * TILE + tx`; in slab `t` the element this thread fetches of `A` is column `t * TILE + tx` of its own `row`, and of `B` is row `t * TILE + ty` of its own `col`. Both land in the same slot `[ty][tx]` of their tile; a ternary with `0.0f` handles the edges.',
    'Two barriers per slab, not one: the first so nobody multiplies before every thread has written its element, the second so nobody overwrites the tiles for slab `t + 1` while a slower warp is still reading slab `t`. Dropping the second one gives results that are wrong only sometimes.',
    'Keep `acc` in a register and write `C` exactly once, after the loop, guarded by `row < M && col < N`. Threads outside the matrix must still reach every `__syncthreads()` (load zeros, loop, barrier), so there is no early `return` in this kernel.',
  ],
  checks: [
    {
      id: 'shared-tiles',
      title: 'Two 32 × 32 float tiles in shared memory, no library GEMM',
      detail:
        '`constexpr int TILE = 32` and `__shared__ float As[TILE][TILE]`, `__shared__ float Bs[TILE][TILE]` inside the kernel: one slab of `A` and one of `B` staged per block, 8 KB in all. No cuBLAS, cuBLASLt or CUTLASS: the product is computed from these tiles.',
      match: {
        cuda: {
          all: [
            /constexpr\s+int\s+TILE\s*=\s*32\b|#define\s+TILE\s+32\b/,
            /__shared__\s+float\s+As\s*\[\s*TILE\s*\]\s*\[\s*TILE\s*\]/,
            /__shared__\s+float\s+Bs\s*\[\s*TILE\s*\]\s*\[\s*TILE\s*\]/,
          ],
          none: [/cublas/i, /cutlass/i],
        },
      },
    },
    {
      id: 'slab-loop',
      title: 'K is walked in ⌈K / TILE⌉ slabs, one element per thread per operand',
      detail:
        'A loop `for (int t = 0; t < (K + TILE - 1) / TILE; ++t)` (5 slabs for `K = 131`) and per slab the load column `t * TILE + tx` of `A` and the load row `t * TILE + ty` of `B`: every thread fetches exactly one float of each operand per slab, so a block fetches each slab once.',
      match: {
        cuda: {
          all: [
            /for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\(\s*K\s*\+\s*TILE\s*-\s*1\s*\)\s*\/\s*TILE\s*;/,
            /(?<!\.)\b\w+\s*\*\s*TILE\s*\+\s*(?:tx|threadIdx\.x)\b/,
            /(?<!\.)\b\w+\s*\*\s*TILE\s*\+\s*(?:ty|threadIdx\.y)\b/,
          ],
        },
      },
    },
    {
      id: 'zero-padded-loads',
      title: 'Loads are bounds-checked and pad with zeros at the edges',
      detail:
        '`As[ty][tx] = (row < M && a_col < K) ? A[row * K + a_col] : 0.0f` and `Bs[ty][tx] = (b_row < K && col < N) ? B[b_row * N + col] : 0.0f`. On `97 × 75 × 131` the last slab has 3 valid columns of 32 and the corner block 1 valid row; the zeros contribute nothing to the sum, so the product loop needs no branch.',
      match: {
        cuda: {
          all: [
            /As\s*\[\s*(?:ty|threadIdx\.y)\s*\]\s*\[\s*(?:tx|threadIdx\.x)\s*\]\s*=\s*\(\s*row\s*<\s*M\s*&&\s*\w+\s*<\s*K\s*\)\s*\?\s*A\s*\[[^\]]+\]\s*:\s*0\.0f/,
            /Bs\s*\[\s*(?:ty|threadIdx\.y)\s*\]\s*\[\s*(?:tx|threadIdx\.x)\s*\]\s*=\s*\(\s*\w+\s*<\s*K\s*&&\s*col\s*<\s*N\s*\)\s*\?\s*B\s*\[[^\]]+\]\s*:\s*0\.0f/,
          ],
        },
      },
    },
    {
      id: 'two-barriers',
      title: '__syncthreads() after the loads and again after the products',
      detail:
        'Load into `As`/`Bs` → `__syncthreads()` → `acc += As[ty][k] * Bs[k][tx]` over the slab → `__syncthreads()`, in that order. The first barrier makes the whole slab visible before anyone multiplies; the second keeps a fast warp from overwriting the tiles with slab `t + 1` while a slow one still reads slab `t`.',
      match: {
        cuda: {
          order: [
            /As\s*\[[^\]]*\]\s*\[[^\]]*\]\s*=\s*[^=]/,
            /__syncthreads\s*\(\s*\)/,
            /\+=\s*As\s*\[[^\]]*\]\s*\[[^\]]*\]\s*\*\s*Bs\s*\[[^\]]*\]\s*\[[^\]]*\]/,
            /__syncthreads\s*\(\s*\)/,
          ],
        },
      },
    },
    {
      id: 'store-once',
      title: 'Register accumulator, one guarded store, no early return',
      detail:
        '`row = blockIdx.y * TILE + ty`, `col = blockIdx.x * TILE + tx`, and after the loop `if (row < M && col < N) C[row * N + col] = acc;`: `acc` lives in a register and global memory is written once per output. No `return;` before the barriers: an out-of-range thread that skips a `__syncthreads()` its block-mates wait on is undefined behaviour.',
      match: {
        cuda: {
          all: [
            /\brow\s*=\s*blockIdx\.y\s*\*\s*TILE\s*\+\s*(?:ty|threadIdx\.y)\b/,
            /\bcol\s*=\s*blockIdx\.x\s*\*\s*TILE\s*\+\s*(?:tx|threadIdx\.x)\b/,
            /if\s*\(\s*row\s*<\s*M\s*&&\s*col\s*<\s*N\s*\)\s*C\s*\[\s*row\s*\*\s*N\s*\+\s*col\s*\]\s*=\s*acc\s*;/,
          ],
          order: [/__syncthreads\s*\(\s*\)/, /C\s*\[\s*row\s*\*\s*N\s*\+\s*col\s*\]\s*=\s*acc\s*;/],
          none: [/matmul_tiled\s*\([^)]*\)\s*\{[^}]*\breturn\s*;/],
        },
      },
    },
    {
      id: 'grid-geometry',
      title: 'Grid of ⌈N / 32⌉ × ⌈M / 32⌉ blocks of 32 × 32 threads, x along columns',
      detail:
        '`dim3 block(TILE, TILE)`, `dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE)`, launched as `<<<grid, block>>>`, and the kernel indexing with the same `TILE` (`blockIdx.y * TILE`). `97 × 75` gives a 3 × 4 grid of 12 blocks; `x` along columns is what makes consecutive threads read consecutive addresses.',
      match: {
        cuda: {
          all: [
            /dim3\s+block\s*\(\s*TILE\s*,\s*TILE\s*\)/,
            /dim3\s+grid\s*\(\s*\(\s*N\s*\+\s*TILE\s*-\s*1\s*\)\s*\/\s*TILE\s*,\s*\(\s*M\s*\+\s*TILE\s*-\s*1\s*\)\s*\/\s*TILE\s*\)/,
            /<<<\s*grid\s*,\s*block\s*>>>/,
            /blockIdx\.y\s*\*\s*TILE/,
          ],
        },
      },
    },
    {
      id: 'self-test',
      title: 'CPU reference with max abs error, event-timed GFLOP/s, PASS',
      detail:
        'The file ends in a `main()` that compares both kernels against `matmul_cpu` on `97 × 75 × 131` by `max_abs_error`, copies results back with `cudaMemcpyDeviceToHost` after the launches, times `1024³` between `cudaEventRecord`s with `cudaEventElapsedTime`, and prints `PASS`.',
      match: {
        cuda: {
          all: [/cudaEventRecord\s*\(/, /cudaEventElapsedTime\s*\(/, /matmul_cpu\s*\(/, /max_abs_error\s*\(/, /"PASS"/],
          order: [/<<<\s*grid\s*,\s*block\s*>>>/, /cudaMemcpy\s*\([^;]*cudaMemcpyDeviceToHost/],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `${PREAMBLE}
// Tiled: the block walks K in TILE-wide slabs; each slab of A and B is staged in shared memory once
// and read TILE times from there.
__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K) {
  // TODO: __shared__ float As[TILE][TILE], Bs[TILE][TILE]; tx, ty; row = blockIdx.y * TILE + ty,
  //       col = blockIdx.x * TILE + tx; float acc = 0.0f.
  // TODO: for t in 0 .. (K + TILE - 1) / TILE: load A[row][t * TILE + tx] and B[t * TILE + ty][col] into
  //       As[ty][tx] / Bs[ty][tx] (0.0f outside M, K, N); __syncthreads(); acc += As[ty][k] * Bs[k][tx]
  //       for k in 0 .. TILE; __syncthreads().
  // TODO: if (row < M && col < N) C[row * N + col] = acc;
}
${HOST}`,
      solution: `${PREAMBLE}
// Tiled: the block walks K in TILE-wide slabs; each slab of A and B is staged in shared memory once
// and read TILE times from there.
__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K) {
  __shared__ float As[TILE][TILE];
  __shared__ float Bs[TILE][TILE];

  const int tx = threadIdx.x;
  const int ty = threadIdx.y;
  const int row = blockIdx.y * TILE + ty;
  const int col = blockIdx.x * TILE + tx;
  float acc = 0.0f;

  for (int t = 0; t < (K + TILE - 1) / TILE; ++t) {
    // One element of each operand per thread; a warp reads 32 consecutive floats of A and of B.
    const int a_col = t * TILE + tx;
    const int b_row = t * TILE + ty;
    As[ty][tx] = (row < M && a_col < K) ? A[row * K + a_col] : 0.0f;
    Bs[ty][tx] = (b_row < K && col < N) ? B[b_row * N + col] : 0.0f;
    __syncthreads();  // the whole slab is in shared memory before anyone multiplies
#pragma unroll
    for (int k = 0; k < TILE; ++k) acc += As[ty][k] * Bs[k][tx];
    __syncthreads();  // everyone is done with this slab before the next one overwrites it
  }
  if (row < M && col < N) C[row * N + col] = acc;
}
${HOST}`,
    },
  },
  debrief: `The kernel keeps the naive mapping (one thread, one output) and changes only where the operands come from. A block of 32 × 32 threads owns a 32 × 32 tile of \`C\`; to produce it the block needs a 32 × K strip of \`A\` and a K × 32 strip of \`B\`, and it fetches them 32 columns (rows) at a time. Each thread loads one float of each strip into the slot \`[ty][tx]\` of \`As\` and \`Bs\`, which makes the warp's 32 loads 32 consecutive addresses (four 32-byte sectors, 128 bytes) and then multiplies its row of \`As\` by its column of \`Bs\` 32 times from shared memory. Every float loaded from global memory is used by 32 threads instead of one: 32× fewer global loads. The measured gain is far smaller (1.5× in Boehm's worklog) because the naive kernel's loads are already coalesced and mostly hit L1; the tiled kernel's limit moves to shared memory. Two details decide correctness. The barriers come in pairs: without the first, a thread multiplies slots its neighbours have not written; without the second, a fast warp loads slab \`t + 1\` over a slab a slow warp is still reading, a race that produces wrong values only sometimes, which is why the self-test compares every element on the small shape and again on \`1024³\` (32 slabs) against the naive kernel. And the edges are handled by padding, not by branching: out-of-range threads load \`0.0f\`, stay in the loop and reach both barriers, and are only excluded at the store, because a \`__syncthreads()\` that part of the block skips is undefined behaviour. The shared reads are bank-conflict-free as written (\`As[ty][k]\` is one broadcast address per warp, \`Bs[k][tx]\` spans 32 consecutive banks) and would become a 32-way conflict if \`Bs\` were stored transposed. cuBLAS and CUTLASS start from this kernel and add register tiling (each thread computes a 4 × 4 to 8 × 8 micro-tile, multiplying the FLOPs per shared load), 128 × 128 block tiles computed by 128 to 256 threads, double-buffered slabs loaded with \`cp.async\` or TMA while the current one is multiplied, tensor cores through \`mma.sync\`, swizzled tile layouts, and split-K for thin shapes. \`torch.matmul\` reaches them through cuBLAS by default (\`torch.backends.cuda.preferred_blas_library\` can switch it to cuBLASLt), and Triton's \`tl.dot\` generates the same structure from a few lines. FlashAttention is the same idea applied twice over: \`Q · Kᵀ\` and \`P · V\` are tiled through shared memory so the \`N × N\` score matrix is never written to global memory at all.`,
};
