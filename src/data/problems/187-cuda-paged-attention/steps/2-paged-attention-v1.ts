import type {Step} from '@/lib/types';

/**
 * Step 2 of the PagedAttention kernels: paged_attention_v1, decode attention over the paged cache with
 * one thread block per (head, sequence). The header carries step 1's kernel to fill the cache; the
 * CPU reference over contiguous K/V, the timing and the PASS check are the same in starter and solution.
 */
const HEADER = `// vLLM's paged_attention_v1: decode attention over a paged KV cache. One thread block per
// (head, sequence); its warps walk the sequence's KV blocks through the block table, score each key
// with a two-lane dot product joined by a shuffle, keep the logits in shared memory, reduce max and
// sum across the block, then accumulate V. Float storage; grouped-query attention.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <numeric>
#include <vector>

#include <cuda_runtime.h>

#define CUDA_CHECK(call)                                                                         \\
  do {                                                                                           \\
    cudaError_t err__ = (call);                                                                  \\
    if (err__ != cudaSuccess) {                                                                  \\
      fprintf(stderr, "CUDA error %s at %s:%d\\n", cudaGetErrorString(err__), __FILE__, __LINE__); \\
      exit(1);                                                                                   \\
    }                                                                                            \\
  } while (0)

#define CUDA_LAUNCH(kernel, grid, block, smem, ...) \\
  do {                                              \\
    kernel<<<grid, block, smem>>>(__VA_ARGS__);     \\
    CUDA_CHECK(cudaGetLastError());                 \\
  } while (0)

constexpr int WARP_SIZE = 32;
constexpr int NUM_KV_HEADS = 8;   // Llama-3 8B: 32 query heads share 8 KV heads
constexpr int HEAD_SIZE = 128;
constexpr int BLOCK_SIZE = 16;    // tokens per KV-cache block, vLLM's default
constexpr int NUM_THREADS = 128;  // threads per thread block: 4 warps
constexpr int NUM_WARPS = NUM_THREADS / WARP_SIZE;
constexpr int THREAD_GROUP_SIZE = WARP_SIZE / BLOCK_SIZE;  // 2 lanes score one key: a warp covers one KV block
constexpr int NUM_VECS_PER_THREAD = HEAD_SIZE / (THREAD_GROUP_SIZE * 4);  // float4s of q and k per lane: 16
constexpr int V_PER_LANE = HEAD_SIZE / WARP_SIZE;  // output elements per lane: 4
static_assert(WARP_SIZE % BLOCK_SIZE == 0, "a warp scores a whole KV block at once");
static_assert(HEAD_SIZE % (THREAD_GROUP_SIZE * 4) == 0 && HEAD_SIZE % WARP_SIZE == 0, "head size");

// Step 1: one block per token, threads over heads x head_size, slot -1 skipped.
__global__ void reshape_and_cache(const float* __restrict__ key, const float* __restrict__ value,
                                  float* __restrict__ key_cache, float* __restrict__ value_cache,
                                  const int64_t* __restrict__ slot_mapping, int num_kv_heads, int head_size,
                                  int block_size) {
  const int64_t token_idx = blockIdx.x;
  const int64_t slot = slot_mapping[token_idx];
  if (slot < 0) return;
  const int64_t block_idx = slot / block_size;
  const int64_t block_offset = slot % block_size;
  const int n = num_kv_heads * head_size;
  for (int i = threadIdx.x; i < n; i += blockDim.x) {
    const int head = i / head_size;
    const int d = i % head_size;
    const int64_t src = (token_idx * num_kv_heads + head) * head_size + d;
    const int64_t dst = ((block_idx * block_size + block_offset) * num_kv_heads + head) * head_size + d;
    key_cache[dst] = key[src];
    value_cache[dst] = value[src];
  }
}

`;

const SOLUTION_KERNEL = `// Grid (num_heads, num_seqs), NUM_THREADS threads, dynamic shared memory: one float per context token.
// out, q: [num_seqs, num_heads, HEAD_SIZE]. k_cache, v_cache: [num_blocks, BLOCK_SIZE, num_kv_heads, HEAD_SIZE].
// block_tables: [num_seqs, max_num_blocks_per_seq]. seq_lens: [num_seqs].
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v1(float* __restrict__ out, const float* __restrict__ q, const float* __restrict__ k_cache,
                       const float* __restrict__ v_cache, const int* __restrict__ block_tables,
                       const int* __restrict__ seq_lens, int max_num_blocks_per_seq, int num_kv_heads, float scale) {
  extern __shared__ float logits[];  // [seq_len], scores and then exp(score - max)
  __shared__ float red_max[NUM_WARPS];
  __shared__ float red_sum[NUM_WARPS];
  __shared__ float out_smem[NUM_WARPS][HEAD_SIZE];

  const int head = blockIdx.x;
  const int seq = blockIdx.y;
  const int num_heads = gridDim.x;
  const int kv_head = head / (num_heads / num_kv_heads);  // GQA: 4 query heads read one KV head
  const int seq_len = seq_lens[seq];
  const int num_seq_blocks = (seq_len + BLOCK_SIZE - 1) / BLOCK_SIZE;
  const int* block_table = block_tables + (int64_t)seq * max_num_blocks_per_seq;
  const int64_t token_stride = (int64_t)num_kv_heads * HEAD_SIZE;  // floats from one slot to the next

  const int warp = threadIdx.x / WARP_SIZE;
  const int lane = threadIdx.x % WARP_SIZE;
  const int group = lane / THREAD_GROUP_SIZE;         // the token of a KV block this lane's group scores
  const int group_offset = lane % THREAD_GROUP_SIZE;  // the lane's half of the head: float4s offset, offset + 2, ...

  // q in registers: this lane's 16 float4s, interleaved with its partner's so the pair reads 32 bytes at once.
  const float4* q4 = reinterpret_cast<const float4*>(q + ((int64_t)seq * num_heads + head) * HEAD_SIZE);
  float4 q_vec[NUM_VECS_PER_THREAD];
#pragma unroll
  for (int i = 0; i < NUM_VECS_PER_THREAD; ++i) q_vec[i] = q4[group_offset + i * THREAD_GROUP_SIZE];

  // 1. Scores. Warp w takes KV blocks w, w + 4, w + 8, ...; inside one, group g scores token g.
  float qk_max = -INFINITY;
  for (int block_idx = warp; block_idx < num_seq_blocks; block_idx += NUM_WARPS) {
    const int64_t physical_block = block_table[block_idx];
    const int token = block_idx * BLOCK_SIZE + group;
    const float4* k4 = reinterpret_cast<const float4*>(k_cache + (physical_block * BLOCK_SIZE + group) * token_stride +
                                                       (int64_t)kv_head * HEAD_SIZE);
    float qk = 0.f;
#pragma unroll
    for (int i = 0; i < NUM_VECS_PER_THREAD; ++i) {
      const float4 k = k4[group_offset + i * THREAD_GROUP_SIZE];
      qk += q_vec[i].x * k.x + q_vec[i].y * k.y + q_vec[i].z * k.z + q_vec[i].w * k.w;
    }
    // Join the two halves. Every lane shuffles, even past the end of the sequence: a shuffle with a full
    // mask must be reached by all 32 lanes.
#pragma unroll
    for (int mask = THREAD_GROUP_SIZE / 2; mask >= 1; mask /= 2) qk += __shfl_xor_sync(0xffffffffu, qk, mask);
    qk *= scale;
    if (token < seq_len) {  // the tail of the last block holds stale slots (NaN in the test)
      if (group_offset == 0) logits[token] = qk;
      qk_max = fmaxf(qk_max, qk);
    }
  }

  // 2. Block-wide max: a butterfly inside each warp, one value per warp through shared memory.
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) qk_max = fmaxf(qk_max, __shfl_xor_sync(0xffffffffu, qk_max, mask));
  if (lane == 0) red_max[warp] = qk_max;
  __syncthreads();  // also makes every logits[] write visible to the whole block
  qk_max = red_max[0];
#pragma unroll
  for (int w = 1; w < NUM_WARPS; ++w) qk_max = fmaxf(qk_max, red_max[w]);

  // 3. exp(score - max) in place, and the block-wide sum (its own buffer: red_max may still be read).
  float exp_sum = 0.f;
  for (int i = threadIdx.x; i < seq_len; i += NUM_THREADS) {
    const float p = __expf(logits[i] - qk_max);
    logits[i] = p;
    exp_sum += p;
  }
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) exp_sum += __shfl_xor_sync(0xffffffffu, exp_sum, mask);
  if (lane == 0) red_sum[warp] = exp_sum;
  __syncthreads();  // also publishes the exponentials
  exp_sum = 0.f;
#pragma unroll
  for (int w = 0; w < NUM_WARPS; ++w) exp_sum += red_sum[w];
  const float inv_sum = 1.f / exp_sum;

  // 4. V: the same split over KV blocks; lane owns head elements lane, lane + 32, lane + 64, lane + 96.
  float acc[V_PER_LANE];
#pragma unroll
  for (int j = 0; j < V_PER_LANE; ++j) acc[j] = 0.f;
  for (int block_idx = warp; block_idx < num_seq_blocks; block_idx += NUM_WARPS) {
    const int64_t physical_block = block_table[block_idx];
    const int tokens_here = min(BLOCK_SIZE, seq_len - block_idx * BLOCK_SIZE);
    for (int t = 0; t < tokens_here; ++t) {
      const float p = logits[block_idx * BLOCK_SIZE + t];
      const float* v_row = v_cache + (physical_block * BLOCK_SIZE + t) * token_stride + (int64_t)kv_head * HEAD_SIZE;
#pragma unroll
      for (int j = 0; j < V_PER_LANE; ++j) acc[j] += p * v_row[lane + j * WARP_SIZE];
    }
  }

  // 5. Add the four warps' partial outputs through shared memory, normalise, write once.
#pragma unroll
  for (int j = 0; j < V_PER_LANE; ++j) out_smem[warp][lane + j * WARP_SIZE] = acc[j];
  __syncthreads();
  for (int i = threadIdx.x; i < HEAD_SIZE; i += NUM_THREADS) {
    float o = 0.f;
#pragma unroll
    for (int w = 0; w < NUM_WARPS; ++w) o += out_smem[w][i];
    out[((int64_t)seq * num_heads + head) * HEAD_SIZE + i] = o * inv_sum;
  }
}
`;

const STARTER_KERNEL = `// Grid (num_heads, num_seqs), NUM_THREADS threads, dynamic shared memory: one float per context token.
// out, q: [num_seqs, num_heads, HEAD_SIZE]. k_cache, v_cache: [num_blocks, BLOCK_SIZE, num_kv_heads, HEAD_SIZE].
// block_tables: [num_seqs, max_num_blocks_per_seq]. seq_lens: [num_seqs].
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v1(float* __restrict__ out, const float* __restrict__ q, const float* __restrict__ k_cache,
                       const float* __restrict__ v_cache, const int* __restrict__ block_tables,
                       const int* __restrict__ seq_lens, int max_num_blocks_per_seq, int num_kv_heads, float scale) {
  // TODO: head = blockIdx.x, seq = blockIdx.y, kv_head = head / (num_heads / num_kv_heads).
  // 1. Load this lane's float4s of q into registers (q_vec), then let warp w walk KV blocks w, w + 4, ...
  //    through block_tables: thread group g (2 lanes) dots token g's key, the halves joined with
  //    __shfl_xor_sync by every lane, then logits[token] = qk * scale for tokens < seq_len.
  // 2. Block max: warp butterfly, red_max[warp], __syncthreads(). 3. logits[i] = __expf(logits[i] - qk_max),
  //    block sum through red_sum. 4. acc[j] += p * V for the warp's blocks. 5. Add the warps' acc through
  //    out_smem[NUM_WARPS][HEAD_SIZE] and write out = sum * (1 / exp_sum).
  (void)out;
  (void)q;
  (void)k_cache;
  (void)v_cache;
  (void)block_tables;
  (void)seq_lens;
  (void)max_num_blocks_per_seq;
  (void)num_kv_heads;
  (void)scale;
}
`;

const HOST = `
// Deterministic inputs: a 32-bit LCG.
struct Lcg {
  uint32_t state;
  uint32_t next_u32() {
    state = state * 1664525u + 1013904223u;
    return state >> 8;
  }
  float uniform() { return (float)next_u32() / (float)(1u << 24) * 2.0f - 1.0f; }  // [-1, 1)
};

// Sequences in the paged cache as the scheduler hands them to attention, and (once filled) their K/V
// in plain contiguous form for the CPU reference.
struct PagedBatch {
  std::vector<int> seq_lens, seq_starts;
  std::vector<int> block_tables;  // [num_seqs, max_num_blocks_per_seq], -1 past a sequence's last block
  int max_num_blocks_per_seq = 0;
  std::vector<int64_t> slot_mapping;      // [total_tokens]
  std::vector<float> k_tokens, v_tokens;  // [total_tokens, NUM_KV_HEADS, HEAD_SIZE]
};

// The block manager's half: each sequence takes blocks from a shuffled free list, so they are scattered.
static PagedBatch allocate_blocks(const std::vector<int>& lens, int num_blocks, Lcg& rng) {
  PagedBatch b;
  b.seq_lens = lens;
  std::vector<int> free_list(num_blocks);
  std::iota(free_list.begin(), free_list.end(), 0);
  for (int i = num_blocks - 1; i > 0; --i) std::swap(free_list[i], free_list[rng.next_u32() % (uint32_t)(i + 1)]);
  int total = 0;
  for (int len : lens) {
    b.seq_starts.push_back(total);
    total += len;
    b.max_num_blocks_per_seq = std::max(b.max_num_blocks_per_seq, (len + BLOCK_SIZE - 1) / BLOCK_SIZE);
  }
  b.block_tables.assign(lens.size() * b.max_num_blocks_per_seq, -1);
  b.slot_mapping.resize(total);
  size_t used = 0;
  for (size_t s = 0; s < lens.size(); ++s)
    for (int p = 0; p < lens[s]; ++p) {
      int& entry = b.block_tables[s * b.max_num_blocks_per_seq + p / BLOCK_SIZE];
      if (p % BLOCK_SIZE == 0) {
        if (used == free_list.size()) {
          fprintf(stderr, "out of KV-cache blocks\\n");
          exit(1);
        }
        entry = free_list[used++];
      }
      b.slot_mapping[b.seq_starts[s] + p] = (int64_t)entry * BLOCK_SIZE + p % BLOCK_SIZE;
    }
  return b;
}

// Random K/V for every token, scattered into the cache by step 1's kernel and kept for the CPU reference.
static void fill_cache(PagedBatch& b, Lcg& rng, float* d_key_cache, float* d_value_cache) {
  const int total = (int)b.slot_mapping.size();
  const size_t n = (size_t)total * NUM_KV_HEADS * HEAD_SIZE;
  b.k_tokens.resize(n);
  b.v_tokens.resize(n);
  for (float& x : b.k_tokens) x = rng.uniform();
  for (float& x : b.v_tokens) x = rng.uniform();
  float *d_k = nullptr, *d_v = nullptr;
  int64_t* d_slots = nullptr;
  CUDA_CHECK(cudaMalloc(&d_k, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_v, n * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_slots, total * sizeof(int64_t)));
  CUDA_CHECK(cudaMemcpy(d_k, b.k_tokens.data(), n * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_v, b.v_tokens.data(), n * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_slots, b.slot_mapping.data(), total * sizeof(int64_t), cudaMemcpyHostToDevice));
  CUDA_LAUNCH(reshape_and_cache, dim3(total), dim3(512), 0, d_k, d_v, d_key_cache, d_value_cache, d_slots,
              NUM_KV_HEADS, HEAD_SIZE, BLOCK_SIZE);
  CUDA_CHECK(cudaDeviceSynchronize());
  CUDA_CHECK(cudaFree(d_k));
  CUDA_CHECK(cudaFree(d_v));
  CUDA_CHECK(cudaFree(d_slots));
}

// Double-precision attention over each sequence's contiguous K/V: no blocks, no tables, no shuffles.
static void attention_cpu(const PagedBatch& b, const std::vector<float>& q, int num_heads, float scale,
                          std::vector<float>& out, double& max_logit) {
  const int group = num_heads / NUM_KV_HEADS;
  for (size_t s = 0; s < b.seq_lens.size(); ++s)
    for (int h = 0; h < num_heads; ++h) {
      const float* qh = &q[(s * num_heads + h) * HEAD_SIZE];
      const int kvh = h / group;
      const int len = b.seq_lens[s];
      std::vector<double> p(len);
      double mx = -INFINITY;
      for (int t = 0; t < len; ++t) {
        const float* k = &b.k_tokens[((size_t)(b.seq_starts[s] + t) * NUM_KV_HEADS + kvh) * HEAD_SIZE];
        double dot = 0.0;
        for (int d = 0; d < HEAD_SIZE; ++d) dot += (double)qh[d] * (double)k[d];
        p[t] = dot * scale;
        mx = std::max(mx, p[t]);
      }
      max_logit = std::max(max_logit, mx);
      double sum = 0.0;
      for (int t = 0; t < len; ++t) sum += (p[t] = std::exp(p[t] - mx));
      for (int d = 0; d < HEAD_SIZE; ++d) {
        double acc = 0.0;
        for (int t = 0; t < len; ++t)
          acc += p[t] * (double)b.v_tokens[((size_t)(b.seq_starts[s] + t) * NUM_KV_HEADS + kvh) * HEAD_SIZE + d];
        out[(s * num_heads + h) * HEAD_SIZE + d] = (float)(acc / sum);
      }
    }
}

int main() {
  const int num_heads = 32;
  const float scale = 1.0f / sqrtf((float)HEAD_SIZE);
  const int num_blocks = 512;  // the cache: 512 blocks x 16 slots x 8 KV heads x 128 floats, 32 MiB each for K and V
  // One token, a partial block, exactly one block, one past it, and longer contexts that leave some warps a block short.
  const std::vector<int> lens = {1, 15, 16, 17, 100, 513, 1000, 2047};
  const int num_seqs = (int)lens.size();
  Lcg rng{2024u};

  const size_t cache_bytes = (size_t)num_blocks * BLOCK_SIZE * NUM_KV_HEADS * HEAD_SIZE * sizeof(float);
  float *d_key_cache = nullptr, *d_value_cache = nullptr;
  CUDA_CHECK(cudaMalloc(&d_key_cache, cache_bytes));
  CUDA_CHECK(cudaMalloc(&d_value_cache, cache_bytes));
  CUDA_CHECK(cudaMemset(d_key_cache, 0xFF, cache_bytes));  // unused slots are NaN: reading one poisons the output
  CUDA_CHECK(cudaMemset(d_value_cache, 0xFF, cache_bytes));
  PagedBatch batch = allocate_blocks(lens, num_blocks, rng);
  fill_cache(batch, rng, d_key_cache, d_value_cache);

  // Queries: the last sequence's are 100x larger, so its logits pass 88, where expf overflows float.
  std::vector<float> h_q((size_t)num_seqs * num_heads * HEAD_SIZE);
  for (size_t i = 0; i < h_q.size(); ++i) {
    const bool loud = i / ((size_t)num_heads * HEAD_SIZE) == (size_t)num_seqs - 1;
    h_q[i] = rng.uniform() * (loud ? 100.0f : 1.0f);
  }

  float *d_q = nullptr, *d_out = nullptr;
  int *d_block_tables = nullptr, *d_seq_lens = nullptr;
  const size_t q_bytes = h_q.size() * sizeof(float);
  CUDA_CHECK(cudaMalloc(&d_q, q_bytes));
  CUDA_CHECK(cudaMalloc(&d_out, q_bytes));
  CUDA_CHECK(cudaMalloc(&d_block_tables, batch.block_tables.size() * sizeof(int)));
  CUDA_CHECK(cudaMalloc(&d_seq_lens, lens.size() * sizeof(int)));
  CUDA_CHECK(cudaMemcpy(d_q, h_q.data(), q_bytes, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_block_tables, batch.block_tables.data(), batch.block_tables.size() * sizeof(int),
                        cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_seq_lens, lens.data(), lens.size() * sizeof(int), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(d_out, 0, q_bytes));

  const int max_len = *std::max_element(lens.begin(), lens.end());
  const size_t smem = (size_t)((max_len + BLOCK_SIZE - 1) / BLOCK_SIZE * BLOCK_SIZE) * sizeof(float);
  const dim3 grid(num_heads, num_seqs);
  CUDA_LAUNCH(paged_attention_v1, grid, dim3(NUM_THREADS), smem, d_out, d_q, d_key_cache, d_value_cache,
              d_block_tables, d_seq_lens, batch.max_num_blocks_per_seq, NUM_KV_HEADS, scale);
  CUDA_CHECK(cudaDeviceSynchronize());
  std::vector<float> h_out(h_q.size()), ref(h_q.size());
  CUDA_CHECK(cudaMemcpy(h_out.data(), d_out, q_bytes, cudaMemcpyDeviceToHost));

  double max_logit = -INFINITY;
  attention_cpu(batch, h_q, num_heads, scale, ref, max_logit);
  bool ok = true;
  for (int s = 0; s < num_seqs; ++s) {
    float err = 0.0f;
    for (size_t i = (size_t)s * num_heads * HEAD_SIZE; i < (size_t)(s + 1) * num_heads * HEAD_SIZE; ++i) {
      const float e = fabsf(h_out[i] - ref[i]);
      if (!(e < 1e-3f)) ok = false;  // also catches NaN
      err = fmaxf(err, std::isnan(e) ? INFINITY : e);
    }
    printf("seq %d  len %5d  blocks %3d  max|err| = %.2e\\n", s, lens[s], (lens[s] + BLOCK_SIZE - 1) / BLOCK_SIZE, err);
  }
  printf("largest logit %.1f (expf overflows past 88.7: the max is subtracted first)\\n", max_logit);

  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  const int reps = 20;
  CUDA_CHECK(cudaEventRecord(t0));
  for (int r = 0; r < reps; ++r)
    CUDA_LAUNCH(paged_attention_v1, grid, dim3(NUM_THREADS), smem, d_out, d_q, d_key_cache, d_value_cache,
                d_block_tables, d_seq_lens, batch.max_num_blocks_per_seq, NUM_KV_HEADS, scale);
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  ms /= reps;
  const double kv_bytes = 2.0 * std::accumulate(lens.begin(), lens.end(), 0.0) * NUM_KV_HEADS * HEAD_SIZE * sizeof(float);
  printf("timing: %d blocks of %d threads, %zu bytes of shared logits each, %.4f ms, %.1f GB/s of K/V\\n",
         num_heads * num_seqs, NUM_THREADS, smem, ms, kv_bytes / (ms * 1e-3) / 1e9);

  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  for (void* p : {(void*)d_key_cache, (void*)d_value_cache, (void*)d_q, (void*)d_out, (void*)d_block_tables,
                  (void*)d_seq_lens})
    CUDA_CHECK(cudaFree(p));
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`;

export const pagedAttentionV1Step: Step = {
  id: 'paged-attention-v1',
  title: 'paged_attention_v1: one block per sequence and head',
  concept: 'cuda',
  file: 'paged_attention_v1',
  focus: ['v1-warps', 'v1-q', 'v1-acc', 'v1-logits', 'v1-red', 'v1-out-smem', 'v1-table', 'v1-out'],
  task: `## Task

At a decode step every running sequence has one new query per head, and it attends to every token in its
KV cache, which lives in blocks scattered over the pool. Write vLLM's first kernel for it:

\`\`\`cuda
__global__ void paged_attention_v1(float* out, const float* q, const float* k_cache, const float* v_cache,
                                   const int* block_tables, const int* seq_lens, int max_num_blocks_per_seq,
                                   int num_kv_heads, float scale);
\`\`\`

- **Shapes.** \`q\`, \`out\`: \`[num_seqs, num_heads, HEAD_SIZE]\`; \`k_cache\`, \`v_cache\`: \`[num_blocks, BLOCK_SIZE,
  num_kv_heads, HEAD_SIZE]\` (step 1's layout); \`block_tables\`: \`[num_seqs, max_num_blocks_per_seq]\` \`int\`;
  \`seq_lens\`: \`[num_seqs]\`. Given: \`HEAD_SIZE = 128\`, \`BLOCK_SIZE = 16\`, \`NUM_THREADS = 128\` (4 warps),
  \`THREAD_GROUP_SIZE = 2\`, \`NUM_VECS_PER_THREAD = 16\`, \`V_PER_LANE = 4\`; \`scale = 1/√128\`.
- **Grid.** \`dim3(num_heads, num_seqs)\`: \`head = blockIdx.x\`, \`seq = blockIdx.y\`, \`num_heads = gridDim.x\`.
  Grouped-query attention: \`kv_head = head / (num_heads / num_kv_heads)\`, so query heads 0 … 3 read KV head 0.
- **q in registers.** Lane \`lane\` is in thread group \`group = lane / 2\` with \`group_offset = lane % 2\`, and
  holds half the head as \`float4 q_vec[16]\`: \`q_vec[i]\` is float4 number \`group_offset + 2i\` of the query.
- **Scores.** Warp \`w\` walks logical blocks \`w, w + 4, w + 8, …\` below \`⌈seq_len / 16⌉\`, with
  \`physical_block = block_tables[seq][block_idx]\` as \`int64_t\`. In a block, group \`g\` scores token
  \`block_idx × 16 + g\`: a 64-element partial dot per lane from \`float4\` loads, joined by
  \`qk += __shfl_xor_sync(0xffffffff, qk, 1)\`, times \`scale\`. **Every lane shuffles**; only tokens below
  \`seq_len\` then store \`logits[token]\` (group offset 0) and fold into \`qk_max\`, because the tail of the
  last block holds stale slots (NaN in the test).
- **Logits in shared memory.** \`extern __shared__ float logits[]\`, one float per token; the host passes
  \`⌈max_len / 16⌉ × 16 × 4\` bytes.
- **Max and sum across the block.** \`qk_max\`: an XOR butterfly over 32 lanes with \`fmaxf\`, lane 0 writes
  \`red_max[warp]\`, \`__syncthreads()\`, every thread folds the four. Then \`logits[i] = __expf(logits[i] − qk_max)\`
  for \`i = threadIdx.x; i < seq_len; i += NUM_THREADS\`, summed the same way through a **separate**
  \`red_sum[NUM_WARPS]\`.
- **V.** The same warp split over blocks; lane owns channels \`lane + 32j\`, \`j < 4\`, and adds
  \`acc[j] += p * v_row[lane + 32j]\` for every token of the block below \`seq_len\`. Then
  \`out_smem[warp][lane + 32j] = acc[j]\`, \`__syncthreads()\`, and thread \`i\` writes
  \`out[seq][head][i] = (Σ_w out_smem[w][i]) × inv_sum\`, \`inv_sum = 1 / exp_sum\`.
- **Forbidden:** copying a sequence's K/V into a contiguous buffer, cuBLAS, cuDNN, FlashAttention, FlashInfer.
- The file ends with the given \`main()\`: step 1's kernel fills a NaN-initialised pool of 512 blocks for
  eight sequences of 1, 15, 16, 17, 100, 513, 1,000 and 2,047 tokens; 32 query heads; the last sequence's
  queries are 100× larger, so its logits pass 88, where \`expf\` overflows float. Every output must be within
  \`1e-3\` of a double-precision CPU attention over contiguous K/V; then a \`cudaEvent\` timing and \`PASS\`.

The butterfly that every reduction here uses, lane by lane:

:::widget warp-reduce

> One query against a whole context is a dot product per token and a weighted sum of rows. The work is
> getting those rows out of scattered blocks at full bandwidth, and four warps agreeing on one max and
> one sum.`,
  hints: [
    'Lay the kernel out as five phases: q into registers; the score loop `for (int block_idx = warp; block_idx < num_seq_blocks; block_idx += NUM_WARPS)`; the max; the exponentials and the sum; the V loop with the same bounds; the cross-warp add. Only the two reductions and the final add need `__syncthreads()`.',
    'Token `g` of a block has its key at `k_cache + (physical_block * BLOCK_SIZE + g) * num_kv_heads * HEAD_SIZE + kv_head * HEAD_SIZE`; read it as `float4` number `group_offset + i * THREAD_GROUP_SIZE` so the two lanes of a group load 32 contiguous bytes. Token `t`’s V row is the same address in `v_cache` with `t` for `g`.',
    'The barrier after `red_max[warp] = …` also publishes every `logits[]` store, and the one after `red_sum[warp] = …` publishes the exponentials. Keep `red_max` and `red_sum` apart: with one array a fast warp overwrites a slot with its sum while a slow warp is still reading the maxima.',
  ],
  checks: [
    {
      id: 'grid-and-gqa',
      title: 'One block per (head, sequence), its KV head by GQA',
      detail:
        'Expected `head = blockIdx.x`, `seq = blockIdx.y` and `kv_head = head / (num_heads / num_kv_heads)`: decode has one query per head, and four query heads share each of the 8 KV heads.',
      match: {
        cuda: {
          all: [/=\s*blockIdx\.x\s*;/, /=\s*blockIdx\.y\s*;/, /\w+\s*\/\s*\(\s*num_heads\s*\/\s*num_kv_heads\s*\)/],
        },
      },
    },
    {
      id: 'block-table-walk',
      title: 'Warps walk the KV blocks through the block table',
      detail:
        'Expected a loop starting at the warp index and stepping by `NUM_WARPS`, reading `block_table[block_idx]` for the physical block: the sequence is never contiguous, so every K and V address goes through the table.',
      match: {
        cuda: {
          all: [
            /for\s*\(\s*int\s+\w+\s*=\s*warp\w*\s*;[^;]*;\s*\w+\s*\+=\s*NUM_WARPS\s*\)/,
            /=\s*block_table\w*\s*\[[^\]]+\]\s*;/,
          ],
        },
      },
    },
    {
      id: 'qk-shuffle',
      title: 'q·k per token from registers, joined by a full-warp shuffle',
      detail:
        'Expected `q_vec[…]` in registers, `qk += __shfl_xor_sync(0xffffffff, qk, …)` reached by every lane, and only then the `token < seq_len` test that stores `logits[token]`: a full-mask shuffle that some lanes skip is undefined behaviour.',
      match: {
        cuda: {
          all: [/float4\s+q_vec\s*\[/, /logits\s*\[[^\]]+\]\s*=\s*qk\b/],
          order: [/\+=\s*__shfl_xor_sync\s*\(\s*0xffffffffu?\s*,\s*qk\s*,/, /if\s*\(\s*token\s*<\s*seq_len\s*\)/],
        },
      },
    },
    {
      id: 'shared-logits',
      title: 'Logits in dynamic shared memory, exponentiated against the max',
      detail:
        'Expected `extern __shared__ float logits[]` and `__expf(logits[i] - qk_max)` stored back in place: the whole context’s scores stay on chip, and subtracting the max keeps `__expf` finite when logits pass 88.',
      match: {
        cuda: {
          all: [
            /extern\s+__shared__\s+float\s+logits\s*\[\s*\]/,
            /__expf\s*\(\s*logits\s*\[[^\]]+\]\s*-\s*qk_max\s*\)/,
          ],
        },
      },
    },
    {
      id: 'block-reductions',
      title: 'Max and sum reduced across the block with separate buffers',
      detail:
        'Expected `fmaxf(qk_max, __shfl_xor_sync(…))`, then `red_max[warp] = …`, `__syncthreads()`, `red_sum[warp] = …`, `__syncthreads()`, with `__shared__ float red_max[NUM_WARPS]` and `red_sum[NUM_WARPS]` as two arrays: one buffer for both races between warps.',
      match: {
        cuda: {
          all: [
            /__shared__\s+float\s+red_max\s*\[\s*NUM_WARPS\s*\]/,
            /__shared__\s+float\s+red_sum\s*\[\s*NUM_WARPS\s*\]/,
            /fmaxf\s*\(\s*qk_max\s*,\s*__shfl_xor_sync\s*\(/,
          ],
          order: [
            /red_max\s*\[\s*warp\w*\s*\]\s*=/,
            /__syncthreads\s*\(\s*\)/,
            /red_sum\s*\[\s*warp\w*\s*\]\s*=/,
            /__syncthreads\s*\(\s*\)/,
          ],
        },
      },
    },
    {
      id: 'v-accumulate',
      title: 'V weighted by the probabilities, warps added once',
      detail:
        'Expected `acc[j] += p * v_row[…]`, the partial sums in `__shared__ float out_smem[NUM_WARPS][HEAD_SIZE]`, and one store `out[…] = … * inv_sum`: each warp covers a quarter of the blocks, so the four partial outputs meet in shared memory and are normalised once.',
      match: {
        cuda: {
          all: [
            /acc\w*\s*\[[^\]]+\]\s*\+=\s*\w+\s*\*\s*v\w*\s*\[/,
            /__shared__\s+float\s+out_smem\s*\[\s*NUM_WARPS\s*\]\s*\[\s*HEAD_SIZE\s*\]/,
            /\bout\s*\[[^\]]+\]\s*=\s*\w+\s*\*\s*inv_sum/,
          ],
          none: [/cublas/i, /cudnn/i, /flash_?attn|flashinfer/i],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `${HEADER}${STARTER_KERNEL}${HOST}`,
      solution: `${HEADER}${SOLUTION_KERNEL}${HOST}`,
    },
  },
  debrief: `Every choice in the kernel follows from decode having one query per head. One thread block per (head, sequence) is the natural unit, and it must see the whole context, because a softmax needs one max and one sum over every token; the scores therefore live in shared memory, which is why v1's context is bounded by it (vLLM switches to v2 past 8,192 tokens). The warp-per-KV-block split comes from the paper's kernel, adapted from FasterTransformer: a warp has 32 lanes and a block 16 tokens, so thread groups of 2 lanes score all 16 keys at once, each lane holding half of \`q\` in registers and loading its half of a key as 16-byte vectors; one \`__shfl_xor_sync\` joins the halves. The shuffle carries a full mask, so it sits outside the \`token < seq_len\` test, and the test also keeps the stale tail of the last block (NaN here) out of the max. The reductions are the classic two-level shape (butterfly in registers, one value per warp in shared memory, a barrier), with separate buffers for max and sum because the second write would race the first read. Splitting the warps over keys is what FlashAttention-2's paper calls the "split-K" scheme: with a single query there are no query rows to hand out, so the warps take a quarter of the keys each and pay with the final \`out_smem\` exchange. GQA adds nothing to the kernel: the four blocks of one KV head read the same rows, and when they run close together the repeats are served from L2. vLLM's production version keeps this structure and changes the arithmetic: fp16 or bf16 inputs whose dot products accumulate in fp32, the \`x\`-split K layout and transposed V from step 1's debrief, logits normalised in place before the V pass, fp8 KV with scales, ALiBi biases, and block-sparse masks. Newer vLLM backends hand the same block table to FlashAttention or FlashInfer kernels instead.`,
};
