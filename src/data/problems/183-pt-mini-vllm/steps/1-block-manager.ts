import type {Step} from '@/lib/types';

export const blockManagerStep: Step = {
  id: 'block-manager',
  title: 'Block manager: block tables, ref counts, copy-on-write',
  concept: 'pytorch',
  file: 'block_manager',
  focus: ['block-manager', 'tables', 'table-a', 'table-b', 'free-list'],
  task: `## Task

Write \`block_manager.py\`: the bookkeeping that lets one sequence's keys and values live in fixed-size
blocks scattered over a pool. No tensors yet: a block is an integer, a slot is \`block * block_size +
offset\`.

\`BlockAllocator(num_blocks, block_size)\` (its \`__init__\` is given): \`free_list\` is a \`deque\` of every block
id, \`ref_count\` a list of zeros.

- \`allocate() -> int\`: \`popleft\` a block and give it ref count 1; \`MemoryError\` when the list is empty.
- \`incref(block)\`: one more owner of a live block.
- \`free(block)\`: one owner fewer; at 0 the block is appended to the free list. Freeing a block at 0 is an
  \`AssertionError\`.

\`BlockManager(num_blocks, block_size)\`: \`block_tables[seq_id]\` lists the physical blocks of a sequence
(logical block \`j\` holds positions \`j * block_size\` to \`(j + 1) * block_size - 1\`); \`num_tokens[seq_id]\`
counts its reserved slots.

- \`append_slots(seq_id, n=1) -> list[int]\`: reserve the next \`n\` positions and return their slot ids.
  Offset 0 allocates a new block. A position with offset > 0 whose last block has ref count > 1 is a write
  into a shared block: **copy-on-write** allocates a fresh block, appends \`(old, new)\` to \`self.copies\`,
  frees one reference of the old block and puts the new one in the table.
- \`blocks_for(seq_id, n) -> int\`: the blocks that \`append_slots(seq_id, n)\` would take, the copy included.
  \`can_append\` compares it with \`num_free()\` (given).
- \`slot_mapping(seq_id, start, end) -> list[int]\`: the slots of positions \`start\` to \`end - 1\`.
- \`fork(parent_id, child_id)\`: the child gets a copy of the parent's table and token count and every block
  one more reference. Nothing is copied yet.
- \`free(seq_id)\`: drop the table and the count, releasing the blocks **last block first** (step 4's LRU
  queue relies on that order).
- Given: \`allocate(seq_id, token_ids)\` reserves a prompt and returns 0, the number of tokens whose KV is
  already cached (step 4 overrides it); \`can_allocate\`, \`take_copies\` and \`waste\`.

The self-test, with 8 blocks of 4 slots:

- 10 tokens take 3 blocks, and their slots follow the table.
- A fork shares all three at ref count 2; the child's next append copies the shared, partly filled last
  block exactly once, and the parent's next append then copies nothing.
- Shared blocks return to the free list only with their last owner; appending past the pool raises
  \`MemoryError\`.
- 64 sequences of random length up to 512, grown in random chunks, waste at most \`block_size - 1\` slots
  each, printed beside the waste of contiguous \`max_len\` preallocation.
- \`check_invariants\` after every phase: a block's ref count equals the number of tables holding it, and a
  block is on the free list exactly when it is unreferenced. Then it prints \`PASS\`.

Step through three sequences growing over a pool; switch the block size and the shared prefix:

:::widget paged-kv {"blockSize": 4}

> A sequence's KV memory is a list of block ids, not a range of addresses: it grows one block at a time,
> wastes less than one block, and can point at blocks another sequence also uses.`,
  hints: [
    'Position `p` lives in slot `table[p // block_size] * block_size + p % block_size`. A sequence needs a new block exactly when it writes a position with `p % block_size == 0`.',
    'Copy-on-write only arises in a partly filled last block: a full shared block is never written again, so crossing into a new block just allocates. Release the old block with `self.allocator.free(old)` so its count drops back to the other owners.',
    '`blocks_for` is `-(-(used + n) // block_size) - len(table)` (a ceiling division), plus 1 when `used % block_size != 0` and `ref_count[table[-1]] > 1`. For `free`, loop over `reversed(self.block_tables.pop(seq_id))`.',
  ],
  checks: [
    {
      id: 'allocate',
      title: 'Allocation takes a free block with one reference',
      detail:
        '`allocate` pops a block off `free_list` and sets its `ref_count` to 1: a block is either free (count 0, on the list) or owned.',
      match: {python: {all: [/free_list\.(?:popleft|pop)\(/, /ref_count\[\w+\]\s*=\s*1\b/]}},
    },
    {
      id: 'free-at-zero',
      title: 'A block goes back to the free list only at ref count 0',
      detail:
        '`free` decrements `ref_count` and appends the block to `free_list` only when the count reaches 0, so a block shared by a fork survives its first owner.',
      match: {python: {order: [/ref_count\[\w+\]\s*-=\s*1/, /==\s*0\s*:/, /free_list\.append\(/]}},
    },
    {
      id: 'new-block',
      title: 'A new block when the last one is full',
      detail:
        '`append_slots` calls `self.allocator.allocate()` for a position whose offset `pos % self.block_size` is 0, and only then: memory grows one block at a time.',
      match: {python: {all: [/\.append\(\s*self\.allocator\.allocate\(\)\s*\)/, /%\s*self\.block_size/]}},
    },
    {
      id: 'slot-ids',
      title: 'Slot id = block × block_size + offset',
      detail:
        'A slot is a flat index into the cache viewed as `[num_blocks * block_size, ...]`: `block * self.block_size + offset`. Step 2 writes keys and values there.',
      match: {python: {all: [/\*\s*self\.block_size\s*\+/]}},
    },
    {
      id: 'copy-on-write',
      title: 'Writing into a shared block copies it first',
      detail:
        'When the last block has `ref_count > 1` and the next position is inside it, a fresh block is allocated and `(old, new)` appended to `self.copies`; writing in place would change the other sequence’s tokens.',
      match: {python: {all: [/ref_count\[[^\n]*?\]\s*>\s*1/, /self\.copies\.append\(/]}},
    },
    {
      id: 'fork',
      title: 'Fork shares blocks by reference',
      detail:
        '`fork` copies the parent’s table (a list of ints) and calls `incref` on every block; no block is allocated until one of them writes.',
      match: {python: {all: [/\.incref\(/]}},
    },
    {
      id: 'free-reverse',
      title: 'Freeing a sequence releases its blocks last first',
      detail:
        '`free(seq_id)` passes every block of the table to `self.allocator.free` in `reversed` order, so the block holding the most specific tokens is the first to be reused (and, in step 4, evicted).',
      match: {python: {all: [/reversed\(/, /self\.allocator\.free\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""Paged KV memory bookkeeping: a block allocator with ref counts, and one block table per sequence."""

from collections import deque


class BlockAllocator:
    """num_blocks physical KV blocks of block_size token slots each: a free list and a ref count per block."""

    def __init__(self, num_blocks: int, block_size: int):
        self.num_blocks = num_blocks
        self.block_size = block_size
        self.free_list: deque[int] = deque(range(num_blocks))
        self.ref_count = [0] * num_blocks

    def num_free(self) -> int:
        return len(self.free_list)

    def allocate(self) -> int:
        """Take a block off the free list with one reference; MemoryError when none is left."""
        # TODO: pop the head of the free list (MemoryError when empty) and give it ref count 1.
        raise NotImplementedError("TODO: allocate a block")

    def incref(self, block: int) -> None:
        # TODO: one more owner of a live block.
        raise NotImplementedError("TODO: incref")

    def free(self, block: int) -> None:
        """Drop one reference; the block returns to the free list when the last one goes."""
        # TODO: drop one reference; at zero, the block goes back on the free list.
        raise NotImplementedError("TODO: free a block")


class BlockManager:
    """Maps each sequence's logical blocks (token position // block_size) to physical blocks."""

    def __init__(self, num_blocks: int, block_size: int):
        self.block_size = block_size
        self.allocator = self.make_allocator(num_blocks, block_size)
        self.block_tables: dict[int, list[int]] = {}
        self.num_tokens: dict[int, int] = {}
        self.copies: list[tuple[int, int]] = []

    def make_allocator(self, num_blocks: int, block_size: int) -> BlockAllocator:
        return BlockAllocator(num_blocks, block_size)

    def num_free(self) -> int:
        return self.allocator.num_free()

    def blocks_for(self, seq_id: int, n: int) -> int:
        """Physical blocks that appending n slots to seq_id takes: new blocks plus one copy-on-write."""
        # TODO: blocks still to allocate for used + n tokens, plus 1 when the partly filled last block is
        # shared (ref count > 1) and must be copied before this sequence writes into it.
        raise NotImplementedError("TODO: blocks_for")

    def can_append(self, seq_id: int, n: int = 1) -> bool:
        return self.blocks_for(seq_id, n) <= self.num_free()

    def can_allocate(self, seq_id: int, token_ids: list[int]) -> bool:
        return self.can_append(seq_id, len(token_ids))

    def allocate(self, seq_id: int, token_ids: list[int]) -> int:
        """Reserve slots for a prompt; returns how many leading tokens already have KV (0 without a prefix cache)."""
        assert seq_id not in self.block_tables, f"sequence {seq_id} already has a block table"
        self.append_slots(seq_id, len(token_ids))
        return 0

    def append_slots(self, seq_id: int, n: int = 1) -> list[int]:
        """Reserve the next n token slots of seq_id and return their slot ids (block * block_size + offset)."""
        # TODO: for each new position: offset 0 takes a fresh block; a write into a shared last block
        # copies it first (record (old, new) in self.copies, release the old one); slot = block * size + offset.
        raise NotImplementedError("TODO: append_slots")

    def slot_mapping(self, seq_id: int, start: int, end: int) -> list[int]:
        """Slot ids of positions start .. end - 1 of seq_id."""
        raise NotImplementedError("TODO: slot_mapping")

    def fork(self, parent_id: int, child_id: int) -> None:
        """The child shares every block of the parent; the first write into a shared partial block copies it."""
        # TODO: the child's table is a copy of the parent's, every block one reference more.
        raise NotImplementedError("TODO: fork")

    def take_copies(self) -> list[tuple[int, int]]:
        """(src, dst) block copies the KV cache must perform before the next write."""
        copies, self.copies = self.copies, []
        return copies

    def free(self, seq_id: int) -> None:
        """Release every block of seq_id, last block first."""
        # TODO: drop the table and the token count, releasing the blocks last block first.
        raise NotImplementedError("TODO: free a sequence")

    def waste(self, seq_id: int) -> int:
        """Reserved but unused slots: only the tail of the last block."""
        return len(self.block_tables[seq_id]) * self.block_size - self.num_tokens[seq_id]


def check_invariants(bm: BlockManager) -> None:
    alloc = bm.allocator
    refs = [0] * alloc.num_blocks
    for table in bm.block_tables.values():
        for block in table:
            refs[block] += 1
    assert refs == alloc.ref_count, "ref counts must equal the number of tables holding each block"
    free = list(alloc.free_list)
    assert len(set(free)) == len(free), "a block is on the free list twice"
    for block in range(alloc.num_blocks):
        assert (block in free) == (alloc.ref_count[block] == 0), f"block {block}: free iff unreferenced"


if __name__ == "__main__":
    import random

    random.seed(0)
    BS = 4
    bm = BlockManager(num_blocks=8, block_size=BS)

    # Allocation: 10 tokens take ceil(10 / 4) = 3 blocks; slots follow the block table.
    slots = bm.append_slots(0, 10)
    t0 = bm.block_tables[0]
    assert len(t0) == 3 and bm.num_free() == 5
    assert slots == [t0[p // BS] * BS + p % BS for p in range(10)]
    assert bm.slot_mapping(0, 4, 10) == slots[4:]
    assert bm.waste(0) == 2
    check_invariants(bm)

    # Fork: the child shares all three blocks, nothing is copied yet.
    bm.fork(0, 1)
    assert bm.block_tables[1] == t0 and all(bm.allocator.ref_count[b] == 2 for b in t0)
    assert bm.num_free() == 5 and bm.take_copies() == []
    check_invariants(bm)

    # Copy-on-write: the child appends into the shared, partly filled last block.
    shared_last = t0[-1]
    assert bm.blocks_for(1, 1) == 1
    (slot,) = bm.append_slots(1, 1)
    t1 = bm.block_tables[1]
    assert t1[:2] == t0[:2] and t1[2] != shared_last
    assert bm.take_copies() == [(shared_last, t1[2])]
    assert slot == t1[2] * BS + 2
    assert bm.allocator.ref_count[shared_last] == 1 and bm.num_free() == 4
    # The parent now owns its last block alone: appending copies nothing.
    bm.append_slots(0, 1)
    assert bm.block_tables[0][-1] == shared_last and bm.take_copies() == []
    check_invariants(bm)

    # A full shared block is never written again: crossing into a new block allocates, no copy.
    bm.append_slots(1, 1)
    bm.append_slots(1, 1)
    assert len(bm.block_tables[1]) == 4 and bm.take_copies() == []
    check_invariants(bm)

    # Free: shared blocks survive until their last owner goes.
    bm.free(0)
    assert all(bm.allocator.ref_count[b] == 1 for b in t0[:2])
    check_invariants(bm)
    bm.free(1)
    assert bm.num_free() == 8 and bm.block_tables == {}
    check_invariants(bm)

    # Out of memory is an error the scheduler must avoid with can_append.
    bm.append_slots(2, 8 * BS)
    assert not bm.can_append(2, 1)
    try:
        bm.append_slots(2, 1)
        raise AssertionError("allocation past the pool must fail")
    except MemoryError:
        pass
    bm.free(2)

    # Waste: at most block_size - 1 slots per sequence, against max_len preallocation.
    BS, MAX_LEN = 16, 512
    bm = BlockManager(num_blocks=2048, block_size=BS)
    lengths = [random.randint(1, MAX_LEN) for _ in range(64)]
    for seq_id, n in enumerate(lengths):
        done = 0
        while done < n:  # prompt then decode steps, as a server grows a sequence
            step = min(n - done, random.randint(1, 20))
            bm.append_slots(seq_id, step)
            done += step
        assert 0 <= bm.waste(seq_id) <= BS - 1
    check_invariants(bm)
    paged_waste = sum(bm.waste(s) for s in range(len(lengths)))
    contiguous_waste = sum(MAX_LEN - n for n in lengths)
    used = sum(lengths)
    print(f"tokens {used}: paged waste {paged_waste} slots ({paged_waste / (used + paged_waste):.1%}), "
          f"contiguous max_len waste {contiguous_waste} ({contiguous_waste / (MAX_LEN * len(lengths)):.1%})")
    assert paged_waste <= (BS - 1) * len(lengths) < contiguous_waste
    for seq_id in range(len(lengths)):
        bm.free(seq_id)
    assert bm.num_free() == 2048
    check_invariants(bm)
    print("PASS")
`,
      solution: `"""Paged KV memory bookkeeping: a block allocator with ref counts, and one block table per sequence."""

from collections import deque


class BlockAllocator:
    """num_blocks physical KV blocks of block_size token slots each: a free list and a ref count per block."""

    def __init__(self, num_blocks: int, block_size: int):
        self.num_blocks = num_blocks
        self.block_size = block_size
        self.free_list: deque[int] = deque(range(num_blocks))
        self.ref_count = [0] * num_blocks

    def num_free(self) -> int:
        return len(self.free_list)

    def allocate(self) -> int:
        """Take a block off the free list with one reference; MemoryError when none is left."""
        if not self.free_list:
            raise MemoryError("out of KV blocks")
        block = self.free_list.popleft()
        assert self.ref_count[block] == 0
        self.ref_count[block] = 1
        return block

    def incref(self, block: int) -> None:
        assert self.ref_count[block] > 0, "only a live block can be shared"
        self.ref_count[block] += 1

    def free(self, block: int) -> None:
        """Drop one reference; the block returns to the free list when the last one goes."""
        assert self.ref_count[block] > 0, f"double free of block {block}"
        self.ref_count[block] -= 1
        if self.ref_count[block] == 0:
            self.free_list.append(block)


class BlockManager:
    """Maps each sequence's logical blocks (token position // block_size) to physical blocks."""

    def __init__(self, num_blocks: int, block_size: int):
        self.block_size = block_size
        self.allocator = self.make_allocator(num_blocks, block_size)
        self.block_tables: dict[int, list[int]] = {}
        self.num_tokens: dict[int, int] = {}
        self.copies: list[tuple[int, int]] = []

    def make_allocator(self, num_blocks: int, block_size: int) -> BlockAllocator:
        return BlockAllocator(num_blocks, block_size)

    def num_free(self) -> int:
        return self.allocator.num_free()

    def blocks_for(self, seq_id: int, n: int) -> int:
        """Physical blocks that appending n slots to seq_id takes: new blocks plus one copy-on-write."""
        table = self.block_tables.get(seq_id, [])
        used = self.num_tokens.get(seq_id, 0)
        new = -(-(used + n) // self.block_size) - len(table)
        cow = used % self.block_size != 0 and n > 0 and self.allocator.ref_count[table[-1]] > 1
        return new + int(cow)

    def can_append(self, seq_id: int, n: int = 1) -> bool:
        return self.blocks_for(seq_id, n) <= self.num_free()

    def can_allocate(self, seq_id: int, token_ids: list[int]) -> bool:
        return self.can_append(seq_id, len(token_ids))

    def allocate(self, seq_id: int, token_ids: list[int]) -> int:
        """Reserve slots for a prompt; returns how many leading tokens already have KV (0 without a prefix cache)."""
        assert seq_id not in self.block_tables, f"sequence {seq_id} already has a block table"
        self.append_slots(seq_id, len(token_ids))
        return 0

    def append_slots(self, seq_id: int, n: int = 1) -> list[int]:
        """Reserve the next n token slots of seq_id and return their slot ids (block * block_size + offset)."""
        table = self.block_tables.setdefault(seq_id, [])
        used = self.num_tokens.get(seq_id, 0)
        slots = []
        for pos in range(used, used + n):
            offset = pos % self.block_size
            if offset == 0:
                table.append(self.allocator.allocate())
            elif self.allocator.ref_count[table[-1]] > 1:
                # Copy-on-write: the partly filled last block is shared, so this sequence gets its own copy.
                fresh = self.allocator.allocate()
                self.copies.append((table[-1], fresh))
                self.allocator.free(table[-1])
                table[-1] = fresh
            slots.append(table[-1] * self.block_size + offset)
        self.num_tokens[seq_id] = used + n
        return slots

    def slot_mapping(self, seq_id: int, start: int, end: int) -> list[int]:
        """Slot ids of positions start .. end - 1 of seq_id."""
        table = self.block_tables[seq_id]
        assert end <= self.num_tokens[seq_id]
        return [table[p // self.block_size] * self.block_size + p % self.block_size for p in range(start, end)]

    def fork(self, parent_id: int, child_id: int) -> None:
        """The child shares every block of the parent; the first write into a shared partial block copies it."""
        table = self.block_tables[parent_id]
        for block in table:
            self.allocator.incref(block)
        self.block_tables[child_id] = list(table)
        self.num_tokens[child_id] = self.num_tokens[parent_id]

    def take_copies(self) -> list[tuple[int, int]]:
        """(src, dst) block copies the KV cache must perform before the next write."""
        copies, self.copies = self.copies, []
        return copies

    def free(self, seq_id: int) -> None:
        """Release every block of seq_id, last block first."""
        for block in reversed(self.block_tables.pop(seq_id)):
            self.allocator.free(block)
        del self.num_tokens[seq_id]

    def waste(self, seq_id: int) -> int:
        """Reserved but unused slots: only the tail of the last block."""
        return len(self.block_tables[seq_id]) * self.block_size - self.num_tokens[seq_id]


def check_invariants(bm: BlockManager) -> None:
    alloc = bm.allocator
    refs = [0] * alloc.num_blocks
    for table in bm.block_tables.values():
        for block in table:
            refs[block] += 1
    assert refs == alloc.ref_count, "ref counts must equal the number of tables holding each block"
    free = list(alloc.free_list)
    assert len(set(free)) == len(free), "a block is on the free list twice"
    for block in range(alloc.num_blocks):
        assert (block in free) == (alloc.ref_count[block] == 0), f"block {block}: free iff unreferenced"


if __name__ == "__main__":
    import random

    random.seed(0)
    BS = 4
    bm = BlockManager(num_blocks=8, block_size=BS)

    # Allocation: 10 tokens take ceil(10 / 4) = 3 blocks; slots follow the block table.
    slots = bm.append_slots(0, 10)
    t0 = bm.block_tables[0]
    assert len(t0) == 3 and bm.num_free() == 5
    assert slots == [t0[p // BS] * BS + p % BS for p in range(10)]
    assert bm.slot_mapping(0, 4, 10) == slots[4:]
    assert bm.waste(0) == 2
    check_invariants(bm)

    # Fork: the child shares all three blocks, nothing is copied yet.
    bm.fork(0, 1)
    assert bm.block_tables[1] == t0 and all(bm.allocator.ref_count[b] == 2 for b in t0)
    assert bm.num_free() == 5 and bm.take_copies() == []
    check_invariants(bm)

    # Copy-on-write: the child appends into the shared, partly filled last block.
    shared_last = t0[-1]
    assert bm.blocks_for(1, 1) == 1
    (slot,) = bm.append_slots(1, 1)
    t1 = bm.block_tables[1]
    assert t1[:2] == t0[:2] and t1[2] != shared_last
    assert bm.take_copies() == [(shared_last, t1[2])]
    assert slot == t1[2] * BS + 2
    assert bm.allocator.ref_count[shared_last] == 1 and bm.num_free() == 4
    # The parent now owns its last block alone: appending copies nothing.
    bm.append_slots(0, 1)
    assert bm.block_tables[0][-1] == shared_last and bm.take_copies() == []
    check_invariants(bm)

    # A full shared block is never written again: crossing into a new block allocates, no copy.
    bm.append_slots(1, 1)
    bm.append_slots(1, 1)
    assert len(bm.block_tables[1]) == 4 and bm.take_copies() == []
    check_invariants(bm)

    # Free: shared blocks survive until their last owner goes.
    bm.free(0)
    assert all(bm.allocator.ref_count[b] == 1 for b in t0[:2])
    check_invariants(bm)
    bm.free(1)
    assert bm.num_free() == 8 and bm.block_tables == {}
    check_invariants(bm)

    # Out of memory is an error the scheduler must avoid with can_append.
    bm.append_slots(2, 8 * BS)
    assert not bm.can_append(2, 1)
    try:
        bm.append_slots(2, 1)
        raise AssertionError("allocation past the pool must fail")
    except MemoryError:
        pass
    bm.free(2)

    # Waste: at most block_size - 1 slots per sequence, against max_len preallocation.
    BS, MAX_LEN = 16, 512
    bm = BlockManager(num_blocks=2048, block_size=BS)
    lengths = [random.randint(1, MAX_LEN) for _ in range(64)]
    for seq_id, n in enumerate(lengths):
        done = 0
        while done < n:  # prompt then decode steps, as a server grows a sequence
            step = min(n - done, random.randint(1, 20))
            bm.append_slots(seq_id, step)
            done += step
        assert 0 <= bm.waste(seq_id) <= BS - 1
    check_invariants(bm)
    paged_waste = sum(bm.waste(s) for s in range(len(lengths)))
    contiguous_waste = sum(MAX_LEN - n for n in lengths)
    used = sum(lengths)
    print(f"tokens {used}: paged waste {paged_waste} slots ({paged_waste / (used + paged_waste):.1%}), "
          f"contiguous max_len waste {contiguous_waste} ({contiguous_waste / (MAX_LEN * len(lengths)):.1%})")
    assert paged_waste <= (BS - 1) * len(lengths) < contiguous_waste
    for seq_id in range(len(lengths)):
        bm.free(seq_id)
    assert bm.num_free() == 2048
    check_invariants(bm)
    print("PASS")
`,
    },
  },
  debrief: `This is the virtual-memory idea applied to the KV cache. Before vLLM, servers reserved one contiguous buffer per request sized for the longest output it might produce, so a request that stopped after 50 tokens of a 2,048-token reservation wasted 97% of it, and the gaps between buffers fragmented what was left; the PagedAttention paper measured earlier systems keeping real token states in only 20.4% to 38.2% of their KV memory. With blocks, a sequence owns \`ceil(len / block_size)\` of them and wastes only the tail of the last one, under one block, whatever its final length. The indirection costs one table lookup per position, which step 2 pays in the gather. Reference counts are what make sharing safe: a forked sequence (parallel sampling, beam search) or a second request with the same prefix points at the same physical blocks, and copy-on-write splits a block only when someone writes into a shared, partly filled one, never into a full one. Freeing last block first is a small choice with a large effect later: the tail of a prompt is the least likely to be reused, so it should be the first evicted. Production vLLM uses 16-token blocks by default and sizes the pool by profiling the GPU memory left after weights and activations. Its v0 manager could also swap a preempted sequence's blocks to CPU memory; v1 keeps every \`KVCacheBlock\` object in a preallocated pool with an intrusive doubly linked free queue, so taking a cached block out of the middle of the queue is O(1).`,
};
