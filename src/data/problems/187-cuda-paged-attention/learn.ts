/**
 * The learning guide for the PagedAttention kernels: paged KV memory and its addressing, the
 * reshape_and_cache scatter, why decode attention is bandwidth-bound, paged_attention_v1's thread groups,
 * shuffles and block reductions, v2's partitions and their exact merge, and what vLLM's production
 * kernels add. Rendered at /cuda-paged-attention/learn.
 */
export const learn = `# The mechanism at a glance

PagedAttention (Kwon et al., SOSP 2023) is the idea vLLM is built on: keep every sequence's KV cache in
fixed-size **blocks** of 16 tokens, scattered anywhere in one preallocated pool, and give each sequence a
**block table** that maps its logical blocks to physical ones, the way a page table maps a process's pages
to frames. The memory manager gets paging's properties (no external fragmentation, waste bounded by one
partly filled block, blocks shareable between sequences). The price is paid in the kernels: attention can
no longer read a sequence's keys as one array, so every K and V address goes through the table.

Three CUDA kernels carry that price, and this project writes all three in float:

- \`reshape_and_cache\` writes each new token's K and V rows into the slot the scheduler gave it.
- \`paged_attention_v1\` runs decode attention with one thread block per (head, sequence), its warps walking
  the KV blocks through the block table.
- \`paged_attention_v2\` splits long contexts into 512-token partitions and merges them in a reduce kernel.

One thread block of v1, for head 5 of a sequence with 70 tokens in five blocks:

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "v1-block", "label": "Thread block (head 5, seq 1)", "sub": "paged_attention_v1<<<(32, 8), 128>>>", "count": "256 blocks", "layout": "row", "align": "end", "detail": "\`head = blockIdx.x = 5\`, \`seq = blockIdx.y = 1\`, \`kv_head = 5 / (32 / 8) = 1\`. The block computes one 128-float output row from a 70-token context.", "items": [
      {"id": "v1-warps", "label": "Warps", "sub": "warp w: KV blocks w, w + 4, …", "layout": "grid", "columns": 2, "detail": "Five logical blocks over four warps: warp 0 takes blocks 0 and 4, the others one each. The same split serves the V pass.", "items": [
        {"label": "Warp 0", "sub": "blocks 0, 4", "layout": "column", "items": [
          {"threads": 16, "label": "16 groups of 2 lanes", "detail": "Group \`g\` scores token \`g\` of the block: each lane dots its 64 floats of q against 64 of the key, one \`__shfl_xor_sync(…, 1)\` joins the halves, and lane 0 of the group stores \`logits[token]\`."}
        ]},
        {"label": "Warp 1", "sub": "block 1", "layout": "column", "items": [
          {"threads": 16, "label": "16 groups of 2"}
        ]},
        {"label": "Warp 2", "sub": "block 2", "layout": "column", "items": [
          {"threads": 16, "label": "16 groups of 2"}
        ]},
        {"label": "Warp 3", "sub": "block 3", "layout": "column", "items": [
          {"threads": 16, "label": "16 groups of 2"}
        ]}
      ]},
      {"label": "Registers, per lane", "tone": "register", "layout": "column", "items": [
        {"id": "v1-q", "array": "q_vec[16]", "sub": "float4 · half the head", "cols": 16, "tone": "register", "detail": "Float4 number \`group_offset + 2i\` of \`q[1][5]\`, loaded once: the two lanes of a group hold interleaved halves, so their loads of one key are 32 contiguous bytes."},
        {"id": "v1-acc", "array": "acc[4]", "sub": "channels lane + 32j", "cols": 4, "tone": "register", "detail": "\`acc[j] += p × v_row[lane + 32j]\` over the warp’s tokens: a partial output for 4 of the 128 channels."}
      ]},
      {"label": "Shared memory", "tone": "shared", "layout": "column", "items": [
        {"id": "v1-logits", "array": "logits[80]", "sub": "a row = one KV block · 70 used", "cols": 16, "rows": 5, "tone": "shared", "marks": [{"rows": [4,4], "cols": [6,15], "tone": "muted", "label": "past seq_len"}], "detail": "Dynamic shared memory, \`⌈70 / 16⌉ × 16 × 4 = 320\` bytes here. Scores first, then \`__expf(logit − qk_max)\` in place. Slots 70 … 79 of the last block are never stored or read."},
        {"id": "v1-red", "array": "red_max, red_sum", "sub": "one slot per warp each", "cols": 8, "cells": ["m0", "m1", "m2", "m3", "l0", "l1", "l2", "l3"], "tone": "shared", "detail": "Two arrays: each warp’s butterfly result goes in, \`__syncthreads()\`, every thread folds the four. One shared array would let a fast warp overwrite a max with its sum."},
        {"id": "v1-out-smem", "array": "out_smem[4][128]", "sub": "a cell = 8 channels", "cols": 16, "rows": 4, "tone": "shared", "detail": "Each warp’s \`acc\` for all 128 channels; after a barrier thread \`i\` adds the four rows for channel \`i\`."}
      ]}
    ]},
    {"id": "v1-hbm", "label": "Global memory", "sub": "HBM", "tone": "global", "stretch": true, "items": [
      {"id": "v1-table", "array": "block_tables[1]", "sub": "logical → physical", "cols": 5, "cells": ["7", "2", "12", "5", "9"], "detail": "Sequence 1’s row of \`block_tables\`. Logical block \`b\` of the context is physical block \`block_tables[1][b]\`; every K and V address goes through it."},
      {"id": "v1-k", "array": "k_cache [16][16]", "sub": "a row = one block · a cell = one slot", "cols": 16, "rows": 16, "marks": [{"rows": [7,7], "cols": [0,15], "tone": "a", "label": "logical 0"},{"rows": [2,2], "cols": [0,15], "tone": "a", "label": "logical 1"},{"rows": [12,12], "cols": [0,15], "tone": "a", "label": "logical 2"},{"rows": [5,5], "cols": [0,15], "tone": "a", "label": "logical 3"},{"rows": [9,9], "cols": [0,5], "tone": "a", "label": "logical 4"},{"rows": [9,9], "cols": [6,15], "tone": "muted", "label": "stale"}], "detail": "An illustrative 16-block pool. Sequence 1 owns blocks 7, 2, 12, 5 and 9 in that logical order; the last holds 6 tokens and 10 stale slots (NaN in the test)."},
      {"id": "v1-v", "array": "v_cache [16][16]", "sub": "same blocks, same slots", "cols": 16, "rows": 16, "marks": [{"rows": [7,7], "cols": [0,15], "tone": "a", "label": "logical 0"},{"rows": [2,2], "cols": [0,15], "tone": "a", "label": "logical 1"},{"rows": [12,12], "cols": [0,15], "tone": "a", "label": "logical 2"},{"rows": [5,5], "cols": [0,15], "tone": "a", "label": "logical 3"},{"rows": [9,9], "cols": [0,5], "tone": "a", "label": "logical 4"},{"rows": [9,9], "cols": [6,15], "tone": "muted", "label": "stale"}], "detail": "Read in the second pass with the same warp split; the stale tail is never touched."},
      {"id": "v1-out", "array": "out [8][32][128]", "sub": "a row = one sequence", "cols": 8, "rows": 8, "marks": [{"rows": [1,1], "cols": [1,1], "tone": "b", "label": "head 5"}], "detail": "\`out[1][5][i] = (Σ_w out_smem[w][i]) / exp_sum\`: one store per channel, the only global write of the kernel."}
    ]}
  ],
  "arrows": [
    {"from": "v1-k", "to": "v1-q", "label": "K · float4"},
    {"from": "v1-v", "to": "v1-acc", "label": "V rows"},
    {"from": "v1-out-smem", "to": "v1-out", "label": "Σ warps / l"}
  ]
}
:::

Read it bottom to top. The block table says sequence 1's context lives in physical blocks 7, 2, 12, 5
and 9. Four warps walk those blocks, two lanes per key, and store one score per token in shared memory;
the block agrees on one max and one sum; the same warps walk the V rows, and the four partial outputs
meet in shared memory once. Nothing in the kernel depends on where the blocks are.

The contract, in three files that each compile and test on their own:

| File | Kernel | Grid × threads | Shapes |
|---|---|---|---|
| \`reshape_and_cache.cu\` | \`reshape_and_cache\` | \`num_tokens\` × 512 | K/V \`[tokens, 8, 128]\` into \`[blocks, 16, 8, 128]\` |
| \`paged_attention_v1.cu\` | \`paged_attention_v1\` | \`(heads, seqs)\` × 128 | \`q\`, \`out\` \`[seqs, 32, 128]\` |
| \`paged_attention_v2.cu\` | \`paged_attention_v2\` and \`_reduce\` | \`(heads, seqs, partitions)\` × 128, then \`(heads, seqs)\` × 128 | partials \`[seqs, 32, partitions]\` |

The shapes are Llama-3 8B's attention: 32 query heads, 8 KV heads, head size 128, with vLLM's block size
of 16 tokens and 128 threads per block.

# Paged KV memory: blocks, tables and slots

A decoder keeps the K and V rows of every token it has seen. For Llama-3 8B that is
\`2 × 32 layers × 8 KV heads × 128 × 2 bytes = 128 KiB\` per token in fp16, so one 8,192-token sequence holds
1 GiB of cache. The paper measured what happens when each request reserves contiguous memory for its
maximum length: in the systems it compared, only 20.4% to 38.2% of KV memory held actual token states.
The rest was reserved for tokens not generated yet, internal fragmentation (a request shorter than its
reservation) and external fragmentation (gaps between reservations of different sizes).

| | Contiguous per request | Paged (vLLM) |
|---|---|---|
| Allocation | \`max_len\` tokens up front | one 16-token block when the last one fills |
| Waste per sequence | up to \`max_len − len\` tokens | under one block |
| External fragmentation | yes, reservations differ in size | none, every block is the same size |
| Sharing a prompt | copy it | point two tables at the same blocks |
| What attention sees | one array per sequence | a list of block numbers |

The addressing is a few lines. The scheduler turns a token's position into a **slot** once, on the host,
and every kernel turns the slot or the position back into a block and an offset:

\`\`\`cuda
slot     = block_table[seq][pos / 16] * 16 + pos % 16;     // scheduler, per new token
k_row    = k_cache + ((slot / 16) * 16 + slot % 16) * 8 * 128 + kv_head * 128;
// attention reads by logical block instead:
physical = block_table[seq][block_idx];                     // then row (physical * 16 + t)
\`\`\`

Step through three sequences filling a pool through their block tables, and compare the waste against a
contiguous reservation:

:::widget paged-kv {"blockSize": 4}

The layout inside a block is a choice, and vLLM has used more than one:

| Layout | K | V | Used by |
|---|---|---|---|
| This project | \`[blocks, 16, kv_heads, 128]\` | same | \`reshape_and_cache_flash\`, the FlashAttention backend |
| vLLM's \`paged_attention\` | \`[blocks, kv_heads, 128/x, 16, x]\`, \`x\` = 16 bytes of elements | \`[blocks, kv_heads, 128, 16]\` | \`paged_attention_v1\` and \`v2\` |

The second layout puts the 16 tokens of a block side by side for each 16-byte slice of a head, so a warp
scoring a whole block loads 256 contiguous bytes; V is transposed so one lane reads consecutive tokens of
one channel. This project keeps the simpler layout, where a token's row for all heads is 4 KB of
contiguous floats, and reads it with \`float4\` loads instead.

:::quiz
Q: Why does vLLM waste at most one block per sequence?
- [ ] Blocks are freed as soon as attention has read them
- [x] A sequence gets a new block only when its last block is full, so only the last block can be partly empty
- [ ] The block size adapts to each sequence's length
> Blocks are allocated on demand, left to right. Every block but the last is full, so the waste is the unused tail of one block, at most 15 slots with a block size of 16.
:::

# Writing the cache: reshape_and_cache

The QKV projection produces this step's K and V rows contiguously, \`[num_tokens, 8, 128]\`. One kernel
scatters them into the pool. The paper calls it the "fused reshape and block write": splitting the rows
into blocks, reshaping them to the layout attention reads and storing them by the block table, in one
launch per layer.

:::gpu
{
  "items": [
    {"id": "rc-in", "label": "Global memory", "sub": "this step’s new rows", "tone": "global", "layout": "column", "items": [
      {"id": "rc-key", "array": "key [8][8][128]", "sub": "a row = one token", "cols": 8, "rows": 8, "marks": [{"rows": [1,1], "cols": [0,7], "tone": "b", "label": "token 1"},{"rows": [5,7], "cols": [0,7], "tone": "muted", "label": "padding"}], "detail": "This step’s K rows, contiguous, as the QKV projection wrote them: a cell is one KV head, 128 floats, so a row is 4 KB. \`value\` has the same shape."},
      {"id": "rc-slots", "array": "slot_mapping [8]", "sub": "int64 · from the host", "cols": 8, "cells": ["52", "150", "234", "1", "191", "-1", "-1", "-1"], "marks": [{"cols": [1,1], "tone": "b"},{"cols": [5,7], "tone": "muted", "label": "padding"}], "detail": "The scheduler computes \`slot = block_table[pos / 16] × 16 + pos % 16\` for every token. Sequence 1’s table is 7, 2, 12, 5, 9, so its token at position 70 is logical block 4, physical block 9, offset 6: slot 150."}
    ]},
    {"id": "rc-grid", "label": "Grid · one decode step", "sub": "reshape_and_cache<<<8, 512>>>", "count": "8 blocks", "layout": "column", "detail": "One thread block per new token. Five sequences decode one token each and the batch is padded to 8, a size a CUDA graph was captured at.", "items": [
      {"id": "rc-token", "label": "Block 1", "sub": "seq 1, position 70", "layout": "column", "detail": "\`slot = 150\`: \`block_idx = 150 / 16 = 9\`, \`block_offset = 150 % 16 = 6\`. The K row goes to \`key_cache[9][6][head][d]\`, the V row to the same place in \`value_cache\`.", "items": [
        {"threads": 16, "continues": true, "label": "512 threads, 2 floats each", "detail": "Thread \`t\` copies floats \`t\` and \`t + 512\` of the token’s 1,024 (\`head = i / 128\`, \`d = i % 128\`), so a warp reads and writes 128 contiguous bytes at a time."}
      ]},
      {"gap": "…"},
      {"id": "rc-pad", "label": "Block 7", "sub": "padding · slot -1", "layout": "column", "detail": "Slot -1: the block returns before any store. Without the test, C++ gives \`-1 / 16 = 0\` and \`-1 % 16 = -1\`, and the padding row lands in the slot just before block 0.", "items": [
        {"threads": 16, "idle": 16, "continues": true, "label": "returns at once"}
      ]}
    ]},
    {"id": "rc-hbm", "label": "Global memory", "sub": "the paged cache", "tone": "global", "items": [
      {"id": "rc-cache", "array": "key_cache [16][16]", "sub": "a row = one block · a cell = one slot", "cols": 16, "rows": 16, "marks": [{"rows": [7,7], "cols": [0,15], "tone": "a", "label": "seq 1"},{"rows": [2,2], "cols": [0,15], "tone": "a", "label": "seq 1"},{"rows": [12,12], "cols": [0,15], "tone": "a", "label": "seq 1"},{"rows": [5,5], "cols": [0,15], "tone": "a", "label": "seq 1"},{"rows": [9,9], "cols": [0,5], "tone": "a"},{"rows": [9,9], "cols": [6,6], "tone": "b"},{"rows": [3,3], "cols": [4,4], "tone": "b"},{"rows": [14,14], "cols": [10,10], "tone": "b"},{"rows": [0,0], "cols": [1,1], "tone": "b"},{"rows": [11,11], "cols": [15,15], "tone": "b"}], "detail": "An illustrative 16-block pool (the test’s has 256). Sequence 1’s first 70 tokens fill blocks 7, 2, 12 and 5 and six slots of block 9; this step writes its token at position 70 into slot 6 of block 9, and the other four sequences’ tokens into their own slots."}
    ]}
  ],
  "arrows": [
    {"from": "rc-key", "to": "rc-token", "label": "row 1 · 4 KB"},
    {"from": "rc-slots", "to": "rc-token", "label": "slot 150"},
    {"from": "rc-token", "to": "rc-cache", "label": "block 9, offset 6"}
  ]
}
:::

- **One thread block per token.** Tokens are independent, and a token's row for all 8 KV heads is 1,024
  contiguous floats in both the source and the destination, so 512 threads copy it in two coalesced sweeps.
- **The slot is \`int64\`.** At 1,024 floats per slot, \`int\` offsets overflow past 2²¹ slots, which is 8 GiB
  of float K: an ordinary cache on an 80 GB GPU.
- **Slot -1 is padding.** Engines capture CUDA graphs at a few fixed batch sizes and pad each step's batch up
  to the next one; the padding tokens get slot -1 and must not be written.
- **The kernel decides nothing.** Which slot a token gets is the block manager's decision, made on the
  host; the kernel divides and copies.

The padding test has to come first, because C++ integer division rounds towards zero:

| Kernel | Slot -1 becomes | What happens |
|---|---|---|
| Correct: \`if (slot < 0) return;\` | nothing | the block exits before any store |
| Test after the division | \`block_idx = -1 / 16 = 0\`, \`block_offset = -1 % 16 = -1\` | 4 KB written just before block 0, into whatever lives there |
| No test, \`int\` offsets | as above, and large slots overflow | writes before block 0 and, past 2²¹ slots, wrapped addresses |

The self-test puts a guard block on each side of the pool, fills everything with NaN and compares the whole
allocation bitwise against a CPU scatter, so a padding row that lands in the guard is a failure, not a
silent corruption of a neighbouring buffer.

:::quiz
Q: A batch of 5 decode tokens is padded to 8 with slot -1. What does a reshape kernel without the padding test do?
- [ ] It skips the padding, because their K rows are zero
- [ ] It crashes on the division by a negative number
- [x] It writes the padding rows to offset -1 of block 0, which is the memory just before the cache
> -1 / 16 is 0 and -1 % 16 is -1 in C++, so the destination is one slot before block 0. Nothing faults if that memory belongs to another buffer; the corruption is silent, which is why the test is the first statement of the kernel.
:::

# Decode attention is a bandwidth problem

At a decode step each sequence has one new query per head, and that query meets every cached token. Per
token and per query head, the work is one 128-element dot product with K and one 128-element weighted add
of V. Count it in float, as this project stores it:

| Per token, per KV head | Value |
|---|---|
| Bytes read (K row + V row) | 2 × 128 × 4 = 1,024 |
| FLOPs, one query head | 2 × 128 (q·k) + 2 × 128 (p·v) = 512 |
| FLOPs, four query heads sharing it (GQA) | 2,048 |
| Arithmetic intensity | about 2 FLOPs per byte |

An A100 does 19.5 TFLOPS of FP32 against 1.6 to 2.0 TB/s of HBM, so it needs about 10 FLOPs per byte before
arithmetic becomes the limit. Decode attention offers 2: it is a matrix-vector product per head, and the
time is the time to stream the context's K and V once. Tensor cores do not help a single query, and every
design decision in the kernels is about bytes and parallelism:

- **Read each byte once.** Scores live in shared memory, so K is read once for the scores and V once for
  the output; nothing of size \`seq_len\` goes back to HBM.
- **Read in wide, aligned pieces.** Two lanes per key with interleaved \`float4\` loads fetch 32 contiguous
  bytes per group; a V row is read 128 contiguous bytes per warp instruction.
- **Keep enough blocks in flight.** Bandwidth comes from many outstanding loads on many SMs. One block per
  (head, sequence) is enough for a large batch and too few for one long sequence, which is the whole case
  for v2.

GQA helps for free: the 4 query heads that share a KV head are 4 thread blocks reading the same rows, and
when they run close together the repeats come from L2 rather than HBM.

:::quiz
Q: Why do tensor cores not speed up paged_attention_v1?
- [ ] The paged layout cannot be loaded into tensor-core fragments
- [x] With one query per head the work is a matrix-vector product, and its time is set by reading K and V, not by arithmetic
- [ ] Tensor cores do not support float accumulation
> At about 2 FLOPs per byte the kernel waits on memory. Faster multiplies change nothing until more queries share each loaded row, as in prefill or speculative decoding.
:::

# Inside paged_attention_v1

The kernel has five phases, and only the reductions and the final add need a barrier.

**Scores.** A warp has 32 lanes and a KV block has 16 tokens, so a warp scores a whole block at once with
**thread groups** of 2 lanes per token. Each lane holds half the query in registers, as 16 \`float4\`s
interleaved with its partner's, dots it against its half of the key, and one shuffle adds the halves:

\`\`\`cuda
for (int block_idx = warp; block_idx < num_seq_blocks; block_idx += NUM_WARPS) {
  const int64_t physical_block = block_table[block_idx];
  // qk = this lane's 64-float partial dot of q_vec with token \`group\` of the block
  qk += __shfl_xor_sync(0xffffffffu, qk, 1);    // every lane, valid token or not
  qk *= scale;
  if (token < seq_len) { if (group_offset == 0) logits[token] = qk; qk_max = fmaxf(qk_max, qk); }
}
\`\`\`

**Max and sum.** A softmax needs one max and one sum over the whole context, and the context is spread over
four warps. Each reduction is two levels: an XOR butterfly inside the warp, five shuffles that leave the
result in every lane, then one value per warp through shared memory and a barrier.

\`\`\`cuda
for (int mask = 16; mask >= 1; mask /= 2) qk_max = fmaxf(qk_max, __shfl_xor_sync(0xffffffffu, qk_max, mask));
if (lane == 0) red_max[warp] = qk_max;
__syncthreads();                         // also publishes every logits[] store
qk_max = fmaxf(fmaxf(red_max[0], red_max[1]), fmaxf(red_max[2], red_max[3]));
// logits[i] = __expf(logits[i] - qk_max) in place; the same two levels sum them through red_sum
\`\`\`

Step through the butterfly the reductions use, lane by lane:

:::widget warp-reduce

**V and the output.** The warps walk their blocks again; lane \`l\` owns channels \`l\`, \`l + 32\`, \`l + 64\` and
\`l + 96\` and adds \`p × v\` for each token. Each warp now holds a partial output over a quarter of the
context: the four meet in \`out_smem[4][128]\`, and after a barrier thread \`i\` adds channel \`i\` and
multiplies by \`1 / exp_sum\`. Splitting warps over keys like this is the "split-K" partitioning that
FlashAttention-2's paper moves away from for training, where there are many query rows to hand out; with
one query there are none, so decode keeps it and pays with this one exchange.

Each of these lines has a tempting wrong version:

| Wrong version | Why it fails | What the test sees |
|---|---|---|
| Shuffle inside \`if (token < seq_len)\` | lanes of short groups never reach a full-mask shuffle | undefined: a hang or wrong scores |
| One \`red[NUM_WARPS]\` for max and sum | a fast warp writes its sum while a slow warp still reads the maxima | wrong max, run to run |
| No \`token < seq_len\` test | the tail of the last block holds stale slots | NaN from the NaN-filled pool |
| \`__expf(logit)\` without the max | logits pass 88 when queries are large | \`inf / inf = NaN\` for the loud sequence |
| No barrier between the exponentials and the V pass | a warp reads \`logits[t]\` before the thread that owns \`t\` has exponentiated it | wrong weights for a few tokens |

:::details Why q sits in registers here and in shared memory in vLLM
vLLM loads the query into a \`__shared__\` array of vectors (\`q_vecs\`) once per block, and each lane reads its
vectors from there inside the dot product, which keeps register pressure down across the head sizes it
supports. In float with a 128-float head, a lane's half is 64 registers, which still fits, so this
project keeps it in registers and the inner loop does no shared-memory reads. Each lane loads its 16
\`float4\`s straight from global memory; 512 bytes are unique, and the repeats are served from cache.
:::

:::quiz
Q: Why is the shuffle that joins a thread group's two halves placed before the \`token < seq_len\` test, not inside it?
- [ ] The shuffle is cheaper outside a branch
- [x] A shuffle with a full mask must be executed by all 32 lanes, and lanes scoring past the end would skip it
- [ ] The test needs the joined score to decide
> \`__shfl_xor_sync(0xffffffff, …)\` names every lane. In the last block some groups score tokens past \`seq_len\`; if they skipped the shuffle, the lanes that reached it would wait for or read from lanes that never arrive. So every lane shuffles, and the test only decides what is stored.
:::

# Splitting the context: v2 and the reduce

v1 launches \`num_seqs × num_heads\` blocks. For a large batch that fills the GPU. For one long sequence it
does not:

| Sequences × context | v1 blocks | v2 blocks (512-token partitions) | vLLM runs |
|---|---|---|---|
| 1 × 2,048 | 32 | 128 | v2 |
| 1 × 8,192 | 32 | 512 | v2 |
| 4 × 8,192 | 128 | 2,048 | v2 |
| 32 × 1,024 | 1,024 | 2,048 | v1 |

On an A100's 108 SMs, the 1 × 8,192 case runs v1 on at most 32 SMs, each block walking 8,192 tokens alone.
v2 splits each context into partitions of 512 tokens, gives each (head, sequence, partition) its own block,
and adds a second kernel to merge them. Flash-Decoding (Stanford CRFM, October 2023) applies the same split
to FlashAttention for the same reason.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "v2-grid", "label": "Grid · one 6,000-token sequence", "sub": "paged_attention_v2<<<(32, 1, 12), 128>>>", "count": "384 blocks", "detail": "v1 would launch 32 blocks for this sequence. v2 launches one per (head, partition): 32 × 12. Blocks of shorter sequences past their own end return at once.", "items": [
      {"id": "v2-p0", "label": "Partition 0", "sub": "tokens 0 … 511", "layout": "column", "detail": "v1’s body on blocks 0 … 31: its own max \`m_0\`, exp-sum \`l_0\` and output \`o_0 / l_0\`.", "items": [
        {"threads": 8, "continues": true, "label": "4 warps · 32 KV blocks"},
        {"array": "logits[512]", "sub": "a cell = 64 tokens", "cols": 8, "tone": "shared", "detail": "Static shared memory, 2 KB whatever the context: indexed by \`token − start_token\`."}
      ]},
      {"id": "v2-p1", "label": "Partition 1", "sub": "tokens 512 … 1,023", "layout": "column", "items": [
        {"threads": 8, "continues": true, "label": "4 warps · 32 KV blocks"},
        {"array": "logits[512]", "sub": "a cell = 64 tokens", "cols": 8, "tone": "shared"}
      ]},
      {"gap": "…"},
      {"id": "v2-plast", "label": "Partition 11", "sub": "tokens 5,632 … 5,999", "layout": "column", "detail": "\`end_block = min(352 + 32, 375) = 375\`, \`end_token = min(5,632 + 512, 6,000) = 6,000\`: 368 tokens, the last KV block holding 16.", "items": [
        {"threads": 8, "continues": true, "label": "4 warps · 23 KV blocks"},
        {"array": "logits[512]", "sub": "368 used", "cols": 8, "tone": "shared", "marks": [{"cols": [6,7], "tone": "muted", "label": "unused"}]}
      ]}
    ]},
    {"id": "v2-hbm", "label": "Global memory", "sub": "partials · one row per (seq, head, partition)", "tone": "global", "stretch": true, "items": [
      {"id": "v2-max", "array": "max_logits[12]", "sub": "m_p", "cols": 12, "cells": "index", "detail": "Each partition’s max score. The reduce takes their max \`m\`."},
      {"id": "v2-sums", "array": "exp_sums[12]", "sub": "l_p = Σ exp(s − m_p)", "cols": 12, "cells": "index", "detail": "Each partition’s sum, against its own max: not comparable across partitions until rescaled."},
      {"id": "v2-tmp", "array": "tmp_out[12][128]", "sub": "o_p / l_p · a cell = 8 channels", "cols": 16, "rows": 12, "detail": "Each partition’s output, normalised by its own \`l_p\`: a weighted mean of its V rows."},
      {"id": "v2-out", "array": "out[128]", "sub": "one row per (seq, head)", "cols": 16, "marks": [{"cols": [0,15], "tone": "register", "label": "written once"}], "detail": "\`out[i] = Σ_p tmp_out[p][i] × weights[p] / Σ_p weights[p]\`: exactly v1’s answer, up to float rounding."}
    ]},
    {"id": "v2-reduce", "label": "paged_attention_v2_reduce", "sub": "<<<(32, 1), 128>>> · 48 B of shared memory", "count": "32 blocks", "layout": "row", "align": "end", "detail": "One block per (head, sequence). A sequence with one partition copies its row; this one has twelve.", "items": [
      {"threads": 8, "continues": true, "label": "128 threads"},
      {"id": "v2-weights", "array": "weights[12]", "sub": "l_p · exp(m_p − m)", "cols": 12, "cells": "index", "tone": "shared", "detail": "\`m = max_p m_p\` (block reduction), then \`weights[p] = exp_sums[p] × expf(max_logits[p] − m)\`: each partition’s share of the global softmax denominator."}
    ]}
  ],
  "arrows": [
    {"from": "v2-p0", "to": "v2-hbm", "label": "m_0, l_0, o_0"},
    {"from": "v2-plast", "to": "v2-hbm", "label": "m_11, l_11, o_11"},
    {"from": "v2-sums", "to": "v2-weights", "label": "m_p, l_p"},
    {"from": "v2-reduce", "to": "v2-out", "label": "Σ w_p o_p / Σ w_p"}
  ]
}
:::

A partition runs v1's body on its own range and keeps three things: its max \`m_p\`, its exp-sum \`l_p\` and
its output divided by \`l_p\`. The merge needs one identity:

\`\`\`text
exp(s − m) = exp(s − m_p) · exp(m_p − m)            m = max over p of m_p
w_p   = l_p · exp(m_p − m)                          partition p's share of the denominator
out   = Σ_p w_p · (o_p / l_p) / Σ_p w_p
\`\`\`

Every term of partition \`p\` was computed against \`m_p\`; multiplying by \`exp(m_p − m)\` re-expresses it
against the global max, so the result is exactly v1's, up to float rounding. The test requires
\`max|v2 − v1| < 1e-4\`. It is the online-softmax rescale applied once per partition instead of once per tile:

:::widget online-softmax {"tile": 4}

- **Empty partitions leave.** The grid is sized for the longest sequence; a block whose partition starts
  past its own sequence's end returns before any barrier.
- **Shared memory stops growing.** v1 needs \`seq_len × 4\` bytes of logits; v2 needs 2 KB per block whatever
  the context, which is why vLLM uses v2 for every context past 8,192 tokens.
- **One partition, no reduce.** A sequence that fits in one partition already has its answer; the reduce
  copies it.
- **The heuristic.** vLLM runs v1 when the longest context fits in one partition, or when
  \`num_seqs × num_heads > 512\` already fills the GPU, and v2 otherwise; the extra launch and the round trip
  of the partials through HBM are what v2 costs.

The merge has its own wrong versions:

| Reduce | Result |
|---|---|
| \`w_p = l_p · exp(m_p − m)\` (correct) | equals v1 |
| \`w_p = l_p\` | each \`l_p\` was summed against a different max, so partitions are weighted wrongly |
| \`atomicAdd\` of \`o_p\` into \`out\` | a sum of up to 12 means instead of one weighted mean |
| Reads all \`max_num_partitions\` rows | reads partitions a shorter sequence never wrote (NaN in the test) |

:::quiz
Q: Partition 0 has max 3 and exp-sum 10; partition 1 has max 5 and exp-sum 4. What weight does partition 0 get in the merge?
- [ ] 10, its exp-sum
- [x] 10 · exp(3 − 5), its exp-sum re-expressed against the global max 5
- [ ] 10 / 14, its share of the raw exp-sums
> Partition 0's sum was taken against max 3. Against the global max 5 every one of its terms is smaller by exp(3 − 5), so its share of the denominator is 10 · exp(−2), about 1.35, beside partition 1's 4.
:::

# What production kernels add

The three kernels here are vLLM's in structure and simplified in arithmetic. The production versions add:

| Concern | This project | vLLM's kernels |
|---|---|---|
| Storage | float | fp16 or bf16, or fp8 with \`k_scale\` / \`v_scale\` |
| K layout | \`[blocks, 16, kv_heads, 128]\` | \`[blocks, kv_heads, 128/x, 16, x]\` for 16-byte loads |
| V layout | same as K | transposed, \`[blocks, kv_heads, 128, 16]\` |
| Head sizes | 128 | templates for 64 to 256 |
| Masks | none | ALiBi slopes, block-sparse patterns |
| Logits | exponentials, normalised at the end | normalised in place before the V pass |

- **Block sharing.** Parallel sampling, beam search and shared prefixes point several block tables at the
  same physical blocks, with a reference count per block and copy-on-write when a shared last block is
  written. The attention kernels do not change: they only follow the table.
- **CUDA graphs.** Decode steps are short, so launch overhead matters; engines capture the whole step at a
  few batch sizes, which is where the padding slots of step 1 come from.
- **Other kernels, same contract.** vLLM's FlashAttention backend writes the cache with
  \`reshape_and_cache_flash\` in this project's layout and passes the block table to FlashAttention's paged
  KV kernels; FlashInfer's paged kernels take each sequence's list of pages in the same spirit. A table of
  blocks in, one output row per query head out: the interface outlived the kernels that introduced it.

:::quiz
Q: Two beam-search candidates share their first 30 blocks. What must the attention kernel do differently?
- [x] Nothing: both block tables list the same physical blocks, and the kernel follows each table
- [ ] Copy the shared blocks into each candidate's own region before reading
- [ ] Lock the shared blocks while one candidate reads them
> Sharing lives entirely in the block tables and the block manager's reference counts. Reads need no coordination, and copy-on-write happens before a write, in the scheduler, not in attention.
:::

# What to take away

- Paging the KV cache trades contiguous memory for an indirection: blocks of 16 tokens anywhere in a pool,
  a block table per sequence, and waste bounded by one block.
- \`reshape_and_cache\` is a scatter by slot: one block per token, \`int64\` offsets, padding slot -1 skipped
  before any arithmetic.
- Decode attention streams K and V at about 2 FLOPs per byte; the kernels are designed around reading each
  byte once, in wide pieces, from enough blocks at once.
- v1 gives each (head, sequence) one block: warps over KV blocks, two lanes per key joined by a full-warp
  shuffle, logits in shared memory, two-level max and sum reductions with separate buffers.
- v2 splits long contexts into 512-token partitions and merges them exactly with
  \`w_p = l_p · exp(m_p − m)\`, buying parallelism when there are few sequences.

Primary reference: Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180).
vLLM's kernels at v0.6.3: [\`attention_kernels.cu\`](https://github.com/vllm-project/vllm/blob/v0.6.3/csrc/attention/attention_kernels.cu)
and [\`cache_kernels.cu\`](https://github.com/vllm-project/vllm/blob/v0.6.3/csrc/cache_kernels.cu); the
[design walkthrough](https://docs.vllm.ai/en/stable/design/paged_attention/) in vLLM's documentation;
[Flash-Decoding for long-context inference](https://crfm.stanford.edu/2023/10/12/flashdecoding.html);
[FlashAttention-2](https://arxiv.org/abs/2307.08691) for the split-K discussion; NVIDIA's
[Using CUDA Warp-Level Primitives](https://developer.nvidia.com/blog/using-cuda-warp-level-primitives/) for
shuffle masks.
`;
