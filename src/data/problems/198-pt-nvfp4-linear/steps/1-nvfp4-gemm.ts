import type {Step} from '@/lib/types';

/** Matches `pattern` inside the body of top-level `def name` (up to the next top-level statement). */
const inDef = (name: string, pattern: string): RegExp =>
  new RegExp(String.raw`def ${name}\b(?:(?!\n(?:def |class |@|if __name__))[\s\S])*?` + pattern);

/** Matches `pattern` inside the body of method `def name` (up to the next method or top-level statement). */
const inMethod = (name: string, pattern: string): RegExp =>
  new RegExp(String.raw`def ${name}\b(?:(?!\n[ \t]*(?:def |@)|\n(?:class |if __name__))[\s\S])*?` + pattern);

/** Matches `pattern` inside `class NVFP4Linear`. */
const inClass = (pattern: string): RegExp =>
  new RegExp(String.raw`class NVFP4Linear\b(?:(?!\n(?:def |class |@|if __name__))[\s\S])*?` + pattern);

export const nvfp4GemmStep: Step = {
  id: 'nvfp4-gemm',
  title: 'The block-scaled GEMM and NVFP4Linear',
  concept: 'pytorch',
  file: 'nvfp4_gemm',
  focus: [
    'x-in',
    'act-quant',
    'calib-amax',
    'w-nvfp4',
    'block-dot',
    'block-scale',
    'global-scale',
    'bias-add',
    'g-a',
    'g-sfa',
    'g-b',
    'g-sfb',
    'g-acc',
  ],
  task: `## Task

A Blackwell tensor core never dequantizes an NVFP4 operand. It multiplies 4-bit values block by block and
applies the block scales to the partial sums. Write that GEMM, then a linear layer built on it.

The file gives the canonical NVFP4 quantizer, already implemented:
- \`e2m1_round(x)\`: the nearest of ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}, ties to the even mantissa, saturating at ±6.
- \`e2m1_encode\`, \`pack_fp4\` and \`unpack_fp4\`: the code is sign bit 3, exponent bits 2..1, mantissa bit 0,
  two codes per byte, low nibble first. \`FP4_LUT[code]\` is the value.
- \`global_scale(amax)\`: the per-tensor FP32 decode scale \`amax / (6 · 448)\`, or 1 when \`amax\` is 0.
- \`NVFP4Tensor(codes, scales, s_global)\`: \`codes (rows, K/2)\` uint8, \`scales (rows, K/16)\`
  \`torch.float8_e4m3fn\`, \`s_global ()\` float32. \`.values()\` returns the E2M1 values, \`(rows, K/16, 16)\` float32.
- \`nvfp4_quantize(x, s_global=None)\` along K: \`s_block = e4m3(min(amax_block / 6 / s_global, 448))\`,
  \`q = e2m1(x / (s_block · s_global))\`, and a block whose scale is 0 encodes zeros. Without \`s_global\`, the
  scale comes from \`amax(|x|)\`.
- \`nvfp4_dequantize(t) = q · s_block · s_global\`, \`(rows, K)\` float32.

Write:
- \`nvfp4_matmul(a, b) -> (M, N)\` float32, for \`a\` of shape \`(M, K)\` and \`b\` of shape \`(N, K)\`, both
  \`NVFP4Tensor\`. With \`qa\`, \`qb\` the E2M1 values, \`s_a\`, \`s_b\` the block scales and \`g_a\`, \`g_b\` the
  global scales:

\`\`\`text
P[m, n, b] = Σ_(k in b) qa[m, k] · qb[n, k]
acc[m, n]  = Σ_b P[m, n, b] · s_a[m, b] · s_b[n, b]
out[m, n]  = acc[m, n] · g_a · g_b
\`\`\`

- \`P\` is exact: each product is a multiple of 1/4 no larger than 36 in magnitude, so 16 of them sum to at
  most 576.
- Forbidden in \`nvfp4_matmul\`: \`nvfp4_dequantize\`, \`torch._scaled_mm\`, Transformer Engine, ModelOpt and
  torchao.
- \`NVFP4Linear\`'s \`__init__\` (given) registers the buffers \`w_codes\`, \`w_scales\`, \`w_global\`, \`act_amax\`
  (0 means not calibrated) and \`bias\`.
- \`NVFP4Linear.from_linear(linear, act_amax=None)\` (classmethod) quantizes \`linear.weight\` **once**, with its
  own global scale. It stores \`act_amax\` when given and copies the bias as float32. The layer has no parameters.
- \`forward(x)\` takes \`x\` of shape \`(..., in)\`. It flattens \`x\` to \`(tokens, in)\` and quantizes it along K
  on every call, with \`global_scale(act_amax)\` once calibrated and \`x\`'s own amax otherwise. Then
  \`nvfp4_matmul\` with the weight, the bias added in float, and the result reshaped to \`(..., out)\`.

:::widget nvfp4-block {"outlier": false}

The self-test runs \`M, N, K = 48, 64, 512\` with uneven rows and asserts:
- the GEMM equals dequantize-then-matmul to \`1e-5\` of \`max |out|\` (one run: \`5.7e-7\`);
- it matches a float64 loop over the blocks to \`1e-6\`, and every block's dot product is a multiple of 1/4;
- it is \`0.01\` to \`0.15\` away from the fp32 \`a @ w.T\` in relative norm (one run: \`0.130\`): quantization error
  and nothing else.

On \`NVFP4Linear\` over \`nn.Linear(256, 96)\`, it asserts:
- no parameters, packed \`(96, 128)\` uint8 codes and \`(96, 16)\` scales: 4.5 bits per weight;
- outputs equal to the dequantized reference, and a zero input returning the bias exactly;
- a relative output error under \`0.15\`, both dynamic and calibrated on eight batches (one run: \`0.139\` for both);
- an input 8× past the calibrated amax stays finite but clips: \`0.600\` relative error, more than twice the in-range error.

Then it prints \`PASS\`.

> A block-scaled GEMM does the 4-bit products exactly and spends the precision on the scales. One E4M3
> number per 16 values, applied once per partial sum, and one FP32 number per tensor, applied once per output.`,
  hints: [
    '`a.values()` and `b.values()` give `(M, nb, 16)` and `(N, nb, 16)`. `torch.einsum("mbk,nbk->mnb", qa, qb)` is every block’s dot product at once, `(M, N, nb)`.',
    'Broadcast the scales to the partial sums: `a.scales.float()[:, None, :]` is `(M, 1, nb)` and `b.scales.float()[None, :, :]` is `(1, N, nb)`. Sum over the last axis, then multiply by `a.s_global * b.s_global`.',
    'In `forward`, `s_x = global_scale(self.act_amax) if self.act_amax > 0 else None` picks the scale. `nvfp4_quantize(x2, s_x)` handles both, and the weight is `NVFP4Tensor(self.w_codes, self.w_scales, self.w_global)`.',
  ],
  checks: [
    {
      id: 'block-dot',
      title: 'One FP4 dot product per block',
      detail:
        '`nvfp4_matmul` contracts the 16 values of each block on their own (an `einsum` or a batched matmul that keeps the block axis), the way the tensor core does before any scale is applied.',
      match: {python: {all: [inDef('nvfp4_matmul', String.raw`(?:einsum\(|bmm\(|matmul\(|\s@\s|\*[^\n]*\.sum\()`)]}},
    },
    {
      id: 'block-scales',
      title: 'Both operands’ block scales on the partial sums',
      detail:
        'Each partial sum is multiplied by `s_a[m, blk] · s_b[n, blk]`: the scales of the same K block of a row of A and a row of B.',
      match: {python: {all: [inDef('nvfp4_matmul', String.raw`\.scales[\s\S]*?\.scales`)]}},
    },
    {
      id: 'global-scales',
      title: 'Both global scales, once per output',
      detail:
        'After the blocks are summed, the result is multiplied by `s_global` of A and of B: two FP32 numbers per GEMM, not per element.',
      match: {python: {all: [inDef('nvfp4_matmul', String.raw`s_global[\s\S]*?s_global`)]}},
    },
    {
      id: 'no-shortcut',
      title: 'No dequantize-then-matmul, no library kernel',
      detail:
        '`nvfp4_matmul` must not call `nvfp4_dequantize` (the result would match, but it is not the block-scaled GEMM). No `torch._scaled_mm`, Transformer Engine, ModelOpt or torchao.',
      match: {
        python: {
          none: [
            inDef('nvfp4_matmul', String.raw`nvfp4_dequantize\(`),
            /_scaled_mm/,
            /transformer_engine|modelopt|torchao/,
          ],
        },
      },
    },
    {
      id: 'weight-once',
      title: 'The weight is quantized once',
      detail:
        '`from_linear` calls `nvfp4_quantize` on `linear.weight` and keeps the codes, scales and global scale as buffers; the forward never sees a float weight.',
      match: {python: {all: [inMethod('from_linear', String.raw`nvfp4_quantize\([^)\n]*weight`)]}},
    },
    {
      id: 'act-per-forward',
      title: 'Activations quantized on every forward, multiplied by the block-scaled GEMM',
      detail: '`forward` calls `nvfp4_quantize` on the flattened input, then `nvfp4_matmul` with the stored weight.',
      match: {
        python: {
          all: [
            inMethod(
              'forward',
              String.raw`(?:nvfp4_quantize\([\s\S]*?nvfp4_matmul\(|nvfp4_matmul\(\s*nvfp4_quantize\()`,
            ),
          ],
        },
      },
    },
    {
      id: 'calibrated-scale',
      title: 'The activation global scale comes from the calibrated amax',
      detail:
        'With `act_amax > 0`, the input’s global scale is `global_scale(act_amax)`, fixed at calibration; with 0 it falls back to the input’s own amax.',
      match: {python: {all: [inClass(String.raw`(?:global_scale\(|FP4_MAX\s*\*\s*E4M3_MAX|6(?:\.0)?\s*\*\s*448)`)]}},
    },
    {
      id: 'bias-float',
      title: 'Bias added in float after the GEMM',
      detail: 'The bias is never quantized: `forward` adds `self.bias` to the fp32 GEMM output.',
      match: {python: {all: [inMethod('forward', String.raw`self\.bias`)]}},
    },
  ],
  code: {
    python: {
      starter: `"""NVFP4 for inference, part 1: a block-scaled GEMM over NVFP4 tensors and a drop-in NVFP4Linear."""

from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

FP4_MAX = 6.0  # largest E2M1 magnitude
E4M3_MAX = 448.0  # largest float8_e4m3fn value
BLOCK = 16  # consecutive values along K that share one E4M3 scale
E2M1_GRID = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])
# code -> value. The code is sign bit 3, exponent bits 2..1, mantissa bit 0, so codes 0..7 are the grid in order.
FP4_LUT = torch.cat([E2M1_GRID, -E2M1_GRID])


# ---- given: the canonical NVFP4 quantizer ---------------------------------------------------------


def e2m1_round(x: torch.Tensor) -> torch.Tensor:
    """Nearest E2M1 value, ties to the even mantissa, saturating at +-6."""
    a = x.abs().clamp(max=FP4_MAX)
    step = torch.where(a < 2, 0.5, torch.where(a < 4, 1.0, 2.0))  # spacing of the grid around a
    return torch.copysign(torch.round(a / step) * step, x)  # round() is half to even


def e2m1_encode(v: torch.Tensor) -> torch.Tensor:
    """E2M1 values (exactly on the grid) -> 4-bit codes in uint8."""
    idx = torch.bucketize(v.abs(), E2M1_GRID)
    return (idx | ((v < 0).long() << 3)).to(torch.uint8)


def pack_fp4(codes: torch.Tensor) -> torch.Tensor:
    """(..., K) codes -> (..., K/2) bytes, element 2j in the low nibble."""
    return codes[..., 0::2] | (codes[..., 1::2] << 4)


def unpack_fp4(packed: torch.Tensor) -> torch.Tensor:
    return torch.stack([packed & 0xF, packed >> 4], dim=-1).flatten(-2)


def global_scale(amax: torch.Tensor | float) -> torch.Tensor:
    """Per-tensor FP32 decode scale: amax / (6 * 448), or 1 when amax is 0."""
    amax = torch.as_tensor(amax, dtype=torch.float32)
    return torch.where(amax > 0, amax / (FP4_MAX * E4M3_MAX), torch.ones_like(amax))


@dataclass
class NVFP4Tensor:
    codes: torch.Tensor  # (rows, K/2) uint8, two E2M1 codes per byte
    scales: torch.Tensor  # (rows, K/16) float8_e4m3fn, one per block of 16 along K
    s_global: torch.Tensor  # () float32 per-tensor decode scale

    def values(self) -> torch.Tensor:
        """The E2M1 values, (rows, K/16, 16) float32: what the tensor core multiplies."""
        q = FP4_LUT[unpack_fp4(self.codes).long()]
        return q.view(q.shape[0], -1, BLOCK)


def nvfp4_quantize(x: torch.Tensor, s_global: torch.Tensor | float | None = None) -> NVFP4Tensor:
    """x (rows, K), K a multiple of 16, quantized along K. s_global: a calibrated decode scale, else from amax(|x|)."""
    rows, K = x.shape
    assert K % BLOCK == 0, "K must be a multiple of 16"
    xb = x.float().reshape(rows, K // BLOCK, BLOCK)
    s_global = global_scale(xb.abs().amax()) if s_global is None else torch.as_tensor(s_global, dtype=torch.float32)
    s_block = (xb.abs().amax(-1) / FP4_MAX / s_global).clamp(max=E4M3_MAX).to(torch.float8_e4m3fn)
    scale = (s_block.float() * s_global)[..., None]  # (rows, K/16, 1) decode scale of each block
    q = torch.where(scale > 0, e2m1_round(xb / torch.where(scale > 0, scale, 1.0)), 0.0)  # zero scale: zeros
    return NVFP4Tensor(pack_fp4(e2m1_encode(q).view(rows, K)), s_block, s_global)


def nvfp4_dequantize(t: NVFP4Tensor) -> torch.Tensor:
    """q * s_block * s_global, (rows, K) float32."""
    q = t.values()
    return (q * (t.scales.float() * t.s_global)[..., None]).view(q.shape[0], -1)


# ---- the block-scaled GEMM ------------------------------------------------------------------------


def nvfp4_matmul(a: NVFP4Tensor, b: NVFP4Tensor) -> torch.Tensor:
    """a (M, K) and b (N, K) in NVFP4 -> a times b transposed, (M, N) float32, as a block-scaled MMA computes it."""
    # TODO: take the E2M1 values of both operands per block, form one 16-term dot product per (m, n, block)
    # in fp32, scale each by s_a[m, block] * s_b[n, block], sum over the blocks, then apply both global scales.
    raise NotImplementedError("TODO: the block-scaled GEMM")


class NVFP4Linear(nn.Module):
    """y = x @ W.T + b with W stored in NVFP4 and x quantized to NVFP4 along K on every forward.

    Buffers: w_codes (out, in/2) uint8, w_scales (out, in/16) float8_e4m3fn, w_global () float32,
    act_amax () float32 (0: not calibrated, scale each input by its own amax), bias (out,) float32 or None.
    """

    def __init__(self, in_features: int, out_features: int):
        super().__init__()
        assert in_features % BLOCK == 0
        self.in_features, self.out_features = in_features, out_features
        self.register_buffer("w_codes", torch.zeros(out_features, in_features // 2, dtype=torch.uint8))
        self.register_buffer("w_scales", torch.zeros(out_features, in_features // BLOCK, dtype=torch.float8_e4m3fn))
        self.register_buffer("w_global", torch.ones(()))
        self.register_buffer("act_amax", torch.zeros(()))
        self.register_buffer("bias", None)

    @classmethod
    def from_linear(cls, linear: nn.Linear, act_amax: torch.Tensor | float | None = None) -> "NVFP4Linear":
        # TODO: quantize the weight once into w_codes, w_scales, w_global; keep act_amax if given; copy the bias
        # in float32.
        raise NotImplementedError("TODO: build the layer from an nn.Linear")

    def weight_nvfp4(self) -> NVFP4Tensor:
        return NVFP4Tensor(self.w_codes, self.w_scales, self.w_global)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # TODO: flatten x to (tokens, in), quantize it along K with the calibrated global scale (or its own
        # amax when act_amax is 0), multiply with nvfp4_matmul, add the bias in float, restore the leading dims.
        raise NotImplementedError("TODO: NVFP4 forward")


if __name__ == "__main__":
    torch.manual_seed(0)

    # The given quantizer: every code round-trips, packing is lossless, ties go to the even mantissa.
    assert torch.equal(e2m1_encode(FP4_LUT), torch.arange(16, dtype=torch.uint8).masked_fill(torch.arange(16) == 8, 0))
    codes = torch.randint(16, (8, 32), dtype=torch.uint8)
    assert torch.equal(unpack_fp4(pack_fp4(codes)), codes)
    assert e2m1_round(torch.tensor([0.25, 0.75, 1.75, 2.5, 3.5, 5.0, 9.0, -5.0])).tolist() == [
        0.0, 1.0, 2.0, 2.0, 4.0, 4.0, 6.0, -4.0,
    ]

    # Heavy-tailed operands with uneven rows, so blocks get very different scales.
    M, N, K = 48, 64, 512
    a = torch.randn(M, K) * torch.rand(M, 1) * 3 + torch.randn(M, K).pow(3) * 0.1
    w = torch.randn(N, K) * 0.05
    qa, qw = nvfp4_quantize(a), nvfp4_quantize(w)
    out = nvfp4_matmul(qa, qw)
    assert out.shape == (M, N) and out.dtype == torch.float32

    # 1. Same numbers as dequantize-then-matmul, to fp32 rounding.
    deq = nvfp4_dequantize(qa) @ nvfp4_dequantize(qw).T
    gap = ((out - deq).abs().max() / deq.abs().max()).item()
    print(f"block-scaled GEMM vs dequantize-then-matmul: max gap {gap:.2e} of max |out|")
    assert gap < 1e-5

    # 2. A slow float64 reference, block by block: each block's FP4 dot product is an exact multiple of 1/4.
    nb = K // BLOCK
    ref = torch.zeros(M, N, dtype=torch.float64)
    va, vw = qa.values().double(), qw.values().double()
    for blk in range(nb):
        dot = va[:, blk] @ vw[:, blk].T
        assert torch.equal(dot * 4, (dot * 4).round()) and dot.abs().max() <= BLOCK * 36
        ref += dot * qa.scales[:, blk].double()[:, None] * qw.scales[:, blk].double()[None, :]
    ref *= qa.s_global.double() * qw.s_global.double()
    rel64 = ((out.double() - ref).abs().max() / ref.abs().max()).item()
    print(f"vs float64 block-by-block reference: {rel64:.2e}")
    assert rel64 < 1e-6

    # 3. Against the fp32 product it differs only by quantization error.
    exact = a @ w.T
    q_err = ((out - exact).norm() / exact.norm()).item()
    print(f"relative error vs fp32 a @ w.T: {q_err:.4f}")
    assert 0.01 < q_err < 0.15

    # NVFP4Linear: weights quantized once, bias in float, activations dynamic or calibrated.
    lin = nn.Linear(256, 96)
    x = torch.randn(4, 10, 256)
    layer = NVFP4Linear.from_linear(lin)
    assert not list(layer.parameters()) and layer.w_codes.dtype == torch.uint8
    assert layer.w_codes.shape == (96, 128) and layer.w_scales.shape == (96, 16)
    y = layer(x)
    want = nvfp4_dequantize(nvfp4_quantize(x.reshape(-1, 256))) @ nvfp4_dequantize(layer.weight_nvfp4()).T + lin.bias
    assert y.shape == (4, 10, 96) and torch.allclose(y.reshape(-1, 96), want, atol=1e-5)
    y_fp = F.linear(x, lin.weight, lin.bias).detach()
    err_dyn = ((y - y_fp).norm() / y_fp.norm()).item()
    assert torch.equal(layer(torch.zeros(2, 256)), lin.bias.detach().expand(2, 96)), "bias added in float"

    # Calibrated: the global scale comes from amax seen on calibration batches, not from this input.
    calib_amax = torch.stack([torch.randn(4, 10, 256).abs().amax() for _ in range(8)]).amax()
    static = NVFP4Linear.from_linear(lin, act_amax=calib_amax)
    y_s = static(x)
    want_s = nvfp4_matmul(nvfp4_quantize(x.reshape(-1, 256), global_scale(calib_amax)), static.weight_nvfp4())
    assert torch.allclose(y_s.reshape(-1, 96), want_s + lin.bias, atol=1e-5)
    err_static = ((y_s - y_fp).norm() / y_fp.norm()).item()
    print(f"NVFP4Linear relative output error: dynamic {err_dyn:.4f}, calibrated {err_static:.4f}")
    assert err_dyn < 0.15 and err_static < 0.15

    # An input 8x larger than anything calibrated: its blocks' scales clip at 448 and its values saturate at 6.
    big = static(8 * x)
    err_big = ((big - F.linear(8 * x, lin.weight, lin.bias)).norm() / F.linear(8 * x, lin.weight, lin.bias).norm())
    print(f"input 8x past the calibrated amax: relative error {err_big.item():.4f} (clipped)")
    assert torch.isfinite(big).all() and err_big > 2 * err_static

    bits = 8 * sum(t.numel() * t.element_size() for t in (layer.w_codes, layer.w_scales)) / lin.weight.numel()
    print(f"weight storage: {bits:.2f} bits per weight (+4 bytes of global scale)")
    assert bits == 4.5
    print("PASS")
`,
      solution: `"""NVFP4 for inference, part 1: a block-scaled GEMM over NVFP4 tensors and a drop-in NVFP4Linear."""

from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

FP4_MAX = 6.0  # largest E2M1 magnitude
E4M3_MAX = 448.0  # largest float8_e4m3fn value
BLOCK = 16  # consecutive values along K that share one E4M3 scale
E2M1_GRID = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])
# code -> value. The code is sign bit 3, exponent bits 2..1, mantissa bit 0, so codes 0..7 are the grid in order.
FP4_LUT = torch.cat([E2M1_GRID, -E2M1_GRID])


# ---- given: the canonical NVFP4 quantizer ---------------------------------------------------------


def e2m1_round(x: torch.Tensor) -> torch.Tensor:
    """Nearest E2M1 value, ties to the even mantissa, saturating at +-6."""
    a = x.abs().clamp(max=FP4_MAX)
    step = torch.where(a < 2, 0.5, torch.where(a < 4, 1.0, 2.0))  # spacing of the grid around a
    return torch.copysign(torch.round(a / step) * step, x)  # round() is half to even


def e2m1_encode(v: torch.Tensor) -> torch.Tensor:
    """E2M1 values (exactly on the grid) -> 4-bit codes in uint8."""
    idx = torch.bucketize(v.abs(), E2M1_GRID)
    return (idx | ((v < 0).long() << 3)).to(torch.uint8)


def pack_fp4(codes: torch.Tensor) -> torch.Tensor:
    """(..., K) codes -> (..., K/2) bytes, element 2j in the low nibble."""
    return codes[..., 0::2] | (codes[..., 1::2] << 4)


def unpack_fp4(packed: torch.Tensor) -> torch.Tensor:
    return torch.stack([packed & 0xF, packed >> 4], dim=-1).flatten(-2)


def global_scale(amax: torch.Tensor | float) -> torch.Tensor:
    """Per-tensor FP32 decode scale: amax / (6 * 448), or 1 when amax is 0."""
    amax = torch.as_tensor(amax, dtype=torch.float32)
    return torch.where(amax > 0, amax / (FP4_MAX * E4M3_MAX), torch.ones_like(amax))


@dataclass
class NVFP4Tensor:
    codes: torch.Tensor  # (rows, K/2) uint8, two E2M1 codes per byte
    scales: torch.Tensor  # (rows, K/16) float8_e4m3fn, one per block of 16 along K
    s_global: torch.Tensor  # () float32 per-tensor decode scale

    def values(self) -> torch.Tensor:
        """The E2M1 values, (rows, K/16, 16) float32: what the tensor core multiplies."""
        q = FP4_LUT[unpack_fp4(self.codes).long()]
        return q.view(q.shape[0], -1, BLOCK)


def nvfp4_quantize(x: torch.Tensor, s_global: torch.Tensor | float | None = None) -> NVFP4Tensor:
    """x (rows, K), K a multiple of 16, quantized along K. s_global: a calibrated decode scale, else from amax(|x|)."""
    rows, K = x.shape
    assert K % BLOCK == 0, "K must be a multiple of 16"
    xb = x.float().reshape(rows, K // BLOCK, BLOCK)
    s_global = global_scale(xb.abs().amax()) if s_global is None else torch.as_tensor(s_global, dtype=torch.float32)
    s_block = (xb.abs().amax(-1) / FP4_MAX / s_global).clamp(max=E4M3_MAX).to(torch.float8_e4m3fn)
    scale = (s_block.float() * s_global)[..., None]  # (rows, K/16, 1) decode scale of each block
    q = torch.where(scale > 0, e2m1_round(xb / torch.where(scale > 0, scale, 1.0)), 0.0)  # zero scale: zeros
    return NVFP4Tensor(pack_fp4(e2m1_encode(q).view(rows, K)), s_block, s_global)


def nvfp4_dequantize(t: NVFP4Tensor) -> torch.Tensor:
    """q * s_block * s_global, (rows, K) float32."""
    q = t.values()
    return (q * (t.scales.float() * t.s_global)[..., None]).view(q.shape[0], -1)


# ---- the block-scaled GEMM ------------------------------------------------------------------------


def nvfp4_matmul(a: NVFP4Tensor, b: NVFP4Tensor) -> torch.Tensor:
    """a (M, K) and b (N, K) in NVFP4 -> a times b transposed, (M, N) float32, as a block-scaled MMA computes it."""
    qa, qb = a.values(), b.values()  # (M, K/16, 16), (N, K/16, 16) E2M1 values
    partial = torch.einsum("mbk,nbk->mnb", qa, qb)  # one 16-term FP4 dot product per block: exact in fp32
    scaled = partial * a.scales.float()[:, None, :] * b.scales.float()[None, :, :]  # s_a[m, blk] * s_b[n, blk]
    return scaled.sum(-1) * (a.s_global * b.s_global)  # accumulate over blocks, then the two global scales


class NVFP4Linear(nn.Module):
    """y = x @ W.T + b with W stored in NVFP4 and x quantized to NVFP4 along K on every forward.

    Buffers: w_codes (out, in/2) uint8, w_scales (out, in/16) float8_e4m3fn, w_global () float32,
    act_amax () float32 (0: not calibrated, scale each input by its own amax), bias (out,) float32 or None.
    """

    def __init__(self, in_features: int, out_features: int):
        super().__init__()
        assert in_features % BLOCK == 0
        self.in_features, self.out_features = in_features, out_features
        self.register_buffer("w_codes", torch.zeros(out_features, in_features // 2, dtype=torch.uint8))
        self.register_buffer("w_scales", torch.zeros(out_features, in_features // BLOCK, dtype=torch.float8_e4m3fn))
        self.register_buffer("w_global", torch.ones(()))
        self.register_buffer("act_amax", torch.zeros(()))
        self.register_buffer("bias", None)

    @classmethod
    def from_linear(cls, linear: nn.Linear, act_amax: torch.Tensor | float | None = None) -> "NVFP4Linear":
        layer = cls(linear.in_features, linear.out_features)
        w = nvfp4_quantize(linear.weight.detach())  # once, with the weight's own global scale
        layer.w_codes, layer.w_scales, layer.w_global = w.codes, w.scales, w.s_global
        if act_amax is not None:
            layer.act_amax = torch.as_tensor(act_amax, dtype=torch.float32).clone()
        if linear.bias is not None:
            layer.bias = linear.bias.detach().float().clone()
        return layer

    def weight_nvfp4(self) -> NVFP4Tensor:
        return NVFP4Tensor(self.w_codes, self.w_scales, self.w_global)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x2 = x.reshape(-1, self.in_features)
        s_x = global_scale(self.act_amax) if self.act_amax > 0 else None  # calibrated, else dynamic
        y = nvfp4_matmul(nvfp4_quantize(x2, s_x), self.weight_nvfp4())
        if self.bias is not None:
            y = y + self.bias  # in float, after the GEMM
        return y.view(*x.shape[:-1], self.out_features)


if __name__ == "__main__":
    torch.manual_seed(0)

    # The given quantizer: every code round-trips, packing is lossless, ties go to the even mantissa.
    assert torch.equal(e2m1_encode(FP4_LUT), torch.arange(16, dtype=torch.uint8).masked_fill(torch.arange(16) == 8, 0))
    codes = torch.randint(16, (8, 32), dtype=torch.uint8)
    assert torch.equal(unpack_fp4(pack_fp4(codes)), codes)
    assert e2m1_round(torch.tensor([0.25, 0.75, 1.75, 2.5, 3.5, 5.0, 9.0, -5.0])).tolist() == [
        0.0, 1.0, 2.0, 2.0, 4.0, 4.0, 6.0, -4.0,
    ]

    # Heavy-tailed operands with uneven rows, so blocks get very different scales.
    M, N, K = 48, 64, 512
    a = torch.randn(M, K) * torch.rand(M, 1) * 3 + torch.randn(M, K).pow(3) * 0.1
    w = torch.randn(N, K) * 0.05
    qa, qw = nvfp4_quantize(a), nvfp4_quantize(w)
    out = nvfp4_matmul(qa, qw)
    assert out.shape == (M, N) and out.dtype == torch.float32

    # 1. Same numbers as dequantize-then-matmul, to fp32 rounding.
    deq = nvfp4_dequantize(qa) @ nvfp4_dequantize(qw).T
    gap = ((out - deq).abs().max() / deq.abs().max()).item()
    print(f"block-scaled GEMM vs dequantize-then-matmul: max gap {gap:.2e} of max |out|")
    assert gap < 1e-5

    # 2. A slow float64 reference, block by block: each block's FP4 dot product is an exact multiple of 1/4.
    nb = K // BLOCK
    ref = torch.zeros(M, N, dtype=torch.float64)
    va, vw = qa.values().double(), qw.values().double()
    for blk in range(nb):
        dot = va[:, blk] @ vw[:, blk].T
        assert torch.equal(dot * 4, (dot * 4).round()) and dot.abs().max() <= BLOCK * 36
        ref += dot * qa.scales[:, blk].double()[:, None] * qw.scales[:, blk].double()[None, :]
    ref *= qa.s_global.double() * qw.s_global.double()
    rel64 = ((out.double() - ref).abs().max() / ref.abs().max()).item()
    print(f"vs float64 block-by-block reference: {rel64:.2e}")
    assert rel64 < 1e-6

    # 3. Against the fp32 product it differs only by quantization error.
    exact = a @ w.T
    q_err = ((out - exact).norm() / exact.norm()).item()
    print(f"relative error vs fp32 a @ w.T: {q_err:.4f}")
    assert 0.01 < q_err < 0.15

    # NVFP4Linear: weights quantized once, bias in float, activations dynamic or calibrated.
    lin = nn.Linear(256, 96)
    x = torch.randn(4, 10, 256)
    layer = NVFP4Linear.from_linear(lin)
    assert not list(layer.parameters()) and layer.w_codes.dtype == torch.uint8
    assert layer.w_codes.shape == (96, 128) and layer.w_scales.shape == (96, 16)
    y = layer(x)
    want = nvfp4_dequantize(nvfp4_quantize(x.reshape(-1, 256))) @ nvfp4_dequantize(layer.weight_nvfp4()).T + lin.bias
    assert y.shape == (4, 10, 96) and torch.allclose(y.reshape(-1, 96), want, atol=1e-5)
    y_fp = F.linear(x, lin.weight, lin.bias).detach()
    err_dyn = ((y - y_fp).norm() / y_fp.norm()).item()
    assert torch.equal(layer(torch.zeros(2, 256)), lin.bias.detach().expand(2, 96)), "bias added in float"

    # Calibrated: the global scale comes from amax seen on calibration batches, not from this input.
    calib_amax = torch.stack([torch.randn(4, 10, 256).abs().amax() for _ in range(8)]).amax()
    static = NVFP4Linear.from_linear(lin, act_amax=calib_amax)
    y_s = static(x)
    want_s = nvfp4_matmul(nvfp4_quantize(x.reshape(-1, 256), global_scale(calib_amax)), static.weight_nvfp4())
    assert torch.allclose(y_s.reshape(-1, 96), want_s + lin.bias, atol=1e-5)
    err_static = ((y_s - y_fp).norm() / y_fp.norm()).item()
    print(f"NVFP4Linear relative output error: dynamic {err_dyn:.4f}, calibrated {err_static:.4f}")
    assert err_dyn < 0.15 and err_static < 0.15

    # An input 8x larger than anything calibrated: its blocks' scales clip at 448 and its values saturate at 6.
    big = static(8 * x)
    err_big = ((big - F.linear(8 * x, lin.weight, lin.bias)).norm() / F.linear(8 * x, lin.weight, lin.bias).norm())
    print(f"input 8x past the calibrated amax: relative error {err_big.item():.4f} (clipped)")
    assert torch.isfinite(big).all() and err_big > 2 * err_static

    bits = 8 * sum(t.numel() * t.element_size() for t in (layer.w_codes, layer.w_scales)) / lin.weight.numel()
    print(f"weight storage: {bits:.2f} bits per weight (+4 bytes of global scale)")
    assert bits == 4.5
    print("PASS")
`,
    },
  },
  debrief: `The GEMM has the shape of the hardware's. CUTLASS documents Blackwell's block-scaled MMA as \`D = C + Σ_k (A[i, k] · SFA[i, k/SV]) · (B[j, k] · SFB[j, k/SV])\`, with a scale-factor vector size \`SV\` of 16 for \`nv_float4_t\` (E4M3 scales) and 32 for \`mx_float4_t\` (E8M0 scales). Within a block, the products of two E2M1 values are small multiples of 1/4, so their sum is exact; the block scales are 4-bit-mantissa numbers whose product is exact too. The only rounding in \`nvfp4_matmul\` is the fp32 accumulation across blocks, which is why it agrees with a float64 loop to about 1e-7. **Why two global scales and not one per element**: they are one scalar per GEMM, applied to the fp32 result once. Folding them into the block scales would push the E4M3 values out of range, which is the reason the second level exists. **Why calibrate the activation scale**: a dynamic global scale needs \`amax(|x|)\` over the whole input before the first block can be quantized, a reduction across the tensor on every call. A calibrated one is a constant, so the previous kernel can write NVFP4 directly. The price is the clipping the self-test shows when an input exceeds the calibrated range: block scales stop at 448 and values saturate at 6. Production kernels add what this file leaves out. They store the scales in the swizzled tile layout the MMA reads, fuse the activation quantization into the producing kernel's epilogue, keep the accumulator on chip, and write bf16 outputs. ModelOpt computes the same two levels this file does: weights get \`amax / (6 · 448)\` per tensor and E4M3 scales per 16, activations a static per-tensor scale from calibration.`,
};
