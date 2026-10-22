/**
 * The learning guide for GPTQ from scratch: uniform 4-bit group grids and their storage, the layer
 * objective and its Hessian, error feedback from Optimal Brain Surgeon to GPTQ's Cholesky form with
 * lazy batches, and sequential quantization of a whole model. Rendered at `/pt-gptq/learn`.
 */
export const learn = `# The mechanism at a glance

GPTQ ([Frantar et al., 2022](https://arxiv.org/abs/2210.17323), ICLR 2023) turns a trained model's
weights into 4-bit integers without any training. It works one linear layer at a time and asks one
question of each: which 4-bit matrix \`Ŵ\` makes the layer's **output** on real inputs closest to the
original's? Round to nearest (RTN) answers a different question, which 4-bit value is closest to each
**weight**, and the gap between the two answers is the whole method.

The answer comes from a few thousand calibration tokens and a closed-form update. Quantize the columns
of \`W\` left to right; after each column, move the columns not yet quantized so that they cancel its
rounding error on the output. How much each later column should move is read off one matrix, the
upper Cholesky factor of the inverse Hessian \`H⁻¹\`, where \`H = (2/n) Σ x xᵀ\` over the layer's inputs.

:::architecture
{
  "input": "a trained fp16 / fp32 linear layer W (d_out × d_in)",
  "output": "4-bit codes, one fp16 scale and one zero point per group",
  "items": [
    {"id": "g-x", "label": "Calibration activations", "kind": "io", "sub": "X · n tokens × d_in", "detail": "The layer's real inputs on a calibration batch, after the layers below were quantized."},
    {"id": "g-h", "label": "Hessian H", "sub": "(2/n) XᵀX + λI", "detail": "The layer's output error is the quadratic form tr(ΔW H ΔWᵀ). One d_in × d_in matrix serves every output row."},
    {"id": "g-u", "label": "Cholesky of H⁻¹", "kind": "attention", "sub": "U upper · computed once"},
    {"tone": "block", "repeat": "d_in ×", "label": "Column i, left to right", "items": [
      {"id": "g-q", "label": "Round column i", "sub": "group grid · clamp(round(w/s) + z)"},
      {"id": "g-e", "label": "Error, scaled", "kind": "loss", "sub": "(w − ŵ) / U[i, i]"},
      {"id": "g-up", "label": "Move later columns", "sub": "W[:, j>i] −= err · U[i, j]", "detail": "Columns not yet quantized absorb the error; quantized ones never change again."}
    ]},
    {"id": "g-out", "label": "QuantLinear", "kind": "io", "sub": "qweight · scales · zeros"}
  ],
  "notes": [
    {"at": "g-h", "text": "**128** sequences × **2,048** tokens in the paper"},
    {"at": "g-up", "text": "Same column order for **every** row"},
    {"at": "g-out", "text": "**4.19** bits per weight at group size 128"}
  ]
}
:::

The project builds it in four files: the 4-bit format and \`QuantLinear\`, the Hessian collector, the
solver \`gptq_quantize(W, H, bits=4, group_size=128, blocksize=128)\`, and a pass over a small
transformer LM that quantizes its layers in order. What it costs and buys, at group size 128:

| quantity | fp32 | fp16 | GPTQ int4, g = 128 |
|---|---|---|---|
| bits per weight | 32 | 16 | 4 + (16 + 8)/128 = 4.1875 |
| 7B weights | 28 GB | 14 GB | about 3.7 GB |
| decode step at batch 1 | memory bound | memory bound | about 4× fewer weight bytes than fp16 |

The paper quantizes OPT-175B in about four hours on one A100. At 3 bits the result, embeddings and
head kept in fp16, takes about 63 GB and runs on that single 80 GB GPU; in fp16 it needs five.

# A 4-bit grid per group of weights

A uniform quantizer maps a real weight to one of \`2^bits\` evenly spaced levels. The asymmetric kind
that GPTQ checkpoints use places the grid with two numbers per group:

\`\`\`text
lo    = min(min(w), 0)          hi = max(max(w), 0)
scale = (hi − lo) / (2^bits − 1)               15 for 4 bits
zero  = round(−lo / scale)                     the code that 0.0 lands on
code  = clamp(round(w / scale) + zero, 0, 15)  stored as an integer
ŵ     = scale · (code − zero)                  what the matmul sees
\`\`\`

- **Asymmetric**: the grid spans the group's own \`[min, max]\`, so a group of mostly positive weights
  does not spend half its codes on negatives. Including 0 in the range keeps a zero weight exactly 0.
- **Integer zero point**: rounding \`zero\` to an integer shifts the grid by whole steps, so every
  element is within \`scale / 2\` of a level.
- **Groups**: one \`(scale, zero)\` pair per 128 consecutive input columns of one output row. A single
  large weight only stretches the grid of its own 127 neighbours. The price is overhead per weight:

| group size | overhead (fp16 scale + 8-bit zero) | bits per weight |
|---|---|---|
| 32 | 24 / 32 | 4.75 |
| 64 | 24 / 64 | 4.375 |
| 128 | 24 / 128 | 4.1875 |
| whole row of 4,096 | 24 / 4,096 | 4.006 |

The step is set by the extremes, so the error of every other weight grows with the group's range.
Move the sliders: a larger group almost always has a wider range and therefore coarser levels, and each
bit removed doubles the step. The toggle is the subject of the rest of this guide.

:::widget int4-quant {"bits": 4, "group": 32}

Round to nearest is optimal **per weight**: no other code is closer to \`w\`. It ignores how the weights
are used. Real activations are strongly correlated across features, and on correlated inputs the
errors of neighbouring weights add up on the output instead of averaging out.

:::quiz
Q: A group of 128 weights lies in [−0.05, 0.05] except one weight of 0.8. What does that weight do to round-to-nearest at 4 bits?
- [ ] Nothing: it is rounded like any other weight and only its own error grows
- [x] The step becomes about 0.057, larger than the range of the other 127 weights, so most of them round to a level or two around 0
- [ ] The zero point overflows and the group cannot be stored
> The scale is (0.8 + 0.05) / 15 ≈ 0.057: the other weights all lie within one step of 0 and collapse
> onto two or three codes. Smaller groups confine the damage; activation-aware methods such as AWQ
> rescale the important channels before quantizing.
:::

# Packing and the quantized linear layer

Nothing in a byte-addressed tensor is 4 bits wide, so two codes share a \`uint8\`: column \`2j\` in the
low nibble, column \`2j + 1\` in the high one. AutoGPTQ checkpoints pack eight codes into each \`int32\`
of \`qweight\` and pack the zero points the same way as \`qzeros\`; the arithmetic is identical.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "p-codes", "label": "Codes of output row r", "sub": "uint8 · 0 … 15", "items": [
      {"array": "codes[r, :]", "sub": "one weight per cell · b0, b1: qweight bytes", "cols": 12, "cells": ["3", "10", "15", "0", "7", "7", "12", "4", "9", "1", "14", "6"], "continues": true, "marks": [{"cols": [0, 1], "tone": "a", "label": "b0"}, {"cols": [2, 3], "tone": "b", "label": "b1"}], "detail": "A device tensor in global memory; each marked pair of codes becomes one qweight byte."}
    ]},
    {"id": "p-buf", "label": "QuantLinear buffers", "sub": "per output row", "tone": "global", "layout": "column", "align": "start", "items": [
      {"id": "p-q", "array": "qweight[r, :]", "sub": "uint8 · low nibble = even column", "cols": 6, "cells": ["A3", "0F", "77", "4C", "19", "6E"], "continues": true, "marks": [{"cols": [0, 0], "tone": "a"}, {"cols": [1, 1], "tone": "b"}], "detail": "Byte 0 is 3 | 10 << 4 = 0xA3, byte 1 is 15 | 0 << 4 = 0x0F."},
      {"id": "p-s", "array": "scales[r, :]", "sub": "fp16 · one per 128 columns", "cols": 4, "cells": ["s₀", "s₁", "s₂", "s₃"]},
      {"id": "p-z", "array": "zeros[r, :]", "sub": "uint8 · one per 128 columns", "cols": 4, "cells": ["z₀", "z₁", "z₂", "z₃"]}
    ]},
    {"id": "p-mm", "label": "Matmul", "sub": "x @ ((q − z) · s)ᵀ + b", "tone": "compute", "detail": "Here the whole weight is dequantized, then F.linear. A fused kernel does it per tile in registers."}
  ],
  "arrows": [
    {"from": "p-codes", "to": "p-q", "label": "pack_int4"},
    {"from": "p-buf", "to": "p-mm", "label": "unpack, dequantize"}
  ]
}
:::

The project's \`QuantLinear\` keeps \`qweight\`, \`scales\`, \`zeros\` and \`bias\` as buffers, and its
\`forward\` dequantizes the whole matrix and calls \`F.linear\`. That saves memory and nothing else:
for one call it materialises the float weight. The speed comes from kernels that never do that.

| implementation | weight bytes read per decode step (7B) | where dequantization happens |
|---|---|---|
| fp16 \`nn.Linear\` | about 14 GB | nowhere |
| dequantize, then matmul (this project) | 3.7 GB read, 14 GB written and read again | a separate pass in memory |
| fused W4A16 kernel (ExLlama, Marlin) | about 3.7 GB | in registers, per tile, before the tensor-core MMA |

At batch size 1 a decoder step multiplies each weight once per token, so its time is the time to
stream the weights; reading a quarter of the bytes is close to a 4× speedup for those matmuls. At large
batch sizes the matmuls become compute bound and the dequantization is overhead, which is why the
[Hugging Face integration post](https://huggingface.co/blog/gptq-integration) reports latency on par
with fp16 at small batches and warns about slowdowns at larger ones.

:::quiz
Q: Why does \`QuantLinear\` store its codes, scales and zeros as buffers rather than parameters?
- [ ] Buffers are stored in fp16 automatically
- [x] They are state that must move with the module and be saved in the \`state_dict\`, but no optimizer should ever update them
- [ ] \`nn.Parameter\` cannot hold integer tensors, and that is the only reason
> Integer codes have no gradient, and a quantized layer is not trained further (adapters such as LoRA
> are trained beside it). Buffers follow \`.to(device)\` and serialisation like parameters do, and stay
> invisible to \`model.parameters()\`.
:::

# The layer objective and its Hessian

GPTQ inherits its objective from [Optimal Brain Compression](https://arxiv.org/abs/2208.11580): for one
layer with inputs \`X\` (\`n\` tokens), find the quantized \`Ŵ\` that minimises the squared output error.

\`\`\`text
E(Ŵ) = ‖W Xᵀ − Ŵ Xᵀ‖²  =  Σ_rows ΔW[r] (XᵀX) ΔW[r]ᵀ  =  (n/2) · tr(ΔW H ΔWᵀ)
H    = (2/n) Σ_t x_t x_tᵀ      d_in × d_in, the same for every output row
\`\`\`

Three properties make this tractable:

- **Exactly quadratic.** A linear layer's output error is a quadratic form in the weight error, so the
  Hessian is not an approximation: it is the whole loss surface of the layer.
- **Rows decouple.** Each output row contributes its own quadratic form with the **same** \`H\`. Every
  row can be solved independently, and in GPTQ all rows are solved at once with one matrix.
- **Cheap to collect.** A forward pre-hook sees each layer's input during an ordinary forward pass;
  a running average \`H ← H · m/(m + n) + (2/(m + n)) Σ x xᵀ\` in float32 never grows with the
  calibration size. The paper uses 128 random segments of 2,048 tokens from C4.

\`H\` must be inverted, and two things break that. An input feature that is always 0 (a dead ReLU unit,
padding) gives a zero row and column; and thousands of tokens of a 4,096-wide layer are close to rank
deficient. The fixes, and what happens without them:

| situation | without the fix | with it |
|---|---|---|
| input \`j\` always 0, \`H[j, j] = 0\` | \`H\` singular: Cholesky fails, the run stops | \`H[j, j] = 1\`, \`W[:, j] = 0\`: the weight cannot affect the output anyway |
| nearly rank-deficient \`H\` | Cholesky of \`H⁻¹\` fails in float32 or returns huge updates | \`λ = 0.01 · mean(diag H)\` on the diagonal bounds the condition number |
| \`H\` summed in bf16 over 100k tokens | most digits lost to rounding of a growing sum | float32 running average at the scale of one token |

:::quiz
Q: Why is one Hessian enough for all 4,096 output rows of a layer?
- [ ] GPTQ approximates every row's Hessian by their average
- [x] Each row's output error is ΔW[r] (XᵀX) ΔW[r]ᵀ: the matrix depends only on the inputs, which all rows share
- [ ] Only the first row is quantized with error feedback; the rest use round to nearest
> The rows of a linear layer read the same input vector, so the second derivative of the squared
> output error with respect to any row is the same 2XᵀX/n. That shared matrix is what lets GPTQ use
> one Cholesky factorisation per layer.
:::

# Error feedback: from Optimal Brain Surgeon to GPTQ

Optimal Brain Surgeon (Hassibi and Stork, 1993) answered a pruning question: if one weight must change
by a fixed amount, how should the others move to keep a quadratic loss as small as possible? For weight
\`q\` set to its quantized value, with \`F\` the weights not yet fixed and \`H_F⁻¹\` the inverse Hessian
restricted to them:

\`\`\`text
δ_F   = − (w_q − quant(w_q)) / [H_F⁻¹]_qq · (H_F⁻¹)[:, q]      the optimal move of the others
H_F⁻¹ ← H_F⁻¹ − (H_F⁻¹)[:, q] (H_F⁻¹)[q, :] / [H_F⁻¹]_qq      remove q from the inverse
\`\`\`

The smallest possible example shows why this beats rounding. Two inputs that are always equal
(\`x₂ = x₁\`): only \`w₁ + w₂\` matters to the output. Grid levels 0 and 1, both weights 0.3:

| method | w₁ | w₂ | w₁ + w₂ | output error per unit x² | weight error ‖ΔW‖² |
|---|---|---|---|---|---|
| original | 0.3 | 0.3 | 0.6 | 0 | 0 |
| round to nearest | 0 | 0 | 0 | 0.36 | 0.18 |
| error feedback | 0 | 0.3 + 0.3 → 1 | 1 | 0.16 | 0.58 |

Error feedback rounds \`w₁\` down, pushes its error of 0.3 onto \`w₂\`, which then rounds up. Its weights
are further from the originals (0.58 against 0.18) and its output is closer (0.16 against 0.36). The
project's self-test shows the same trade on a \`64 × 256\` layer with correlated inputs: GPTQ's weight error
was 0.174 against RTN's 0.093, its output error 2,687 against 13,361, about 5× lower. Toggle the widget
above to error feedback to watch each weight move before it is rounded.

OBQ, the quantization version, applied this greedily: always quantize the weight whose error costs the
least, update the rest, repeat. That is accurate and \`O(d_row · d_col³)\`: an hour for a 25M-parameter
ResNet-50, out of reach for a 175B model. GPTQ keeps the update and changes three things around it.

:::quiz
Q: In the two-weight example, why is error feedback's weight error larger but its output error smaller?
- [ ] Error feedback uses a coarser grid than round to nearest
- [x] It deliberately moves w₂ away from its own value so that the sum w₁ + w₂, the only thing the output sees, lands closer
- [ ] Round to nearest clamps w₂ to the grid's edge
> The objective is the layer's output, not the weights. On correlated inputs a later weight can cancel an
> earlier weight's error, so the best output can need weights that are individually worse.
:::

# Cholesky rows and lazy batches

GPTQ's three changes, all in \`gptq_quantize\`:

1. **One order for every row.** OBQ chooses a different greedy order per row, so every row needs its
   own shrinking \`H_F⁻¹\`. GPTQ quantizes every row left to right. The set of quantized columns is then
   the same for all rows, \`H_F⁻¹\` is the same, and the paper finds the order matters little on large
   models.
2. **Cholesky instead of downdates.** With a fixed order, the only rows of \`H_F⁻¹\` ever used are row
   \`i\` of the matrix left after removing columns \`0..i−1\`. Those rows, divided by the square root of
   their diagonal, are exactly the rows of the upper Cholesky factor \`U\` of \`H⁻¹\`. One factorisation
   replaces \`d_col\` downdates whose rounding errors made \`H_F⁻¹\` indefinite on large models.
3. **Lazy batch updates.** Column \`i\`'s error only needs to reach column \`j\` before \`j\` is quantized.
   Inside a block of 128 columns updates are applied at once; to everything after the block they wait,
   and arrive as one matmul.

\`\`\`text
U = cholesky(cholesky_inverse(cholesky(H)), upper=True)
for i1 in range(0, d_col, 128):
    for i in block:
        (new group? grid from W1[:, i:i+g])
        ŵ      = quant(W1[:, i])
        err    = (W1[:, i] − ŵ) / U[i, i]
        W1[:, i:] −= err ⊗ U[i, i:]           inside the block, now
    W[:, i2:]  −= Err1 @ U[i1:i2, i2:]        everything after it, once
\`\`\`

| | OBQ | GPTQ without lazy batches | GPTQ |
|---|---|---|---|
| order | greedy per row | left to right, shared | left to right, shared |
| inverse Hessian work | \`d_row\` inverses, \`d_col\` downdates each | one Cholesky | one Cholesky |
| cost, \`d_row = d_col = 4,096\` | about \`d⁴\` = 2.8 × 10¹⁴ | about \`d³\` = 6.9 × 10¹⁰ | the same FLOPs, as matmuls |
| update of later columns | rank 1 per weight | rank 1 per column, memory bound | rank 128 per block, compute bound |

The lazy batch only regroups additions, so it gives the same codes as updating everything after every
column; the self-test checks that block sizes 32 and 128 agree, and that the fast solver agrees with a
slow float64 version that applies the OBS update and the explicit downdate one column at a time.

There is one subtlety with groups. A group's grid is chosen at its first column, from the weights as
they are **then**, after the earlier columns have pushed their errors onto them. A grid fixed from the
original weights would miss values the updates pushed outside it. The reference's \`--act-order\`
option quantizes columns by decreasing \`diag(H)\` instead, the most sensitive inputs first while the
most columns remain to absorb their error, and \`--static-groups\` then fixes all grids up front so that
the groups stay contiguous in memory.

:::quiz
Q: The lazy batch update delays the effect of a block's errors on later columns. Why does that not change the result?
- [ ] Because later columns are re-quantized at the end
- [x] Column j's value only matters when j is quantized; the updates are additions, so applying them all just before that gives the same number
- [ ] Because U is upper triangular, the delayed updates are zero
> Each later column receives Σ_k err_k · U[k, j] over the block's columns k. Whether those terms are
> added one at a time or as one matmul, column j holds the same value when its turn comes.
:::

# Quantizing a whole model, in order

A layer quantized on the float model's activations is optimised for inputs it will never see: in the
quantized model, the layers below it are wrong too. GPTQ therefore quantizes the model in the order
the data flows and calibrates each layer on the quantized model's own activations.

:::architecture
{
  "input": "calibration ids",
  "output": "quantized model",
  "items": [
    {"id": "s-emb", "label": "Embeddings", "kind": "embed", "sub": "inps = embed(calib) · once"},
    {"tone": "block", "repeat": "n_layer ×", "label": "Decoder layer", "items": [
      {"tone": "dotted", "repeat": "per group ×", "label": "q·k·v → o → gate·up → down", "items": [
        {"id": "s-h", "label": "Hooks fill H", "sub": "one forward of this layer"},
        {"id": "s-q", "label": "gptq_quantize", "kind": "attention", "sub": "per linear in the group"},
        {"id": "s-sw", "label": "Swap in QuantLinear", "sub": "later groups see it"}
      ]},
      {"id": "s-run", "label": "Run the quantized layer", "sub": "inps = layer(inps)", "detail": "The next layer's Hessians include this layer's quantization error."}
    ]},
    {"id": "s-eval", "label": "Held-out perplexity", "kind": "loss", "sub": "fp vs GPTQ vs RTN"}
  ],
  "notes": [
    {"at": "s-emb", "text": "The full model never runs again"},
    {"at": "s-run", "text": "Only **one** layer on the GPU at a time"}
  ]
}
:::

Two quantities matter: memory and quality. On the project's small LM (width 128, two blocks, 4,096
calibration tokens), one run printed:

| model | block linear weights | held-out perplexity | perplexity lost |
|---|---|---|---|
| fp32 | 1,536 KiB | 8.142 | |
| round to nearest, 4 bits, g = 128 | 201 KiB | 8.445 | 0.304 |
| GPTQ, 4 bits, g = 128 | 201 KiB | 8.285 | 0.143 |

GPTQ keeps about half of what rounding loses on this tiny model. On large models the gap is far wider.
On WikiText-2 the paper reports for OPT-175B:

| OPT-175B | bits | WikiText-2 perplexity |
|---|---|---|
| fp16 | 16 | 8.34 |
| round to nearest | 4 | 10.54 |
| GPTQ | 4 | 8.37 |
| round to nearest | 3 | 7.3 × 10³ (collapsed) |
| GPTQ | 3 | 8.68 |

The order matters less on a two-block model: calibrating every layer on the float model's activations
instead lands within 0.02 perplexity of the sequential pass here. The paper finds that the sequential
pass brings noticeable improvements at negligible extra cost on its large models, where many more
layers of error accumulate below the last ones.

What production adds around the same loop: [AutoGPTQ](https://github.com/AutoGPTQ/AutoGPTQ) and its
successor GPTQModel wrap it for every \`transformers\` architecture, with act-order, symmetric or
asymmetric grids, packed \`qzeros\` and fused kernels; \`transformers\` loads the checkpoints with a
\`GPTQConfig\`. Other methods attack the same problem differently. [AWQ](https://arxiv.org/abs/2306.00978)
uses no error feedback: it scales each input channel's weights by a factor that grows with the
channel's average activation (and divides the activation by it) before round to nearest, which
protects the few salient channels. [LLM.int8()](https://arxiv.org/abs/2208.07339) keeps outlier activation features in
fp16 and quantizes the rest to 8 bits.

:::quiz
Q: Why does the quantization loop run each layer again after quantizing it?
- [ ] To check that the codes were written correctly
- [x] Its output, computed with the quantized weights, is the input the next layer will really see, so the next layer's Hessian and error feedback account for it
- [ ] Because the hooks only fire on the second forward
> Sequential calibration lets each layer compensate for the error of the layers below. It costs one
> extra forward of one layer per layer, and it is why only one layer needs to be on the GPU at a time.
:::

# What to take away

- **Objective**: GPTQ minimises the layer's output error \`‖WX − ŴX‖²\`, not the weights' error; on
  correlated inputs the two disagree, and the output is what the model uses.
- **Hessian**: that error is \`tr(ΔW H ΔWᵀ)\` with \`H = (2/n) XᵀX\`, one matrix per layer shared by all
  rows, collected by a hook and made invertible by dead-column handling and 1% damping.
- **Error feedback**: quantize columns left to right and move the columns not yet quantized by the OBS
  update, read off the rows of the upper Cholesky factor of \`H⁻¹\`.
- **Speed**: one order for all rows, one Cholesky factorisation and lazy batch updates of 128 columns
  turn OBQ's hour for a 25M-parameter ResNet-50 into about four GPU hours for a 175B model.
- **Format**: 4-bit codes, an fp16 scale and a zero point per group of 128, 4.19 bits per weight; the
  speed comes from kernels that dequantize in registers.
- **Order**: quantize the model layer by layer on the quantized model's own activations.

Primary source: Frantar, Ashkboos, Hoefler and Alistarh,
[GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers](https://arxiv.org/abs/2210.17323),
with the reference code at [IST-DASLab/gptq](https://github.com/IST-DASLab/gptq).
`;
