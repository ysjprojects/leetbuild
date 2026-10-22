import type {Step} from '@/lib/types';

export const schedulerStep: Step = {
  id: 'scheduler',
  title: 'Continuous batching: scheduler, preemption, engine',
  concept: 'pytorch',
  file: 'scheduler',
  focus: ['scheduler', 'block-manager', 'flatten', 'qkv', 'write-kv', 'paged-attn', 'sampler', 'finish'],
  task: `## Task

Write \`scheduler.py\`: Orca's iteration-level scheduling on top of steps 1 and 2. Every engine step
re-forms the batch, so a finished request leaves and a waiting one joins after one forward pass, not
after the whole batch. \`Sequence\`, the model \`TinyLM\` and \`generate\` are given.

\`Sequence(seq_id, prompt, max_tokens)\`: \`tokens\` is \`prompt + output\`; \`num_computed\` counts the leading
tokens whose KV is in the cache. Every step computes \`tokens[num_computed:]\`: the whole prompt in a prefill,
the last sampled token in a decode.

\`Scheduler(block_manager, max_num_seqs=8, max_num_batched_tokens=256)\` holds \`self.bm\`, a \`deque\`
\`self.waiting\`, a list \`self.running\` (oldest first) and \`num_preemptions\`.

- \`schedule() -> ("prefill", seqs) | ("decode", seqs)\`. **Prefill first**: while a seat is free
  (\`max_num_seqs\`), the next waiting sequence fits the remaining token budget and
  \`self.bm.can_allocate(seq_id, tokens)\`, \`popleft\` it, set \`num_computed = self.bm.allocate(seq_id,
  tokens)\` and mark it running. A non-empty batch is returned as a prefill.
- Otherwise **decode** every running sequence, oldest first, reserving one slot with
  \`append_slots(seq_id, 1)\`. While \`can_append(seq_id, 1)\` fails, **preempt the newest** running sequence,
  and the sequence itself when it is the newest left. Return a copy of the new running list.
- \`preempt(seq)\` by **recompute**: \`self.bm.free\` its blocks, \`num_computed = 0\`, \`appendleft\` it to
  \`waiting\` (it was admitted before anything still waiting), count it.
- \`finish(seq)\`: out of \`running\`, blocks freed.

\`LLMEngine(model, num_blocks, block_size, eos_id=None, max_num_seqs=8, max_num_batched_tokens=256)\`
(constructor given) holds a block manager from \`make_block_manager\` (step 4 overrides it), a scheduler, and
one \`(k_cache, v_cache)\` per layer. \`step() -> list[Sequence]\` returns the sequences that finished:

- Flatten the batch: every uncomputed token of every scheduled sequence is one row, with its token, its
  position, its slot from \`self.block_manager.slot_mapping\`, its sequence's block table (through
  \`pad_block_tables\`) and \`context_len = position + 1\`. Count \`num_prefill_tokens\` / \`num_decode_tokens\`.
- Run \`self.model(tokens, positions, attn)\` where \`attn(i, q, k, v)\` calls \`write_kv\` into layer \`i\`'s
  cache **before** \`paged_attention\` (a row attends to its own key).
- Greedy sampler: the \`argmax\` of each sequence's last row.
- Per sequence: \`num_computed = len(seq)\`, call \`self.on_computed(seq)\` (a no-op hook for step 4), append
  the token, and \`self.scheduler.finish\` it when the token is \`self.eos_id\` or the output has
  \`max_tokens\` ids.

The self-test runs \`TinyLM\` (2 layers, 4 query heads over 2 KV heads, float64) on 6 prompts of 3 to 13
tokens with \`max_tokens = 16\` and an EOS id the model really emits:

- With 64 blocks of 4 the outputs equal \`dense_generate\` (one prompt at a time, a contiguous cache grown
  with \`torch.cat\`) token for token, with no preemption.
- With 12 blocks they are still identical, at least one sequence was preempted, and every block is back on
  the free list at the end. Then it prints \`PASS\`.

> The batch is rebuilt every iteration from whatever fits in memory. When memory runs out, the newest
> request gives its blocks back and recomputes them later, so the oldest always makes progress.`,
  hints: [
    'Keep one invariant: after a step, `num_computed == len(seq) - 1` (the token just sampled has no KV yet) and the block manager holds exactly `num_computed` slots. Then a prefill and a decode are the same computation over `tokens[num_computed:]`, and a recomputed sequence is just a longer prefill.',
    'The decode loop over a `deque(self.running)`: `seq = queue.popleft()`; `while not self.bm.can_append(seq.seq_id, 1): victim = queue.pop() if queue else seq; self.preempt(victim)`, stopping when the victim is `seq` itself. Python’s `while ... else` runs the `else` only when the loop was not broken: that is where the slot is reserved.',
    'Do not hand the scheduler’s own `running` list to the engine: `finish` removes from it while the engine iterates. Inside `step`, `last` is the index of each sequence’s last row in the flattened batch, so `logits[last].argmax(-1)` is the greedy sampler.',
  ],
  checks: [
    {
      id: 'prefill-first',
      title: 'Waiting sequences are admitted while blocks suffice',
      detail:
        '`schedule` takes `self.waiting` in order (`popleft`) only while `self.bm.can_allocate` holds, and runs that prefill batch before any decode: a new request waits one iteration, not a whole batch.',
      match: {python: {all: [/\.can_allocate\(/, /self\.waiting\.popleft\(\)/]}},
    },
    {
      id: 'decode-slot',
      title: 'Decode reserves one slot per running sequence',
      detail:
        'Each running sequence is checked with `can_append` and gets `append_slots(seq_id, 1)`: the slot its last sampled token’s key and value will be written to.',
      match: {python: {all: [/\.can_append\(/, /\.append_slots\([^)\n]*,\s*1\s*\)/]}},
    },
    {
      id: 'preempt-recompute',
      title: 'Out of blocks: the newest sequence is preempted by recompute',
      detail:
        'The victim is the newest running sequence (`pop()` from the end); `preempt` frees its blocks with `self.bm.free`, resets `num_computed = 0` and puts it back with `self.waiting.appendleft`.',
      match: {
        python: {
          all: [/\.pop\(\)/, /num_computed\s*=\s*0/],
          order: [/self\.bm\.free\(/, /self\.waiting\.appendleft\(/],
        },
      },
    },
    {
      id: 'flatten',
      title: 'Slots and block tables come from the block manager',
      detail:
        '`step` asks `self.block_manager.slot_mapping` for every new token’s slot and passes the tables through `pad_block_tables`: the model runner holds no memory layout of its own.',
      match: {python: {all: [/\.slot_mapping\(/, /pad_block_tables\(/]}},
    },
    {
      id: 'write-then-attend',
      title: 'Each layer writes its K/V, then attends through paged_attention',
      detail:
        '`attn` calls `write_kv` before `paged_attention`, so a token’s own key is in the cache when its row reads it; no fused attention shortcut.',
      match: {
        python: {
          order: [/write_kv\(/, /paged_attention\(/],
          none: [/scaled_dot_product_attention/, /flash_attn/, /^\s*(?:import\s+vllm|from\s+vllm)\b/m],
        },
      },
    },
    {
      id: 'finish',
      title: 'EOS or max_tokens finishes a sequence and frees its blocks',
      detail:
        'A sampled `self.eos_id`, or `max_tokens` outputs, sends the sequence to `self.scheduler.finish`, which returns its blocks the same step so a waiting request can use them.',
      match: {python: {all: [/==\s*self\.eos_id/, /self\.scheduler\.finish\(/]}},
    },
  ],
  code: {
    python: {
      starter: `"""Continuous batching: a scheduler with preemption by recompute, and an engine that runs a tiny model on the paged cache."""

import math
from collections import deque

import torch
import torch.nn as nn

from block_manager import BlockManager
from paged_attention import allocate_kv_cache, pad_block_tables, paged_attention, write_kv

WAITING, RUNNING, FINISHED = "waiting", "running", "finished"


class Sequence:
    """One request: its prompt, its generated ids, and how many leading tokens already have KV in the cache."""

    def __init__(self, seq_id: int, prompt: list[int], max_tokens: int):
        self.seq_id = seq_id
        self.prompt = list(prompt)
        self.output: list[int] = []
        self.max_tokens = max_tokens
        self.status = WAITING
        self.num_computed = 0

    @property
    def tokens(self) -> list[int]:
        return self.prompt + self.output

    def __len__(self) -> int:
        return len(self.prompt) + len(self.output)


class Scheduler:
    """FCFS waiting queue and running list; each step is one prefill batch or one decode batch."""

    def __init__(self, block_manager: BlockManager, max_num_seqs: int = 8, max_num_batched_tokens: int = 256):
        self.bm = block_manager
        self.max_num_seqs = max_num_seqs
        self.max_num_batched_tokens = max_num_batched_tokens
        self.waiting: deque[Sequence] = deque()
        self.running: list[Sequence] = []
        self.num_preemptions = 0

    def add(self, seq: Sequence) -> None:
        self.waiting.append(seq)

    def has_work(self) -> bool:
        return bool(self.waiting or self.running)

    def schedule(self) -> tuple[str, list[Sequence]]:
        """("prefill", seqs) or ("decode", seqs); every returned sequence has slots for its uncomputed tokens."""
        # TODO: prefill first. Admit self.waiting in order while a seat is free (max_num_seqs), the prompt
        # fits the token budget (max_num_batched_tokens) and self.bm.can_allocate says yes; set
        # seq.num_computed from self.bm.allocate and move the batch to self.running.
        # TODO: otherwise decode: oldest first, reserve one slot per running sequence; while it cannot
        # append, preempt the newest running sequence (itself when it is the newest left).
        raise NotImplementedError("TODO: schedule")

    def preempt(self, seq: Sequence) -> None:
        """Recompute: drop the sequence's KV and send it back to the front of the waiting queue."""
        # TODO: free its blocks, forget its computed tokens, put it back at the front of self.waiting,
        # count the preemption.
        raise NotImplementedError("TODO: preempt by recompute")

    def finish(self, seq: Sequence) -> None:
        raise NotImplementedError("TODO: finish: status, out of running, blocks freed")


class Layer(nn.Module):
    def __init__(self, d: int, n_heads: int, n_kv_heads: int):
        super().__init__()
        self.n_heads, self.n_kv_heads, self.head_dim = n_heads, n_kv_heads, d // n_heads
        self.ln1 = nn.LayerNorm(d)
        self.q_proj = nn.Linear(d, d, bias=False)
        self.k_proj = nn.Linear(d, n_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(d, n_kv_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(d, d, bias=False)
        self.ln2 = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))


class TinyLM(nn.Module):
    """A pre-norm decoder with learned positions and GQA. Attention is whatever attn the runner passes in."""

    def __init__(self, vocab_size: int = 64, d_model: int = 32, n_layers: int = 2, n_heads: int = 4,
                 n_kv_heads: int = 2, max_positions: int = 256):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, d_model)
        self.pos = nn.Embedding(max_positions, d_model)
        self.layers = nn.ModuleList(Layer(d_model, n_heads, n_kv_heads) for _ in range(n_layers))
        self.norm = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)

    def forward(self, tokens: torch.Tensor, positions: torch.Tensor, attn) -> torch.Tensor:
        """tokens, positions [N] long (any mix of sequences); attn(layer_idx, q, k, v) -> [N, n_heads, head_dim]."""
        n = tokens.shape[0]
        x = self.embed(tokens) + self.pos(positions)
        for i, layer in enumerate(self.layers):
            h = layer.ln1(x)
            q = layer.q_proj(h).view(n, layer.n_heads, layer.head_dim)
            k = layer.k_proj(h).view(n, layer.n_kv_heads, layer.head_dim)
            v = layer.v_proj(h).view(n, layer.n_kv_heads, layer.head_dim)
            x = x + layer.o_proj(attn(i, q, k, v).reshape(n, -1))
            x = x + layer.mlp(layer.ln2(x))
        return self.head(self.norm(x))


class LLMEngine:
    """Scheduler -> block manager -> model runner (paged attention) -> greedy sampler, one batch per step."""

    def __init__(self, model: TinyLM, num_blocks: int, block_size: int, eos_id: int | None = None,
                 max_num_seqs: int = 8, max_num_batched_tokens: int = 256):
        self.model = model
        self.eos_id = eos_id
        self.block_manager = self.make_block_manager(num_blocks, block_size)
        self.scheduler = Scheduler(self.block_manager, max_num_seqs, max_num_batched_tokens)
        layer = model.layers[0]
        dtype = model.head.weight.dtype
        self.kv_caches = [allocate_kv_cache(num_blocks, block_size, layer.n_kv_heads, layer.head_dim, dtype)
                          for _ in model.layers]
        self.next_id = 0
        self.num_prefill_tokens = 0
        self.num_decode_tokens = 0

    def make_block_manager(self, num_blocks: int, block_size: int) -> BlockManager:
        return BlockManager(num_blocks, block_size)

    def add_request(self, prompt: list[int], max_tokens: int) -> Sequence:
        bs = self.block_manager.block_size
        assert -(-(len(prompt) + max_tokens) // bs) <= self.block_manager.allocator.num_blocks, "can never fit"
        seq = Sequence(self.next_id, prompt, max_tokens)
        self.next_id += 1
        self.scheduler.add(seq)
        return seq

    def on_computed(self, seq: Sequence) -> None:
        """Called once a sequence's new tokens have KV in the cache (the prefix cache hooks in here)."""

    @torch.no_grad()
    def step(self) -> list[Sequence]:
        """One scheduler batch through the model; returns the sequences that finished in this step."""
        # TODO: schedule; flatten every uncomputed token of every scheduled sequence into one row (token,
        # position, slot from self.block_manager.slot_mapping, its block table, context length position + 1);
        # count prefill and decode tokens.
        # TODO: run self.model with an attn(i, q, k, v) that writes k, v into layer i's cache, then calls
        # paged_attention; argmax of each sequence's last row.
        # TODO: per sequence: all tokens are now computed (call self.on_computed), append the new id, and
        # finish it on self.eos_id or max_tokens.
        raise NotImplementedError("TODO: one engine step")

    def generate(self, prompts: list[list[int]], max_tokens: int) -> list[list[int]]:
        seqs = [self.add_request(p, max_tokens) for p in prompts]
        while self.scheduler.has_work():
            self.step()
        return [s.output for s in seqs]


def dense_generate(model: TinyLM, prompt: list[int], max_tokens: int, eos_id: int | None) -> list[int]:
    """Reference: one prompt at a time, a contiguous per-layer KV cache grown with torch.cat."""
    ks = [None] * len(model.layers)
    vs = [None] * len(model.layers)

    def attn(i, q, k, v):
        ks[i] = k if ks[i] is None else torch.cat([ks[i], k])
        vs[i] = v if vs[i] is None else torch.cat([vs[i], v])
        n, total = q.shape[0], ks[i].shape[0]
        group = q.shape[1] // k.shape[1]
        out = torch.empty_like(q)
        for r in range(n):
            visible = total - n + r + 1  # causal: row r sits at position total - n + r
            for h in range(q.shape[1]):
                kh, vh = ks[i][:visible, h // group], vs[i][:visible, h // group]
                out[r, h] = torch.softmax(kh @ q[r, h] / math.sqrt(q.shape[2]), dim=0) @ vh
        return out

    out: list[int] = []
    with torch.no_grad():
        feed, pos = list(prompt), 0
        while len(out) < max_tokens:
            logits = model(torch.tensor(feed), torch.arange(pos, pos + len(feed)), attn)
            tok = int(logits[-1].argmax())
            out.append(tok)
            pos += len(feed)
            feed = [tok]
            if tok == eos_id:
                break
    return out


if __name__ == "__main__":
    torch.manual_seed(0)
    model = TinyLM().double().eval()
    vocab = model.embed.num_embeddings
    prompts = [torch.randint(1, vocab, (int(n),)).tolist() for n in torch.randint(3, 14, (6,))]
    MAX_TOKENS, BS = 16, 4

    # Pick an EOS id the model really emits: the third token of prompt 0's greedy continuation.
    eos = dense_generate(model, prompts[0], MAX_TOKENS, None)[2]
    expected = [dense_generate(model, p, MAX_TOKENS, eos) for p in prompts]
    assert len(expected[0]) == 3 and expected[0][-1] == eos

    # A roomy pool: everything fits, no preemption.
    engine = LLMEngine(model, num_blocks=64, block_size=BS, eos_id=eos)
    got = engine.generate(prompts, MAX_TOKENS)
    assert got == expected, (got, expected)
    assert engine.scheduler.num_preemptions == 0
    assert engine.block_manager.num_free() == 64, "every block must be freed"

    # A tight pool: 12 blocks of 4 slots for 6 sequences of up to 29 tokens forces preemption.
    engine = LLMEngine(model, num_blocks=12, block_size=BS, eos_id=eos)
    got = engine.generate(prompts, MAX_TOKENS)
    assert got == expected, (got, expected)
    assert engine.scheduler.num_preemptions > 0
    assert engine.block_manager.num_free() == 12 and engine.block_manager.block_tables == {}
    print(f"{len(prompts)} prompts, {sum(map(len, got))} tokens: identical to dense greedy decoding; "
          f"{engine.scheduler.num_preemptions} preemptions with 12 blocks; "
          f"{engine.num_prefill_tokens} prefill + {engine.num_decode_tokens} decode tokens")
    print("PASS")
`,
      solution: `"""Continuous batching: a scheduler with preemption by recompute, and an engine that runs a tiny model on the paged cache."""

import math
from collections import deque

import torch
import torch.nn as nn

from block_manager import BlockManager
from paged_attention import allocate_kv_cache, pad_block_tables, paged_attention, write_kv

WAITING, RUNNING, FINISHED = "waiting", "running", "finished"


class Sequence:
    """One request: its prompt, its generated ids, and how many leading tokens already have KV in the cache."""

    def __init__(self, seq_id: int, prompt: list[int], max_tokens: int):
        self.seq_id = seq_id
        self.prompt = list(prompt)
        self.output: list[int] = []
        self.max_tokens = max_tokens
        self.status = WAITING
        self.num_computed = 0

    @property
    def tokens(self) -> list[int]:
        return self.prompt + self.output

    def __len__(self) -> int:
        return len(self.prompt) + len(self.output)


class Scheduler:
    """FCFS waiting queue and running list; each step is one prefill batch or one decode batch."""

    def __init__(self, block_manager: BlockManager, max_num_seqs: int = 8, max_num_batched_tokens: int = 256):
        self.bm = block_manager
        self.max_num_seqs = max_num_seqs
        self.max_num_batched_tokens = max_num_batched_tokens
        self.waiting: deque[Sequence] = deque()
        self.running: list[Sequence] = []
        self.num_preemptions = 0

    def add(self, seq: Sequence) -> None:
        self.waiting.append(seq)

    def has_work(self) -> bool:
        return bool(self.waiting or self.running)

    def schedule(self) -> tuple[str, list[Sequence]]:
        """("prefill", seqs) or ("decode", seqs); every returned sequence has slots for its uncomputed tokens."""
        # Prefill first: admit waiting sequences in order while seats, the token budget and blocks allow.
        batch: list[Sequence] = []
        budget = self.max_num_batched_tokens
        while self.waiting and len(self.running) + len(batch) < self.max_num_seqs:
            seq = self.waiting[0]
            if len(seq) > budget or not self.bm.can_allocate(seq.seq_id, seq.tokens):
                break
            self.waiting.popleft()
            seq.num_computed = self.bm.allocate(seq.seq_id, seq.tokens)
            seq.status = RUNNING
            budget -= len(seq) - seq.num_computed
            batch.append(seq)
        if batch:
            self.running.extend(batch)
            return "prefill", batch

        # Decode: one slot for every running sequence, oldest first; out of blocks, preempt the newest.
        scheduled: list[Sequence] = []
        queue = deque(self.running)
        while queue:
            seq = queue.popleft()
            while not self.bm.can_append(seq.seq_id, 1):
                victim = queue.pop() if queue else seq
                self.preempt(victim)
                if victim is seq:
                    break
            else:
                self.bm.append_slots(seq.seq_id, 1)
                scheduled.append(seq)
        self.running = scheduled
        return "decode", list(scheduled)

    def preempt(self, seq: Sequence) -> None:
        """Recompute: drop the sequence's KV and send it back to the front of the waiting queue."""
        self.bm.free(seq.seq_id)
        seq.num_computed = 0
        seq.status = WAITING
        self.waiting.appendleft(seq)
        self.num_preemptions += 1

    def finish(self, seq: Sequence) -> None:
        seq.status = FINISHED
        self.running.remove(seq)
        self.bm.free(seq.seq_id)


class Layer(nn.Module):
    def __init__(self, d: int, n_heads: int, n_kv_heads: int):
        super().__init__()
        self.n_heads, self.n_kv_heads, self.head_dim = n_heads, n_kv_heads, d // n_heads
        self.ln1 = nn.LayerNorm(d)
        self.q_proj = nn.Linear(d, d, bias=False)
        self.k_proj = nn.Linear(d, n_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(d, n_kv_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(d, d, bias=False)
        self.ln2 = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))


class TinyLM(nn.Module):
    """A pre-norm decoder with learned positions and GQA. Attention is whatever attn the runner passes in."""

    def __init__(self, vocab_size: int = 64, d_model: int = 32, n_layers: int = 2, n_heads: int = 4,
                 n_kv_heads: int = 2, max_positions: int = 256):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, d_model)
        self.pos = nn.Embedding(max_positions, d_model)
        self.layers = nn.ModuleList(Layer(d_model, n_heads, n_kv_heads) for _ in range(n_layers))
        self.norm = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)

    def forward(self, tokens: torch.Tensor, positions: torch.Tensor, attn) -> torch.Tensor:
        """tokens, positions [N] long (any mix of sequences); attn(layer_idx, q, k, v) -> [N, n_heads, head_dim]."""
        n = tokens.shape[0]
        x = self.embed(tokens) + self.pos(positions)
        for i, layer in enumerate(self.layers):
            h = layer.ln1(x)
            q = layer.q_proj(h).view(n, layer.n_heads, layer.head_dim)
            k = layer.k_proj(h).view(n, layer.n_kv_heads, layer.head_dim)
            v = layer.v_proj(h).view(n, layer.n_kv_heads, layer.head_dim)
            x = x + layer.o_proj(attn(i, q, k, v).reshape(n, -1))
            x = x + layer.mlp(layer.ln2(x))
        return self.head(self.norm(x))


class LLMEngine:
    """Scheduler -> block manager -> model runner (paged attention) -> greedy sampler, one batch per step."""

    def __init__(self, model: TinyLM, num_blocks: int, block_size: int, eos_id: int | None = None,
                 max_num_seqs: int = 8, max_num_batched_tokens: int = 256):
        self.model = model
        self.eos_id = eos_id
        self.block_manager = self.make_block_manager(num_blocks, block_size)
        self.scheduler = Scheduler(self.block_manager, max_num_seqs, max_num_batched_tokens)
        layer = model.layers[0]
        dtype = model.head.weight.dtype
        self.kv_caches = [allocate_kv_cache(num_blocks, block_size, layer.n_kv_heads, layer.head_dim, dtype)
                          for _ in model.layers]
        self.next_id = 0
        self.num_prefill_tokens = 0
        self.num_decode_tokens = 0

    def make_block_manager(self, num_blocks: int, block_size: int) -> BlockManager:
        return BlockManager(num_blocks, block_size)

    def add_request(self, prompt: list[int], max_tokens: int) -> Sequence:
        bs = self.block_manager.block_size
        assert -(-(len(prompt) + max_tokens) // bs) <= self.block_manager.allocator.num_blocks, "can never fit"
        seq = Sequence(self.next_id, prompt, max_tokens)
        self.next_id += 1
        self.scheduler.add(seq)
        return seq

    def on_computed(self, seq: Sequence) -> None:
        """Called once a sequence's new tokens have KV in the cache (the prefix cache hooks in here)."""

    @torch.no_grad()
    def step(self) -> list[Sequence]:
        """One scheduler batch through the model; returns the sequences that finished in this step."""
        kind, seqs = self.scheduler.schedule()
        if not seqs:
            return []
        # Flatten the batch: every token not yet in the cache is one row.
        tokens, positions, slots, tables, ctx, last = [], [], [], [], [], []
        for seq in seqs:
            start, end = seq.num_computed, len(seq)
            tokens += seq.tokens[start:end]
            positions += list(range(start, end))
            slots += self.block_manager.slot_mapping(seq.seq_id, start, end)
            tables += [self.block_manager.block_tables[seq.seq_id]] * (end - start)
            ctx += list(range(start + 1, end + 1))
            last.append(len(tokens) - 1)
        if kind == "prefill":
            self.num_prefill_tokens += len(tokens)
        else:
            self.num_decode_tokens += len(tokens)
        slot_mapping = torch.tensor(slots, dtype=torch.long)
        block_tables = pad_block_tables(tables)
        context_lens = torch.tensor(ctx, dtype=torch.long)

        def attn(i, q, k, v):
            k_cache, v_cache = self.kv_caches[i]
            write_kv(k, v, k_cache, v_cache, slot_mapping)  # write first: a row may attend to itself
            return paged_attention(q, k_cache, v_cache, block_tables, context_lens)

        logits = self.model(torch.tensor(tokens), torch.tensor(positions), attn)
        next_ids = logits[last].argmax(dim=-1).tolist()  # greedy sampler, last row of each sequence

        finished = []
        for seq, tok in zip(seqs, next_ids):
            seq.num_computed = len(seq)
            self.on_computed(seq)
            seq.output.append(tok)
            if tok == self.eos_id or len(seq.output) >= seq.max_tokens:
                self.scheduler.finish(seq)
                finished.append(seq)
        return finished

    def generate(self, prompts: list[list[int]], max_tokens: int) -> list[list[int]]:
        seqs = [self.add_request(p, max_tokens) for p in prompts]
        while self.scheduler.has_work():
            self.step()
        return [s.output for s in seqs]


def dense_generate(model: TinyLM, prompt: list[int], max_tokens: int, eos_id: int | None) -> list[int]:
    """Reference: one prompt at a time, a contiguous per-layer KV cache grown with torch.cat."""
    ks = [None] * len(model.layers)
    vs = [None] * len(model.layers)

    def attn(i, q, k, v):
        ks[i] = k if ks[i] is None else torch.cat([ks[i], k])
        vs[i] = v if vs[i] is None else torch.cat([vs[i], v])
        n, total = q.shape[0], ks[i].shape[0]
        group = q.shape[1] // k.shape[1]
        out = torch.empty_like(q)
        for r in range(n):
            visible = total - n + r + 1  # causal: row r sits at position total - n + r
            for h in range(q.shape[1]):
                kh, vh = ks[i][:visible, h // group], vs[i][:visible, h // group]
                out[r, h] = torch.softmax(kh @ q[r, h] / math.sqrt(q.shape[2]), dim=0) @ vh
        return out

    out: list[int] = []
    with torch.no_grad():
        feed, pos = list(prompt), 0
        while len(out) < max_tokens:
            logits = model(torch.tensor(feed), torch.arange(pos, pos + len(feed)), attn)
            tok = int(logits[-1].argmax())
            out.append(tok)
            pos += len(feed)
            feed = [tok]
            if tok == eos_id:
                break
    return out


if __name__ == "__main__":
    torch.manual_seed(0)
    model = TinyLM().double().eval()
    vocab = model.embed.num_embeddings
    prompts = [torch.randint(1, vocab, (int(n),)).tolist() for n in torch.randint(3, 14, (6,))]
    MAX_TOKENS, BS = 16, 4

    # Pick an EOS id the model really emits: the third token of prompt 0's greedy continuation.
    eos = dense_generate(model, prompts[0], MAX_TOKENS, None)[2]
    expected = [dense_generate(model, p, MAX_TOKENS, eos) for p in prompts]
    assert len(expected[0]) == 3 and expected[0][-1] == eos

    # A roomy pool: everything fits, no preemption.
    engine = LLMEngine(model, num_blocks=64, block_size=BS, eos_id=eos)
    got = engine.generate(prompts, MAX_TOKENS)
    assert got == expected, (got, expected)
    assert engine.scheduler.num_preemptions == 0
    assert engine.block_manager.num_free() == 64, "every block must be freed"

    # A tight pool: 12 blocks of 4 slots for 6 sequences of up to 29 tokens forces preemption.
    engine = LLMEngine(model, num_blocks=12, block_size=BS, eos_id=eos)
    got = engine.generate(prompts, MAX_TOKENS)
    assert got == expected, (got, expected)
    assert engine.scheduler.num_preemptions > 0
    assert engine.block_manager.num_free() == 12 and engine.block_manager.block_tables == {}
    print(f"{len(prompts)} prompts, {sum(map(len, got))} tokens: identical to dense greedy decoding; "
          f"{engine.scheduler.num_preemptions} preemptions with 12 blocks; "
          f"{engine.num_prefill_tokens} prefill + {engine.num_decode_tokens} decode tokens")
    print("PASS")
`,
    },
  },
  debrief: `Static batching runs a batch until its longest member finishes, so short requests sit idle and new ones queue; Orca (OSDI 2022) schedules at the granularity of one iteration instead, and Anyscale measured 8× the throughput of static batching from that alone, 23× with vLLM's paged memory on top. Paging is what lets continuous batching be greedy: without it, admitting a request means reserving its maximum length up front. With it, the scheduler admits whatever fits now and deals with running out later, by preemption. vLLM's paper takes the same choices as this file: first come, first served; preempt the latest arrival; recover by recomputation (the prompt plus the tokens generated so far become one prefill, which is cheap because a prefill is parallel) or by swapping blocks to CPU memory. The \`num_computed\` invariant is the v1 design: there is no prefill or decode state, only how many tokens of each request have KV in the cache, so recomputation, prefix caching and chunked prefill all reduce to "compute \`tokens[num_computed:]\`". The outputs equal sequential decoding exactly because the arithmetic is the same per row; on a GPU, batch-dependent kernels make that only approximately true. Production adds chunked prefill that mixes prefill chunks into decode batches under one token budget, a watermark of free blocks before admitting, sampling parameters per request, CUDA graphs for the decode step, and asynchronous output processing so the CPU's scheduling overlaps the GPU's forward pass.`,
};
