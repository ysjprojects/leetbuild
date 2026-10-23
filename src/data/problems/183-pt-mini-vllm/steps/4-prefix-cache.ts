import type {Step} from '@/lib/types';

export const prefixCacheStep: Step = {
  id: 'prefix-cache',
  title: 'Prefix caching: hashed blocks, shared and evicted in LRU order',
  concept: 'pytorch',
  file: 'prefix_cache',
  focus: ['prefix-cache', 'block-manager', 'table-a', 'table-b', 'free-list'],
  task: `## Task

Write \`prefix_cache.py\`: vLLM's automatic prefix caching. A full block's keys and values depend only on
its tokens and every token before it, so a block can be named by a hash chain and found again by the
next request that starts the same way. Subclass steps 1 and 3; the engine and the model do not change.

\`block_hash(prev_hash, token_ids) -> int\` is \`hash((prev_hash, tuple(token_ids)))\`, with \`prev_hash\` \`None\`
for block 0. Equal hashes mean an equal prefix up to and including this block.

\`PrefixCachingAllocator(num_blocks, block_size)\` (its \`__init__\` is given): \`free_queue\` is an
\`OrderedDict\` of free block ids, least recently freed first; \`hash_of[block]\`; \`cached\` maps hash to block;
\`evictions\`.

- \`allocate()\`: \`popitem(last=False)\`; if that block still has a hash it is **evicted** (removed from
  \`cached\`, \`hash_of\` cleared, counted). Ref count 1.
- \`free(block)\`: at ref count 0 the block goes to the **tail** of \`free_queue\`, keeping its hash and
  contents: a later request can still hit it until it is reallocated.
- \`lookup(h) -> int | None\`: a hit takes a reference; a hit on an idle block (ref count 0) also removes it
  from \`free_queue\`.
- \`register(block, h)\`: publish a computed full block (a hash already published keeps its first block).

\`PrefixCachingBlockManager(BlockManager)\` adds \`hashes[seq_id]\`, \`query_tokens\`, \`hit_tokens\` and
\`hit_rate()\`.

- \`_prefix_hashes(token_ids)\`: the chained hashes of the first \`(len(token_ids) - 1) // block_size\` blocks,
  so the last prompt token is always computed (its logits are the next token's distribution).
- \`can_allocate(seq_id, token_ids)\`: the blocks the prompt needs beyond its cached prefix, plus the cached
  hits that are idle (they leave the free queue too), fit \`num_free()\`.
- \`allocate(seq_id, token_ids) -> int\`: look the prefix hashes up in order and **stop at the first miss**;
  the hits start the block table, \`append_slots\` reserves the rest; count the prompt tokens and the hit
  tokens; return the number of cached tokens (the scheduler stores it in \`num_computed\`).
- \`mark_computed(seq_id, token_ids)\`: every block now full of computed tokens and not yet hashed gets its
  chained hash and is \`register\`ed (decode-filled blocks too).

\`PrefixCachingEngine(LLMEngine)\`: \`make_block_manager\` returns the new manager, and \`on_computed(seq)\` calls
\`mark_computed(seq.seq_id, seq.tokens[:seq.num_computed])\`.

The self-test (blocks of 4, a 21-token system prompt, 3 user suffixes):

- The allocator alone: three hashed blocks freed in order, a hit revives the first, the next allocation
  evicts the second (the LRU one), the third still hits.
- A cold request prefills all 27 of its tokens; a second request with the same system prompt prefills only
  its last 4 (5 cached blocks) with outputs identical to \`dense_generate\`, and a prompt-token hit rate of
  exactly 20 / 51.
- Two concurrent requests share those 5 blocks at ref count 2; afterwards every ref count is 0.
- In a 12-block pool, an unrelated 30-token request evicts the tail of the cached prompt; the next request
  prefills exactly the tokens its surviving leading blocks do not cover, with identical outputs. Then it
  prints \`PASS\`.

With the shared prefix on, the first two blocks of every request map to the same physical blocks, with their ref counts:

:::widget paged-kv {"blockSize": 4, "shared": true}

> Caching costs nothing until memory is needed: a finished request's blocks stay on the free list with
> their hashes, and the free list's order decides what is forgotten first.`,
  hints: [
    'The chain is what makes a hit safe: block `i` matches only if every block before it matched, so look the hashes up in order and `break` at the first `None`. A table whose leading blocks are hits and whose tail is fresh is still a valid table for steps 2 and 3.',
    'An `OrderedDict` is an LRU queue with O(1) removal from the middle: `popitem(last=False)` takes the oldest, `del free_queue[block]` revives a hit, `free_queue[block] = None` appends at the tail. Step 1 frees the last block first, so a prompt’s tail is evicted before its head.',
    'Register only after the forward pass that wrote the block: `mark_computed` runs from `on_computed`, after `write_kv`. Capping the cached prefix at `(len - 1) // block_size` blocks keeps the last prompt token in a block of its own sequence, so no request ever writes into a shared block.',
  ],
  checks: [
    {
      id: 'chain-hash',
      title: 'A block’s hash chains the previous hash with its tokens',
      detail:
        '`block_hash` hashes `(prev_hash, tuple(token_ids))` (or a `hashlib.sha256` of the same): the same tokens after a different prefix have different keys and values, so they must not match.',
      match: {python: {all: [/hash\(\s*\(\s*\w+\s*,\s*tuple\(|hashlib\.sha256\(/]}},
    },
    {
      id: 'full-blocks',
      title: 'Only full blocks are cached, and the last prompt token is computed',
      detail:
        'The prefix lookup covers `(len(token_ids) - 1) // block_size` blocks: partial blocks are never shared, and at least one token is left to produce the logits.',
      match: {python: {all: [/\(\s*len\(\s*token_ids\s*\)\s*-\s*1\s*\)\s*\/\/\s*(?:self\.)?\w+/]}},
    },
    {
      id: 'chain-breaks',
      title: 'The lookup stops at the first miss',
      detail:
        'A miss on block `i` ends the shared prefix: block `i + 1` may still be cached (block `i` was evicted first), but taking it would leave a hole in the table that nothing computes. `if block is None: break`.',
      match: {python: {all: [/is\s+None\s*:\s*\n\s*break\b/]}},
    },
    {
      id: 'hit-takes-ref',
      title: 'A hit takes a reference and leaves the free queue',
      detail:
        '`lookup` increments `ref_count` and removes an idle hit from `free_queue` (`del` or `pop`), so the block cannot be evicted while a sequence reads it.',
      match: {
        python: {all: [/del\s+self\.free_queue\[\w+\]|self\.free_queue\.pop\(\w+/, /self\.ref_count\[\w+\]\s*\+=\s*1/]},
      },
    },
    {
      id: 'lru-evict',
      title: 'Allocation pops the LRU block and evicts its hash',
      detail:
        '`allocate` takes `free_queue.popitem(last=False)`, the least recently freed block, and deletes its hash from `cached`: from then on the block holds new data and must not be found.',
      match: {python: {all: [/popitem\(\s*last\s*=\s*False\s*\)/, /del\s+self\.cached\[|self\.cached\.pop\(/]}},
    },
    {
      id: 'free-keeps-hash',
      title: 'A freed block keeps its hash at the tail of the queue',
      detail:
        '`free` appends the block with `free_queue[block] = None` (or `move_to_end`) and leaves `hash_of` alone: the most recently freed is evicted last.',
      match: {python: {all: [/self\.free_queue\[\w+\]\s*=\s*None|self\.free_queue\.move_to_end\(/]}},
    },
    {
      id: 'publish-after-compute',
      title: 'Blocks are published once their KV is computed',
      detail:
        '`on_computed` calls `mark_computed`, which `register`s each newly full block: a block registered before the forward pass wrote it would hand another request empty keys.',
      match: {python: {all: [/\.register\(/, /def on_computed[\s\S]*?\.mark_computed\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""Automatic prefix caching: full KV blocks found by a hash of their tokens and everything before them."""

from collections import OrderedDict

import torch

from block_manager import BlockAllocator, BlockManager
from scheduler import LLMEngine, Sequence, TinyLM, dense_generate


def block_hash(prev_hash: int | None, token_ids: list[int]) -> int:
    """A full block's identity: the previous block's hash chained with this block's token ids."""
    raise NotImplementedError("TODO: hash the previous hash together with the tuple of token ids")


class PrefixCachingAllocator(BlockAllocator):
    """Free blocks wait in one LRU queue; a freed block keeps its hash and contents until it is reallocated."""

    def __init__(self, num_blocks: int, block_size: int):
        self.num_blocks = num_blocks
        self.block_size = block_size
        self.ref_count = [0] * num_blocks
        self.free_queue: OrderedDict[int, None] = OrderedDict((b, None) for b in range(num_blocks))
        self.hash_of: list[int | None] = [None] * num_blocks
        self.cached: dict[int, int] = {}  # hash -> block
        self.evictions = 0

    def num_free(self) -> int:
        return len(self.free_queue)

    def allocate(self) -> int:
        """Pop the least recently freed block; if it still holds a cached block, evict it from the table."""
        # TODO: pop the head (least recently freed) of self.free_queue; if that block still has a hash,
        # evict it: drop it from self.cached and clear hash_of. Ref count 1.
        raise NotImplementedError("TODO: allocate with LRU eviction")

    def free(self, block: int) -> None:
        # TODO: drop a reference; at zero the block joins the tail of self.free_queue, hash kept.
        raise NotImplementedError("TODO: free into the LRU queue")

    def lookup(self, h: int) -> int | None:
        """A hit takes a reference on the cached block (pulling it off the free queue if it was idle)."""
        # TODO: None on a miss; on a hit take a reference, pulling an idle block off the free queue.
        raise NotImplementedError("TODO: lookup")

    def register(self, block: int, h: int) -> None:
        """Publish a computed full block under h (a hash already published keeps its first block)."""
        raise NotImplementedError("TODO: register")


class PrefixCachingBlockManager(BlockManager):
    """Block tables whose leading full blocks may be shared cached blocks found by hash."""

    def __init__(self, num_blocks: int, block_size: int):
        super().__init__(num_blocks, block_size)
        self.hashes: dict[int, list[int]] = {}
        self.query_tokens = 0
        self.hit_tokens = 0

    def hit_rate(self) -> float:
        """Prompt tokens served from the cache / prompt tokens admitted."""
        return self.hit_tokens / max(1, self.query_tokens)

    def make_allocator(self, num_blocks: int, block_size: int) -> BlockAllocator:
        return PrefixCachingAllocator(num_blocks, block_size)

    def _prefix_hashes(self, token_ids: list[int]) -> list[int]:
        """Hashes of the full blocks a prompt may reuse: at least its last token is always computed."""
        # TODO: chained hashes of the first (len(token_ids) - 1) // block_size blocks.
        raise NotImplementedError("TODO: _prefix_hashes")

    def can_allocate(self, seq_id: int, token_ids: list[int]) -> bool:
        """Blocks the prompt needs beyond its cached prefix, plus cached hits that are idle, fit the free queue."""
        raise NotImplementedError("TODO: can_allocate")

    def allocate(self, seq_id: int, token_ids: list[int]) -> int:
        """Share the longest cached prefix of full blocks, reserve slots for the rest; returns cached tokens."""
        # TODO: look the prefix hashes up in order and stop at the first miss; the hits start the block
        # table (their tokens count as computed); reserve slots for the rest with append_slots; keep the
        # hashes per sequence and count query_tokens and hit_tokens.
        raise NotImplementedError("TODO: allocate with a cached prefix")

    def mark_computed(self, seq_id: int, token_ids: list[int]) -> None:
        """Hash every block that has just become full of computed tokens and publish it."""
        # TODO: for every block now full of computed tokens that has no hash yet, chain its hash and register it.
        raise NotImplementedError("TODO: mark_computed")

    def free(self, seq_id: int) -> None:
        super().free(seq_id)  # last block first, so a prefix's tail is evicted before its head
        del self.hashes[seq_id]


class PrefixCachingEngine(LLMEngine):
    def make_block_manager(self, num_blocks: int, block_size: int) -> BlockManager:
        return PrefixCachingBlockManager(num_blocks, block_size)

    def on_computed(self, seq: Sequence) -> None:
        raise NotImplementedError("TODO: publish the sequence's newly full blocks")


if __name__ == "__main__":
    torch.manual_seed(0)
    model = TinyLM().double().eval()
    vocab = model.embed.num_embeddings
    BS, MAX_TOKENS = 4, 8
    system = torch.randint(1, vocab, (21,)).tolist()  # 5 full blocks and one token
    users = [torch.randint(1, vocab, (n,)).tolist() for n in (6, 3, 9)]
    prompts = [system + u for u in users]
    expected = [dense_generate(model, p, MAX_TOKENS, None) for p in prompts]

    # LRU order on the allocator alone: freed hashed blocks are evicted oldest first, hits revive them.
    alloc = PrefixCachingAllocator(3, BS)
    blocks = [alloc.allocate() for _ in range(3)]
    for b, h in zip(blocks, (11, 22, 33)):
        alloc.register(b, h)
    for b in blocks:
        alloc.free(b)
    assert alloc.lookup(11) == blocks[0] and alloc.ref_count[blocks[0]] == 1  # revived, off the queue
    assert alloc.allocate() == blocks[1] and 22 not in alloc.cached  # LRU victim: evicted
    assert alloc.lookup(22) is None and alloc.lookup(33) == blocks[2]

    # A cold request prefills everything; the second one with the same system prompt reuses its 5 blocks.
    engine = PrefixCachingEngine(model, num_blocks=64, block_size=BS)
    assert engine.generate([prompts[0]], MAX_TOKENS) == [expected[0]]
    cold = engine.num_prefill_tokens
    assert cold == len(prompts[0])
    assert engine.generate([prompts[1]], MAX_TOKENS) == [expected[1]]
    warm = engine.num_prefill_tokens - cold
    assert warm == len(prompts[1]) - 20, warm  # 5 cached blocks of 4 tokens
    bm = engine.block_manager
    assert bm.hit_rate() == 20 / (len(prompts[0]) + len(prompts[1]))
    print(f"second request prefills {warm} of {len(prompts[1])} tokens; prompt-token hit rate {bm.hit_rate():.0%}")
    alloc = bm.allocator

    # Two concurrent requests share the cached blocks with ref count 2; outputs stay identical.
    s2 = engine.add_request(prompts[2], MAX_TOKENS)
    s0 = engine.add_request(prompts[0], MAX_TOKENS)
    engine.step()  # one prefill batch for both
    shared = engine.block_manager.block_tables[s2.seq_id][:5]
    assert shared == engine.block_manager.block_tables[s0.seq_id][:5]
    assert all(alloc.ref_count[b] == 2 for b in shared)
    while engine.scheduler.has_work():
        engine.step()
    assert [s2.output, s0.output] == [expected[2], expected[0]]
    assert engine.block_manager.block_tables == {} and all(r == 0 for r in alloc.ref_count)
    assert engine.block_manager.num_free() == 64

    # Eviction: a small pool, an unrelated request that needs most of it, then the system prompt again.
    engine = PrefixCachingEngine(model, num_blocks=12, block_size=BS)
    assert engine.generate([prompts[0]], MAX_TOKENS) == [expected[0]]  # 9 blocks used, then freed
    alloc = engine.block_manager.allocator
    other = torch.randint(1, vocab, (30,)).tolist()
    assert engine.generate([other], 2) == [dense_generate(model, other, 2, None)]  # 8 blocks: evicts 5
    assert alloc.evictions > 0
    survivors = 0
    h = None
    for i in range(5):
        h = block_hash(h, system[i * BS:(i + 1) * BS])
        if h not in alloc.cached:
            break
        survivors += 1
    before = engine.num_prefill_tokens
    assert engine.generate([prompts[1]], MAX_TOKENS) == [expected[1]]
    assert engine.num_prefill_tokens - before == len(prompts[1]) - survivors * BS
    for h, b in alloc.cached.items():
        assert alloc.hash_of[b] == h, "the table and the blocks agree after eviction"
    assert engine.block_manager.num_free() == 12
    print(f"after eviction {survivors} of 5 system blocks survived; {alloc.evictions} evictions; outputs identical")
    print("PASS")
`,
      solution: `"""Automatic prefix caching: full KV blocks found by a hash of their tokens and everything before them."""

from collections import OrderedDict

import torch

from block_manager import BlockAllocator, BlockManager
from scheduler import LLMEngine, Sequence, TinyLM, dense_generate


def block_hash(prev_hash: int | None, token_ids: list[int]) -> int:
    """A full block's identity: the previous block's hash chained with this block's token ids."""
    return hash((prev_hash, tuple(token_ids)))


class PrefixCachingAllocator(BlockAllocator):
    """Free blocks wait in one LRU queue; a freed block keeps its hash and contents until it is reallocated."""

    def __init__(self, num_blocks: int, block_size: int):
        self.num_blocks = num_blocks
        self.block_size = block_size
        self.ref_count = [0] * num_blocks
        self.free_queue: OrderedDict[int, None] = OrderedDict((b, None) for b in range(num_blocks))
        self.hash_of: list[int | None] = [None] * num_blocks
        self.cached: dict[int, int] = {}  # hash -> block
        self.evictions = 0

    def num_free(self) -> int:
        return len(self.free_queue)

    def allocate(self) -> int:
        """Pop the least recently freed block; if it still holds a cached block, evict it from the table."""
        if not self.free_queue:
            raise MemoryError("out of KV blocks")
        block, _ = self.free_queue.popitem(last=False)
        if self.hash_of[block] is not None:
            del self.cached[self.hash_of[block]]
            self.hash_of[block] = None
            self.evictions += 1
        assert self.ref_count[block] == 0
        self.ref_count[block] = 1
        return block

    def free(self, block: int) -> None:
        assert self.ref_count[block] > 0, f"double free of block {block}"
        self.ref_count[block] -= 1
        if self.ref_count[block] == 0:
            self.free_queue[block] = None  # most recently used end: evicted last

    def lookup(self, h: int) -> int | None:
        """A hit takes a reference on the cached block (pulling it off the free queue if it was idle)."""
        block = self.cached.get(h)
        if block is None:
            return None
        if self.ref_count[block] == 0:
            del self.free_queue[block]
        self.ref_count[block] += 1
        return block

    def register(self, block: int, h: int) -> None:
        """Publish a computed full block under h (a hash already published keeps its first block)."""
        if self.hash_of[block] is None and h not in self.cached:
            self.hash_of[block] = h
            self.cached[h] = block


class PrefixCachingBlockManager(BlockManager):
    """Block tables whose leading full blocks may be shared cached blocks found by hash."""

    def __init__(self, num_blocks: int, block_size: int):
        super().__init__(num_blocks, block_size)
        self.hashes: dict[int, list[int]] = {}
        self.query_tokens = 0
        self.hit_tokens = 0

    def hit_rate(self) -> float:
        """Prompt tokens served from the cache / prompt tokens admitted."""
        return self.hit_tokens / max(1, self.query_tokens)

    def make_allocator(self, num_blocks: int, block_size: int) -> BlockAllocator:
        return PrefixCachingAllocator(num_blocks, block_size)

    def _prefix_hashes(self, token_ids: list[int]) -> list[int]:
        """Hashes of the full blocks a prompt may reuse: at least its last token is always computed."""
        bs = self.block_size
        hashes, prev = [], None
        for i in range((len(token_ids) - 1) // bs):
            prev = block_hash(prev, token_ids[i * bs:(i + 1) * bs])
            hashes.append(prev)
        return hashes

    def can_allocate(self, seq_id: int, token_ids: list[int]) -> bool:
        """Blocks the prompt needs beyond its cached prefix, plus cached hits that are idle, fit the free queue."""
        alloc = self.allocator
        cached = 0
        idle_hits = 0
        for h in self._prefix_hashes(token_ids):
            block = alloc.cached.get(h)
            if block is None:
                break
            cached += 1
            idle_hits += alloc.ref_count[block] == 0  # a hit on an idle block takes it off the free queue
        need = -(-len(token_ids) // self.block_size) - cached
        return need + idle_hits <= self.num_free()

    def allocate(self, seq_id: int, token_ids: list[int]) -> int:
        """Share the longest cached prefix of full blocks, reserve slots for the rest; returns cached tokens."""
        assert seq_id not in self.block_tables
        table: list[int] = []
        hashes: list[int] = []
        for h in self._prefix_hashes(token_ids):
            block = self.allocator.lookup(h)
            if block is None:
                break  # the chain breaks at the first miss: later blocks depend on this one
            table.append(block)
            hashes.append(h)
        cached = len(table) * self.block_size
        self.query_tokens += len(token_ids)
        self.hit_tokens += cached
        self.block_tables[seq_id] = table
        self.num_tokens[seq_id] = cached
        self.hashes[seq_id] = hashes
        self.append_slots(seq_id, len(token_ids) - cached)
        return cached

    def mark_computed(self, seq_id: int, token_ids: list[int]) -> None:
        """Hash every block that has just become full of computed tokens and publish it."""
        bs = self.block_size
        table, hashes = self.block_tables[seq_id], self.hashes[seq_id]
        while len(hashes) < len(token_ids) // bs:
            i = len(hashes)
            h = block_hash(hashes[-1] if hashes else None, token_ids[i * bs:(i + 1) * bs])
            self.allocator.register(table[i], h)
            hashes.append(h)

    def free(self, seq_id: int) -> None:
        super().free(seq_id)  # last block first, so a prefix's tail is evicted before its head
        del self.hashes[seq_id]


class PrefixCachingEngine(LLMEngine):
    def make_block_manager(self, num_blocks: int, block_size: int) -> BlockManager:
        return PrefixCachingBlockManager(num_blocks, block_size)

    def on_computed(self, seq: Sequence) -> None:
        self.block_manager.mark_computed(seq.seq_id, seq.tokens[:seq.num_computed])


if __name__ == "__main__":
    torch.manual_seed(0)
    model = TinyLM().double().eval()
    vocab = model.embed.num_embeddings
    BS, MAX_TOKENS = 4, 8
    system = torch.randint(1, vocab, (21,)).tolist()  # 5 full blocks and one token
    users = [torch.randint(1, vocab, (n,)).tolist() for n in (6, 3, 9)]
    prompts = [system + u for u in users]
    expected = [dense_generate(model, p, MAX_TOKENS, None) for p in prompts]

    # LRU order on the allocator alone: freed hashed blocks are evicted oldest first, hits revive them.
    alloc = PrefixCachingAllocator(3, BS)
    blocks = [alloc.allocate() for _ in range(3)]
    for b, h in zip(blocks, (11, 22, 33)):
        alloc.register(b, h)
    for b in blocks:
        alloc.free(b)
    assert alloc.lookup(11) == blocks[0] and alloc.ref_count[blocks[0]] == 1  # revived, off the queue
    assert alloc.allocate() == blocks[1] and 22 not in alloc.cached  # LRU victim: evicted
    assert alloc.lookup(22) is None and alloc.lookup(33) == blocks[2]

    # A cold request prefills everything; the second one with the same system prompt reuses its 5 blocks.
    engine = PrefixCachingEngine(model, num_blocks=64, block_size=BS)
    assert engine.generate([prompts[0]], MAX_TOKENS) == [expected[0]]
    cold = engine.num_prefill_tokens
    assert cold == len(prompts[0])
    assert engine.generate([prompts[1]], MAX_TOKENS) == [expected[1]]
    warm = engine.num_prefill_tokens - cold
    assert warm == len(prompts[1]) - 20, warm  # 5 cached blocks of 4 tokens
    bm = engine.block_manager
    assert bm.hit_rate() == 20 / (len(prompts[0]) + len(prompts[1]))
    print(f"second request prefills {warm} of {len(prompts[1])} tokens; prompt-token hit rate {bm.hit_rate():.0%}")
    alloc = bm.allocator

    # Two concurrent requests share the cached blocks with ref count 2; outputs stay identical.
    s2 = engine.add_request(prompts[2], MAX_TOKENS)
    s0 = engine.add_request(prompts[0], MAX_TOKENS)
    engine.step()  # one prefill batch for both
    shared = engine.block_manager.block_tables[s2.seq_id][:5]
    assert shared == engine.block_manager.block_tables[s0.seq_id][:5]
    assert all(alloc.ref_count[b] == 2 for b in shared)
    while engine.scheduler.has_work():
        engine.step()
    assert [s2.output, s0.output] == [expected[2], expected[0]]
    assert engine.block_manager.block_tables == {} and all(r == 0 for r in alloc.ref_count)
    assert engine.block_manager.num_free() == 64

    # Eviction: a small pool, an unrelated request that needs most of it, then the system prompt again.
    engine = PrefixCachingEngine(model, num_blocks=12, block_size=BS)
    assert engine.generate([prompts[0]], MAX_TOKENS) == [expected[0]]  # 9 blocks used, then freed
    alloc = engine.block_manager.allocator
    other = torch.randint(1, vocab, (30,)).tolist()
    assert engine.generate([other], 2) == [dense_generate(model, other, 2, None)]  # 8 blocks: evicts 5
    assert alloc.evictions > 0
    survivors = 0
    h = None
    for i in range(5):
        h = block_hash(h, system[i * BS:(i + 1) * BS])
        if h not in alloc.cached:
            break
        survivors += 1
    before = engine.num_prefill_tokens
    assert engine.generate([prompts[1]], MAX_TOKENS) == [expected[1]]
    assert engine.num_prefill_tokens - before == len(prompts[1]) - survivors * BS
    for h, b in alloc.cached.items():
        assert alloc.hash_of[b] == h, "the table and the blocks agree after eviction"
    assert engine.block_manager.num_free() == 12
    print(f"after eviction {survivors} of 5 system blocks survived; {alloc.evictions} evictions; outputs identical")
    print("PASS")
`,
    },
  },
  debrief: `System prompts, few-shot examples, multi-turn chats and agent loops resend the same thousands of tokens on every request; recomputing them is pure waste, and their KV blocks are already in memory when the previous request finishes. vLLM's automatic prefix caching names each full block by the hash of its parent's hash and its own tokens, keeps a hash-to-block table, and lets freed blocks sit in the free queue with their hash until the allocator actually needs them; the free queue's order is the LRU policy, and freeing a request's blocks in reverse puts the most specific blocks at the front. The chain makes a match on block \`i\` imply a match of the whole prefix, and stopping at the first miss keeps the table a prefix of hits followed by fresh blocks, which is all PagedAttention needs. SGLang's RadixAttention keeps the same information as a radix tree over token sequences, which also matches partial blocks and makes eviction a leaf-first walk; vLLM's hash table is simpler and fits fixed blocks. Python's \`hash\` of a tuple of ints is 64 bits and not collision-resistant: since v0.11 vLLM hashes with \`sha256\` by default, because a collision would silently attend to another request's keys, and it can salt the first block per tenant so cache timing cannot leak whether someone else sent the same prompt. Production also puts extra keys in the hash (the LoRA adapter, image hashes), so the same token ids under a different adapter or image never match, and offloads evicted blocks to CPU memory or disk (LMCache) instead of forgetting them.`,
};
