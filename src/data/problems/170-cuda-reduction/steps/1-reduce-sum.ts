import type {Step} from '@/lib/types';

/** The grid-stride accumulation loop: every thread folds `in[i]` for `i` stepping by the whole grid. */
const GRID_STRIDE =
  /for\s*\([^;]*(blockIdx\.x\s*\*\s*blockDim\.x\s*\+\s*threadIdx\.x|threadIdx\.x\s*\+\s*blockIdx\.x\s*\*\s*blockDim\.x)\s*;[^;]*<\s*n\s*;[^)]*\+=\s*(gridDim\.x\s*\*\s*blockDim\.x|blockDim\.x\s*\*\s*gridDim\.x)/;

export const reduceSumStep: Step = {
  id: 'reduce-sum',
  title: 'reduce_sum: grid-stride partials, warp shuffles, one slot per warp, one atomic per block',
  concept: 'cuda',
  file: 'reduce_sum',
  focus: ['kernel', 'smem', 'gmem'],
  task: `## Task

Implement \`__global__ void reduce_sum(const float* in, float* out, int n)\`: on entry \`*out\` is 0, on exit it
holds \`in[0] + … + in[n-1]\`. The host is written; it builds \`N = 1 << 24\` floats in \`[0, 1)\`, launches two
configurations (512 × 256 and 64 × 128 threads) and compares each result with a Kahan-summed double
reference at a relative tolerance of \`1e-5\`.

- **Grid-stride partial.** Every thread starts at \`blockIdx.x * blockDim.x + threadIdx.x\` and steps by
  \`gridDim.x * blockDim.x\` while \`i < n\`, folding \`in[i]\` into one register. No thread sums the array alone,
  and no \`cub::\`/\`thrust::\`.
- **Warp reduction.** \`__device__ float warp_reduce_sum(float v)\`: \`v += __shfl_down_sync(0xffffffff, v,
  offset)\` for \`offset = 16, 8, 4, 2, 1\`; lane 0 ends with the warp's sum. The mask is the full
  \`0xffffffff\` — not \`__activemask()\`, not the unsynchronised \`__shfl_down\`.
- **One shared slot per warp.** \`lane = threadIdx.x % 32\`, \`warp = threadIdx.x / 32\`; lane 0 of each warp
  writes \`warp_sums[warp]\` (\`__shared__ float warp_sums[32]\`), then \`__syncthreads()\`.
- **Warp 0 finishes the block.** It reads \`lane < blockDim.x / 32 ? warp_sums[lane] : 0\`, calls
  \`warp_reduce_sum\` again, and lane 0 does **one** \`atomicAdd(out, v)\` for the whole block.
- **Block size** is a multiple of 32, at most 1024; the host rejects anything else before launching.
- Forbidden: the interleaved-addressing tree (\`if (tid % (2 * s) == 0)\` with \`s *= 2\`) — half the lanes
  of every warp idle at the first level and the \`%\` costs more than the add.
- The self-test zeroes \`*out\` with \`cudaMemset\` before **every** launch (atomics accumulate), checks the
  launch, copies the float back, reports ms per launch and GB/s over 20 launches, and prints \`PASS\`.

> A sum of 16 M floats moves 64 MiB and does 16 M adds: it is bandwidth-bound, so the kernel reads each
> element exactly once, coalesced, and keeps every later step — shuffles, 32 shared slots, one atomic —
> off the memory bus.`,
  sequence: {
    participants: ['Host', 'Block', 'Warp', 'Shared memory', 'Global memory'],
    messages: [
      {from: 'Host', to: 'Global memory', label: 'cudaMemcpy in (H2D) · cudaMemset(out, 0)', kind: 'sync'},
      {from: 'Host', to: 'Block', label: 'reduce_sum<<<512, 256>>>(in, out, n)', kind: 'async'},
      {from: 'Block', to: 'Global memory', label: 'v += in[i], i += gridDim.x × blockDim.x (coalesced)', kind: 'sync'},
      {
        from: 'Warp',
        to: 'Warp',
        label: '__shfl_down_sync(0xffffffff, v, 16 … 1) → lane 0 has the warp sum',
        kind: 'sync',
      },
      {from: 'Warp', to: 'Shared memory', label: 'lane 0: warp_sums[warp] = v', kind: 'sync'},
      {from: 'Block', to: 'Block', label: '__syncthreads()', kind: 'sync'},
      {from: 'Shared memory', to: 'Warp', label: 'warp 0: warp_sums[lane] (0 past blockDim.x / 32)', kind: 'reply'},
      {from: 'Warp', to: 'Warp', label: 'shuffle again → lane 0 has the block sum', kind: 'sync'},
      {from: 'Warp', to: 'Global memory', label: 'atomicAdd(out, v) — once per block', kind: 'sync'},
      {from: 'Host', to: 'Global memory', label: 'cudaMemcpy out (D2H) · |out − ref| / ref ≤ 1e-5', kind: 'sync'},
    ],
  },
  hints: [
    'Write `warp_reduce_sum` first: `for (int offset = 16; offset > 0; offset >>= 1) v += __shfl_down_sync(0xffffffff, v, offset);`. After it only lane 0 is meaningful; the other lanes hold partial sums you never read.',
    'The kernel is three stages in one register `v`: the grid-stride loop, `v = warp_reduce_sum(v)` then `if (lane == 0) warp_sums[warp] = v;`, `__syncthreads()`, and `if (warp == 0) { v = lane < blockDim.x / 32 ? warp_sums[lane] : 0.0f; v = warp_reduce_sum(v); if (lane == 0) atomicAdd(out, v); }`.',
    'Every thread must reach `__syncthreads()` — no `return` for threads with `i >= n`; the grid-stride loop simply does zero iterations for them and they contribute 0.0f. The slots past `blockDim.x / 32` are never written, which is why warp 0 reads 0 there instead of `warp_sums[lane]`.',
  ],
  checks: [
    {
      id: 'grid-stride',
      title: 'Every thread accumulates a grid-stride slice',
      detail:
        'A `for` from `blockIdx.x * blockDim.x + threadIdx.x` while `< n`, stepping by `gridDim.x * blockDim.x`, so 64 blocks × 128 threads still cover 16 M elements with coalesced reads. No `if (threadIdx.x == 0) for …` serial loop and no `cub::`/`thrust::`.',
      match: {
        cuda: {
          all: [GRID_STRIDE],
          none: [/if\s*\(\s*(threadIdx\.x|i|idx|tid)\s*==\s*0\s*\)\s*\{?\s*for\s*\(/, /\bcub::/, /\bthrust::/],
        },
      },
    },
    {
      id: 'warp-shuffle',
      title: 'Reduces a warp with __shfl_down_sync over the full mask, offsets 16 … 1',
      detail:
        '`v += __shfl_down_sync(0xffffffff, v, offset)` in a loop halving `offset` from 16 to 1 — five register-to-register steps, no shared memory and no barrier. `__activemask()` or the removed `__shfl_down` would make the mask depend on who happens to be converged.',
      match: {
        cuda: {
          all: [
            /__shfl_down_sync\(\s*0x[fF]{8}\s*,\s*\w+\s*,\s*offset\s*\)/,
            /for\s*\(\s*int\s+offset\s*=\s*(16|32\s*\/\s*2|warpSize\s*\/\s*2)\s*;\s*offset\s*>\s*0\s*;\s*offset\s*(>>=\s*1|\/=\s*2)\s*\)/,
          ],
          none: [/__shfl_down\(/, /__activemask\(\)/, /__shfl_down_sync\(\s*0x(?![fF]{8}\b)[0-9a-fA-F]+/],
        },
      },
    },
    {
      id: 'warp-lane',
      title: 'Lane and warp come from threadIdx.x; warp 0 reads only blockDim.x / 32 slots',
      detail:
        '`lane = threadIdx.x % 32`, `warp = threadIdx.x / 32` (or `& 31`, `>> 5`), and the second pass reads `warp_sums[lane]` only for `lane < blockDim.x / 32` — a 128-thread block has four warps, so the other 28 slots were never written.',
      match: {
        cuda: {
          all: [
            /threadIdx\.x\s*(%\s*32|&\s*31)/,
            /threadIdx\.x\s*(\/\s*32|>>\s*5)/,
            /\w+\s*<\s*blockDim\.x\s*(\/\s*32|>>\s*5)/,
          ],
        },
      },
    },
    {
      id: 'shared-slots',
      title: 'One shared slot per warp, a barrier between the write and the read, no interleaved tree',
      detail:
        '`__shared__ float warp_sums[32]`, written by lane 0 of each warp, then `__syncthreads()`, then read by warp 0 — 32 floats instead of one per thread, and exactly one barrier. The classic `if (tid % (2 * s) == 0)` / `s *= 2` tree is not accepted: it diverges every warp at every level.',
      match: {
        cuda: {
          all: [/__shared__\s+float\s+\w+\s*\[[^\]]+\]/, /__syncthreads\(\)/],
          order: [/__shared__/, /__syncthreads\(\)/, /atomicAdd\(|out\s*\[\s*blockIdx\.x\s*\]\s*=/],
          none: [
            /%\s*\(\s*2\s*\*\s*\w+\s*\)\s*==\s*0/,
            /for\s*\(\s*(unsigned\s+)?int\s+\w+\s*=\s*1\s*;[^;]*<\s*blockDim\.x\s*;\s*\w+\s*\*=\s*2\s*\)/,
          ],
        },
      },
    },
    {
      id: 'block-combine',
      title: 'Lane 0 of warp 0 combines the block once with atomicAdd(out, …)',
      detail:
        'After the second `warp_reduce_sum`, `if (lane == 0) atomicAdd(out, v)` — 512 atomics for 16 M elements, not one per thread; the kernel never writes `*out` with `=`. A second-stage launch over per-block partials (`out[blockIdx.x] = …`) is the deterministic alternative.',
      match: {
        cuda: {
          all: [
            /if\s*\(\s*(lane|threadIdx\.x(\s*(%\s*32|&\s*31))?)\s*==\s*0\s*\)\s*\{?\s*atomicAdd\(\s*out\s*,|out\s*\[\s*blockIdx\.x\s*\]\s*=[\s\S]*reduce_sum<<<[\s\S]*reduce_sum<<</,
          ],
          none: [/\*\s*out\s*=/, /atomicAdd\(\s*out\s*,\s*in\s*\[/],
        },
      },
    },
    {
      id: 'host-protocol',
      title: 'The host zeroes out before every launch, checks the launch, reads back, times, compares',
      detail:
        '`cudaMemset(d_out, 0, …)` precedes `reduce_sum<<<…>>>`, which precedes the `cudaMemcpyDeviceToHost` of one float; `threads % 32` is rejected before launching; `cudaEventElapsedTime` gives ms per launch; the reference is a Kahan sum (`c = (t - sum) - y`) in double.',
      match: {
        cuda: {
          order: [/cudaMemset\(\s*d_out\s*,\s*0\s*,/, /reduce_sum<<</, /cudaMemcpy\([^;]*cudaMemcpyDeviceToHost\s*\)/],
          all: [/threads\s*%\s*32\s*(!=|==)\s*0/, /cudaEventElapsedTime\(/, /\(\s*t\s*-\s*sum\s*\)\s*-\s*y/],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// reduce_sum.cu — sum n floats on the GPU: a grid-stride partial per thread, warp shuffles, one shared
// slot per warp, one atomicAdd per block.
//   nvcc -O2 -o reduce_sum reduce_sum.cu && ./reduce_sum
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                   \\
  do {                                                                                     \\
    cudaError_t err_ = (call);                                                             \\
    if (err_ != cudaSuccess) {                                                             \\
      std::fprintf(stderr, "%s:%d: %s\\n", __FILE__, __LINE__, cudaGetErrorString(err_));   \\
      std::exit(EXIT_FAILURE);                                                             \\
    }                                                                                      \\
  } while (0)

// After a launch: the launch itself (a bad configuration) and anything the kernel did.
#define LAUNCH_CHECK()                   \\
  do {                                   \\
    CUDA_CHECK(cudaGetLastError());      \\
    CUDA_CHECK(cudaDeviceSynchronize()); \\
  } while (0)

constexpr int N = 1 << 24;  // 16 777 216 floats, 64 MiB
constexpr float REL_TOL = 1e-5f;
constexpr int TIMED_ITERS = 20;

// Sum across the 32 lanes of a warp; lane 0 holds the result, the other lanes hold partial sums.
__device__ __forceinline__ float warp_reduce_sum(float v) {
  // TODO: v += __shfl_down_sync(0xffffffff, v, offset) for offset = 16, 8, 4, 2, 1.
  return v;
}

// *out must be 0 on entry; on exit it holds in[0] + ... + in[n-1]. blockDim.x: a multiple of 32, at most 1024.
__global__ void reduce_sum(const float* in, float* out, int n) {
  // TODO:
  // 1. grid-stride loop: every thread folds its slice of in[] into one register
  // 2. warp_reduce_sum; lane 0 of each warp writes its sum to a __shared__ slot; __syncthreads()
  // 3. warp 0 reads the slots (0 past blockDim.x / 32), warp_reduce_sum again, lane 0 atomicAdd(out, v)
}

// Kahan-compensated sum in double: the reference the GPU result is measured against.
static double kahan_sum(const std::vector<float>& xs) {
  double sum = 0.0, c = 0.0;
  for (float x : xs) {
    double y = static_cast<double>(x) - c;
    double t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return sum;
}

// One configuration: zero the accumulator, launch, read back, compare, then time 20 launches.
static bool run(const float* d_in, float* d_out, int blocks, int threads, double reference) {
  if (threads % 32 != 0 || threads > 1024) {
    std::fprintf(stderr, "block size %d is not a multiple of 32 up to 1024\\n", threads);
    return false;
  }
  CUDA_CHECK(cudaMemset(d_out, 0, sizeof(float)));
  reduce_sum<<<blocks, threads>>>(d_in, d_out, N);
  LAUNCH_CHECK();
  float result = 0.0f;
  CUDA_CHECK(cudaMemcpy(&result, d_out, sizeof(float), cudaMemcpyDeviceToHost));
  const double rel_err = std::fabs(static_cast<double>(result) - reference) / std::fabs(reference);

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  for (int it = 0; it < TIMED_ITERS; ++it) {
    CUDA_CHECK(cudaMemset(d_out, 0, sizeof(float)));
    reduce_sum<<<blocks, threads>>>(d_in, d_out, N);
  }
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  CUDA_CHECK(cudaGetLastError());
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  const double ms_per_launch = ms / TIMED_ITERS;
  const double gb_per_s = static_cast<double>(N) * sizeof(float) / (ms_per_launch * 1e-3) / 1e9;
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));

  const bool ok = rel_err <= REL_TOL;
  std::printf("%4d blocks x %4d threads: sum %.3f (ref %.3f, rel err %.2e)  %.4f ms/launch  %.1f GB/s  %s\\n",
              blocks, threads, result, reference, rel_err, ms_per_launch, gb_per_s, ok ? "ok" : "MISMATCH");
  return ok;
}

int main() {
  std::vector<float> h_in(N);
  unsigned x = 12345u;  // LCG: deterministic values in [0, 1)
  for (int i = 0; i < N; ++i) {
    x = x * 1664525u + 1013904223u;
    h_in[i] = static_cast<float>(x >> 8) * (1.0f / 16777216.0f);
  }
  const double reference = kahan_sum(h_in);

  float *d_in = nullptr, *d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, N * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_out, sizeof(float)));
  CUDA_CHECK(cudaMemcpy(d_in, h_in.data(), N * sizeof(float), cudaMemcpyHostToDevice));

  bool ok = run(d_in, d_out, 512, 256, reference);  // many blocks: 128 elements per thread
  ok = run(d_in, d_out, 64, 128, reference) && ok;   // few blocks: 2048 per thread, the grid stride carries it

  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  std::printf("%s\\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
`,
      solution: `// reduce_sum.cu — sum n floats on the GPU: a grid-stride partial per thread, warp shuffles, one shared
// slot per warp, one atomicAdd per block.
//   nvcc -O2 -o reduce_sum reduce_sum.cu && ./reduce_sum
#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CUDA_CHECK(call)                                                                   \\
  do {                                                                                     \\
    cudaError_t err_ = (call);                                                             \\
    if (err_ != cudaSuccess) {                                                             \\
      std::fprintf(stderr, "%s:%d: %s\\n", __FILE__, __LINE__, cudaGetErrorString(err_));   \\
      std::exit(EXIT_FAILURE);                                                             \\
    }                                                                                      \\
  } while (0)

// After a launch: the launch itself (a bad configuration) and anything the kernel did.
#define LAUNCH_CHECK()                   \\
  do {                                   \\
    CUDA_CHECK(cudaGetLastError());      \\
    CUDA_CHECK(cudaDeviceSynchronize()); \\
  } while (0)

constexpr int N = 1 << 24;  // 16 777 216 floats, 64 MiB
constexpr float REL_TOL = 1e-5f;
constexpr int TIMED_ITERS = 20;

// Sum across the 32 lanes of a warp; lane 0 holds the result, the other lanes hold partial sums.
__device__ __forceinline__ float warp_reduce_sum(float v) {
  for (int offset = 16; offset > 0; offset >>= 1) v += __shfl_down_sync(0xffffffff, v, offset);
  return v;
}

// *out must be 0 on entry; on exit it holds in[0] + ... + in[n-1]. blockDim.x: a multiple of 32, at most 1024.
__global__ void reduce_sum(const float* in, float* out, int n) {
  __shared__ float warp_sums[32];  // one slot per warp of a 1024-thread block

  // 1. Every thread folds a grid-stride slice into a register: one coalesced read per element.
  float v = 0.0f;
  for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += gridDim.x * blockDim.x) v += in[i];

  // 2. Reduce within the warp; lane 0 of each warp parks its sum in shared memory.
  v = warp_reduce_sum(v);
  const int lane = threadIdx.x % 32;
  const int warp = threadIdx.x / 32;
  if (lane == 0) warp_sums[warp] = v;
  __syncthreads();

  // 3. Warp 0 reduces the warp sums (slots past blockDim.x / 32 were never written) and adds the block's
  //    total to *out once.
  if (warp == 0) {
    v = (lane < blockDim.x / 32) ? warp_sums[lane] : 0.0f;
    v = warp_reduce_sum(v);
    if (lane == 0) atomicAdd(out, v);
  }
}

// Kahan-compensated sum in double: the reference the GPU result is measured against.
static double kahan_sum(const std::vector<float>& xs) {
  double sum = 0.0, c = 0.0;
  for (float x : xs) {
    double y = static_cast<double>(x) - c;
    double t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return sum;
}

// One configuration: zero the accumulator, launch, read back, compare, then time 20 launches.
static bool run(const float* d_in, float* d_out, int blocks, int threads, double reference) {
  if (threads % 32 != 0 || threads > 1024) {
    std::fprintf(stderr, "block size %d is not a multiple of 32 up to 1024\\n", threads);
    return false;
  }
  CUDA_CHECK(cudaMemset(d_out, 0, sizeof(float)));
  reduce_sum<<<blocks, threads>>>(d_in, d_out, N);
  LAUNCH_CHECK();
  float result = 0.0f;
  CUDA_CHECK(cudaMemcpy(&result, d_out, sizeof(float), cudaMemcpyDeviceToHost));
  const double rel_err = std::fabs(static_cast<double>(result) - reference) / std::fabs(reference);

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  for (int it = 0; it < TIMED_ITERS; ++it) {
    CUDA_CHECK(cudaMemset(d_out, 0, sizeof(float)));
    reduce_sum<<<blocks, threads>>>(d_in, d_out, N);
  }
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  CUDA_CHECK(cudaGetLastError());
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  const double ms_per_launch = ms / TIMED_ITERS;
  const double gb_per_s = static_cast<double>(N) * sizeof(float) / (ms_per_launch * 1e-3) / 1e9;
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));

  const bool ok = rel_err <= REL_TOL;
  std::printf("%4d blocks x %4d threads: sum %.3f (ref %.3f, rel err %.2e)  %.4f ms/launch  %.1f GB/s  %s\\n",
              blocks, threads, result, reference, rel_err, ms_per_launch, gb_per_s, ok ? "ok" : "MISMATCH");
  return ok;
}

int main() {
  std::vector<float> h_in(N);
  unsigned x = 12345u;  // LCG: deterministic values in [0, 1)
  for (int i = 0; i < N; ++i) {
    x = x * 1664525u + 1013904223u;
    h_in[i] = static_cast<float>(x >> 8) * (1.0f / 16777216.0f);
  }
  const double reference = kahan_sum(h_in);

  float *d_in = nullptr, *d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, N * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_out, sizeof(float)));
  CUDA_CHECK(cudaMemcpy(d_in, h_in.data(), N * sizeof(float), cudaMemcpyHostToDevice));

  bool ok = run(d_in, d_out, 512, 256, reference);  // many blocks: 128 elements per thread
  ok = run(d_in, d_out, 64, 128, reference) && ok;   // few blocks: 2048 per thread, the grid stride carries it

  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  std::printf("%s\\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
`,
    },
  },
  debrief: `The kernel is shaped by one number: 64 MiB in, 4 bytes out. A sum does one add per 4-byte load, so it runs at memory bandwidth or not at all, and everything after the load must stay off the bus. The **grid-stride loop** is what makes the global reads the only traffic — each element is read once, by consecutive threads at consecutive addresses, and a thread holding 2048 partial adds in a register costs nothing extra; it also decouples the grid from \`n\`, so 64 blocks and 512 blocks both cover 16 M elements and the same kernel serves a 1 000-element row of a LayerNorm and a 100 M-element gradient norm. The **shuffles** replace Mark Harris's shared-memory tree inside the warp: five register moves, no \`__shared__\` traffic, no barrier, and no idle lanes — the interleaved \`tid % (2 * s)\` tree leaves half of every warp waiting at the first level and all but one lane by the last. The full mask \`0xffffffff\` says "all 32 lanes take part" up front; since Volta, threads of a warp may be at different program counters, and \`__activemask()\` reports whoever happens to be converged — a reduction over that set is silently wrong. **One shared slot per warp** is the smallest hand-off the block needs: 32 floats, one \`__syncthreads()\` between the writes and warp 0's reads, and a guard at \`blockDim.x / 32\` because a 128-thread block fills four slots and leaves 28 uninitialised. The **atomic** happens once per block — 512 of them for 16 M elements — so contention is a non-issue; what it costs is determinism: float addition is not associative, and the order blocks arrive varies run to run, so the last digits of \`sum\` move. That is exactly why PyTorch's \`torch.use_deterministic_algorithms(True)\` disables atomic-based reductions and why the two-stage version (\`out[blockIdx.x] = v\`, then a second launch over the partials) exists. Production reductions go further along the same lines: \`float4\` loads to issue 16 bytes per thread per instruction, several independent accumulators per thread so the adds pipeline, CUB's \`DeviceReduce\` with a single pass and decoupled look-back, \`cooperative_groups::reduce\` for the warp step, and PyTorch's \`Reduce.cuh\` that fuses the sum with the \`x²\` of a norm or the \`exp(x − max)\` of a softmax so the data is read once for the whole op. Triton's \`tl.sum\` and \`torch.compile\` generate the same shape: a per-program partial, a tree within the program, one combine across programs.`,
};
