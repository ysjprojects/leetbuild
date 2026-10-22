import type {GpuMark} from '@/lib/gpuFigure';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {reshapeAndCacheStep} from './steps/1-reshape-and-cache';
import {pagedAttentionV1Step} from './steps/2-paged-attention-v1';
import {pagedAttentionV2Step} from './steps/3-paged-attention-v2';

/** Sequence 1 of the figures (category `a`): 70 tokens in physical blocks 7, 2, 12, 5 and 9 of a 16-block pool. */
const SEQUENCE_1_BLOCKS: GpuMark[] = [
  {rows: [7, 7], cols: [0, 15], tone: 'a', label: 'logical 0'},
  {rows: [2, 2], cols: [0, 15], tone: 'a', label: 'logical 1'},
  {rows: [12, 12], cols: [0, 15], tone: 'a', label: 'logical 2'},
  {rows: [5, 5], cols: [0, 15], tone: 'a', label: 'logical 3'},
  {rows: [9, 9], cols: [0, 5], tone: 'a', label: 'logical 4'},
  {rows: [9, 9], cols: [6, 15], tone: 'muted', label: 'stale'},
];

/**
 * Project: vLLM's PagedAttention kernels in CUDA, in float. reshape_and_cache scatters a step's new K/V
 * rows into 16-token blocks by slot; paged_attention_v1 runs decode attention with one thread block per
 * (head, sequence), walking the block table; paged_attention_v2 splits long contexts into 512-token
 * partitions and merges them with a reduce kernel.
 */
export const cudaPagedAttentionProblem: Problem = {
  id: 'cuda-paged-attention',
  title: 'PagedAttention kernels in CUDA',
  tagline:
    'vLLM’s three PagedAttention kernels: scatter new K/V rows into 16-token blocks by slot, decode attention that walks each sequence’s block table, and the v2 split into 512-token partitions merged by exp(m_p − m).',
  difficulty: 'hard',
  track: 'dllm',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 120,
  statement: `# PagedAttention kernels in CUDA

vLLM (Kwon et al., SOSP 2023) serves LLMs from a KV cache cut into blocks of 16 tokens: any block anywhere
in one preallocated pool, and a **block table** per sequence that maps its logical blocks to physical
ones, as a page table maps pages to frames. Paging ends the fragmentation of per-request contiguous
reservations, so more sequences fit in a batch; the cost is that attention can no longer read a
sequence's keys as one array. Three kernels pay it, between the scheduler (which hands out slots and
block tables) and the attention layer, at every decode step of vLLM's original CUDA backend; newer
backends pass the same block tables to FlashAttention or FlashInfer kernels.

You write the three in CUDA C++ 12, in float, for Llama-3 8B's attention shape (32 query heads, 8 KV
heads, head size 128), with blocks of 16 tokens and 128 threads per attention block. Each file is a
complete program, and later files repeat the earlier kernels they need.

- \`reshape_and_cache.cu\`: \`__global__ void reshape_and_cache(const float* key, const float* value,
  float* key_cache, float* value_cache, const int64_t* slot_mapping, int num_kv_heads, int head_size,
  int block_size)\`. \`key\`, \`value\`: \`[num_tokens, num_kv_heads, head_size]\`; the caches:
  \`[num_blocks, block_size, num_kv_heads, head_size]\`; one thread block per token; slot \`-1\` is padding.
- \`paged_attention_v1.cu\`: \`__global__ void paged_attention_v1(float* out, const float* q, const float*
  k_cache, const float* v_cache, const int* block_tables, const int* seq_lens, int max_num_blocks_per_seq,
  int num_kv_heads, float scale)\`. \`q\`, \`out\`: \`[num_seqs, num_heads, 128]\`; \`block_tables\`:
  \`[num_seqs, max_num_blocks_per_seq]\` \`int\`; grid \`(num_heads, num_seqs)\`; one float of dynamic shared
  memory per context token.
- \`paged_attention_v2.cu\`: \`paged_attention_v2(float* exp_sums, float* max_logits, float* tmp_out, …)\`
  with v1's inputs over a grid \`(num_heads, num_seqs, ⌈max_len / 512⌉)\`, and
  \`paged_attention_v2_reduce(float* out, const float* exp_sums, const float* max_logits, const float*
  tmp_out, const int* seq_lens, int max_num_partitions)\` over \`(num_heads, num_seqs)\`. The partials are
  \`[num_seqs, num_heads, max_num_partitions]\` floats and as many 128-float outputs.

Storage is float throughout. vLLM stores fp16, bf16 or fp8 with the same indexing; float keeps every check
tight, and step 1's bitwise.

## What you build here

1. \`reshape_and_cache\`: the scatter of a step's new K/V rows into their slots, one thread block per
   token, \`int64\` slots split into (block, offset), padding skipped before any store.
2. \`paged_attention_v1\`: decode attention with one thread block per (head, sequence): q in registers,
   warps walking the KV blocks through the block table, two-lane dot products joined by a warp shuffle,
   logits in shared memory, block-wide max and sum, the V accumulation, grouped-query heads.
3. \`paged_attention_v2\`: the context split into 512-token partitions, each writing a partial max,
   exp-sum and output, and the reduce that rescales them by \`exp(m_p − m)\`: equal to v1, and faster when a
   few long sequences leave v1's grid too small for the GPU.

## Run it on your machine

\`\`\`sh
nvcc -O2 -o reshape_and_cache reshape_and_cache.cu && ./reshape_and_cache
nvcc -O2 -o paged_attention_v1 paged_attention_v1.cu && ./paged_attention_v1
nvcc -O2 -o paged_attention_v2 paged_attention_v2.cu && ./paged_attention_v2
\`\`\`

Any NVIDIA GPU with CUDA 12 and about 400 MB of free memory. Each program runs in seconds, most of them on
the CPU reference.

- \`reshape_and_cache\` prints the batches, the blocks of the last sequence, how many slots differ from a
  CPU scatter, and the scatter's time and bandwidth. \`PASS\` means the whole pool, two guard blocks
  included, is bitwise what a CPU walk of the block tables produces: every row in its slot, no padding
  written, nothing else touched.
- \`paged_attention_v1\` prints each sequence's max error against a double-precision CPU attention over
  contiguous K/V, the largest logit (past 88, where \`expf\` overflows float) and the kernel's time.
  \`PASS\` means every output is within \`1e-3\`.
- \`paged_attention_v2\` prints \`max|v2 − v1|\` and both errors against the CPU, then v1 against v2 plus the
  reduce for 1 to 32 sequences of 1,024 to 8,192 tokens, with the kernel vLLM's heuristic would pick.
  \`PASS\` means v2 equals v1 within \`1e-4\` and both match the CPU; the timings are for reading, not part
  of the check.

## Left out on purpose

fp16, bf16 and fp8 KV storage and their scales; vLLM's \`x\`-split K layout and transposed V; the block
manager itself (allocation, freeing, reference counts, copy-on-write, prefix caching); attention over
paged KV during prefill; ALiBi, sliding-window and block-sparse masks; several queries per sequence, as
speculative decoding needs; tensor cores (one query is a matrix-vector product); CUDA graphs; ROCm.`,
  figures: [
    {
      title: 'Writing new tokens into their slots',
      gpu: {
        items: [
          {
            id: 'rc-in',
            label: 'Global memory',
            sub: 'this step’s new rows',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'rc-key',
                array: 'key [8][8][128]',
                sub: 'a row = one token',
                cols: 8,
                rows: 8,
                marks: [
                  {rows: [1, 1], cols: [0, 7], tone: 'b', label: 'token 1'},
                  {rows: [5, 7], cols: [0, 7], tone: 'muted', label: 'padding'},
                ],
                detail:
                  'This step’s K rows, contiguous, as the QKV projection wrote them: a cell is one KV head, 128 floats, so a row is 4 KB. `value` has the same shape.',
              },
              {
                id: 'rc-slots',
                array: 'slot_mapping [8]',
                sub: 'int64 · from the host',
                cols: 8,
                cells: ['52', '150', '234', '1', '191', '-1', '-1', '-1'],
                marks: [
                  {cols: [1, 1], tone: 'b'},
                  {cols: [5, 7], tone: 'muted', label: 'padding'},
                ],
                detail:
                  'The scheduler computes `slot = block_table[pos / 16] × 16 + pos % 16` for every token. Sequence 1’s table is 7, 2, 12, 5, 9, so its token at position 70 is logical block 4, physical block 9, offset 6: slot 150.',
              },
            ],
          },
          {
            id: 'rc-grid',
            label: 'Grid · one decode step',
            sub: 'reshape_and_cache<<<8, 512>>>',
            count: '8 blocks',
            layout: 'column',
            detail:
              'One thread block per new token. Five sequences decode one token each and the batch is padded to 8, a size a CUDA graph was captured at.',
            items: [
              {
                id: 'rc-token',
                label: 'Block 1',
                sub: 'seq 1, position 70',
                layout: 'column',
                items: [
                  {
                    threads: 16,
                    continues: true,
                    label: '512 threads, 2 floats each',
                    detail:
                      'Thread `t` copies floats `t` and `t + 512` of the token’s 1,024 (`head = i / 128`, `d = i % 128`), so a warp reads and writes 128 contiguous bytes at a time.',
                  },
                ],
                detail:
                  '`slot = 150`: `block_idx = 150 / 16 = 9`, `block_offset = 150 % 16 = 6`. The K row goes to `key_cache[9][6][head][d]`, the V row to the same place in `value_cache`.',
              },
              {gap: '…'},
              {
                id: 'rc-pad',
                label: 'Block 7',
                sub: 'padding · slot -1',
                layout: 'column',
                items: [{threads: 16, idle: 16, continues: true, label: 'returns at once'}],
                detail:
                  'Slot -1: the block returns before any store. Without the test, C++ gives `-1 / 16 = 0` and `-1 % 16 = -1`, and the padding row lands in the slot just before block 0.',
              },
            ],
          },
          {
            id: 'rc-hbm',
            label: 'Global memory',
            sub: 'the paged cache',
            tone: 'global',
            items: [
              {
                id: 'rc-cache',
                array: 'key_cache [16][16]',
                sub: 'a row = one block · a cell = one slot',
                cols: 16,
                rows: 16,
                marks: [
                  {rows: [7, 7], cols: [0, 15], tone: 'a', label: 'seq 1'},
                  {rows: [2, 2], cols: [0, 15], tone: 'a', label: 'seq 1'},
                  {rows: [12, 12], cols: [0, 15], tone: 'a', label: 'seq 1'},
                  {rows: [5, 5], cols: [0, 15], tone: 'a', label: 'seq 1'},
                  {rows: [9, 9], cols: [0, 5], tone: 'a'},
                  {rows: [9, 9], cols: [6, 6], tone: 'b'},
                  {rows: [3, 3], cols: [4, 4], tone: 'b'},
                  {rows: [14, 14], cols: [10, 10], tone: 'b'},
                  {rows: [0, 0], cols: [1, 1], tone: 'b'},
                  {rows: [11, 11], cols: [15, 15], tone: 'b'},
                ],
                detail:
                  'An illustrative 16-block pool (the test’s has 256). Sequence 1’s first 70 tokens fill blocks 7, 2, 12 and 5 and six slots of block 9; this step writes its token at position 70 into slot 6 of block 9, and the other four sequences’ tokens into their own slots.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'rc-key', to: 'rc-token', label: 'row 1 · 4 KB'},
          {from: 'rc-slots', to: 'rc-token', label: 'slot 150'},
          {from: 'rc-token', to: 'rc-cache', label: 'block 9, offset 6'},
        ],
      },
    },
    {
      title: 'One block per sequence and head',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'v1-block',
            label: 'Thread block (head 5, seq 1)',
            sub: 'paged_attention_v1<<<(32, 8), 128>>>',
            count: '256 blocks',
            layout: 'row',
            align: 'end',
            detail:
              '`head = blockIdx.x = 5`, `seq = blockIdx.y = 1`, `kv_head = 5 / (32 / 8) = 1`. The block computes one 128-float output row from a 70-token context.',
            items: [
              {
                id: 'v1-warps',
                label: 'Warps',
                sub: 'warp w: KV blocks w, w + 4, …',
                layout: 'grid',
                columns: 2,
                detail:
                  'Five logical blocks over four warps: warp 0 takes blocks 0 and 4, the others one each. The same split serves the V pass.',
                items: [
                  {
                    label: 'Warp 0',
                    sub: 'blocks 0, 4',
                    layout: 'column',
                    items: [
                      {
                        threads: 16,
                        label: '16 groups of 2 lanes',
                        detail:
                          'Group `g` scores token `g` of the block: each lane dots its 64 floats of q against 64 of the key, one `__shfl_xor_sync(…, 1)` joins the halves, and lane 0 of the group stores `logits[token]`.',
                      },
                    ],
                  },
                  {label: 'Warp 1', sub: 'block 1', layout: 'column', items: [{threads: 16, label: '16 groups of 2'}]},
                  {label: 'Warp 2', sub: 'block 2', layout: 'column', items: [{threads: 16, label: '16 groups of 2'}]},
                  {label: 'Warp 3', sub: 'block 3', layout: 'column', items: [{threads: 16, label: '16 groups of 2'}]},
                ],
              },
              {
                label: 'Registers, per lane',
                tone: 'register',
                layout: 'column',
                items: [
                  {
                    id: 'v1-q',
                    array: 'q_vec[16]',
                    sub: 'float4 · half the head',
                    cols: 16,
                    tone: 'register',
                    detail:
                      'Float4 number `group_offset + 2i` of `q[1][5]`, loaded once: the two lanes of a group hold interleaved halves, so their loads of one key are 32 contiguous bytes.',
                  },
                  {
                    id: 'v1-acc',
                    array: 'acc[4]',
                    sub: 'channels lane + 32j',
                    cols: 4,
                    tone: 'register',
                    detail:
                      '`acc[j] += p × v_row[lane + 32j]` over the warp’s tokens: a partial output for 4 of the 128 channels.',
                  },
                ],
              },
              {
                label: 'Shared memory',
                tone: 'shared',
                layout: 'column',
                items: [
                  {
                    id: 'v1-logits',
                    array: 'logits[80]',
                    sub: 'a row = one KV block · 70 used',
                    cols: 16,
                    rows: 5,
                    tone: 'shared',
                    marks: [{rows: [4, 4], cols: [6, 15], tone: 'muted', label: 'past seq_len'}],
                    detail:
                      'Dynamic shared memory, `⌈70 / 16⌉ × 16 × 4 = 320` bytes here. Scores first, then `__expf(logit − qk_max)` in place. Slots 70 … 79 of the last block are never stored or read.',
                  },
                  {
                    id: 'v1-red',
                    array: 'red_max, red_sum',
                    sub: 'one slot per warp each',
                    cols: 8,
                    cells: ['m0', 'm1', 'm2', 'm3', 'l0', 'l1', 'l2', 'l3'],
                    tone: 'shared',
                    detail:
                      'Two arrays: each warp’s butterfly result goes in, `__syncthreads()`, every thread folds the four. One shared array would let a fast warp overwrite a max with its sum.',
                  },
                  {
                    id: 'v1-out-smem',
                    array: 'out_smem[4][128]',
                    sub: 'a cell = 8 channels',
                    cols: 16,
                    rows: 4,
                    tone: 'shared',
                    detail:
                      'Each warp’s `acc` for all 128 channels; after a barrier thread `i` adds the four rows for channel `i`.',
                  },
                ],
              },
            ],
          },
          {
            id: 'v1-hbm',
            label: 'Global memory',
            sub: 'HBM',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'v1-table',
                array: 'block_tables[1]',
                sub: 'logical → physical',
                cols: 5,
                cells: ['7', '2', '12', '5', '9'],
                detail:
                  'Sequence 1’s row of `block_tables`. Logical block `b` of the context is physical block `block_tables[1][b]`; every K and V address goes through it.',
              },
              {
                id: 'v1-k',
                array: 'k_cache [16][16]',
                sub: 'a row = one block · a cell = one slot',
                cols: 16,
                rows: 16,
                marks: SEQUENCE_1_BLOCKS,
                detail:
                  'An illustrative 16-block pool. Sequence 1 owns blocks 7, 2, 12, 5 and 9 in that logical order; the last holds 6 tokens and 10 stale slots (NaN in the test).',
              },
              {
                id: 'v1-v',
                array: 'v_cache [16][16]',
                sub: 'same blocks, same slots',
                cols: 16,
                rows: 16,
                marks: SEQUENCE_1_BLOCKS,
                detail: 'Read in the second pass with the same warp split; the stale tail is never touched.',
              },
              {
                id: 'v1-out',
                array: 'out [8][32][128]',
                sub: 'a row = one sequence',
                cols: 8,
                rows: 8,
                marks: [{rows: [1, 1], cols: [1, 1], tone: 'b', label: 'head 5'}],
                detail:
                  '`out[1][5][i] = (Σ_w out_smem[w][i]) / exp_sum`: one store per channel, the only global write of the kernel.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'v1-k', to: 'v1-q', label: 'K · float4'},
          {from: 'v1-v', to: 'v1-acc', label: 'V rows'},
          {from: 'v1-out-smem', to: 'v1-out', label: 'Σ warps / l'},
        ],
      },
    },
    {
      title: 'v2: partitions and the reduce',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'v2-grid',
            label: 'Grid · one 6,000-token sequence',
            sub: 'paged_attention_v2<<<(32, 1, 12), 128>>>',
            count: '384 blocks',
            detail:
              'v1 would launch 32 blocks for this sequence. v2 launches one per (head, partition): 32 × 12. Blocks of shorter sequences past their own end return at once.',
            items: [
              {
                id: 'v2-p0',
                label: 'Partition 0',
                sub: 'tokens 0 … 511',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '4 warps · 32 KV blocks'},
                  {
                    array: 'logits[512]',
                    sub: 'a cell = 64 tokens',
                    cols: 8,
                    tone: 'shared',
                    detail: 'Static shared memory, 2 KB whatever the context: indexed by `token − start_token`.',
                  },
                ],
                detail: 'v1’s body on blocks 0 … 31: its own max `m_0`, exp-sum `l_0` and output `o_0 / l_0`.',
              },
              {
                id: 'v2-p1',
                label: 'Partition 1',
                sub: 'tokens 512 … 1,023',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '4 warps · 32 KV blocks'},
                  {array: 'logits[512]', sub: 'a cell = 64 tokens', cols: 8, tone: 'shared'},
                ],
              },
              {gap: '…'},
              {
                id: 'v2-plast',
                label: 'Partition 11',
                sub: 'tokens 5,632 … 5,999',
                layout: 'column',
                items: [
                  {threads: 8, continues: true, label: '4 warps · 23 KV blocks'},
                  {
                    array: 'logits[512]',
                    sub: '368 used',
                    cols: 8,
                    tone: 'shared',
                    marks: [{cols: [6, 7], tone: 'muted', label: 'unused'}],
                  },
                ],
                detail:
                  '`end_block = min(352 + 32, 375) = 375`, `end_token = min(5,632 + 512, 6,000) = 6,000`: 368 tokens, the last KV block holding 16.',
              },
            ],
          },
          {
            id: 'v2-hbm',
            label: 'Global memory',
            sub: 'partials · one row per (seq, head, partition)',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'v2-max',
                array: 'max_logits[12]',
                sub: 'm_p',
                cols: 12,
                cells: 'index',
                detail: 'Each partition’s max score. The reduce takes their max `m`.',
              },
              {
                id: 'v2-sums',
                array: 'exp_sums[12]',
                sub: 'l_p = Σ exp(s − m_p)',
                cols: 12,
                cells: 'index',
                detail: 'Each partition’s sum, against its own max: not comparable across partitions until rescaled.',
              },
              {
                id: 'v2-tmp',
                array: 'tmp_out[12][128]',
                sub: 'o_p / l_p · a cell = 8 channels',
                cols: 16,
                rows: 12,
                detail: 'Each partition’s output, normalised by its own `l_p`: a weighted mean of its V rows.',
              },
              {
                id: 'v2-out',
                array: 'out[128]',
                sub: 'one row per (seq, head)',
                cols: 16,
                marks: [{cols: [0, 15], tone: 'register', label: 'written once'}],
                detail:
                  '`out[i] = Σ_p tmp_out[p][i] × weights[p] / Σ_p weights[p]`: exactly v1’s answer, up to float rounding.',
              },
            ],
          },
          {
            id: 'v2-reduce',
            label: 'paged_attention_v2_reduce',
            sub: '<<<(32, 1), 128>>> · 48 B of shared memory',
            count: '32 blocks',
            layout: 'row',
            align: 'end',
            detail:
              'One block per (head, sequence). A sequence with one partition copies its row; this one has twelve.',
            items: [
              {threads: 8, continues: true, label: '128 threads'},
              {
                id: 'v2-weights',
                array: 'weights[12]',
                sub: 'l_p · exp(m_p − m)',
                cols: 12,
                cells: 'index',
                tone: 'shared',
                detail:
                  '`m = max_p m_p` (block reduction), then `weights[p] = exp_sums[p] × expf(max_logits[p] − m)`: each partition’s share of the global softmax denominator.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'v2-p0', to: 'v2-hbm', label: 'm_0, l_0, o_0'},
          {from: 'v2-plast', to: 'v2-hbm', label: 'm_11, l_11, o_11'},
          {from: 'v2-sums', to: 'v2-weights', label: 'm_p, l_p'},
          {from: 'v2-reduce', to: 'v2-out', label: 'Σ w_p o_p / Σ w_p'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Efficient Memory Management for Large Language Model Serving with PagedAttention',
      url: 'https://arxiv.org/abs/2309.06180',
      by: 'Woosuk Kwon et al.',
      date: '2023-09-12',
      venue: 'SOSP 2023',
      takes:
        'The 16-token blocks and block tables, and the fused reshape-and-write and block-read kernels with one warp per KV block that `reshape_and_cache` and `paged_attention_v1` rebuild.',
    },
    {
      kind: 'paper',
      title: 'FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning',
      url: 'https://arxiv.org/abs/2307.08691',
      by: 'Tri Dao',
      date: '2023-07-17',
      venue: 'ICLR 2024',
      takes:
        'The "split-K" partitioning, warps that divide the keys and merge through shared memory, which `paged_attention_v1` uses because a decode step has one query, and the case for parallelising long sequences that step 3 applies to the KV axis.',
    },
    {
      kind: 'code',
      title: 'vLLM',
      url: 'https://github.com/vllm-project/vllm',
      by: 'vLLM project',
      date: '2023-02-09',
      venue: 'GitHub',
      takes:
        '`reshape_and_cache` in `csrc/cache_kernels.cu`, and `paged_attention_v1`, `paged_attention_v2` and `paged_attention_v2_reduce` in `csrc/attention/` with `PARTITION_SIZE = 512` and the v1/v2 heuristic, rebuilt here in float.',
    },
    {
      kind: 'post',
      title: 'Flash-Decoding for long-context inference',
      url: 'https://crfm.stanford.edu/2023/10/12/flashdecoding.html',
      by: 'Tri Dao et al.',
      date: '2023-10-12',
      venue: 'Stanford CRFM blog',
      takes:
        'Splitting one long context across thread blocks and merging the splits by their log-sum-exp: the reason `paged_attention_v2` and its reduce exist.',
    },
    {
      kind: 'docs',
      title: 'Paged Attention',
      url: 'https://docs.vllm.ai/en/stable/design/paged_attention/',
      venue: 'vLLM documentation',
      takes:
        'The walkthrough of thread groups, `q_vecs` and `k_vecs`, the `qk_max` and `exp_sum` reductions and the `accs` V loop that `paged_attention_v1` follows.',
    },
  ],
  steps: [reshapeAndCacheStep, pagedAttentionV1Step, pagedAttentionV2Step],
  learn,
};
