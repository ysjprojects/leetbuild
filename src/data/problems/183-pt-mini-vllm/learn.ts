/**
 * The learning guide for the mini vLLM: why contiguous KV caches waste memory, block tables with ref
 * counts and copy-on-write, attention over a paged cache, continuous batching with preemption, and
 * hash-based prefix caching with LRU eviction. Rendered at `/pt-mini-vllm/learn`.
 */
export const learn = `# The system at a glance

An LLM server spends most of its GPU memory on two things: the weights, which are fixed, and the KV
cache, which grows by one key and one value per layer for every token of every request in flight. How
many requests fit in a batch, and so the throughput, is decided by how that cache is managed.
[vLLM](https://github.com/vllm-project/vllm) (Kwon et al., UC Berkeley,
[SOSP 2023](https://arxiv.org/abs/2309.06180)) manages it like an operating system manages RAM: in
fixed-size pages, mapped per sequence by a table, shared where contents are equal. Around that it runs
[Orca's](https://www.usenix.org/conference/osdi22/presentation/yu) iteration-level scheduler, which
re-forms the batch after every forward pass.

One engine step, as the four files of this project build it:

:::architecture
{
  "input": "waiting and running requests",
  "output": "one new token per scheduled request",
  "items": [
    {"id": "g-sched", "label": "Scheduler", "sub": "prefill if any fit · else decode", "detail": "FCFS: admit waiting requests while blocks suffice, else decode every running one and preempt the newest when a slot cannot be reserved."},
    {"id": "g-prefix", "label": "Prefix cache lookup", "sub": "hash(prev, tokens) → block", "detail": "Full blocks of the prompt found by a hash chain join the table without being recomputed."},
    {"id": "g-bm", "label": "Block manager", "sub": "append_slots · fork · CoW · free", "detail": "A slot for every token about to be computed; a new block only when the last one is full."},
    {"id": "g-flat", "label": "Flatten the batch", "kind": "io", "sub": "token, position, slot, table, context_len"},
    {"tone": "block", "repeat": "n_layers ×", "label": "Model runner", "items": [
      {"id": "g-qkv", "label": "Q, K, V projections", "sub": "GQA: fewer KV heads"},
      {"id": "g-write", "label": "write_kv", "sub": "scatter k, v to their slots"},
      {"id": "g-attn", "label": "Paged attention", "kind": "attention", "sub": "gather by block table · mask"},
      {"id": "g-mlp", "label": "MLP and residuals", "kind": "ffn"}
    ]},
    {"id": "g-sample", "label": "Sampler", "kind": "head", "sub": "argmax of each last row"},
    {"id": "g-finish", "label": "Append, finish, free", "kind": "io", "sub": "EOS or max_tokens → blocks back"}
  ],
  "notes": [
    {"at": "g-sched", "text": "The batch changes **every** iteration"},
    {"at": "g-bm", "text": "Waste **< 1 block** per sequence", "side": "left"},
    {"at": "g-attn", "text": "The model sees a **table** and a length"}
  ]
}
:::

The three ideas and where they live:

| idea | from | the problem it removes | file |
|---|---|---|---|
| paged KV cache | vLLM (2023) | reserving max-length buffers, fragmentation, no sharing | \`block_manager.py\`, \`paged_attention.py\` |
| continuous batching | Orca (2022) | a batch that runs until its longest member finishes | \`scheduler.py\` |
| automatic prefix caching | SGLang (2023), vLLM | recomputing the same system prompt for every request | \`prefix_cache.py\` |

Nothing here changes the model's arithmetic: every test in the project compares the engine's tokens with
plain one-request-at-a-time greedy decoding, and they are equal.

# Why a contiguous KV cache wastes memory

Each token keeps a key and a value per layer and per KV head:

\`\`\`text
bytes per token = 2 · n_layers · n_kv_heads · head_dim · bytes per number
\`\`\`

| model | layers × KV heads × dim | per token (fp16) | 4,096 tokens |
|---|---|---|---|
| OPT-13B (no GQA) | 40 × 40 × 128 | 800 KiB | 3.1 GiB |
| Llama 3 8B | 32 × 8 × 128 | 128 KiB | 512 MiB |
| Llama 3 70B | 80 × 8 × 128 | 320 KiB | 1.25 GiB |
| this project's TinyLM (float64) | 2 × 2 × 8 | 512 B | 2 MiB |

The PagedAttention paper's OPT-13B example on a 40 GB A100 leaves about 12 GB for the cache: around 15,700
token slots for every request together. A request's final length is unknown when it arrives, so systems
before vLLM reserved one contiguous buffer of the maximum length per request. Three kinds of waste follow:

- **Reserved**: slots that will be used, but not yet; a request that will produce 500 tokens holds them all
  from its first step.
- **Internal fragmentation**: slots that will never be used, because the request stops long before the
  maximum. A 2,048-token reservation for a 300-token answer leaves 85% empty.
- **External fragmentation**: gaps between buffers of different sizes that no new buffer fits into.

The paper measured earlier systems storing real token states in only 20.4% to 38.2% of their KV memory.
Paging removes all three: a sequence holds \`ceil(len / block_size)\` blocks, allocated as it grows, all of
one size, so it wastes only the unused tail of its last block.

:::gpu
{
  "layout": "row",
  "align": "start",
  "items": [
    {"id": "f-contig", "label": "Contiguous, max_len 16", "sub": "one buffer per request", "tone": "global", "layout": "column", "items": [
      {"id": "f-ca", "array": "A · 11 tokens", "cols": 16, "cells": "index", "marks": [{"cols": [0, 10], "tone": "a"}, {"cols": [11, 15], "tone": "bad", "label": "5 reserved, empty"}]},
      {"id": "f-cb", "array": "B · 7 tokens", "cols": 16, "cells": "index", "marks": [{"cols": [0, 6], "tone": "b"}, {"cols": [7, 15], "tone": "bad", "label": "9 reserved, empty"}]}
    ]},
    {"id": "f-paged", "label": "Paged, blocks of 4", "sub": "blocks allocated as tokens arrive", "tone": "global", "layout": "column", "items": [
      {"id": "f-pa", "array": "A · blocks 7, 1, 4", "cols": 12, "cells": "index", "marks": [{"cols": [0, 10], "tone": "a"}, {"cols": [11, 11], "tone": "muted", "label": "1 empty"}]},
      {"id": "f-pb", "array": "B · blocks 2, 9", "cols": 8, "cells": "index", "marks": [{"cols": [0, 6], "tone": "b"}, {"cols": [7, 7], "tone": "muted", "label": "1 empty"}]}
    ]}
  ]
}
:::

Contiguous reservation holds 32 slots for 18 tokens and wastes 14; paging holds 20 and wastes 2, and the
waste stays under one block per sequence however long the maximum is. Step through three requests on a
96-slot pool, change the block size, and compare the two bars:

:::widget paged-kv {"blockSize": 4}

Smaller blocks waste less, but every block is one more table entry and one more scattered read in the
attention kernel. The paper's ablation found 16 to 128 tokens per block best on ShareGPT, while on Alpaca,
whose sequences are short, blocks above 32 hurt; vLLM defaults to 16, an average waste of about 7.5 slots
per sequence when lengths fall evenly across a block.

:::quiz
Q: A server reserves contiguous buffers of 2,048 tokens. Its requests average 400 tokens. What limits its batch size?
- [ ] The weights: they are copied once per request in the batch
- [x] The reservations: each request holds 2,048 slots, about 5 times what it uses, so 5 times fewer requests fit
- [ ] Nothing: unused slots in a reservation are free for other requests
> A reservation is owned for the request's whole lifetime, so its unused slots cannot hold another
> request's keys. Paging allocates on demand, and the same memory holds about 5 times as many 400-token
> requests, which is where most of vLLM's 2 to 4× throughput comes from.
:::

# Block tables and reference counts

A slot is a flat index into the pool: \`slot = block · block_size + offset\`. Position \`p\` of a sequence lives
in \`table[p // block_size]\` at offset \`p % block_size\`, and a new block is allocated exactly when \`p\` is a
multiple of the block size. The allocator is a free list and one reference count per block: a block is
either free (count 0, on the list) or owned by the tables that hold it.

:::gpu
{
  "layout": "row",
  "align": "start",
  "items": [
    {"id": "t-tables", "label": "Scheduler state · Python", "sub": "block_size 4", "tone": "host", "layout": "column", "items": [
      {"id": "t-a", "array": "A · 11 tokens", "sub": "block table", "cols": 3, "tone": "host", "cells": ["7", "1", "4"], "marks": [{"cols": [0, 0], "tone": "c", "label": "ref 2"}, {"cols": [1, 2], "tone": "a"}]},
      {"id": "t-b", "array": "B · 7 tokens", "sub": "block table", "cols": 2, "tone": "host", "cells": ["7", "9"], "marks": [{"cols": [0, 0], "tone": "c", "label": "ref 2"}, {"cols": [1, 1], "tone": "b"}]},
      {"id": "t-free", "array": "free list", "sub": "ref count 0", "cols": 8, "tone": "host", "cells": ["0", "2", "3", "5", "6", "8", "10", "11"]}
    ]},
    {"id": "t-pool", "label": "KV cache · one layer", "sub": "k_cache [12, 4, n_kv, d]", "tone": "global", "layout": "column", "items": [
      {"id": "t-blocks", "array": "physical blocks 0 to 11 × slots 0 to 3", "sub": "cell: token position · tints as in the tables", "cols": 12, "rows": 4, "cells": ["", "4", "", "", "8", "", "", "0", "", "4", "", "", "", "5", "", "", "9", "", "", "1", "", "5", "", "", "", "6", "", "", "10", "", "", "2", "", "6", "", "", "", "7", "", "", "", "", "", "3", "", "", "", ""], "marks": [{"cols": [7, 7], "rows": [0, 3], "tone": "c"}, {"cols": [1, 1], "rows": [0, 3], "tone": "a"}, {"cols": [4, 4], "rows": [0, 2], "tone": "a"}, {"cols": [9, 9], "rows": [0, 2], "tone": "b"}, {"cols": [4, 4], "rows": [3, 3], "tone": "muted"}, {"cols": [9, 9], "rows": [3, 3], "tone": "muted"}]}
    ]}
  ],
  "arrows": [{"from": "t-tables", "to": "t-pool", "label": "k_cache[block_tables]"}]
}
:::

Because a table is a list of integers, two sequences can point at the same block. vLLM's paper uses this
for parallel sampling, beam search and shared prefixes, through three operations:

- **fork**: the child copies the parent's table and every block gains a reference. Nothing is copied.
- **append**: reserve the next slot. If the last block is shared (count > 1) and partly filled, this
  sequence's write would change the other's tokens, so it first gets a private copy: **copy-on-write**
  allocates a block, records the pair \`(src, dst)\` for the cache to copy, and drops one reference on
  the original. A full shared block is never written again, so it is never copied.
- **free**: drop one reference on every block, last block first; blocks reaching zero return to the free list.

The failure copy-on-write prevents, for a parent with 10 tokens forked into two samples:

| next token of sample 2 | naive: write into the shared block | copy-on-write |
|---|---|---|
| where it goes | slot 2 of the shared last block | slot 2 of a fresh copy of that block |
| sample 1's position 10 | overwritten by sample 2's key | intact |
| blocks used | 3 | 4 (one copy, only of the partial block) |
| result | sample 1 attends to a token it never generated | both samples equal their solo runs |

:::quiz
Q: Two forked sequences share three blocks; the last holds 2 of 4 tokens. Both decode one token. How many block copies happen?
- [ ] Three: a fork must copy everything before either writes
- [x] One: the first writer copies the shared partial block; the second then owns the original alone
- [ ] Two: each sequence copies the block it writes into
> After the first writer's copy, the original block's count drops to 1, so the second writer appends in
> place. The two full blocks are never written again and stay shared for both lifetimes.
:::

# Attention over a paged cache

The model never learns where a sequence lives. It gets, per row, a block table and a length:

\`\`\`python
k_cache.view(num_blocks * block_size, n_kv, d)[slot_mapping] = k      # write_kv: scatter by slot
k = k_cache[block_tables].reshape(N, max_blocks * block_size, n_kv, d)  # gather in logical order
k = k.repeat_interleave(n_heads // n_kv, dim=2)                       # GQA
scores = einsum("nhd,nlhd->nhl", q, k) / sqrt(d)
scores[pos >= context_lens[:, None]] = -inf                           # past the row's length
out = einsum("nhl,nlhd->nhd", softmax(scores, -1), v)
\`\`\`

Treating every token as its own query row makes one function serve both phases. A decode step is one
row per sequence with \`context_len\` its length. A prefill of \`T\` tokens is \`T\` rows of one sequence with
\`context_len = position + 1\`: the mask that hides the tail of the last block also makes the prefill causal.
Every layer writes its keys and values before it reads, so a row can attend to itself.

The mask is not optional even without padding:

| what a row reads past its length | where it comes from | without the mask |
|---|---|---|
| the tail of its last block | whatever sequence used that block before | attends to another request's stale keys |
| padded table entries (block 0) | another live sequence | attends to someone else's tokens |
| slots of a row's later positions (prefill) | its own future tokens | sees the future: no longer causal |

The gather here copies \`N · L\` keys per layer, which a GPU kernel never does. vLLM's CUDA kernel walks the
block table inside the kernel and reads each block once per (head, sequence); FlashAttention and
FlashInfer have paged variants. The arithmetic is the same, which is why this project can check its
output against dense attention to \`1e-12\`.

:::quiz
Q: A prefill of 5 tokens runs through paged_attention as 5 rows of one sequence. What makes position 2 ignore positions 3 and 4?
- [ ] A separate causal mask built only for prefill
- [x] Its row's context_len is 3, so positions 3 and above are set to −inf like any position past a length
- [ ] Positions 3 and 4 are not written to the cache until after attention
> All 5 keys are written before attention reads, so the future keys are in the cache. The per-row length
> \`position + 1\` hides them, the same rule that hides the stale tail of a block in decode.
:::

# Continuous batching and preemption

With static batching, a batch runs until its longest request finishes: a request that stops after 20
tokens idles for the other 480 steps, and new arrivals wait for the whole batch. Orca schedules one
iteration at a time instead: after every forward pass the batch is rebuilt from whatever is running and
whatever fits. [Anyscale measured](https://www.anyscale.com/blog/continuous-batching-llm-inference) 8× the
throughput of static batching from continuous batching alone and up to 23× with vLLM's paged memory on top.

The policy of vLLM's paper (FCFS, preempt the latest arrival) and of its v0 scheduler (prefills before
decodes), which \`scheduler.py\` implements:

- **First come, first served.** \`waiting\` is a queue; \`running\` is ordered by admission.
- **Prefill first.** A waiting request is admitted while a seat, the token budget and the blocks allow;
  if any were admitted, the step is a prefill.
- **Otherwise decode every running request**, oldest first, one slot each.
- **Out of blocks, preempt the newest.** Its blocks are freed and it returns to the front of \`waiting\`.

The engine tracks one number per request, \`num_computed\`: how many leading tokens have keys and values in
the cache. A step computes \`tokens[num_computed:]\`, which is the whole prompt in a prefill and the last
sampled token in a decode. Preemption sets it to 0, so the request comes back as a longer prefill of its
prompt plus everything it generated, and its next token is exactly what it would have been.

| recovery after preemption | cost | used by |
|---|---|---|
| recompute: free the blocks, prefill prompt + output again | one prefill of the whole sequence (parallel), independent of block size | vLLM v0 for single-sequence requests, v1 always, this project |
| swap: copy the blocks to CPU memory, copy back later | PCIe traffic both ways, CPU memory for the blocks | vLLM v0 for parallel samples and beams, which it could not recompute; dropped in v1 |

The paper's ablation found swapping slow at small block sizes (many small PCIe transfers) and the two about
equal from 16 to 64 tokens per block; vLLM's code defaults to recompute because it costs less than swapping.

Without preemption the scheduler can deadlock: every running request needs a new block, none is free,
and none can finish. Preempting the newest guarantees that the oldest request always progresses. Watch the widget's pool as sequence C
arrives while A and B still run: blocks come and go one at a time, never as whole reservations.

:::quiz
Q: The pool is full and three requests are running. Which one does the scheduler preempt, and what happens to its output so far?
- [ ] The oldest, since it holds the most blocks; its output is discarded
- [x] The newest; its blocks are freed, and later its prompt plus its output are prefilled again so it continues where it stopped
- [ ] The longest; its blocks are kept read-only until memory frees up
> Preempting the latest arrival keeps FCFS fairness and guarantees progress for the earliest. Recompute
> keeps the generated tokens (they are just ids) and rebuilds their keys and values in one prefill.
:::

# Prefix caching: blocks named by their contents

Chat turns, system prompts, few-shot examples and agent loops send the same leading thousands of tokens
again and again. A block's keys and values depend only on its tokens and every token before it, so a full
block can be named by a hash chain:

\`\`\`python
h0 = hash((None, tuple(tokens[0:16])))
h1 = hash((h0,   tuple(tokens[16:32])))     # equal h1 means an equal prefix of 32 tokens
\`\`\`

The [vLLM design](https://docs.vllm.ai/en/stable/design/prefix_caching/) that \`prefix_cache.py\` follows:

- **Lookup** hashes the prompt's full blocks in order and stops at the first miss; the hits join the table
  with one more reference each, and their tokens count as computed, so only the suffix is prefilled.
- **At least one token is computed**: the lookup covers \`(len - 1) // block_size\` blocks, because the last
  prompt token's logits are the next token's distribution.
- **Publish after compute** (this project): a block is hashed and registered once the forward pass has
  written it, prefill or decode. vLLM v1 registers a block as soon as it is allocated full of scheduled
  tokens, so a request scheduled later in the same step can already hit it: every layer writes the
  batch's keys before any row reads them.
- **Freed is not forgotten**: a block whose count reaches 0 goes to the tail of the free queue with its
  hash. A hit on it pulls it back out; allocating it evicts the hash.
- **LRU with a twist**: requests free their blocks last block first, so a prompt's specific tail is
  evicted before its widely shared head.

With the shared-prefix toggle on, the three requests in the widget map their first two blocks to the same
physical blocks, with the reference count on each:

:::widget paged-kv {"blockSize": 4, "shared": true}

[SGLang's RadixAttention](https://arxiv.org/abs/2312.07104) stores the same information as a radix tree of
token sequences, which also matches partial blocks and evicts leaves first. A hash table over fixed blocks
is simpler and fits paged memory exactly.

| the hash covers | what goes wrong |
|---|---|
| only the block's own tokens | the same 16 tokens after a different prefix match, and attention reads keys computed in another context |
| the chain, looked up past a miss | a hit after a hole leaves a block nobody computed in the table |
| the chain, stopping at the first miss | correct: the table is a prefix of hits followed by fresh blocks |

:::quiz
Q: Request 1 finished; its 5 system-prompt blocks have ref count 0. Request 2 with the same system prompt arrives. What happens?
- [ ] The blocks were freed, so request 2 recomputes the system prompt
- [x] If the blocks have not been reallocated, the lookup finds them by hash, takes them off the free queue and request 2 prefills only its suffix
- [ ] Request 2 must wait until request 1's blocks are copied into new ones
> Freed hashed blocks stay valid until the allocator pops them for something else. That is why caching is
> free: it uses memory nobody needs yet, and gives it up in LRU order the moment someone does.
:::

# What to take away

- The KV cache, not the weights, decides how many requests fit; contiguous max-length reservations kept
  earlier servers at 20 to 40% useful KV memory.
- A block table maps logical blocks to physical ones; waste is under one block per sequence, and ref
  counts with copy-on-write let sequences share blocks safely.
- Attention reads the paged cache through the table with one query row per token and a per-row length,
  which serves prefill and decode alike.
- Continuous batching re-forms the batch every iteration; when blocks run out, the newest request is
  preempted and later recomputed from its tokens.
- Prefix caching names full blocks by a hash chain, shares them by reference, and keeps freed blocks
  until LRU eviction needs them.

Primary reference: Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180) (SOSP 2023), as implemented in [vLLM](https://github.com/vllm-project/vllm); for a compact reading of the same design, [Nano-vLLM](https://github.com/GeeeekExplorer/nano-vllm).
`;
