import type {Step} from '@/lib/types';

export const int4RtnStep: Step = {
  id: 'int4-rtn',
  title: '4-bit codes: group grids, nibble packing, QuantLinear',
  concept: 'pytorch',
  file: 'quant_int4',
  focus: ['codes-row', 'qweight', 'scales', 'zeros', 'deq-forward'],
  task: `## Task

Write the storage format every later step fills: asymmetric 4-bit codes with one scale and one zero
point per group of \`group_size\` input columns, packed two codes per byte, and a module that runs
from them. Write the rounding and the bit operations yourself: no \`torch.quantize_per_channel\`,
\`torch.ao.quantization\`, \`bitsandbytes\` or \`auto_gptq\`.

- \`quant_params(w, bits=4) -> (scale, zero)\`: \`w\` is \`(rows, g)\` float32, one group per row; both
  results are \`(rows, 1)\` float32.
  - The range is \`[min(w, 0), max(w, 0)]\`: 0.0 is always representable, so a zero weight stays exactly 0.
  - \`scale = (max − min) / (2^bits − 1)\`, rounded **up** to the next fp16 value (it is stored in fp16,
    and rounding up keeps the 16 levels spanning the whole range); an all-zero row gets \`scale = 1\`.
  - \`zero = round(−min / scale)\`: the code that 0.0 lands on.
- \`quantize(w, scale, zero, bits=4)\`: \`clamp(round(w / scale) + zero, 0, 2^bits − 1)\`, as float.
- \`quantize_rtn(W, bits=4, group_size=128) -> (codes, scales, zeros)\`: \`W\` is \`(out, in)\` with
  \`in % group_size == 0\`; \`codes (out, in)\` uint8, \`scales (out, in // group_size)\` float16,
  \`zeros (out, in // group_size)\` uint8. Every element ends within \`scale / 2\` of its value.
- \`dequantize(codes, scales, zeros, group_size)\`: \`(codes − zero) · scale\` per group, float32 \`(out, in)\`.
- \`pack_int4(codes)\`: \`(..., n)\` uint8 to \`(..., n // 2)\` uint8, column \`2j\` in the **low** nibble and
  \`2j + 1\` in the high one (\`[3, 10]\` packs to \`0xA3\`); \`unpack_int4\` inverts it.
- \`QuantLinear(in_features, out_features, bias=True, group_size=128)\`: buffers \`qweight (out, in // 2)\`
  uint8, \`scales\` fp16, \`zeros\` uint8, \`bias (out,)\` float32 or \`None\`. Buffers, not parameters.
  - \`QuantLinear.from_quantized(linear, codes, scales, zeros, group_size)\` packs the codes and copies the bias.
  - \`forward(x)\` unpacks, dequantizes and applies \`F.linear\` (or \`x @ Ŵᵀ + b\`); it keeps no float copy of the weight.
  - \`bits_per_weight()\` counts the three buffers' bits over \`in · out\`: \`4 + (16 + 8) / group_size\`.

:::widget int4-quant {"bits": 4, "group": 32}

The self-test round-trips packing on random codes, checks the half-step bound on a \`64 × 256\` matrix with
one outlier (its group's scale more than twice a neighbour's), that an all-zero group dequantizes to
zeros, that \`QuantLinear\` matches an \`einsum\` with the dequantized weight to 1e-5, and that it stores
4.1875 bits per weight at \`group_size = 128\` (7.64× less than fp32). Then it prints \`PASS\`.

> A 4-bit weight is a code and a pointer to its group's two numbers: the scale and zero point are where
> the precision goes, and the group size decides how far one outlier can stretch a grid.`,
  hints: [
    'Reshape `W` to `(out, in // g, g)` and flatten to `(out · in // g, g)`: then every row is one group and `quant_params` works on rows. Reshape the results back at the end.',
    'Rounding the scale up: cast the exact scale to fp16, and where that cast landed below the exact value, step it up one fp16 ulp with `torch.nextafter` toward `+inf`. Compute the zero point from the rounded scale, so codes and storage agree.',
    'Pack with the strided slices `0::2` (low nibble) and `1::2` (shifted into the high nibble). Unpack by stacking the two nibbles on a new last axis and flattening it: that interleaves them back into column order.',
  ],
  checks: [
    {
      id: 'range',
      title: 'Grid from the group’s min and max',
      detail:
        'The scale is the group’s range over `2 ** bits - 1` levels, the range taken from its minimum and maximum (each extended to include 0). An asymmetric grid uses all 16 codes on a skewed group, where a symmetric one wastes half of them.',
      match: {
        python: {
          all: [
            /\.amin\(|\.min\(|torch\.min\(/,
            /\.amax\(|\.max\(|torch\.max\(/,
            /2\s*\*\*\s*bits\s*-\s*1|\(\s*1\s*<<\s*bits\s*\)\s*-\s*1/,
          ],
        },
      },
    },
    {
      id: 'round-clamp',
      title: 'Round to nearest, clamped into 0..15, written by hand',
      detail:
        '`torch.round(w / scale) + zero`, then `clamp` to the code range: the zero point is an integer, so it shifts the grid without moving any level. Library quantizers (`torch.quantize_per_channel`, `torch.ao.quantization`, `bitsandbytes`, `auto_gptq`) are not allowed.',
      match: {
        python: {
          all: [/torch\.round\(/, /\.clamp\(|torch\.clamp\(/],
          none: [
            /quantize_per_(?:channel|tensor)/,
            /torch\.ao\.quantization/,
            /bitsandbytes/,
            /auto_gptq/,
            /gptqmodel/,
          ],
        },
      },
    },
    {
      id: 'groups',
      title: 'One scale and zero point per group of columns',
      detail:
        '`W` is viewed as `(out, in // group_size, group_size)` so each group gets its own grid, and `dequantize` broadcasts them back over the group’s columns (`repeat_interleave(group_size, dim=1)` or a reshape).',
      match: {
        python: {
          all: [
            /(?:reshape|view)\([^\n]*group_size/,
            /repeat_interleave\(\s*group_size|(?:reshape|view)\([^\n]*\/\/\s*group_size\s*,\s*group_size/,
          ],
        },
      },
    },
    {
      id: 'pack',
      title: 'Two codes per byte, low nibble first',
      detail:
        'Even columns in bits 0 to 3, odd columns shifted `<< 4` into bits 4 to 7; unpacking masks with `& 0xF` and shifts `>> 4`. The order is the format: a kernel that reads the other nibble first computes with the wrong weights.',
      match: {
        python: {
          all: [/<<\s*4/, /&\s*(?:0x[fF]|15)\b/, />>\s*4/, /0::2|::2\]/],
        },
      },
    },
    {
      id: 'buffers',
      title: 'QuantLinear stores packed codes, scales and zeros as buffers',
      detail:
        '`register_buffer("qweight", …)`, `register_buffer("scales", …)` and `register_buffer("zeros", …)`: they move with `.to(device)` and land in the `state_dict`, but no optimizer sees them.',
      match: {
        python: {
          all: [
            /register_buffer\(\s*["']qweight["']/,
            /register_buffer\(\s*["']scales["']/,
            /register_buffer\(\s*["']zeros["']/,
          ],
        },
      },
    },
    {
      id: 'forward',
      title: 'forward dequantizes, then runs the matmul',
      detail:
        'The weight is rebuilt from the codes on each call (`unpack_int4`, then `dequantize`) and applied with `F.linear(x, W_hat, bias)`. Keeping a float copy (`nn.Parameter`, `self.weight = …`) would give back the memory 4 bits saved.',
      match: {
        python: {
          all: [/F\.linear\(\s*x\b|x\s*@\s*[\w.()]*\.t\(\)|torch\.matmul\(\s*x\b/],
          order: [/def forward\(/, /unpack_int4\(|dequantize|dequantized_weight\(/],
          none: [/nn\.Parameter\(/, /self\.weight\s*=/],
        },
      },
    },
    {
      id: 'bits',
      title: 'Bits per weight counted from the buffers',
      detail:
        'Stored bits come from the buffers themselves (`numel() * element_size() * 8`), so the 16-bit scale and 8-bit zero per group show up: 4.1875 bits per weight at `group_size = 128`, 4.75 at 32.',
      match: {python: {all: [/element_size\(\)/]}},
    },
  ],
  code: {
    python: {
      starter: `"""4-bit weights: asymmetric per-group round-to-nearest, two codes per byte, and a Linear that stores them."""

import torch
import torch.nn as nn
import torch.nn.functional as F


def quant_params(w: torch.Tensor, bits: int = 4) -> tuple[torch.Tensor, torch.Tensor]:
    """Scale and zero point per row of \`w\` (rows, g), each (rows, 1) float32.

    The range is [min(w, 0), max(w, 0)] so 0.0 is always a grid point. The scale is rounded up to the
    next fp16 value (what QuantLinear stores), so the 2^bits levels still span the whole range.
    """
    # TODO: the row's min (at most 0) and max (at least 0); scale = their distance over the top code;
    # round it up to fp16; an all-zero row gets scale 1; zero point = the code that 0.0 lands on.
    raise NotImplementedError("TODO: scale and zero point from the row's range")


def quantize(w: torch.Tensor, scale: torch.Tensor, zero: torch.Tensor, bits: int = 4) -> torch.Tensor:
    """Integer codes round(w / scale) + zero, clamped to 0..2^bits - 1, as float."""
    raise NotImplementedError("TODO: round to the nearest level, then clamp into the code range")


def quantize_rtn(W: torch.Tensor, bits: int = 4, group_size: int = 128):
    """Round to nearest: W (out, in) -> codes (out, in) uint8, scales (out, in // g) fp16, zeros (out, in // g) uint8"""
    raise NotImplementedError("TODO: view W as groups of group_size columns, one scale and zero point per group")


def dequantize(codes: torch.Tensor, scales: torch.Tensor, zeros: torch.Tensor, group_size: int) -> torch.Tensor:
    """(codes - zero) * scale per group, as float32 (out, in)."""
    raise NotImplementedError("TODO: broadcast each group's scale and zero point over its columns")


def pack_int4(codes: torch.Tensor) -> torch.Tensor:
    """(..., n) uint8 codes in 0..15 -> (..., n // 2) uint8: column 2j in the low nibble, 2j + 1 in the high one."""
    raise NotImplementedError("TODO: even columns in the low nibble, odd columns in the high nibble")


def unpack_int4(packed: torch.Tensor) -> torch.Tensor:
    """Inverse of pack_int4: (..., m) uint8 -> (..., 2m) uint8, low nibble first."""
    raise NotImplementedError("TODO: split each byte and interleave the nibbles back into columns")


class QuantLinear(nn.Module):
    """A Linear whose weight is 4-bit codes packed two per byte, with an fp16 scale and a zero point per group."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, group_size: int = 128):
        super().__init__()
        # TODO: buffers qweight (out, in // 2) uint8, scales (out, in // g) fp16, zeros (out, in // g) uint8,
        # and bias (out,) float32 or None. Buffers, not parameters: nothing here is trained.
        raise NotImplementedError("TODO: register the packed weight, scales, zeros and bias")

    @classmethod
    def from_quantized(cls, linear: nn.Linear, codes, scales, zeros, group_size: int) -> "QuantLinear":
        raise NotImplementedError("TODO: a QuantLinear holding the packed codes and the Linear's bias")

    def dequantized_weight(self) -> torch.Tensor:
        raise NotImplementedError("TODO: unpack, then dequantize")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        raise NotImplementedError("TODO: dequantize the weight and apply it to x")

    def bits_per_weight(self) -> float:
        """Stored bits over weights: the codes plus every group's scale and zero point."""
        raise NotImplementedError("TODO: count the bytes of the three buffers")


if __name__ == "__main__":
    torch.manual_seed(0)
    out_f, in_f, g = 64, 256, 128

    # Packing: two codes per byte, low nibble first, and back.
    codes = torch.randint(0, 16, (out_f, in_f), dtype=torch.uint8)
    packed = pack_int4(codes)
    assert packed.shape == (out_f, in_f // 2) and packed.dtype == torch.uint8
    assert torch.equal(unpack_int4(packed), codes)
    assert pack_int4(torch.tensor([3, 10], dtype=torch.uint8)).item() == 3 + 16 * 10  # 0xA3

    # Round-to-nearest: codes in range, error at most half a step per element.
    W = torch.randn(out_f, in_f)
    W[3, 17] = 12.0  # an outlier widens its group's step
    q, scales, zeros = quantize_rtn(W, bits=4, group_size=g)
    assert q.dtype == torch.uint8 and int(q.max()) <= 15
    assert scales.shape == (out_f, in_f // g) and scales.dtype == torch.float16 and zeros.dtype == torch.uint8
    W_hat = dequantize(q, scales, zeros, g)
    step = scales.float().repeat_interleave(g, dim=1)
    assert ((W - W_hat).abs() <= step / 2 + 1e-6).all(), "an element is more than half a step from its level"
    assert scales[3, 0] > 2 * scales[4, 0], "the outlier's group has the wider step"
    assert torch.equal(dequantize(*quantize_rtn(torch.zeros(4, g), group_size=g), g), torch.zeros(4, g))

    # QuantLinear: the same output as a matmul with the dequantized weight.
    lin = nn.Linear(in_f, out_f)
    q, scales, zeros = quantize_rtn(lin.weight.detach(), group_size=g)
    ql = QuantLinear.from_quantized(lin, q, scales, zeros, g)
    x = torch.randn(5, 7, in_f)
    ref = torch.einsum("bti,oi->bto", x, dequantize(q, scales, zeros, g)) + lin.bias.detach()
    assert torch.allclose(ql(x), ref, atol=1e-5)
    rel = (ql(x) - lin(x)).norm() / lin(x).norm()
    assert rel < 0.15, rel

    # Storage: 4 bits per code plus 16 + 8 bits per group of g weights.
    bpw = ql.bits_per_weight()
    assert abs(bpw - (4 + 24 / g)) < 1e-9, bpw
    print(f"rtn int4 g={g}: {bpw:.4f} bits/weight, {32 / bpw:.2f}x smaller than fp32, rel output error {rel:.3f}")
    print("PASS")
`,
      solution: `"""4-bit weights: asymmetric per-group round-to-nearest, two codes per byte, and a Linear that stores them."""

import torch
import torch.nn as nn
import torch.nn.functional as F


def quant_params(w: torch.Tensor, bits: int = 4) -> tuple[torch.Tensor, torch.Tensor]:
    """Scale and zero point per row of \`w\` (rows, g), each (rows, 1) float32.

    The range is [min(w, 0), max(w, 0)] so 0.0 is always a grid point. The scale is rounded up to the
    next fp16 value (what QuantLinear stores), so the 2^bits levels still span the whole range.
    """
    maxq = 2**bits - 1
    wmin = w.amin(dim=1, keepdim=True).clamp(max=0)
    wmax = w.amax(dim=1, keepdim=True).clamp(min=0)
    exact = (wmax - wmin) / maxq
    half = exact.half()
    half = torch.where(half.float() < exact, torch.nextafter(half, torch.full_like(half, float("inf"))), half)
    scale = half.float()
    scale = torch.where(scale == 0, torch.ones_like(scale), scale)  # an all-zero group
    zero = torch.round(-wmin / scale)
    return scale, zero


def quantize(w: torch.Tensor, scale: torch.Tensor, zero: torch.Tensor, bits: int = 4) -> torch.Tensor:
    """Integer codes round(w / scale) + zero, clamped to 0..2^bits - 1, as float."""
    return torch.clamp(torch.round(w / scale) + zero, 0, 2**bits - 1)


def quantize_rtn(W: torch.Tensor, bits: int = 4, group_size: int = 128):
    """Round to nearest: W (out, in) -> codes (out, in) uint8, scales (out, in // g) fp16, zeros (out, in // g) uint8"""
    out_features, in_features = W.shape
    assert in_features % group_size == 0, "group_size must divide in_features"
    groups = W.float().reshape(out_features, in_features // group_size, group_size)
    flat = groups.reshape(-1, group_size)
    scale, zero = quant_params(flat, bits)
    q = quantize(flat, scale, zero, bits)
    codes = q.reshape(out_features, in_features).to(torch.uint8)
    shape = (out_features, in_features // group_size)
    return codes, scale.reshape(shape).half(), zero.reshape(shape).to(torch.uint8)


def dequantize(codes: torch.Tensor, scales: torch.Tensor, zeros: torch.Tensor, group_size: int) -> torch.Tensor:
    """(codes - zero) * scale per group, as float32 (out, in)."""
    s = scales.float().repeat_interleave(group_size, dim=1)
    z = zeros.float().repeat_interleave(group_size, dim=1)
    return (codes.float() - z) * s


def pack_int4(codes: torch.Tensor) -> torch.Tensor:
    """(..., n) uint8 codes in 0..15 -> (..., n // 2) uint8: column 2j in the low nibble, 2j + 1 in the high one."""
    assert codes.shape[-1] % 2 == 0
    return codes[..., 0::2] | (codes[..., 1::2] << 4)


def unpack_int4(packed: torch.Tensor) -> torch.Tensor:
    """Inverse of pack_int4: (..., m) uint8 -> (..., 2m) uint8, low nibble first."""
    return torch.stack((packed & 0xF, packed >> 4), dim=-1).flatten(-2)


class QuantLinear(nn.Module):
    """A Linear whose weight is 4-bit codes packed two per byte, with an fp16 scale and a zero point per group."""

    def __init__(self, in_features: int, out_features: int, bias: bool = True, group_size: int = 128):
        super().__init__()
        assert in_features % group_size == 0 and in_features % 2 == 0
        self.in_features, self.out_features, self.group_size = in_features, out_features, group_size
        n_groups = in_features // group_size
        self.register_buffer("qweight", torch.zeros(out_features, in_features // 2, dtype=torch.uint8))
        self.register_buffer("scales", torch.ones(out_features, n_groups, dtype=torch.float16))
        self.register_buffer("zeros", torch.zeros(out_features, n_groups, dtype=torch.uint8))
        self.register_buffer("bias", torch.zeros(out_features) if bias else None)

    @classmethod
    def from_quantized(cls, linear: nn.Linear, codes, scales, zeros, group_size: int) -> "QuantLinear":
        layer = cls(linear.in_features, linear.out_features, linear.bias is not None, group_size)
        layer.qweight.copy_(pack_int4(codes.to(torch.uint8)))
        layer.scales.copy_(scales)
        layer.zeros.copy_(zeros)
        if linear.bias is not None:
            layer.bias.copy_(linear.bias.detach())
        return layer

    def dequantized_weight(self) -> torch.Tensor:
        return dequantize(unpack_int4(self.qweight), self.scales, self.zeros, self.group_size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.linear(x, self.dequantized_weight().to(x.dtype), self.bias)

    def bits_per_weight(self) -> float:
        """Stored bits over weights: the codes plus every group's scale and zero point."""
        stored = sum(b.numel() * b.element_size() * 8 for b in (self.qweight, self.scales, self.zeros))
        return stored / (self.in_features * self.out_features)


if __name__ == "__main__":
    torch.manual_seed(0)
    out_f, in_f, g = 64, 256, 128

    # Packing: two codes per byte, low nibble first, and back.
    codes = torch.randint(0, 16, (out_f, in_f), dtype=torch.uint8)
    packed = pack_int4(codes)
    assert packed.shape == (out_f, in_f // 2) and packed.dtype == torch.uint8
    assert torch.equal(unpack_int4(packed), codes)
    assert pack_int4(torch.tensor([3, 10], dtype=torch.uint8)).item() == 3 + 16 * 10  # 0xA3

    # Round-to-nearest: codes in range, error at most half a step per element.
    W = torch.randn(out_f, in_f)
    W[3, 17] = 12.0  # an outlier widens its group's step
    q, scales, zeros = quantize_rtn(W, bits=4, group_size=g)
    assert q.dtype == torch.uint8 and int(q.max()) <= 15
    assert scales.shape == (out_f, in_f // g) and scales.dtype == torch.float16 and zeros.dtype == torch.uint8
    W_hat = dequantize(q, scales, zeros, g)
    step = scales.float().repeat_interleave(g, dim=1)
    assert ((W - W_hat).abs() <= step / 2 + 1e-6).all(), "an element is more than half a step from its level"
    assert scales[3, 0] > 2 * scales[4, 0], "the outlier's group has the wider step"
    assert torch.equal(dequantize(*quantize_rtn(torch.zeros(4, g), group_size=g), g), torch.zeros(4, g))

    # QuantLinear: the same output as a matmul with the dequantized weight.
    lin = nn.Linear(in_f, out_f)
    q, scales, zeros = quantize_rtn(lin.weight.detach(), group_size=g)
    ql = QuantLinear.from_quantized(lin, q, scales, zeros, g)
    x = torch.randn(5, 7, in_f)
    ref = torch.einsum("bti,oi->bto", x, dequantize(q, scales, zeros, g)) + lin.bias.detach()
    assert torch.allclose(ql(x), ref, atol=1e-5)
    rel = (ql(x) - lin(x)).norm() / lin(x).norm()
    assert rel < 0.15, rel

    # Storage: 4 bits per code plus 16 + 8 bits per group of g weights.
    bpw = ql.bits_per_weight()
    assert abs(bpw - (4 + 24 / g)) < 1e-9, bpw
    print(f"rtn int4 g={g}: {bpw:.4f} bits/weight, {32 / bpw:.2f}x smaller than fp32, rel output error {rel:.3f}")
    print("PASS")
`,
    },
  },
  debrief: `The format is GPTQ's and AutoGPTQ's in miniature. **Asymmetric, per group**: a group of 128 weights from one output row shares an fp16 scale and an integer zero point, so one outlier only coarsens its own group, and a group that is mostly positive does not waste half its codes on negatives. The range always includes 0 so a weight of 0 stays exactly 0 (padding, pruned weights). The scale is rounded up to fp16 before the zero point is computed from it: the codes are what the stored numbers decode, with no fp32 value hiding in the error bound. **Packing** is pure layout: two codes per byte here, eight per \`int32\` in AutoGPTQ's \`qweight\`, and reshuffled offline in ExLlama's and Marlin's formats to match the order their kernels dequantize in (in Marlin, with full-width vector loads, straight into the tensor-core fragment layout). The order is the contract between the packer and the kernel. **QuantLinear** dequantizes the whole weight and runs a float matmul, which is correct and saves memory but not time; production kernels (ExLlamaV2, Marlin, the Triton kernels in GPTQModel) dequantize inside the matmul, in registers, one tile at a time, so the weight crosses HBM at 4 bits. At batch size 1 a decoder step is memory bound, which is where 4-bit weights make those matmuls close to 4× faster than fp16. Zero points are stored as 4-bit values packed like the codes in real checkpoints (\`qzeros\`); here they take a byte each, 8 of the 24 overhead bits per group.`,
};
