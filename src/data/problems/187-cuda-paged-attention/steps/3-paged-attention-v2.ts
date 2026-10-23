import type {Step} from '@/lib/types';

/**
 * Step 3 of the PagedAttention kernels: paged_attention_v2, the context split into 512-token partitions
 * with partial max, exp-sum and output per partition, and the reduce kernel that rescales and combines
 * them. The header carries steps 1 and 2; the comparison against v1 and the CPU, the long-context timing
 * and the PASS check are the same in starter and solution.
 */
const HEADER = `// vLLM's paged_attention_v2: the context of each sequence is split into 512-token partitions, one
// thread block per (head, sequence, partition), each writing a partial max, exp-sum and output; a
// reduce kernel rescales the partials by exp(m_p - m) and combines them. Same answer as v1, and the
// GPU stays full when a few long sequences would leave most SMs idle under v1. Float storage; GQA.
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
constexpr int PARTITION_SIZE = 512;                // tokens per partition, vLLM's
constexpr int BLOCKS_PER_PARTITION = PARTITION_SIZE / BLOCK_SIZE;
static_assert(WARP_SIZE % BLOCK_SIZE == 0, "a warp scores a whole KV block at once");
static_assert(HEAD_SIZE % (THREAD_GROUP_SIZE * 4) == 0 && HEAD_SIZE % WARP_SIZE == 0, "head size");
static_assert(PARTITION_SIZE % BLOCK_SIZE == 0, "a partition is whole KV blocks");

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

// Step 2. Grid (num_heads, num_seqs), NUM_THREADS threads, dynamic shared memory: one float per context token.
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

const SOLUTION_KERNEL = `// Grid (num_heads, num_seqs, max_num_partitions), NUM_THREADS threads, no dynamic shared memory.
// exp_sums, max_logits: [num_seqs, num_heads, max_num_partitions].
// tmp_out: [num_seqs, num_heads, max_num_partitions, HEAD_SIZE], each row normalised by its own exp-sum.
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v2(float* __restrict__ exp_sums, float* __restrict__ max_logits, float* __restrict__ tmp_out,
                       const float* __restrict__ q, const float* __restrict__ k_cache,
                       const float* __restrict__ v_cache, const int* __restrict__ block_tables,
                       const int* __restrict__ seq_lens, int max_num_blocks_per_seq, int num_kv_heads, float scale) {
  __shared__ float logits[PARTITION_SIZE];  // this partition's scores, then exp(score - m_p)
  __shared__ float red_max[NUM_WARPS];
  __shared__ float red_sum[NUM_WARPS];
  __shared__ float out_smem[NUM_WARPS][HEAD_SIZE];

  const int head = blockIdx.x;
  const int seq = blockIdx.y;
  const int partition = blockIdx.z;
  const int num_heads = gridDim.x;
  const int max_num_partitions = gridDim.z;
  const int seq_len = seq_lens[seq];
  // The grid is sized for the longest sequence: a partition past this one's end has nothing to do. The test
  // reads only blockIdx and seq_lens, so the whole block leaves together, before any barrier.
  if (partition * PARTITION_SIZE >= seq_len) return;

  const int num_seq_blocks = (seq_len + BLOCK_SIZE - 1) / BLOCK_SIZE;
  const int start_block = partition * BLOCKS_PER_PARTITION;
  const int end_block = min(start_block + BLOCKS_PER_PARTITION, num_seq_blocks);
  const int start_token = start_block * BLOCK_SIZE;
  const int end_token = min(start_token + PARTITION_SIZE, seq_len);
  const int num_tokens = end_token - start_token;

  const int kv_head = head / (num_heads / num_kv_heads);
  const int* block_table = block_tables + (int64_t)seq * max_num_blocks_per_seq;
  const int64_t token_stride = (int64_t)num_kv_heads * HEAD_SIZE;
  const int warp = threadIdx.x / WARP_SIZE;
  const int lane = threadIdx.x % WARP_SIZE;
  const int group = lane / THREAD_GROUP_SIZE;
  const int group_offset = lane % THREAD_GROUP_SIZE;

  const float4* q4 = reinterpret_cast<const float4*>(q + ((int64_t)seq * num_heads + head) * HEAD_SIZE);
  float4 q_vec[NUM_VECS_PER_THREAD];
#pragma unroll
  for (int i = 0; i < NUM_VECS_PER_THREAD; ++i) q_vec[i] = q4[group_offset + i * THREAD_GROUP_SIZE];

  // 1. Scores for this partition's KV blocks only; logits are indexed from the partition's first token.
  float qk_max = -INFINITY;
  for (int block_idx = start_block + warp; block_idx < end_block; block_idx += NUM_WARPS) {
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
#pragma unroll
    for (int mask = THREAD_GROUP_SIZE / 2; mask >= 1; mask /= 2) qk += __shfl_xor_sync(0xffffffffu, qk, mask);
    qk *= scale;
    if (token < seq_len) {
      if (group_offset == 0) logits[token - start_token] = qk;
      qk_max = fmaxf(qk_max, qk);
    }
  }

  // 2. The partition's max m_p.
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) qk_max = fmaxf(qk_max, __shfl_xor_sync(0xffffffffu, qk_max, mask));
  if (lane == 0) red_max[warp] = qk_max;
  __syncthreads();
  qk_max = red_max[0];
#pragma unroll
  for (int w = 1; w < NUM_WARPS; ++w) qk_max = fmaxf(qk_max, red_max[w]);

  // 3. The partition's exp-sum l_p = sum of exp(score - m_p).
  float exp_sum = 0.f;
  for (int i = threadIdx.x; i < num_tokens; i += NUM_THREADS) {
    const float p = __expf(logits[i] - qk_max);
    logits[i] = p;
    exp_sum += p;
  }
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) exp_sum += __shfl_xor_sync(0xffffffffu, exp_sum, mask);
  if (lane == 0) red_sum[warp] = exp_sum;
  __syncthreads();
  exp_sum = 0.f;
#pragma unroll
  for (int w = 0; w < NUM_WARPS; ++w) exp_sum += red_sum[w];
  const float inv_sum = 1.f / exp_sum;

  // 4. V over the partition's tokens.
  float acc[V_PER_LANE];
#pragma unroll
  for (int j = 0; j < V_PER_LANE; ++j) acc[j] = 0.f;
  for (int block_idx = start_block + warp; block_idx < end_block; block_idx += NUM_WARPS) {
    const int64_t physical_block = block_table[block_idx];
    const int tokens_here = min(BLOCK_SIZE, seq_len - block_idx * BLOCK_SIZE);
    for (int t = 0; t < tokens_here; ++t) {
      const float p = logits[block_idx * BLOCK_SIZE + t - start_token];
      const float* v_row = v_cache + (physical_block * BLOCK_SIZE + t) * token_stride + (int64_t)kv_head * HEAD_SIZE;
#pragma unroll
      for (int j = 0; j < V_PER_LANE; ++j) acc[j] += p * v_row[lane + j * WARP_SIZE];
    }
  }

  // 5. The partials: m_p, l_p and the output o_p normalised by l_p.
#pragma unroll
  for (int j = 0; j < V_PER_LANE; ++j) out_smem[warp][lane + j * WARP_SIZE] = acc[j];
  __syncthreads();
  const int64_t row = ((int64_t)seq * num_heads + head) * max_num_partitions + partition;
  if (threadIdx.x == 0) {
    max_logits[row] = qk_max;
    exp_sums[row] = exp_sum;
  }
  for (int i = threadIdx.x; i < HEAD_SIZE; i += NUM_THREADS) {
    float o = 0.f;
#pragma unroll
    for (int w = 0; w < NUM_WARPS; ++w) o += out_smem[w][i];
    tmp_out[row * HEAD_SIZE + i] = o * inv_sum;
  }
}

// Grid (num_heads, num_seqs), NUM_THREADS threads, dynamic shared memory: max_num_partitions floats.
// out: [num_seqs, num_heads, HEAD_SIZE]; the partials as paged_attention_v2 wrote them.
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v2_reduce(float* __restrict__ out, const float* __restrict__ exp_sums,
                              const float* __restrict__ max_logits, const float* __restrict__ tmp_out,
                              const int* __restrict__ seq_lens, int max_num_partitions) {
  extern __shared__ float weights[];  // [num_partitions]: l_p * exp(m_p - m)
  __shared__ float red_max[NUM_WARPS];
  __shared__ float red_sum[NUM_WARPS];

  const int head = blockIdx.x;
  const int seq = blockIdx.y;
  const int num_heads = gridDim.x;
  const int seq_len = seq_lens[seq];
  const int num_partitions = (seq_len + PARTITION_SIZE - 1) / PARTITION_SIZE;
  const int64_t row0 = ((int64_t)seq * num_heads + head) * max_num_partitions;
  const float* partial = tmp_out + row0 * HEAD_SIZE;
  float* o = out + ((int64_t)seq * num_heads + head) * HEAD_SIZE;

  if (num_partitions == 1) {  // one partition is already the answer
    for (int i = threadIdx.x; i < HEAD_SIZE; i += NUM_THREADS) o[i] = partial[i];
    return;
  }
  const int warp = threadIdx.x / WARP_SIZE;
  const int lane = threadIdx.x % WARP_SIZE;

  // The global max m over the partitions' maxima; partitions past this sequence's end are never read.
  float m = -INFINITY;
  for (int p = threadIdx.x; p < num_partitions; p += NUM_THREADS) m = fmaxf(m, max_logits[row0 + p]);
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) m = fmaxf(m, __shfl_xor_sync(0xffffffffu, m, mask));
  if (lane == 0) red_max[warp] = m;
  __syncthreads();
  m = red_max[0];
#pragma unroll
  for (int w = 1; w < NUM_WARPS; ++w) m = fmaxf(m, red_max[w]);

  // Each partition's weight is its exp-sum re-expressed under m; the total is the softmax denominator.
  float total = 0.f;
  for (int p = threadIdx.x; p < num_partitions; p += NUM_THREADS) {
    const float w = exp_sums[row0 + p] * expf(max_logits[row0 + p] - m);
    weights[p] = w;
    total += w;
  }
#pragma unroll
  for (int mask = WARP_SIZE / 2; mask >= 1; mask /= 2) total += __shfl_xor_sync(0xffffffffu, total, mask);
  if (lane == 0) red_sum[warp] = total;
  __syncthreads();  // also publishes weights[]
  total = 0.f;
#pragma unroll
  for (int w = 0; w < NUM_WARPS; ++w) total += red_sum[w];
  const float inv_total = 1.f / total;

  // out = sum_p o_p * l_p * exp(m_p - m) / sum_p l_p * exp(m_p - m).
  for (int i = threadIdx.x; i < HEAD_SIZE; i += NUM_THREADS) {
    float acc = 0.f;
    for (int p = 0; p < num_partitions; ++p) acc += partial[(int64_t)p * HEAD_SIZE + i] * weights[p];
    o[i] = acc * inv_total;
  }
}
`;

const STARTER_KERNEL = `// Grid (num_heads, num_seqs, max_num_partitions), NUM_THREADS threads, no dynamic shared memory.
// exp_sums, max_logits: [num_seqs, num_heads, max_num_partitions].
// tmp_out: [num_seqs, num_heads, max_num_partitions, HEAD_SIZE], each row normalised by its own exp-sum.
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v2(float* __restrict__ exp_sums, float* __restrict__ max_logits, float* __restrict__ tmp_out,
                       const float* __restrict__ q, const float* __restrict__ k_cache,
                       const float* __restrict__ v_cache, const int* __restrict__ block_tables,
                       const int* __restrict__ seq_lens, int max_num_blocks_per_seq, int num_kv_heads, float scale) {
  // TODO: partition = blockIdx.z; return when partition * PARTITION_SIZE >= seq_len. Otherwise run
  // paged_attention_v1's body over KV blocks [start_block, end_block) of this partition only, with
  // __shared__ float logits[PARTITION_SIZE] indexed by token - start_token, and write the partials:
  // max_logits[row] = qk_max, exp_sums[row] = exp_sum and tmp_out[row * HEAD_SIZE + i] = o * inv_sum.
  (void)exp_sums;
  (void)max_logits;
  (void)tmp_out;
  (void)q;
  (void)k_cache;
  (void)v_cache;
  (void)block_tables;
  (void)seq_lens;
  (void)max_num_blocks_per_seq;
  (void)num_kv_heads;
  (void)scale;
}

// Grid (num_heads, num_seqs), NUM_THREADS threads, dynamic shared memory: max_num_partitions floats.
// out: [num_seqs, num_heads, HEAD_SIZE]; the partials as paged_attention_v2 wrote them.
__global__ void __launch_bounds__(NUM_THREADS)
    paged_attention_v2_reduce(float* __restrict__ out, const float* __restrict__ exp_sums,
                              const float* __restrict__ max_logits, const float* __restrict__ tmp_out,
                              const int* __restrict__ seq_lens, int max_num_partitions) {
  // TODO: copy tmp_out when num_partitions == 1. Otherwise find m = max of max_logits over the sequence's
  // partitions, weigh each partition by weights[p] = exp_sums[p] * expf(max_logits[p] - m) in
  // extern __shared__ float weights[], sum them, and write out[i] = sum_p tmp_out[p][i] * weights[p] / total.
  (void)out;
  (void)exp_sums;
  (void)max_logits;
  (void)tmp_out;
  (void)seq_lens;
  (void)max_num_partitions;
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

// A batch's block tables and lengths on the device.
struct DeviceBatch {
  int* block_tables = nullptr;
  int* seq_lens = nullptr;
  int num_seqs = 0, max_len = 0, max_num_blocks_per_seq = 0;
};

static DeviceBatch upload(const PagedBatch& b) {
  DeviceBatch d;
  d.num_seqs = (int)b.seq_lens.size();
  d.max_len = *std::max_element(b.seq_lens.begin(), b.seq_lens.end());
  d.max_num_blocks_per_seq = b.max_num_blocks_per_seq;
  CUDA_CHECK(cudaMalloc(&d.block_tables, b.block_tables.size() * sizeof(int)));
  CUDA_CHECK(cudaMalloc(&d.seq_lens, b.seq_lens.size() * sizeof(int)));
  CUDA_CHECK(cudaMemcpy(d.block_tables, b.block_tables.data(), b.block_tables.size() * sizeof(int),
                        cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d.seq_lens, b.seq_lens.data(), b.seq_lens.size() * sizeof(int), cudaMemcpyHostToDevice));
  return d;
}

static void release(DeviceBatch& d) {
  CUDA_CHECK(cudaFree(d.block_tables));
  CUDA_CHECK(cudaFree(d.seq_lens));
}

static int partitions_for(int len) { return (len + PARTITION_SIZE - 1) / PARTITION_SIZE; }

// v1: one launch, the longest sequence's logits in shared memory.
static void run_v1(float* d_out, const float* d_q, const float* d_key_cache, const float* d_value_cache,
                   const DeviceBatch& b, int num_heads, float scale) {
  const size_t smem = (size_t)((b.max_len + BLOCK_SIZE - 1) / BLOCK_SIZE * BLOCK_SIZE) * sizeof(float);
  CUDA_LAUNCH(paged_attention_v1, dim3(num_heads, b.num_seqs), dim3(NUM_THREADS), smem, d_out, d_q, d_key_cache,
              d_value_cache, b.block_tables, b.seq_lens, b.max_num_blocks_per_seq, NUM_KV_HEADS, scale);
}

// v2: the partition kernel over (heads, sequences, partitions), then the reduce over (heads, sequences).
struct Partials {
  float* exp_sums = nullptr;
  float* max_logits = nullptr;
  float* tmp_out = nullptr;
};

static void run_v2(float* d_out, const Partials& part, const float* d_q, const float* d_key_cache,
                   const float* d_value_cache, const DeviceBatch& b, int num_heads, float scale) {
  const int max_num_partitions = partitions_for(b.max_len);
  CUDA_LAUNCH(paged_attention_v2, dim3(num_heads, b.num_seqs, max_num_partitions), dim3(NUM_THREADS), 0,
              part.exp_sums, part.max_logits, part.tmp_out, d_q, d_key_cache, d_value_cache, b.block_tables,
              b.seq_lens, b.max_num_blocks_per_seq, NUM_KV_HEADS, scale);
  CUDA_LAUNCH(paged_attention_v2_reduce, dim3(num_heads, b.num_seqs), dim3(NUM_THREADS),
              max_num_partitions * sizeof(float), d_out, part.exp_sums, part.max_logits, part.tmp_out, b.seq_lens,
              max_num_partitions);
}

template <typename Launch>
static float mean_ms(Launch launch, int reps) {
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  launch();  // warm-up
  CUDA_CHECK(cudaEventRecord(t0));
  for (int r = 0; r < reps; ++r) launch();
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  return ms / reps;
}

static float max_abs_diff(const std::vector<float>& a, const std::vector<float>& b) {
  float err = 0.0f;
  for (size_t i = 0; i < a.size(); ++i) {
    const float e = fabsf(a[i] - b[i]);
    err = fmaxf(err, std::isnan(e) ? INFINITY : e);
  }
  return err;
}

int main() {
  const int num_heads = 32;
  const float scale = 1.0f / sqrtf((float)HEAD_SIZE);
  const int num_blocks = 2048;  // 32,768 slots x 8 KV heads x 128 floats: 128 MiB each for K and V
  Lcg rng{2025u};

  // Under one partition, exactly one, one token into a second, and long contexts of 4 and 12 partitions.
  const std::vector<int> lens = {1, 511, 512, 513, 2000, 6000};
  const int num_seqs = (int)lens.size();
  struct Case {
    int seqs, context;
  };
  const std::vector<Case> cases = {{1, 2048}, {1, 8192}, {4, 8192}, {32, 1024}};

  const size_t cache_bytes = (size_t)num_blocks * BLOCK_SIZE * NUM_KV_HEADS * HEAD_SIZE * sizeof(float);
  float *d_key_cache = nullptr, *d_value_cache = nullptr;
  CUDA_CHECK(cudaMalloc(&d_key_cache, cache_bytes));
  CUDA_CHECK(cudaMalloc(&d_value_cache, cache_bytes));
  CUDA_CHECK(cudaMemset(d_key_cache, 0xFF, cache_bytes));  // unused slots are NaN
  CUDA_CHECK(cudaMemset(d_value_cache, 0xFF, cache_bytes));

  // Scratch for the largest run: one row per (sequence, head, partition), one output per (sequence, head).
  size_t rows = (size_t)num_seqs * num_heads * partitions_for(*std::max_element(lens.begin(), lens.end()));
  size_t heads_out = (size_t)num_seqs * num_heads;
  for (const Case& c : cases) {
    rows = std::max(rows, (size_t)c.seqs * num_heads * partitions_for(c.context));
    heads_out = std::max(heads_out, (size_t)c.seqs * num_heads);
  }
  Partials part;
  CUDA_CHECK(cudaMalloc(&part.exp_sums, rows * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&part.max_logits, rows * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&part.tmp_out, rows * HEAD_SIZE * sizeof(float)));
  CUDA_CHECK(cudaMemset(part.exp_sums, 0xFF, rows * sizeof(float)));  // NaN: a partition never written stays NaN
  CUDA_CHECK(cudaMemset(part.max_logits, 0xFF, rows * sizeof(float)));
  CUDA_CHECK(cudaMemset(part.tmp_out, 0xFF, rows * HEAD_SIZE * sizeof(float)));
  const size_t out_bytes = heads_out * HEAD_SIZE * sizeof(float);
  float *d_q = nullptr, *d_out_v1 = nullptr, *d_out_v2 = nullptr;
  CUDA_CHECK(cudaMalloc(&d_q, out_bytes));
  CUDA_CHECK(cudaMalloc(&d_out_v1, out_bytes));
  CUDA_CHECK(cudaMalloc(&d_out_v2, out_bytes));
  CUDA_CHECK(cudaMemset(d_out_v1, 0, out_bytes));
  CUDA_CHECK(cudaMemset(d_out_v2, 0, out_bytes));

  // 1. v2 against v1 and against the CPU. The last sequence's queries are 100x larger: logits past 88.
  PagedBatch batch = allocate_blocks(lens, num_blocks, rng);
  fill_cache(batch, rng, d_key_cache, d_value_cache);
  std::vector<float> h_q((size_t)num_seqs * num_heads * HEAD_SIZE);
  for (size_t i = 0; i < h_q.size(); ++i) {
    const bool loud = i / ((size_t)num_heads * HEAD_SIZE) == (size_t)num_seqs - 1;
    h_q[i] = rng.uniform() * (loud ? 100.0f : 1.0f);
  }
  CUDA_CHECK(cudaMemcpy(d_q, h_q.data(), h_q.size() * sizeof(float), cudaMemcpyHostToDevice));
  DeviceBatch db = upload(batch);
  run_v1(d_out_v1, d_q, d_key_cache, d_value_cache, db, num_heads, scale);
  run_v2(d_out_v2, part, d_q, d_key_cache, d_value_cache, db, num_heads, scale);
  CUDA_CHECK(cudaDeviceSynchronize());
  std::vector<float> out_v1(h_q.size()), out_v2(h_q.size()), ref(h_q.size());
  CUDA_CHECK(cudaMemcpy(out_v1.data(), d_out_v1, h_q.size() * sizeof(float), cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(out_v2.data(), d_out_v2, h_q.size() * sizeof(float), cudaMemcpyDeviceToHost));
  double max_logit = -INFINITY;
  attention_cpu(batch, h_q, num_heads, scale, ref, max_logit);
  release(db);

  const float v2_v1 = max_abs_diff(out_v2, out_v1);
  const float v2_cpu = max_abs_diff(out_v2, ref);
  const float v1_cpu = max_abs_diff(out_v1, ref);
  const bool ok = v2_v1 < 1e-4f && v2_cpu < 1e-3f && v1_cpu < 1e-3f;
  printf("lengths   ");
  for (int len : lens) printf(" %5d", len);
  printf("\\npartitions");
  for (int len : lens) printf(" %5d", partitions_for(len));
  printf("\\nmax|v2 - v1| = %.2e  max|v2 - cpu| = %.2e  max|v1 - cpu| = %.2e  largest logit %.1f\\n", v2_v1, v2_cpu,
         v1_cpu, max_logit);

  // 2. Long contexts. The values do not change the time; zeros keep every logit finite.
  CUDA_CHECK(cudaMemset(d_key_cache, 0, cache_bytes));
  CUDA_CHECK(cudaMemset(d_value_cache, 0, cache_bytes));
  CUDA_CHECK(cudaMemset(d_q, 0, out_bytes));
  int sms = 0;
  CUDA_CHECK(cudaDeviceGetAttribute(&sms, cudaDevAttrMultiProcessorCount, 0));
  printf("timing on %d SMs, %d heads, mean of 20 calls; vLLM runs v1 when one partition is enough or seqs x heads > 512\\n",
         sms, num_heads);
  printf("seqs  context  v1 blocks    v1 ms  v2 blocks  v2+reduce ms  vLLM\\n");
  for (const Case& c : cases) {
    PagedBatch tb = allocate_blocks(std::vector<int>(c.seqs, c.context), num_blocks, rng);
    DeviceBatch tdb = upload(tb);
    const float ms_v1 = mean_ms([&] { run_v1(d_out_v1, d_q, d_key_cache, d_value_cache, tdb, num_heads, scale); }, 20);
    const float ms_v2 =
        mean_ms([&] { run_v2(d_out_v2, part, d_q, d_key_cache, d_value_cache, tdb, num_heads, scale); }, 20);
    const bool use_v1 = c.context <= 8192 && (partitions_for(c.context) == 1 || c.seqs * num_heads > 512);
    printf("%4d  %7d  %9d  %7.3f  %9d  %12.3f  %s\\n", c.seqs, c.context, c.seqs * num_heads, ms_v1,
           c.seqs * num_heads * partitions_for(c.context), ms_v2, use_v1 ? "v1" : "v2");
    release(tdb);
  }

  for (void* p : {(void*)d_key_cache, (void*)d_value_cache, (void*)part.exp_sums, (void*)part.max_logits,
                  (void*)part.tmp_out, (void*)d_q, (void*)d_out_v1, (void*)d_out_v2})
    CUDA_CHECK(cudaFree(p));
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`;

export const pagedAttentionV2Step: Step = {
  id: 'paged-attention-v2',
  title: 'paged_attention_v2: partitions and the reduce',
  concept: 'cuda',
  file: 'paged_attention_v2',
  focus: ['v2-p0', 'v2-p1', 'v2-plast', 'v2-max', 'v2-sums', 'v2-tmp', 'v2-reduce', 'v2-weights', 'v2-out'],
  task: `## Task

v1 gives each (head, sequence) one thread block. One sequence with 32 heads launches 32 blocks on a GPU
with 108 SMs or more, and each block walks the whole context alone. v2 splits the context. Write both of
its kernels:

\`\`\`cuda
__global__ void paged_attention_v2(float* exp_sums, float* max_logits, float* tmp_out, const float* q,
                                   const float* k_cache, const float* v_cache, const int* block_tables,
                                   const int* seq_lens, int max_num_blocks_per_seq, int num_kv_heads, float scale);
__global__ void paged_attention_v2_reduce(float* out, const float* exp_sums, const float* max_logits,
                                          const float* tmp_out, const int* seq_lens, int max_num_partitions);
\`\`\`

- **Partitions.** \`PARTITION_SIZE = 512\` tokens, \`BLOCKS_PER_PARTITION = 32\` KV blocks. Grid
  \`dim3(num_heads, num_seqs, max_num_partitions)\` with \`max_num_partitions = ⌈max_len / 512⌉\`;
  \`partition = blockIdx.z\`. A block with \`partition × PARTITION_SIZE >= seq_len\` returns at once: the
  test reads \`blockIdx\` and \`seq_lens\` only, so the whole block leaves before any barrier.
- **Range.** \`start_block = partition × BLOCKS_PER_PARTITION\`, \`end_block = min(start_block +
  BLOCKS_PER_PARTITION, num_seq_blocks)\`, \`start_token = start_block × 16\`, \`end_token = min(start_token +
  PARTITION_SIZE, seq_len)\`, \`num_tokens = end_token − start_token\`.
- **Each partition is v1 on its range.** Warps walk \`start_block + warp, start_block + warp + 4, …\` below
  \`end_block\`; the scores go to \`__shared__ float logits[PARTITION_SIZE]\` at \`token − start_token\`, and the
  exponent loop runs to \`num_tokens\`. No dynamic shared memory: its size no longer depends on the context.
- **Partials.** With \`row = (seq × num_heads + head) × max_num_partitions + partition\`, thread 0 writes
  \`max_logits[row] = qk_max\` (\`m_p\`) and \`exp_sums[row] = exp_sum\` (\`l_p\`), and the block writes
  \`tmp_out[row × HEAD_SIZE + i]\`, the partition's output already divided by \`l_p\`.
- **Reduce.** Grid \`dim3(num_heads, num_seqs)\`, \`NUM_THREADS\` threads, \`max_num_partitions × 4\` bytes of
  dynamic shared memory for \`extern __shared__ float weights[]\`. With \`num_partitions = ⌈seq_len / 512⌉\`:
  for 1, copy the partial to \`out\`. Otherwise \`m = max_p m_p\` (a block reduction, as in v1),
  \`weights[p] = l_p × expf(m_p − m)\`, \`total = Σ_p weights[p]\` and
  \`out[i] = Σ_p tmp_out[p][i] × weights[p] / total\`. Read only the sequence's own \`num_partitions\` rows; the
  others were never written (they hold NaN in the test).
- **Forbidden:** atomics on \`out\` (combining partials is a rescale, not a plain sum) and a second pass over
  K or V.
- The file ends with the given \`main()\`, which holds steps 1 and 2: six sequences of 1, 511, 512, 513, 2,000
  and 6,000 tokens (1, 1, 1, 2, 4 and 12 partitions; the last with 100× queries) and NaN-filled partial
  buffers. It requires \`max|v2 − v1| < 1e-4\` and both within \`1e-3\` of the CPU reference, then times v1
  against v2 plus the reduce at 1 × 2,048, 1 × 8,192, 4 × 8,192 and 32 × 1,024 (sequences × context), prints
  which of the two vLLM's heuristic would pick, and \`PASS\`.

The same rescale, one tile at a time instead of one partition:

:::widget online-softmax {"tile": 4}

> A softmax over a split context is exact if each piece keeps its max and its sum:
> \`exp(s − m) = exp(s − m_p) · exp(m_p − m)\` turns partial answers into the whole one. v2 spends one small
> kernel to get as many thread blocks as the context has partitions.`,
  hints: [
    'Start from v1 and change four things: the early return, the block range (`start_block + warp` up to `end_block`), the logits index (`token - start_token`, and `i < num_tokens` in the exponent loop), and the epilogue, which writes the three partials instead of `out`.',
    'Write `tmp_out` already divided by the partition’s own `l_p`, as vLLM does. The reduce then needs `l_p` again inside the weight, `weights[p] = exp_sums[p] * expf(max_logits[p] - m)`, which is the partition’s share of the global denominator `total`.',
    'The reduce’s max and sum are v1’s block reductions over `num_partitions` values: start at `m = -INFINITY`, stride `p` by `NUM_THREADS`, butterfly, `red_max[warp]`, `__syncthreads()`. The barrier after `red_sum[warp] = …` also publishes `weights[]` to the threads that read every entry in the final loop.',
  ],
  checks: [
    {
      id: 'partition-grid',
      title: 'One block per (head, sequence, partition); empty partitions leave',
      detail:
        'Expected `partition = blockIdx.z` and `if (partition * PARTITION_SIZE >= seq_len) return;`: the grid is sized for the longest sequence, and a whole block must leave together, before its first barrier.',
      match: {
        cuda: {
          all: [
            /=\s*blockIdx\.z\s*;/,
            /if\s*\(\s*\w+\s*\*\s*PARTITION_SIZE\s*>=\s*seq_len\s*\)\s*(?:\{\s*)?return\s*;/,
          ],
        },
      },
    },
    {
      id: 'partition-range',
      title: 'The partition’s KV blocks and tokens are bounded',
      detail:
        'Expected `start_block = partition * BLOCKS_PER_PARTITION`, `end_block = min(start_block + BLOCKS_PER_PARTITION, num_seq_blocks)` and `end_token = min(start_token + PARTITION_SIZE, seq_len)`: the last partition is usually short, and the last block of it shorter.',
      match: {
        cuda: {
          all: [
            /\w+\s*\*\s*BLOCKS_PER_PARTITION/,
            /min\s*\(\s*\w+\s*\+\s*BLOCKS_PER_PARTITION\s*,\s*num_seq_blocks\s*\)/,
            /min\s*\(\s*\w+\s*\+\s*PARTITION_SIZE\s*,\s*seq_len\s*\)/,
          ],
        },
      },
    },
    {
      id: 'partition-logits',
      title: 'A fixed 512-float logits buffer, indexed from the partition’s first token',
      detail:
        'Expected `__shared__ float logits[PARTITION_SIZE]` and `logits[token - start_token] = …`: shared memory no longer grows with the context, which is what lets v2 serve contexts v1 cannot hold.',
      match: {
        cuda: {
          all: [/__shared__\s+float\s+logits\s*\[\s*PARTITION_SIZE\s*\]/, /logits\s*\[[^\]]*-\s*start_token\s*\]\s*=/],
        },
      },
    },
    {
      id: 'partials-written',
      title: 'Each partition writes m_p, l_p and its normalised output',
      detail:
        'Expected `max_logits[row] = qk_max`, `exp_sums[row] = exp_sum` and `tmp_out[row * HEAD_SIZE + i] = …`: the three numbers the reduce needs to put the partitions back on one scale.',
      match: {
        cuda: {
          all: [
            /max_logits\s*\[[^\]]+\]\s*=\s*qk_max/,
            /exp_sums\s*\[[^\]]+\]\s*=\s*exp_sum/,
            /tmp_out\s*\[[^\]]+\]\s*=/,
          ],
        },
      },
    },
    {
      id: 'single-partition',
      title: 'A one-partition sequence is copied, not reduced',
      detail:
        'Expected `if (num_partitions == 1)` in the reduce, copying `tmp_out` to `out`: its partial is already the answer, and most sequences of a batch are short.',
      match: {cuda: {all: [/if\s*\(\s*num_partitions\s*==\s*1\s*\)/]}},
    },
    {
      id: 'global-max',
      title: 'The reduce finds the global max over the partitions',
      detail:
        'Expected `m = fmaxf(m, max_logits[…])` over the sequence’s partitions, then the block reduction: every partition is re-expressed against the same `m`.',
      match: {
        cuda: {
          all: [/fmaxf\s*\(\s*\w+\s*,\s*max_logits\s*\[/],
        },
      },
    },
    {
      id: 'rescale',
      title: 'Each partition is weighted by l_p · exp(m_p − m)',
      detail:
        'Expected `exp_sums[p] * expf(max_logits[p] - m)`: each `l_p` was summed against its own max, and multiplying by `exp(m_p − m)` puts it on the global scale. Without it, a partition with small logits weighs as much as the one holding the max.',
      match: {
        cuda: {
          all: [
            /exp_sums\s*\[[^\]]+\]\s*\*\s*(?:__)?expf\s*\(\s*max_logits\s*\[[^\]]+\]\s*-\s*\w+\s*\)|(?:__)?expf\s*\(\s*max_logits\s*\[[^\]]+\]\s*-\s*\w+\s*\)\s*\*\s*exp_sums\s*\[/,
          ],
          none: [/atomicAdd\s*\(/],
        },
      },
    },
    {
      id: 'weighted-sum',
      title: 'The output is the weighted sum of partials over the total weight',
      detail:
        'Expected `extern __shared__ float weights[]` and `acc += partial[…] * weights[p]` (or `tmp_out[…] * weights[p]`), scaled by `1 / total` once: the softmax denominator of the whole context.',
      match: {
        cuda: {
          all: [/extern\s+__shared__\s+float\s+weights\s*\[\s*\]/, /\+=\s*\w+\s*\[[^\]]+\]\s*\*\s*weights\s*\[/],
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
  debrief: `v2 exists because decode is too narrow for v1's grid. A decode step has one query per (sequence, head), so v1 launches \`num_seqs × num_heads\` blocks: 32 for one sequence of a 32-head model, on a GPU with 108 SMs or more, while each of those blocks walks thousands of tokens alone. Flash-Decoding (Dao, Haziza, Massa and Sizov, 2023) describes the same fix: split the keys and values as well, compute each split in parallel, keep one extra number per split, and combine. The combine is exact because a softmax over a union is recoverable from the pieces' maxima and sums, \`exp(s − m) = exp(s − m_p) · exp(m_p − m)\`: with \`o_p\` a partition's unnormalised output, it contributes \`o_p · exp(m_p − m)\`, and the denominator is \`Σ_p l_p · exp(m_p − m)\`. vLLM stores \`o_p / l_p\` (so the reduce multiplies by \`l_p\` again) with \`m_p\` and \`l_p\` beside it; Flash-Decoding stores the log-sum-exp \`m_p + log l_p\` instead, which is the same information in one float. The partition size trades parallelism against the reduce: 512 tokens gives 16 partitions at 8,192 tokens, and fixes the logits buffer at 2 KB, so the context is no longer bounded by shared memory. The reduce is cheap (a few floats per partition per head) but it is a second launch and one more round trip of \`tmp_out\` through global memory, which is why vLLM keeps v1 when one partition suffices or when \`num_seqs × num_heads > 512\` already fills the GPU, and uses v2 past 8,192 tokens whatever the batch. Flash-Decoding itself ships in the FlashAttention package from version 2.2 and in xFormers from 0.0.22, whose dispatcher picks the split or the unsplit kernel by problem size, as vLLM's heuristic does.`,
};
