import type {Step} from '@/lib/types';

export const gpt2GenerateStep: Step = {
  id: 'gpt2-generate',
  title: 'Generation: temperature, top-k, nucleus and a KV cache',
  concept: 'pytorch',
  file: 'gpt2_generate',
  focus: ['tokens', 'wte', 'wpe', 'attn', 'head'],
  task: `## Task

Sample from the step-1 model (\`from gpt2_model import GPT, GPTConfig, CausalSelfAttention\`), first by
re-running the whole context for every token, then with a per-block KV cache that produces the
**same tokens** for the same seed. No \`F.scaled_dot_product_attention\`, no \`argmax\` decoding path.

- \`filter_logits(logits, temperature=1.0, top_k=None, top_p=None)\`: \`logits\` is \`(B, V)\`; divide by
  \`temperature\` (assert \`> 0\`); top-k sets everything below the k-th largest (\`torch.topk\`) to \`-inf\`;
  top-p sorts descending, takes \`torch.cumsum\` of the softmax and drops a token when the mass **before**
  it already exceeds \`top_p\` (the crossing token stays), then \`scatter\`s back to vocabulary order.
- \`sample_next(logits, temperature, top_k, top_p) -> (B, 1)\`: \`F.softmax\` of the filtered logits, then
  \`torch.multinomial(probs, num_samples=1)\`.
- \`@torch.no_grad() generate(model, idx, max_new_tokens, temperature=1.0, top_k=None, top_p=None)\`:
  \`max_new_tokens\` times: crop to \`idx[:, -block_size:]\` once longer than \`block_size\`, run the model,
  take \`logits[:, -1, :]\`, sample, \`torch.cat\` onto \`idx\`. Returns \`(B, T + max_new_tokens)\`.
- \`KVCache(config, batch_size, device, dtype)\`: \`k\` and \`v\` preallocated with \`torch.zeros\` to
  \`(n_layer, B, n_head, block_size, hd)\`, \`pos = 0\`; \`nbytes()\` reports both.
- \`attn_cached(attn, x, k_cache, v_cache, pos)\`: \`x\` is \`(B, T, C)\` for positions \`pos … pos + T − 1\`;
  the module's own \`c_attn\`, write the new keys and values to \`k_cache[:, :, pos : pos + T]\`, attend over
  \`[:, :, : pos + T]\` with mask rows \`attn.mask[:, :, pos : pos + T, : pos + T]\`, then \`c_proj\`.
- \`forward_cached(model, idx, cache) -> (B, V)\`: embeddings at \`torch.arange(pos, pos + T)\`, each block
  through \`attn_cached\` and its MLP, \`cache.pos += T\`, the logits of the last position only.
- \`@torch.no_grad() generate_cached(…)\` with \`generate\`'s signature: prefill with the prompt's last
  \`block_size\` tokens, then feed only the sampled token \`forward_cached(model, idx_next, cache)\`; when
  \`cache.pos == block_size\` the learned positions are exhausted — reset \`pos\` to 0 and re-encode the last
  \`block_size\` tokens, exactly what the uncached crop computes.

:::architecture
{
  "input": "prompt idx · (B, T)",
  "output": "to the tokenizer's decode",
  "items": [
    {"id": "prefill", "label": "Prefill the prompt", "kind": "attention", "sub": "forward_cached · positions 0..T−1", "detail": "The prompt's last \`block_size\` tokens at once: every block writes its k and v rows into the cache; only the last position's logits come back."},
    {"tone": "block", "repeat": "max_new_tokens ×", "label": "One decode step", "items": [
      {"id": "filter", "label": "filter_logits", "sub": "÷ temperature · top-k · top-p"},
      {"id": "sample", "label": "Sample", "sub": "softmax → multinomial → (B, 1)", "detail": "Exactly one \`torch.multinomial\` per new token, in both paths: that is what makes cached and uncached draws identical."},
      {"id": "append", "label": "Append to idx", "kind": "io", "sub": "torch.cat((idx, idx_next), 1)"},
      {"id": "decode", "label": "Decode one token", "kind": "attention", "sub": "forward_cached(idx_next) at pos", "side": {"label": "KV cache", "sub": "rows 0..pos", "detail": "\`(n_layer, B, n_head, block_size, hd)\` for k and for v; this step appends row \`pos\` and its one query attends over all \`pos + 1\` rows."}, "detail": "Skipped after the last token. When \`cache.pos == block_size\`, reset \`pos\` to 0 and re-encode the last \`block_size\` tokens."}
    ]},
    {"id": "out", "label": "Generated ids", "kind": "io", "sub": "(B, T + max_new_tokens)"}
  ]
}
:::

The self-test (float64, \`eval()\`, \`GPTConfig(32, 16, 2, 2, 16)\`) checks the filters on a known
distribution, shapes and the crop past \`block_size\`, that \`top_k=1\` ignores the seed, that the cached
prefill and one decode step match the full forward to 1e-10, that \`generate_cached\` and \`generate\` draw
identical tokens under \`torch.manual_seed(42)\` for three filter settings with 10 and 30 new tokens, and
the cache size \`2 · n_layer · B · block_size · n_embd · 8\` bytes, then prints \`PASS\`.

> Decoding is a loop of one-row matmuls: with the cache, token *t* costs one position of compute and *t*
> rows of reading keys and values — the bottleneck moves from FLOPs to memory bandwidth.`,
  hints: [
    'Top-k in two lines: `v, _ = torch.topk(logits, k)` then `logits.masked_fill(logits < v[:, [-1]], float("-inf"))`. For top-p, `remove = torch.cumsum(probs, -1) - probs > top_p` on the sorted probabilities keeps the token that crosses the threshold; `torch.full_like(logits, -inf).scatter(-1, sorted_idx, sorted_logits)` undoes the sort.',
    'The cached attention is the step-1 attention with offsets: queries are the T new rows, keys and values are the first `pos + T` rows of the cache, and the causal mask is the slice `mask[:, :, pos : pos + T, : pos + T]` — for a single decode token that row is all ones.',
    'Same tokens means the same random draws: call `torch.multinomial` exactly once per new token in both paths, and do not run a forward after the last token. GPT-2’s positions are a learned table of `block_size` rows, so a sliding window cannot reuse cached keys — when the cache is full, re-encode the cropped window from position 0.',
  ],
  checks: [
    {
      id: 'no-grad-crop',
      title: 'No graph, context cropped to block_size',
      detail:
        '`generate` is `@torch.no_grad()` and feeds `idx[:, -block_size:]` once the sequence outgrows the position table — the model cannot see more than `block_size` tokens.',
      match: {
        python: {
          all: [
            /@torch\.no_grad\(\)\s*\ndef generate\(/,
            /idx\[\s*:\s*,\s*-\s*(?:model\.config\.)?block_size\s*:\s*\]/,
          ],
        },
      },
    },
    {
      id: 'temperature',
      title: 'Last position, divided by temperature',
      detail:
        'Only `logits[:, -1, :]` predicts the next token; dividing by `temperature` before the softmax sharpens (`< 1`) or flattens (`> 1`) the distribution.',
      match: {python: {all: [/logits\[\s*:\s*,\s*-1\s*,\s*:\s*\]/, /logits\s*\/\s*temperature/]}},
    },
    {
      id: 'top-k',
      title: 'Top-k masks the tail to −inf',
      detail:
        '`torch.topk` gives the k-th largest logit; everything below it is `masked_fill`ed with `float("-inf")` so its probability after the softmax is exactly zero.',
      match: {python: {all: [/torch\.topk\(/, /masked_fill\([^\n]*float\("-inf"\)/]}},
    },
    {
      id: 'nucleus',
      title: 'Nucleus sampling over the sorted cumulative mass',
      detail:
        'Logits are `torch.sort`ed with `descending=True`, the softmax is accumulated with `torch.cumsum`, tokens beyond `top_p` are removed and the result is `scatter`ed back to vocabulary order.',
      match: {python: {all: [/torch\.sort\([^\n]*descending\s*=\s*True/, /torch\.cumsum\(/, /\.scatter\(/]}},
    },
    {
      id: 'multinomial',
      title: 'Sample with torch.multinomial, not argmax',
      detail:
        '`F.softmax` of the filtered logits, then `torch.multinomial(probs, num_samples=1)`; greedy decoding is `top_k=1`, not a separate `argmax` path.',
      match: {
        python: {all: [/torch\.multinomial\(/], order: [/F\.softmax\(/, /torch\.multinomial\(/], none: [/\.argmax\(/]},
      },
    },
    {
      id: 'kv-write',
      title: 'Preallocated cache, written at pos, read up to pos + T',
      detail:
        '`torch.zeros` buffers of `block_size` rows per block; new keys go to `k_cache[:, :, pos : pos + T]` (values likewise) and attention reads `[:, :, : pos + T]` — no `torch.cat` reallocation per token.',
      match: {
        python: {
          all: [
            /torch\.zeros\(/,
            /k_cache\[\s*:\s*,\s*:\s*,\s*pos\s*:\s*pos\s*\+\s*T\s*\]\s*=/,
            /v_cache\[\s*:\s*,\s*:\s*,\s*pos\s*:\s*pos\s*\+\s*T\s*\]\s*=/,
            /\[\s*:\s*,\s*:\s*,\s*:\s*pos\s*\+\s*T\s*\]/,
          ],
        },
      },
    },
    {
      id: 'offset-positions',
      title: 'Positions and mask rows continue from the cache',
      detail:
        'New tokens are embedded at `torch.arange(pos, pos + T)` and masked with rows `mask[:, :, pos : pos + T, : pos + T]` — starting from 0 would give every decoded token position 0.',
      match: {
        python: {
          all: [
            /torch\.arange\(\s*pos\s*,\s*pos\s*\+\s*T/,
            /mask\[\s*:\s*,\s*:\s*,\s*pos\s*:\s*pos\s*\+\s*T\s*,\s*:\s*pos\s*\+\s*T\s*\]/,
          ],
        },
      },
    },
    {
      id: 'decode-one',
      title: 'Decode feeds one token; a full cache re-encodes the window',
      detail:
        'After the prefill only the sampled token goes in — `forward_cached(model, idx_next, cache)` — and `cache.pos == block_size` triggers a reset and re-encoding of `idx[:, -block_size:]`.',
      match: {
        python: {all: [/forward_cached\(\s*model\s*,\s*idx_next\s*,\s*cache\s*\)/, /cache\.pos\s*==\s*block_size/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Sampling from GPT-2: temperature, top-k, nucleus, the block_size crop, and a per-block KV cache."""

import math

import torch
import torch.nn.functional as F

from gpt2_model import GPT, GPTConfig, CausalSelfAttention


def filter_logits(logits: torch.Tensor, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """(B, V) last-position logits -> scaled logits with everything outside top-k / the nucleus at -inf."""
    # TODO: divide by temperature; top-k: -inf below the k-th largest; top-p: sort descending, keep the
    # smallest prefix whose mass reaches top_p (the crossing token included), scatter back.
    raise NotImplementedError("TODO")


def sample_next(logits: torch.Tensor, temperature: float, top_k: int | None, top_p: float | None) -> torch.Tensor:
    """(B, V) -> (B, 1) token ids drawn from the filtered distribution."""
    raise NotImplementedError("TODO")


# TODO: no autograd graph while sampling.
def generate(model: GPT, idx: torch.Tensor, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """Append \`max_new_tokens\` sampled ids to idx (B, T); every step re-runs the whole (cropped) context."""
    # TODO: crop to the last block_size tokens; logits of the last position; sample; append.
    raise NotImplementedError("TODO")


class KVCache:
    """Keys and values of every block, preallocated to block_size: 2 · n_layer · B · block_size · n_embd numbers."""

    def __init__(self, config: GPTConfig, batch_size: int, device, dtype):
        # TODO: self.k, self.v of shape (n_layer, B, n_head, block_size, hd); self.pos = 0.
        raise NotImplementedError("TODO")

    def nbytes(self) -> int:
        raise NotImplementedError("TODO")


def attn_cached(attn: CausalSelfAttention, x: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor, pos: int) -> torch.Tensor:
    """Attention for T new positions starting at \`pos\`: write their k, v into the cache, attend over [0, pos + T)."""
    # TODO: the module's c_attn / c_proj / mask, with rows pos .. pos + T of the causal mask.
    raise NotImplementedError("TODO")


def forward_cached(model: GPT, idx: torch.Tensor, cache: KVCache) -> torch.Tensor:
    """Run only the new tokens idx (B, T) at positions cache.pos.. ; return the last position's logits (B, V)."""
    raise NotImplementedError("TODO")


# TODO: no autograd graph while sampling.
def generate_cached(model: GPT, idx: torch.Tensor, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """Same tokens as \`generate\` (same seed, eval mode), one position of compute per new token."""
    # TODO: prefill the prompt, then decode one token at a time; when the cache is full, re-encode
    # the last block_size tokens from position 0.
    raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L = 32, 16
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=2, n_head=2, n_embd=16, dropout=0.0)
    model = GPT(config).double().eval()  # float64: cached and uncached logits agree to ~1e-15

    # Filters on a known distribution.
    probs = torch.tensor([[0.5, 0.3, 0.15, 0.05]], dtype=torch.float64)
    logits = probs.log()
    assert torch.isinf(filter_logits(logits, top_k=2)[0, 2:]).all() and torch.isfinite(filter_logits(logits, top_k=2)[0, :2]).all()
    kept = torch.isfinite(filter_logits(logits, top_p=0.7))[0].tolist()
    assert kept == [True, True, False, False], kept  # 0.5 < 0.7, 0.5 + 0.3 crosses: both stay
    kept = torch.isfinite(filter_logits(logits, top_p=0.4))[0].tolist()
    assert kept == [True, False, False, False], kept
    cold = F.softmax(filter_logits(logits, temperature=0.5), dim=-1)
    assert cold[0, 0] > 0.5 and torch.allclose(F.softmax(filter_logits(logits), dim=-1), probs)
    shuffled = torch.tensor([[0.1, 2.0, -1.0, 1.0]])
    assert torch.isfinite(filter_logits(shuffled, top_p=0.5))[0].tolist() == [False, True, False, False]

    # Shapes, the prompt kept, ids in range; the context is cropped once it outgrows block_size.
    prompt = torch.randint(V, (3, 4))
    out = generate(model, prompt, 30, temperature=0.9, top_k=10)
    assert out.shape == (3, 34) and torch.equal(out[:, :4], prompt) and int(out.max()) < V

    # top_k=1 is greedy: the same continuation whatever the seed.
    torch.manual_seed(1)
    a = generate(model, prompt, 8, top_k=1)
    torch.manual_seed(2)
    b = generate(model, prompt, 8, top_k=1)
    assert torch.equal(a, b)

    # The cache reproduces the full forward: prefill and one decode step.
    cache = KVCache(config, 3, "cpu", torch.float64)
    full, _ = model(out[:, :9])
    assert torch.allclose(forward_cached(model, out[:, :8], cache), full[:, -2], atol=1e-10)
    assert torch.allclose(forward_cached(model, out[:, 8:9], cache), full[:, -1], atol=1e-10)
    assert cache.pos == 9

    # Cached and uncached sampling draw the same tokens under the same seed — inside and past block_size.
    for kwargs in [dict(), dict(temperature=0.8, top_k=10), dict(temperature=1.2, top_p=0.9)]:
        for n_new in (10, 30):
            torch.manual_seed(42)
            ref = generate(model, prompt, n_new, **kwargs)
            torch.manual_seed(42)
            got = generate_cached(model, prompt, n_new, **kwargs)
            assert torch.equal(ref, got), (kwargs, n_new)

    # Memory: 2 (k and v) x n_layer x B x block_size x n_embd elements.
    assert cache.nbytes() == 2 * config.n_layer * 3 * L * config.n_embd * 8
    print("PASS")
`,
      solution: `"""Sampling from GPT-2: temperature, top-k, nucleus, the block_size crop, and a per-block KV cache."""

import math

import torch
import torch.nn.functional as F

from gpt2_model import GPT, GPTConfig, CausalSelfAttention


def filter_logits(logits: torch.Tensor, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """(B, V) last-position logits -> scaled logits with everything outside top-k / the nucleus at -inf."""
    assert temperature > 0, "temperature must be positive; top_k=1 is greedy decoding"
    logits = logits / temperature
    if top_k is not None:
        v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
        logits = logits.masked_fill(logits < v[:, [-1]], float("-inf"))
    if top_p is not None:
        sorted_logits, sorted_idx = torch.sort(logits, descending=True)
        probs = F.softmax(sorted_logits, dim=-1)
        # Drop a token once the mass *before* it already exceeds top_p: the token that crosses stays.
        remove = torch.cumsum(probs, dim=-1) - probs > top_p
        sorted_logits = sorted_logits.masked_fill(remove, float("-inf"))
        logits = torch.full_like(logits, float("-inf")).scatter(-1, sorted_idx, sorted_logits)
    return logits


def sample_next(logits: torch.Tensor, temperature: float, top_k: int | None, top_p: float | None) -> torch.Tensor:
    """(B, V) -> (B, 1) token ids drawn from the filtered distribution."""
    probs = F.softmax(filter_logits(logits, temperature, top_k, top_p), dim=-1)
    return torch.multinomial(probs, num_samples=1)


@torch.no_grad()
def generate(model: GPT, idx: torch.Tensor, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """Append \`max_new_tokens\` sampled ids to idx (B, T); every step re-runs the whole (cropped) context."""
    block_size = model.config.block_size
    for _ in range(max_new_tokens):
        idx_cond = idx if idx.size(1) <= block_size else idx[:, -block_size:]
        logits, _ = model(idx_cond)
        idx_next = sample_next(logits[:, -1, :], temperature, top_k, top_p)
        idx = torch.cat((idx, idx_next), dim=1)
    return idx


class KVCache:
    """Keys and values of every block, preallocated to block_size: 2 · n_layer · B · block_size · n_embd numbers."""

    def __init__(self, config: GPTConfig, batch_size: int, device, dtype):
        hd = config.n_embd // config.n_head
        shape = (config.n_layer, batch_size, config.n_head, config.block_size, hd)
        self.k = torch.zeros(shape, device=device, dtype=dtype)
        self.v = torch.zeros(shape, device=device, dtype=dtype)
        self.pos = 0  # number of positions already cached

    def nbytes(self) -> int:
        return self.k.numel() * self.k.element_size() + self.v.numel() * self.v.element_size()


def attn_cached(attn: CausalSelfAttention, x: torch.Tensor, k_cache: torch.Tensor, v_cache: torch.Tensor, pos: int) -> torch.Tensor:
    """Attention for T new positions starting at \`pos\`: write their k, v into the cache, attend over [0, pos + T)."""
    B, T, C = x.shape
    nh, hd = attn.n_head, C // attn.n_head
    q, k, v = attn.c_attn(x).split(attn.n_embd, dim=2)
    q = q.view(B, T, nh, hd).transpose(1, 2)  # (B, nh, T, hd)
    k_cache[:, :, pos : pos + T] = k.view(B, T, nh, hd).transpose(1, 2)
    v_cache[:, :, pos : pos + T] = v.view(B, T, nh, hd).transpose(1, 2)
    keys = k_cache[:, :, : pos + T]  # (B, nh, pos + T, hd)
    values = v_cache[:, :, : pos + T]
    att = (q @ keys.transpose(-2, -1)) / math.sqrt(hd)  # (B, nh, T, pos + T)
    att = att.masked_fill(~attn.mask[:, :, pos : pos + T, : pos + T], float("-inf"))
    att = F.softmax(att, dim=-1)
    y = (att @ values).transpose(1, 2).contiguous().view(B, T, C)
    return attn.c_proj(y)


def forward_cached(model: GPT, idx: torch.Tensor, cache: KVCache) -> torch.Tensor:
    """Run only the new tokens idx (B, T) at positions cache.pos.. ; return the last position's logits (B, V)."""
    B, T = idx.shape
    pos = cache.pos
    assert pos + T <= model.config.block_size
    tr = model.transformer
    x = tr.wte(idx) + tr.wpe(torch.arange(pos, pos + T, device=idx.device))
    for layer, block in enumerate(tr.h):
        x = x + attn_cached(block.attn, block.ln_1(x), cache.k[layer], cache.v[layer], pos)
        x = x + block.mlp(block.ln_2(x))
    cache.pos = pos + T
    return model.lm_head(tr.ln_f(x[:, -1, :]))


@torch.no_grad()
def generate_cached(model: GPT, idx: torch.Tensor, max_new_tokens: int, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> torch.Tensor:
    """Same tokens as \`generate\` (same seed, eval mode), one position of compute per new token."""
    block_size = model.config.block_size
    w = model.transformer.wte.weight
    cache = KVCache(model.config, idx.size(0), w.device, w.dtype)
    logits = forward_cached(model, idx[:, -block_size:], cache)  # prefill the prompt
    for i in range(max_new_tokens):
        idx_next = sample_next(logits, temperature, top_k, top_p)
        idx = torch.cat((idx, idx_next), dim=1)
        if i == max_new_tokens - 1:
            break
        if cache.pos == block_size:
            # Learned absolute positions cannot slide: the cropped window is re-encoded from position 0.
            cache.pos = 0
            logits = forward_cached(model, idx[:, -block_size:], cache)
        else:
            logits = forward_cached(model, idx_next, cache)  # decode: one token in, one row of k, v added
    return idx


if __name__ == "__main__":
    torch.manual_seed(0)
    V, L = 32, 16
    config = GPTConfig(vocab_size=V, block_size=L, n_layer=2, n_head=2, n_embd=16, dropout=0.0)
    model = GPT(config).double().eval()  # float64: cached and uncached logits agree to ~1e-15

    # Filters on a known distribution.
    probs = torch.tensor([[0.5, 0.3, 0.15, 0.05]], dtype=torch.float64)
    logits = probs.log()
    assert torch.isinf(filter_logits(logits, top_k=2)[0, 2:]).all() and torch.isfinite(filter_logits(logits, top_k=2)[0, :2]).all()
    kept = torch.isfinite(filter_logits(logits, top_p=0.7))[0].tolist()
    assert kept == [True, True, False, False], kept  # 0.5 < 0.7, 0.5 + 0.3 crosses: both stay
    kept = torch.isfinite(filter_logits(logits, top_p=0.4))[0].tolist()
    assert kept == [True, False, False, False], kept
    cold = F.softmax(filter_logits(logits, temperature=0.5), dim=-1)
    assert cold[0, 0] > 0.5 and torch.allclose(F.softmax(filter_logits(logits), dim=-1), probs)
    shuffled = torch.tensor([[0.1, 2.0, -1.0, 1.0]])
    assert torch.isfinite(filter_logits(shuffled, top_p=0.5))[0].tolist() == [False, True, False, False]

    # Shapes, the prompt kept, ids in range; the context is cropped once it outgrows block_size.
    prompt = torch.randint(V, (3, 4))
    out = generate(model, prompt, 30, temperature=0.9, top_k=10)
    assert out.shape == (3, 34) and torch.equal(out[:, :4], prompt) and int(out.max()) < V

    # top_k=1 is greedy: the same continuation whatever the seed.
    torch.manual_seed(1)
    a = generate(model, prompt, 8, top_k=1)
    torch.manual_seed(2)
    b = generate(model, prompt, 8, top_k=1)
    assert torch.equal(a, b)

    # The cache reproduces the full forward: prefill and one decode step.
    cache = KVCache(config, 3, "cpu", torch.float64)
    full, _ = model(out[:, :9])
    assert torch.allclose(forward_cached(model, out[:, :8], cache), full[:, -2], atol=1e-10)
    assert torch.allclose(forward_cached(model, out[:, 8:9], cache), full[:, -1], atol=1e-10)
    assert cache.pos == 9

    # Cached and uncached sampling draw the same tokens under the same seed — inside and past block_size.
    for kwargs in [dict(), dict(temperature=0.8, top_k=10), dict(temperature=1.2, top_p=0.9)]:
        for n_new in (10, 30):
            torch.manual_seed(42)
            ref = generate(model, prompt, n_new, **kwargs)
            torch.manual_seed(42)
            got = generate_cached(model, prompt, n_new, **kwargs)
            assert torch.equal(ref, got), (kwargs, n_new)

    # Memory: 2 (k and v) x n_layer x B x block_size x n_embd elements.
    assert cache.nbytes() == 2 * config.n_layer * 3 * L * config.n_embd * 8
    print("PASS")
`,
    },
  },
  debrief: `\`generate\` is nanoGPT's, and it is quadratic: token *t* re-runs all *t* positions through every block, so 1,000 tokens cost about 500,000 position-forwards. The cache removes the redundancy. Keys and values of past positions never change — causal masking means position *i* only ever sees positions ≤ *i* — so each block stores them once, and a decode step embeds one token, computes one row of q, k, v per block, appends k, v at \`pos\`, and attends one query over \`pos + 1\` keys. The price is memory: \`2 · n_layer · B · T · n_embd\` numbers, which for GPT-2 small at \`T = 1024\` in fp16 is 36 MiB per sequence, and for a 70B model with 80 layers and 8,192-wide keys it is 2.5 MiB per token — the reason grouped-query attention shares one k, v head among several query heads and vLLM pages the cache in blocks. Preallocating to \`block_size\` and writing into a slice avoids \`torch.cat\`'s per-token reallocation; the mask slice \`[pos : pos + T, : pos + T]\` makes one function serve both the prefill (a triangle) and decode (a full row). GPT-2's learned absolute positions are why a full cache must be re-encoded: rotary embeddings (LLaMA) rotate q and k by their own positions, so a rolling cache can keep old keys. The samplers are the standard trio: temperature rescales, top-k drops a fixed-size tail, nucleus (Holtzman et al.) drops a tail sized by probability mass so a confident step keeps few tokens and an uncertain one keeps many. Production servers add continuous batching, paged and quantised caches, \`F.scaled_dot_product_attention\` with FlashAttention / FlashDecoding kernels, CUDA graphs for the decode step and speculative decoding.`,
};
