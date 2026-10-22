import type {Step} from '@/lib/types';

export const pagedAttentionStep: Step = {
  id: 'paged-attention',
  title: 'PagedAttention: write by slot, read through the block table',
  concept: 'pytorch',
  file: 'paged_attention',
  focus: ['write-kv', 'paged-attn', 'kv-blocks', 'tables', 'table-a', 'table-b'],
  task: `## Task

Write \`paged_attention.py\` (\`from block_manager import BlockManager\`): a KV cache stored in blocks, and
attention that finds a sequence's keys and values through its block table. No
\`F.scaled_dot_product_attention\`, no \`torch.nn.MultiheadAttention\`, no \`vllm\`.

- \`allocate_kv_cache(num_blocks, block_size, n_kv_heads, head_dim, dtype=torch.float32)\`: one layer's
  \`(k_cache, v_cache)\`, each \`torch.zeros\` of shape \`[num_blocks, block_size, n_kv_heads, head_dim]\`.
- \`write_kv(k, v, k_cache, v_cache, slot_mapping)\`: \`k\`, \`v\` are \`[N, n_kv_heads, head_dim]\` and
  \`slot_mapping\` is \`[N]\` long. Row \`i\` goes to slot \`slot_mapping[i]\` of the cache viewed as
  \`[num_blocks * block_size, n_kv_heads, head_dim]\` (a \`view\`, so the write lands in the cache). Slot
  \`-1\` marks padding and is skipped.
- \`copy_blocks(k_cache, v_cache, copies)\`: perform step 1's copy-on-write pairs \`(src, dst)\`, whole blocks.
- \`pad_block_tables(tables)\` (given): ragged tables to a \`[len(tables), max_blocks]\` long tensor padded with
  block 0, which the context length masks.

\`paged_attention(q, k_cache, v_cache, block_tables, context_lens) -> [N, n_heads, head_dim]\` computes
**one query row per token**: \`q\` is \`[N, n_heads, head_dim]\`, \`block_tables\` \`[N, max_blocks]\`,
\`context_lens\` \`[N]\`, and row \`i\` attends to positions \`0\` to \`context_lens[i] - 1\` of its sequence.

- Gather \`k_cache[block_tables]\` (and \`v_cache\`) to \`[N, max_blocks * block_size, n_kv_heads, head_dim]\`.
- GQA: KV head \`j\` serves query heads \`j * g\` to \`(j + 1) * g - 1\` with \`g = n_heads // n_kv_heads\`
  (\`repeat_interleave\` on the head axis).
- Scores \`q · k / sqrt(head_dim)\`, positions \`>= context_lens[i]\` set to \`float("-inf")\`, softmax over
  positions, weighted sum of the values.
- A decode step is one row per sequence with \`context_len = len\`; a prefill of \`T\` tokens is \`T\` rows of
  one sequence with \`context_len = position + 1\`, which makes the mask causal.

The self-test, in float64, 8 query heads over 2 KV heads, blocks of 4 slots:

- The 64-block free list is shuffled and 8 sequences of random length (1 to 37, plus 1, 4 and 9) grow
  round-robin in random chunks, so their blocks interleave; each write batch carries a \`-1\` row of 99s
  that must never reach the cache.
- Decode rows match \`dense_attention\` over the contiguous K and V to \`1e-12\`.
- Every prefill row of one sequence matches causal dense attention.
- A fork, a copy-on-write append and \`copy_blocks\`: the child sees the parent's tokens plus its own, the
  parent is unchanged. Then it prints \`PASS\`.

> The model never sees where a sequence lives. It sees a block table and a length; the gather turns
> scattered blocks back into a contiguous view, and the mask hides everything past the length.`,
  hints: [
    '`k_cache.view(num_blocks * block_size, n_kv, d)[slots] = k[keep]` writes in place: indexing a view with a long tensor on the left of `=` is a scatter into the cache. Build `keep = slot_mapping >= 0` first.',
    'Indexing a `[num_blocks, block_size, ...]` tensor with a `[N, max_blocks]` long tensor gives `[N, max_blocks, block_size, ...]`: `reshape(N, max_blocks * block_size, n_kv, d)` puts position `p` of row `i` at index `p`.',
    'The mask: `torch.arange(max_blocks * block_size)[None, :] < context_lens[:, None]` is `[N, L]`; broadcast it over heads with `scores.masked_fill(~valid[:, None, :], float("-inf"))`. With `torch.einsum("nhd,nlhd->nhl", q, k)` the head axes line up after `repeat_interleave(n_heads // n_kv, dim=2)`.',
  ],
  checks: [
    {
      id: 'cache-shape',
      title: 'The cache is [num_blocks, block_size, n_kv_heads, head_dim]',
      detail:
        '`allocate_kv_cache` returns two `torch.zeros` tensors of that shape: one block is `block_size` consecutive positions of every KV head, the unit the block table points at.',
      match: {python: {all: [/torch\.zeros\(/, /num_blocks\s*,\s*block_size\s*,\s*n_kv_heads\s*,\s*head_dim/]}},
    },
    {
      id: 'write-by-slot',
      title: 'write_kv scatters by slot and skips −1',
      detail:
        'Rows with `slot_mapping >= 0` are written through a flat view `[num_blocks * block_size, ...]` of the cache (or `index_copy_` / `index_put_`); padding rows with slot `-1` would otherwise land in the last slot of the pool.',
      match: {
        python: {
          all: [
            /slot_mapping\s*(?:>=\s*0|!=\s*-1|>\s*-1)/,
            /(?:view|reshape|flatten)\([^)]*\)\s*\[[^\]]+\]\s*=(?!=)|index_copy_\(|index_put_\(/,
          ],
        },
      },
    },
    {
      id: 'gather',
      title: 'Keys and values are gathered through the block table',
      detail:
        '`k_cache[block_tables]` and `v_cache[block_tables]` (or `index_select`) fetch each row’s physical blocks in logical order; reading the cache contiguously would mix sequences.',
      match: {
        python: {
          all: [
            /k_cache\[\s*block_tables\s*\]|k_cache\.index_select\(/,
            /v_cache\[\s*block_tables\s*\]|v_cache\.index_select\(/,
          ],
        },
      },
    },
    {
      id: 'context-mask',
      title: 'Positions past the context length are masked to −inf',
      detail:
        'Each row compares positions with its own `context_lens[:, None]` and sets the rest to `-inf` before the softmax: the tail of the last block and the padded blocks hold stale or foreign data.',
      match: {
        python: {
          all: [
            /context_lens\[\s*:\s*,\s*None\s*\]|context_lens\.unsqueeze\(|context_lens\.view\(/,
            /float\(\s*["']-inf["']\s*\)|-math\.inf|-torch\.inf|torch\.finfo/,
          ],
        },
      },
    },
    {
      id: 'gqa',
      title: 'GQA: each KV head serves n_heads // n_kv_heads query heads',
      detail:
        'The cache stores `n_kv_heads` heads; `repeat_interleave` (or `expand`) by `n_heads // n_kv_heads` on the head axis maps KV head `j` to query heads `j * g` to `(j + 1) * g - 1`, as LLaMA-style models do.',
      match: {
        python: {all: [/repeat_interleave\(|\.expand\(/, /\/\/\s*(?:n_kv|n_kv_heads|kv_heads|num_kv_heads)\b/]},
      },
    },
    {
      id: 'copy-blocks',
      title: 'Copy-on-write copies whole blocks',
      detail:
        '`copy_blocks` sets `k_cache[dst] = k_cache[src]` (and `v_cache`) for every pair: one block of every KV head, before the forked sequence writes into `dst`.',
      match: {python: {all: [/k_cache\[\s*\w+\s*\]\s*=\s*k_cache\[|k_cache\[\s*\w+\s*\]\.copy_\(/]}},
    },
    {
      id: 'own-attention',
      title: 'Attention written out, no fused kernel',
      detail:
        'Scores and the weighted sum are your own `einsum` / `matmul`; `F.scaled_dot_product_attention`, FlashAttention and vLLM’s kernels are what this file replaces.',
      match: {
        python: {
          all: [/torch\.einsum\(|torch\.matmul\(|@/],
          none: [
            /scaled_dot_product_attention/,
            /flash_attn/,
            /MultiheadAttention/,
            /^\s*(?:import\s+vllm|from\s+vllm)\b/m,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""A paged KV cache and attention that reads it through block tables."""

import math
from collections import deque

import torch

from block_manager import BlockManager


def allocate_kv_cache(num_blocks: int, block_size: int, n_kv_heads: int, head_dim: int,
                      dtype: torch.dtype = torch.float32) -> tuple[torch.Tensor, torch.Tensor]:
    """One layer's K and V caches, each [num_blocks, block_size, n_kv_heads, head_dim], zeroed."""
    raise NotImplementedError("TODO: two zeroed tensors of that shape and dtype")


def write_kv(k: torch.Tensor, v: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor,
             slot_mapping: torch.Tensor) -> None:
    """Scatter N new rows k, v [N, n_kv_heads, head_dim] to their slots; slot -1 (padding) is skipped."""
    # TODO: view each cache as [num_blocks * block_size, n_kv_heads, head_dim] and write row i to slot
    # slot_mapping[i], skipping the -1 slots.
    raise NotImplementedError("TODO: write_kv")


def copy_blocks(k_cache: torch.Tensor, v_cache: torch.Tensor, copies: list[tuple[int, int]]) -> None:
    """Perform the block manager's copy-on-write copies (src block -> dst block)."""
    raise NotImplementedError("TODO: copy_blocks")


def pad_block_tables(tables: list[list[int]]) -> torch.Tensor:
    """Ragged block tables -> [len(tables), max_blocks] long, padded with block 0 (masked by context_lens)."""
    width = max(len(t) for t in tables)
    return torch.tensor([t + [0] * (width - len(t)) for t in tables], dtype=torch.long)


def paged_attention(q: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor,
                    block_tables: torch.Tensor, context_lens: torch.Tensor) -> torch.Tensor:
    """One query row per token.

    q [N, n_heads, head_dim]; block_tables [N, max_blocks] long; context_lens [N] long: row i attends to
    positions 0 .. context_lens[i] - 1 of its sequence. Returns [N, n_heads, head_dim].
    """
    # TODO: gather each row's blocks through block_tables, flatten them to positions, repeat each KV head
    # for its group of query heads, scale the scores by 1 / sqrt(head_dim), set positions at or past the
    # row's context length to -inf, softmax, weight the values.
    raise NotImplementedError("TODO: paged_attention")


def dense_attention(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    """Reference: q [n_heads, d] over contiguous k, v [L, n_kv, d], one head at a time."""
    n_heads, d = q.shape
    group = n_heads // k.shape[1]
    out = torch.empty_like(q)
    for h in range(n_heads):
        kh, vh = k[:, h // group], v[:, h // group]
        w = torch.softmax(kh @ q[h] / math.sqrt(d), dim=0)
        out[h] = w @ vh
    return out


if __name__ == "__main__":
    torch.manual_seed(0)
    BS, N_HEADS, N_KV, D = 4, 8, 2, 16
    NUM_BLOCKS = 64
    dt = torch.float64

    bm = BlockManager(NUM_BLOCKS, BS)
    # Shuffle the free list so physical blocks are scattered, as they are after hours of serving.
    bm.allocator.free_list = deque(torch.randperm(NUM_BLOCKS).tolist())
    k_cache, v_cache = allocate_kv_cache(NUM_BLOCKS, BS, N_KV, D, dt)
    assert k_cache.shape == (NUM_BLOCKS, BS, N_KV, D)

    lengths = [int(x) for x in torch.randint(1, 38, (5,))] + [1, BS, 2 * BS + 1]
    dense_k = [torch.randn(n, N_KV, D, dtype=dt) for n in lengths]
    dense_v = [torch.randn(n, N_KV, D, dtype=dt) for n in lengths]

    # Grow the sequences round-robin in random chunks so their blocks interleave in the pool.
    done = [0] * len(lengths)
    while any(d < n for d, n in zip(done, lengths)):
        for s, n in enumerate(lengths):
            if done[s] == n:
                continue
            step = min(n - done[s], int(torch.randint(1, 6, ())))
            slots = bm.append_slots(s, step)
            # Pad the batch with a -1 slot: write_kv must skip it.
            sm = torch.tensor(slots + [-1], dtype=torch.long)
            kk = torch.cat([dense_k[s][done[s]:done[s] + step], torch.full((1, N_KV, D), 99.0, dtype=dt)])
            vv = torch.cat([dense_v[s][done[s]:done[s] + step], torch.full((1, N_KV, D), 99.0, dtype=dt)])
            write_kv(kk, vv, k_cache, v_cache, sm)
            done[s] += step
    assert (k_cache != 99.0).all() and (v_cache != 99.0).all(), "a -1 slot was written"
    tables = [bm.block_tables[s] for s in range(len(lengths))]
    assert any(t != sorted(t) or t[-1] - t[0] != len(t) - 1 for t in tables), "blocks should be scattered"

    # Decode: one query per sequence over its whole context, against dense attention.
    q = torch.randn(len(lengths), N_HEADS, D, dtype=dt)
    out = paged_attention(q, k_cache, v_cache, pad_block_tables(tables), torch.tensor(lengths))
    assert out.shape == (len(lengths), N_HEADS, D)
    for s, n in enumerate(lengths):
        ref = dense_attention(q[s], dense_k[s], dense_v[s])
        torch.testing.assert_close(out[s], ref, rtol=0, atol=1e-12)

    # Prefill: every position of one sequence is a row with context_len = position + 1 (causal).
    s, n = 2, lengths[2]
    qp = torch.randn(n, N_HEADS, D, dtype=dt)
    rows = pad_block_tables([tables[s]] * n)
    outp = paged_attention(qp, k_cache, v_cache, rows, torch.arange(1, n + 1))
    for p in range(n):
        ref = dense_attention(qp[p], dense_k[s][: p + 1], dense_v[s][: p + 1])
        torch.testing.assert_close(outp[p], ref, rtol=0, atol=1e-12)

    # Fork + copy-on-write: the child's first new token lands in a copy of the parent's last block.
    parent = next(i for i, n in enumerate(lengths) if n % BS != 0)
    child = 100
    bm.fork(parent, child)
    (slot,) = bm.append_slots(child, 1)
    copy_blocks(k_cache, v_cache, bm.take_copies())
    new_k, new_v = torch.randn(1, N_KV, D, dtype=dt), torch.randn(1, N_KV, D, dtype=dt)
    write_kv(new_k, new_v, k_cache, v_cache, torch.tensor([slot]))
    qc = torch.randn(2, N_HEADS, D, dtype=dt)
    n = lengths[parent]
    both = paged_attention(qc, k_cache, v_cache,
                           pad_block_tables([bm.block_tables[child], bm.block_tables[parent]]),
                           torch.tensor([n + 1, n]))
    torch.testing.assert_close(both[0], dense_attention(qc[0], torch.cat([dense_k[parent], new_k]),
                                                        torch.cat([dense_v[parent], new_v])), rtol=0, atol=1e-12)
    torch.testing.assert_close(both[1], dense_attention(qc[1], dense_k[parent], dense_v[parent]), rtol=0, atol=1e-12)

    used_blocks = NUM_BLOCKS - bm.num_free()
    print(f"lengths {lengths}: {used_blocks} of {NUM_BLOCKS} blocks in use, matches dense attention")
    print("PASS")
`,
      solution: `"""A paged KV cache and attention that reads it through block tables."""

import math
from collections import deque

import torch

from block_manager import BlockManager


def allocate_kv_cache(num_blocks: int, block_size: int, n_kv_heads: int, head_dim: int,
                      dtype: torch.dtype = torch.float32) -> tuple[torch.Tensor, torch.Tensor]:
    """One layer's K and V caches, each [num_blocks, block_size, n_kv_heads, head_dim], zeroed."""
    shape = (num_blocks, block_size, n_kv_heads, head_dim)
    return torch.zeros(shape, dtype=dtype), torch.zeros(shape, dtype=dtype)


def write_kv(k: torch.Tensor, v: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor,
             slot_mapping: torch.Tensor) -> None:
    """Scatter N new rows k, v [N, n_kv_heads, head_dim] to their slots; slot -1 (padding) is skipped."""
    num_blocks, block_size, n_kv, d = k_cache.shape
    keep = slot_mapping >= 0
    slots = slot_mapping[keep]
    k_cache.view(num_blocks * block_size, n_kv, d)[slots] = k[keep]
    v_cache.view(num_blocks * block_size, n_kv, d)[slots] = v[keep]


def copy_blocks(k_cache: torch.Tensor, v_cache: torch.Tensor, copies: list[tuple[int, int]]) -> None:
    """Perform the block manager's copy-on-write copies (src block -> dst block)."""
    for src, dst in copies:
        k_cache[dst] = k_cache[src]
        v_cache[dst] = v_cache[src]


def pad_block_tables(tables: list[list[int]]) -> torch.Tensor:
    """Ragged block tables -> [len(tables), max_blocks] long, padded with block 0 (masked by context_lens)."""
    width = max(len(t) for t in tables)
    return torch.tensor([t + [0] * (width - len(t)) for t in tables], dtype=torch.long)


def paged_attention(q: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor,
                    block_tables: torch.Tensor, context_lens: torch.Tensor) -> torch.Tensor:
    """One query row per token.

    q [N, n_heads, head_dim]; block_tables [N, max_blocks] long; context_lens [N] long: row i attends to
    positions 0 .. context_lens[i] - 1 of its sequence. Returns [N, n_heads, head_dim].
    """
    n, n_heads, d = q.shape
    _, block_size, n_kv, _ = k_cache.shape
    max_blocks = block_tables.shape[1]
    # Gather: the table turns logical block j into a physical block; [N, max_blocks * block_size, n_kv, d].
    k = k_cache[block_tables].reshape(n, max_blocks * block_size, n_kv, d)
    v = v_cache[block_tables].reshape(n, max_blocks * block_size, n_kv, d)
    # GQA: each KV head serves n_heads // n_kv consecutive query heads.
    group = n_heads // n_kv
    k = k.repeat_interleave(group, dim=2)
    v = v.repeat_interleave(group, dim=2)
    scores = torch.einsum("nhd,nlhd->nhl", q, k) / math.sqrt(d)
    pos = torch.arange(max_blocks * block_size)
    valid = pos[None, :] < context_lens[:, None]
    scores = scores.masked_fill(~valid[:, None, :], float("-inf"))
    probs = torch.softmax(scores, dim=-1)
    return torch.einsum("nhl,nlhd->nhd", probs, v)


def dense_attention(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    """Reference: q [n_heads, d] over contiguous k, v [L, n_kv, d], one head at a time."""
    n_heads, d = q.shape
    group = n_heads // k.shape[1]
    out = torch.empty_like(q)
    for h in range(n_heads):
        kh, vh = k[:, h // group], v[:, h // group]
        w = torch.softmax(kh @ q[h] / math.sqrt(d), dim=0)
        out[h] = w @ vh
    return out


if __name__ == "__main__":
    torch.manual_seed(0)
    BS, N_HEADS, N_KV, D = 4, 8, 2, 16
    NUM_BLOCKS = 64
    dt = torch.float64

    bm = BlockManager(NUM_BLOCKS, BS)
    # Shuffle the free list so physical blocks are scattered, as they are after hours of serving.
    bm.allocator.free_list = deque(torch.randperm(NUM_BLOCKS).tolist())
    k_cache, v_cache = allocate_kv_cache(NUM_BLOCKS, BS, N_KV, D, dt)
    assert k_cache.shape == (NUM_BLOCKS, BS, N_KV, D)

    lengths = [int(x) for x in torch.randint(1, 38, (5,))] + [1, BS, 2 * BS + 1]
    dense_k = [torch.randn(n, N_KV, D, dtype=dt) for n in lengths]
    dense_v = [torch.randn(n, N_KV, D, dtype=dt) for n in lengths]

    # Grow the sequences round-robin in random chunks so their blocks interleave in the pool.
    done = [0] * len(lengths)
    while any(d < n for d, n in zip(done, lengths)):
        for s, n in enumerate(lengths):
            if done[s] == n:
                continue
            step = min(n - done[s], int(torch.randint(1, 6, ())))
            slots = bm.append_slots(s, step)
            # Pad the batch with a -1 slot: write_kv must skip it.
            sm = torch.tensor(slots + [-1], dtype=torch.long)
            kk = torch.cat([dense_k[s][done[s]:done[s] + step], torch.full((1, N_KV, D), 99.0, dtype=dt)])
            vv = torch.cat([dense_v[s][done[s]:done[s] + step], torch.full((1, N_KV, D), 99.0, dtype=dt)])
            write_kv(kk, vv, k_cache, v_cache, sm)
            done[s] += step
    assert (k_cache != 99.0).all() and (v_cache != 99.0).all(), "a -1 slot was written"
    tables = [bm.block_tables[s] for s in range(len(lengths))]
    assert any(t != sorted(t) or t[-1] - t[0] != len(t) - 1 for t in tables), "blocks should be scattered"

    # Decode: one query per sequence over its whole context, against dense attention.
    q = torch.randn(len(lengths), N_HEADS, D, dtype=dt)
    out = paged_attention(q, k_cache, v_cache, pad_block_tables(tables), torch.tensor(lengths))
    assert out.shape == (len(lengths), N_HEADS, D)
    for s, n in enumerate(lengths):
        ref = dense_attention(q[s], dense_k[s], dense_v[s])
        torch.testing.assert_close(out[s], ref, rtol=0, atol=1e-12)

    # Prefill: every position of one sequence is a row with context_len = position + 1 (causal).
    s, n = 2, lengths[2]
    qp = torch.randn(n, N_HEADS, D, dtype=dt)
    rows = pad_block_tables([tables[s]] * n)
    outp = paged_attention(qp, k_cache, v_cache, rows, torch.arange(1, n + 1))
    for p in range(n):
        ref = dense_attention(qp[p], dense_k[s][: p + 1], dense_v[s][: p + 1])
        torch.testing.assert_close(outp[p], ref, rtol=0, atol=1e-12)

    # Fork + copy-on-write: the child's first new token lands in a copy of the parent's last block.
    parent = next(i for i, n in enumerate(lengths) if n % BS != 0)
    child = 100
    bm.fork(parent, child)
    (slot,) = bm.append_slots(child, 1)
    copy_blocks(k_cache, v_cache, bm.take_copies())
    new_k, new_v = torch.randn(1, N_KV, D, dtype=dt), torch.randn(1, N_KV, D, dtype=dt)
    write_kv(new_k, new_v, k_cache, v_cache, torch.tensor([slot]))
    qc = torch.randn(2, N_HEADS, D, dtype=dt)
    n = lengths[parent]
    both = paged_attention(qc, k_cache, v_cache,
                           pad_block_tables([bm.block_tables[child], bm.block_tables[parent]]),
                           torch.tensor([n + 1, n]))
    torch.testing.assert_close(both[0], dense_attention(qc[0], torch.cat([dense_k[parent], new_k]),
                                                        torch.cat([dense_v[parent], new_v])), rtol=0, atol=1e-12)
    torch.testing.assert_close(both[1], dense_attention(qc[1], dense_k[parent], dense_v[parent]), rtol=0, atol=1e-12)

    used_blocks = NUM_BLOCKS - bm.num_free()
    print(f"lengths {lengths}: {used_blocks} of {NUM_BLOCKS} blocks in use, matches dense attention")
    print("PASS")
`,
    },
  },
  debrief: `Two scatter-gathers carry the whole idea. \`write_kv\` is vLLM's \`reshape_and_cache\`: each new key and value goes to the slot the block manager chose, so the cache never moves. \`paged_attention\` is the read side: the block table turns logical block \`j\` of row \`i\` into a physical block, and the gather rebuilds a contiguous \`[L, n_kv, d]\` view per row. Treating every token as its own query row with its own \`context_len\` makes one function serve decode (one row per sequence) and prefill (a causal triangle of rows), which is how vLLM v1's unified attention batch works too. Here the gather materialises \`N · L\` keys per layer, which is fine on a CPU with a tiny model and wasteful on a GPU: the real kernel never copies. vLLM's CUDA PagedAttention runs one thread block per (head, sequence), walks the block table, has each warp read whole KV blocks, and reduces the softmax across warps in shared memory, and FlashAttention's varlen kernels and FlashInfer read paged layouts directly. The mask matters even without padding: the last block's tail holds stale keys from whatever sequence used the block before, and the padded table entries point at block 0, which belongs to someone else. GQA is what makes the cache affordable at scale: Llama 3 70B keeps 8 KV heads for 64 query heads, an 8× smaller cache per token.`,
};
