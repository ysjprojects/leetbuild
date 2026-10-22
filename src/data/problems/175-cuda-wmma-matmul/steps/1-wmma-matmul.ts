import type {Step} from '@/lib/types';

/** `wmma::fragment<…>` with the one fp16 shape every tensor-core generation supports; `using namespace nvcuda` tolerated. */
const fragmentPattern = (kind: string, tail: string): RegExp =>
  new RegExp(
    String.raw`(?:wmma::)?fragment<\s*(?:wmma::)?${kind}\s*,\s*(?:16|WMMA_M)\s*,\s*(?:16|WMMA_N)\s*,\s*(?:16|WMMA_K)\s*,\s*${tail}\s*>`,
  );

export const wmmaMatmulStep: Step = {
  id: 'wmma-matmul',
  title: 'wmma_matmul: one warp, one 16×16 tile, fragments, mma_sync',
  concept: 'cuda',
  file: 'wmma_matmul',
  focus: ['host', 'acc0', 'frag-a', 'frag-b', 'mma', 'acc', 'store'],
  task: `## Task

Implement \`C = A · B\` on tensor cores with \`nvcuda::wmma\` (\`#include <mma.h>\`): \`A\` is \`M × K\` and \`B\` is
\`K × N\`, both \`half\` and **row-major**; \`C\` is \`M × N\` \`float\`. Two kernels and the host code that pads for them.

- \`__global__ void wmma_matmul(const half* A, const half* B, float* C, int M, int N, int K)\` — **one warp per
  16 × 16 output tile**, fragments loaded straight from global memory. The block is 128 threads = 4 warps side by
  side along a row of tiles; \`warpId = threadIdx.x / warpSize\`, \`tileRow = blockIdx.y\`,
  \`tileCol = blockIdx.x * 4 + warpId\`; a warp whose tile is past \`N\` returns as a whole. Declare
  \`wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major>\`, the same for \`matrix_b\`
  (\`row_major\`, since \`B\` is row-major) and \`wmma::fragment<wmma::accumulator, 16, 16, 16, float>\`;
  \`fill_fragment(acc, 0.0f)\`; then \`for (k = 0; k < K; k += 16)\`: \`load_matrix_sync\` the A tile at
  \`A + tileRow·16·K + k\` with leading dimension \`K\` and the B tile at \`B + k·N + tileCol·16\` with leading
  dimension \`N\`, \`mma_sync(acc, a, b, acc)\`; finally \`store_matrix_sync(C + tileRow·16·N + tileCol·16, acc, N,
  wmma::mem_row_major)\`.
- \`__global__ void wmma_matmul_smem(…same signature…)\` — a **64 × 64 block tile** staged through shared memory
  in steps of \`BK = 32\` along K: \`__shared__ __align__(32) half As[64][32 + 8]\` and \`Bs[32][64 + 8]\` (the 8
  halves of skew keep every row stride a multiple of 16 bytes and spread bank traffic), filled cooperatively by
  the 128 threads with rows past \`M\`/\`K\` and columns past \`N\` zero-filled, \`__syncthreads()\`, then each of the
  2 × 2 warps consumes its 32 × 32 quarter as 2 × 2 accumulators (\`load_matrix_sync\` from \`&As[row][kk]\` with
  \`ldm = 40\` and \`&Bs[kk][col]\` with \`ldm = 72\`, four \`mma_sync\`), \`__syncthreads()\` again before the next
  \`k0\` overwrites the tiles. Store each accumulator whose tile origin lies inside \`M × N\`.
- Every \`load_matrix_sync\`/\`store_matrix_sync\` pointer must be **32-byte aligned** and every \`ldm\` a multiple of
  8 halves (4 floats): that is why the kernels take only multiples of 16 and the host pads. \`pad16(x)\` rounds
  up to a multiple of 16; \`upload_padded\` allocates \`Mp × Kp\`, \`Kp × Np\` and \`Mp × Np\`, zeroes the inputs and
  copies the real rows in with \`cudaMemcpy2D\`; \`download\` copies the \`M × N\` corner back the same way.
- Inputs are fp16: \`__float2half\` on the way in, \`__half2float\` for the fp32 CPU reference, which therefore
  sees exactly the rounded values the tensor cores see — the only difference left is accumulation order.
- Tolerance: \`max |C − ref| ≤ 2e-5 × K\` (1e-2 at K = 512, 2e-2 at K = 1024): fp16 products are exact in fp32,
  so the error is K-proportional accumulation noise, two orders below that bound.
- No cuBLAS, no CUTLASS. Keep the plain fp32 tiled kernel: the self-test times all three at 1024³ and prints
  TFLOP/s and the speed-up.
- The self-test runs \`256 × 384 × 512\` and \`250 × 375 × 500\` (the padded path) against the CPU for both
  kernels, then the benchmark, and prints \`PASS\`. Build: \`nvcc -O2 -arch=sm_80 -o wmma_matmul wmma_matmul.cu\`
  (\`sm_70\` or later works).

fp16 keeps 11 significant bits against fp32's 24: slide a value through both formats below to see the rounding
the inputs take on the way in, and why the accumulator has to stay \`float\`.

:::widget float-formats

> A fragment is the warp's share of a 16 × 16 tile in an undocumented register layout; the only things you may
> do with it are \`load\`, \`mma\`, \`store\` — and all 32 lanes must do them together.`,
  hints: [
    'Three fragment declarations and four calls carry the direct kernel: `fill_fragment(acc, 0.0f)`, then per 16 of K `load_matrix_sync(a, A + tileRow * 16 * K + k, K)`, `load_matrix_sync(b, B + k * N + tileCol * 16, N)`, `mma_sync(acc, a, b, acc)`, and once at the end `store_matrix_sync(C + tileRow * 16 * N + tileCol * 16, acc, N, wmma::mem_row_major)`. The pointer is the tile’s top-left element; `ldm` is the full row length of the matrix it sits in.',
    'In the staged kernel the leading dimension is the padded row length of the shared array (`BK + 8 = 40` for `As`, `BN + 8 = 72` for `Bs`), not `K` or `N`. Each warp loads two `a` fragments (`&As[warpRow * 32 + i * 16][kk]`) and two `b` fragments (`&Bs[kk][warpCol * 32 + j * 16]`) and does four `mma_sync` into `acc[i][j]`.',
    'Two `__syncthreads()` per `k0` step: one after the cooperative fill so no warp reads a half-written tile, one after the `mma_sync` loop so no thread starts the next fill while a warp is still reading. `pad16` is `(x + 15) / 16 * 16`; `cudaMemcpy2D(dst, dstPitch, src, srcPitch, widthBytes, rows, kind)` copies a strided block in one call.',
  ],
  checks: [
    {
      id: 'fragments',
      title: 'Fragments of the right shape, type and layout',
      detail:
        '`#include <mma.h>` and three `wmma::fragment<…, 16, 16, 16, …>` declarations: `matrix_a` in `half` `row_major`, `matrix_b` in `half` (`row_major` for a row-major B), `accumulator` in `float`. The 16 × 16 × 16 fp16 shape is the one every tensor-core generation since Volta runs; fp32 accumulation is what keeps a 512-term sum honest.',
      match: {
        cuda: {
          all: [
            /#include\s*<mma\.h>/,
            fragmentPattern('matrix_a', String.raw`half\s*,\s*(?:wmma::)?row_major`),
            fragmentPattern('matrix_b', String.raw`half\s*,\s*(?:wmma::)?(?:row|col)_major`),
            fragmentPattern('accumulator', 'float'),
          ],
        },
      },
    },
    {
      id: 'fill-mma-store',
      title: 'Accumulator zeroed, mma_sync accumulates into itself, stored once',
      detail:
        '`fill_fragment(acc, 0)` before the K loop, `mma_sync(acc, a, b, acc)` inside it (D = A·B + C with C = D keeps the running sum in registers), `store_matrix_sync` after it. A `mma_sync` whose last argument is a different fragment, or a store inside the loop, computes something else or K/16 times too slowly.',
      match: {
        cuda: {
          all: [
            /fill_fragment\(\s*[\w[\]]+\s*,\s*0(?:\.0*f?)?\s*\)/,
            /mma_sync\(\s*([\w[\]]+)\s*,\s*[\w[\]]+\s*,\s*[\w[\]]+\s*,\s*\1\s*\)/,
          ],
          order: [/fill_fragment\(/, /mma_sync\(/, /store_matrix_sync\(/],
        },
      },
    },
    {
      id: 'k-loop-ldm',
      title: 'The K loop steps by 16 with the right leading dimensions',
      detail:
        '`for (k = 0; k < K; k += 16)` and, in the direct kernel, `load_matrix_sync(a, A + …, K)` and `load_matrix_sync(b, B + …, N)`: `ldm` is the row length of the matrix the tile sits in, not the tile width — with `16` in its place the second row of every fragment comes from the wrong place and the result is silently wrong.',
      match: {
        cuda: {
          all: [
            /for\s*\(\s*(?:int\s+)?\w+\s*=\s*0\s*;\s*\w+\s*<\s*K\s*;\s*\w+\s*\+=\s*(?:16|WMMA_K)\s*\)/,
            /load_matrix_sync\(\s*[\w[\]]+\s*,[^;]*,\s*K\s*\)/,
            /load_matrix_sync\(\s*[\w[\]]+\s*,[^;]*,\s*N\s*\)/,
          ],
        },
      },
    },
    {
      id: 'store-row-major',
      title: 'The tile is stored row-major with ldm = N',
      detail:
        '`store_matrix_sync(C + …, acc, N, wmma::mem_row_major)`: the accumulator has no layout of its own, so the store names one and the leading dimension of `C`. `mem_col_major` here would transpose every tile in place.',
      match: {
        cuda: {
          all: [/store_matrix_sync\(\s*[^;]*,\s*N\s*,\s*(?:wmma::)?mem_row_major\s*\)/],
        },
      },
    },
    {
      id: 'warp-per-tile',
      title: 'A warp, not a thread, owns a tile',
      detail:
        '`warpId = threadIdx.x / warpSize` (or `/ 32`) chooses the tile and is computed before any fragment is loaded; the tile index never depends on the lane. Every WMMA call is warp-collective — a thread-per-element mapping, or a lane-dependent `if` around `mma_sync`, is undefined behaviour.',
      match: {
        cuda: {
          all: [/\bwarpId\s*=\s*threadIdx\.x\s*\/\s*(?:warpSize|32)\b/],
          order: [/\bwarpId\s*=\s*threadIdx\.x\s*\/\s*(?:warpSize|32)\b/, /load_matrix_sync\(/],
        },
      },
    },
    {
      id: 'shared-staging',
      title: 'The staged kernel fills aligned shared tiles between two barriers',
      detail:
        '`wmma_matmul_smem` declares `__shared__ __align__(32) half` tiles (`load_matrix_sync` needs a 32-byte-aligned pointer and an `ldm` that is a multiple of 8 halves), and its K loop is `__syncthreads()` → `mma_sync` → `__syncthreads()`: the first barrier publishes the tile to the warps, the second keeps the next fill from overwriting a tile a warp is still reading.',
      match: {
        cuda: {
          all: [
            /__global__\s+void\s+wmma_matmul_smem\s*\(/,
            /(?:__shared__\s+(?:__align__\(\s*(?:32|64|128|256)\s*\)|alignas\(\s*(?:32|64|128|256)\s*\))|(?:__align__\(\s*(?:32|64|128|256)\s*\)|alignas\(\s*(?:32|64|128|256)\s*\))\s+__shared__)\s+half\s+\w+\s*\[/,
          ],
          order: [/__global__\s+void\s+wmma_matmul_smem\s*\(/, /__syncthreads\(\)/, /mma_sync\(/, /__syncthreads\(\)/],
        },
      },
    },
    {
      id: 'host-padding',
      title: 'The host pads every dimension to a multiple of 16',
      detail:
        '`pad16` is `(x + 15) / 16 * 16` (or `(x + 15) & ~15`) and the inputs reach the device through `cudaMemcpy2D` into zeroed, padded buffers. A 250 × 375 × 500 product then runs on 256 × 384 × 512 tiles whose extra rows and columns are zero, so the corner the host copies back is exact.',
      match: {
        cuda: {
          all: [/\(\s*\w+\s*\+\s*15\s*\)\s*(?:\/\s*16\s*\*\s*16|&\s*~\s*15)/, /cudaMemcpy2D\(/],
        },
      },
    },
    {
      id: 'no-cublas',
      title: 'Tensor cores through WMMA on fp16 inputs, not through a library',
      detail:
        'The file converts with `__float2half`/`__half2float`, multiplies with `mma_sync`, and never names cuBLAS or CUTLASS. `cublasGemmEx` is what you would ship; the point here is the warp-level contract it is built from.',
      match: {
        cuda: {
          all: [/__float2half\(/, /__half2float\(/, /mma_sync\(/],
          none: [/cublas/i, /cutlass/i],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// wmma_matmul.cu — C[M×N] = A[M×K] · B[K×N] on tensor cores: fp16 inputs, fp32 accumulation, one warp per 16×16 tile.
// Build and run:  nvcc -O2 -arch=sm_80 -o wmma_matmul wmma_matmul.cu && ./wmma_matmul    (sm_70 or later)
#include <cuda_fp16.h>
#include <cuda_runtime.h>
#include <mma.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

using namespace nvcuda;

static void cuda_check(cudaError_t err, const char* file, int line) {
  if (err == cudaSuccess) return;
  fprintf(stderr, "CUDA error: %s at %s:%d\\n", cudaGetErrorString(err), file, line);
  exit(1);
}
#define CUDA_CHECK(call) cuda_check((call), __FILE__, __LINE__)
// After a launch: a bad configuration shows up now, an in-kernel fault at the synchronize.
#define LAUNCH_CHECK() do { CUDA_CHECK(cudaGetLastError()); CUDA_CHECK(cudaDeviceSynchronize()); } while (0)

constexpr int WARPS_PER_BLOCK = 4;        // direct kernel: 4 warps = 4 tiles side by side along a row of C
constexpr int BM = 64, BN = 64, BK = 32;  // staged kernel: block tile, 2 × 2 warps of 32 × 32 each
constexpr int SKEW = 8;                   // halves of padding per shared row: ldm a multiple of 8, banks spread
constexpr int TILE = 16;                  // the plain fp32 baseline

// ---- baseline: the plain tiled fp32 kernel (kept for the speed comparison) ----------------
__global__ void tiled_matmul_fp32(const float* A, const float* B, float* C, int M, int N, int K) {
  __shared__ float As[TILE][TILE];
  __shared__ float Bs[TILE][TILE];
  const int row = blockIdx.y * TILE + threadIdx.y;
  const int col = blockIdx.x * TILE + threadIdx.x;
  float acc = 0.0f;
  for (int t = 0; t < K; t += TILE) {
    As[threadIdx.y][threadIdx.x] = (row < M && t + threadIdx.x < K) ? A[row * K + t + threadIdx.x] : 0.0f;
    Bs[threadIdx.y][threadIdx.x] = (t + threadIdx.y < K && col < N) ? B[(t + threadIdx.y) * N + col] : 0.0f;
    __syncthreads();
    for (int i = 0; i < TILE; ++i) acc += As[threadIdx.y][i] * Bs[i][threadIdx.x];
    __syncthreads();
  }
  if (row < M && col < N) C[row * N + col] = acc;
}

// ---- one warp per 16 × 16 output tile, fragments loaded straight from global memory --------
// M, N, K are multiples of 16 (the host pads). Block = 128 threads = 4 warps along one row of tiles.
__global__ void wmma_matmul(const half* A, const half* B, float* C, int M, int N, int K) {
  // TODO: warpId = threadIdx.x / warpSize; tileRow = blockIdx.y; tileCol = blockIdx.x * WARPS_PER_BLOCK + warpId;
  //       return (as a whole warp) if the tile is outside M × N;
  //       fragments a (matrix_a, half, row_major), b (matrix_b, half, row_major), acc (accumulator, float);
  //       fill_fragment(acc, 0.0f); for k in 0..K step 16: load_matrix_sync a (ldm K), b (ldm N), mma_sync;
  //       store_matrix_sync(C + tileRow * 16 * N + tileCol * 16, acc, N, wmma::mem_row_major).
}

// ---- stage 64 × 32 and 32 × 64 tiles through shared memory; 4 warps share each load -------
// Any M, N, K that are multiples of 16: rows past M/K and columns past N are zero-filled on the way in.
__global__ void wmma_matmul_smem(const half* A, const half* B, float* C, int M, int N, int K) {
  // TODO: __shared__ __align__(32) half As[BM][BK + SKEW], Bs[BK][BN + SKEW];
  //       warpId → (warpRow, warpCol) in 2 × 2; acc[2][2] filled with 0;
  //       for k0 in 0..K step BK: cooperative fill (zero outside M/N/K), __syncthreads(),
  //         for kk in 0..BK step 16: load 2 a fragments (ldm BK + SKEW) and 2 b fragments (ldm BN + SKEW), 4 mma_sync,
  //         __syncthreads();
  //       store each acc[i][j] whose tile origin is inside M × N (ldm N, mem_row_major).
}

// ---- host side -----------------------------------------------------------------------------
static int pad16(int x) {
  return x;  // TODO: round up to a multiple of 16 — every WMMA tile is 16 × 16
}

// A, B, C on the device, zero-padded to multiples of 16 so every kernel sees whole, aligned tiles.
struct Padded {
  half* A;
  half* B;
  float* C;
  int Mp, Np, Kp;
};

static Padded upload_padded(const std::vector<half>& A, const std::vector<half>& B, int M, int N, int K) {
  Padded p{nullptr, nullptr, nullptr, pad16(M), pad16(N), pad16(K)};
  CUDA_CHECK(cudaMalloc(&p.A, sizeof(half) * p.Mp * p.Kp));
  CUDA_CHECK(cudaMalloc(&p.B, sizeof(half) * p.Kp * p.Np));
  CUDA_CHECK(cudaMalloc(&p.C, sizeof(float) * p.Mp * p.Np));
  CUDA_CHECK(cudaMemset(p.A, 0, sizeof(half) * p.Mp * p.Kp));
  CUDA_CHECK(cudaMemset(p.B, 0, sizeof(half) * p.Kp * p.Np));
  // strided copies: M rows of K halves into rows of pitch Kp; K rows of N halves into rows of pitch Np
  CUDA_CHECK(cudaMemcpy2D(p.A, sizeof(half) * p.Kp, A.data(), sizeof(half) * K, sizeof(half) * K, M,
                          cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy2D(p.B, sizeof(half) * p.Np, B.data(), sizeof(half) * N, sizeof(half) * N, K,
                          cudaMemcpyHostToDevice));
  return p;
}

static void download(const Padded& p, std::vector<float>& C, int M, int N) {
  C.assign((size_t)M * N, 0.0f);
  CUDA_CHECK(cudaMemcpy2D(C.data(), sizeof(float) * N, p.C, sizeof(float) * p.Np, sizeof(float) * N, M,
                          cudaMemcpyDeviceToHost));
}

static void release(Padded& p) {
  CUDA_CHECK(cudaFree(p.A));
  CUDA_CHECK(cudaFree(p.B));
  CUDA_CHECK(cudaFree(p.C));
}

static void launch_wmma(const Padded& p, bool staged) {
  if (staged) {
    const dim3 grid((p.Np + BN - 1) / BN, (p.Mp + BM - 1) / BM);
    wmma_matmul_smem<<<grid, 32 * 4>>>(p.A, p.B, p.C, p.Mp, p.Np, p.Kp);
  } else {
    const dim3 grid((p.Np / 16 + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK, p.Mp / 16);
    wmma_matmul<<<grid, 32 * WARPS_PER_BLOCK>>>(p.A, p.B, p.C, p.Mp, p.Np, p.Kp);
  }
  CUDA_CHECK(cudaGetLastError());
}

// ---- reference, inputs, timing -------------------------------------------------------------
// Deterministic values in [-1, 1) rounded to fp16: the rounding is part of the input, not an error.
static std::vector<half> random_half(size_t n, uint32_t seed) {
  std::vector<half> v(n);
  uint32_t s = seed;
  for (size_t i = 0; i < n; ++i) {
    s = s * 1664525u + 1013904223u;
    v[i] = __float2half((float)(s >> 8) / (float)(1u << 24) * 2.0f - 1.0f);
  }
  return v;
}

static std::vector<float> to_float(const std::vector<half>& v) {
  std::vector<float> f(v.size());
  for (size_t i = 0; i < v.size(); ++i) f[i] = __half2float(v[i]);
  return f;
}

// fp32 CPU reference over the fp16-rounded inputs: the GPU differs only in accumulation order.
static std::vector<float> cpu_matmul(const std::vector<float>& A, const std::vector<float>& B, int M, int N, int K) {
  std::vector<float> C((size_t)M * N, 0.0f);
  for (int i = 0; i < M; ++i)
    for (int k = 0; k < K; ++k) {
      const float a = A[(size_t)i * K + k];
      for (int j = 0; j < N; ++j) C[(size_t)i * N + j] += a * B[(size_t)k * N + j];
    }
  return C;
}

static float max_abs_diff(const std::vector<float>& x, const std::vector<float>& y) {
  float m = 0.0f;
  for (size_t i = 0; i < x.size(); ++i) {
    const float d = fabsf(x[i] - y[i]);
    if (d != d) return INFINITY;  // a NaN never passes a tolerance
    if (d > m) m = d;
  }
  return m;
}

template <typename Launch>
static float time_ms(Launch launch, int iters) {
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  launch();  // warm-up
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaEventRecord(t0));
  for (int i = 0; i < iters; ++i) launch();
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  return ms / iters;
}

// ---- self-test -----------------------------------------------------------------------------
static bool check_case(int M, int N, int K) {
  const float tol = 2e-5f * K;  // fp32 accumulation noise over K exact fp16 products, with margin
  const std::vector<half> A = random_half((size_t)M * K, 1u), B = random_half((size_t)K * N, 2u);
  const std::vector<float> ref = cpu_matmul(to_float(A), to_float(B), M, N, K);
  Padded p = upload_padded(A, B, M, N, K);
  bool ok = true;
  for (int staged = 0; staged < 2; ++staged) {
    CUDA_CHECK(cudaMemset(p.C, 0, sizeof(float) * p.Mp * p.Np));  // a kernel that writes nothing fails loudly
    launch_wmma(p, staged == 1);
    LAUNCH_CHECK();
    std::vector<float> C;
    download(p, C, M, N);
    const float err = max_abs_diff(C, ref);
    printf("%-17s M=%d N=%d K=%d  max|C - ref| = %.3e  (tol %.1e)  %s\\n", staged ? "wmma_matmul_smem" : "wmma_matmul",
           M, N, K, err, tol, err <= tol ? "ok" : "FAIL");
    ok = ok && err <= tol;
  }
  release(p);
  return ok;
}

static bool benchmark(int n, int iters) {
  const int M = n, N = n, K = n;
  const std::vector<half> A = random_half((size_t)M * K, 3u), B = random_half((size_t)K * N, 4u);
  const std::vector<float> Af = to_float(A), Bf = to_float(B);  // the same rounded values, fp32, for the baseline
  Padded p = upload_padded(A, B, M, N, K);
  float *dAf, *dBf, *dCf;
  CUDA_CHECK(cudaMalloc(&dAf, sizeof(float) * Af.size()));
  CUDA_CHECK(cudaMalloc(&dBf, sizeof(float) * Bf.size()));
  CUDA_CHECK(cudaMalloc(&dCf, sizeof(float) * (size_t)M * N));
  CUDA_CHECK(cudaMemcpy(dAf, Af.data(), sizeof(float) * Af.size(), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dBf, Bf.data(), sizeof(float) * Bf.size(), cudaMemcpyHostToDevice));

  const dim3 tb(TILE, TILE), tg((N + TILE - 1) / TILE, (M + TILE - 1) / TILE);
  const float ms_tiled = time_ms(
      [&] {
        tiled_matmul_fp32<<<tg, tb>>>(dAf, dBf, dCf, M, N, K);
        CUDA_CHECK(cudaGetLastError());
      },
      iters);
  const float ms_direct = time_ms([&] { launch_wmma(p, false); }, iters);
  const float ms_smem = time_ms([&] { launch_wmma(p, true); }, iters);
  CUDA_CHECK(cudaDeviceSynchronize());

  const double tflops = 2.0 * M * N * K / 1e12;
  printf("%d^3  tiled fp32 %.3f ms = %5.2f TFLOP/s | wmma %.3f ms = %5.2f TFLOP/s (%.1fx) | wmma smem %.3f ms = %5.2f TFLOP/s (%.1fx)\\n",
         n, ms_tiled, tflops / (ms_tiled * 1e-3), ms_direct, tflops / (ms_direct * 1e-3), ms_tiled / ms_direct, ms_smem,
         tflops / (ms_smem * 1e-3), ms_tiled / ms_smem);

  // the staged result is what p.C holds now; at this size the fp32 baseline is the reference
  std::vector<float> C, Cf((size_t)M * N);
  download(p, C, M, N);
  CUDA_CHECK(cudaMemcpy(Cf.data(), dCf, sizeof(float) * Cf.size(), cudaMemcpyDeviceToHost));
  const float err = max_abs_diff(C, Cf), tol = 2e-5f * K;
  printf("%d^3  max|wmma smem - tiled fp32| = %.3e  (tol %.1e)  %s\\n", n, err, tol, err <= tol ? "ok" : "FAIL");

  CUDA_CHECK(cudaFree(dAf));
  CUDA_CHECK(cudaFree(dBf));
  CUDA_CHECK(cudaFree(dCf));
  release(p);
  return err <= tol;
}

int main() {
  cudaDeviceProp prop;
  CUDA_CHECK(cudaGetDeviceProperties(&prop, 0));
  printf("%s (sm_%d%d)\\n", prop.name, prop.major, prop.minor);
  if (prop.major < 7) {
    fprintf(stderr, "tensor cores need sm_70 or later\\n");
    return 1;
  }
  bool ok = true;
  ok = check_case(256, 384, 512) && ok;  // multiples of 16, non-square: a wrong ldm shows
  ok = check_case(250, 375, 500) && ok;  // the padded path
  ok = benchmark(1024, 20) && ok;
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`,
      solution: `// wmma_matmul.cu — C[M×N] = A[M×K] · B[K×N] on tensor cores: fp16 inputs, fp32 accumulation, one warp per 16×16 tile.
// Build and run:  nvcc -O2 -arch=sm_80 -o wmma_matmul wmma_matmul.cu && ./wmma_matmul    (sm_70 or later)
#include <cuda_fp16.h>
#include <cuda_runtime.h>
#include <mma.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

using namespace nvcuda;

static void cuda_check(cudaError_t err, const char* file, int line) {
  if (err == cudaSuccess) return;
  fprintf(stderr, "CUDA error: %s at %s:%d\\n", cudaGetErrorString(err), file, line);
  exit(1);
}
#define CUDA_CHECK(call) cuda_check((call), __FILE__, __LINE__)
// After a launch: a bad configuration shows up now, an in-kernel fault at the synchronize.
#define LAUNCH_CHECK() do { CUDA_CHECK(cudaGetLastError()); CUDA_CHECK(cudaDeviceSynchronize()); } while (0)

constexpr int WARPS_PER_BLOCK = 4;        // direct kernel: 4 warps = 4 tiles side by side along a row of C
constexpr int BM = 64, BN = 64, BK = 32;  // staged kernel: block tile, 2 × 2 warps of 32 × 32 each
constexpr int SKEW = 8;                   // halves of padding per shared row: ldm a multiple of 8, banks spread
constexpr int TILE = 16;                  // the plain fp32 baseline

// ---- baseline: the plain tiled fp32 kernel (kept for the speed comparison) ----------------
__global__ void tiled_matmul_fp32(const float* A, const float* B, float* C, int M, int N, int K) {
  __shared__ float As[TILE][TILE];
  __shared__ float Bs[TILE][TILE];
  const int row = blockIdx.y * TILE + threadIdx.y;
  const int col = blockIdx.x * TILE + threadIdx.x;
  float acc = 0.0f;
  for (int t = 0; t < K; t += TILE) {
    As[threadIdx.y][threadIdx.x] = (row < M && t + threadIdx.x < K) ? A[row * K + t + threadIdx.x] : 0.0f;
    Bs[threadIdx.y][threadIdx.x] = (t + threadIdx.y < K && col < N) ? B[(t + threadIdx.y) * N + col] : 0.0f;
    __syncthreads();
    for (int i = 0; i < TILE; ++i) acc += As[threadIdx.y][i] * Bs[i][threadIdx.x];
    __syncthreads();
  }
  if (row < M && col < N) C[row * N + col] = acc;
}

// ---- one warp per 16 × 16 output tile, fragments loaded straight from global memory --------
// M, N, K are multiples of 16 (the host pads). Block = 128 threads = 4 warps along one row of tiles.
__global__ void wmma_matmul(const half* A, const half* B, float* C, int M, int N, int K) {
  const int warpId = threadIdx.x / warpSize;                  // which of the block's 4 warps
  const int tileRow = blockIdx.y;                             // 16-row strip of C
  const int tileCol = blockIdx.x * WARPS_PER_BLOCK + warpId;  // 16-column strip of C
  if (tileRow * 16 >= M || tileCol * 16 >= N) return;         // the whole warp leaves together

  // a fragment is this warp's share of a 16 × 16 tile, spread over the 32 lanes' registers
  wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> a_frag;
  wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> b_frag;
  wmma::fragment<wmma::accumulator, 16, 16, 16, float> acc;
  wmma::fill_fragment(acc, 0.0f);

  for (int k = 0; k < K; k += 16) {
    // pointer = the tile's top-left element; ldm = the row length of the matrix it sits in
    wmma::load_matrix_sync(a_frag, A + tileRow * 16 * K + k, K);  // A[tileRow*16 .. +16][k .. k+16]
    wmma::load_matrix_sync(b_frag, B + k * N + tileCol * 16, N);  // B[k .. k+16][tileCol*16 .. +16]
    wmma::mma_sync(acc, a_frag, b_frag, acc);                      // acc = a · b + acc
  }
  wmma::store_matrix_sync(C + tileRow * 16 * N + tileCol * 16, acc, N, wmma::mem_row_major);
}

// ---- stage 64 × 32 and 32 × 64 tiles through shared memory; 4 warps share each load -------
// Any M, N, K that are multiples of 16: rows past M/K and columns past N are zero-filled on the way in.
__global__ void wmma_matmul_smem(const half* A, const half* B, float* C, int M, int N, int K) {
  __shared__ __align__(32) half As[BM][BK + SKEW];  // 64 × 40 halves: row stride 80 B, a multiple of 16 B
  __shared__ __align__(32) half Bs[BK][BN + SKEW];  // 32 × 72 halves: row stride 144 B
  const int warpId = threadIdx.x / warpSize;
  const int warpRow = warpId / 2, warpCol = warpId % 2;  // 2 × 2 warps, each owning 32 × 32 of the block tile
  const int row0 = blockIdx.y * BM, col0 = blockIdx.x * BN;
  const half zero = __float2half(0.0f);

  wmma::fragment<wmma::accumulator, 16, 16, 16, float> acc[2][2];
  for (int i = 0; i < 2; ++i)
    for (int j = 0; j < 2; ++j) wmma::fill_fragment(acc[i][j], 0.0f);

  for (int k0 = 0; k0 < K; k0 += BK) {
    // cooperative fill: 128 threads, 16 elements each per tile; consecutive threads read consecutive columns
    for (int i = threadIdx.x; i < BM * BK; i += blockDim.x) {
      const int r = i / BK, c = i % BK;
      As[r][c] = (row0 + r < M && k0 + c < K) ? A[(row0 + r) * K + k0 + c] : zero;
    }
    for (int i = threadIdx.x; i < BK * BN; i += blockDim.x) {
      const int r = i / BN, c = i % BN;
      Bs[r][c] = (k0 + r < K && col0 + c < N) ? B[(k0 + r) * N + col0 + c] : zero;
    }
    __syncthreads();  // both tiles complete before any warp reads them

    for (int kk = 0; kk < BK; kk += 16) {
      wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> a_frag[2];
      wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> b_frag[2];
      for (int i = 0; i < 2; ++i) wmma::load_matrix_sync(a_frag[i], &As[warpRow * 32 + i * 16][kk], BK + SKEW);
      for (int j = 0; j < 2; ++j) wmma::load_matrix_sync(b_frag[j], &Bs[kk][warpCol * 32 + j * 16], BN + SKEW);
      for (int i = 0; i < 2; ++i)
        for (int j = 0; j < 2; ++j) wmma::mma_sync(acc[i][j], a_frag[i], b_frag[j], acc[i][j]);
    }
    __syncthreads();  // every warp is done with As/Bs before the next k0 overwrites them
  }

  for (int i = 0; i < 2; ++i)
    for (int j = 0; j < 2; ++j) {
      const int r = row0 + warpRow * 32 + i * 16, c = col0 + warpCol * 32 + j * 16;
      // M and N are multiples of 16: a tile is either entirely inside C or entirely outside
      if (r < M && c < N) wmma::store_matrix_sync(C + r * N + c, acc[i][j], N, wmma::mem_row_major);
    }
}

// ---- host side -----------------------------------------------------------------------------
static int pad16(int x) {
  return (x + 15) / 16 * 16;  // every WMMA tile is 16 × 16
}

// A, B, C on the device, zero-padded to multiples of 16 so every kernel sees whole, aligned tiles.
struct Padded {
  half* A;
  half* B;
  float* C;
  int Mp, Np, Kp;
};

static Padded upload_padded(const std::vector<half>& A, const std::vector<half>& B, int M, int N, int K) {
  Padded p{nullptr, nullptr, nullptr, pad16(M), pad16(N), pad16(K)};
  CUDA_CHECK(cudaMalloc(&p.A, sizeof(half) * p.Mp * p.Kp));
  CUDA_CHECK(cudaMalloc(&p.B, sizeof(half) * p.Kp * p.Np));
  CUDA_CHECK(cudaMalloc(&p.C, sizeof(float) * p.Mp * p.Np));
  CUDA_CHECK(cudaMemset(p.A, 0, sizeof(half) * p.Mp * p.Kp));
  CUDA_CHECK(cudaMemset(p.B, 0, sizeof(half) * p.Kp * p.Np));
  // strided copies: M rows of K halves into rows of pitch Kp; K rows of N halves into rows of pitch Np
  CUDA_CHECK(cudaMemcpy2D(p.A, sizeof(half) * p.Kp, A.data(), sizeof(half) * K, sizeof(half) * K, M,
                          cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy2D(p.B, sizeof(half) * p.Np, B.data(), sizeof(half) * N, sizeof(half) * N, K,
                          cudaMemcpyHostToDevice));
  return p;
}

static void download(const Padded& p, std::vector<float>& C, int M, int N) {
  C.assign((size_t)M * N, 0.0f);
  CUDA_CHECK(cudaMemcpy2D(C.data(), sizeof(float) * N, p.C, sizeof(float) * p.Np, sizeof(float) * N, M,
                          cudaMemcpyDeviceToHost));
}

static void release(Padded& p) {
  CUDA_CHECK(cudaFree(p.A));
  CUDA_CHECK(cudaFree(p.B));
  CUDA_CHECK(cudaFree(p.C));
}

static void launch_wmma(const Padded& p, bool staged) {
  if (staged) {
    const dim3 grid((p.Np + BN - 1) / BN, (p.Mp + BM - 1) / BM);
    wmma_matmul_smem<<<grid, 32 * 4>>>(p.A, p.B, p.C, p.Mp, p.Np, p.Kp);
  } else {
    const dim3 grid((p.Np / 16 + WARPS_PER_BLOCK - 1) / WARPS_PER_BLOCK, p.Mp / 16);
    wmma_matmul<<<grid, 32 * WARPS_PER_BLOCK>>>(p.A, p.B, p.C, p.Mp, p.Np, p.Kp);
  }
  CUDA_CHECK(cudaGetLastError());
}

// ---- reference, inputs, timing -------------------------------------------------------------
// Deterministic values in [-1, 1) rounded to fp16: the rounding is part of the input, not an error.
static std::vector<half> random_half(size_t n, uint32_t seed) {
  std::vector<half> v(n);
  uint32_t s = seed;
  for (size_t i = 0; i < n; ++i) {
    s = s * 1664525u + 1013904223u;
    v[i] = __float2half((float)(s >> 8) / (float)(1u << 24) * 2.0f - 1.0f);
  }
  return v;
}

static std::vector<float> to_float(const std::vector<half>& v) {
  std::vector<float> f(v.size());
  for (size_t i = 0; i < v.size(); ++i) f[i] = __half2float(v[i]);
  return f;
}

// fp32 CPU reference over the fp16-rounded inputs: the GPU differs only in accumulation order.
static std::vector<float> cpu_matmul(const std::vector<float>& A, const std::vector<float>& B, int M, int N, int K) {
  std::vector<float> C((size_t)M * N, 0.0f);
  for (int i = 0; i < M; ++i)
    for (int k = 0; k < K; ++k) {
      const float a = A[(size_t)i * K + k];
      for (int j = 0; j < N; ++j) C[(size_t)i * N + j] += a * B[(size_t)k * N + j];
    }
  return C;
}

static float max_abs_diff(const std::vector<float>& x, const std::vector<float>& y) {
  float m = 0.0f;
  for (size_t i = 0; i < x.size(); ++i) {
    const float d = fabsf(x[i] - y[i]);
    if (d != d) return INFINITY;  // a NaN never passes a tolerance
    if (d > m) m = d;
  }
  return m;
}

template <typename Launch>
static float time_ms(Launch launch, int iters) {
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  launch();  // warm-up
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaEventRecord(t0));
  for (int i = 0; i < iters; ++i) launch();
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  return ms / iters;
}

// ---- self-test -----------------------------------------------------------------------------
static bool check_case(int M, int N, int K) {
  const float tol = 2e-5f * K;  // fp32 accumulation noise over K exact fp16 products, with margin
  const std::vector<half> A = random_half((size_t)M * K, 1u), B = random_half((size_t)K * N, 2u);
  const std::vector<float> ref = cpu_matmul(to_float(A), to_float(B), M, N, K);
  Padded p = upload_padded(A, B, M, N, K);
  bool ok = true;
  for (int staged = 0; staged < 2; ++staged) {
    CUDA_CHECK(cudaMemset(p.C, 0, sizeof(float) * p.Mp * p.Np));  // a kernel that writes nothing fails loudly
    launch_wmma(p, staged == 1);
    LAUNCH_CHECK();
    std::vector<float> C;
    download(p, C, M, N);
    const float err = max_abs_diff(C, ref);
    printf("%-17s M=%d N=%d K=%d  max|C - ref| = %.3e  (tol %.1e)  %s\\n", staged ? "wmma_matmul_smem" : "wmma_matmul",
           M, N, K, err, tol, err <= tol ? "ok" : "FAIL");
    ok = ok && err <= tol;
  }
  release(p);
  return ok;
}

static bool benchmark(int n, int iters) {
  const int M = n, N = n, K = n;
  const std::vector<half> A = random_half((size_t)M * K, 3u), B = random_half((size_t)K * N, 4u);
  const std::vector<float> Af = to_float(A), Bf = to_float(B);  // the same rounded values, fp32, for the baseline
  Padded p = upload_padded(A, B, M, N, K);
  float *dAf, *dBf, *dCf;
  CUDA_CHECK(cudaMalloc(&dAf, sizeof(float) * Af.size()));
  CUDA_CHECK(cudaMalloc(&dBf, sizeof(float) * Bf.size()));
  CUDA_CHECK(cudaMalloc(&dCf, sizeof(float) * (size_t)M * N));
  CUDA_CHECK(cudaMemcpy(dAf, Af.data(), sizeof(float) * Af.size(), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dBf, Bf.data(), sizeof(float) * Bf.size(), cudaMemcpyHostToDevice));

  const dim3 tb(TILE, TILE), tg((N + TILE - 1) / TILE, (M + TILE - 1) / TILE);
  const float ms_tiled = time_ms(
      [&] {
        tiled_matmul_fp32<<<tg, tb>>>(dAf, dBf, dCf, M, N, K);
        CUDA_CHECK(cudaGetLastError());
      },
      iters);
  const float ms_direct = time_ms([&] { launch_wmma(p, false); }, iters);
  const float ms_smem = time_ms([&] { launch_wmma(p, true); }, iters);
  CUDA_CHECK(cudaDeviceSynchronize());

  const double tflops = 2.0 * M * N * K / 1e12;
  printf("%d^3  tiled fp32 %.3f ms = %5.2f TFLOP/s | wmma %.3f ms = %5.2f TFLOP/s (%.1fx) | wmma smem %.3f ms = %5.2f TFLOP/s (%.1fx)\\n",
         n, ms_tiled, tflops / (ms_tiled * 1e-3), ms_direct, tflops / (ms_direct * 1e-3), ms_tiled / ms_direct, ms_smem,
         tflops / (ms_smem * 1e-3), ms_tiled / ms_smem);

  // the staged result is what p.C holds now; at this size the fp32 baseline is the reference
  std::vector<float> C, Cf((size_t)M * N);
  download(p, C, M, N);
  CUDA_CHECK(cudaMemcpy(Cf.data(), dCf, sizeof(float) * Cf.size(), cudaMemcpyDeviceToHost));
  const float err = max_abs_diff(C, Cf), tol = 2e-5f * K;
  printf("%d^3  max|wmma smem - tiled fp32| = %.3e  (tol %.1e)  %s\\n", n, err, tol, err <= tol ? "ok" : "FAIL");

  CUDA_CHECK(cudaFree(dAf));
  CUDA_CHECK(cudaFree(dBf));
  CUDA_CHECK(cudaFree(dCf));
  release(p);
  return err <= tol;
}

int main() {
  cudaDeviceProp prop;
  CUDA_CHECK(cudaGetDeviceProperties(&prop, 0));
  printf("%s (sm_%d%d)\\n", prop.name, prop.major, prop.minor);
  if (prop.major < 7) {
    fprintf(stderr, "tensor cores need sm_70 or later\\n");
    return 1;
  }
  bool ok = true;
  ok = check_case(256, 384, 512) && ok;  // multiples of 16, non-square: a wrong ldm shows
  ok = check_case(250, 375, 500) && ok;  // the padded path
  ok = benchmark(1024, 20) && ok;
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`,
    },
  },
  debrief: `The kernel is shaped by one contract: a \`wmma::fragment\` is a warp's share of a 16 × 16 tile in a register layout the hardware chooses, and the only operations on it — \`load_matrix_sync\`, \`mma_sync\`, \`store_matrix_sync\`, \`fill_fragment\` — are warp-collective. That is why the unit of work is a warp (\`warpId = threadIdx.x / warpSize\`), why a tile past the edge exits as a whole warp rather than lane by lane, and why the host pads to multiples of 16 and keeps every pointer 32-byte aligned and every \`ldm\` a multiple of 8 halves: the instructions have no bounds checks and no unaligned path, only undefined results. \`mma_sync(acc, a, b, acc)\` is \`D = A·B + C\` with \`C\` and \`D\` the same fragment, so the K/16 partial products accumulate in fp32 registers and touch memory once at the store. The direct kernel already beats the fp32 tiled baseline by a wide margin because the tensor core does 16 × 16 × 16 = 4096 multiply-adds per instruction; it is still bound by global loads, and the staged version is the first step toward fixing that: each A and B element enters the SM once per 64 × 64 block and four warps share it, with the two barriers separating *fill* from *consume* and the skew of 8 halves keeping \`ldm\` legal and the loads conflict-free. Production GEMMs — cuBLAS, CUTLASS, the \`torch.matmul\` behind every linear layer — keep the same structure and add what this file leaves out: 128 × 128 or larger block tiles, vectorised 16-byte global loads via \`cp.async\` with a multi-stage pipeline that loads tile k+2 while k is multiplied, software-swizzled shared memory in place of the skew, split-K for skinny shapes, fused epilogues (bias, GELU, residual), and on Hopper the \`wgmma\` instructions that read operands straight from shared memory through TMA. The tolerance also tells a story: the inputs are fp16 and the reference uses the same rounded values, so what remains is fp32 accumulation order — which is why mixed-precision training keeps the accumulator, the master weights and the optimizer state in fp32 while the multiplies run in half precision.`,
};
