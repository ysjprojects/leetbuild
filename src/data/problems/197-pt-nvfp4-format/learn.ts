/**
 * The learning guide for NVFP4: the E2M1 element and its rounding, why 4-bit values need block
 * scales, MXFP4's power-of-two scale against NVFP4's E4M3 scale and FP32 tensor scale, the bytes in
 * memory, and the measured error against MXFP4. Rendered at `/pt-nvfp4-format/learn`.
 */
export const learn = `# The mechanism at a glance

NVFP4 is the 4-bit floating-point format of NVIDIA's Blackwell GPUs. A tensor in NVFP4 is three
arrays: 4-bit E2M1 values, one FP8 E4M3 scale for every 16 consecutive values, and one FP32 scale for
the whole tensor. A value decodes as

\`\`\`text
x̂ = e2m1 · s_block · s_global
\`\`\`

The terms this guide uses, each explained again where it first matters:

| term | meaning |
|---|---|
| sign, exponent, mantissa | the three fields of a floating-point number: the sign bit, a power of two, and the fraction bits that pick a point between that power and the next |
| ExMy | a float with 1 sign bit, x exponent bits and y mantissa bits |
| E2M1 | the 4-bit element: ±{0, 0.5, 1, 1.5, 2, 3, 4, 6} |
| E4M3 | an 8-bit float (FP8) with 3 mantissa bits, largest value 448: NVFP4's block scale |
| E8M0 | 8 exponent bits and nothing else: a power of two from 2⁻¹²⁷ to 2¹²⁷, MXFP4's block scale |
| block | 16 consecutive values along the last dimension that share one scale |
| scale | the number a block is divided by before rounding and multiplied by after |
| amax | the largest absolute value in a group: a block or the whole tensor |
| round to nearest even (RNE) | take the closest representable value; on an exact tie, the one whose last mantissa bit is 0 |
| saturate | a value beyond the largest representable one becomes that largest one, sign kept |
| code | the 4-bit pattern (0 to 15) that stores one E2M1 value |
| nibble, packing | a nibble is half a byte; packing stores two 4-bit codes in one \`uint8\` |
| binade | the range between two consecutive powers of two, such as [2, 4) |

The format is a refinement of MXFP4, the 4-bit member of the Open Compute Project's
[Microscaling (MX) specification](https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf/):
the same E2M1 element, but half the block and a scale with mantissa bits. NVIDIA presented it for
inference in June 2025 ([NVIDIA Technical Blog](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/))
and showed months later that a 12B model can be pretrained on 10 trillion tokens with its matmuls in
NVFP4 ([NVIDIA, 2025](https://arxiv.org/abs/2509.25149)).

Quantizing a tensor takes two passes over it: one for the tensor's largest magnitude, one that scales
each block of 16 and rounds every value onto the 4-bit grid.

:::architecture
{
  "input": "x · (..., K) float32",
  "output": "packed codes · E4M3 scales · FP32 scale",
  "items": [
    {"id": "g-x", "label": "Tensor x", "kind": "io", "sub": "blocks of 16 along K", "detail": "K is the reduction dimension of the matmul that will consume the tensor, so one block scale multiplies one 16-wide partial dot product."},
    {"id": "g-sg", "label": "Tensor scale", "sub": "s_g = amax / (6 · 448) · FP32", "detail": "Chosen so that the block holding the tensor's largest value gets E4M3's largest scale, 448."},
    {"tone": "block", "repeat": "K/16 ×", "label": "Each block of 16", "items": [
      {"id": "g-sb", "label": "Block scale", "kind": "attention", "sub": "s_b = e4m3(amax_b / 6 / s_g)", "detail": "Rounded to nearest even into FP8 E4M3, clamped at 448."},
      {"id": "g-q", "label": "Round to E2M1", "kind": "attention", "sub": "q = rne(x / (s_b · s_g)), ±6"},
      {"id": "g-c", "label": "4-bit code", "sub": "sign · exponent · mantissa"}
    ]},
    {"id": "g-p", "label": "Pack", "sub": "two codes per byte", "detail": "Even element in the low nibble."},
    {"id": "g-out", "label": "NVFP4 tensor", "kind": "io", "sub": "4.5 bits per value + 32 per tensor"}
  ],
  "notes": [
    {"at": "g-sg", "text": "**One** FP32 number per tensor"},
    {"at": "g-sb", "text": "**One byte** per 16 values"},
    {"at": "g-out", "text": "**3.56×** smaller than BF16"}
  ]
}
:::

The project writes all of it in one file, \`nvfp4.py\`: \`round_to_e2m1\`, \`e2m1_to_codes\` and
\`codes_to_e2m1\`, \`pack_fp4\` and \`unpack_fp4\`, \`quantize_nvfp4\` returning an
\`NVFP4Tensor(packed, scales, global_scale, shape)\`, and \`dequantize_nvfp4\`. What the format costs
against the alternatives:

| format | element | scale | bits per value | vs BF16 |
|---|---|---|---|---|
| BF16 | 16-bit float | none | 16 | 1× |
| FP8 E4M3, per tensor | 8-bit float | FP32 per tensor | 8 (+ 32 per tensor) | 2× |
| MXFP4 | E2M1 | E8M0 per 32 values | 4 + 8/32 = 4.25 | 3.76× |
| NVFP4 | E2M1 | E4M3 per 16 values, FP32 per tensor | 4 + 8/16 = 4.5 (+ 32 per tensor) | 3.56× |

NVFP4 spends a quarter of a bit per value more than MXFP4. The rest of this guide is about what that
quarter bit buys.

# E2M1: fifteen values and a rounding rule

**Floating point in a few bits.** A float stores a number as a sign, a power of two and a fraction.
With \`s\` the sign bit, \`e\` the exponent field read as an unsigned integer, \`m\` the mantissa field
and \`M\` the number of mantissa bits (the OCP spec's definition):

\`\`\`text
normal    (e > 0):  (−1)^s · (1 + m / 2^M) · 2^(e − bias)
subnormal (e = 0):  (−1)^s · (0 + m / 2^M) · 2^(1 − bias)
\`\`\`

The **bias** lets unsigned exponent bits reach powers below 1 as well as above. A normal number has an
implicit leading 1; a subnormal drops it, which is how the format reaches 0 and the values near it.
Within one binade the exponent is fixed, so the mantissa splits that binade into \`2^M\` equal steps.

E2M1 is this in four bits: 1 sign bit, 2 exponent bits with bias 1, 1 mantissa bit. The OCP spec
defines it with subnormals and no infinities or NaN. Exponent 0 is the subnormal binade, holding 0
and 0.5; exponents 1 to 3 are normal, \`(1 + m/2) · 2^(e − 1)\`. Code 0101, for example, has \`e = 2\`
and \`m = 1\`: \`(1 + 1/2) · 2^1 = 3\`.

| code | sign | exponent | mantissa | value |
|---|---|---|---|---|
| 0000 | 0 | 00 | 0 | 0 |
| 0001 | 0 | 00 | 1 | 0.5 |
| 0010 | 0 | 01 | 0 | 1.0 |
| 0011 | 0 | 01 | 1 | 1.5 |
| 0100 | 0 | 10 | 0 | 2 |
| 0101 | 0 | 10 | 1 | 3 |
| 0110 | 0 | 11 | 0 | 4 |
| 0111 | 0 | 11 | 1 | 6 |
| 1xxx | 1 | | | the same magnitudes, negative; 1000 is −0 |

Two things fall out of the table. The low three bits of a code are the index of its magnitude in
\`E2M1_VALUES = [0, 0.5, 1, 1.5, 2, 3, 4, 6]\`, so encoding is a search and decoding a lookup. And the
grid is not uniform: the step is 0.5 up to 2, 1 from 2 to 4, and 2 from 4 to 6. Large values are
stored with roughly the same relative precision as small ones, which is why a float grid fits a bell-shaped
distribution better than 16 evenly spaced integers.

**Rounding.** The spec requires round to nearest, ties to even, and saturation: a value beyond 6
becomes 6 with its sign kept, never an overflow. "Even" means the code whose mantissa bit is 0. Within
one binade the step is fixed, so rounding is \`round(|x| / step) · step\`, and the even codes are
exactly the even multiples of the step:

\`\`\`text
step = 0.5 if |x| < 2 else 1 if |x| < 4 else 2
q    = sign(x) · min(round_half_even(|x| / step) · step, 6)
\`\`\`

\`torch.round\` already sends halves to the even integer, so this is three lines of PyTorch. Every tie:

| value | neighbours | rounds to | because |
|---|---|---|---|
| 0.25 | 0 (0000), 0.5 (0001) | 0 | 0000 is even |
| 0.75 | 0.5 (0001), 1 (0010) | 1 | |
| 1.25 | 1 (0010), 1.5 (0011) | 1 | |
| 1.75 | 1.5 (0011), 2 (0100) | 2 | crosses into the next binade |
| 2.5 | 2 (0100), 3 (0101) | 2 | |
| 3.5 | 3 (0101), 4 (0110) | 4 | |
| 5 | 4 (0110), 6 (0111) | 4 | |

Exact ties are rare in real data after a fractional scale, but the rule must be fixed so that every
encoder writes the same bits, and ties to even does not push ties in one direction on average, as
always rounding halves up would. Training recipes go further for gradients and use stochastic
rounding, which makes the expected value of the quantized tensor equal the original.

:::quiz
Q: After scaling, a block holds the values 4.9, 5.0 and 5.1. What does E2M1 store for them?
- [ ] 4, 6 and 6: halves round up
- [x] 4, 4 and 6: 5.0 is a tie between 4 (0110) and 6 (0111), and 0110 has the even mantissa bit
- [ ] 5, 5 and 5: E2M1 rounds to the nearest integer
> Between 4 and 6 the step is 2, so 5 is the midpoint. Ties to even pick the code with mantissa bit 0,
> which is 4. 4.9 is nearer to 4 and 5.1 nearer to 6. There is no 5 in E2M1: above 4 the only value
> is 6.
:::

# Why 4-bit values need a scale per block

E2M1's nonzero magnitudes run from 0.5 to 6, a ratio of 12, or 3.58 binades. A tensor of activations
or weights spans far more than that, so the values have to be scaled into the grid first, and the
choice of scale decides the error. The amax rule maps the largest magnitude in a group onto 6:
\`s = amax / 6\`. Everything else in the group is then rounded on a grid whose step is set by that
largest value.

With **one scale for the whole tensor**, a single outlier sets the step for millions of values. On
the self-test's \`64 × 256\` Gaussian matrix with 1% of the values 20× larger, the tensor amax is 57.7
and the smallest step is \`0.5 · 57.7 / 6 ≈ 4.8\`. Every ordinary value, almost all of them under 3 in
magnitude, rounds to 0 or ±4.8. The mean squared error is 0.994 against a signal power of 4.43.

With **one scale per small block**, an outlier only coarsens the grid of its own block. MXFP4 uses
blocks of 32 values and an 8-bit E8M0 scale: an exponent only, so the scale is a power of two. The
OCP conversion rule takes the largest power of two at or below the block amax and divides by 4, the
largest power of two in E2M1:

\`\`\`text
X = 2^floor(log2(amax_block)) / 2^2        MXFP4, one E8M0 byte per 32 values
\`\`\`

NVFP4 uses blocks of 16 and stores \`amax_block / 6\` itself in E4M3, so the block amax lands on 6 (or
within one E4M3 rounding of it). Compare the two on 32 values:

:::widget nvfp4-block {"outlier": false}

Resample a few times: the two NVFP4 blocks get different grids, and MXFP4's single grid is set by
whichever half holds the larger value. Switch the outlier on. NVFP4's block 0 coarsens, block 1 keeps
its fine grid, and the whole MXFP4 block coarsens with it.

:::architecture
{
  "input": "the same block of 32 values",
  "output": "squared error compared",
  "items": [
    {"id": "c-x", "label": "32 values", "kind": "io", "sub": "N(0, 1), maybe one outlier"},
    {"columns": [
      [
        {"id": "c-mx-s", "label": "MXFP4 scale", "sub": "X = 2^⌊log₂ amax⌋ / 4", "detail": "One E8M0 byte for all 32 values. The block amax lands anywhere in [4, 8) times X; above 6 it clamps."},
        {"id": "c-mx-q", "label": "Round 32 values", "sub": "rne(x / X), ±6"}
      ],
      [
        {"id": "c-nv-s", "label": "NVFP4 scales, 2 blocks", "kind": "attention", "sub": "e4m3(amax_b / 6 / s_g)", "detail": "Two E4M3 bytes, one per 16 values, under one FP32 tensor scale. Each block amax lands within 6.25% of 6."},
        {"id": "c-nv-q", "label": "Round 16 + 16 values", "kind": "attention", "sub": "rne(x / (s_b · s_g)), ±6"}
      ]
    ]},
    {"id": "c-err", "label": "Mean squared error", "kind": "loss", "sub": "‖x − x̂‖² / n"}
  ],
  "notes": [
    {"at": "c-mx-s", "text": "Amax lands in **[4, 8) · X**", "side": "left"},
    {"at": "c-nv-s", "text": "Amax lands in **[5.67, 6.37] · s**"},
    {"at": "c-err", "text": "**3.60×** lower for NVFP4 with outliers"}
  ]
}
:::

Two separate changes are at work, and the self-test's matrix measures each (mean squared error;
signal power 1.01 for plain Gaussian values, 4.43 with 1% of the values 20× larger):

| scaling | block | scale type | plain N(0, 1) | with outliers |
|---|---|---|---|---|
| one per tensor | whole tensor | FP32 | 0.01569 | 0.99402 |
| MXFP4 (OCP floor rule) | 32 | E8M0 | 0.01315 | 0.13196 |
| MXFP4, scale rounded up | 32 | E8M0 | 0.01327 | 0.13424 |
| E4M3 scale, 32-value blocks | 32 | E4M3 + FP32 | 0.01072 | 0.06360 |
| NVFP4 | 16 | E4M3 + FP32 | 0.00929 | 0.03661 |
| exact FP32 scale per block | 16 | FP32 | 0.00923 | 0.03451 |

The scale's precision does most of the work on plain values; the smaller block does most of it once
there are outliers. NVFP4 ends within 1% of an exact FP32 block scale on plain data, with one byte
where FP32 would take four.

:::quiz
Q: On the self-test's matrix, 1% of the values are 20× larger than the rest. Why does NVFP4 lose so much less than one 4-bit scale for the whole tensor?
- [ ] E2M1 has a wider range than INT4
- [x] Each outlier only sets the grid of its own 16 values; every other block keeps a grid sized to its own amax
- [ ] NVFP4 stores outliers in FP8 separately
> The amax rule maps a group's largest value to 6, so the group's step is proportional to its largest
> value. With one scale per tensor that group is the whole tensor and the outliers crush everything to
> 0 or the first grid point. With blocks of 16, 14% of the blocks hold an outlier and the rest are
> unaffected.
:::

# E4M3 block scales and the FP32 tensor scale

A power-of-two scale can be off from the ideal \`amax / 6\` by almost a factor of 2. Under the OCP floor
rule the block amax lands anywhere from 4 to just under 8 grid units: above 6 it clamps, which on the
plain Gaussian matrix happens in 28% of MXFP4's blocks. Rounding the scale up instead, as the NVFP4
paper notes is common practice for MXFP4 to avoid clamping, the amax can land as low as 3, leaving
the 4 and 6 grid points unused and a whole binade of the element's range wasted. Either way a quarter
to a half of the grid is spent badly in many blocks.

E4M3 (1 sign, 4 exponent bits with bias 7, 3 mantissa bits) is the FP8 format already used for
weights and activations on Hopper. Its 3 mantissa bits split every binade into 8 steps: between 64
and 128 it stores 64, 72, 80, …, 120. Any value in its normal range is at most half a step, 1/16 of
the binade's start or 6.25%, from a stored one. Its largest value is \`1.75 · 2⁸ = 448\` (exponent
1111 with mantissa 111 is NaN). So the block amax lands between 5.67 and 6.37 grid units (multiples
of \`s_block · s_global\`, measured over the test matrix) and saturates by at most 0.37 of a unit. The
NVFP4 paper puts it as: at least one value in every block of 16, its amax, is stored at close to FP8
precision.

The price is range. E8M0 spans 2⁻¹²⁷ to 2¹²⁷; E4M3 spans 2⁻⁹ to 448, about 17.8 binades, with the
bottom three of them subnormal. Raw block scales \`amax_b / 6\` of a tensor could fall anywhere, so
NVFP4 adds the second level: one FP32 scale for the tensor that moves all block scales into E4M3's
range together.

\`\`\`text
s_global = amax(|x|) / (6 · 448)                 FP32, one per tensor (1 for an all-zero tensor)
s_block  = e4m3(min(amax_block / 6 / s_global, 448))      one byte per 16 values
q        = e2m1(x / (s_block · s_global))         ties to even, saturate at ±6
x̂        = q · s_block · s_global
\`\`\`

The block that holds the tensor's amax gets \`s_block = 448\` exactly, E4M3's maximum, and every other
block a smaller one. The next section quantizes one block by hand.

The failures this design avoids, each measured on the self-test's matrix:

| what goes wrong | what happens | MSE, plain N(0, 1) |
|---|---|---|
| nothing (NVFP4 as specified) | | 0.00929 |
| elements divided by the exact block scale, decoded with the stored one | every value in a block is off by the scale's rounding, up to 6.25% | 0.00977 |
| no tensor scale (\`s_global = 1\`), data of magnitude 10⁻³ | every \`amax_b / 6\` is below half of E4M3's smallest subnormal, so every block scale is 0 | 1.01 (relative: all signal lost) |
| no tensor scale, data of magnitude 10³ | block scales above 448 clamp, so block amaxes saturate | 0.01065 (relative) |
| one scale per tensor | outliers set every value's step | 0.01569; 0.99402 with outliers |

The second row is why \`quantize_nvfp4\` casts the scale to \`float8_e4m3fn\` **before** it divides the
elements: the encoder must divide by the number the decoder will multiply by. The tensor scale has a
limit too. A block whose amax is about 29,000 times smaller than the tensor's gets a subnormal E4M3
scale with fewer mantissa bits, and one about 459,000 times smaller gets 0 and decodes to zeros. That
is acceptable: its values are below the error of the loudest block anyway.

:::quiz
Q: Why does NVFP4 need the FP32 tensor scale when MXFP4 does not?
- [ ] FP32 is needed to store the sign of the block scales
- [x] E4M3 covers only about 18 binades (2⁻⁹ to 448), so raw block scales must first be moved into that range; E8M0 covers 254 binades and needs no help
- [ ] The tensor scale replaces the block scales for blocks of zeros
> E4M3 trades exponent bits for mantissa bits. Its range cannot hold the block scales of an arbitrary
> tensor, but after dividing by \`amax / (6 · 448)\` the largest block scale is exactly 448 and the rest
> lie below it, inside the range for all blocks within about 459,000× of the loudest.
:::

# One block, by hand

Take this block of 16 values from a tensor whose amax, in some other block, is 10:

\`\`\`text
x = [−0.08, 0.36, −0.78, 0.07, 0.66, −0.25, 1.62, −1.60, 0.03, −0.31, 0.29, −0.22, 0.85, 0.11, 0.55, 0.43]
\`\`\`

1. **Tensor scale.** \`s_global = 10 / (6 · 448) = 10 / 2,688 = 0.0037202\`.
2. **Block amax.** The largest \`|x|\` in the block is 1.62.
3. **Block scale.** Exactly, \`1.62 / 6 / 0.0037202 = 72.58\`. That is below 448, so nothing clamps. In
   the binade [64, 128) E4M3 stores 64, 72, 80, …, so 72.58 rounds to 72.0 = \`1.125 · 2⁶\`: sign 0,
   exponent \`6 + 7 = 13 = 1101\`, mantissa \`0.125 · 8 = 1 = 001\`, the byte \`0 1101 001 = 0x69\`.
4. **One grid unit.** \`u = 72.0 · 0.0037202 = 0.26786\`. Every element is divided by this stored
   value, not by \`72.58 · s_global\`.
5. **Round and encode.** Divide by \`u\`, round onto E2M1 (step 0.5 below 2, 1 up to 4, 2 above, ties
   to even, ±6 at most), then write the code: bit 3 is the sign, bits 2..0 the index into
   \`E2M1_VALUES\`.

| x | x / u | E2M1 | code | decodes to |
|---|---|---|---|---|
| −0.08 | −0.299 | −0.5 | 1001 (9) | −0.134 |
| 0.36 | 1.344 | 1.5 | 0011 (3) | 0.402 |
| −0.78 | −2.912 | −3 | 1101 (D) | −0.804 |
| 0.07 | 0.261 | 0.5 | 0001 (1) | 0.134 |
| 0.66 | 2.464 | 2 | 0100 (4) | 0.536 |
| −0.25 | −0.933 | −1 | 1010 (A) | −0.268 |
| 1.62 | 6.048 | 6 | 0111 (7) | 1.607 |
| −1.60 | −5.973 | −6 | 1111 (F) | −1.607 |
| 0.03 | 0.112 | 0 | 0000 (0) | 0 |
| −0.31 | −1.157 | −1 | 1010 (A) | −0.268 |
| 0.29 | 1.083 | 1 | 0010 (2) | 0.268 |
| −0.22 | −0.821 | −1 | 1010 (A) | −0.268 |
| 0.85 | 3.173 | 3 | 0101 (5) | 0.804 |
| 0.11 | 0.411 | 0.5 | 0001 (1) | 0.134 |
| 0.55 | 2.053 | 2 | 0100 (4) | 0.536 |
| 0.43 | 1.605 | 1.5 | 0011 (3) | 0.402 |

Four rows are worth a second look. 0.261 is just above 0.25, the midpoint of 0 and 0.5, so it rounds
up to 0.5. 2.464 sits in [2, 4), where the step is 1, so its neighbours are 2 and 3 and it goes to 2.
−0.821 lies between 0.5 and 1, nearer 1. And 6.048 is above 6 because E4M3 rounded the scale down
from 72.58 to 72: it saturates to 6, and the block amax decodes to 1.607 instead of 1.62.

Decoding reverses it: code D is \`1101\`, sign bit 1 and index \`101 = 5\`, so \`−E2M1_VALUES[5] · u =
−3 · 0.26786 = −0.804\`. The block's mean squared error is 0.0022. MXFP4 on the same 16 values uses
\`X = 2^⌊log₂ 1.62⌋ / 4 = 0.25\`: 1.62 becomes 6.48, rounds to 6 and decodes to 1.5, and the block's
error is 0.0038.

:::quiz
Q: The tensor amax doubles to 20 and this block stays the same. What changes in its encoding?
- [ ] Every code halves, since s_global doubled
- [x] Only the scale byte: the exact scale halves to 36.29, E4M3 rounds it to 36 (0x61), and the grid unit 36 · 20 / 2,688 is still 0.26786
- [ ] The block scale clamps at 448
> \`s_global\` doubles and \`amax_b / 6 / s_global\` halves. Halving moves a number down one binade
> without changing its mantissa, so E4M3 rounds 36.29 to 36 exactly as it rounded 72.58 to 72. The
> product \`s_block · s_global\`, and with it every code, stays the same.
:::

# The bytes in memory

Nothing in a byte-addressed tensor is 4 bits wide, so two codes share a \`uint8\`: element \`2j\` in the
low nibble (bits 0 to 3), \`2j + 1\` in the high nibble (bits 4 to 7). \`[3, 10]\` packs to
\`3 | 10 << 4 = 0xA3\`. The block above, in memory:

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "m-codes", "label": "Codes of one block", "sub": "uint8 · 0 … 15", "items": [
      {"array": "codes[r, 16b … 16b + 15]", "sub": "hex", "cols": 16, "cells": ["9", "3", "D", "1", "4", "A", "7", "F", "0", "A", "2", "A", "5", "1", "4", "3"], "marks": [{"cols": [0, 1], "tone": "a", "label": "b0"}, {"cols": [2, 3], "tone": "b", "label": "b1"}, {"cols": [14, 15], "tone": "c", "label": "b7"}], "detail": "The codes from the table above. Code 7 is +6, F is −6, 9 is −0.5, 0 is 0. Each marked pair becomes one packed byte."}
    ]},
    {"id": "m-hbm", "label": "NVFP4Tensor in global memory", "sub": "9 bytes per 16 values", "tone": "global", "layout": "column", "align": "start", "items": [
      {"id": "m-packed", "array": "packed[r, 8b … 8b + 7]", "sub": "uint8 · low nibble first", "cols": 8, "cells": ["39", "1D", "A4", "F7", "A0", "A2", "15", "34"], "marks": [{"cols": [0, 0], "tone": "a"}, {"cols": [1, 1], "tone": "b"}, {"cols": [7, 7], "tone": "c"}], "detail": "9 | 3 << 4 = 0x39."},
      {"id": "m-scale", "array": "scales[r, b]", "sub": "E4M3 · 1 byte", "cols": 1, "cells": ["0x69"], "detail": "72.0: sign 0, exponent 1101, mantissa 001."},
      {"id": "m-sg", "array": "global_scale", "sub": "FP32 · per tensor", "cols": 1, "cells": ["s_g"]}
    ]}
  ],
  "arrows": [
    {"from": "m-codes", "to": "m-hbm", "label": "pack_fp4 → packed"}
  ]
}
:::

The accounting per block of 16 values:

| piece | bits | per value |
|---|---|---|
| 16 codes | 64 | 4 |
| 1 E4M3 scale | 8 | 0.5 |
| FP32 tensor scale | 32 per tensor | about 0 |
| total | 72 per block | 4.5 |

On the self-test's \`64 × 256\` matrix that is 73,760 bits: \`4.5 · 16,384 + 32\`.

- **The nibble order is the format.** A kernel that reads the high nibble first multiplies by the
  wrong values and nothing crashes. PyTorch has a dtype for exactly this layout,
  \`torch.float4_e2m1fn_x2\` (two E2M1 values per byte), but on CPU it cannot be converted to or from
  float; \`packed.view(torch.float4_e2m1fn_x2)\` relabels the bytes and nothing more.
- **Scales live apart from the codes.** \`scales\` is a separate \`(..., K/16)\` tensor, as the
  OCP spec allows. Transformer Engine pads it to multiples of 128 × 4 and swizzles it into the tile
  order the tensor cores read; this project keeps the plain row-major layout.
- **Blocks run along K.** A matmul sums over K, so a tensor core multiplies two 16-wide blocks,
  applies the two block scales to that partial dot product, and the two tensor scales once to the
  output. A weight and its transpose are therefore blocked along different dimensions and quantize
  to different values, unless the blocks are 16 × 16 squares, which is what the training recipe uses
  for weights.

:::quiz
Q: A 7B-parameter model's linear weights are stored in NVFP4. Roughly how much memory do they take, compared with BF16?
- [ ] 3.5 GB, a quarter of BF16's 14 GB
- [x] About 3.9 GB: 4.5 bits per value, 3.56× less than BF16's 14 GB
- [ ] 7 GB: the scales cost as much as the codes
> 7 · 10⁹ values · 4.5 bits = 31.5 · 10⁹ bits ≈ 3.94 GB. The block scales add an eighth to the 4-bit
> codes; the tensor scales are a few bytes per matrix. NVIDIA's blog quotes about 3.5× less memory
> than FP16 and about 1.8× less than FP8.
:::

# Writing it: an order that works, and common mistakes

Build the file bottom-up and test each function before the next one uses it:

1. \`round_to_e2m1\`: check the tie table above (0.25 → 0, 2.5 → 2, 5 → 4) and 7 → 6.
2. \`e2m1_to_codes\` and \`codes_to_e2m1\`: decode all 16 codes, encode them back.
3. \`pack_fp4\` and \`unpack_fp4\`: \`[3, 10]\` must give \`0xA3\`, not just survive a round trip.
4. \`quantize_nvfp4\`: tensor amax and \`s_global\`, reshape to \`(..., K/16, 16)\`, block amax, the cast
   to \`float8_e4m3fn\`, the division by the stored scale, the zero-scale guard, codes, packing.
5. \`dequantize_nvfp4\`, then the block above: you should get its codes, \`0x69\` and \`0x39 0x1D …\`.

The mistakes that come up, and what they look like:

| mistake | what you see | fix |
|---|---|---|
| \`torch.round(x)\` without the per-binade step | 4.9 → 5, not on the grid; 1.3 → 1, not 1.5 | divide by the step, round, multiply back |
| no clamp after rounding | 7 → 8 | \`.clamp(max=6)\` |
| amax as \`x.max()\` | a block whose largest magnitude is negative gets too small a scale and saturates | \`x.abs().amax()\` |
| arithmetic on the E4M3 scales | \`RuntimeError: Promotion for Float8 Types is not supported\` | \`scales.float()\` first |
| dividing an all-zero block by its scale 0 | 0 / 0 = NaN, which has no E2M1 code | \`torch.where(scale > 0, …, 0)\` |
| dividing by the exact scale | the scale's rounding error, up to 6.25%, in every value: MSE 0.00977, not 0.00929 | cast the scale first |
| nibbles swapped in both pack and unpack | your own round trip passes, but \`[3, 10]\` packs to \`0x3A\` and a kernel decodes garbage | low nibble first |
| sign taken with \`torch.signbit\` | −0 gets code 8 | \`v < 0\`, false for −0 |

:::quiz
Q: Your \`pack_fp4\` puts element \`2j\` in the high nibble, and your \`unpack_fp4\` reads it from there. Which test catches it?
- [ ] The packing round trip on random codes
- [x] A fixed vector: \`[3, 10]\` must pack to \`0xA3\`
- [ ] The dequantization error bound
> A swapped pair of functions inverts itself, so the round trip and everything after it still pass.
> Only a fixed expected byte pins the order that other code, such as a tensor-core kernel, will read.
:::

# What production adds

The file stops at the format. The pieces around it in a real stack:

- **The GEMM.** Blackwell's fifth-generation tensor cores take packed NVFP4 operands and their E4M3
  scales directly; nothing is dequantized to memory. Each 16-wide partial dot product is multiplied
  by the two operands' block scales, and the output once by the two tensor scales.
- **Inference checkpoints.** TensorRT Model Optimizer and LLM Compressor quantize trained models
  post-training (or with quantization-aware training), and TensorRT-LLM and vLLM serve them.
  NVIDIA reports DeepSeek-R1-0528 within 1% of its FP8 accuracy on seven benchmarks in NVFP4.
- **Training.** [Transformer Engine's NVFP4 recipe](https://docs.nvidia.com/deeplearning/transformer-engine/features/low_precision_training/nvfp4/nvfp4.html)
  adds 16 × 16 2D blocks for weights, stochastic rounding for gradients, and random Hadamard
  transforms of 16-wide tiles before the weight-gradient GEMM, which spread outliers across a block.
  The paper keeps the linear layers of the first two and last eight blocks in BF16 (16% of the linear
  layers), and trains a 12B hybrid Mamba-Transformer on 10T tokens this way with loss and accuracies
  close to its FP8 baseline.
- **Distributed amax.** When a tensor is gathered across ranks, every rank must use the same
  \`s_global\`, so the amax is reduced with a max before quantizing. Block scales need no
  communication: each is local to its 16 values.

:::quiz
Q: Why can each rank compute its block scales locally but not its tensor scale, when a sequence-parallel activation is all-gathered in NVFP4?
- [ ] Block scales are stored in FP8, which is never communicated
- [x] Each block lies entirely on one rank, but s_global depends on the amax of the whole gathered tensor, and the gathered blocks must share one s_global to decode consistently
- [ ] The tensor scale is recomputed after the gather anyway
> A block of 16 never straddles ranks, so its amax is local. The E4M3 block scales are relative to
> s_global; if two ranks used different tensor scales, their blocks would be encoded on different
> rulers and one gathered tensor could not carry a single global_scale.
:::

# What to take away

- An NVFP4 value is \`e2m1 · s_block · s_global\`: 4 bits per value, one E4M3 byte per 16 values,
  one FP32 number per tensor. 4.5 bits per value, 3.56× smaller than BF16.
- E2M1 is a float grid, ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}: round within the binade's step, ties to the
  even code, saturate at ±6. The low three bits of a code index the magnitude.
- The scale's precision is the point: E4M3 puts each block amax within 6.25% of 6, where E8M0's
  powers of two waste up to a binade or clamp. The FP32 tensor scale moves all block scales into
  E4M3's narrow range.
- Divide by the stored E4M3 scale, not the exact one, and let a zero scale encode zeros.
- On Gaussian data NVFP4's squared error is 1.42× below MXFP4's; with 1% outliers, 3.60×.

The primary source is NVIDIA's [Pretraining Large Language Models with NVFP4](https://arxiv.org/abs/2509.25149),
Appendix B for the quantization procedure; the MX baseline is [Microscaling Data Formats for Deep Learning](https://arxiv.org/abs/2310.10537).
`;
