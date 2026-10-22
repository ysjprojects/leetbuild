import type {Step} from '@/lib/types';

export const llamaAttentionStep: Step = {
  id: 'llama-attention',
  title: 'Grouped-query attention with a KV cache',
  concept: 'pytorch',
  file: 'llama_attention',
  focus: ['q-heads', 'kv-heads', 'cache-k', 'cache-v'],
  task: `## Task

Write Llama 3's attention in \`llama_attention.py\` (\`from llama_layers import apply_rope, precompute_rope\`):
\`n_heads\` query heads share \`n_kv_heads\` key/value heads, keys and values live in a preallocated cache,
and a prompt can be fed in chunks at any \`start_pos\`. Write the attention out:
\`F.scaled_dot_product_attention\` and \`nn.MultiheadAttention\` are not allowed.

- \`repeat_kv(x, n_rep)\`: \`(B, S, n_kv_heads, hd) → (B, S, n_kv_heads · n_rep, hd)\`, query head \`h\` reading KV
  head \`h // n_rep\`; return \`x\` itself when \`n_rep == 1\`. Meta's version is
  \`x[:, :, :, None, :].expand(...).reshape(...)\`, one copy.
- \`causal_mask(seqlen, start_pos, device=None)\`: an additive \`(seqlen, start_pos + seqlen)\` float mask.
  Row \`i\` is the token at position \`start_pos + i\`: 0 for keys \`0 … start_pos + i\`, \`float("-inf")\` after.
  The first \`start_pos\` columns (the cache) are all 0; the rest is \`torch.triu\` of a \`-inf\` square with
  \`diagonal=1\`.
- \`kv_cache_bytes_per_token(n_layers, n_kv_heads, head_dim, bytes_per_elem=2)\`:
  \`2 · n_layers · n_kv_heads · head_dim · bytes_per_elem\`. Llama 3 8B in bf16: **131,072 B = 128 KiB**.
- \`Attention(dim, n_heads, n_kv_heads, max_batch_size, max_seq_len)\`:
  - bias-free \`wq: dim → n_heads · head_dim\`, \`wk\` and \`wv: dim → n_kv_heads · head_dim\`, \`wo\` back to
    \`dim\`, with \`head_dim = dim // n_heads\` and \`n_rep = n_heads // n_kv_heads\`;
  - non-persistent buffers \`cache_k\` and \`cache_v\`, \`torch.zeros(max_batch_size, max_seq_len, n_kv_heads,
    head_dim)\`: only the KV heads are stored.
- \`forward(x, start_pos, freqs_cis, mask)\`, \`x\` is \`(bsz, seqlen, dim)\` and \`freqs_cis\` the rows
  \`start_pos … start_pos + seqlen − 1\`:
  1. project and view as \`(bsz, seqlen, heads, head_dim)\`; \`apply_rope\` on q and k;
  2. write \`cache_k[:bsz, start_pos : start_pos + seqlen] = xk\` (and v), then read
     \`cache_k[:bsz, : start_pos + seqlen]\`, never a \`torch.cat\` that grows;
  3. \`repeat_kv\` both, transpose heads in front, \`scores = q @ kᵀ / math.sqrt(head_dim)\`, add \`mask\` when it is
     not \`None\` (one decode token needs none), \`F.softmax(scores.float(), dim=-1).type_as(xq)\`, \`@ values\`;
  4. merge heads and \`wo\`.

:::widget gqa-heads {"heads": 32, "kvHeads": 8}

The self-test checks \`repeat_kv\` against a stack of head indices, the mask cell by cell for \`(3, 2)\`, the
output against a slow per-head reference (head \`h\` on KV head \`h // n_rep\`, mask and softmax by hand) and
against an MHA \`Attention\` whose K/V weights repeat each group's rows, a 4-token prefill followed by
one-token decodes, a chunk at \`start_pos = 3\` (and that ignoring the offset breaks it), a batch smaller
than the cache, and the bytes per token: 128 KiB for 8B, 4× that without GQA, 1 GiB at 8,192 tokens.
Then it prints \`PASS\`.

> The cache holds \`n_kv_heads\`, not \`n_heads\`: Llama 3 8B's 32 query heads read 8 KV heads, so a token of
> context costs 128 KiB instead of 512 KiB, and \`repeat_kv\` restores the shapes only for the matmul.`,
  hints: [
    'Shapes first: `xq` is `(bsz, seqlen, n_heads, hd)` and `xk`, `xv` are `(bsz, seqlen, n_kv_heads, hd)`. The cache is indexed `[batch, position, kv_head, dim]`, so the write is a slice on the first two axes: `self.cache_k[:bsz, start_pos : start_pos + seqlen] = xk`.',
    'The mask is `torch.hstack([torch.zeros(seqlen, start_pos), torch.triu(torch.full((seqlen, seqlen), float("-inf")), diagonal=1)])`. A mask built for `start_pos = 0` would be `(seqlen, seqlen)` and either fail to broadcast or, padded on the wrong side, hide cached keys and show future ones.',
    'Softmax in float32 (`scores.float()`), then `.type_as(xq)`, as Meta does: in bf16 the exponentials of large scores lose the small weights. Register the caches with `register_buffer(..., persistent=False)` so `.to(device)` and `.half()` move them and `state_dict()` does not save them.',
  ],
  checks: [
    {
      id: 'gqa-projections',
      title: 'wq for n_heads, wk and wv for n_kv_heads',
      detail:
        '`wq = nn.Linear(dim, n_heads * head_dim, bias=False)`, `wk` and `wv` to `n_kv_heads * head_dim`: Llama 3 8B projects 4,096 → 4,096 for queries and 4,096 → 1,024 for keys and for values.',
      match: {
        python: {
          all: [
            /nn\.Linear\(\s*\w+\s*,\s*(?:self\.)?n_heads\s*\*\s*(?:self\.)?head_dim/,
            /nn\.Linear\(\s*\w+\s*,\s*(?:self\.)?n_kv_heads\s*\*\s*(?:self\.)?head_dim/,
          ],
        },
      },
    },
    {
      id: 'repeat-kv',
      title: 'repeat_kv expands each KV head to its query group',
      detail:
        'Query head `h` reads KV head `h // n_rep`: `x[:, :, :, None, :].expand(...)` then `reshape`, or `torch.repeat_interleave(x, n_rep, dim=2)`. `repeat` (tiling) would pair head `h` with KV head `h % n_kv_heads`, the wrong group.',
      match: {
        python: {
          all: [/\.expand\(|repeat_interleave\(/],
          none: [/\.repeat\(\s*1\s*,\s*1\s*,\s*(?:n_rep|self\.n_rep)/],
        },
      },
    },
    {
      id: 'kv-cache',
      title: 'Preallocated cache written at start_pos',
      detail:
        '`cache_k` and `cache_v` are `torch.zeros` buffers of `(max_batch_size, max_seq_len, n_kv_heads, head_dim)`; new rows go to `[:bsz, start_pos : start_pos + seqlen]` and attention reads `[:bsz, : start_pos + seqlen]`. Growing the cache with `torch.cat` reallocates every token.',
      match: {
        python: {
          all: [
            /torch\.zeros\(/,
            /cache_k\[[^\]\n]*start_pos\s*:\s*start_pos\s*\+\s*\w+\s*\]\s*=/,
            /cache_v\[[^\]\n]*start_pos\s*:\s*start_pos\s*\+\s*\w+\s*\]\s*=/,
            /=\s*self\.cache_k\[[^\]\n]*:\s*start_pos\s*\+\s*\w+\s*\]/,
          ],
          none: [/torch\.cat\(\s*[[(]\s*self\.cache_[kv]/],
        },
      },
    },
    {
      id: 'mask-offset',
      title: 'Causal mask offset by start_pos',
      detail:
        'A `float("-inf")` upper triangle (`torch.triu(..., diagonal=1)`) for the new tokens among themselves, after `start_pos` zero columns for the cached keys: the mask is `(seqlen, start_pos + seqlen)`.',
      match: {
        python: {
          all: [
            /\btriu\(|\btril\(/,
            /float\(\s*["']-inf["']\s*\)/,
            /start_pos\s*\+\s*1|\(\s*seqlen\s*,\s*start_pos\s*\)|hstack\(|torch\.cat\(/,
          ],
        },
      },
    },
    {
      id: 'explicit-attention',
      title: 'Attention written out, softmax in float32',
      detail:
        'Scores `q @ kᵀ / math.sqrt(head_dim)`, plus the mask, then `F.softmax(scores.float(), dim=-1)` and `@ values`. `F.scaled_dot_product_attention` and `nn.MultiheadAttention` are not allowed here.',
      match: {
        python: {
          all: [/\/\s*math\.sqrt\(\s*self\.head_dim\s*\)|head_dim\s*\*\*\s*-?0\.5/, /\.float\(\)/],
          order: [/scores\s*(?:=\s*scores\s*\+|\+=)\s*mask/, /softmax\(/],
          none: [/scaled_dot_product_attention/, /nn\.MultiheadAttention/],
        },
      },
    },
    {
      id: 'rope-before-cache',
      title: 'RoPE on q and k before the cache write',
      detail:
        'Keys are cached already rotated: `apply_rope` comes before `cache_k[...] = xk`, so a decode step rotates only its own token and never touches the cached rows again.',
      match: {
        python: {
          order: [/apply_rope\(/, /cache_k\[[^\]\n]*\]\s*=/],
        },
      },
    },
    {
      id: 'kv-bytes',
      title: 'KV-cache bytes per token',
      detail:
        '`kv_cache_bytes_per_token` returns `2 * n_layers * n_kv_heads * head_dim * bytes_per_elem` (K and V): 131,072 bytes for Llama 3 8B in bf16.',
      match: {
        python: {
          all: [
            /2\s*\*[^\n]*n_layers[^\n]*n_kv_heads[^\n]*head_dim|2\s*\*[^\n]*n_kv_heads[^\n]*head_dim[^\n]*n_layers/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Llama 3's grouped-query attention as Meta's reference model.py writes it: n_heads query heads share
n_kv_heads key/value heads, a preallocated KV cache written at start_pos, and a causal mask offset by it."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from llama_layers import apply_rope, precompute_rope


def repeat_kv(x: torch.Tensor, n_rep: int) -> torch.Tensor:
    """(B, S, n_kv_heads, hd) -> (B, S, n_kv_heads * n_rep, hd): KV head g serves query heads g*n_rep … g*n_rep + n_rep - 1."""
    raise NotImplementedError("TODO: return x itself when n_rep == 1, else repeat each KV head n_rep times in place")


def causal_mask(seqlen: int, start_pos: int, device: torch.device | None = None) -> torch.Tensor:
    """(seqlen, start_pos + seqlen) additive mask: row i is token start_pos + i, which sees keys 0 … start_pos + i."""
    raise NotImplementedError("TODO: zeros for the start_pos cached columns, then an upper-triangular -inf block")


def kv_cache_bytes_per_token(n_layers: int, n_kv_heads: int, head_dim: int, bytes_per_elem: int = 2) -> int:
    """K and V, every layer, every KV head: what one more token of context costs."""
    raise NotImplementedError("TODO")


class Attention(nn.Module):
    def __init__(self, dim: int, n_heads: int, n_kv_heads: int, max_batch_size: int, max_seq_len: int):
        super().__init__()
        assert dim % n_heads == 0 and n_heads % n_kv_heads == 0
        self.n_heads = n_heads
        self.n_kv_heads = n_kv_heads
        self.n_rep = n_heads // n_kv_heads
        self.head_dim = dim // n_heads
        # TODO: wq (n_heads heads), wk and wv (n_kv_heads heads), wo, all bias-free; non-persistent
        # cache_k / cache_v buffers of zeros, (max_batch_size, max_seq_len, n_kv_heads, head_dim).
        raise NotImplementedError("TODO: projections and the preallocated KV cache")

    def forward(
        self, x: torch.Tensor, start_pos: int, freqs_cis: torch.Tensor, mask: torch.Tensor | None
    ) -> torch.Tensor:
        # TODO: project and split into heads; RoPE on q and k; write k, v at start_pos; read rows
        # 0 … start_pos + seqlen; repeat_kv; scores / sqrt(head_dim) + mask; softmax in float32; @ v; wo.
        raise NotImplementedError("TODO: grouped-query attention over the cache")


if __name__ == "__main__":
    torch.manual_seed(0)
    dim, n_heads, n_kv_heads, max_batch, max_seq = 32, 8, 2, 3, 24
    hd, rep = dim // n_heads, n_heads // n_kv_heads
    freqs = precompute_rope(hd, max_seq)

    # repeat_kv: query head h reads KV head h // n_rep.
    kv = torch.randn(2, 5, n_kv_heads, hd)
    expected = torch.stack([kv[:, :, h // rep] for h in range(n_heads)], dim=2)
    assert torch.equal(repeat_kv(kv, rep), expected)
    assert repeat_kv(kv, 1) is kv

    # The offset mask, cell by cell: row i (token start_pos + i) sees keys 0 … start_pos + i.
    m = causal_mask(3, 2)
    assert m.shape == (3, 5)
    for i in range(3):
        for j in range(5):
            assert (m[i, j].item() == 0.0) == (j <= 2 + i) and (m[i, j].item() == -math.inf) == (j > 2 + i), (i, j)

    attn = Attention(dim, n_heads, n_kv_heads, max_batch, max_seq)
    assert attn.wk.weight.shape == (n_kv_heads * hd, dim) and attn.wq.weight.shape == (n_heads * hd, dim)
    assert attn.cache_k.shape == (max_batch, max_seq, n_kv_heads, hd), "the cache holds n_kv_heads, not n_heads"

    # Against a slow multi-head reference: one head at a time, head h using KV head h // n_rep.
    def reference(x: torch.Tensor) -> torch.Tensor:
        B, T, _ = x.shape
        outs = []
        for h in range(n_heads):
            g = h // rep
            q = (x @ attn.wq.weight[h * hd : (h + 1) * hd].T).unsqueeze(2)
            k = (x @ attn.wk.weight[g * hd : (g + 1) * hd].T).unsqueeze(2)
            v = x @ attn.wv.weight[g * hd : (g + 1) * hd].T
            q, k = apply_rope(q, k, freqs[:T])
            s = q[:, :, 0] @ k[:, :, 0].transpose(1, 2) / hd**0.5  # (B, T, T)
            future = torch.ones(T, T).bool()
            for i in range(T):
                future[i, : i + 1] = False
            s = s.masked_fill(future, -math.inf)
            w = torch.exp(s - s.amax(-1, keepdim=True))
            outs.append((w / w.sum(-1, keepdim=True)) @ v)
        return torch.cat(outs, dim=-1) @ attn.wo.weight.T

    T = 9
    x = torch.randn(max_batch, T, dim)
    with torch.no_grad():
        full = attn(x, 0, freqs[:T], causal_mask(T, 0))
        assert full.shape == (max_batch, T, dim)
        assert torch.allclose(full, reference(x), atol=1e-5), (full - reference(x)).abs().max()

        # GQA is MHA whose K/V weights repeat each group's rows n_rep times.
        mha = Attention(dim, n_heads, n_heads, max_batch, max_seq)
        mha.wq.weight.copy_(attn.wq.weight)
        mha.wo.weight.copy_(attn.wo.weight)
        mha.wk.weight.copy_(torch.cat([attn.wk.weight[(h // rep) * hd : (h // rep + 1) * hd] for h in range(n_heads)]))
        mha.wv.weight.copy_(torch.cat([attn.wv.weight[(h // rep) * hd : (h // rep + 1) * hd] for h in range(n_heads)]))
        assert torch.allclose(mha(x, 0, freqs[:T], causal_mask(T, 0)), full, atol=1e-5)

        # Prefill 4 tokens, then one token at a time: the same rows as the full forward.
        attn.cache_k.zero_()
        attn.cache_v.zero_()
        steps = [attn(x[:, :4], 0, freqs[:4], causal_mask(4, 0))]
        for pos in range(4, T):
            steps.append(attn(x[:, pos : pos + 1], pos, freqs[pos : pos + 1], None))
        assert torch.allclose(torch.cat(steps, dim=1), full, atol=1e-5)

        # A chunk after a prefill needs the offset mask: positions 3 … 8 at start_pos 3.
        first = attn(x[:, :3], 0, freqs[:3], causal_mask(3, 0))
        chunk = attn(x[:, 3:], 3, freqs[3:T], causal_mask(T - 3, 3))
        assert torch.allclose(torch.cat([first, chunk], dim=1), full, atol=1e-5)
        unshifted = attn(x[:, 3:], 3, freqs[3:T], torch.hstack([causal_mask(T - 3, 0), torch.zeros(T - 3, 3)]))
        assert not torch.allclose(unshifted, chunk, atol=1e-3), "a mask that ignores start_pos lets tokens see the future"

        # A smaller batch than the cache was sized for reads only its own rows.
        attn.cache_k.zero_()
        attn.cache_v.zero_()
        one = attn(x[:1], 0, freqs[:T], causal_mask(T, 0))
        assert torch.allclose(one, full[:1], atol=1e-5)

    # KV bytes per token: Llama 3 8B (32 layers, 8 KV heads of 128) in bf16 is 128 KiB; MHA would be 4x.
    assert kv_cache_bytes_per_token(32, 8, 128) == 131072
    assert kv_cache_bytes_per_token(32, 32, 128) == 4 * 131072
    assert kv_cache_bytes_per_token(32, 8, 128) * 8192 == 1 << 30  # 1 GiB for an 8,192-token sequence
    per_layer = (attn.cache_k.nbytes + attn.cache_v.nbytes) // (max_batch * max_seq)
    assert per_layer == kv_cache_bytes_per_token(1, n_kv_heads, hd, bytes_per_elem=4)
    print("PASS")
`,
      solution: `"""Llama 3's grouped-query attention as Meta's reference model.py writes it: n_heads query heads share
n_kv_heads key/value heads, a preallocated KV cache written at start_pos, and a causal mask offset by it."""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from llama_layers import apply_rope, precompute_rope


def repeat_kv(x: torch.Tensor, n_rep: int) -> torch.Tensor:
    """(B, S, n_kv_heads, hd) -> (B, S, n_kv_heads * n_rep, hd): KV head g serves query heads g*n_rep … g*n_rep + n_rep - 1."""
    bs, slen, n_kv_heads, head_dim = x.shape
    if n_rep == 1:
        return x
    return (
        x[:, :, :, None, :].expand(bs, slen, n_kv_heads, n_rep, head_dim).reshape(bs, slen, n_kv_heads * n_rep, head_dim)
    )


def causal_mask(seqlen: int, start_pos: int, device: torch.device | None = None) -> torch.Tensor:
    """(seqlen, start_pos + seqlen) additive mask: row i is token start_pos + i, which sees keys 0 … start_pos + i."""
    mask = torch.full((seqlen, seqlen), float("-inf"), device=device)
    mask = torch.triu(mask, diagonal=1)
    # Every cached key (columns 0 … start_pos - 1) is in the past of every new token.
    return torch.hstack([torch.zeros((seqlen, start_pos), device=device), mask])


def kv_cache_bytes_per_token(n_layers: int, n_kv_heads: int, head_dim: int, bytes_per_elem: int = 2) -> int:
    """K and V, every layer, every KV head: what one more token of context costs."""
    return 2 * n_layers * n_kv_heads * head_dim * bytes_per_elem


class Attention(nn.Module):
    def __init__(self, dim: int, n_heads: int, n_kv_heads: int, max_batch_size: int, max_seq_len: int):
        super().__init__()
        assert dim % n_heads == 0 and n_heads % n_kv_heads == 0
        self.n_heads = n_heads
        self.n_kv_heads = n_kv_heads
        self.n_rep = n_heads // n_kv_heads
        self.head_dim = dim // n_heads
        self.wq = nn.Linear(dim, n_heads * self.head_dim, bias=False)
        self.wk = nn.Linear(dim, n_kv_heads * self.head_dim, bias=False)
        self.wv = nn.Linear(dim, n_kv_heads * self.head_dim, bias=False)
        self.wo = nn.Linear(n_heads * self.head_dim, dim, bias=False)
        # Only the n_kv_heads are cached: that is the whole memory saving of GQA.
        shape = (max_batch_size, max_seq_len, n_kv_heads, self.head_dim)
        self.register_buffer("cache_k", torch.zeros(shape), persistent=False)
        self.register_buffer("cache_v", torch.zeros(shape), persistent=False)

    def forward(
        self, x: torch.Tensor, start_pos: int, freqs_cis: torch.Tensor, mask: torch.Tensor | None
    ) -> torch.Tensor:
        bsz, seqlen, _ = x.shape
        xq = self.wq(x).view(bsz, seqlen, self.n_heads, self.head_dim)
        xk = self.wk(x).view(bsz, seqlen, self.n_kv_heads, self.head_dim)
        xv = self.wv(x).view(bsz, seqlen, self.n_kv_heads, self.head_dim)
        xq, xk = apply_rope(xq, xk, freqs_cis)

        # Write the new rows at their positions, then read every row up to the last new one.
        self.cache_k[:bsz, start_pos : start_pos + seqlen] = xk
        self.cache_v[:bsz, start_pos : start_pos + seqlen] = xv
        keys = self.cache_k[:bsz, : start_pos + seqlen]
        values = self.cache_v[:bsz, : start_pos + seqlen]
        keys = repeat_kv(keys, self.n_rep)  # (B, start_pos + seqlen, n_heads, hd)
        values = repeat_kv(values, self.n_rep)

        xq = xq.transpose(1, 2)  # (B, n_heads, seqlen, hd)
        keys = keys.transpose(1, 2)  # (B, n_heads, start_pos + seqlen, hd)
        values = values.transpose(1, 2)
        scores = torch.matmul(xq, keys.transpose(2, 3)) / math.sqrt(self.head_dim)
        if mask is not None:
            scores = scores + mask  # (B, n_heads, seqlen, start_pos + seqlen)
        scores = F.softmax(scores.float(), dim=-1).type_as(xq)
        output = torch.matmul(scores, values)  # (B, n_heads, seqlen, hd)
        output = output.transpose(1, 2).contiguous().view(bsz, seqlen, -1)
        return self.wo(output)


if __name__ == "__main__":
    torch.manual_seed(0)
    dim, n_heads, n_kv_heads, max_batch, max_seq = 32, 8, 2, 3, 24
    hd, rep = dim // n_heads, n_heads // n_kv_heads
    freqs = precompute_rope(hd, max_seq)

    # repeat_kv: query head h reads KV head h // n_rep.
    kv = torch.randn(2, 5, n_kv_heads, hd)
    expected = torch.stack([kv[:, :, h // rep] for h in range(n_heads)], dim=2)
    assert torch.equal(repeat_kv(kv, rep), expected)
    assert repeat_kv(kv, 1) is kv

    # The offset mask, cell by cell: row i (token start_pos + i) sees keys 0 … start_pos + i.
    m = causal_mask(3, 2)
    assert m.shape == (3, 5)
    for i in range(3):
        for j in range(5):
            assert (m[i, j].item() == 0.0) == (j <= 2 + i) and (m[i, j].item() == -math.inf) == (j > 2 + i), (i, j)

    attn = Attention(dim, n_heads, n_kv_heads, max_batch, max_seq)
    assert attn.wk.weight.shape == (n_kv_heads * hd, dim) and attn.wq.weight.shape == (n_heads * hd, dim)
    assert attn.cache_k.shape == (max_batch, max_seq, n_kv_heads, hd), "the cache holds n_kv_heads, not n_heads"

    # Against a slow multi-head reference: one head at a time, head h using KV head h // n_rep.
    def reference(x: torch.Tensor) -> torch.Tensor:
        B, T, _ = x.shape
        outs = []
        for h in range(n_heads):
            g = h // rep
            q = (x @ attn.wq.weight[h * hd : (h + 1) * hd].T).unsqueeze(2)
            k = (x @ attn.wk.weight[g * hd : (g + 1) * hd].T).unsqueeze(2)
            v = x @ attn.wv.weight[g * hd : (g + 1) * hd].T
            q, k = apply_rope(q, k, freqs[:T])
            s = q[:, :, 0] @ k[:, :, 0].transpose(1, 2) / hd**0.5  # (B, T, T)
            future = torch.ones(T, T).bool()
            for i in range(T):
                future[i, : i + 1] = False
            s = s.masked_fill(future, -math.inf)
            w = torch.exp(s - s.amax(-1, keepdim=True))
            outs.append((w / w.sum(-1, keepdim=True)) @ v)
        return torch.cat(outs, dim=-1) @ attn.wo.weight.T

    T = 9
    x = torch.randn(max_batch, T, dim)
    with torch.no_grad():
        full = attn(x, 0, freqs[:T], causal_mask(T, 0))
        assert full.shape == (max_batch, T, dim)
        assert torch.allclose(full, reference(x), atol=1e-5), (full - reference(x)).abs().max()

        # GQA is MHA whose K/V weights repeat each group's rows n_rep times.
        mha = Attention(dim, n_heads, n_heads, max_batch, max_seq)
        mha.wq.weight.copy_(attn.wq.weight)
        mha.wo.weight.copy_(attn.wo.weight)
        mha.wk.weight.copy_(torch.cat([attn.wk.weight[(h // rep) * hd : (h // rep + 1) * hd] for h in range(n_heads)]))
        mha.wv.weight.copy_(torch.cat([attn.wv.weight[(h // rep) * hd : (h // rep + 1) * hd] for h in range(n_heads)]))
        assert torch.allclose(mha(x, 0, freqs[:T], causal_mask(T, 0)), full, atol=1e-5)

        # Prefill 4 tokens, then one token at a time: the same rows as the full forward.
        attn.cache_k.zero_()
        attn.cache_v.zero_()
        steps = [attn(x[:, :4], 0, freqs[:4], causal_mask(4, 0))]
        for pos in range(4, T):
            steps.append(attn(x[:, pos : pos + 1], pos, freqs[pos : pos + 1], None))
        assert torch.allclose(torch.cat(steps, dim=1), full, atol=1e-5)

        # A chunk after a prefill needs the offset mask: positions 3 … 8 at start_pos 3.
        first = attn(x[:, :3], 0, freqs[:3], causal_mask(3, 0))
        chunk = attn(x[:, 3:], 3, freqs[3:T], causal_mask(T - 3, 3))
        assert torch.allclose(torch.cat([first, chunk], dim=1), full, atol=1e-5)
        unshifted = attn(x[:, 3:], 3, freqs[3:T], torch.hstack([causal_mask(T - 3, 0), torch.zeros(T - 3, 3)]))
        assert not torch.allclose(unshifted, chunk, atol=1e-3), "a mask that ignores start_pos lets tokens see the future"

        # A smaller batch than the cache was sized for reads only its own rows.
        attn.cache_k.zero_()
        attn.cache_v.zero_()
        one = attn(x[:1], 0, freqs[:T], causal_mask(T, 0))
        assert torch.allclose(one, full[:1], atol=1e-5)

    # KV bytes per token: Llama 3 8B (32 layers, 8 KV heads of 128) in bf16 is 128 KiB; MHA would be 4x.
    assert kv_cache_bytes_per_token(32, 8, 128) == 131072
    assert kv_cache_bytes_per_token(32, 32, 128) == 4 * 131072
    assert kv_cache_bytes_per_token(32, 8, 128) * 8192 == 1 << 30  # 1 GiB for an 8,192-token sequence
    per_layer = (attn.cache_k.nbytes + attn.cache_v.nbytes) // (max_batch * max_seq)
    assert per_layer == kv_cache_bytes_per_token(1, n_kv_heads, hd, bytes_per_elem=4)
    print("PASS")
`,
    },
  },
  debrief: `This is Meta's \`Attention\` with fairscale's parallel layers replaced by \`nn.Linear\`. Three choices
make it a serving attention rather than a training one. **Grouped-query attention**
([Ainslie et al., 2023](https://arxiv.org/abs/2305.13245)) keeps 32 query heads but only 8 key/value heads:
quality stays close to MHA while the cache, which dominates memory at long context, shrinks 4×.
\`repeat_kv\` makes the shapes line up for a plain batched matmul; fused kernels (FlashAttention,
vLLM's paged attention) skip that copy and index KV head \`h // n_rep\` directly.

**The cache is preallocated** to \`max_seq_len\` rows and written in place at \`start_pos\`. Meta's reference
allocates it per layer for \`max_batch_size\` sequences up front, which is why serving systems moved to
paged blocks: a fixed slab per sequence wastes whatever the sequence never uses. Because keys are
cached after RoPE, a decode step rotates one key and reuses every cached one untouched.

**The offset mask** is what lets one \`forward\` serve both phases: the prefill (\`start_pos = 0\`, a full
triangle), a chunked prefill (\`start_pos > 0\`, zero columns for the cache then a triangle) and decode
(one token, no mask at all). Production engines add a batch of sequences at different \`start_pos\`
values in one call (continuous batching) and keep the scores off memory with FlashAttention.`,
};
