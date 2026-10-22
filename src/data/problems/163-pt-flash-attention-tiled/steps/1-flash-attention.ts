import type {Step} from '@/lib/types';

/** From `def flash_attention(` to the next top-level definition: the function body, where the shortcuts are forbidden. */
const inFlashAttention = (pattern: string): RegExp =>
  new RegExp(`def flash_attention\\((?:(?!\\n(?:def |class |if __name__))[\\s\\S])*?(?:${pattern})`);

export const flashAttentionStep: Step = {
  id: 'flash-attention',
  title: 'flash_attention(): tiles, running max and sum, one normalisation at the end',
  concept: 'pytorch',
  file: 'flash_attention',
  focus: ['qloop', 'kloop', 'stats'],
  task: `## Task

Implement \`flash_attention(q, k, v, block_q, block_k, causal=True) -> out\` for \`q\`, \`k\`, \`v\` of shape
\`[B, H, T, hd]\`: exactly \`softmax(q kᵀ / √hd) v\` (causally masked when \`causal\`), computed **without ever
holding a \`[T, T]\` score matrix** — one \`[block_q, block_k]\` tile of scores at a time.

- **Two loops.** Query tiles \`q0 = 0, block_q, 2·block_q, …\` (the last one shorter when \`T\` is not a
  multiple), and for each, key/value tiles \`k0 = 0, block_k, …\`. Scores of one tile:
  \`s = q[:, :, q0:q1] @ k[:, :, k0:k1]ᵀ · (1 / √hd)\`, shape \`[B, H, bq, bk]\`.
- **Online softmax.** Per query row carry \`m\` (running max, starts \`-inf\`), \`l\` (running sum, starts 0) and
  \`o\` (unnormalised output, \`[B, H, bq, hd]\`, starts 0). For each key tile:
  \`m_new = max(m, s.amax(-1))\`, \`alpha = exp(m - m_new)\`, \`p = exp(s - m_new)\`,
  \`l = alpha · l + p.sum(-1)\`, \`o = alpha · o + p @ v[:, :, k0:k1]\`, \`m = m_new\`. The query tile's
  output is \`o / l\` — divide **once**, after the last key tile. Keep \`m\`, \`l\` and \`o\` as the names
  (\`m_new\` / \`m_i\` style suffixes are fine).
- **Causal.** A key tile that starts at or after the query tile's end (\`k0 >= q1\`) is skipped; a tile that
  crosses the diagonal is masked **inside the tile** with \`torch.arange\` row/column indices and
  \`masked_fill(cols > rows, -inf)\`; a tile entirely below the diagonal needs no mask.
- **Precision.** Compute in float32 (float64 inputs stay float64), return the input dtype; scale by
  \`1 / math.sqrt(hd)\`. Autograd must flow through the loop: no \`torch.no_grad\`, no \`.detach()\`.
- **Forbidden:** \`F.scaled_dot_product_attention\`, any \`softmax(\` and anything that builds a \`[T, T]\`
  tensor (a full \`tril\` mask included) inside \`flash_attention\`. The reference is used only by the
  self-test.
- **Self-test** (keep it): \`torch.manual_seed(0)\`, \`B, H, T, hd = 2, 3, 37, 16\`; causal tiles
  \`(8, 8)\`, \`(16, 4)\`, \`(5, 7)\`, \`(32, 16)\` run under \`NoFullScores(T)\` — a \`TorchFunctionMode\` that
  raises if any op returns a tensor ending in \`[T, T]\` — and must \`allclose\` the reference with
  \`atol=1e-5\`; \`(64, 64)\` degenerates to one tile; \`causal=False\` against the unmasked reference;
  \`torch.autograd.gradcheck\` in float64 on \`[1, 2, 7, 4]\` with tiles \`(3, 2)\`; then \`PASS\`.

> The softmax over a row needs the row's max before any exponential is taken — unless every partial
> result is tagged with the max it was computed under and rescaled by \`exp(m_old - m_new)\` when a
> later tile raises it. That rescaling is what lets attention stream over keys without the \`[T, T]\`.`,
  sequence: {
    participants: ['caller', 'flash_attention', 'k/v tile', 'm · l · o'],
    messages: [
      {
        from: 'caller',
        to: 'flash_attention',
        label: 'q, k, v [2, 3, 37, 16] · block_q = 8 · block_k = 8',
        kind: 'sync',
      },
      {from: 'flash_attention', to: 'm · l · o', label: 'query rows 8..15: m = -inf, l = 0, o = 0', kind: 'sync'},
      {
        from: 'flash_attention',
        to: 'k/v tile',
        label: 'keys 0..7: s = q₈₋₁₅ k₀₋₇ᵀ / √16  [8, 8], below the diagonal — no mask',
        kind: 'sync',
      },
      {
        from: 'k/v tile',
        to: 'm · l · o',
        label: 'm_new = max(m, rowmax s) · α = exp(m − m_new) = 0 · l = Σp · o = p v₀₋₇',
        kind: 'sync',
      },
      {
        from: 'flash_attention',
        to: 'k/v tile',
        label: 'keys 8..15: crosses the diagonal → masked_fill(col > row, −inf)',
        kind: 'sync',
      },
      {
        from: 'k/v tile',
        to: 'm · l · o',
        label: 'm_new ≥ m · α = exp(m − m_new) ≤ 1 · l = α l + Σp · o = α o + p v₈₋₁₅',
        kind: 'sync',
      },
      {from: 'flash_attention', to: 'k/v tile', label: 'keys 16..23: k0 = 16 ≥ q1 = 16 → skipped', kind: 'async'},
      {from: 'm · l · o', to: 'flash_attention', label: 'out[8:16] = o / l', kind: 'reply'},
      {
        from: 'flash_attention',
        to: 'caller',
        label: 'torch.cat(tiles, dim=2) → [2, 3, 37, 16], float32',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Shape the stats as `[B, H, bq, 1]` so they broadcast against `s` (`[B, H, bq, bk]`) and `o` (`[B, H, bq, hd]`): `m = torch.full((B, H, bq, 1), float("-inf"))`, `l = torch.zeros((B, H, bq, 1))`. With `m = -inf`, the first tile gives `alpha = exp(-inf) = 0`, so no special case for the first iteration.',
    'Within a tile the diagonal sits at absolute positions: `rows = torch.arange(q0, q1)[:, None]`, `cols = torch.arange(k0, k1)[None, :]`, `s = s.masked_fill(cols > rows, float("-inf"))`. Only tiles with `k1 > q0 + 1` can contain a masked entry; `k0 >= q1` means the whole tile is in the future — `break`, since later tiles are too.',
    '`exp(-inf - m_new)` is 0 and `exp(s - m_new)` is 0 on masked entries, so neither `l` nor `o` ever sees a NaN as long as every row has at least one unmasked key in its first tile — true for causal self-attention (key 0 is visible to every query). Collect `o / l` per query tile and `torch.cat` on `dim=2`.',
  ],
  checks: [
    {
      id: 'tiled-loops',
      title: 'Loops over query tiles and key/value tiles',
      detail:
        'A `for … in range(0, T, block_q)` over query rows and, inside it, `range(0, T, block_k)` over keys; the query tiles are joined with `torch.cat(…, dim=2)`. T = 37 with 8-row tiles gives a last tile of 5 rows.',
      match: {
        python: {
          all: [
            /for\s+\w+\s+in\s+range\(\s*0\s*,\s*\w+\s*,\s*block_q\s*\)/,
            /for\s+\w+\s+in\s+range\(\s*0\s*,\s*\w+\s*,\s*block_k\s*\)/,
            /torch\.cat\(/,
          ],
        },
      },
    },
    {
      id: 'tile-scores',
      title: 'Scores come one [block_q, block_k] tile at a time, never as the full matrix',
      detail:
        'One matmul of the query tile against the transposed key tile per inner iteration; no `softmax(` and no `scaled_dot_product_attention` inside `flash_attention`. The self-test’s `NoFullScores` mode raises on any `[T, T]` tensor.',
      match: {
        python: {
          all: [/torch\.matmul\(|torch\.einsum\(|\s@\s/, /\.transpose\(\s*-2\s*,\s*-1\s*\)|\.mT\b|\.swapaxes\(/],
          none: [
            /softmax\(/,
            inFlashAttention('scaled_dot_product_attention\\('),
            inFlashAttention('\\.tril\\(|\\.triu\\('),
          ],
        },
      },
    },
    {
      id: 'scale',
      title: 'Scores are scaled by 1 / sqrt(hd)',
      detail:
        'The dot products are multiplied by `1 / math.sqrt(hd)` (or `hd ** -0.5`) before the exponentials; without it the reference comparison fails by far more than 1e-5.',
      match: {python: {all: [/math\.sqrt\(|\*\*\s*-0\.5|torch\.rsqrt\(/]}},
    },
    {
      id: 'running-max',
      title: 'A running max per row, and exp(m_old - m_new) when it moves',
      detail:
        '`m_new = torch.maximum(m, s.amax(-1, keepdim=True))`, `alpha = torch.exp(m - m_new)`, `p = torch.exp(s - m_new)`: every exponential is taken relative to the max seen so far, so no tile can overflow and earlier tiles are rescaled when a later one raises the max.',
      match: {
        python: {
          all: [
            /torch\.maximum\(|torch\.max\(/,
            /\.amax\(|\.max\(/,
            /torch\.exp\(\s*m\w*\s*-\s*m\w*\s*\)|\(\s*m\w*\s*-\s*m\w*\s*\)\.exp\(\)/,
          ],
        },
      },
    },
    {
      id: 'running-sum',
      title: 'A running sum and accumulator rescaled by alpha, normalised once at the end',
      detail:
        '`l = alpha * l + p.sum(-1, keepdim=True)`, `o = alpha * o + p @ v_tile`, and the tile’s output is `o / l` after the last key tile — not a division per tile.',
      match: {
        python: {
          all: [
            /\.sum\(\s*(dim\s*=\s*)?-1\s*,\s*keepdim\s*=\s*True\s*\)/,
            /\bo\w*\s*=\s*\w+\s*\*\s*o\w*\s*\+/,
            /\bl\w*\s*=\s*\w+\s*\*\s*l\w*\s*\+/,
            /\bo\w*\s*\/\s*l\w*\b/,
          ],
        },
      },
    },
    {
      id: 'causal-tiles',
      title: 'Causal mask inside a tile; fully masked tiles skipped',
      detail:
        'Row and column positions from `torch.arange`, `masked_fill(cols > rows, -inf)` on tiles crossing the diagonal, and a `break`/`continue` for key tiles starting at or after the query tile’s end. For T = 37, block 8×8 the last query tile skips nothing and the first skips four tiles.',
      match: {
        python: {
          all: [
            /torch\.arange\(/,
            /masked_fill\(|torch\.where\(/,
            /float\(\s*["']-inf["']\s*\)|-\s*torch\.inf\b|-\s*math\.inf\b/,
            /if\s+causal\b[^\n]*:\s*\n\s*(break|continue)\b/,
          ],
        },
      },
    },
    {
      id: 'float32',
      title: 'Computes in float32 and returns the input dtype',
      detail:
        'Inputs are promoted with `.to(torch.float32)` (float64 kept as float64 so `gradcheck` can run), the tiles accumulate in that dtype, and the result is cast back to the input dtype.',
      match: {python: {all: [/torch\.float32/, /torch\.float64/, /\.to\(\s*\w*dtype\w*\s*\)/]}},
    },
    {
      id: 'autograd',
      title: 'Autograd flows through the loop',
      detail:
        'The self-test’s `torch.autograd.gradcheck` in float64 passes; nothing in `flash_attention` detaches, runs under `torch.no_grad` or leaves the tensor world.',
      match: {
        python: {
          all: [/torch\.autograd\.gradcheck\(/],
          none: [inFlashAttention('torch\\.no_grad\\(|inference_mode\\(|\\.detach\\(\\)|\\.numpy\\(\\)')],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Exact causal attention in query/key tiles with an online softmax: FlashAttention's algorithm, in PyTorch."""

import math

import torch
import torch.nn.functional as F
from torch.overrides import TorchFunctionMode


def flash_attention(
    q: torch.Tensor, k: torch.Tensor, v: torch.Tensor, block_q: int, block_k: int, causal: bool = True
) -> torch.Tensor:
    """Attention over [B, H, T, hd] tensors, one [block_q, block_k] tile of scores at a time.

    Per query tile the row statistics m (running max), l (running sum of exp) and the unnormalised
    output o are carried across key tiles and rescaled by exp(m_old - m_new) whenever the max moves.
    Causal: keys after the query are masked within a tile and tiles entirely after the query tile are
    skipped. Computes in float32 (float64 stays float64) and returns the input dtype.
    """
    B, H, T, hd = q.shape
    assert k.shape == (B, H, T, hd) and v.shape == (B, H, T, hd), "self-attention: q, k, v share [B, H, T, hd]"
    # TODO: promote to float32 (keep float64), scale = 1 / sqrt(hd)
    # TODO: for q0 in range(0, T, block_q): m = -inf, l = 0, o = 0 of shape [B, H, bq, 1] / [B, H, bq, hd]
    # TODO:   for k0 in range(0, T, block_k): skip if causal and k0 >= q1; s = q_tile @ k_tileᵀ * scale;
    # TODO:     mask cols > rows with -inf when the tile crosses the diagonal;
    # TODO:     m_new = max(m, rowmax s); alpha = exp(m - m_new); p = exp(s - m_new);
    # TODO:     l = alpha * l + p.sum(-1); o = alpha * o + p @ v_tile; m = m_new
    # TODO:   collect o / l; torch.cat on dim 2; cast back to the input dtype
    raise NotImplementedError("TODO")


class NoFullScores(TorchFunctionMode):
    """Fails the moment any op produces a tensor with a [T, T] trailing shape: the score matrix was materialised."""

    def __init__(self, seq_len: int):
        super().__init__()
        self.seq_len = seq_len

    def __torch_function__(self, func, types, args=(), kwargs=None):
        result = func(*args, **(kwargs or {}))
        for t in (result if isinstance(result, (tuple, list)) else (result,)):
            if isinstance(t, torch.Tensor) and t.dim() >= 2 and t.shape[-2:] == (self.seq_len, self.seq_len):
                raise AssertionError(f"{func.__name__} produced a [{self.seq_len}, {self.seq_len}] tensor")
        return result


if __name__ == "__main__":
    torch.manual_seed(0)
    B, H, T, hd = 2, 3, 37, 16
    q, k, v = (torch.randn(B, H, T, hd) for _ in range(3))
    ref = F.scaled_dot_product_attention(q, k, v, is_causal=True)
    for block_q, block_k in [(8, 8), (16, 4), (5, 7), (32, 16)]:
        with NoFullScores(T):
            out = flash_attention(q, k, v, block_q, block_k)
        assert out.dtype == torch.float32 and out.shape == (B, H, T, hd)
        err = (out - ref).abs().max().item()
        assert torch.allclose(out, ref, atol=1e-5), f"causal tiles {block_q}x{block_k}: max abs err {err:.3e}"
    assert torch.allclose(flash_attention(q, k, v, 64, 64), ref, atol=1e-5), "tiles larger than T: one tile"
    full = F.scaled_dot_product_attention(q, k, v)
    assert torch.allclose(flash_attention(q, k, v, 8, 8, causal=False), full, atol=1e-5), "non-causal"
    q64, k64, v64 = (torch.randn(1, 2, 7, 4, dtype=torch.float64, requires_grad=True) for _ in range(3))
    assert torch.autograd.gradcheck(lambda a, b, c: flash_attention(a, b, c, 3, 2), (q64, k64, v64))
    print("PASS")
`,
      solution: `"""Exact causal attention in query/key tiles with an online softmax: FlashAttention's algorithm, in PyTorch."""

import math

import torch
import torch.nn.functional as F
from torch.overrides import TorchFunctionMode


def flash_attention(
    q: torch.Tensor, k: torch.Tensor, v: torch.Tensor, block_q: int, block_k: int, causal: bool = True
) -> torch.Tensor:
    """Attention over [B, H, T, hd] tensors, one [block_q, block_k] tile of scores at a time.

    Per query tile the row statistics m (running max), l (running sum of exp) and the unnormalised
    output o are carried across key tiles and rescaled by exp(m_old - m_new) whenever the max moves.
    Causal: keys after the query are masked within a tile and tiles entirely after the query tile are
    skipped. Computes in float32 (float64 stays float64) and returns the input dtype.
    """
    B, H, T, hd = q.shape
    assert k.shape == (B, H, T, hd) and v.shape == (B, H, T, hd), "self-attention: q, k, v share [B, H, T, hd]"
    in_dtype = q.dtype
    acc_dtype = torch.float64 if in_dtype == torch.float64 else torch.float32
    q, k, v = q.to(acc_dtype), k.to(acc_dtype), v.to(acc_dtype)
    scale = 1.0 / math.sqrt(hd)
    tiles = []
    for q0 in range(0, T, block_q):
        q1 = min(q0 + block_q, T)
        q_tile = q[:, :, q0:q1, :]
        m = torch.full((B, H, q1 - q0, 1), float("-inf"), dtype=acc_dtype, device=q.device)
        l = torch.zeros((B, H, q1 - q0, 1), dtype=acc_dtype, device=q.device)
        o = torch.zeros((B, H, q1 - q0, hd), dtype=acc_dtype, device=q.device)
        for k0 in range(0, T, block_k):
            if causal and k0 >= q1:
                break  # this tile and every later one lie entirely after the query tile
            k1 = min(k0 + block_k, T)
            s = torch.matmul(q_tile, k[:, :, k0:k1, :].transpose(-2, -1)) * scale  # [B, H, bq, bk]
            if causal and k1 > q0 + 1:  # the tile crosses the diagonal: mask within it
                rows = torch.arange(q0, q1, device=q.device)[:, None]
                cols = torch.arange(k0, k1, device=q.device)[None, :]
                s = s.masked_fill(cols > rows, float("-inf"))
            m_new = torch.maximum(m, s.amax(dim=-1, keepdim=True))
            alpha = torch.exp(m - m_new)  # 0 on the first tile (m = -inf), <= 1 afterwards
            p = torch.exp(s - m_new)
            l = alpha * l + p.sum(dim=-1, keepdim=True)
            o = alpha * o + torch.matmul(p, v[:, :, k0:k1, :])
            m = m_new
        tiles.append(o / l)
    return torch.cat(tiles, dim=2).to(in_dtype)


class NoFullScores(TorchFunctionMode):
    """Fails the moment any op produces a tensor with a [T, T] trailing shape: the score matrix was materialised."""

    def __init__(self, seq_len: int):
        super().__init__()
        self.seq_len = seq_len

    def __torch_function__(self, func, types, args=(), kwargs=None):
        result = func(*args, **(kwargs or {}))
        for t in (result if isinstance(result, (tuple, list)) else (result,)):
            if isinstance(t, torch.Tensor) and t.dim() >= 2 and t.shape[-2:] == (self.seq_len, self.seq_len):
                raise AssertionError(f"{func.__name__} produced a [{self.seq_len}, {self.seq_len}] tensor")
        return result


if __name__ == "__main__":
    torch.manual_seed(0)
    B, H, T, hd = 2, 3, 37, 16
    q, k, v = (torch.randn(B, H, T, hd) for _ in range(3))
    ref = F.scaled_dot_product_attention(q, k, v, is_causal=True)
    for block_q, block_k in [(8, 8), (16, 4), (5, 7), (32, 16)]:
        with NoFullScores(T):
            out = flash_attention(q, k, v, block_q, block_k)
        assert out.dtype == torch.float32 and out.shape == (B, H, T, hd)
        err = (out - ref).abs().max().item()
        assert torch.allclose(out, ref, atol=1e-5), f"causal tiles {block_q}x{block_k}: max abs err {err:.3e}"
    assert torch.allclose(flash_attention(q, k, v, 64, 64), ref, atol=1e-5), "tiles larger than T: one tile"
    full = F.scaled_dot_product_attention(q, k, v)
    assert torch.allclose(flash_attention(q, k, v, 8, 8, causal=False), full, atol=1e-5), "non-causal"
    q64, k64, v64 = (torch.randn(1, 2, 7, 4, dtype=torch.float64, requires_grad=True) for _ in range(3))
    assert torch.autograd.gradcheck(lambda a, b, c: flash_attention(a, b, c, 3, 2), (q64, k64, v64))
    print("PASS")
`,
    },
  },
  debrief: `The loop is FlashAttention's algorithm with PyTorch ops in place of a kernel. Three decisions carry it. The **running max** \`m\` is what makes streaming exact: a softmax needs the row max before any exponential, so every tile's exponentials are taken against the max seen so far and, when a later tile raises it, the old sum and accumulator are multiplied by \`exp(m_old - m_new)\` — a factor at most 1, so nothing overflows and the final \`o / l\` is the softmax to rounding. The **division happens once**: \`l\` and \`o\` are unnormalised partial sums, which is why they rescale by the same \`alpha\` and why a per-tile division would be both wrong and slower. The **causal mask lives inside the tile**: absolute row and column indices from \`torch.arange\`, so only tiles crossing the diagonal pay for a mask and tiles past it are never computed — half the work for a causal model. What this version leaves on the table is memory for the backward pass: autograd saves every \`p\` tile, so training still holds \`O(T²)\` activations; the real kernel stores only \`m\` and \`l\` per row (as one logsumexp) and **recomputes** \`p\` tile by tile in the backward, trading FLOPs for bytes. The kernel also keeps \`q\`, \`k\`, \`v\` tiles and \`o\` in SRAM for the whole inner loop, which is where the speed comes from; FlashAttention-2 reorders the loops so a thread block owns a query tile and reduces non-matmul work; \`F.scaled_dot_product_attention\` dispatches to that kernel on CUDA, and Triton or \`torch.compile\` let you write this same loop and get a fused kernel out.`,
};
