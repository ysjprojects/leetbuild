import type {Step} from '@/lib/types';

/** A pattern inside the body of the top-level function `name`: from its `def` to the next line that starts at column 0. */
const inFn = (name: string, body: string): RegExp =>
  new RegExp(String.raw`def ${name}\((?:(?!\n\S)[\s\S])*?(?:${body})`);

const HEADER = `"""NVFP4 from scratch: E2M1 elements, one E4M3 scale per 16 values, one FP32 scale per tensor, two codes per byte."""

from dataclasses import dataclass

import torch

E2M1_VALUES = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])  # magnitude of 3-bit code c is E2M1_VALUES[c]
BLOCK = 16
E4M3_MAX = 448.0
E2M1_MAX = 6.0
`;

const TENSOR = `@dataclass
class NVFP4Tensor:
    packed: torch.Tensor  # uint8 (..., K // 2)
    scales: torch.Tensor  # float8_e4m3fn (..., K // 16)
    global_scale: torch.Tensor  # float32 scalar
    shape: torch.Size
`;

const SELF_TEST = `if __name__ == "__main__":
    torch.manual_seed(0)

    # 1. The grid, the ties and saturation: ties go to the even code (0, 1.0, 2.0, 4.0 have mantissa bit 0).
    x = torch.tensor([0.25, 0.75, 1.25, 1.75, 2.5, 3.5, 5.0, 0.26, 2.6, 5.1, 6.0, 7.0, 1e6, -0.75, -5.0, -1e6])
    want = torch.tensor([0.0, 1.0, 1.0, 2.0, 2.0, 4.0, 4.0, 0.5, 3.0, 6.0, 6.0, 6.0, 6.0, -1.0, -4.0, -6.0])
    assert torch.equal(round_to_e2m1(x), want), round_to_e2m1(x)
    grid = torch.cat([-E2M1_VALUES.flip(0), E2M1_VALUES])
    assert torch.equal(round_to_e2m1(grid), grid), "grid points are fixed points"
    # Against brute force: nearest grid value, ties to the even code, on random inputs and every midpoint.
    probe = torch.cat([torch.randn(4000) * 3, (E2M1_VALUES[1:] + E2M1_VALUES[:-1]) / 2])
    probe = torch.cat([probe, -probe])
    dist = (probe.abs().unsqueeze(-1) - E2M1_VALUES).abs()
    best = dist.min(dim=-1, keepdim=True).values
    tied_even = (dist == best) & (torch.arange(8) % 2 == 0)
    pick = torch.where(tied_even.any(-1), tied_even.float().argmax(-1), dist.argmin(-1))
    brute = E2M1_VALUES[pick] * probe.sign()
    assert torch.equal(round_to_e2m1(probe), brute), "round_to_e2m1 disagrees with the nearest-even search"

    # 2. Codes and packing: all 16 codes, the bit layout, two per byte low nibble first.
    codes = torch.arange(16, dtype=torch.uint8)
    values = codes_to_e2m1(codes)
    assert torch.equal(values[:8], E2M1_VALUES) and torch.equal(values[8:], -E2M1_VALUES)
    keep = codes != 8  # code 8 is -0, which encodes back as code 0
    assert torch.equal(e2m1_to_codes(values[keep]), codes[keep]) and e2m1_to_codes(values[8:9]).item() == 0
    assert e2m1_to_codes(torch.tensor([-6.0])).item() == 0b1111
    assert e2m1_to_codes(torch.tensor([1.5])).item() == 0b0011
    assert pack_fp4(torch.tensor([3, 10], dtype=torch.uint8)).item() == 0xA3
    rand_codes = torch.randint(0, 16, (8, 64), dtype=torch.uint8)
    assert torch.equal(unpack_fp4(pack_fp4(rand_codes)), rand_codes)

    # 3. Quantize a Gaussian matrix with outliers (1% of the values 20x larger) and one all-zero block.
    M, K = 64, 256
    W_plain = torch.randn(M, K)
    W = torch.where(torch.rand(M, K) < 0.01, W_plain * 20, W_plain)
    W[5, 16:32] = 0.0
    t = quantize_nvfp4(W)
    assert t.packed.shape == (M, K // 2) and t.packed.dtype == torch.uint8
    assert t.scales.shape == (M, K // BLOCK) and t.scales.dtype == torch.float8_e4m3fn
    assert t.global_scale.dtype == torch.float32 and t.global_scale.dim() == 0 and t.shape == W.shape
    assert torch.isclose(t.global_scale, W.abs().max() / (6 * 448))
    assert t.scales.float().max() == E4M3_MAX, "the block holding the tensor amax uses the top of E4M3"
    W_hat = dequantize_nvfp4(t)

    # Per-element bound: half the local grid step at |x| / scale, times the block scale (normal E4M3 scales).
    scale = (t.scales.float() * t.global_scale).repeat_interleave(BLOCK, dim=1)
    a = (W / torch.where(scale > 0, scale, torch.ones_like(scale))).abs()
    half_step = torch.where(a < 2, 0.25, torch.where(a < 4, 0.5, 1.0))
    normal = t.scales.float().repeat_interleave(BLOCK, dim=1) >= 2**-6
    err = (W - W_hat).abs()
    assert (err[normal] <= half_step[normal] * scale[normal] * (1 + 1e-6)).all(), "an error exceeds half a step"
    assert normal.float().mean() > 0.99

    # The zero block: scale 0, codes 0, decodes to zeros. An all-zero tensor gets s_global = 1.
    assert t.scales[5, 1].float().item() == 0.0
    assert torch.equal(unpack_fp4(t.packed)[5, 16:32], torch.zeros(16, dtype=torch.uint8))
    assert torch.equal(W_hat[5, 16:32], torch.zeros(16))
    z = quantize_nvfp4(torch.zeros(4, 32))
    assert z.global_scale.item() == 1.0 and torch.equal(dequantize_nvfp4(z), torch.zeros(4, 32))

    # Against a slow reference: one block at a time in Python floats.
    def reference_block(xs: list[float], s_global: float) -> list[float]:
        amax_b = max(abs(v) for v in xs)
        s_b = torch.tensor(min(amax_b / 6.0 / s_global, 448.0)).to(torch.float8_e4m3fn).float().item()
        if s_b == 0.0:
            return [0.0] * len(xs)
        sc = s_b * s_global
        return [round_to_e2m1(torch.tensor([v / sc])).item() * sc for v in xs]

    s_g = t.global_scale.item()
    for r in range(4):
        for b in range(K // BLOCK):
            ref = reference_block(W[r, b * 16 : (b + 1) * 16].tolist(), s_g)
            assert torch.allclose(W_hat[r, b * 16 : (b + 1) * 16], torch.tensor(ref), rtol=1e-6, atol=0)

    # 4. Against MXFP4 (OCP MX v1.0): blocks of 32, X = 2^floor(log2 amax) / 2^2, an E8M0 power of two.
    def mxfp4_roundtrip(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        blocks = x.reshape(*x.shape[:-1], x.shape[-1] // 32, 32)
        amax = blocks.abs().amax(dim=-1, keepdim=True)
        exp = torch.floor(torch.log2(amax.clamp(min=2.0**-127))) - 2
        X = torch.exp2(exp.clamp(-127, 127)).to(torch.float8_e8m0fnu)
        return (round_to_e2m1(blocks / X.float()) * X.float()).reshape(x.shape), X

    _, X = mxfp4_roundtrip(W)
    assert torch.equal(X.float(), torch.exp2(torch.log2(X.float()).round())), "E8M0 scales are powers of two"
    for name, data in (("N(0, 1)", W_plain), ("N(0, 1), 1% of values x20", W)):
        mse_nv = (data - dequantize_nvfp4(quantize_nvfp4(data))).pow(2).mean().item()
        mse_mx = (data - mxfp4_roundtrip(data)[0]).pow(2).mean().item()
        print(f"MSE on {name}: NVFP4 {mse_nv:.5f}, MXFP4 {mse_mx:.5f} ({mse_mx / mse_nv:.2f}x)")
        assert mse_nv < mse_mx, "NVFP4 should beat MXFP4"

    # 5. Storage: 4 bits per code, 8 bits per 16 values, 32 bits per tensor.
    bits = (t.packed.numel() * t.packed.element_size() + t.scales.numel() * t.scales.element_size()) * 8
    bits += t.global_scale.numel() * t.global_scale.element_size() * 8
    assert bits == 4.5 * W.numel() + 32
    print(f"{bits} bits for {W.numel()} values: {(bits - 32) / W.numel()} bits/value + 32 per tensor")
    print("PASS")
`;

export const nvfp4QuantizeStep: Step = {
  id: 'nvfp4-quantize',
  title: 'E2M1 codes, E4M3 block scales, one FP32 tensor scale',
  concept: 'pytorch',
  file: 'nvfp4',
  focus: [
    'x-in',
    'amax',
    's-global',
    'block-amax',
    's-block',
    'e2m1-round',
    'codes',
    'pack',
    'nvfp4-out',
    'dequant',
    'block-codes',
    'packed-bytes',
    'scale-byte',
    'global-scale',
    'deq',
  ],
  task: `## Task

Write NVFP4 the way Blackwell's tensor cores read it: 4-bit E2M1 elements, one FP8 E4M3 scale per 16
consecutive values along the last dimension, one FP32 scale per tensor, two codes per byte. Write the
rounding and the bit operations yourself: no casting to \`torch.float4_e2m1fn_x2\` (it may only be a
\`view\` dtype), no Transformer Engine, TensorRT Model Optimizer, \`torchao\` or \`compressed_tensors\`.

- **Constants** (given): \`E2M1_VALUES = [0, 0.5, 1, 1.5, 2, 3, 4, 6]\` (the magnitude of 3-bit code
  \`c\` is \`E2M1_VALUES[c]\`), \`BLOCK = 16\`, \`E4M3_MAX = 448.0\`, \`E2M1_MAX = 6.0\`.
- \`round_to_e2m1(x)\`: each element to the nearest of ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}, ties to the
  **even code** (the one whose mantissa bit is 0), saturating at ±6. So 0.25 → 0, 0.75 → 1, 1.25 → 1,
  2.5 → 2, 3.5 → 4, 5 → 4, 7 → 6. The grid step is 0.5 below 2, 1 from 2 to 4, and 2 above.
- \`e2m1_to_codes(v)\` → uint8 in 0..15: sign in bit 3, exponent in bits 2..1, mantissa in bit 0, so
  the low 3 bits are the index into \`E2M1_VALUES\`. 1.5 is \`0b0011\`, −6 is \`0b1111\`, and 0 (also −0)
  is code 0. \`codes_to_e2m1(codes)\` → float32 inverts it (code 8 decodes to −0).
- \`pack_fp4(codes)\`: \`(..., n)\` uint8 → \`(..., n // 2)\` uint8, element \`2j\` in the **low** nibble and
  \`2j + 1\` in the high one (\`[3, 10]\` → \`0xA3\`). \`unpack_fp4\` inverts it.
- \`quantize_nvfp4(x) -> NVFP4Tensor\`: \`x\` is \`(..., K)\` with \`K % 16 == 0\`.
  - \`s_global = amax(|x|) / (6 · 448)\` as an FP32 scalar, or 1 when the tensor is all zeros.
  - Per block of 16: \`s_block = amax_block / 6 / s_global\`, clamped to 448, cast to
    \`torch.float8_e4m3fn\` (round to nearest even).
  - Each element: \`q = round_to_e2m1(x / (s_block_e4m3 · s_global))\` with the **stored** E4M3 scale,
    not the exact one, so codes and scales agree. A block whose scale is 0 encodes zeros.
  - Fields: \`packed\` uint8 \`(..., K/2)\`, \`scales\` float8_e4m3fn \`(..., K/16)\`, \`global_scale\` float32
    0-d, \`shape\`.
- \`dequantize_nvfp4(t)\` → float32 in \`t.shape\`: \`codes_to_e2m1(unpack_fp4(packed)) · s_block · s_global\`.

:::widget nvfp4-block {"outlier": true}

The self-test checks the ties, saturation and signs, and \`round_to_e2m1\` against a brute-force
nearest-even search. It checks every code, the bit layout and the packing round trip. On a \`64 × 256\`
Gaussian matrix where 1% of the values are 20× larger, it checks that every element whose block has a
normal E4M3 scale is within half its local grid step times the block scale. It checks that an all-zero
block stores scale 0 and decodes to zeros, and that the result matches a block-by-block reference. It
compares against MXFP4 (blocks of 32, \`X = 2^⌊log₂ amax⌋ / 4\` in E8M0): NVFP4's MSE is 0.00929
against 0.01315 on plain Gaussian values (1.42×) and 0.03661 against 0.13196 with the outliers (3.60×).
Then it counts 4.5 bits per value plus 32 bits per tensor and prints \`PASS\`.

> NVFP4 is MXFP4 with a finer ruler: half the block, and a scale with 3 mantissa bits instead of a
> power of two. The price of E4M3's narrow range is paid once per tensor, by one FP32 number.`,
  hints: [
    'Rounding: the grid is a float format, so the step is fixed within a binade. `step = 0.5` where `|x| < 2`, `1` where `|x| < 4`, else `2`; then `torch.round(|x| / step) * step` (which sends halves to the even neighbour), clamped to 6, with the sign put back. Even multiples of the step are exactly the even codes.',
    'Codes: `torch.searchsorted(E2M1_VALUES, v.abs())` finds the index of an exact grid value; OR in `(v < 0) << 3`. Packing is `codes[..., 0::2] | (codes[..., 1::2] << 4)`; unpacking is `torch.stack((p & 0xF, p >> 4), dim=-1).flatten(-2)`.',
    'Quantizing: `blocks = x.reshape(*x.shape[:-1], K // 16, 16)`, `block_amax = blocks.abs().amax(-1)`, `scales = (block_amax / 6 / s_global).clamp(max=448).to(torch.float8_e4m3fn)`, then divide by `scales.float().unsqueeze(-1) * s_global`. Where that scale is 0, write zeros instead of dividing.',
  ],
  checks: [
    {
      id: 'e2m1-rne',
      title: 'E2M1 rounding written by hand: nearest, ties to even, saturating',
      detail:
        '`round_to_e2m1` rounds onto the grid itself (`torch.round` per binade step, or a search over the midpoints) and saturates at ±6 (`clamp`). Casting to `torch.float4_e2m1fn_x2` is not the exercise, and CPU PyTorch cannot do it anyway: the dtype is for `view` only.',
      match: {
        python: {
          all: [
            inFn('round_to_e2m1', String.raw`torch\.round\(|\.round\(\)|searchsorted\(|bucketize\(`),
            inFn('round_to_e2m1', String.raw`clamp\(|clip\(|minimum\(|E2M1_MAX|6\.0`),
          ],
          none: [/\.to\(\s*(?:dtype\s*=\s*)?torch\.float4_e2m1fn_x2/],
        },
      },
    },
    {
      id: 'codes',
      title: 'Sign in bit 3, magnitude index in bits 2..0',
      detail:
        '`e2m1_to_codes` sets bit 3 for negatives (`<< 3`, `| 8`) on top of the index into `E2M1_VALUES`, and `codes_to_e2m1` masks the index back out (`& 0x7`). This is the bit layout of the OCP FP4 element: 1 sign, 2 exponent and 1 mantissa bits, bias 1.',
      match: {
        python: {
          all: [
            inFn('e2m1_to_codes', String.raw`<<\s*3|\*\s*8\b|\|\s*8\b|\+\s*8\b|0x0?8\b`),
            inFn('codes_to_e2m1', String.raw`&\s*(?:0x0?7|7)\b|%\s*8\b`),
            inFn('codes_to_e2m1', 'E2M1_VALUES'),
          ],
        },
      },
    },
    {
      id: 'pack',
      title: 'Two codes per byte, low nibble first',
      detail:
        'Even elements in bits 0 to 3, odd elements shifted `<< 4`; unpacking masks with `& 0xF` and shifts `>> 4`. The nibble order is part of the format: a kernel that reads the other nibble first multiplies by the wrong values.',
      match: {
        python: {
          all: [
            inFn('pack_fp4', String.raw`<<\s*4`),
            inFn('pack_fp4', String.raw`0::2|::2\]|\[\s*\.\.\.\s*,\s*0\s*\]|unflatten\(|reshape\([^\n]*,\s*2\s*\)`),
            inFn('unpack_fp4', String.raw`>>\s*4`),
            inFn('unpack_fp4', String.raw`&\s*(?:0x0?[fF]|15)\b`),
          ],
        },
      },
    },
    {
      id: 'global-scale',
      title: 'One FP32 scale per tensor: amax / (6 · 448)',
      detail:
        '`quantize_nvfp4` divides the tensor amax by `E2M1_MAX * E4M3_MAX` (2,688), so the block holding the largest value gets the largest E4M3 scale, 448, and every other block scale lands inside E4M3’s range.',
      match: {
        python: {
          all: [
            inFn(
              'quantize_nvfp4',
              String.raw`(?:E2M1_MAX|6(?:\.0)?)\s*\*\s*(?:E4M3_MAX|448(?:\.0)?)|(?:E4M3_MAX|448(?:\.0)?)\s*\*\s*(?:E2M1_MAX|6(?:\.0)?)|2688`,
            ),
          ],
        },
      },
    },
    {
      id: 'block-scale',
      title: 'One E4M3 scale per 16 values, clamped to 448',
      detail:
        'The last dimension is viewed as `(K // 16, 16)` blocks, each block’s amax over 6 and over `s_global` is clamped to 448 and cast `.to(torch.float8_e4m3fn)`. Library quantizers (Transformer Engine, Model Optimizer, `torchao`, `compressed_tensors`, FlashInfer) are not allowed.',
      match: {
        python: {
          all: [
            inFn('quantize_nvfp4', String.raw`(?:reshape|view|unflatten)\([^\n]*(?:BLOCK|16)`),
            inFn('quantize_nvfp4', 'float8_e4m3fn'),
            inFn('quantize_nvfp4', String.raw`(?:clamp|clip)\([^\n]*(?:E4M3_MAX|448)|minimum\(`),
          ],
          none: [
            /transformer_engine|modelopt|torchao|compressed_tensors|flashinfer|llmcompressor/,
            /quantize_per_(?:tensor|channel)/,
          ],
        },
      },
    },
    {
      id: 'stored-scale',
      title: 'Elements divided by the stored E4M3 scale',
      detail:
        'The cast to `float8_e4m3fn` comes before `round_to_e2m1` in `quantize_nvfp4`: elements are divided by `s_block_e4m3 · s_global`, the scale the decoder will multiply by. Dividing by the exact scale leaves a scale error of up to 6.25% in every dequantized value.',
      match: {python: {all: [inFn('quantize_nvfp4', String.raw`float8_e4m3fn(?:(?!\n\S)[\s\S])*?round_to_e2m1\(`)]}},
    },
    {
      id: 'dequant',
      title: 'Dequantize: q · s_block · s_global',
      detail:
        '`dequantize_nvfp4` unpacks the bytes, decodes the codes with `codes_to_e2m1`, multiplies each block by its E4M3 scale and the whole tensor by `global_scale`. Both scales are needed: the E4M3 values alone are off by `s_global`.',
      match: {
        python: {
          all: [
            inFn('dequantize_nvfp4', String.raw`unpack_fp4\(`),
            inFn('dequantize_nvfp4', String.raw`codes_to_e2m1\(`),
            inFn('dequantize_nvfp4', 'global_scale'),
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `${HEADER}

def round_to_e2m1(x: torch.Tensor) -> torch.Tensor:
    """Nearest E2M1 value of each element, ties to the even code, saturating at +-6. Same dtype as x."""
    # TODO: the grid spacing is 0.5 below 2, 1 from 2 to 4, and 2 above. Round the magnitude to a multiple
    # of its spacing (halves to the even multiple), saturate at 6, and put the sign back.
    raise NotImplementedError("TODO: round onto the signed E2M1 grid")


def e2m1_to_codes(v: torch.Tensor) -> torch.Tensor:
    """E2M1 values -> uint8 codes 0..15: sign in bit 3, exponent in bits 2..1, mantissa in bit 0."""
    raise NotImplementedError("TODO: index of the magnitude in E2M1_VALUES, plus the sign bit")


def codes_to_e2m1(codes: torch.Tensor) -> torch.Tensor:
    """uint8 codes 0..15 -> float32 E2M1 values."""
    raise NotImplementedError("TODO: look the low three bits up in E2M1_VALUES and apply the sign bit")


def pack_fp4(codes: torch.Tensor) -> torch.Tensor:
    """(..., n) uint8 codes -> (..., n // 2) uint8: element 2j in the low nibble, 2j + 1 in the high nibble."""
    raise NotImplementedError("TODO: even elements in the low nibble, odd elements in the high nibble")


def unpack_fp4(packed: torch.Tensor) -> torch.Tensor:
    """Inverse of pack_fp4: (..., m) uint8 -> (..., 2m) uint8, low nibble first."""
    raise NotImplementedError("TODO: split each byte and interleave the nibbles back into place")


${TENSOR}

def quantize_nvfp4(x: torch.Tensor) -> NVFP4Tensor:
    """x (..., K) float, K a multiple of 16: one E4M3 scale per 16 values along the last dimension, one FP32 scale."""
    # TODO: the tensor scale from the tensor amax; the blocks of 16 and their amax; the E4M3 block scales;
    # the elements divided by the stored scale times the tensor scale, rounded to E2M1; codes, packed.
    raise NotImplementedError("TODO: two-level scales, then codes")


def dequantize_nvfp4(t: NVFP4Tensor) -> torch.Tensor:
    """Every value times its block scale and the tensor scale, float32, in the original shape."""
    raise NotImplementedError("TODO: unpack, decode, scale back")


${SELF_TEST}`,
      solution: `${HEADER}

def round_to_e2m1(x: torch.Tensor) -> torch.Tensor:
    """Nearest E2M1 value of each element, ties to the even code, saturating at +-6. Same dtype as x."""
    a = x.abs()
    step = torch.where(a < 2, 0.5, torch.where(a < 4, 1.0, 2.0))  # the grid spacing in each binade
    q = (torch.round(a / step) * step).clamp(max=E2M1_MAX)  # torch.round sends halves to the even neighbour
    return torch.where(x < 0, -q, q).to(x.dtype)


def e2m1_to_codes(v: torch.Tensor) -> torch.Tensor:
    """E2M1 values -> uint8 codes 0..15: sign in bit 3, exponent in bits 2..1, mantissa in bit 0."""
    magnitude = torch.searchsorted(E2M1_VALUES, v.abs().float().contiguous())
    sign = (v < 0).to(torch.uint8)  # -0.0 < 0 is False: negative zero encodes as code 0
    return (sign << 3) | magnitude.to(torch.uint8)


def codes_to_e2m1(codes: torch.Tensor) -> torch.Tensor:
    """uint8 codes 0..15 -> float32 E2M1 values."""
    magnitude = E2M1_VALUES[(codes & 0x7).long()]
    return torch.where((codes & 0x8) != 0, -magnitude, magnitude)


def pack_fp4(codes: torch.Tensor) -> torch.Tensor:
    """(..., n) uint8 codes -> (..., n // 2) uint8: element 2j in the low nibble, 2j + 1 in the high nibble."""
    assert codes.shape[-1] % 2 == 0
    return codes[..., 0::2] | (codes[..., 1::2] << 4)


def unpack_fp4(packed: torch.Tensor) -> torch.Tensor:
    """Inverse of pack_fp4: (..., m) uint8 -> (..., 2m) uint8, low nibble first."""
    return torch.stack((packed & 0xF, packed >> 4), dim=-1).flatten(-2)


${TENSOR}

def quantize_nvfp4(x: torch.Tensor) -> NVFP4Tensor:
    """x (..., K) float, K a multiple of 16: one E4M3 scale per 16 values along the last dimension, one FP32 scale."""
    assert x.shape[-1] % BLOCK == 0, "K must be a multiple of 16"
    x = x.float()
    amax = x.abs().amax()
    global_scale = torch.where(amax > 0, amax / (E2M1_MAX * E4M3_MAX), torch.ones_like(amax))
    blocks = x.reshape(*x.shape[:-1], x.shape[-1] // BLOCK, BLOCK)
    block_amax = blocks.abs().amax(dim=-1)
    scales = (block_amax / E2M1_MAX / global_scale).clamp(max=E4M3_MAX).to(torch.float8_e4m3fn)
    scale = scales.float().unsqueeze(-1) * global_scale  # what one E2M1 unit is worth in each block
    safe = torch.where(scale > 0, scale, torch.ones_like(scale))
    q = torch.where(scale > 0, round_to_e2m1(blocks / safe), torch.zeros_like(blocks))  # scale 0: zeros
    codes = e2m1_to_codes(q).reshape(x.shape)
    return NVFP4Tensor(pack_fp4(codes), scales, global_scale.float(), x.shape)


def dequantize_nvfp4(t: NVFP4Tensor) -> torch.Tensor:
    """Every value times its block scale and the tensor scale, float32, in the original shape."""
    values = codes_to_e2m1(unpack_fp4(t.packed))
    blocks = values.reshape(*t.scales.shape, BLOCK)
    return (blocks * t.scales.float().unsqueeze(-1) * t.global_scale).reshape(t.shape)


${SELF_TEST}`,
    },
  },
  debrief: `The format is the one in NVIDIA's NVFP4 pretraining paper (Appendix B) and Transformer Engine's \`NVFP4Quantizer\`, minus the hardware. **The element** is the OCP FP4 E2M1 type: 15 distinct values, a step of 0.5 below 2, 1 up to 4 and 2 up to 6, so rounding is a float rounding and ties go to the even code exactly as \`torch.round\` sends halves to the even integer. **The block scale** is the change from MXFP4. MXFP4 rounds each 32-value block's scale to a power of two (E8M0). Rounded up, as the NVFP4 paper does for MXFP4, the block amax can land as low as 3 of the 6 the grid reaches, a binade lost; rounded down, by the OCP spec's floor rule used here, it lands anywhere in [4, 8) and clamps to 6 above 6. NVFP4 stores \`amax/6\` in E4M3, within 6.25%, for every 16 values, so each block's largest value lands on or next to ±6 and the grid is used to its top. **The tensor scale** pays for E4M3's narrow range (2⁻⁹ to 448): dividing by \`amax / (6 · 448)\` moves the largest block scale to exactly 448, and the others below it. A block about 29,000 times quieter than the loudest gets a subnormal E4M3 scale with fewer mantissa bits, and one about 459,000 times quieter a scale of 0, which is why the test asserts its error bound only where the E4M3 scale is normal. The cost: 4 + 8/16 = 4.5 bits per value, plus 32 bits per tensor, against 4.25 for MXFP4. On the test matrix that buys 1.42× less squared error on plain Gaussian values and 3.60× with 1% outliers. Production adds what this file leaves out: Blackwell's tensor cores consume the packed codes and swizzled scale tiles directly, applying the two E4M3 block scales per 16-wide partial dot product and the two FP32 scales once on the output. For training, the recipe adds 16 × 16 2D weight blocks, stochastic rounding of gradients and random Hadamard transforms before the weight-gradient GEMM.`,
};
