import type {Step} from '@/lib/types';

export const causalAttentionStep: Step = {
  id: 'causal-attention',
  title: 'CausalSelfAttention: fused qkv, heads, tril mask, float32 softmax, proj',
  concept: 'pytorch',
  file: 'causal_attention',
  focus: ['qkv', 'q', 'k', 'v', 'scores', 'mask', 'softmax', 'dropout', 'wsum', 'merge', 'proj'],
  task: `## Task

Implement \`CausalSelfAttention(nn.Module)\` with \`__init__(self, d_model, n_heads, dropout=0.0, max_len=1024)\`
and \`forward(self, x, attn_mask=None)\` → \`[B, T, d_model]\`, where position \`t\` attends to positions
\`0..t\` only. \`torch.nn.functional.scaled_dot_product_attention\`, \`nn.MultiheadAttention\` and
\`nn.Transformer*\` are **forbidden inside the module** — the self-test uses SDPA as the reference.

- **One fused projection**: \`self.qkv = nn.Linear(d_model, 3 * d_model)\`; \`split(d_model, dim=-1)\` gives
  \`q, k, v\`, each \`[B, T, d_model]\`. \`self.head_dim = d_model // n_heads\` (assert it divides).
- **Heads are a reshape**: \`view(B, T, n_heads, head_dim).transpose(1, 2)\` → \`[B, H, T, hd]\`; after
  attention \`transpose(1, 2).contiguous().view(B, T, d_model)\` puts the heads back side by side.
- **Scores**: \`q @ k.transpose(-2, -1)\` scaled by \`1 / sqrt(head_dim)\` → \`[B, H, T, T]\`.
- **The causal mask is a buffer**: \`register_buffer("causal_mask", torch.tril(torch.ones(max_len, max_len,
  dtype=torch.bool)), persistent=False)\` in \`__init__\`; \`forward\` slices \`[:T, :T]\`. \`attn_mask\`, when given,
  is \`[B, T]\` bool, \`True\` where the key is a real token; AND it in as \`attn_mask[:, None, None, :]\`
  (padding is on the right, so no row is fully masked).
- **Mask before the softmax** with \`masked_fill(~mask, float("-inf"))\`; the softmax runs over the last dim
  in **float32 or wider** (\`dtype=torch.float32\` for half inputs, never downcasting a float64 input), then
  casts back to \`v.dtype\`.

:::widget attention-heatmap {"causal": true}

- \`self.attn_dropout = nn.Dropout(dropout)\` on the probabilities, then \`probs @ v\`, merge heads,
  \`self.proj = nn.Linear(d_model, d_model)\`.
- The file ends with the self-test: \`torch.manual_seed(0)\`, \`B, T, D, H = 2, 8, 32, 4\`, equality with
  \`F.scaled_dot_product_attention(q, k, v, is_causal=True)\` through the same weights at \`atol=rtol=1e-5\`,
  a perturbation of token 5 that leaves positions \`0..4\` unchanged, a right-padded sample against SDPA
  with an explicit boolean mask, \`torch.autograd.gradcheck\` on a \`(8, 2)\` module in float64, dropout
  that is a no-op in \`eval()\` — and \`PASS\`.

> The mask must zero the *probability*, not the score: \`-inf\` before the softmax makes \`exp\` return exactly
> 0 and leaves the row normalised over the past alone. Masking after the softmax leaks the future
> through the denominator.`,
  hints: [
    'Shapes first: `self.qkv(x)` is `[B, T, 3D]`; `.split(self.d_model, dim=-1)` gives three `[B, T, D]`; `.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)` makes each `[B, H, T, hd]`, and `q @ k.transpose(-2, -1)` is then `[B, H, T, T]` with no loop over heads.',
    'Build the mask once in `__init__` as a bool buffer and slice `self.causal_mask[:T, :T]` in `forward`; a `[T, T]` bool broadcasts over `[B, H, T, T]`. `scores.masked_fill(~mask, float("-inf"))` then `torch.softmax(..., dim=-1, dtype=torch.promote_types(scores.dtype, torch.float32)).to(v.dtype)` — `promote_types` is float32 for half inputs and leaves float64 alone, which is what `gradcheck` needs.',
    'After `probs @ v` the tensor is `[B, H, T, hd]`: `transpose(1, 2)` gives `[B, T, H, hd]`, which is not contiguous, so `.contiguous()` before `.view(B, T, D)`. The padding mask is `attn_mask[:, None, None, :]` — it masks *keys* (columns), not queries.',
  ],
  checks: [
    {
      id: 'fused-qkv',
      title: 'One fused qkv projection, split into q, k, v',
      detail:
        '`self.qkv = nn.Linear(d_model, 3 * d_model)` and a `.split(` / `.chunk(` of its output: one GEMM reads `x` once for all three projections instead of three Linear layers reading it three times.',
      match: {
        python: {all: [/nn\.Linear\(\s*d_model\s*,\s*3\s*\*\s*d_model\s*\)/, /\.split\(|\.chunk\(/]},
      },
    },
    {
      id: 'heads',
      title: 'Heads are a view and a transpose, not a loop',
      detail:
        '`.view(B, T, n_heads, head_dim).transpose(1, 2)` to `[B, H, T, hd]` before the scores and `.transpose(1, 2).contiguous().view(B, T, d_model)` after `probs @ v`: every head is one slice of the same tensor and one batched matmul covers them all.',
      match: {
        python: {
          all: [
            /\.(view|reshape)\([^)]*n_heads[^)]*head_dim\s*\)\s*\.transpose\(\s*1\s*,\s*2\s*\)/,
            /\.transpose\(\s*1\s*,\s*2\s*\)(\s*\.contiguous\(\))?\s*\.(view|reshape)\(/,
          ],
        },
      },
    },
    {
      id: 'scale',
      title: 'Scores are q·kᵀ scaled by 1/sqrt(head_dim)',
      detail:
        '`q @ k.transpose(-2, -1)` divided by `math.sqrt(self.head_dim)` (or `* self.head_dim ** -0.5`): without the scale the dot products grow with `hd` and the softmax saturates to one-hot rows, killing the gradient.',
      match: {
        python: {all: [/math\.sqrt\(\s*self\.head_dim\s*\)|self\.head_dim\s*\*\*\s*-?0\.5/]},
      },
    },
    {
      id: 'causal-buffer',
      title: 'The causal mask is a registered tril buffer',
      detail:
        '`self.register_buffer("causal_mask", torch.tril(...))` built once in `__init__`: not a parameter (nothing to train), but part of the module so `.to(device)` moves it; `forward` slices `[:T, :T]`.',
      match: {
        python: {all: [/self\.register_buffer\(\s*"causal_mask"/, /torch\.tril\(/]},
      },
    },
    {
      id: 'mask-before-softmax',
      title: 'masked_fill(-inf) before the softmax',
      detail:
        '`scores.masked_fill(~mask, float("-inf"))` and only then `softmax`: `exp(-inf)` is exactly 0 and the row is normalised over the visible keys alone. Masking after the softmax leaves the future in the denominator.',
      match: {
        python: {
          all: [/masked_fill\([^\n]*(float\(\s*["']-inf["']\s*\)|-torch\.inf|-math\.inf|-float\(\s*["']inf["']\s*\))/],
          order: [/masked_fill\(/, /softmax\(/],
        },
      },
    },
    {
      id: 'float32-softmax',
      title: 'The softmax runs in float32 (or wider)',
      detail:
        '`softmax(..., dtype=torch.float32)` / `promote_types(scores.dtype, torch.float32)` or `scores.float()` on the same line: a bfloat16 softmax has 8 bits of mantissa and loses the small probabilities a long row is made of; cast back to `v.dtype` afterwards.',
      match: {
        python: {all: [/softmax\([^\n]*(float32|\.float\(\))/]},
      },
    },
    {
      id: 'padding-mask',
      title: 'attn_mask masks keys, ANDed with the causal mask',
      detail:
        '`if attn_mask is not None:` combine `[B, T]` as `attn_mask[:, None, None, :]` (columns = keys) with the `[T, T]` tril; a padded key is then invisible to every query, and the self-test’s right-padded sample matches SDPA with an explicit mask.',
      match: {
        python: {
          all: [
            /attn_mask\s+is\s+not\s+None/,
            /attn_mask\[\s*:\s*,\s*None\s*,\s*None(\s*,\s*:)?\s*\]|attn_mask\.unsqueeze\(|attn_mask\.(view|reshape)\(/,
          ],
        },
      },
    },
    {
      id: 'dropout-then-proj',
      title: 'Dropout on the probabilities, then @ v, then proj — and no shortcut',
      detail:
        '`nn.Dropout(dropout)` applied after the softmax and before `probs @ v`, then `self.proj(...)` last; no `F.scaled_dot_product_attention` or `nn.MultiheadAttention` inside the module (the self-test may call SDPA as its reference).',
      match: {
        python: {
          all: [/nn\.Dropout\(\s*dropout\s*\)/, /@\s*k\.transpose|torch\.matmul\(\s*q\s*,|einsum\(/],
          order: [/softmax\(/, /self\.\w*dropout\w*\(/, /@\s*v\b|torch\.matmul\(/, /self\.proj\(/],
          none: [
            /nn\.MultiheadAttention|nn\.Transformer/,
            /class CausalSelfAttention(?:(?!\nif __name__)[\s\S])*?scaled_dot_product_attention/,
            /scaled_dot_product_attention(?!\()/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Causal multi-head self-attention from scratch: one fused qkv projection, heads split out, scaled dot-product
scores, a tril mask applied before a float32 softmax, attention dropout, output projection."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class CausalSelfAttention(nn.Module):
    """Multi-head self-attention where position t attends to positions 0..t only (a decoder block's attention)."""

    def __init__(self, d_model: int, n_heads: int, dropout: float = 0.0, max_len: int = 1024) -> None:
        super().__init__()
        assert d_model % n_heads == 0, "d_model must be a multiple of n_heads"
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        # TODO: self.qkv = nn.Linear(d_model, 3 * d_model), self.proj = nn.Linear(d_model, d_model),
        #       self.attn_dropout = nn.Dropout(dropout), and a non-persistent bool buffer "causal_mask" =
        #       torch.tril(torch.ones(max_len, max_len, dtype=torch.bool))
        raise NotImplementedError("TODO")

    def forward(self, x: torch.Tensor, attn_mask: torch.Tensor | None = None) -> torch.Tensor:
        """x: [B, T, d_model]; attn_mask: optional [B, T] bool, True where the key is a real token. Returns [B, T, d_model]."""
        # TODO: qkv → split → view(B, T, H, hd).transpose(1, 2) → q @ k.transpose(-2, -1) / sqrt(hd)
        #       → masked_fill(~(tril[:T, :T] & attn_mask[:, None, None, :]), -inf) → softmax in float32 → dropout
        #       → @ v → transpose(1, 2).contiguous().view(B, T, D) → proj
        raise NotImplementedError("TODO")


if __name__ == "__main__":
    torch.manual_seed(0)
    B, T, D, H = 2, 8, 32, 4
    attn = CausalSelfAttention(D, H, dropout=0.0).eval()
    x = torch.randn(B, T, D)

    def reference(x: torch.Tensor, key_mask: torch.Tensor | None = None) -> torch.Tensor:
        """The same weights through PyTorch's fused kernel."""
        q, k, v = attn.qkv(x).split(D, dim=-1)
        q, k, v = (t.view(B, T, H, D // H).transpose(1, 2) for t in (q, k, v))
        if key_mask is None:
            out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        else:
            full = torch.tril(torch.ones(T, T, dtype=torch.bool)) & key_mask[:, None, None, :]
            out = F.scaled_dot_product_attention(q, k, v, attn_mask=full)
        return attn.proj(out.transpose(1, 2).reshape(B, T, D))

    # 1. Matches F.scaled_dot_product_attention(is_causal=True).
    out = attn(x)
    assert out.shape == (B, T, D), out.shape
    assert torch.allclose(out, reference(x), atol=1e-5, rtol=1e-5), "mismatch vs SDPA(is_causal=True)"

    # 2. Causal: perturbing token 5 changes nothing at positions 0..4.
    x2 = x.clone()
    x2[:, 5] += 1.0
    assert torch.allclose(attn(x2)[:, :5], out[:, :5], atol=1e-6), "a later token leaked into earlier positions"
    assert not torch.allclose(attn(x2)[:, 5:], out[:, 5:]), "positions 5.. must see the change"

    # 3. Key padding: the last three tokens of sample 1 are padding; every row matches the masked reference.
    key_mask = torch.ones(B, T, dtype=torch.bool)
    key_mask[1, 5:] = False
    assert torch.allclose(attn(x, attn_mask=key_mask), reference(x, key_mask), atol=1e-5, rtol=1e-5), "padding mask"

    # 4. Gradients through the mask, the scale and the softmax, in float64.
    small = CausalSelfAttention(8, 2, dropout=0.0).double()
    xs = torch.randn(1, 4, 8, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(small, (xs,), eps=1e-6, atol=1e-4), "gradcheck"

    # 5. Dropout only touches the probabilities, and only in training mode.
    drop = CausalSelfAttention(D, H, dropout=0.5)
    drop.load_state_dict(attn.state_dict())
    assert torch.allclose(drop.eval()(x), out), "eval mode must not drop"
    assert not torch.allclose(drop.train()(x), out), "train mode must drop"
    print("PASS")
`,
      solution: `"""Causal multi-head self-attention from scratch: one fused qkv projection, heads split out, scaled dot-product
scores, a tril mask applied before a float32 softmax, attention dropout, output projection."""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class CausalSelfAttention(nn.Module):
    """Multi-head self-attention where position t attends to positions 0..t only (a decoder block's attention)."""

    def __init__(self, d_model: int, n_heads: int, dropout: float = 0.0, max_len: int = 1024) -> None:
        super().__init__()
        assert d_model % n_heads == 0, "d_model must be a multiple of n_heads"
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)  # one GEMM for q, k and v
        self.proj = nn.Linear(d_model, d_model)
        self.attn_dropout = nn.Dropout(dropout)
        # Not a parameter: nothing to train, moves with .to(device), stays out of the state_dict.
        causal = torch.tril(torch.ones(max_len, max_len, dtype=torch.bool))
        self.register_buffer("causal_mask", causal, persistent=False)

    def forward(self, x: torch.Tensor, attn_mask: torch.Tensor | None = None) -> torch.Tensor:
        """x: [B, T, d_model]; attn_mask: optional [B, T] bool, True where the key is a real token. Returns [B, T, d_model]."""
        B, T, _ = x.shape
        q, k, v = self.qkv(x).split(self.d_model, dim=-1)  # three [B, T, d_model]
        q = q.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)  # [B, H, T, hd]
        k = k.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_heads, self.head_dim).transpose(1, 2)
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)  # [B, H, T, T]
        mask = self.causal_mask[:T, :T]  # [T, T], broadcast over B and H
        if attn_mask is not None:
            mask = mask & attn_mask[:, None, None, :]  # [B, 1, T, T]: padded keys are never attended
        scores = scores.masked_fill(~mask, float("-inf"))
        # Softmax in at least float32: a half-precision row overflows or loses the small probabilities.
        probs = torch.softmax(scores, dim=-1, dtype=torch.promote_types(scores.dtype, torch.float32)).to(v.dtype)
        probs = self.attn_dropout(probs)
        out = probs @ v  # [B, H, T, hd]
        out = out.transpose(1, 2).contiguous().view(B, T, self.d_model)  # heads back side by side
        return self.proj(out)


if __name__ == "__main__":
    torch.manual_seed(0)
    B, T, D, H = 2, 8, 32, 4
    attn = CausalSelfAttention(D, H, dropout=0.0).eval()
    x = torch.randn(B, T, D)

    def reference(x: torch.Tensor, key_mask: torch.Tensor | None = None) -> torch.Tensor:
        """The same weights through PyTorch's fused kernel."""
        q, k, v = attn.qkv(x).split(D, dim=-1)
        q, k, v = (t.view(B, T, H, D // H).transpose(1, 2) for t in (q, k, v))
        if key_mask is None:
            out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        else:
            full = torch.tril(torch.ones(T, T, dtype=torch.bool)) & key_mask[:, None, None, :]
            out = F.scaled_dot_product_attention(q, k, v, attn_mask=full)
        return attn.proj(out.transpose(1, 2).reshape(B, T, D))

    # 1. Matches F.scaled_dot_product_attention(is_causal=True).
    out = attn(x)
    assert out.shape == (B, T, D), out.shape
    assert torch.allclose(out, reference(x), atol=1e-5, rtol=1e-5), "mismatch vs SDPA(is_causal=True)"

    # 2. Causal: perturbing token 5 changes nothing at positions 0..4.
    x2 = x.clone()
    x2[:, 5] += 1.0
    assert torch.allclose(attn(x2)[:, :5], out[:, :5], atol=1e-6), "a later token leaked into earlier positions"
    assert not torch.allclose(attn(x2)[:, 5:], out[:, 5:]), "positions 5.. must see the change"

    # 3. Key padding: the last three tokens of sample 1 are padding; every row matches the masked reference.
    key_mask = torch.ones(B, T, dtype=torch.bool)
    key_mask[1, 5:] = False
    assert torch.allclose(attn(x, attn_mask=key_mask), reference(x, key_mask), atol=1e-5, rtol=1e-5), "padding mask"

    # 4. Gradients through the mask, the scale and the softmax, in float64.
    small = CausalSelfAttention(8, 2, dropout=0.0).double()
    xs = torch.randn(1, 4, 8, dtype=torch.float64, requires_grad=True)
    assert torch.autograd.gradcheck(small, (xs,), eps=1e-6, atol=1e-4), "gradcheck"

    # 5. Dropout only touches the probabilities, and only in training mode.
    drop = CausalSelfAttention(D, H, dropout=0.5)
    drop.load_state_dict(attn.state_dict())
    assert torch.allclose(drop.eval()(x), out), "eval mode must not drop"
    assert not torch.allclose(drop.train()(x), out), "train mode must drop"
    print("PASS")
`,
    },
  },
  debrief: `The module is nanoGPT's \`CausalSelfAttention\` written out, and each line is where it is for a reason. The **fused qkv** Linear is one \`[B·T, D] × [D, 3D]\` GEMM: \`x\` is read from memory once and the three projections share one launch — three separate layers cost three reads and three launches for the same arithmetic. **Heads are a view**: \`[B, T, D] → [B, T, H, hd] → [B, H, T, hd]\` costs no copy, and the batched \`q @ kᵀ\` runs all \`B × H\` attention matrices in one kernel; the \`.contiguous()\` on the way back is the only copy, because \`transpose\` only changes strides and \`view\` needs the memory in order. The **mask is a buffer**: it is state the module owns (it moves with \`.to(device)\`) but nothing trains it, and \`persistent=False\` keeps a megabyte of ones out of every checkpoint. **\`-inf\` before the softmax** is the only correct place for it — \`exp(-inf) = 0\` exactly, so masked keys get no probability and take no share of the denominator; a mask applied to the probabilities afterwards leaves the future in the normaliser, and a large finite constant like \`-1e4\` still gives \`exp(-1e4 + max)\`, which is not zero once the scores themselves are large. **Softmax in float32** matters in mixed precision: bfloat16 keeps 8 bits of mantissa, so a row of 4096 probabilities loses most of its small entries; \`promote_types\` upcasts half inputs and leaves float64 alone, which is why \`gradcheck\` passes on the same code path.

What this module does *not* do is the whole reason \`F.scaled_dot_product_attention\` exists. The \`[B, H, T, T]\` score tensor is \`O(T²)\` memory — at \`T = 8192\`, \`H = 32\`, one sample is 4 GiB of bfloat16 scores plus the same again for the probabilities and their gradient — and it is written to HBM and read back three times (scores, softmax, \`probs @ v\`). **FlashAttention-2** never materialises it: it streams tiles of \`k\` and \`v\` through SRAM, keeps a running row-max and row-sum (the *online softmax*), and rescales partial outputs as the max moves, so memory is \`O(T)\` and the arithmetic stays on-chip; the backward pass recomputes the probabilities from the saved row statistics instead of storing them. SDPA dispatches to that kernel, to the memory-efficient xFormers kernel, or to this math fallback depending on dtype, mask shape and device — \`is_causal=True\` is a hint that lets the kernel skip the upper-triangle tiles entirely instead of computing and masking them. Production stacks add a **KV cache** at inference (\`k\` and \`v\` of past tokens kept, one query row per step), **grouped-query attention** (fewer \`k\`/\`v\` heads than \`q\` heads, shrinking that cache), **RoPE** applied to \`q\` and \`k\` before the scores, and \`torch.compile\` to fuse the reshapes and the scale into the surrounding kernels.`,
};
