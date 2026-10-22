import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {blockManagerStep} from './steps/1-block-manager';
import {pagedAttentionStep} from './steps/2-paged-attention';
import {schedulerStep} from './steps/3-scheduler';
import {prefixCacheStep} from './steps/4-prefix-cache';

/**
 * Deep-learning project: a mini vLLM in PyTorch. A block manager with ref counts and copy-on-write, a
 * paged KV cache read through block tables, a continuous-batching scheduler with preemption by
 * recompute driving a tiny model, and automatic prefix caching with LRU eviction.
 */
export const ptMiniVllmProblem: Problem = {
  id: 'pt-mini-vllm',
  title: 'A mini vLLM: PagedAttention, continuous batching',
  tagline:
    'Build the core of vLLM in four files: block tables with ref counts and copy-on-write, attention that reads a paged KV cache, a scheduler that re-forms the batch every step and preempts, and a hashed prefix cache.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 150,
  statement: `# A mini vLLM: PagedAttention, continuous batching, prefix caching

vLLM (Kwon et al., UC Berkeley, SOSP 2023) is an open-source LLM inference and serving engine; SGLang,
TensorRT-LLM and Hugging Face TGI use the same ideas. It sits between the model and the API: every
iteration it decides which requests run, where their keys and values live, and which tokens are already
computed. Three ideas carry it:

- **PagedAttention.** The KV cache is a pool of fixed-size blocks; each sequence has a block table
  mapping its logical blocks to physical ones, as an OS page table maps virtual pages to frames. Waste
  falls to less than one block per sequence, and sequences can share blocks.
- **Continuous batching** (Orca, OSDI 2022). The batch is re-formed every forward pass: finished
  requests leave, waiting ones join, and when blocks run out the newest request is preempted.
- **Automatic prefix caching.** A full block is named by a hash of its tokens and everything before them,
  so the next request with the same system prompt reuses the blocks instead of recomputing them.

You write four files, each importing the previous one:

- \`block_manager.py\`: \`BlockAllocator(num_blocks, block_size)\` with a \`free_list\` deque, \`ref_count\`,
  \`allocate() -> int\`, \`incref(block)\`, \`free(block)\`; \`BlockManager(num_blocks, block_size)\` with
  \`block_tables: dict[int, list[int]]\`, \`append_slots(seq_id, n) -> list[int]\` (slot =
  \`block * block_size + offset\`), \`slot_mapping(seq_id, start, end)\`, \`fork(parent_id, child_id)\`,
  copy-on-write pairs in \`take_copies()\`, \`free(seq_id)\`, \`waste(seq_id)\`.
- \`paged_attention.py\`: \`allocate_kv_cache(num_blocks, block_size, n_kv_heads, head_dim, dtype)\` (two
  tensors \`[num_blocks, block_size, n_kv_heads, head_dim]\`), \`write_kv(k, v, k_cache, v_cache,
  slot_mapping)\`, \`copy_blocks\`, and \`paged_attention(q [N, n_heads, head_dim], k_cache, v_cache,
  block_tables [N, max_blocks] long, context_lens [N] long) -> [N, n_heads, head_dim]\` with GQA.
- \`scheduler.py\`: \`Sequence\`, \`Scheduler(block_manager, max_num_seqs, max_num_batched_tokens)\` with
  \`schedule() -> ("prefill" | "decode", seqs)\`, \`preempt\`, \`finish\`; a given \`TinyLM\`; \`LLMEngine(model,
  num_blocks, block_size, eos_id)\` with \`step()\` and \`generate(prompts, max_tokens) -> list[list[int]]\`
  (greedy).
- \`prefix_cache.py\`: \`block_hash(prev_hash, token_ids)\`, \`PrefixCachingAllocator\` (an LRU free queue),
  \`PrefixCachingBlockManager\` and \`PrefixCachingEngine\`.

## What you build here

1. **Block manager**: a free list and ref counts, per-sequence block tables that grow one block at a
   time, slot ids, fork with shared blocks, copy-on-write, free.
2. **PagedAttention**: a KV cache in blocks, writes by slot, attention that gathers through the block
   table and masks past each row's context length, equal to dense attention over shuffled blocks.
3. **Continuous batching**: prefill batches admitted while blocks suffice, decode batches of every running
   sequence, preemption of the newest by recompute, and an engine whose outputs equal one-at-a-time
   greedy decoding even when the pool forces preemption.
4. **Prefix caching**: hash-chained full blocks shared by ref count, only the uncached suffix prefilled,
   freed blocks evicted in LRU order.

## Run it on your machine

Put the four files in one directory and run \`python block_manager.py\`, \`python paged_attention.py\`,
\`python scheduler.py\` and \`python prefix_cache.py\` (Python 3.10 or later, PyTorch 2, CPU only; each
takes about a second). \`PASS\` means: the allocator's invariants hold through forks, copy-on-write and
frees, with at most \`block_size - 1\` wasted slots per sequence; paged attention equals dense attention
to 1e-12 in float64; the engine's tokens equal sequential greedy decoding with a contiguous cache, with
and without preemption, and every block comes back; a second request with a cached system prompt
prefills only its suffix and still produces identical tokens.

## Left out on purpose

The CUDA kernels (vLLM's PagedAttention kernel, FlashAttention and FlashInfer's paged variants: the gather
here materialises keys a kernel never copies), swapping preempted blocks to CPU memory, chunked prefill
and mixed prefill-decode batches, sampling beyond greedy (temperature, top-p, beam search, which uses
\`fork\`), detokenization and streaming, tensor parallelism, CUDA graphs, \`sha256\` block hashes and cache
salts, speculative decoding, and the OpenAI-compatible HTTP server.`,
  figures: [
    {
      title: 'One engine step',
      architecture: {
        input: 'requests · prompt ids, max_tokens',
        output: 'generated ids per request',
        items: [
          {
            tone: 'block',
            repeat: 'until all finish ×',
            label: 'LLMEngine.step()',
            items: [
              {
                id: 'scheduler',
                label: 'Scheduler',
                sub: 'prefill if any fit · else decode',
                detail:
                  'FCFS. Admits waiting sequences while a seat, the token budget and `can_allocate` allow; otherwise decodes every running sequence, preempting the newest by recompute when a slot cannot be reserved.',
              },
              {
                id: 'prefix-cache',
                label: 'Prefix cache lookup',
                sub: 'hash(prev, tokens) → block',
                detail:
                  'Step 4. The prompt’s full blocks are hashed in a chain and looked up in order up to the first miss; hits join the block table with one more reference and count as computed.',
              },
              {
                id: 'block-manager',
                label: 'Block manager',
                sub: 'append_slots · fork · CoW · free',
                detail:
                  'Reserves a slot for every token about to be computed, taking a block from the free list when the last one is full and copying a shared partial block before a write.',
              },
              {
                id: 'flatten',
                label: 'Flatten the batch',
                kind: 'io',
                sub: 'one row per uncomputed token',
                shape: 'tokens, positions, slots [N]',
                detail:
                  'Each row carries its token, its position, its slot from `slot_mapping`, its sequence’s block table and `context_len = position + 1`. A prefill is many rows of one sequence, a decode one row per sequence.',
              },
              {
                tone: 'block',
                repeat: 'n_layers ×',
                label: 'Model runner · TinyLM layer',
                items: [
                  {
                    id: 'qkv',
                    label: 'Q, K, V projections',
                    sub: '4 query heads · 2 KV heads',
                    shape: 'q [N, 4, 8] · k, v [N, 2, 8]',
                  },
                  {
                    id: 'write-kv',
                    label: 'write_kv',
                    sub: 'k_cache.view(-1, …)[slot] = k',
                    detail:
                      'The new keys and values are scattered into the paged cache at their slots before attention reads it; slot −1 marks padding and is skipped.',
                  },
                  {
                    id: 'paged-attn',
                    label: 'Paged attention',
                    kind: 'attention',
                    sub: 'gather by table · mask ≥ context_len',
                    shape: '[N, 4, 8]',
                    detail:
                      '`k_cache[block_tables]` rebuilds each row’s keys in logical order; positions at or past the row’s `context_len` are −inf. GQA repeats each KV head for its 2 query heads.',
                  },
                  {id: 'mlp', label: 'MLP and residuals', kind: 'ffn', sub: 'pre-norm · 32 → 128 → 32'},
                ],
              },
              {
                id: 'sampler',
                label: 'Greedy sampler',
                kind: 'head',
                sub: 'argmax of each last row',
                detail:
                  'Only each sequence’s last row predicts its next token. Greedy decoding makes the output testable against sequential decoding token for token.',
              },
              {
                id: 'finish',
                label: 'Append, finish, free',
                kind: 'io',
                sub: 'EOS or max_tokens → free blocks',
                detail:
                  'The token is appended; a sequence that sampled EOS or reached `max_tokens` leaves `running` and its blocks return to the free list in the same step.',
              },
            ],
          },
        ],
        notes: [
          {at: 'scheduler', text: 'Out of blocks: preempt the **newest**'},
          {at: 'prefix-cache', text: 'Hit: only the **uncached suffix** is prefilled'},
          {at: 'block-manager', text: 'Waste **< 1 block** per sequence', side: 'left'},
          {at: 'paged-attn', text: 'One query row per token, **context_len = pos + 1**'},
        ],
      },
    },
    {
      title: 'The paged KV cache',
      gpu: {
        layout: 'row',
        align: 'start',
        items: [
          {
            id: 'tables',
            label: 'Scheduler state · Python',
            sub: 'block_size 4',
            tone: 'host',
            layout: 'column',
            items: [
              {
                id: 'table-a',
                array: 'A · 11 tokens',
                sub: 'block table: logical → physical',
                cols: 3,
                tone: 'host',
                cells: ['7', '1', '4'],
                marks: [
                  {cols: [0, 0], tone: 'c', label: 'ref 2'},
                  {cols: [1, 2], tone: 'a'},
                ],
                detail:
                  'A’s positions 0 to 3 are in block 7 (shared with B, ref count 2), 4 to 7 in block 1, 8 to 10 in block 4.',
              },
              {
                id: 'table-b',
                array: 'B · 7 tokens',
                sub: 'same first 4 tokens as A',
                cols: 2,
                tone: 'host',
                cells: ['7', '9'],
                marks: [
                  {cols: [0, 0], tone: 'c', label: 'ref 2'},
                  {cols: [1, 1], tone: 'b'},
                ],
                detail:
                  'B starts with A’s first block of tokens, so its logical block 0 maps to A’s physical block 7 (a fork or a prefix-cache hit). Its own tokens 4 to 6 are in block 9.',
              },
              {
                id: 'free-list',
                array: 'free list',
                sub: 'ref count 0 · allocated from the left',
                cols: 8,
                tone: 'host',
                cells: ['0', '2', '3', '5', '6', '8', '10', '11'],
                detail: 'Every block with ref count 0. `allocate` pops the head; `free` appends at the tail.',
              },
            ],
          },
          {
            id: 'pool',
            label: 'KV cache · one layer',
            sub: 'k_cache [12 blocks, 4 slots, n_kv, d]',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'kv-blocks',
                array: 'physical blocks 0 to 11 × slots 0 to 3',
                sub: 'cell: token position · tints as in the tables',
                cols: 12,
                rows: 4,
                cells: [
                  '',
                  '4',
                  '',
                  '',
                  '8',
                  '',
                  '',
                  '0',
                  '',
                  '4',
                  '',
                  '',
                  '',
                  '5',
                  '',
                  '',
                  '9',
                  '',
                  '',
                  '1',
                  '',
                  '5',
                  '',
                  '',
                  '',
                  '6',
                  '',
                  '',
                  '10',
                  '',
                  '',
                  '2',
                  '',
                  '6',
                  '',
                  '',
                  '',
                  '7',
                  '',
                  '',
                  '',
                  '',
                  '',
                  '3',
                  '',
                  '',
                  '',
                  '',
                ],
                marks: [
                  {cols: [7, 7], rows: [0, 3], tone: 'c'},
                  {cols: [1, 1], rows: [0, 3], tone: 'a'},
                  {cols: [4, 4], rows: [0, 2], tone: 'a'},
                  {cols: [9, 9], rows: [0, 2], tone: 'b'},
                  {cols: [4, 4], rows: [3, 3], tone: 'muted'},
                  {cols: [9, 9], rows: [3, 3], tone: 'muted'},
                ],
                detail:
                  'Block 7 is shared by A and B, blocks 1 and 4 are A’s, block 9 is B’s. Slot `s` is block `s // 4`, offset `s % 4`. A’s next token (position 11) goes to slot 4 · 4 + 3 = 19; the only empty reserved slots are the tails of the two last blocks (dimmed).',
              },
            ],
          },
        ],
        arrows: [{from: 'tables', to: 'pool', label: 'k_cache[block_tables]'}],
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
        'The block table, ref counts with copy-on-write, FCFS scheduling that preempts the latest request by recompute, and the waste bound that steps 1 to 3 build.',
    },
    {
      kind: 'paper',
      title: 'Orca: A Distributed Serving System for Transformer-Based Generative Models',
      url: 'https://www.usenix.org/conference/osdi22/presentation/yu',
      by: 'Gyeong-In Yu et al.',
      date: '2022-07',
      venue: 'OSDI 2022',
      takes: 'Iteration-level scheduling: the batch `Scheduler.schedule` re-forms on every `LLMEngine.step`.',
    },
    {
      kind: 'code',
      title: 'vLLM',
      url: 'https://github.com/vllm-project/vllm',
      by: 'vLLM project',
      date: '2023-02-09',
      venue: 'GitHub',
      takes:
        'The production versions of `reshape_and_cache` (`write_kv`), the paged attention kernel, the scheduler and the KV cache manager.',
    },
    {
      kind: 'code',
      title: 'Nano-vLLM',
      url: 'https://github.com/GeeeekExplorer/nano-vllm',
      by: 'GeeeekExplorer',
      date: '2025-06-09',
      venue: 'GitHub',
      takes:
        'The file split this project follows (`block_manager`, `scheduler`, `sequence`, `llm_engine`) and a hash-chained prefix cache in a few hundred lines.',
    },
    {
      kind: 'docs',
      title: 'Automatic Prefix Caching',
      url: 'https://docs.vllm.ai/en/stable/design/prefix_caching/',
      venue: 'vLLM documentation',
      takes:
        'Block hashes over the parent hash and the block’s tokens, the LRU free queue, and freeing in reverse order, as `prefix_cache.py` implements them.',
    },
    {
      kind: 'post',
      title: 'How continuous batching enables 23x throughput in LLM inference while reducing p50 latency',
      url: 'https://www.anyscale.com/blog/continuous-batching-llm-inference',
      by: 'Cade Daniel et al.',
      date: '2023-06-22',
      venue: 'Anyscale blog',
      takes:
        'Static against continuous batching, and the measured 8× (continuous batching) and 23× (with vLLM’s paged memory) throughput gains the scheduler step is about.',
    },
  ],
  steps: [blockManagerStep, pagedAttentionStep, schedulerStep, prefixCacheStep],
  learn,
};
