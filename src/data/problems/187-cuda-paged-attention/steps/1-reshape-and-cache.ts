import type {Step} from '@/lib/types';

/**
 * Step 1 of the PagedAttention kernels: vLLM's reshape_and_cache, which scatters each new token's K and
 * V rows into its slot of the paged cache. The header, the CPU-side scatter and the PASS check are the
 * same in starter and solution; only the kernel body differs.
 */
const HEADER = `// vLLM's reshape_and_cache: scatter the K and V rows of this step's new tokens into the paged KV
// cache through slot_mapping, one thread block per token. Slot -1 marks a padding token: skipped.
// Storage is float end to end; vLLM stores fp16, bf16 or fp8 with the same indexing.
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

constexpr int NUM_KV_HEADS = 8;  // Llama-3 8B: 32 query heads share 8 KV heads
constexpr int HEAD_SIZE = 128;
constexpr int BLOCK_SIZE = 16;   // tokens per KV-cache block, vLLM's default

`;

const SOLUTION_KERNEL = `// Grid: one block per token. key/value: [num_tokens, num_kv_heads, head_size].
// key_cache/value_cache: [num_blocks, block_size, num_kv_heads, head_size]. slot_mapping: [num_tokens].
__global__ void reshape_and_cache(const float* __restrict__ key, const float* __restrict__ value,
                                  float* __restrict__ key_cache, float* __restrict__ value_cache,
                                  const int64_t* __restrict__ slot_mapping, int num_kv_heads, int head_size,
                                  int block_size) {
  const int64_t token_idx = blockIdx.x;
  const int64_t slot = slot_mapping[token_idx];
  if (slot < 0) return;  // padding: no slot, and -1 / block_size would address memory before block 0

  const int64_t block_idx = slot / block_size;     // the physical block
  const int64_t block_offset = slot % block_size;  // the token's row inside it
  const int n = num_kv_heads * head_size;
  // Threads stride over heads x head_size: consecutive threads copy consecutive floats (coalesced).
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

const STARTER_KERNEL = `// Grid: one block per token. key/value: [num_tokens, num_kv_heads, head_size].
// key_cache/value_cache: [num_blocks, block_size, num_kv_heads, head_size]. slot_mapping: [num_tokens].
__global__ void reshape_and_cache(const float* __restrict__ key, const float* __restrict__ value,
                                  float* __restrict__ key_cache, float* __restrict__ value_cache,
                                  const int64_t* __restrict__ slot_mapping, int num_kv_heads, int head_size,
                                  int block_size) {
  // TODO: this block's token is blockIdx.x. Read its int64 slot from slot_mapping and return at once when
  // the slot is negative (padding). Split it into block_idx = slot / block_size and
  // block_offset = slot % block_size, then let the threads stride over num_kv_heads * head_size floats
  // and copy key and value into [block_idx][block_offset][head][d] of key_cache and value_cache.
  (void)key;
  (void)value;
  (void)key_cache;
  (void)value_cache;
  (void)slot_mapping;
  (void)num_kv_heads;
  (void)head_size;
  (void)block_size;
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

// The block manager's half, on the host: each sequence takes its blocks from a shuffled free list,
// so a sequence's blocks are scattered over the cache.
static std::vector<std::vector<int>> allocate_blocks(const std::vector<int>& capacity, int num_blocks, Lcg& rng) {
  std::vector<int> free_list(num_blocks);
  std::iota(free_list.begin(), free_list.end(), 0);
  for (int i = num_blocks - 1; i > 0; --i) std::swap(free_list[i], free_list[rng.next_u32() % (uint32_t)(i + 1)]);
  std::vector<std::vector<int>> tables;
  size_t used = 0;
  for (int tokens : capacity) {
    const size_t need = (size_t)(tokens + BLOCK_SIZE - 1) / BLOCK_SIZE;
    if (used + need > free_list.size()) {
      fprintf(stderr, "out of KV-cache blocks\\n");
      exit(1);
    }
    tables.emplace_back(free_list.begin() + used, free_list.begin() + used + need);
    used += need;
  }
  return tables;
}

int main() {
  const int n = NUM_KV_HEADS * HEAD_SIZE;  // floats per token in K, and in V
  const int num_blocks = 256;              // the cache: 256 blocks x 16 slots
  const size_t block_floats = (size_t)BLOCK_SIZE * n;
  const std::vector<int> prompt_lens = {300, 37, 1000, 5, 640};
  const int num_seqs = (int)prompt_lens.size();
  const int prefill_tokens = 2048;  // prompts packed, then padded to a fixed size as a captured CUDA graph is
  const int decode_tokens = 8;      // one new token per sequence, padded to 8
  Lcg rng{12345u};

  // Room for each prompt and the token decoded after it: 640 fills 40 blocks, so its next token opens a 41st.
  std::vector<int> capacity;
  for (int len : prompt_lens) capacity.push_back(len + 1);
  const std::vector<std::vector<int>> tables = allocate_blocks(capacity, num_blocks, rng);

  // Batches: (sequence, position) per token, -1 for padding; slot = block_table[pos / 16] * 16 + pos % 16.
  std::vector<int> pre_seq(prefill_tokens, -1), pre_pos(prefill_tokens, -1);
  std::vector<int> dec_seq(decode_tokens, -1), dec_pos(decode_tokens, -1);
  int real_prefill = 0;
  for (int s = 0; s < num_seqs; ++s)
    for (int p = 0; p < prompt_lens[s]; ++p, ++real_prefill) {
      pre_seq[real_prefill] = s;
      pre_pos[real_prefill] = p;
    }
  for (int s = 0; s < num_seqs; ++s) {
    dec_seq[s] = s;
    dec_pos[s] = prompt_lens[s];
  }
  auto slots_of = [&](const std::vector<int>& seq, const std::vector<int>& pos) {
    std::vector<int64_t> slots(seq.size(), -1);
    for (size_t t = 0; t < seq.size(); ++t)
      if (seq[t] >= 0)
        slots[t] = (int64_t)tables[seq[t]][pos[t] / BLOCK_SIZE] * BLOCK_SIZE + pos[t] % BLOCK_SIZE;
    return slots;
  };
  const std::vector<int64_t> pre_slots = slots_of(pre_seq, pre_pos);
  const std::vector<int64_t> dec_slots = slots_of(dec_seq, dec_pos);

  // New K/V rows for every token, padding included (a real batch holds garbage there).
  std::vector<float> pre_k((size_t)prefill_tokens * n), pre_v(pre_k.size());
  std::vector<float> dec_k((size_t)decode_tokens * n), dec_v(dec_k.size());
  for (auto* buf : {&pre_k, &pre_v, &dec_k, &dec_v})
    for (float& x : *buf) x = rng.uniform();

  // The cache sits between two guard blocks; every float starts as NaN (all bits set).
  const size_t alloc_floats = (num_blocks + 2) * block_floats;
  const size_t alloc_bytes = alloc_floats * sizeof(float);
  float *d_k_alloc = nullptr, *d_v_alloc = nullptr;
  CUDA_CHECK(cudaMalloc(&d_k_alloc, alloc_bytes));
  CUDA_CHECK(cudaMalloc(&d_v_alloc, alloc_bytes));
  CUDA_CHECK(cudaMemset(d_k_alloc, 0xFF, alloc_bytes));
  CUDA_CHECK(cudaMemset(d_v_alloc, 0xFF, alloc_bytes));
  float* d_key_cache = d_k_alloc + block_floats;
  float* d_value_cache = d_v_alloc + block_floats;

  float *d_pre_k = nullptr, *d_pre_v = nullptr, *d_dec_k = nullptr, *d_dec_v = nullptr;
  int64_t *d_pre_slots = nullptr, *d_dec_slots = nullptr;
  CUDA_CHECK(cudaMalloc(&d_pre_k, pre_k.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_pre_v, pre_v.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_dec_k, dec_k.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_dec_v, dec_v.size() * sizeof(float)));
  CUDA_CHECK(cudaMalloc(&d_pre_slots, pre_slots.size() * sizeof(int64_t)));
  CUDA_CHECK(cudaMalloc(&d_dec_slots, dec_slots.size() * sizeof(int64_t)));
  CUDA_CHECK(cudaMemcpy(d_pre_k, pre_k.data(), pre_k.size() * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_pre_v, pre_v.data(), pre_v.size() * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_dec_k, dec_k.data(), dec_k.size() * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_dec_v, dec_v.data(), dec_v.size() * sizeof(float), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_pre_slots, pre_slots.data(), pre_slots.size() * sizeof(int64_t), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(d_dec_slots, dec_slots.data(), dec_slots.size() * sizeof(int64_t), cudaMemcpyHostToDevice));

  // Prefill, then one decode step: the same kernel serves both.
  const dim3 block(std::min(n, 512));
  CUDA_LAUNCH(reshape_and_cache, dim3(prefill_tokens), block, 0, d_pre_k, d_pre_v, d_key_cache, d_value_cache,
              d_pre_slots, NUM_KV_HEADS, HEAD_SIZE, BLOCK_SIZE);
  CUDA_LAUNCH(reshape_and_cache, dim3(decode_tokens), block, 0, d_dec_k, d_dec_v, d_key_cache, d_value_cache,
              d_dec_slots, NUM_KV_HEADS, HEAD_SIZE, BLOCK_SIZE);
  CUDA_CHECK(cudaDeviceSynchronize());

  std::vector<float> got_k(alloc_floats), got_v(alloc_floats);
  CUDA_CHECK(cudaMemcpy(got_k.data(), d_k_alloc, alloc_bytes, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(got_v.data(), d_v_alloc, alloc_bytes, cudaMemcpyDeviceToHost));

  // CPU reference: walk each sequence's block table from (sequence, position); never look at a slot.
  std::vector<float> ref_k(alloc_floats), ref_v(alloc_floats);
  memset(ref_k.data(), 0xFF, alloc_bytes);
  memset(ref_v.data(), 0xFF, alloc_bytes);
  auto scatter = [&](const std::vector<int>& seq, const std::vector<int>& pos, const std::vector<float>& k,
                     const std::vector<float>& v) {
    for (size_t t = 0; t < seq.size(); ++t) {
      if (seq[t] < 0) continue;
      const int physical = tables[seq[t]][pos[t] / BLOCK_SIZE];
      const size_t row = block_floats + ((size_t)physical * BLOCK_SIZE + pos[t] % BLOCK_SIZE) * n;
      std::copy(k.begin() + t * n, k.begin() + (t + 1) * n, ref_k.begin() + row);
      std::copy(v.begin() + t * n, v.begin() + (t + 1) * n, ref_v.begin() + row);
    }
  };
  scatter(pre_seq, pre_pos, pre_k, pre_v);
  scatter(dec_seq, dec_pos, dec_k, dec_v);

  bool ok = memcmp(got_k.data(), ref_k.data(), alloc_bytes) == 0 && memcmp(got_v.data(), ref_v.data(), alloc_bytes) == 0;
  size_t filled = 0, wrong = 0, guards_hit = 0;
  for (size_t slot = 0; slot < (size_t)(num_blocks + 2) * BLOCK_SIZE; ++slot) {
    const bool want = !std::isnan(ref_k[slot * n]);
    if (want && slot >= (size_t)BLOCK_SIZE && slot < (size_t)(num_blocks + 1) * BLOCK_SIZE) ++filled;
    const bool differs = memcmp(&got_k[slot * n], &ref_k[slot * n], n * sizeof(float)) != 0 ||
                         memcmp(&got_v[slot * n], &ref_v[slot * n], n * sizeof(float)) != 0;
    if (differs) {
      ++wrong;
      if (slot < (size_t)BLOCK_SIZE || slot >= (size_t)(num_blocks + 1) * BLOCK_SIZE) ++guards_hit;
    }
  }
  const int last = num_seqs - 1;
  printf("prefill: %d tokens (%d real, %d padding)  decode: %d tokens (%d real, %d padding)\\n", prefill_tokens,
         real_prefill, prefill_tokens - real_prefill, decode_tokens, num_seqs, decode_tokens - num_seqs);
  printf("sequence %d: prompt of %d tokens in blocks", last, prompt_lens[last]);
  for (size_t b = 0; b < 4; ++b) printf(" %d", tables[last][b]);
  printf(" ... %d; its decode token opened block %d\\n", tables[last][tables[last].size() - 2], tables[last].back());
  printf("cache: %d blocks x %d slots, %zu slots filled, %zu slots differ from the CPU scatter (%zu in the guard blocks)\\n",
         num_blocks, BLOCK_SIZE, filled, wrong, guards_hit);

  // Timing: the prefill scatter again (it rewrites the same values).
  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  const int reps = 20;
  CUDA_CHECK(cudaEventRecord(t0));
  for (int r = 0; r < reps; ++r)
    CUDA_LAUNCH(reshape_and_cache, dim3(prefill_tokens), block, 0, d_pre_k, d_pre_v, d_key_cache, d_value_cache,
                d_pre_slots, NUM_KV_HEADS, HEAD_SIZE, BLOCK_SIZE);
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  ms /= reps;
  const double moved = 4.0 * real_prefill * n * sizeof(float);  // K and V, each read once and written once
  printf("timing: prefill scatter %.4f ms, %.1f GB/s of K/V read and written\\n", ms, moved / (ms * 1e-3) / 1e9);

  CUDA_CHECK(cudaEventDestroy(t0));
  CUDA_CHECK(cudaEventDestroy(t1));
  for (void* p : {(void*)d_k_alloc, (void*)d_v_alloc, (void*)d_pre_k, (void*)d_pre_v, (void*)d_dec_k, (void*)d_dec_v,
                  (void*)d_pre_slots, (void*)d_dec_slots})
    CUDA_CHECK(cudaFree(p));
  printf(ok ? "PASS\\n" : "FAIL\\n");
  return ok ? 0 : 1;
}
`;

export const reshapeAndCacheStep: Step = {
  id: 'reshape-and-cache',
  title: 'reshape_and_cache: new K/V rows into their slots',
  concept: 'cuda',
  file: 'reshape_and_cache',
  focus: ['rc-token', 'rc-pad', 'rc-slots', 'rc-cache'],
  task: `## Task

Every forward pass makes one K row and one V row per new token and KV head. vLLM never appends them to
a contiguous tensor: the block manager has already given every token a **slot** in a pool of
fixed-size blocks, and one kernel scatters the rows there. Write it:

\`\`\`cuda
__global__ void reshape_and_cache(const float* key, const float* value, float* key_cache, float* value_cache,
                                  const int64_t* slot_mapping, int num_kv_heads, int head_size, int block_size);
\`\`\`

- **Shapes.** \`key\`, \`value\`: \`[num_tokens, num_kv_heads, head_size]\`, float, row-major. \`key_cache\`,
  \`value_cache\`: \`[num_blocks, block_size, num_kv_heads, head_size]\`. \`slot_mapping\`: \`[num_tokens]\`
  \`int64_t\`, with \`slot = physical_block × block_size + offset\`.
- **One thread block per token.** The host launches \`num_tokens\` blocks of \`min(num_kv_heads × head_size,
  512)\` threads. Block \`blockIdx.x\` reads its slot into an \`int64_t\`: at 1,024 floats a slot, \`int\` offsets
  overflow past 2²¹ slots, 8 GiB of K.
- **Padding.** Slot \`-1\` marks a padding token (batches are padded to the sizes a CUDA graph was captured
  at). Return before any store: in C++ \`-1 / 16\` is \`0\` and \`-1 % 16\` is \`-1\`, so a padding row would
  land just before block 0.
- **Index.** \`block_idx = slot / block_size\` and \`block_offset = slot % block_size\`. The threads stride
  over \`i = head × head_size + d\` by \`blockDim.x\` and copy \`key[token][head][d]\` and \`value[token][head][d]\`
  to \`[block_idx][block_offset][head][d]\` of the two caches, with 64-bit offsets.
- **Storage stays float.** vLLM converts to fp16, bf16 or fp8 in this same store; the indexing does not
  change, and float keeps the check bitwise.
- **Forbidden:** writing the cache from the host (\`cudaMemcpy\` into \`key_cache\` or \`value_cache\`) and
  touching any slot \`slot_mapping\` does not name.
- The file ends with the given \`main()\`: Llama-3 8B's KV shape (8 KV heads × 128), a pool of 256 blocks ×
  16 slots between two guard blocks, every float NaN at the start. Five prompts of 300, 37, 1,000, 5 and
  640 tokens are written as one prefill batch padded to 2,048 tokens, then one decode token per sequence
  padded to 8 (the 640-token prompt's next token opens a new block). Block tables come from a shuffled
  free list. The pool, guards included, must equal **bitwise** a CPU scatter that walks each sequence's
  block table from (sequence, position); then a \`cudaEvent\` timing of the prefill scatter and \`PASS\`.

Step through three sequences filling a pool of blocks through their block tables:

:::widget paged-kv {"blockSize": 4}

> A slot is an address the scheduler computed once, on the host. The kernel only splits it into
> (block, offset) and copies; after it, no kernel ever sees a sequence as contiguous memory.`,
  hints: [
    'The kernel is about ten lines: read the slot, `if (slot < 0) return;`, divide, then one loop `for (int i = threadIdx.x; i < num_kv_heads * head_size; i += blockDim.x)` with two stores.',
    'Inside the loop, `head = i / head_size` and `d = i % head_size`. The source is `(token_idx * num_kv_heads + head) * head_size + d` and the destination `((block_idx * block_size + block_offset) * num_kv_heads + head) * head_size + d`. Keep `token_idx`, `slot`, `block_idx` and `block_offset` as `int64_t` so every product is 64-bit.',
    'The guard blocks in `main()` are there for the classic bug: without the early return a padding token computes `block_idx = 0` and `block_offset = -1`, and its 1,024 floats land in the slot just before block 0, which is the last slot of the first guard block.',
  ],
  checks: [
    {
      id: 'block-per-token',
      title: 'One thread block per token, its slot read as int64',
      detail:
        'Expected the token index from `blockIdx.x` and `int64_t slot = slot_mapping[token_idx]`: the grid has one block per token, and slot offsets times 1,024 floats need 64 bits.',
      match: {
        cuda: {
          all: [/=\s*blockIdx\.x\s*;/, /(?:int64_t|long\s+long)\s+\w+\s*=\s*slot_mapping\s*\[/],
        },
      },
    },
    {
      id: 'padding-skipped',
      title: 'A padding slot (-1) returns before any store',
      detail:
        'Expected `if (slot < 0) return;` after reading `slot_mapping` and before the first `key_cache[…] =`. Padding tokens carry slot -1; dividing it gives block 0, offset -1, a row written just before the cache.',
      match: {
        cuda: {
          order: [
            /slot_mapping\s*\[/,
            /if\s*\(\s*\w+\s*(?:<\s*0|==\s*-\s*1|<=\s*-\s*1)\s*\)\s*(?:\{\s*)?return\s*;/,
            /key_cache\s*\[[^\]]+\]\s*=/,
          ],
        },
      },
    },
    {
      id: 'block-and-offset',
      title: 'The slot is split into a physical block and an offset',
      detail:
        'Expected `block_idx = slot / block_size` and `block_offset = slot % block_size`: the cache is addressed as `[block][offset][head][d]`, the layout every paged kernel reads.',
      match: {
        cuda: {
          all: [/\w+\s*=\s*\w+\s*\/\s*block_size\s*;/, /\w+\s*=\s*\w+\s*%\s*block_size\s*;/],
        },
      },
    },
    {
      id: 'threads-over-row',
      title: 'Threads stride over the token’s heads × head_size floats',
      detail:
        'Expected `for (int i = threadIdx.x; i < …; i += blockDim.x)`: consecutive threads copy consecutive floats of the token’s 4 KB row, so both the read and the write are coalesced.',
      match: {
        cuda: {
          all: [/for\s*\(\s*int\s+(\w+)\s*=\s*threadIdx\.x\s*;\s*\1\s*<\s*[^;]+;\s*\1\s*\+=\s*blockDim\.x\s*\)/],
        },
      },
    },
    {
      id: 'paged-store',
      title: 'K and V are stored at [block][offset][head][d] on the device',
      detail:
        'Expected a destination built from `(block_idx * block_size + block_offset)` and the stores `key_cache[dst] = key[src]` and `value_cache[dst] = value[src]` in the kernel, with no `cudaMemcpy` into the caches from the host.',
      match: {
        cuda: {
          all: [
            /\(\s*\w+\s*\*\s*block_size\s*\+\s*\w+\s*\)/,
            /key_cache\s*\[[^\]]+\]\s*=\s*key\s*\[/,
            /value_cache\s*\[[^\]]+\]\s*=\s*value\s*\[/,
          ],
          none: [/cudaMemcpy\w*\s*\(\s*(?:d_key_cache|d_value_cache|d_k_alloc|d_v_alloc)\b/],
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
  debrief: `The kernel is trivial on purpose, and that is the design. The hard decision (which slot a token goes to) is made by the block manager on the host, once per step, and arrives as one \`int64\` per token; the GPU only divides and copies. One block per token fits because tokens are independent and a token's K row for all KV heads is 1,024 contiguous floats, so 512 threads read and write it in two coalesced sweeps. The early \`return\` on a negative slot is what lets the engine pad a batch to a captured CUDA-graph size without a second code path, and it must come before the division, because C++ rounds \`-1 / 16\` towards zero. With this layout the destination collapses to \`slot × 1,024 + i\`; vLLM's \`reshape_and_cache_flash\`, which writes this same \`[num_blocks, block_size, num_kv_heads, head_size]\` layout for its FlashAttention backend, still computes \`block_idx × block_stride\` because the cache tensor can be strided. Its older \`reshape_and_cache\`, which feeds the \`paged_attention_v1/v2\` kernels, writes a different layout: K as \`[num_blocks, num_kv_heads, head_size / x, block_size, x]\` with \`x\` elements per 16 bytes, so that for each 16-byte slice of a head the 16 tokens of a block sit side by side and a warp scoring a whole block loads 256 contiguous bytes at a time; V is transposed to \`[num_blocks, num_kv_heads, head_size, block_size]\`, so a lane reads consecutive tokens of one channel. Production stores also convert: fp16 or bf16 from the model's dtype, or fp8 with a per-tensor \`k_scale\`/\`v_scale\`, which halves the cache again.`,
};
