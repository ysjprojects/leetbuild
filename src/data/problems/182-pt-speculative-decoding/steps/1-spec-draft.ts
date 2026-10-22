import type {Step} from '@/lib/types';

export const specDraftStep: Step = {
  id: 'spec-draft',
  title: 'A rewindable KV cache and the draft loop',
  concept: 'pytorch',
  file: 'spec_draft',
  focus: ['context', 'draft-fwd', 'draft-sample', 'dcache-before', 'dcache-drafted'],
  task: `## Task

Write the model both sides of speculative decoding run: a tiny GPT whose KV cache can be **rewound**, and
the loop that lets the small one propose \`gamma\` tokens. No \`F.scaled_dot_product_attention\`, no
\`torch.cat\` onto the cache.

- \`KVCache(config, batch_size=1, dtype=torch.float32)\`: \`k\` and \`v\` preallocated with \`torch.zeros\` to
  \`(n_layer, batch_size, n_head, block_size, head_dim)\`, and \`pos = 0\`, the number of valid positions.
- \`KVCache.truncate(n)\`: assert \`0 <= n <= pos\`, then \`self.pos = n\`. Rows past \`n\` stay in memory; the
  next forward overwrites them and nothing reads them before that.
- \`CausalSelfAttention.forward(x, cache, layer, pos)\`: \`x\` is \`(B, T, C)\` at positions \`pos … pos + T − 1\`.
  With a cache, write the new keys and values to \`cache.k[layer, :B, :, pos : pos + T]\` (and \`v\`), then
  attend over \`cache.k[layer, :B, :, : pos + T]\`. Query \`i\` sees keys \`0 … pos + i\`:
  \`torch.ones(T, pos + T, dtype=torch.bool).tril(diagonal=pos)\`, \`masked_fill\` with \`float("-inf")\`.
- \`TinyLM.forward(idx (B, T) long, cache=None) -> logits (B, T, V)\`: positions \`torch.arange(pos, pos + T)\`
  with \`pos = cache.pos\` (0 without a cache), every block with its layer index, then \`cache.pos = pos + T\`.
- \`to_probs(logits, temperature)\`: \`F.softmax(logits / temperature, dim=-1)\`; at \`temperature == 0\`, a
  one-hot on the argmax (\`F.one_hot\`), so greedy decoding is the same code with a degenerate distribution.
- \`@torch.no_grad() draft_tokens(draft, cache, last_token, gamma, temperature=1.0, generator=None)\`: the
  cache holds everything before \`last_token\`. \`for i in range(gamma)\`: feed one token, take the last
  logits, \`q[i] = to_probs(…)\`, draw the next token with \`torch.multinomial(q[i], 1, generator=generator)\`,
  feed it next. Returns \`tokens (gamma,) long\` and \`q (gamma, V)\`; the cache ends \`gamma\` positions on
  (the last proposal is never fed).
- \`markov_corpus\` and \`fit\` are given: step 3 trains a target and a draft on the same order-2 Markov
  chain so they have something to agree on.

The self-test (float64, \`LMConfig(16, 32, 2, 2, 32)\`) checks that 20 one-token cached forwards and a
7 / 9 / 4 chunked prefill both equal the full forward to 1e-10; that \`truncate(12)\` followed by 5 other
tokens gives the logits of a fresh forward over that sequence, and \`truncate(0)\` restarts cleanly; and
that \`draft_tokens\` at temperatures 1.0, 0.7 and 0 returns the distributions and tokens of a reference
loop of full forwards drawing from the same generator, with the cache \`gamma\` positions on. It prints
\`PASS\`.

> Speculation guesses, and guesses are undone. Undoing costs nothing only if the cache is a
> preallocated buffer with a length: rewinding is one integer.`,
  hints: [
    'Without a cache, the same code runs with `pos = 0` and the keys of this call only: `tril(diagonal=0)` is the usual causal mask. With a cache, the mask is `T` rows by `pos + T` columns, and the first `pos` columns are all visible to every row.',
    'The truncation test passes only if attention reads `[: pos + T]` and never the whole buffer: the stale rows past `pos` are still there after `truncate`, holding the old continuation.',
    '`draft_tokens` keeps a Python int `token`, starting at `last_token`: `logits = draft(torch.tensor([[token]]), cache)[0, -1]`, `q[i] = to_probs(logits, temperature)`, `token = int(torch.multinomial(q[i], 1, generator=generator))`. A one-hot `q` makes `multinomial` return the argmax.',
  ],
  checks: [
    {
      id: 'cache-prealloc',
      title: 'Preallocated cache, written in place',
      detail:
        '`torch.zeros` buffers of `block_size` positions; new keys and values are assigned into the slice `pos : pos + T`. Growing the cache with `torch.cat` would make every rollback a copy.',
      match: {
        python: {
          all: [
            /torch\.zeros\(/,
            /\.k\[[^\]\n]*:\s*\w+\s*\+\s*\w+\s*\]\s*=/,
            /\.v\[[^\]\n]*:\s*\w+\s*\+\s*\w+\s*\]\s*=/,
          ],
          none: [/torch\.cat\(\s*[([]\s*(?:\w+\.)?[kv]\b/],
        },
      },
    },
    {
      id: 'read-prefix',
      title: 'Attention reads only the valid prefix',
      detail:
        'Keys and values are read as `cache.k[…, : pos + T]`: rows past the cache length are stale after a `truncate` and must never be attended to.',
      match: {
        python: {
          all: [/=\s*\w+\.k\[[^\]\n]*:\s*\w+\s*\+\s*\w+\s*\]/, /=\s*\w+\.v\[[^\]\n]*:\s*\w+\s*\+\s*\w+\s*\]/],
        },
      },
    },
    {
      id: 'truncate',
      title: 'truncate(n) moves the length, copies nothing',
      detail:
        '`truncate(n)` sets `self.pos = n`: rejected positions are not cleared, they are simply past the end and get overwritten by the next forward.',
      match: {
        python: {
          all: [/def truncate\(\s*self\s*,\s*(\w+)[^)]*\)[^\n]*:(?:\n[^\n]*)*?\n[ \t]+self\.pos\s*=\s*\1\b/],
        },
      },
    },
    {
      id: 'positions',
      title: 'Positions continue from the cache',
      detail:
        'New tokens are embedded at `torch.arange(pos, pos + T)` and the cache length advances by `T`; starting at 0 would give every drafted token position 0.',
      match: {python: {all: [/torch\.arange\(\s*\w+\s*,\s*\w+\s*\+\s*\w+\s*\)/, /cache\.pos\s*\+?=(?!=)/]}},
    },
    {
      id: 'offset-mask',
      title: 'Causal mask offset by the cached length',
      detail:
        'A `T × (pos + T)` mask with `tril(diagonal=pos)`, filled with `-inf`: query `i` sits at position `pos + i`. Written by hand, not `F.scaled_dot_product_attention`.',
      match: {
        python: {
          all: [/tril\([^)\n]*diagonal\s*=\s*\w+|triu\([^)\n]*diagonal\s*=\s*\w+\s*\+\s*1/, /masked_fill\(/],
          none: [/scaled_dot_product_attention/],
        },
      },
    },
    {
      id: 'greedy-onehot',
      title: 'Temperature scales; zero is a one-hot',
      detail:
        '`to_probs` divides the logits by `temperature` before the softmax and returns a one-hot on the argmax at `temperature == 0`, so the greedy path reuses the sampling code.',
      match: {python: {all: [/\/\s*temperature/, /one_hot\(|\.scatter_?\(/]}},
    },
    {
      id: 'draft-loop',
      title: 'One draft forward per proposal, no graph',
      detail: '`draft_tokens` is `@torch.no_grad()` and runs `for … in range(gamma)`, one forward of one token each.',
      match: {
        python: {
          all: [
            /@torch\.(?:no_grad|inference_mode)\(\)\s*\ndef draft_tokens\(/,
            /for\s+\w+\s+in\s+range\(\s*gamma\s*\)/,
          ],
        },
      },
    },
    {
      id: 'draft-sample',
      title: 'Each proposal is drawn from q with the caller’s generator',
      detail:
        '`torch.multinomial(q_i, 1, generator=generator)` after `to_probs`: verification needs the exact `q_i` each token came from, and a seeded generator makes runs reproducible.',
      match: {
        python: {
          all: [/torch\.multinomial\([^\n]*generator\s*=\s*generator/],
          order: [/def draft_tokens\(/, /to_probs\(|F\.softmax\(/, /torch\.multinomial\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Speculative decoding, part 1: a tiny causal LM with a rewindable KV cache, and the draft loop."""

import bisect
import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class LMConfig:
    vocab_size: int = 16
    block_size: int = 64
    n_layer: int = 2
    n_head: int = 2
    n_embd: int = 32


class KVCache:
    """Keys and values of every layer for batch row(s) 0..B-1, preallocated to block_size positions.

    Rows [0, pos) are valid. truncate(n) rewinds to n positions: rows past n stay in memory but are
    never read again, and the next forward overwrites them.
    """

    def __init__(self, config: LMConfig, batch_size: int = 1, dtype: torch.dtype = torch.float32):
        # TODO: self.k and self.v of shape (n_layer, batch_size, n_head, block_size, head_dim); self.pos = 0.
        raise NotImplementedError("TODO: preallocate the cache")

    def truncate(self, n: int) -> None:
        # TODO: keep the first n positions. Nothing is copied or cleared.
        raise NotImplementedError("TODO: rewind the cache")


class CausalSelfAttention(nn.Module):
    def __init__(self, config: LMConfig):
        super().__init__()
        self.n_head = config.n_head
        self.qkv = nn.Linear(config.n_embd, 3 * config.n_embd)
        self.proj = nn.Linear(config.n_embd, config.n_embd)

    def forward(self, x: torch.Tensor, cache: KVCache | None, layer: int, pos: int) -> torch.Tensor:
        """x (B, T, C) holds positions pos .. pos + T - 1. Without a cache, pos is 0 and T is the whole sequence."""
        # TODO: q, k, v from self.qkv, split into heads. With a cache, write k and v at positions
        # pos .. pos + T - 1 of layer \`layer\` and attend over the first pos + T positions. The mask lets
        # query i (position pos + i) see keys 0 .. pos + i. Then self.proj.
        raise NotImplementedError("TODO: cached causal attention")


class Block(nn.Module):
    def __init__(self, config: LMConfig):
        super().__init__()
        self.ln1 = nn.LayerNorm(config.n_embd)
        self.attn = CausalSelfAttention(config)
        self.ln2 = nn.LayerNorm(config.n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(config.n_embd, 4 * config.n_embd), nn.GELU(), nn.Linear(4 * config.n_embd, config.n_embd)
        )

    def forward(self, x: torch.Tensor, cache: KVCache | None, layer: int, pos: int) -> torch.Tensor:
        x = x + self.attn(self.ln1(x), cache, layer, pos)
        return x + self.mlp(self.ln2(x))


class TinyLM(nn.Module):
    """A pre-norm GPT: token and learned position embeddings, n_layer blocks, LayerNorm, vocabulary head."""

    def __init__(self, config: LMConfig):
        super().__init__()
        self.config = config
        self.wte = nn.Embedding(config.vocab_size, config.n_embd)
        self.wpe = nn.Embedding(config.block_size, config.n_embd)
        self.blocks = nn.ModuleList(Block(config) for _ in range(config.n_layer))
        self.ln_f = nn.LayerNorm(config.n_embd)
        self.head = nn.Linear(config.n_embd, config.vocab_size, bias=False)

    def forward(self, idx: torch.Tensor, cache: KVCache | None = None) -> torch.Tensor:
        """idx (B, T) long -> logits (B, T, V). With a cache, idx holds the positions cache.pos .. cache.pos + T - 1."""
        # TODO: positions start at cache.pos (0 without a cache); embed, run every block with its layer
        # index, advance the cache by T, then ln_f and head.
        raise NotImplementedError("TODO: forward with a cache")


def to_probs(logits: torch.Tensor, temperature: float) -> torch.Tensor:
    """Logits (..., V) -> a distribution (..., V). temperature == 0 is greedy: a one-hot on the argmax."""
    raise NotImplementedError("TODO: temperature softmax, one-hot at 0")


# TODO: no autograd graph while drafting.
def draft_tokens(
    draft: TinyLM,
    cache: KVCache,
    last_token: int,
    gamma: int,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Propose gamma tokens after last_token, one draft forward each.

    The cache holds every position before last_token. Returns tokens (gamma,) long and q (gamma, V),
    row i the distribution token i was drawn from. The cache ends gamma positions further on:
    last_token and the first gamma - 1 proposals are in it, the last proposal is not.
    """
    # TODO: feed one token, read the last logits, record q_i, draw the next token from q_i with the
    # generator, feed that token next.
    raise NotImplementedError("TODO: the draft loop")


def markov_corpus(vocab_size: int, length: int, seed: int = 0, sharpness: float = 3.0) -> torch.Tensor:
    """A token stream from a random order-2 Markov chain: something for two small models to agree on."""
    g = torch.Generator().manual_seed(seed)
    table = F.softmax(torch.randn(vocab_size, vocab_size, vocab_size, generator=g) * sharpness, dim=-1)
    cdf = table.cumsum(dim=-1).tolist()
    u = torch.rand(length, generator=g).tolist()
    out = [0, 1]
    for t in range(2, length):
        row = cdf[out[-2]][out[-1]]
        out.append(min(bisect.bisect(row, u[t]), vocab_size - 1))
    return torch.tensor(out)


def fit(model: TinyLM, data: torch.Tensor, steps: int, batch_size: int = 32, seq_len: int = 32, lr: float = 3e-3) -> float:
    """AdamW on random windows of data, next-token cross-entropy. Returns the last loss."""
    g = torch.Generator().manual_seed(0)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.0)
    model.train()
    for _ in range(steps):
        ix = torch.randint(len(data) - seq_len - 1, (batch_size,), generator=g).tolist()
        x = torch.stack([data[i : i + seq_len] for i in ix])
        y = torch.stack([data[i + 1 : i + 1 + seq_len] for i in ix])
        loss = F.cross_entropy(model(x).flatten(0, 1), y.flatten())
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    model.eval()
    return loss.item()


if __name__ == "__main__":
    torch.manual_seed(0)
    config = LMConfig(vocab_size=16, block_size=32, n_layer=2, n_head=2, n_embd=32)
    model = TinyLM(config).double().eval()  # float64: cached and full logits agree to ~1e-15
    seq = torch.randint(16, (1, 20))

    with torch.no_grad():
        full = model(seq)

        # One token at a time through the cache reproduces the full forward.
        cache = KVCache(config, dtype=torch.float64)
        steps = torch.cat([model(seq[:, t : t + 1], cache) for t in range(20)], dim=1)
        assert torch.allclose(steps, full, atol=1e-10) and cache.pos == 20
        # So do uneven chunks: a prefill of 7, then 9, then 4.
        cache = KVCache(config, dtype=torch.float64)
        chunks = torch.cat([model(seq[:, a:b], cache) for a, b in [(0, 7), (7, 16), (16, 20)]], dim=1)
        assert torch.allclose(chunks, full, atol=1e-10)

        # truncate(12) then a different continuation: the same logits as a fresh forward of that sequence.
        other = torch.randint(16, (1, 5))
        cache.truncate(12)
        assert cache.pos == 12
        rewound = model(other, cache)
        fresh = model(torch.cat([seq[:, :12], other], dim=1))[:, 12:]
        assert torch.allclose(rewound, fresh, atol=1e-10) and cache.pos == 17
        cache.truncate(0)
        assert torch.allclose(model(seq[:, :4], cache), full[:, :4], atol=1e-10)

    # draft_tokens: q is the model's own distribution after each proposed prefix; the cache moves gamma.
    prefix = seq[0, :8].tolist()
    for temperature in (1.0, 0.7, 0.0):
        cache = KVCache(config, dtype=torch.float64)
        with torch.no_grad():
            model(torch.tensor([prefix[:-1]]), cache)
        gen = torch.Generator().manual_seed(1)
        tokens, q = draft_tokens(model, cache, prefix[-1], 5, temperature, gen)
        assert tokens.shape == (5,) and tokens.dtype == torch.long and q.shape == (5, 16)
        assert cache.pos == len(prefix) + 4
        assert torch.allclose(q.sum(dim=-1), torch.ones(5, dtype=torch.float64))
        # Reference: full forwards, the same generator draws.
        gen = torch.Generator().manual_seed(1)
        ctx = list(prefix)
        for i in range(5):
            with torch.no_grad():
                ref_q = to_probs(model(torch.tensor([ctx]))[0, -1], temperature)
            assert torch.allclose(q[i], ref_q, atol=1e-10), (temperature, i)
            ctx.append(int(torch.multinomial(ref_q, 1, generator=gen)))
            assert ctx[-1] == int(tokens[i]), (temperature, i)
        if temperature == 0:
            assert torch.equal(q.max(dim=-1).values, torch.ones(5, dtype=torch.float64))

    print("PASS")
`,
      solution: `"""Speculative decoding, part 1: a tiny causal LM with a rewindable KV cache, and the draft loop."""

import bisect
import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class LMConfig:
    vocab_size: int = 16
    block_size: int = 64
    n_layer: int = 2
    n_head: int = 2
    n_embd: int = 32


class KVCache:
    """Keys and values of every layer for batch row(s) 0..B-1, preallocated to block_size positions.

    Rows [0, pos) are valid. truncate(n) rewinds to n positions: rows past n stay in memory but are
    never read again, and the next forward overwrites them.
    """

    def __init__(self, config: LMConfig, batch_size: int = 1, dtype: torch.dtype = torch.float32):
        hd = config.n_embd // config.n_head
        shape = (config.n_layer, batch_size, config.n_head, config.block_size, hd)
        self.k = torch.zeros(shape, dtype=dtype)
        self.v = torch.zeros(shape, dtype=dtype)
        self.pos = 0

    def truncate(self, n: int) -> None:
        assert 0 <= n <= self.pos, (n, self.pos)
        self.pos = n


class CausalSelfAttention(nn.Module):
    def __init__(self, config: LMConfig):
        super().__init__()
        self.n_head = config.n_head
        self.qkv = nn.Linear(config.n_embd, 3 * config.n_embd)
        self.proj = nn.Linear(config.n_embd, config.n_embd)

    def forward(self, x: torch.Tensor, cache: KVCache | None, layer: int, pos: int) -> torch.Tensor:
        B, T, C = x.shape
        hd = C // self.n_head
        q, k, v = self.qkv(x).split(C, dim=2)
        q = q.view(B, T, self.n_head, hd).transpose(1, 2)
        k = k.view(B, T, self.n_head, hd).transpose(1, 2)
        v = v.view(B, T, self.n_head, hd).transpose(1, 2)
        if cache is not None:
            cache.k[layer, :B, :, pos : pos + T] = k
            cache.v[layer, :B, :, pos : pos + T] = v
            k = cache.k[layer, :B, :, : pos + T]
            v = cache.v[layer, :B, :, : pos + T]
        att = (q @ k.transpose(-2, -1)) / math.sqrt(hd)
        # Query i sits at absolute position pos + i and sees keys 0 .. pos + i.
        mask = torch.ones(T, pos + T, dtype=torch.bool).tril(diagonal=pos)
        att = att.masked_fill(~mask, float("-inf"))
        y = F.softmax(att, dim=-1) @ v
        return self.proj(y.transpose(1, 2).reshape(B, T, C))


class Block(nn.Module):
    def __init__(self, config: LMConfig):
        super().__init__()
        self.ln1 = nn.LayerNorm(config.n_embd)
        self.attn = CausalSelfAttention(config)
        self.ln2 = nn.LayerNorm(config.n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(config.n_embd, 4 * config.n_embd), nn.GELU(), nn.Linear(4 * config.n_embd, config.n_embd)
        )

    def forward(self, x: torch.Tensor, cache: KVCache | None, layer: int, pos: int) -> torch.Tensor:
        x = x + self.attn(self.ln1(x), cache, layer, pos)
        return x + self.mlp(self.ln2(x))


class TinyLM(nn.Module):
    """A pre-norm GPT: token and learned position embeddings, n_layer blocks, LayerNorm, vocabulary head."""

    def __init__(self, config: LMConfig):
        super().__init__()
        self.config = config
        self.wte = nn.Embedding(config.vocab_size, config.n_embd)
        self.wpe = nn.Embedding(config.block_size, config.n_embd)
        self.blocks = nn.ModuleList(Block(config) for _ in range(config.n_layer))
        self.ln_f = nn.LayerNorm(config.n_embd)
        self.head = nn.Linear(config.n_embd, config.vocab_size, bias=False)

    def forward(self, idx: torch.Tensor, cache: KVCache | None = None) -> torch.Tensor:
        """idx (B, T) long -> logits (B, T, V). With a cache, idx holds the positions cache.pos .. cache.pos + T - 1."""
        B, T = idx.shape
        pos = 0 if cache is None else cache.pos
        assert pos + T <= self.config.block_size, "past block_size"
        x = self.wte(idx) + self.wpe(torch.arange(pos, pos + T))
        for layer, block in enumerate(self.blocks):
            x = block(x, cache, layer, pos)
        if cache is not None:
            cache.pos = pos + T
        return self.head(self.ln_f(x))


def to_probs(logits: torch.Tensor, temperature: float) -> torch.Tensor:
    """Logits (..., V) -> a distribution (..., V). temperature == 0 is greedy: a one-hot on the argmax."""
    if temperature == 0:
        return F.one_hot(logits.argmax(dim=-1), logits.size(-1)).to(logits.dtype)
    return F.softmax(logits / temperature, dim=-1)


@torch.no_grad()
def draft_tokens(
    draft: TinyLM,
    cache: KVCache,
    last_token: int,
    gamma: int,
    temperature: float = 1.0,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Propose gamma tokens after last_token, one draft forward each.

    The cache holds every position before last_token. Returns tokens (gamma,) long and q (gamma, V),
    row i the distribution token i was drawn from. The cache ends gamma positions further on:
    last_token and the first gamma - 1 proposals are in it, the last proposal is not.
    """
    tokens = torch.empty(gamma, dtype=torch.long)
    q = torch.empty(gamma, draft.config.vocab_size, dtype=cache.k.dtype)
    token = last_token
    for i in range(gamma):
        logits = draft(torch.tensor([[token]]), cache)[0, -1]
        q[i] = to_probs(logits, temperature)
        token = int(torch.multinomial(q[i], 1, generator=generator))
        tokens[i] = token
    return tokens, q


def markov_corpus(vocab_size: int, length: int, seed: int = 0, sharpness: float = 3.0) -> torch.Tensor:
    """A token stream from a random order-2 Markov chain: something for two small models to agree on."""
    g = torch.Generator().manual_seed(seed)
    table = F.softmax(torch.randn(vocab_size, vocab_size, vocab_size, generator=g) * sharpness, dim=-1)
    cdf = table.cumsum(dim=-1).tolist()
    u = torch.rand(length, generator=g).tolist()
    out = [0, 1]
    for t in range(2, length):
        row = cdf[out[-2]][out[-1]]
        out.append(min(bisect.bisect(row, u[t]), vocab_size - 1))
    return torch.tensor(out)


def fit(model: TinyLM, data: torch.Tensor, steps: int, batch_size: int = 32, seq_len: int = 32, lr: float = 3e-3) -> float:
    """AdamW on random windows of data, next-token cross-entropy. Returns the last loss."""
    g = torch.Generator().manual_seed(0)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.0)
    model.train()
    for _ in range(steps):
        ix = torch.randint(len(data) - seq_len - 1, (batch_size,), generator=g).tolist()
        x = torch.stack([data[i : i + seq_len] for i in ix])
        y = torch.stack([data[i + 1 : i + 1 + seq_len] for i in ix])
        loss = F.cross_entropy(model(x).flatten(0, 1), y.flatten())
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    model.eval()
    return loss.item()


if __name__ == "__main__":
    torch.manual_seed(0)
    config = LMConfig(vocab_size=16, block_size=32, n_layer=2, n_head=2, n_embd=32)
    model = TinyLM(config).double().eval()  # float64: cached and full logits agree to ~1e-15
    seq = torch.randint(16, (1, 20))

    with torch.no_grad():
        full = model(seq)

        # One token at a time through the cache reproduces the full forward.
        cache = KVCache(config, dtype=torch.float64)
        steps = torch.cat([model(seq[:, t : t + 1], cache) for t in range(20)], dim=1)
        assert torch.allclose(steps, full, atol=1e-10) and cache.pos == 20
        # So do uneven chunks: a prefill of 7, then 9, then 4.
        cache = KVCache(config, dtype=torch.float64)
        chunks = torch.cat([model(seq[:, a:b], cache) for a, b in [(0, 7), (7, 16), (16, 20)]], dim=1)
        assert torch.allclose(chunks, full, atol=1e-10)

        # truncate(12) then a different continuation: the same logits as a fresh forward of that sequence.
        other = torch.randint(16, (1, 5))
        cache.truncate(12)
        assert cache.pos == 12
        rewound = model(other, cache)
        fresh = model(torch.cat([seq[:, :12], other], dim=1))[:, 12:]
        assert torch.allclose(rewound, fresh, atol=1e-10) and cache.pos == 17
        cache.truncate(0)
        assert torch.allclose(model(seq[:, :4], cache), full[:, :4], atol=1e-10)

    # draft_tokens: q is the model's own distribution after each proposed prefix; the cache moves gamma.
    prefix = seq[0, :8].tolist()
    for temperature in (1.0, 0.7, 0.0):
        cache = KVCache(config, dtype=torch.float64)
        with torch.no_grad():
            model(torch.tensor([prefix[:-1]]), cache)
        gen = torch.Generator().manual_seed(1)
        tokens, q = draft_tokens(model, cache, prefix[-1], 5, temperature, gen)
        assert tokens.shape == (5,) and tokens.dtype == torch.long and q.shape == (5, 16)
        assert cache.pos == len(prefix) + 4
        assert torch.allclose(q.sum(dim=-1), torch.ones(5, dtype=torch.float64))
        # Reference: full forwards, the same generator draws.
        gen = torch.Generator().manual_seed(1)
        ctx = list(prefix)
        for i in range(5):
            with torch.no_grad():
                ref_q = to_probs(model(torch.tensor([ctx]))[0, -1], temperature)
            assert torch.allclose(q[i], ref_q, atol=1e-10), (temperature, i)
            ctx.append(int(torch.multinomial(ref_q, 1, generator=gen)))
            assert ctx[-1] == int(tokens[i]), (temperature, i)
        if temperature == 0:
            assert torch.equal(q.max(dim=-1).values, torch.ones(5, dtype=torch.float64))

    print("PASS")
`,
    },
  },
  debrief: `The draft side is ordinary decoding with one addition: a cache that can go backwards. Every round that rejects a draft has to undo it, in both models, so the rollback has to be free. A preallocated buffer plus a length makes it one integer assignment; the rows past \`pos\` are dead weight until the next forward overwrites them, and the \`[: pos + T]\` slice is what guarantees nobody reads them. The offset mask, \`tril(diagonal=pos)\` over \`T × (pos + T)\`, lets one forward serve the prefill, a one-token decode step and step 3's \`gamma + 1\`-token verification pass. \`draft_tokens\` returns every \`q_i\`, not just the tokens, because the acceptance test in step 2 needs \`q_i(x_i)\` and the residual needs the whole row. Production engines face the same problem at scale: Hugging Face's assisted generation crops its \`DynamicCache\` to the accepted length, paged engines such as vLLM shorten the sequence in their block tables, and models with recurrent or sliding-window state cannot be cut back by moving a length, so they keep snapshots instead.`,
};
