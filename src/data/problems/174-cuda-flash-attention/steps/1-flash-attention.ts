import type {Step} from '@/lib/types';

/**
 * The code every learner starts from and the reference solution: the same self-testing file, the
 * kernel body replaced by a TODO in the starter. Everything is CUDA C++ 12; the host part (fills,
 * CPU reference, max-abs-error check, events, PASS) is identical in both.
 */
const HOST = `
static void attention_cpu(const std::vector<float>& Q, const std::vector<float>& K, const std::vector<float>& V,
                          std::vector<float>& O, int T, int d, float scale, bool causal) {
  std::vector<double> S((size_t)T * T);
  for (int i = 0; i < T; ++i) {
    double mx = -INFINITY;
    for (int j = 0; j < T; ++j) {
      double acc = 0.0;
      for (int k = 0; k < d; ++k) acc += (double)Q[(size_t)i * d + k] * (double)K[(size_t)j * d + k];
      acc *= scale;
      if (causal && j > i) acc = -INFINITY;
      S[(size_t)i * T + j] = acc;
      mx = std::max(mx, acc);
    }
    double sum = 0.0;
    for (int j = 0; j < T; ++j) {
      const double p = std::exp(S[(size_t)i * T + j] - mx);
      S[(size_t)i * T + j] = p;
      sum += p;
    }
    for (int k = 0; k < d; ++k) {
      double acc = 0.0;
      for (int j = 0; j < T; ++j) acc += S[(size_t)i * T + j] * (double)V[(size_t)j * d + k];
      O[(size_t)i * d + k] = (float)(acc / sum);
    }
  }
}

int main() {
  const int T = 256;
  const int d = 64;
  const float scale = 1.0f / sqrtf((float)d);
  const size_t n = (size_t)T * d;
  const size_t bytes = n * sizeof(float);

  std::vector<float> hQ(n), hK(n), hV(n), hO(n), ref(n);
  uint32_t state = 12345u;
  auto next = [&state]() {
    state = state * 1664525u + 1013904223u;
    return (float)(state >> 8) / (float)(1u << 24) * 2.0f - 1.0f;
  };
  for (auto& x : hQ) x = next();
  for (auto& x : hK) x = next();
  for (auto& x : hV) x = next();

  float *dQ = nullptr, *dK = nullptr, *dV = nullptr, *dO = nullptr;
  CUDA_CHECK(cudaMalloc(&dQ, bytes));
  CUDA_CHECK(cudaMalloc(&dK, bytes));
  CUDA_CHECK(cudaMalloc(&dV, bytes));
  CUDA_CHECK(cudaMalloc(&dO, bytes));
  CUDA_CHECK(cudaMemcpy(dQ, hQ.data(), bytes, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dK, hK.data(), bytes, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dV, hV.data(), bytes, cudaMemcpyHostToDevice));

  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  const dim3 grid((T + BQ - 1) / BQ);
  const dim3 block(BQ);

  bool ok = true;
  for (int c = 0; c < 2; ++c) {
    const bool causal = c == 1;
    CUDA_CHECK(cudaMemset(dO, 0, bytes));
    CUDA_LAUNCH(flash_attn_fwd, grid, block, dQ, dK, dV, dO, T, d, scale, causal);
    CUDA_CHECK(cudaDeviceSynchronize());
    CUDA_CHECK(cudaEventRecord(t0));
    CUDA_LAUNCH(flash_attn_fwd, grid, block, dQ, dK, dV, dO, T, d, scale, causal);
    CUDA_CHECK(cudaEventRecord(t1));
    CUDA_CHECK(cudaEventSynchronize(t1));
    float ms = 0.0f;
    CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
    CUDA_CHECK(cudaMemcpy(hO.data(), dO, bytes, cudaMemcpyDeviceToHost));

    attention_cpu(hQ, hK, hV, ref, T, d, scale, causal);
    float max_err = 0.0f;
    for (size_t i = 0; i < n; ++i) {
      const float e = fabsf(hO[i] - ref[i]);
      if (!(e < 1e-3f)) ok = false;
      max_err = fmaxf(max_err, e);
    }
    printf("%-10s max|err| = %.3e  kernel %.3f ms\\n", causal ? "causal" : "non-causal", max_err, ms);
  }

  const size_t smem = 2 * (size_t)BK * D_MAX * sizeof(float);
  printf("memory: Q K V O %zu bytes each on the device, %zu bytes of shared memory per block for the K/V tiles,"
         " scores in registers (a %d x %d score matrix would be %zu bytes; none allocated)\\n",
         bytes, smem, T, T, (size_t)T * T * sizeof(float));

  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  CUDA_CHECK(cudaFree(dQ));
  CUDA_CHECK(cudaFree(dK));
  CUDA_CHECK(cudaFree(dV));
  CUDA_CHECK(cudaFree(dO));
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`;

const HEADER = `// A FlashAttention-style fused attention forward pass for one head: O = softmax(Q K^T * scale) V,
// computed tile by tile so the T x T score matrix never exists in global memory.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include <cuda_runtime.h>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                \\
    cudaError_t err__ = (call);                                                                       \\
    if (err__ != cudaSuccess) {                                                                       \\
      fprintf(stderr, "CUDA error %s at %s:%d\\n", cudaGetErrorString(err__), __FILE__, __LINE__);      \\
      exit(1);                                                                                        \\
    }                                                                                                 \\
  } while (0)

#define CUDA_LAUNCH(kernel, grid, block, ...)    \\
  do {                                           \\
    kernel<<<grid, block>>>(__VA_ARGS__);        \\
    CUDA_CHECK(cudaGetLastError());              \\
  } while (0)

constexpr int BQ = 64;     // query rows per block: one thread per row
constexpr int BK = 32;     // key/value rows per tile staged in shared memory
constexpr int D_MAX = 64;  // head dimension the register accumulator supports (d <= D_MAX)
`;

export const flashAttentionStep: Step = {
  id: 'flash-attention',
  title: 'flash_attn_fwd: tiled scores, online softmax, one write of O',
  concept: 'cuda',
  file: 'flash_attention',
  focus: ['q', 'ks', 'vs', 's', 'ml', 'o', 'g-o'],
  task: `## Task

Implement the kernel

\`\`\`cuda
__global__ void flash_attn_fwd(const float* Q, const float* K, const float* V, float* O,
                               int T, int d, float scale, bool causal);
\`\`\`

for one attention head: \`Q\`, \`K\`, \`V\` and \`O\` are row-major \`T × d\` \`float\` arrays in global memory,
\`O = softmax(Q Kᵀ · scale) V\` with \`scale = 1 / √d\`, and \`causal\` masks every key \`j > i\` of query row
\`i\`. The host launches \`⌈T / BQ⌉\` blocks of \`BQ\` threads; \`BQ = 64\`, \`BK = 32\`, \`D_MAX = 64\` are given
and \`d ≤ D_MAX\`.

- **One thread per query row.** Thread \`threadIdx.x\` of block \`blockIdx.x\` owns \`row = blockIdx.x × BQ +
  threadIdx.x\`. It loads its query row into registers \`float q[D_MAX]\`, already multiplied by \`scale\`,
  zero-padded beyond \`d\`; its accumulator is \`float o[D_MAX]\`, its running max \`float m = -INFINITY\`,
  its running sum \`float l = 0\`.
- **Key/value tiles in shared memory.** Loop \`kv0 = 0, BK, 2·BK, …\` while \`kv0 < T\`. The block stages rows
  \`kv0 … kv0 + BK − 1\` of \`K\` and \`V\` into \`__shared__ float Ks[BK][D_MAX]\` and \`Vs[BK][D_MAX]\` (zero where
  \`key ≥ T\` or \`k ≥ d\`), with every thread loading a strided share, then \`__syncthreads()\`.
- **Scores in registers.** Each thread computes \`float s[BK]\`: \`s[j] = Σₖ q[k] · Ks[j][k]\`, or
  \`-INFINITY\` when the key is padding (\`key ≥ T\`) or masked (\`causal && key > row\`), and \`tile_max\` over
  the tile.
- **Online softmax.** \`m_new = fmaxf(m, tile_max)\`, \`alpha = __expf(m - m_new)\`, scale the accumulator
  \`o[k] *= alpha\`, then for every \`j\`: \`p = __expf(s[j] - m_new)\`, \`p_sum += p\`, \`o[k] += p · Vs[j][k]\`.
  Finish the tile with \`l = l * alpha + p_sum\` and \`m = m_new\`. Use \`__expf\`, not \`expf\`. The fold on
  one row of scores, tile by tile:

:::widget online-softmax {"tile": 4}

- **A second \`__syncthreads()\`** after the tile is consumed, so no thread overwrites \`Ks\`/\`Vs\` while
  a neighbour still reads them.
- **Causal tile skip.** With \`q_last = min(blockIdx.x × BQ + BQ, T) − 1\` the block's last query row, a
  tile with \`kv0 > q_last\` lies entirely above the diagonal: \`if (causal && kv0 > q_last) break;\` before
  loading it. Inside a tile, the mask is per element.
- **Write \`O\` once**: after the loop, \`inv = 1.f / l\` and \`O[row · d + k] = o[k] * inv\` for \`k < d\`,
  only for \`row < T\`. Loop \`k\` to \`D_MAX\` under \`#pragma unroll\` with an \`if (k < d)\` guard: a loop
  bounded by the runtime \`d\` indexes \`o\` dynamically and pushes the whole array to local memory.
  Threads with \`row ≥ T\` still help load tiles and reach every barrier.
- **Forbidden**: any device allocation of \`T × T\` floats (the score matrix never leaves registers),
  cuBLAS, cuDNN.
- The file ends with the given \`main()\`: \`T = 256\`, \`d = 64\`, deterministic inputs in \`[−1, 1]\`, a
  double-precision CPU reference with a materialised softmax, both \`causal = false\` and \`causal = true\`,
  max-abs-error \`< 1e-3\`, a \`cudaEvent\` timing, a memory note and \`PASS\`.

> The whole kernel is one identity: \`exp(s − m_new) = exp(s − m_old) · exp(m_old − m_new)\`. It lets a
> row's softmax be finished one tile at a time, so the \`T × T\` matrix is never written anywhere.`,
  hints: [
    'Lay the kernel out as two loops and a tail: `for (kv0 …) { stage tile; __syncthreads(); if (row < T) { score; fold; } __syncthreads(); }` then normalise. The stage loop is `for (idx = threadIdx.x; idx < BK * D_MAX; idx += BQ)` with `j = idx / D_MAX`, `k = idx % D_MAX`, so consecutive threads read consecutive floats of one K row.',
    'The fold is three statements around the `j` loop: `m_new = fmaxf(m, tile_max)`, `alpha = __expf(m - m_new)`, `o[k] *= alpha`; inside, `p = __expf(s[j] - m_new)` accumulates `p_sum` and `o[k] += p * Vs[j][k]`; after, `l = l * alpha + p_sum; m = m_new;`. The first tile has `m = -INFINITY`, so `alpha` is 0, and a masked `s[j] = -INFINITY` gives `p = 0`: no special cases, because tile 0 holds key 0 and no row starts on an all-masked tile.',
    'Causal has two levels: `if (causal && kv0 > q_last) break;` at the top of the tile loop is block-uniform (it depends on `blockIdx` only), so every thread leaves together and no barrier is skipped by half a block; inside the tile, `key > row` is per thread and only poisons that score.',
  ],
  checks: [
    {
      id: 'kv-tiles-in-shared',
      title: 'K and V are staged BK rows at a time in shared memory',
      detail:
        'Expected `__shared__ float Ks[BK][D_MAX]` and `Vs[BK][D_MAX]` filled by the block (`Ks[j][k] = …`) once per tile, so a key row read once from global memory serves all BQ query rows of the block.',
      match: {
        cuda: {
          all: [
            /__shared__\s+float\s+Ks\s*\[\s*BK\s*\]\s*\[\s*D_MAX\s*\]/,
            /__shared__\s+float\s+Vs\s*\[\s*BK\s*\]\s*\[\s*D_MAX\s*\]/,
            /Ks\s*\[\s*j\s*\]\s*\[\s*k\s*\]\s*=/,
            /Vs\s*\[\s*j\s*\]\s*\[\s*k\s*\]\s*=/,
          ],
        },
      },
    },
    {
      id: 'barrier-each-side',
      title: 'A barrier after the tile load and another before the next load',
      detail:
        'Expected `Ks[j][k] = …`, then `__syncthreads()`, then the dot products `q[k] * Ks[j][k]`, then `__syncthreads()` again. Without the second barrier a fast thread overwrites `Ks`/`Vs` with the next tile while a slower neighbour still multiplies by the old one.',
      match: {
        cuda: {
          order: [
            /Ks\s*\[\s*j\s*\]\s*\[\s*k\s*\]\s*=/,
            /__syncthreads\(\)/,
            /q\s*\[\s*k\s*\]\s*\*\s*Ks\s*\[\s*j\s*\]\s*\[\s*k\s*\]/,
            /__syncthreads\(\)/,
          ],
        },
      },
    },
    {
      id: 'online-max-sum',
      title: 'Running max and running sum are updated per tile',
      detail:
        'Expected `m_new = fmaxf(m, tile_max)`, probabilities `__expf(s[j] - m_new)` against the new max, `l = l * alpha + p_sum` and `m = m_new` at the end of the tile: softmax finished one tile at a time without ever seeing the whole row.',
      match: {
        cuda: {
          all: [
            /m_new\s*=\s*fmaxf\(\s*m\s*,\s*tile_max\s*\)/,
            /__expf\(\s*s\s*\[\s*j\s*\]\s*-\s*m_new\s*\)/,
            /\bl\s*=\s*l\s*\*\s*alpha\s*\+\s*p_sum/,
            /\bm\s*=\s*m_new\s*;/,
          ],
        },
      },
    },
    {
      id: 'rescale-accumulator',
      title: 'The accumulator is rescaled by exp(m_old − m_new) before the tile is added',
      detail:
        'Expected `alpha = __expf(m - m_new)` and `o[k] *= alpha` before `o[k] += p * Vs[j][k]`: everything accumulated under the old max is re-expressed under the new one, which is the identity that makes the one-pass softmax exact.',
      match: {
        cuda: {
          all: [/alpha\s*=\s*__expf\(\s*m\s*-\s*m_new\s*\)/],
          order: [/o\s*\[\s*k\s*\]\s*\*=\s*alpha/, /o\s*\[\s*k\s*\]\s*\+=\s*p\s*\*\s*Vs\s*\[\s*j\s*\]\s*\[\s*k\s*\]/],
        },
      },
    },
    {
      id: 'causal-mask-and-skip',
      title: 'Causal masking inside a tile, whole tiles above the diagonal skipped',
      detail:
        'Expected `if (causal && kv0 > q_last) break;` before a tile is loaded (block-uniform: every thread leaves the loop together) and `causal && key > row` → `-INFINITY` for the elements of a tile that straddles the diagonal. Close to half the tiles of a long causal head are never read (12 of 32 at `T = 256`).',
      match: {
        cuda: {
          all: [
            /if\s*\(\s*causal\s*&&\s*kv0\s*>\s*q_last\s*\)\s*break\s*;/,
            /causal\s*&&\s*key\s*>\s*row/,
            /-\s*INFINITY/,
          ],
        },
      },
    },
    {
      id: 'no-score-matrix',
      title: 'The scores live in registers; no T × T buffer, no library call',
      detail:
        'Expected `float s[BK]` per thread and no `cudaMalloc` of `T * T` floats, no cuBLAS/cuDNN: the point of the kernel is that the score matrix is never materialised in global memory.',
      match: {
        cuda: {
          all: [/float\s+s\s*\[\s*BK\s*\]/],
          none: [/cudaMalloc[^;]*\bT\s*\*\s*T\b/, /cublas/i, /cudnn/i],
        },
      },
    },
    {
      id: 'normalise-once',
      title: 'O is written once, divided by the final l, and copied back after the launch',
      detail:
        'Expected `inv = 1.f / l` after the tile loop and `O[…] = o[k] * inv` as the only global write of the kernel, then `cudaMemcpy(…, cudaMemcpyDeviceToHost)` after `CUDA_LAUNCH(flash_attn_fwd, …)` on the host.',
      match: {
        cuda: {
          all: [/inv\s*=\s*1\.f\s*\/\s*l\b/, /O\s*\[[^\]]+\]\s*=\s*o\s*\[\s*k\s*\]\s*\*\s*inv/],
          order: [/CUDA_LAUNCH\(\s*flash_attn_fwd|flash_attn_fwd\s*<<</, /cudaMemcpyDeviceToHost/],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `${HEADER}
__global__ void __launch_bounds__(BQ) flash_attn_fwd(const float* __restrict__ Q, const float* __restrict__ K,
                                                       const float* __restrict__ V, float* __restrict__ O,
                                                       int T, int d, float scale, bool causal) {
  // TODO: one thread per query row. Stage each BK-row K/V tile into __shared__ Ks/Vs (zero-padded,
  // __syncthreads() after the load), score the tile against q in registers (s[BK], -INFINITY where
  // key >= T or causal && key > row), fold it into the running max m / sum l / accumulator o with
  // alpha = __expf(m - m_new), __syncthreads() before the next tile, break out of tiles entirely above
  // the diagonal when causal, and write O = o / l once at the end.
  (void)Q;
  (void)K;
  (void)V;
  (void)O;
  (void)T;
  (void)d;
  (void)scale;
  (void)causal;
}
${HOST}`,
      solution: `${HEADER}
__global__ void __launch_bounds__(BQ) flash_attn_fwd(const float* __restrict__ Q, const float* __restrict__ K,
                                                       const float* __restrict__ V, float* __restrict__ O,
                                                       int T, int d, float scale, bool causal) {
  __shared__ float Ks[BK][D_MAX];
  __shared__ float Vs[BK][D_MAX];

  const int q0 = blockIdx.x * BQ;
  const int row = q0 + threadIdx.x;         // the query row this thread owns
  const int q_last = min(q0 + BQ, T) - 1;   // the last query row of the block

  // The query row (pre-scaled), the output accumulator and the online-softmax state, all in registers.
  float q[D_MAX];
  float o[D_MAX];
  float m = -INFINITY;
  float l = 0.f;
#pragma unroll
  for (int k = 0; k < D_MAX; ++k) {
    q[k] = (row < T && k < d) ? Q[(size_t)row * d + k] * scale : 0.f;
    o[k] = 0.f;
  }

  for (int kv0 = 0; kv0 < T; kv0 += BK) {
    // Causal: a tile whose first key is past the block's last query row is entirely masked. The
    // condition depends on blockIdx only, so the whole block leaves together and no barrier is missed.
    if (causal && kv0 > q_last) break;

    // Stage the K/V tile: consecutive threads read consecutive floats of one row (coalesced).
    for (int idx = threadIdx.x; idx < BK * D_MAX; idx += BQ) {
      const int j = idx / D_MAX;
      const int k = idx % D_MAX;
      const int key = kv0 + j;
      const bool valid = key < T && k < d;
      Ks[j][k] = valid ? K[(size_t)key * d + k] : 0.f;
      Vs[j][k] = valid ? V[(size_t)key * d + k] : 0.f;
    }
    __syncthreads();

    if (row < T) {
      // Scores of this row against the tile, in registers; the same Ks address for every thread of a
      // warp is a shared-memory broadcast, not a bank conflict.
      float s[BK];
      float tile_max = -INFINITY;
#pragma unroll
      for (int j = 0; j < BK; ++j) {
        const int key = kv0 + j;
        float acc = 0.f;
#pragma unroll
        for (int k = 0; k < D_MAX; ++k) acc += q[k] * Ks[j][k];
        const bool masked = key >= T || (causal && key > row);
        s[j] = masked ? -INFINITY : acc;
        tile_max = fmaxf(tile_max, s[j]);
      }

      // Online softmax: everything accumulated under the old max is rescaled to the new one.
      // First tile: m = -INFINITY, alpha = 0. Masked score: p = __expf(-INFINITY) = 0.
      const float m_new = fmaxf(m, tile_max);
      const float alpha = __expf(m - m_new);
      float p_sum = 0.f;
#pragma unroll
      for (int k = 0; k < D_MAX; ++k) o[k] *= alpha;
#pragma unroll
      for (int j = 0; j < BK; ++j) {
        const float p = __expf(s[j] - m_new);
        p_sum += p;
#pragma unroll
        for (int k = 0; k < D_MAX; ++k) o[k] += p * Vs[j][k];
      }
      l = l * alpha + p_sum;
      m = m_new;
    }
    __syncthreads();  // everyone is done with Ks/Vs before the next tile overwrites them
  }

  if (row < T) {
    const float inv = 1.f / l;
    // Unrolled to D_MAX with a guard: a loop bounded by the runtime d would index o dynamically and
    // force the whole accumulator into local memory.
#pragma unroll
    for (int k = 0; k < D_MAX; ++k)
      if (k < d) O[(size_t)row * d + k] = o[k] * inv;
  }
}
${HOST}`,
    },
  },
  debrief: `The kernel is shaped by one identity and one memory hierarchy. The identity is \`exp(s − m_new) = exp(s − m_old) · exp(m_old − m_new)\`: it lets the numerator \`Σ exp(s_j − m) v_j\` and the denominator \`Σ exp(s_j − m)\` of a softmax be accumulated under whatever maximum has been seen so far and corrected by one multiply when a larger one arrives. That is the online softmax of Milakov & Gimelshein that FlashAttention builds on. Because of it the row never needs all \`T\` scores at once, so \`s\` is \`BK\` floats in registers, and the \`T × T\` matrix a naïve implementation writes to global memory and reads back (\`T² · 4\` bytes for \`S\`, then again for \`P\`) never exists. The hierarchy decides the rest: \`Q\` rows are read once into registers; each \`K\`/\`V\` tile is read once from global memory into shared memory and reused by all \`BQ\` rows of the block, which is the reuse that makes the kernel bandwidth-efficient; the two \`__syncthreads()\` fence the tile's lifetime, because shared memory is a buffer the whole block writes and the whole block reads. The registers hold only because every index into \`q\`, \`o\` and \`s\` is a constant after unrolling; one runtime-indexed loop moves an array to local memory. Causality is two decisions at two granularities: a block-uniform \`break\` that skips close to half the tiles of a long causal head, and a per-element \`-INFINITY\` that \`__expf\` turns into a clean zero. \`__expf\` is a multiply and one special-function-unit instruction (\`ex2.approx\`) where \`expf\` is a longer accurate sequence; here the 128 FMAs per score dominate, but once the matmuls move to tensor cores the exponentials become the bottleneck. Production kernels keep every one of these choices and change the arithmetic around them: FlashAttention-2 gives each warp its own query rows so the reductions never cross warps, keeps \`O\` unnormalised and stores only \`logsumexp = m + log l\` for the backward pass, and feeds \`QKᵀ\` and \`PV\` to tensor cores through \`mma.sync\` in fp16/bf16; FlashAttention-3 overlaps the softmax of one tile with the matmul of the next on Hopper's asynchronous units; \`torch.nn.functional.scaled_dot_product_attention\` dispatches to one of them, and FlexAttention compiles masked variants from a Python predicate with \`torch.compile\`.`,
};
