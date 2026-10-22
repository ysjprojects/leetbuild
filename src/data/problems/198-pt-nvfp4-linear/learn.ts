/**
 * The learning guide for NVFP4 inference: E2M1 values under two levels of scale, why E4M3 scales and blocks
 * of 16 beat MXFP4, the block-scaled GEMM and why its block sums are exact, calibrated activation scales,
 * post-training quantization of a model against MXFP4 and INT4, and the memory it saves. Rendered at
 * `/pt-nvfp4-linear/learn`.
 */
export const learn = `# The mechanism at a glance

NVFP4 is the 4-bit floating-point format of NVIDIA's Blackwell GPUs. A tensor in NVFP4 is three arrays:
4-bit E2M1 values, one FP8 E4M3 scale for every 16 consecutive values along the reduction dimension K, and
one FP32 scale for the whole tensor. The [NVIDIA blog post that introduced it](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/)
compares it with MXFP4, the open standard it builds on, which has blocks of 32 and a power-of-two scale.

For inference, both operands of every linear layer can be NVFP4: the weights, quantized once, and the
activations, quantized as they arrive (W4A4). The tensor core never turns either back into floats. It
multiplies the 4-bit values block by block, applies the two block scales to each partial sum, accumulates
in FP32 and applies the two tensor scales once at the end.

:::architecture
{
  "input": "x · tokens × in, fp32",
  "output": "y · tokens × out",
  "items": [
    {"id": "m-x", "label": "Activations x", "kind": "io", "sub": "(tokens, in) · fp32"},
    {"id": "m-qx", "label": "Quantize x along K", "kind": "attention", "sub": "E4M3 per 16 · FP32 per tensor", "detail": "On every forward, with a global scale fixed at calibration.", "side": {"id": "m-cal", "label": "Calibrated amax", "sub": "s_x = amax / (6 · 448)"}},
    {"tone": "block", "repeat": "K/16 ×", "label": "K block", "items": [
      {"id": "m-dot", "label": "FP4 dot product", "kind": "attention", "sub": "Σ₁₆ q_x · q_w · exact", "side": {"id": "m-w", "label": "W in NVFP4", "sub": "quantized once"}},
      {"id": "m-sc", "label": "Block scales", "sub": "acc += P · s_x[b] · s_w[b]"}
    ]},
    {"id": "m-g", "label": "Global scales", "sub": "acc · s_x,global · s_w,global"},
    {"id": "m-b", "label": "Bias, fp32", "sub": "y = acc + b"},
    {"id": "m-y", "label": "Output y", "kind": "io", "sub": "(tokens, out)"}
  ],
  "notes": [
    {"at": "m-dot", "text": "Block sums are **exact** in fp32"},
    {"at": "m-g", "text": "**2** FP32 scalars per GEMM"}
  ]
}
:::

The project builds this layer, \`NVFP4Linear\`, on a block-scaled GEMM \`nvfp4_matmul\`. It then quantizes a
small language model after training and measures NVFP4 against MXFP4 and INT4 at the same budget:

| format | element | block | scale | bits per value |
|---|---|---|---|---|
| NVFP4 | E2M1 | 16 | E4M3, plus FP32 per tensor | 4 + 8/16 = 4.5 |
| MXFP4 | E2M1 | 32 | E8M0 (power of two) | 4 + 8/32 = 4.25 |
| INT4, g = 32 | integer −8..7 | 32 | fp16 | 4 + 16/32 = 4.5 |
| bf16 | | | | 16 |

The blog reports about 3.5× less memory than FP16 for whole models and 1% or less accuracy loss against
FP8 on DeepSeek-R1-0528.

# Four bits and two levels of scale

E2M1 has a sign bit, two exponent bits (bias 1) and one mantissa bit. Its eight magnitudes are not evenly
spaced:

\`\`\`text
code   0000 0001 0010 0011 0100 0101 0110 0111     sign is bit 3: 1xxx is negative
value  0    0.5  1    1.5  2    3    4    6
\`\`\`

Half the levels sit in the lowest quarter of the range, and the spacing doubles with each binade. Rounding
is to the nearest value with ties to the even mantissa (2.5 → 2, 3.5 → 4, 5 → 4), and anything beyond 6
saturates to 6. Two codes share a byte, the even element in the low nibble.

Eight magnitudes cannot cover the range of real tensors, so every block of 16 gets a scale. NVFP4 stores
that scale in E4M3, an FP8 format with 3 mantissa bits whose largest value is 448. E4M3 alone spans about
18 binades (2⁻⁹ to 448), less than a tensor whose block maxima vary widely may need, so a second, per-tensor
FP32 scale moves the whole tensor into it:

\`\`\`text
s_global = amax(|x|) / (6 · 448)                    FP32, one per tensor (1 when amax is 0)
s_block  = e4m3( amax_block / 6 / s_global )        ≤ 448, one per 16 values
q        = e2m1( x / (s_block · s_global) )         4 bits, saturating at ±6
x̂        = q · s_block · s_global
\`\`\`

The global scale is chosen so that the block holding the tensor's largest value gets \`s_block = 448\`
exactly, the top of E4M3's range. Every other block gets a smaller scale, rounded to E4M3's 3-bit mantissa,
so its largest value lands within about 6% of 6. A block of zeros, or one so small that its scale rounds to
zero, encodes zeros. The [NVFP4 pretraining paper](https://arxiv.org/abs/2509.25149) defines the same scale
as an encode factor \`6 · 448 / amax\` and stores its inverse in FP32 "for decoding the resulting values
after the NVFP4 GEMM operation".

One block, from a tensor whose largest value is 10:

| quantity | value |
|---|---|
| block values | 0.12, −0.40, 0.95, 2.90, −1.30, … (16 values, amax 2.90) |
| \`s_global\` | 10 / 2,688 = 0.003720 |
| \`amax_block / 6 / s_global\` | 129.92 → E4M3 **128** |
| decode scale \`s_block · s_global\` | 0.4762 |
| codes | 0.5, −1, 2, 6, −3, … (2.90 / 0.4762 = 6.09 saturates to 6) |
| mean squared error | 0.0090 |

The FP8 layouts, and how a value rounds in each, are in the widget below. E4M3 is the row the block
scales are stored in.

:::widget float-formats

:::quiz
Q: Why does NVFP4 need the per-tensor FP32 scale at all, when every block already has a scale?
- [ ] To store the sign of the block
- [x] E4M3 covers only 2⁻⁹ to 448, so block scales of a tensor with very large or very small values would overflow or flush to zero without a tensor-wide shift
- [ ] The tensor core cannot read E4M3 scales without it
> The global scale divides every block scale by the same FP32 number, chosen so the largest block scale is
> exactly 448. That spends E4M3's range where this tensor's blocks actually are. MXFP4 does not need one
> because E8M0 spans 2⁻¹²⁷ to 2¹²⁷.
:::

# Why the scale is E4M3 and the block is 16

MXFP4, the [OCP Microscaling](https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf/)
format, makes two different choices. Its blocks have 32 values, and its scale is E8M0: an 8-bit exponent with
no mantissa, so it is always a power of two. The specification sets it to the largest power of two not
above the block's amax, divided by the largest power of two in E2M1 (4):

\`\`\`text
X = 2^(floor(log2(amax)) − 2)        E8M0, one per 32 values
q = e2m1(x / X)                      values past 6 saturate
\`\`\`

Then \`amax / X\` lands anywhere in \`[4, 8)\`. Below 6, the top of the grid is wasted; above 6, the block's
largest values are clipped. NVFP4's fractional scale puts every block's amax within a few percent of 6.

The smaller block matters at least as much. A block mixes whatever 16 or 32 values happen to be adjacent
along K, and one large value sets the scale for all of them. Below, the 16 values of the example above and
16 values a tenth their size are quantized as one MXFP4 block and as two NVFP4 blocks:

| | NVFP4 (two blocks of 16) | MXFP4 (one block of 32) |
|---|---|---|
| scale of the large half | 128 · s_global = 0.476 | 0.5 |
| scale of the small half | 13 · s_global = 0.048 | 0.5, shared |
| MSE, large half | 0.0090 | 0.0124 |
| MSE, small half | 0.000095 | 0.0041, 43× worse |

The failure is in the last row: under MXFP4 the small half shares a scale with values ten times larger, and
12 of its 16 values round to 0, the other 4 to ±0.25. Toggle the outlier in the widget to see one value stretch a whole
MXFP4 block while NVFP4 confines it to its own 16.

:::widget nvfp4-block {"outlier": true}

The blog's argument is the same: an E8M0 scale "snaps the scale factor to nearest 2ⁿ", while an E4M3 scale
fits the block. The price is the second-level FP32 scale and a quarter bit more per value for the extra blocks.

:::quiz
Q: An MXFP4 block's largest magnitude is 7.9. What happens to it?
- [ ] It is stored exactly: E8M0 picks X = 2 and 7.9 / 2 = 3.95 rounds to 4
- [x] X = 2^(2 − 2) = 1, so 7.9 saturates to 6: a 24% error on the most important value of the block
- [ ] The block is flagged as NaN
> floor(log2 7.9) = 2, so X = 1. Values between 6 and 8 times X all clip to 6. NVFP4 would pick a block
> scale of about 7.9 / 6 in units of the global scale, rounded to E4M3, and 7.9 would come back within a few
> percent.
:::

# The block-scaled GEMM

To multiply \`A (M × K)\` by \`Bᵀ (K × N)\` with both in NVFP4, nothing needs to be dequantized. Within one
K block, the scales are constants that factor out of the dot product, so the core works on raw E2M1
values and touches the scales once per block. The [CUTLASS documentation](https://docs.nvidia.com/cutlass/latest/media/docs/cpp/blackwell_functionality.html)
writes Blackwell's block-scaled MMA as \`D = C + Σ_k (A[i,k] · SFA[i, k/SV]) · (B[j,k] · SFB[j, k/SV])\`,
with a scale-factor vector size \`SV\` of 16 for NVFP4 and 32 for MXFP4.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "s-hbm", "label": "Operands in HBM", "tone": "global", "layout": "row", "align": "start", "items": [
      {"label": "A · activations", "layout": "column", "align": "start", "items": [
        {"id": "s-a", "array": "A codes · M × K", "sub": "E2M1 · two K blocks shown", "cols": 32, "rows": 3, "continues": true, "marks": [{"cols": [0, 15], "tone": "a", "label": "block 0"}, {"cols": [16, 31], "tone": "b", "label": "block 1"}]},
        {"id": "s-sfa", "array": "SFA · M × K/16", "sub": "E4M3", "cols": 2, "rows": 3, "continues": true, "marks": [{"cols": [0, 0], "tone": "a"}, {"cols": [1, 1], "tone": "b"}]}
      ]},
      {"label": "B · weights", "layout": "column", "align": "start", "items": [
        {"id": "s-b", "array": "B codes · N × K", "sub": "E2M1 · same K blocks", "cols": 32, "rows": 3, "continues": true, "marks": [{"cols": [0, 15], "tone": "a", "label": "block 0"}, {"cols": [16, 31], "tone": "b", "label": "block 1"}]},
        {"id": "s-sfb", "array": "SFB · N × K/16", "sub": "E4M3", "cols": 2, "rows": 3, "continues": true, "marks": [{"cols": [0, 0], "tone": "a"}, {"cols": [1, 1], "tone": "b"}]}
      ]}
    ]},
    {"id": "s-mma", "label": "Block-scaled MMA", "sub": "D += s_a[m, b] · s_b[n, b] · Σ₁₆ a · b", "tone": "compute", "items": [
      {"id": "s-d", "array": "D · M × N", "sub": "fp32 accumulator, on chip", "tone": "register", "cols": 4, "rows": 3, "detail": "One scaled partial sum per K block is added to each entry; the global scales multiply D once at the end."}
    ]}
  ],
  "arrows": [{"from": "s-hbm", "to": "s-mma", "label": "block b of A meets block b of B"}]
}
:::

\`nvfp4_matmul\` computes the same thing in three tensor operations:

\`\`\`python
P = torch.einsum("mbk,nbk->mnb", qa, qb)              # (M, N, K/16) FP4 dot products
acc = (P * sa[:, None, :] * sb[None, :, :]).sum(-1)   # block scales, fp32 accumulation
out = acc * (a.s_global * b.s_global)                 # two scalars, once
\`\`\`

Every number before the sum over blocks is exact, which is why the result agrees with a float64 loop to
about 1e-7:

| quantity | range | exact in fp32? |
|---|---|---|
| product of two E2M1 values | multiples of 1/4, at most 36 | yes |
| sum of 16 products | multiples of 1/4, at most 576 | yes, 12 bits |
| \`s_a · s_b\`, both E4M3 | 4-bit significands | yes, 8 bits |
| \`P · s_a · s_b\` | 12 + 8 significant bits | yes, 20 of fp32's 24 |
| sum over K/16 blocks | | rounded, like any fp32 GEMM |

Dequantizing first and calling a float matmul gives the same numbers to fp32 rounding (the self-test checks
both), but it writes a full-precision copy of each operand and multiplies at float speed. That is the
shortcut the step forbids: correct, and the opposite of the point.

:::quiz
Q: Where do the per-tensor global scales enter the block-scaled GEMM?
- [ ] Inside every block, multiplied with each E2M1 product
- [ ] Into the E4M3 block scales before the GEMM, so the kernel never sees them
- [x] Once, on the fp32 result: they are the same for every block, so they factor out of the whole sum
> \`Σ_b P · (s_a · g_a) · (s_b · g_b) = g_a · g_b · Σ_b P · s_a · s_b\`. Folding them into the block scales
> would push those out of E4M3's range, which is why the second level exists.
:::

# Activations: calibrated or dynamic

Weights are known in advance and quantized once. Activations arrive with every request, and their global
scale needs \`amax(|x|)\` over the whole input. Computing it on the fly (a dynamic scale) means a reduction
over the tensor before the first block can be quantized. A calibrated (static) scale removes it: run the
float model on a few hundred representative inputs, record each layer's largest input, and freeze
\`s_x = amax / (6 · 448)\`. NVIDIA Model Optimizer's NVFP4 recipe works this way: \`max\` calibration
records each input quantizer's amax, and the exported activation scale is that amax over \`6 · 448\`.

Only the global scale is frozen. The block scales are still computed from each block of each input, so a
calibrated layer adapts to small inputs as well as a dynamic one. It only breaks when an input exceeds the
range calibration saw:

| input to \`NVFP4Linear(256, 96)\` | relative output error |
|---|---|
| in range, dynamic scale | 0.139 |
| in range, calibrated scale | 0.139 |
| 8× past the calibrated amax | 0.600 |

Past the calibrated amax, the block scales ask for more than 448 and are clamped there, and the values
saturate at 6. On the language model, the calibrated and dynamic versions differ by 0.03 in perplexity
(8.957 against 8.987), on 32 calibration sequences.

:::quiz
Q: A layer was calibrated on inputs with amax 12. At serving time one input has amax 4. What does its quantization lose compared with a dynamic scale?
- [x] Almost nothing: block scales are still computed per block, only their common divisor is fixed, and 4 is inside the calibrated range
- [ ] Two thirds of the precision, since the grid is three times too coarse
- [ ] The input is clipped to 4 / 12 of its values
> A smaller input only means smaller block scales. E4M3's normal range is 2⁻⁶ to 448, so any block whose
> amax is above about 1/28,000 of the calibrated amax keeps a full-precision scale. Clipping happens only
> above the calibrated amax.
:::

# Quantizing a trained model

Post-training quantization (PTQ) needs no gradient and no labels: a trained model, a calibration batch, and
a rule for which layers to convert. The self-test of step 2 trains a two-block TinyLM for 400 steps, hooks
the 8 block linears to record their input amax over 32 sequences, and swaps them for 4-bit layers. Each
format gets the same treatment: weights and inputs both in 4 bits, the embeddings, LayerNorms and head
left in fp32.

:::architecture
{
  "input": "token ids",
  "output": "logits, fp32",
  "items": [
    {"id": "p-emb", "label": "wte + wpe, fp32", "kind": "embed", "sub": "lookup · not a GEMM"},
    {"tone": "block", "repeat": "2 ×", "label": "Transformer block", "items": [
      {"id": "p-attn", "label": "qkv, proj · 4-bit", "kind": "attention", "sub": "W4A4 · amax from calibration"},
      {"id": "p-mlp", "label": "fc1, fc2 · 4-bit", "kind": "attention", "sub": "W4A4 · GELU between in fp32"}
    ]},
    {"id": "p-head", "label": "LM head, fp32", "kind": "head", "sub": "128 → 64 · kept", "detail": "Quantizing it too raised perplexity from 8.957 to 9.044."}
  ],
  "notes": [
    {"at": "p-attn", "text": "**8** linears swapped, **8** amax values"},
    {"at": "p-head", "text": "ModelOpt excludes **lm_head** by default"}
  ]
}
:::

Why the ends stay in high precision:
- **The embedding is a lookup.** A gather reads one row per token; there is no GEMM for a 4-bit format to
  speed up, and its error would enter the residual stream before any layer can correct it.
- **The head writes the logits.** Nothing normalizes its output, so its error moves the softmax directly.
  On this model, quantizing it as well cost 0.087 perplexity on top of the rest. [ModelOpt](https://github.com/NVIDIA/Model-Optimizer)'s
  default configurations disable \`*lm_head*\`, along with MoE routers.

The measured comparison, one run (orderings held on all eight seeds tried):

| format | bits/weight | block weights | layer output error | perplexity |
|---|---|---|---|---|
| fp32 | 32 | 1,536 KiB | | 8.405 |
| NVFP4 | 4.5 | 216 KiB | 0.107 | 8.957 |
| INT4, g = 32 | 4.5 | 216 KiB | 0.113 | 9.219 |
| MXFP4 | 4.25 | 204 KiB | 0.138 | 9.565 |

At equal bits NVFP4 beats INT4. INT4's fp16 scale is just as fine, but its 16 evenly spaced levels fit
bell-shaped data worse than E2M1's, which crowd near zero. MXFP4 is a quarter bit cheaper and clearly
worse: 32-value blocks and power-of-two scales. The gaps depend on the model. Large LLMs have outlier
channels this one lacks, which is why production recipes add rotations or smoothing before 4-bit
activations.

:::quiz
Q: Why is the layer output error measured with each quantized layer fed the float model's own inputs?
- [x] It isolates each format's error per layer; perplexity then shows how those errors compound through the model
- [ ] Because quantized layers cannot run on quantized inputs
- [ ] To make the calibration amax exact
> Fed the float inputs, a layer's error is its own. In the full quantized model, each layer also sees the
> errors of the layers below it, which is what perplexity measures end to end.
:::

# Memory, and what a real kernel adds

Bytes are counted from the stored tensors, not from a formula:

| format | codes | scales | per-tensor | 393,216 block weights |
|---|---|---|---|---|
| fp32 | 4 B | | | 1,536 KiB |
| bf16 | 2 B | | | 768 KiB |
| NVFP4 | 0.5 B | 1 B per 16 | 4 B per layer | 216 KiB (3.56× under bf16) |
| MXFP4 | 0.5 B | 1 B per 32 | | 204 KiB |
| INT4, g = 32 | 0.5 B | 2 B per 32 | | 216 KiB |

At batch size 1, a decoder streams every weight once per token, so its speed tracks those bytes. At large
batch sizes the GEMMs become compute bound, and there NVFP4's value is the tensor core's 4-bit throughput,
which needs the activations in 4 bits as well. A weight-only format cannot use it.

This project computes the right numbers on a CPU. Production kernels add:
- scale factors in the swizzled tile layout the MMA instruction reads, not row-major;
- activation quantization fused into the epilogue of the kernel that produced them;
- the accumulator in on-chip tensor memory, and bf16 outputs;
- NVFP4 KV caches, and a per-layer format search (ModelOpt's \`auto_quantize\`) that leaves sensitive layers
  in a wider format.

:::quiz
Q: A model is decoding at batch size 1. Which matters most for its speed, NVFP4's 4-bit weights or its 4-bit activations?
- [x] The weights: decoding is memory bound, and the weight bytes shrink 3.56× against bf16
- [ ] The activations: they are the larger tensor at batch size 1
- [ ] Neither: the scales dominate the traffic
> At batch 1 the activations are one row per layer; the weights are the traffic. 4-bit activations matter
> when the batch is large enough for the GEMM to be compute bound.
:::

# What to take away

- NVFP4 is E2M1 values with two levels of scale: an E4M3 scale per 16 values along K and an FP32 scale per
  tensor that keeps the block scales inside E4M3's range. That is 4.5 bits per value.
- A block-scaled GEMM never dequantizes. The FP4 products of a block are exact, the block scales multiply
  each partial sum, and the two global scales multiply the result once.
- Fractional E4M3 scales and blocks of 16 are what beat MXFP4. Every block's amax lands near 6, and one
  large value disturbs 15 neighbours, not 31.
- A calibrated activation scale costs nothing in range and removes a reduction from every forward. It
  clips inputs beyond what calibration saw.
- Keep the embeddings and the head in high precision, and measure: here NVFP4 < INT4 < MXFP4 in error and
  perplexity at about 4.5 bits.

Primary reference: [Pretraining Large Language Models with NVFP4](https://arxiv.org/abs/2509.25149) (NVIDIA,
2025), Appendix B for the two-level scaling. The MX baseline is [Microscaling Data Formats for Deep Learning](https://arxiv.org/abs/2310.10537).
`;
