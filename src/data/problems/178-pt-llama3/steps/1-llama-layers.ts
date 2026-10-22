import type {Step} from '@/lib/types';

export const llamaLayersStep: Step = {
  id: 'llama-layers',
  title: 'Layers: RMSNorm, scaled RoPE, SwiGLU',
  concept: 'pytorch',
  file: 'llama_layers',
  focus: ['attn-norm', 'rope', 'ffn-norm', 'ffn', 'final-norm', 'w1', 'silu', 'w3', 'gate-mul', 'w2'],
  task: `## Task

Write the three layers every Llama 3 block is made of, in \`llama_layers.py\`, the way Meta's reference
\`model.py\` writes them. No \`nn.RMSNorm\`, \`F.rms_norm\` or \`nn.LayerNorm\`, and no Hugging Face
\`rotate_half\`: Meta's checkpoints rotate **adjacent** pairs.

- \`RMSNorm(dim, eps=1e-5)\`: a \`weight\` of ones, no bias, no mean subtraction.
  \`_norm(x) = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps)\`; \`forward\` computes it on
  \`x.float()\`, casts back with \`.type_as(x)\`, then multiplies by \`weight\`. A bf16 input gives a bf16
  output whose statistics were taken in float32.
- \`RopeScaling\` (given): \`factor=8\`, \`low_freq_factor=1\`, \`high_freq_factor=4\`,
  \`original_max_position_embeddings=8192\`, the Llama 3.1 values.
- \`scale_rope_freqs(freqs, scaling)\`: with \`wavelen = 2π / freq\`, keep frequencies whose wavelength is
  under \`8192 / 4 = 2048\` tokens, divide those over \`8192 / 1 = 8192\` by \`factor\`, and in between blend
  \`(1 − smooth) · freq / factor + smooth · freq\` with \`smooth = (8192 / wavelen − 1) / (4 − 1)\`.
- \`precompute_rope(head_dim, max_seq_len, theta=500000.0, scaling=RopeScaling())\`: \`freq_j =
  theta^(−2j / head_dim)\` for \`j < head_dim / 2\` (float32), scaled unless \`scaling is None\`, then
  \`torch.outer(positions, freqs)\` and \`torch.polar\`: a \`(max_seq_len, head_dim // 2)\` complex64 table of
  unit numbers \`e^(i·m·freq_j)\`.
- \`apply_rope(xq, xk, freqs_cis)\`: \`xq\` is \`(B, T, n_heads, hd)\`, \`xk\` is \`(B, T, n_kv_heads, hd)\`,
  \`freqs_cis\` is \`(T, hd // 2)\`. View dims \`(2j, 2j + 1)\` as one complex number
  (\`torch.view_as_complex\` on \`x.float().reshape(..., -1, 2)\`), multiply by the row for its position,
  \`torch.view_as_real(...).flatten(3)\`, and \`.type_as\` the input.
- \`ffn_hidden_dim(hidden_dim, multiple_of, ffn_dim_multiplier=None)\`, called with \`4 * dim\`:
  \`int(2 * hidden_dim / 3)\`, then \`int(ffn_dim_multiplier * ...)\` when given, rounded **up** to a multiple
  of \`multiple_of\`. Llama 3 8B: \`int(16384 · 2/3) = 10922\`, \`× 1.3 → 14198\`, up to a multiple of 1,024:
  **14,336**.
- \`FeedForward(dim, hidden_dim, multiple_of, ffn_dim_multiplier)\`: bias-free \`w1\` (gate) and \`w3\` (up)
  \`dim → hidden\`, \`w2\` (down) \`hidden → dim\`; \`forward = w2(F.silu(w1(x)) * w3(x))\`.

:::widget rope-rotation

The self-test checks \`RMSNorm\` against the formula in float64 (1e-5) and the bf16 path bit for bit, the
unscaled table against \`math.cos\` / \`math.sin\`, every scaled frequency against a slow version with the
constants written out (29 pairs kept, 29 divided by 8, 6 blended for \`head_dim = 128\`),
\`apply_rope\` against the pairwise rotation, that norms survive the rotation, that \`q·k\` after rotation
depends only on \`m − n\`, the widths 14,336 (8B) and 28,672 (70B), and SwiGLU against explicit
matrices, then prints \`PASS\`.

> A rotation by \`m·θ\` on q and \`n·θ\` on k leaves \`q·k\` a function of \`m − n\` alone: position enters
> attention as a relative offset, and the 3.1 scaling only slows the rotations whose period is longer
> than the 8K context Llama 3 was pretrained on.`,
  hints: [
    'RMSNorm is two lines: `self._norm(x.float()).type_as(x) * self.weight`, with `_norm` the `rsqrt` of the mean square plus `eps`. Upcasting first matters in bf16: the mean of 4,096 squares in 7 mantissa bits is far off.',
    'The scaling is two `torch.where` calls on `wavelen = 2 * math.pi / freqs`: first divide where `wavelen > 8192`, then replace the band `2048 <= wavelen <= 8192` with the blend. For `apply_rope`, `xq.float().reshape(*xq.shape[:-1], -1, 2)` turns the last axis into pairs; `freqs_cis.view(1, T, 1, hd // 2)` broadcasts over batch and heads.',
    'Rounding up to a multiple: `multiple_of * ((h + multiple_of - 1) // multiple_of)`. Apply `int(...)` after the 2/3 and again after the multiplier, as Meta does, or 8B comes out one block off.',
  ],
  checks: [
    {
      id: 'rmsnorm',
      title: 'RMSNorm in float32, cast back',
      detail:
        'The reciprocal root of `x.pow(2).mean(-1, keepdim=True) + eps` (`torch.rsqrt`), computed on `x.float()` and cast back with `.type_as(x)` before the weight. No `nn.RMSNorm`, `F.rms_norm` or `nn.LayerNorm`: the normaliser is the point.',
      match: {
        python: {
          all: [
            /torch\.rsqrt\(|\/\s*torch\.sqrt\(/,
            /\.mean\(\s*(?:dim\s*=\s*)?-1\s*,\s*keepdim\s*=\s*True\s*\)/,
            /\.float\(\)/,
            /\.type_as\(\s*x\s*\)|\.to\(\s*x\.dtype\s*\)/,
          ],
          none: [/nn\.RMSNorm/, /F\.rms_norm/, /nn\.LayerNorm/],
        },
      },
    },
    {
      id: 'rope-table',
      title: 'Frequencies theta^(-2j/d) as a table of unit complex numbers',
      detail:
        '`theta ** (torch.arange(0, head_dim, 2) / head_dim)` gives one frequency per pair; `torch.outer` with the positions gives every angle and `torch.polar` (or cos and sin) turns them into the `(max_seq_len, head_dim // 2)` table.',
      match: {
        python: {
          all: [/theta\s*\*\*/, /torch\.outer\(|\[\s*:\s*,\s*None\s*\]\s*\*/, /torch\.polar\(|torch\.(?:cos|sin)\(/],
        },
      },
    },
    {
      id: 'rope-scaling',
      title: 'Llama 3.1 scaling by wavelength',
      detail:
        'Wavelengths `2π / freq` are compared with `8192 / low_freq_factor` and `8192 / high_freq_factor`; the band in between blends with `smooth = (8192 / wavelen - low_freq_factor) / (high_freq_factor - low_freq_factor)`. Long wavelengths are divided by `factor`, short ones kept.',
      match: {
        python: {
          all: [
            /2\s*\*\s*(?:math|torch)\.pi\s*\/|(?:math|torch)\.tau\s*\//,
            /\/\s*(?:\w+\.)?low_freq_factor/,
            /\/\s*(?:\w+\.)?high_freq_factor/,
            /-\s*(?:\w+\.)?low_freq_factor\s*\)\s*\/\s*\(\s*(?:\w+\.)?high_freq_factor\s*-\s*(?:\w+\.)?low_freq_factor\s*\)/,
          ],
        },
      },
    },
    {
      id: 'apply-rope',
      title: 'Adjacent pairs rotated as complex numbers, not halves',
      detail:
        'Dims `(2j, 2j + 1)` form one complex number (`torch.view_as_complex` of the last axis reshaped to `(-1, 2)`, or the even and odd slices `[..., ::2]` / `[..., 1::2]`), multiplied by `freqs_cis` and cast back with `.type_as`. `rotate_half` pairs `j` with `j + hd/2`, which does not match Meta’s weights.',
      match: {
        python: {
          all: [
            /view_as_complex\(|\[\s*\.\.\.\s*,\s*0?\s*::\s*2\s*\]/,
            /\.type_as\(\s*xq\s*\)|\.to\(\s*xq\.dtype\s*\)/,
          ],
          none: [/rotate_half/],
        },
      },
    },
    {
      id: 'ffn-width',
      title: "Meta's SwiGLU width: 2/3 of 4d, multiplier, rounded up",
      detail:
        '`int(2 * hidden_dim / 3)`, times `ffn_dim_multiplier` when set, then rounded **up** to a multiple of `multiple_of` with `//`: 14,336 for Llama 3 8B, 28,672 for 70B.',
      match: {
        python: {
          all: [/int\(\s*2\s*\*\s*\w+\s*\/\s*3\s*\)/, /\/\/\s*multiple_of|math\.ceil\([^\n]*multiple_of/],
        },
      },
    },
    {
      id: 'swiglu',
      title: 'SwiGLU: w2(silu(w1 x) * w3 x), no biases',
      detail:
        'Three `nn.Linear(..., bias=False)`; the SiLU of the gate `w1(x)` multiplies the up projection `w3(x)` elementwise and `w2` maps back to `dim`.',
      match: {
        python: {
          all: [/F\.silu\(|nn\.SiLU\(\)/, /self\.w2\(/, /self\.w3\(/, /nn\.Linear\([^\n]*bias\s*=\s*False/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Llama 3's layers as Meta's reference model.py writes them: RMSNorm, rotary embeddings with the Llama 3.1
frequency scaling, and the SwiGLU feed-forward with Meta's hidden-width rule."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


class RMSNorm(nn.Module):
    """x / sqrt(mean(x^2) + eps) * weight, over the last axis; no mean subtraction, no bias."""

    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def _norm(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: x times the reciprocal RMS over the last axis, eps inside the root")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: normalise in float32, cast back to x's dtype, then scale by weight")


@dataclass
class RopeScaling:
    """Llama 3.1's frequency scaling: the values in Meta's apply_scaling and in the 3.1 params.json."""

    factor: float = 8.0
    low_freq_factor: float = 1.0
    high_freq_factor: float = 4.0
    original_max_position_embeddings: int = 8192


def scale_rope_freqs(freqs: torch.Tensor, scaling: RopeScaling) -> torch.Tensor:
    """Keep short wavelengths, divide long ones by the factor, interpolate smoothly in between."""
    raise NotImplementedError("TODO: wavelengths 2*pi/freq; keep < 2048, divide > 8192 by factor, blend between")


def precompute_rope(
    head_dim: int,
    max_seq_len: int,
    theta: float = 500000.0,
    scaling: RopeScaling | None = RopeScaling(),
) -> torch.Tensor:
    """(max_seq_len, head_dim // 2) complex64: e^(i * m * freq_j) for position m and pair j."""
    raise NotImplementedError("TODO: freq_j = theta^(-2j/head_dim), scaled, outer with positions, as unit complex")


def apply_rope(xq: torch.Tensor, xk: torch.Tensor, freqs_cis: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """xq (B, T, H, hd), xk (B, T, KV, hd), freqs_cis (T, hd // 2): rotate dims (2j, 2j + 1) by m * freq_j."""
    raise NotImplementedError("TODO: adjacent pairs as complex numbers, multiply by freqs_cis, back to real, cast back")


def ffn_hidden_dim(hidden_dim: int, multiple_of: int, ffn_dim_multiplier: float | None = None) -> int:
    """Meta's rule, called with hidden_dim = 4 * dim: two thirds, times the multiplier, rounded up to multiple_of."""
    raise NotImplementedError("TODO: int(2/3 of hidden_dim), times ffn_dim_multiplier, round up to multiple_of")


class FeedForward(nn.Module):
    """SwiGLU: w2(silu(w1(x)) * w3(x)), three bias-free matrices."""

    def __init__(self, dim: int, hidden_dim: int, multiple_of: int, ffn_dim_multiplier: float | None):
        super().__init__()
        raise NotImplementedError("TODO: w1 (gate) and w3 (up) dim -> hidden, w2 (down) hidden -> dim, no biases")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: w2(silu(w1(x)) * w3(x))")


if __name__ == "__main__":
    torch.manual_seed(0)

    # RMSNorm against the formula in float64, then the bf16 path: statistics in float32, result in bf16.
    dim = 16
    norm = RMSNorm(dim)
    with torch.no_grad():
        norm.weight.uniform_(0.5, 1.5)
    x = torch.randn(3, 5, dim) * 3
    xd = x.double()
    want = xd * (xd.square().sum(-1, keepdim=True) / dim + 1e-5) ** -0.5 * norm.weight.double()
    got = norm(x)
    assert got.dtype == torch.float32 and torch.allclose(got.double(), want, atol=1e-5), (got.double() - want).abs().max()
    norm_bf16 = RMSNorm(dim).to(torch.bfloat16)
    xb = (torch.randn(4, dim) * 40).to(torch.bfloat16)
    x32 = xb.to(torch.float32)
    stats32 = (x32 * (x32.square().sum(-1, keepdim=True) / dim + 1e-5) ** -0.5).to(torch.bfloat16)
    out = norm_bf16(xb)
    assert out.dtype == torch.bfloat16 and torch.equal(out, stats32 * norm_bf16.weight), "bf16 in, float32 statistics, bf16 out"

    # Base frequencies theta^(-2j/d), unscaled, against math.
    hd, theta = 128, 500000.0
    plain = precompute_rope(hd, 4, theta, scaling=None)
    assert plain.shape == (4, hd // 2) and plain.dtype == torch.complex64
    base = [math.pow(theta, -2 * j / hd) for j in range(hd // 2)]
    for j in (0, 1, 31, 63):
        z = plain[3, j].item()
        assert abs(z.real - math.cos(3 * base[j])) < 1e-5 and abs(z.imag - math.sin(3 * base[j])) < 1e-5, j

    # Llama 3.1 scaling against a slow per-frequency version with the constants written out.
    def scaled_reference(f: float) -> float:
        wavelength = math.tau / f
        if wavelength < 8192 / 4:
            return f
        if wavelength > 8192 / 1:
            return f / 8
        s = (8192 / wavelength - 1) / (4 - 1)
        return (1 - s) * f / 8 + s * f

    scaled = precompute_rope(hd, 2, theta)
    for j in range(hd // 2):
        angle = math.atan2(scaled[1, j].imag.item(), scaled[1, j].real.item())
        assert abs(angle - scaled_reference(base[j])) < 1e-6 * max(1.0, base[j]), (j, angle, scaled_reference(base[j]))
    kept = sum(scaled_reference(f) == f for f in base)
    divided = sum(abs(scaled_reference(f) - f / 8) < 1e-15 for f in base)
    assert (kept, divided) == (29, 29), (kept, divided)  # pairs 29 to 34 are interpolated
    assert torch.allclose(scaled.abs(), torch.ones(2, hd // 2)), "every factor is a unit complex number"

    # apply_rope against the pairwise rotation, written out for every pair.
    B, T, H, KV, d = 2, 6, 4, 2, 8
    freqs_cis = precompute_rope(d, T, theta=10000.0, scaling=None)
    q, k = torch.randn(B, T, H, d), torch.randn(B, T, KV, d)
    rq, rk = apply_rope(q, k, freqs_cis)
    assert rq.shape == q.shape and rk.shape == k.shape
    for m in range(T):
        for j in range(d // 2):
            c, s = freqs_cis[m, j].real, freqs_cis[m, j].imag
            a, b = q[:, m, :, 2 * j], q[:, m, :, 2 * j + 1]
            assert torch.allclose(rq[:, m, :, 2 * j], a * c - b * s, atol=1e-6)
            assert torch.allclose(rq[:, m, :, 2 * j + 1], a * s + b * c, atol=1e-6)
    assert torch.allclose(rq.norm(dim=-1), q.norm(dim=-1), atol=1e-5), "a rotation preserves every head's norm"
    assert torch.allclose(rk.norm(dim=-1), k.norm(dim=-1), atol=1e-5)
    rqb, _ = apply_rope(q.to(torch.bfloat16), k.to(torch.bfloat16), freqs_cis)
    assert rqb.dtype == torch.bfloat16

    # q . k after rotation depends only on the distance m - n: one q and one k placed at every position.
    long_cis = precompute_rope(hd, 64, theta)
    qv, kv = torch.randn(hd), torch.randn(hd)
    qs, ks = apply_rope(qv.expand(1, 64, 1, hd), kv.expand(1, 64, 1, hd), long_cis)
    dots = qs[0, :, 0] @ ks[0, :, 0].T  # dots[m, n]
    for dist in (0, 3, 17):
        diag = torch.stack([dots[n + dist, n] for n in range(64 - dist)])
        assert torch.allclose(diag, diag[0].expand_as(diag), atol=1e-3), (dist, diag.min(), diag.max())
    assert not torch.allclose(dots[3, 0], dots[4, 0], atol=1e-3)

    # SwiGLU width: Meta's rule gives 14,336 for Llama 3 8B and 28,672 for 70B.
    assert ffn_hidden_dim(4 * 4096, 1024, 1.3) == 14336
    assert ffn_hidden_dim(4 * 8192, 4096, 1.3) == 28672
    assert ffn_hidden_dim(4 * 64, 32, None) == 192

    # FeedForward against w2(h1 * sigmoid(h1) * h3) with explicit matrices, and no biases anywhere.
    ff = FeedForward(64, 4 * 64, 32, None)
    assert ff.w1.weight.shape == (192, 64) and ff.w3.weight.shape == (192, 64) and ff.w2.weight.shape == (64, 192)
    assert all(name.endswith("weight") for name, _ in ff.named_parameters()), "SwiGLU has no biases"
    xf = torch.randn(3, 7, 64)
    h1, h3 = xf @ ff.w1.weight.T, xf @ ff.w3.weight.T
    want = (h1 * torch.sigmoid(h1) * h3) @ ff.w2.weight.T
    assert torch.allclose(ff(xf), want, atol=1e-5)
    print("PASS")
`,
      solution: `"""Llama 3's layers as Meta's reference model.py writes them: RMSNorm, rotary embeddings with the Llama 3.1
frequency scaling, and the SwiGLU feed-forward with Meta's hidden-width rule."""

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


class RMSNorm(nn.Module):
    """x / sqrt(mean(x^2) + eps) * weight, over the last axis; no mean subtraction, no bias."""

    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def _norm(self, x: torch.Tensor) -> torch.Tensor:
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # The statistics in float32 whatever the activations are; the result goes back to x's dtype.
        return self._norm(x.float()).type_as(x) * self.weight


@dataclass
class RopeScaling:
    """Llama 3.1's frequency scaling: the values in Meta's apply_scaling and in the 3.1 params.json."""

    factor: float = 8.0
    low_freq_factor: float = 1.0
    high_freq_factor: float = 4.0
    original_max_position_embeddings: int = 8192


def scale_rope_freqs(freqs: torch.Tensor, scaling: RopeScaling) -> torch.Tensor:
    """Keep short wavelengths, divide long ones by the factor, interpolate smoothly in between."""
    old_context_len = scaling.original_max_position_embeddings
    low_freq_wavelen = old_context_len / scaling.low_freq_factor  # 8192: longer is divided by factor
    high_freq_wavelen = old_context_len / scaling.high_freq_factor  # 2048: shorter is kept
    wavelen = 2 * math.pi / freqs
    new_freqs = torch.where(wavelen > low_freq_wavelen, freqs / scaling.factor, freqs)
    smooth = (old_context_len / wavelen - scaling.low_freq_factor) / (
        scaling.high_freq_factor - scaling.low_freq_factor
    )
    mid = (wavelen >= high_freq_wavelen) & (wavelen <= low_freq_wavelen)
    return torch.where(mid, (1 - smooth) * freqs / scaling.factor + smooth * freqs, new_freqs)


def precompute_rope(
    head_dim: int,
    max_seq_len: int,
    theta: float = 500000.0,
    scaling: RopeScaling | None = RopeScaling(),
) -> torch.Tensor:
    """(max_seq_len, head_dim // 2) complex64: e^(i * m * freq_j) for position m and pair j."""
    freqs = 1.0 / (theta ** (torch.arange(0, head_dim, 2)[: head_dim // 2].float() / head_dim))
    if scaling is not None:
        freqs = scale_rope_freqs(freqs, scaling)
    t = torch.arange(max_seq_len, dtype=torch.float32)
    angles = torch.outer(t, freqs)  # (max_seq_len, head_dim // 2)
    return torch.polar(torch.ones_like(angles), angles)


def apply_rope(xq: torch.Tensor, xk: torch.Tensor, freqs_cis: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """xq (B, T, H, hd), xk (B, T, KV, hd), freqs_cis (T, hd // 2): rotate dims (2j, 2j + 1) by m * freq_j."""
    xq_ = torch.view_as_complex(xq.float().reshape(*xq.shape[:-1], -1, 2))
    xk_ = torch.view_as_complex(xk.float().reshape(*xk.shape[:-1], -1, 2))
    rot = freqs_cis.view(1, xq_.shape[1], 1, xq_.shape[-1])  # broadcast over batch and heads
    xq_out = torch.view_as_real(xq_ * rot).flatten(3)
    xk_out = torch.view_as_real(xk_ * rot).flatten(3)
    return xq_out.type_as(xq), xk_out.type_as(xk)


def ffn_hidden_dim(hidden_dim: int, multiple_of: int, ffn_dim_multiplier: float | None = None) -> int:
    """Meta's rule, called with hidden_dim = 4 * dim: two thirds, times the multiplier, rounded up to multiple_of."""
    hidden_dim = int(2 * hidden_dim / 3)
    if ffn_dim_multiplier is not None:
        hidden_dim = int(ffn_dim_multiplier * hidden_dim)
    return multiple_of * ((hidden_dim + multiple_of - 1) // multiple_of)


class FeedForward(nn.Module):
    """SwiGLU: w2(silu(w1(x)) * w3(x)), three bias-free matrices."""

    def __init__(self, dim: int, hidden_dim: int, multiple_of: int, ffn_dim_multiplier: float | None):
        super().__init__()
        hidden_dim = ffn_hidden_dim(hidden_dim, multiple_of, ffn_dim_multiplier)
        self.w1 = nn.Linear(dim, hidden_dim, bias=False)  # gate
        self.w2 = nn.Linear(hidden_dim, dim, bias=False)  # down
        self.w3 = nn.Linear(dim, hidden_dim, bias=False)  # up

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.w2(F.silu(self.w1(x)) * self.w3(x))


if __name__ == "__main__":
    torch.manual_seed(0)

    # RMSNorm against the formula in float64, then the bf16 path: statistics in float32, result in bf16.
    dim = 16
    norm = RMSNorm(dim)
    with torch.no_grad():
        norm.weight.uniform_(0.5, 1.5)
    x = torch.randn(3, 5, dim) * 3
    xd = x.double()
    want = xd * (xd.square().sum(-1, keepdim=True) / dim + 1e-5) ** -0.5 * norm.weight.double()
    got = norm(x)
    assert got.dtype == torch.float32 and torch.allclose(got.double(), want, atol=1e-5), (got.double() - want).abs().max()
    norm_bf16 = RMSNorm(dim).to(torch.bfloat16)
    xb = (torch.randn(4, dim) * 40).to(torch.bfloat16)
    x32 = xb.to(torch.float32)
    stats32 = (x32 * (x32.square().sum(-1, keepdim=True) / dim + 1e-5) ** -0.5).to(torch.bfloat16)
    out = norm_bf16(xb)
    assert out.dtype == torch.bfloat16 and torch.equal(out, stats32 * norm_bf16.weight), "bf16 in, float32 statistics, bf16 out"

    # Base frequencies theta^(-2j/d), unscaled, against math.
    hd, theta = 128, 500000.0
    plain = precompute_rope(hd, 4, theta, scaling=None)
    assert plain.shape == (4, hd // 2) and plain.dtype == torch.complex64
    base = [math.pow(theta, -2 * j / hd) for j in range(hd // 2)]
    for j in (0, 1, 31, 63):
        z = plain[3, j].item()
        assert abs(z.real - math.cos(3 * base[j])) < 1e-5 and abs(z.imag - math.sin(3 * base[j])) < 1e-5, j

    # Llama 3.1 scaling against a slow per-frequency version with the constants written out.
    def scaled_reference(f: float) -> float:
        wavelength = math.tau / f
        if wavelength < 8192 / 4:
            return f
        if wavelength > 8192 / 1:
            return f / 8
        s = (8192 / wavelength - 1) / (4 - 1)
        return (1 - s) * f / 8 + s * f

    scaled = precompute_rope(hd, 2, theta)
    for j in range(hd // 2):
        angle = math.atan2(scaled[1, j].imag.item(), scaled[1, j].real.item())
        assert abs(angle - scaled_reference(base[j])) < 1e-6 * max(1.0, base[j]), (j, angle, scaled_reference(base[j]))
    kept = sum(scaled_reference(f) == f for f in base)
    divided = sum(abs(scaled_reference(f) - f / 8) < 1e-15 for f in base)
    assert (kept, divided) == (29, 29), (kept, divided)  # pairs 29 to 34 are interpolated
    assert torch.allclose(scaled.abs(), torch.ones(2, hd // 2)), "every factor is a unit complex number"

    # apply_rope against the pairwise rotation, written out for every pair.
    B, T, H, KV, d = 2, 6, 4, 2, 8
    freqs_cis = precompute_rope(d, T, theta=10000.0, scaling=None)
    q, k = torch.randn(B, T, H, d), torch.randn(B, T, KV, d)
    rq, rk = apply_rope(q, k, freqs_cis)
    assert rq.shape == q.shape and rk.shape == k.shape
    for m in range(T):
        for j in range(d // 2):
            c, s = freqs_cis[m, j].real, freqs_cis[m, j].imag
            a, b = q[:, m, :, 2 * j], q[:, m, :, 2 * j + 1]
            assert torch.allclose(rq[:, m, :, 2 * j], a * c - b * s, atol=1e-6)
            assert torch.allclose(rq[:, m, :, 2 * j + 1], a * s + b * c, atol=1e-6)
    assert torch.allclose(rq.norm(dim=-1), q.norm(dim=-1), atol=1e-5), "a rotation preserves every head's norm"
    assert torch.allclose(rk.norm(dim=-1), k.norm(dim=-1), atol=1e-5)
    rqb, _ = apply_rope(q.to(torch.bfloat16), k.to(torch.bfloat16), freqs_cis)
    assert rqb.dtype == torch.bfloat16

    # q . k after rotation depends only on the distance m - n: one q and one k placed at every position.
    long_cis = precompute_rope(hd, 64, theta)
    qv, kv = torch.randn(hd), torch.randn(hd)
    qs, ks = apply_rope(qv.expand(1, 64, 1, hd), kv.expand(1, 64, 1, hd), long_cis)
    dots = qs[0, :, 0] @ ks[0, :, 0].T  # dots[m, n]
    for dist in (0, 3, 17):
        diag = torch.stack([dots[n + dist, n] for n in range(64 - dist)])
        assert torch.allclose(diag, diag[0].expand_as(diag), atol=1e-3), (dist, diag.min(), diag.max())
    assert not torch.allclose(dots[3, 0], dots[4, 0], atol=1e-3)

    # SwiGLU width: Meta's rule gives 14,336 for Llama 3 8B and 28,672 for 70B.
    assert ffn_hidden_dim(4 * 4096, 1024, 1.3) == 14336
    assert ffn_hidden_dim(4 * 8192, 4096, 1.3) == 28672
    assert ffn_hidden_dim(4 * 64, 32, None) == 192

    # FeedForward against w2(h1 * sigmoid(h1) * h3) with explicit matrices, and no biases anywhere.
    ff = FeedForward(64, 4 * 64, 32, None)
    assert ff.w1.weight.shape == (192, 64) and ff.w3.weight.shape == (192, 64) and ff.w2.weight.shape == (64, 192)
    assert all(name.endswith("weight") for name, _ in ff.named_parameters()), "SwiGLU has no biases"
    xf = torch.randn(3, 7, 64)
    h1, h3 = xf @ ff.w1.weight.T, xf @ ff.w3.weight.T
    want = (h1 * torch.sigmoid(h1) * h3) @ ff.w2.weight.T
    assert torch.allclose(ff(xf), want, atol=1e-5)
    print("PASS")
`,
    },
  },
  debrief: `Each of the three is a stability or efficiency choice the LLaMA line made in 2023 and Llama 3 kept.
**RMSNorm** drops LayerNorm's mean and bias: one reduction instead of two, and the
[RMSNorm paper](https://arxiv.org/abs/1910.07467) found re-centring added nothing. The float32 upcast is
the part people forget: a bf16 mean of 4,096 squares has 7 mantissa bits, so the reference code takes the
statistics in float32 and only the scaled result goes back to bf16.

**RoPE** stores no position table. Each pair of dims turns by \`m · freq_j\`, so the dot product of a query
at \`m\` and a key at \`n\` sees only \`m − n\`, and the cache can hold keys already rotated. Llama 3 raised
\`theta\` from 10,000 to 500,000 so the slowest pairs barely turn within 8K tokens; Llama 3.1 then
extended the context to 128K without retraining from scratch by dividing the long-wavelength frequencies
by 8 (position interpolation for the pairs that would otherwise see angles never met in training) and
leaving the short ones, which carry local order, alone. vLLM and Hugging Face call this
\`rope_type: "llama3"\`; production kernels fuse the rotation into the QKV projection and keep the table
in cos/sin form instead of complex numbers.

**SwiGLU** replaces GELU's one up-projection with a gate and an up-projection. Three matrices instead
of two would cost 50 % more, so the width shrinks to 2/3 · 4d; the multiplier and the rounding to 1,024
are what make 8B's 14,336 (a multiple of 1,024, good for tensor cores and for splitting across 8 GPUs).`,
};
