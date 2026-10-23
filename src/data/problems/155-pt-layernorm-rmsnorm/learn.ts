/**
 * The learning guide for the LayerNorm / RMSNorm drill: why a transformer normalises its residual
 * stream before every sublayer, the LayerNorm statistics and their small print (biased variance, eps
 * under the root, rsqrt), what RMSNorm drops and why, the float32 upcast that keeps a half-precision
 * row from overflowing, and what fused kernels add: a figure or a table where one says it faster
 * than prose, a pop quiz per section. Rendered at \`/pt-layernorm-rmsnorm/learn\`.
 */
export const learn = `# The mechanism at a glance

A transformer keeps a **residual stream**: one vector of \`D\` features per token, shape \`(B, T, D)\`,
that every block reads from and adds into. Before each sublayer (attention, then the MLP) the row is
**normalised** so the sublayer sees inputs of a fixed magnitude whatever the stream has accumulated.
Two normalisations cover every modern LLM: **LayerNorm** (GPT-2, BERT, ViT) centres the row and divides
by its standard deviation; **RMSNorm** (Llama, Mistral, Gemma, Qwen) skips the centring and divides by
the root mean square. Each is a reduction over the feature axis, a per-row scale, and a learned
per-feature affine map.

The words this guide uses, for one row \`x\` of \`D\` numbers:

| Term | Meaning |
| --- | --- |
| row | the \`D\` features of one token, \`x[b, t, :]\`; a norm treats every row on its own |
| reduction | an operation that collapses an axis to one number per row, such as a sum or a mean |
| mean \`μ\` | \`sum(x) / D\`, the row's average |
| variance \`σ²\` | \`mean((x − μ)²)\`, the average squared distance from the mean. **Biased** divides by \`D\`; **unbiased** (Bessel's correction) divides by \`D − 1\` |
| standard deviation \`σ\` | \`sqrt(σ²)\`, the row's typical spread |
| root mean square (RMS) | \`sqrt(mean(x²))\`: square, average, square root. It equals \`σ\` when \`μ = 0\` |
| \`eps\` | a small constant (1e-5 or 1e-6) added under the square root so a row with \`σ² = 0\` never divides by zero |
| \`rsqrt(v)\` | \`1 / sqrt(v)\`, the reciprocal square root, one call: \`torch.rsqrt\` |
| affine parameters | the learned per-feature \`weight\` (a scale, often written γ) and \`bias\` (a shift, β): \`y · weight + bias\` |
| broadcasting | PyTorch stretches a size-1 axis to match: \`(B, T, D) − (B, T, 1)\` subtracts each row's one mean from all its \`D\` features |
| \`float16\`, \`bfloat16\` | 16-bit floats. float16 tops out at 65 504 with 10 mantissa bits; bfloat16 ("brain float") keeps float32's range with only 7 |
| upcast | convert to a wider dtype (\`x.float()\` gives float32) before the arithmetic, then cast the result back |

Here are both norms inside one pre-norm sublayer, read bottom to top:

:::architecture
{
  "input": "x · (B, T, D) · float32 or bfloat16",
  "output": "x + sublayer(norm(x))",
  "items": [
    {"id": "stream", "label": "Residual stream", "sub": "x · one D-vector per token", "kind": "io", "shape": "[B, T, D]", "detail": "Every block reads from it and adds into it; the norm acts on each row on its own, reducing over D only."},
    {"columns": [
      [{"tone": "dotted", "label": "LayerNorm · GPT-2, BERT", "items": [
        {"id": "ln-mean", "label": "Row mean", "sub": "μ = x.mean(-1, keepdim)", "shape": "[B, T, 1]"},
        {"id": "ln-var", "label": "Biased variance", "sub": "σ² = x.var(unbiased=False)", "shape": "[B, T, 1]", "detail": "Divide by D, not D − 1."},
        {"id": "ln-scale", "label": "Centre and scale", "sub": "(x − μ) · rsqrt(σ² + 1e-5)", "detail": "eps inside the root; one rsqrt per row, then a multiply per element."},
        {"id": "ln-affine", "label": "Affine map", "sub": "· weight + bias · (D,) each", "shape": "[B, T, D]"}
      ]}],
      [{"tone": "dotted", "label": "RMSNorm · Llama, Mistral", "items": [
        {"id": "rms-up", "label": "Upcast", "sub": "xf = x.float() if 16-bit", "detail": "Only float16 and bfloat16; float64 stays float64."},
        {"id": "rms-ms", "label": "Mean of squares", "sub": "mean(xf²) · no centring", "shape": "[B, T, 1]", "detail": "mean(x²) = σ² + μ²: one reduction, and the row is not moved to zero mean."},
        {"id": "rms-scale", "label": "Scale", "sub": "xf · rsqrt(ms + 1e-6)"},
        {"id": "rms-cast", "label": "Cast back", "sub": ".type_as(x)", "detail": "Before the weight multiply, so the output keeps the input dtype."},
        {"id": "rms-weight", "label": "Scale by weight", "sub": "· weight (D,) · no bias", "shape": "[B, T, D]"}
      ]}]
    ]},
    {"id": "sublayer", "label": "Attention or MLP", "kind": "attention", "sub": "reads the normalised row", "shape": "[B, T, D]", "detail": "GPT-2 feeds it the left path, Llama the right."},
    {"id": "add", "op": "+", "from": "stream", "detail": "Pre-norm: x = x + sublayer(norm(x)); the residual carries the un-normalised x around the norm."}
  ],
  "notes": [
    {"at": "ln-var", "text": "Divide by **D**, not D − 1", "side": "left"},
    {"at": "ln-scale", "text": "**eps** under the root: a flat row gives bias, not NaN", "side": "left"},
    {"at": "rms-up", "text": "fp16 x² overflows at **|x| ≥ 256**"},
    {"at": "rms-ms", "text": "**1** reduction instead of 2"},
    {"at": "add", "text": "Pre-norm: the stream itself is never normalised"}
  ]
}
:::

The contract the drill implements, in \`norms.py\`:

- \`LayerNorm(normalized_shape, eps=1e-5)\`: parameters \`weight\` (ones) and \`bias\` (zeros) of
  \`normalized_shape\`; \`forward(x)\` returns \`(x − mean) · rsqrt(var + eps) · weight + bias\` over the
  trailing \`len(normalized_shape)\` dims, the variance **biased** and \`eps\` **inside** the root.
- \`RMSNorm(dim, eps=1e-6)\`: one parameter \`weight\` of shape \`(dim,)\`; \`forward(x)\` returns
  \`x · rsqrt(mean(x²) + eps) · weight\` over the last dim. A \`float16\`/\`bfloat16\` input is normalised
  in **float32** and cast back before the \`weight\` multiply.
- Neither module calls \`nn.LayerNorm\`, \`F.layer_norm\` or \`F.rms_norm\`; the self-test holds them
  against those references in float32, in half precision, and under \`gradcheck\` in float64.

# Why the residual stream is normalised

[Layer normalization](https://arxiv.org/abs/1607.06450) (Ba, Kiros and Hinton, 2016) was proposed
as a batch-size-free alternative to batch normalization: the statistics come from one example's own
features, so they are identical in training and inference and need no running averages. In a
transformer the residual stream grows with depth (each block *adds* to it), and without a norm the
logits of block 40 would be scaled by whatever the first 39 blocks happened to add.

Where the norm sits matters as much as what it computes:

| Placement | Block | Used by | Property |
| --- | --- | --- | --- |
| post-norm | \`x = norm(x + attn(x))\` | the original Transformer, BERT | gradients flow through every norm; deep stacks need warm-up and small learning rates |
| pre-norm | \`x = x + attn(norm(x))\` | GPT-2, Llama, every current LLM | the residual path is an identity; the norm only shapes what each sublayer *reads* |

- [Xiong et al. (2020)](https://arxiv.org/abs/2002.04745) show that at initialisation post-norm's
  gradients are large for the parameters near the output, which is why it needs a learning-rate
  warm-up; pre-norm's are well behaved, and pre-norm models can train without one.
- Pre-norm leaves the stream itself un-normalised, so a final norm is applied before the output
  projection: GPT-2's \`ln_f\`, Llama's \`norm\`.
- A norm is per token: the \`B × T\` rows are independent and the reduction is only over \`D\`. Nothing
  about the batch or the sequence enters the statistic, which is why the same module serves training,
  a batched prefill and a single-token decode step.

:::quiz
Q: In a pre-norm block, what does the norm's output feed?
- [ ] The residual stream itself, which is replaced by the normalised row
- [x] Only the sublayer's input; the residual add uses the un-normalised x
- [ ] The next block's norm, which is why the final norm can be dropped
> Pre-norm is x = x + f(norm(x)). The stream stays an unnormalised sum of every block's contribution, so the output head needs a final norm of its own, and the sublayer sees a fixed-magnitude input at every depth.
:::

# LayerNorm: biased variance, eps under the root, rsqrt

For one row \`x\` of \`D\` features:

\`\`\`text
μ  = mean(x)                        over the last dim, keepdim
σ² = mean((x − μ)²)                 biased: divide by D, not D − 1
r  = rsqrt(σ² + eps)                eps inside the root
y  = (x − μ) · r · weight + bias    weight, bias: shape (D,), broadcast over rows
\`\`\`

Why each line is there:

1. Subtracting \`μ\` moves the row's average to 0. That is the **re-centring**.
2. \`σ²\` measures the spread of the centred row. It must be the biased one, \`sum / D\`, because the
   next line wants the mean square of exactly these \`D\` numbers to come out as 1.
3. Multiplying the centred row by \`r = 1 / sqrt(σ²)\` divides every deviation by the typical deviation,
   so the new mean of squares is \`σ² · r² = 1\`. That is the **re-scaling**. \`eps\` changes it to
   \`σ² / (σ² + eps)\`, a hair under 1 for any ordinary row.
4. \`weight\` and \`bias\` let training undo either step per feature if that helps; at ones and zeros
   they do nothing.

**One row by hand.** Take \`x = [1, 2, 3, 6]\` (\`D = 4\`), \`weight\` ones, \`bias\` zeros, \`eps = 1e-5\`:

| Step | Computation | Result |
| --- | --- | --- |
| 1. mean | \`(1 + 2 + 3 + 6) / 4\` | \`μ = 3\` |
| 2. centre | \`x − μ\` | \`[−2, −1, 0, 3]\` |
| 3. square | \`(x − μ)²\` | \`[4, 1, 0, 9]\`, sum 14 |
| 4. biased variance | \`14 / 4\` | \`σ² = 3.5\` |
| 5. reciprocal root | \`rsqrt(3.5 + 1e-5)\` | \`r = 0.53452\` |
| 6. scale | \`(x − μ) · r\` | \`[−1.069, −0.535, 0, 1.604]\` |
| 7. affine | \`· 1 + 0\` | unchanged |

Check the result: it sums to 0, and its squares \`1.143 + 0.286 + 0 + 2.571\` average to 1.
\`F.layer_norm\` returns the same four numbers. Now the classic bug: \`x.var(-1)\` divides by \`D − 1\` by
default, giving \`σ² = 14 / 3 = 4.667\`, \`r = 0.4629\` and \`[−0.926, −0.463, 0, 1.389]\`, every value
13% too small (a factor \`sqrt(3 / 4) = 0.866\`). At \`D = 4\` the bug is loud; at \`D = 64\` it is 0.8%.

With the self-test's \`(2, 5, 64)\` input, the two statistics are reductions that keep a size-1 axis, and
everything after them is a broadcast:

:::architecture
{
  "input": "x · (2, 5, 64) · float32",
  "output": "y · (2, 5, 64) · float32",
  "items": [
    {"columns": [
      [{"id": "g-mean", "label": "Mean", "sub": "μ · (2, 5, 1)", "detail": "x.mean(dim=-1, keepdim=True)"}],
      [{"id": "g-var", "label": "Biased variance", "sub": "σ² · (2, 5, 1)", "detail": "x.var(dim=-1, unbiased=False, keepdim=True)"}]
    ]},
    {"id": "g-norm", "label": "Normalise", "sub": "(x − μ) · rsqrt(σ² + 1e-5)", "detail": "x, μ and σ² broadcast against each other: (2, 5, 64) with (2, 5, 1)."},
    {"id": "g-aff", "label": "Affine map", "sub": "· weight + bias · (64,) broadcast", "detail": "weight and bias broadcast over the 2 × 5 rows."}
  ],
  "notes": [
    {"at": "g-mean", "text": "keepdim: **(2, 5, 1)** broadcasts back over the row", "side": "left"},
    {"at": "g-aff", "text": "Identity at init: weight **1**, bias **0**"}
  ]
}
:::

Four details decide whether the module agrees with
[\`torch.nn.LayerNorm\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html):

- **Biased variance.** \`torch.var\` defaults to Bessel's correction (divide by D − 1); every
  normalisation kernel divides by D. The normalised row comes out a factor \`sqrt(D / (D − 1))\` too
  small: 0.8% at D = 64, 0.01% at D = 4096, small enough to pass a loose tolerance and wrong in every
  layer. \`unbiased=False\` (or \`correction=0\`) makes the two agree to float32 precision.
- **eps inside the root.** A row of identical values (a padding token, say) has \`σ² = 0\` and
  \`x − μ = 0\`. With no \`eps\` the module computes \`0 · rsqrt(0) = 0 · ∞ = NaN\`; with it, the row
  normalises to \`0 · weight + bias = bias\`. Where \`eps\` goes decides agreement with the reference, not
  finiteness: under the root it floors \`σ\` at \`√eps ≈ 0.003\`, while \`/ (sqrt(σ²) + eps)\` floors it at
  1e-5. On a near-flat row with \`σ = 1e-4\` the reference gives ±0.032 and the eps-outside version ±0.909.
- \`rsqrt\`, **not** \`1 / sqrt\` per element. One reciprocal square root per row, then a multiply per
  element, instead of a division per element (a division costs several multiplies). The two agree to
  rounding; \`rsqrt\` is the form Llama's code and the CUDA kernels use.
- \`keepdim=True\` keeps the reduced axis as size 1, \`(B, T, 1)\`, so \`x − mean\` broadcasts back over
  the row without a \`reshape\`.

Autograd derives the backward, but it is worth knowing its shape: with \`g\` the incoming gradient,
\`x̂ = (x − μ) · r\` and \`h = g · weight\`,

\`\`\`text
dx = r · (h − mean(h) − x̂ · mean(h · x̂))
dweight = Σ_rows g · x̂          dbias = Σ_rows g
\`\`\`

The gradient of a row is the gradient projected away from the two directions the norm removed: the
row's mean and its scale. \`gradcheck\` in float64 confirms the forward written above produces exactly
this.

:::quiz
Q: A hand-written LayerNorm passes allclose against F.layer_norm at rtol 1e-2 and fails at 1e-5. The most likely cause?
- [x] torch.var's default Bessel correction: the normalised row is shrunk by sqrt(D / (D − 1))
- [ ] eps was added after the square root instead of inside it
- [ ] weight and bias were initialised to zeros and ones instead of ones and zeros
> A uniform factor of sqrt(64 / 63) ≈ 1.008 is a 0.8% error on every element: inside 1e-2, outside 1e-5. eps placement only shows on near-constant rows, and swapped initialisation would make every output equal the bias, 1.
:::

# RMSNorm: scale without centring

[Root mean square layer normalization](https://arxiv.org/abs/1910.07467) (Zhang and Sennrich, 2019)
asked which half of LayerNorm does the work. Their finding: the **re-scaling** invariance is what
stabilises training; the **re-centring** is dispensable. Drop it and the module is one reduction:

\`\`\`text
rms = sqrt(mean(x²) + eps)
y   = x / rms · weight             no mean, no bias
\`\`\`

**The same row by hand.** \`x = [1, 2, 3, 6]\`, \`weight\` ones, \`eps = 1e-6\`:

| Step | Computation | Result |
| --- | --- | --- |
| 1. square | \`x²\` | \`[1, 4, 9, 36]\`, sum 50 |
| 2. mean of squares | \`50 / 4\` | \`12.5\` (RMS \`= sqrt(12.5) = 3.536\`) |
| 3. reciprocal root | \`rsqrt(12.5 + 1e-6)\` | \`r = 0.28284\` |
| 4. scale | \`x · r\` | \`[0.283, 0.566, 0.849, 1.697]\` |

The squares of the result average to 1, as with LayerNorm, but the result does not sum to 0: its mean
is \`0.849 = μ · r = 3 · 0.283\`. RMSNorm kept the row's offset and scaled it with everything else. The
two statistics are linked: \`mean(x²) = σ² + μ² = 3.5 + 9 = 12.5\`.

Llama's module is the form the drill uses, and the one \`torch.nn.functional.rms_norm\` (PyTorch 2.4)
reproduces:

\`\`\`python
def _norm(self, x):
    return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)

def forward(self, x):
    return self._norm(x.float()).type_as(x) * self.weight
\`\`\`

| | LayerNorm | RMSNorm |
| --- | --- | --- |
| reductions per row | 2 (mean, then variance) | 1 (mean of squares) |
| element-wise passes | subtract, scale, affine ×2 | scale, affine ×1 |
| parameters per layer | 2·D (\`weight\`, \`bias\`) | D (\`weight\`) |
| default \`eps\` | 1e-5 (\`nn.LayerNorm\`) | 1e-6 in Llama's \`RMSNorm\` class and LLaMA 1; Llama 2 and 3 pass 1e-5 |
| invariant to | adding a constant to the row, scaling the row | scaling the row |
| used by | GPT-2, BERT, OPT, ViT | Llama, Mistral, Gemma, Qwen, T5 |

- The variance of a row *after* centring and its mean of squares *before* centring differ by μ²:
  \`mean(x²) = σ² + μ²\`. RMSNorm therefore does not map a row to zero mean; a row with a large common
  offset is scaled down by it. In practice the residual stream's rows are close to zero-mean and the
  difference is immaterial to quality.
- No bias: a learned per-feature shift would re-introduce the offset the norm is indifferent to, and
  the next linear layer has a bias of its own if it wants one.
- The saving is small per layer (one reduction and D parameters) and real in aggregate: a 7B Llama
  runs 65 norms per token, and every reduction is a pass over a 4096-wide row held in memory
  bandwidth, not FLOPs.

Give the row a common offset and the two part ways: LayerNorm subtracts it, RMSNorm scales it down with
the rest of the row.

:::widget norm-compare

:::quiz
Q: A row of all 3.0 (D = 64) goes through RMSNorm with weight = ones. What comes out?
- [ ] All zeros: the row has no variance
- [x] All 1.0: 3 / sqrt(mean(9)) = 1
- [ ] NaN: the statistic is 0 and the division fails
> RMSNorm divides by the root mean square, not the standard deviation. The row's RMS is 3, so every element becomes 1. LayerNorm on the same row would subtract the mean and return bias (zeros); it is LayerNorm *without* eps that would reach 0 · ∞ = NaN.
:::

# The upcast rule: where overflow is allowed

Models train and serve in \`bfloat16\`, and some in \`float16\`. The residual stream's activations grow
with depth (rows of magnitude in the hundreds are ordinary in a large model), and the norm squares
them:

| dtype | exponent bits | mantissa bits | largest finite | \`x²\` overflows at |
| --- | --- | --- | --- | --- |
| float16 | 5 | 10 | 65 504 | \`\\|x\\| ≥ 256\` |
| bfloat16 | 8 | 7 | 3.4 × 10³⁸ | \`\\|x\\| > 1.8 × 10¹⁹\`, never in practice |
| float32 | 8 | 23 | 3.4 × 10³⁸ | never |

\`256² = 65 536\` is just past float16's 65 504, and float16's next value below 256 is 255.875, whose
square 65 472 still fits. Follow the four-element row \`x = [300, −20, 5, 100]\` through RMSNorm both
ways:

| Stage | Squared in float16 | Upcast to float32 first |
| --- | --- | --- |
| \`x²\` | \`[inf, 400, 25, 10 000]\` | \`[90 000, 400, 25, 10 000]\` |
| \`mean(x²)\` | \`inf\`: one overflow poisons the row | \`25 106.25\` (RMS 158.4) |
| \`rsqrt(ms + eps)\` | \`0\` | \`0.006311\` |
| \`x · r\` | \`[0, 0, 0, 0]\`: finite, silent, wrong | \`[1.893, −0.126, 0.032, 0.631]\` |
| cast to float16 | zeros | \`[1.894, −0.1262, 0.03156, 0.6313]\` |

Nothing raises. The row is replaced by zeros, the block's attention sees a blank token, and the loss
moves a little. Llama's module takes the statistic in float32 and casts the *normalised* row back:

:::architecture
{
  "input": "x · float16 · magnitudes up to 600",
  "output": "y · float16 · within 1e-3 of the float32 statistic",
  "items": [
    {"id": "u-up", "label": "Upcast", "sub": "xf = x.float() · float32", "detail": "One temporary float32 row; the statistic, the rsqrt and the division all happen here."},
    {"id": "u-ms", "label": "Mean of squares", "sub": "squares up to 3.6 × 10⁵", "detail": "Far inside float32's range of 3.4 × 10³⁸."},
    {"id": "u-scale", "label": "Scale", "sub": "xf · rsqrt(ms + eps) · unit RMS"},
    {"id": "u-cast", "label": "Cast back", "sub": ".type_as(x) · float16, values O(1)", "detail": "A row of unit RMS loses only mantissa bits in float16, never range."},
    {"id": "u-w", "label": "Scale by weight", "sub": "float16 · float16", "detail": "weight lives in the model's dtype; multiplying after the cast keeps y in float16."}
  ],
  "notes": [
    {"at": "u-ms", "text": "**No inf**: float32 holds the squares"},
    {"at": "u-cast", "text": "Loses mantissa bits, **never** range"}
  ]
}
:::

- **Upcast the input, not the output.** \`x.float()\` costs one temporary row in float32; the statistic,
  the \`rsqrt\` and the division happen there. The normalised row has unit RMS, so casting it back to
  half precision loses only mantissa bits, never range.
- **Cast back before the weight multiply.** \`weight\` lives in the model's dtype; multiplying the
  float32 row by a \`bfloat16\` weight would promote the output to float32 and the next matmul would
  run in the wrong dtype. \`.type_as(x) * self.weight\` keeps the output in \`x\`'s dtype.
- **Leave float32 and float64 alone.** \`x.float()\` on a float64 tensor *downcasts*. A module that
  does so unconditionally still passes every float32 test and fails \`gradcheck\`: the numerical
  Jacobian divides float32 rounding noise (about 6e-8 of each value) by a perturbation of 1e-6, an
  error of several percent. The rule is "at least float32", not "exactly float32".
- \`bfloat16\` cannot overflow here, but its 7-bit mantissa makes a sum of 4096 squares lose precision;
  PyTorch's reductions accumulate in float32 internally, the upcast makes it explicit and covers the
  element-wise steps too.

:::details Why eps differs between the two modules
LayerNorm's \`eps\` is added to a variance; RMSNorm's to a mean of squares, which for a zero-mean row is
the same quantity. The defaults differ by convention, not by mathematics: PyTorch chose 1e-5 for
\`nn.LayerNorm\`; Llama's \`RMSNorm\` class defaults to 1e-6, the value LLaMA 1 shipped, and Llama 2 and 3
pass 1e-5. In half-precision models the value matters slightly more than it looks: a float16 \`eps\` of
1e-6 is representable (the smallest subnormal is 6e-8) but 1e-8 would round to zero, which is one more
reason to add it in float32.
:::

:::quiz
Q: RMSNorm on a float16 row containing a 300 returns a row of zeros, no error. Which line is wrong?
- [ ] rsqrt(... + eps): the eps is too small for float16
- [x] x.pow(2) in float16: 300² = 90 000 exceeds 65 504, the mean is inf and rsqrt(inf) is 0
- [ ] .type_as(x): the cast back truncated the result
> 300 squared overflows float16's range; one inf in the row makes the mean inf and the scale 0. Squaring in float32 (x.float() first) keeps the statistic finite; the cast back then only touches values of order 1.
:::

# How to approach it, and the common mistakes

Build the file in this order, testing as you go:

1. Work the row \`[1, 2, 3, 6]\` by hand (the two tables above) and keep the numbers.
2. Write \`LayerNorm.forward\` for one trailing dim, run it on that row, and match
   \`[−1.069, −0.535, 0, 1.604]\`. Then compare against \`F.layer_norm\` at \`atol=rtol=1e-5\`: a loose
   tolerance hides the Bessel bug.
3. Generalise \`dims\` to a tuple and test \`normalized_shape=(5, 64)\`.
4. Write \`RMSNorm\` in float32 and match \`[0.283, 0.566, 0.849, 1.697]\`, then \`F.rms_norm\`.
5. Add the upcast and feed it a float16 row with entries above 256.
6. Run \`gradcheck\` in float64 last; it is the test that catches an unconditional \`x.float()\`.

| Mistake | What you see | Fix |
| --- | --- | --- |
| \`x.var(-1)\` with its default | 0.8% off at D = 64; passes \`rtol=1e-2\`, fails \`1e-5\` | \`unbiased=False\` or \`correction=0\` |
| \`x.mean(-1)\` without \`keepdim\` | \`(2, 5, 64) − (2, 5)\` raises a size mismatch; with a square \`(D, D)\` input it broadcasts silently and wrong | \`keepdim=True\` |
| no \`eps\` | NaN on a constant row, such as padding | \`rsqrt(var + eps)\` |
| squaring in float16 | a row of zeros, no error | \`x.float()\` before the square |
| \`x.float()\` on every input | float32 tests pass, float64 \`gradcheck\` fails | upcast only \`float16\`/\`bfloat16\` |
| \`* weight\` before \`.type_as(x)\` | a bfloat16 model gets a float32 output | cast back, then multiply |
| \`F.rms_norm(x, (D,), w)\` as the reference | \`eps\` defaults to float32's machine epsilon (1.2e-7), not 1e-6 | pass \`eps\` explicitly |

:::quiz
Q: Your RMSNorm passes every float32 and bfloat16 test but fails gradcheck in float64. What is the likely cause?
- [ ] The variance is unbiased
- [x] x.float() runs on every input, so float64 is downcast to float32
- [ ] .type_as(x) comes before the weight multiply
> gradcheck compares autograd's Jacobian with finite differences of 1e-6. A float32 detour adds rounding noise of about 6e-8 per value, a several-percent error once divided by 1e-6. Upcast only float16 and bfloat16. RMSNorm has no variance, and casting before the weight multiply is the correct order.
:::

# What production systems add

The two modules are six lines of tensor arithmetic, and PyTorch runs them as six kernels, each reading
and writing a \`(B, T, D)\` tensor. For D = 4096 in bfloat16 one row is 8 KB; the stream for a 4k-token
batch is 32 MB per pass:

| Implementation | Passes over the row | What moves |
| --- | --- | --- |
| eager \`x.mean\`, \`x.var\`, \`x − mean\`, \`· rsqrt\`, \`· weight\`, \`+ bias\` | 2 reads + 4 read-writes | ~10 × the tensor |
| \`F.layer_norm\`, \`F.rms_norm\` on CUDA (one fused kernel) | 1 read + 1 write | 2 × the tensor |
| fused residual-add + norm (vLLM, TensorRT-LLM) | 2 reads + 2 writes, instead of 3 + 2 | the sum is never read back |

- **Fused kernels.** \`F.layer_norm\` computes its statistics in one pass over the row, keeping a
  running mean and sum of squared deviations in registers (Welford's algorithm), then writes the row
  once. \`F.rms_norm\` arrived in PyTorch 2.4 as a chain of separate ops and gained a fused CUDA kernel
  in July 2025 ([pytorch#153666](https://github.com/pytorch/pytorch/pull/153666)). Apex's
  \`FusedLayerNorm\`, Triton's layer-norm tutorial and \`torch.compile\` generate the same shape, with
  the backward fused too.
- **Fused into the residual add.** In a pre-norm block the row that enters the norm is the one the
  previous residual add just produced. Inference engines compute \`x + h\` and \`norm(x + h)\` in one
  kernel, writing both.
- **Variants.** Gemma parameterises the scale as \`(1 + weight)\` with zero-initialised \`weight\`;
  QK-norm applies RMSNorm to the query and key vectors inside attention so the logits stay bounded;
  \`nn.LayerNorm(elementwise_affine=False)\` drops the affine map where a following linear layer absorbs
  it. All of them are the drill's two modules with one line changed.
- **Where the time goes.** A norm is memory-bound: a few FLOPs per element against one row read and one
  write. In a decode step it is a negligible fraction of the time; in prefill and training it is the
  difference between six passes and two, which is why no production model runs the eager version.

The one-pass statistic has a trap of its own: \`E[x²] − E[x]²\` subtracts two nearly equal numbers when
the row sits on a large offset, and float32 runs out of digits. Welford's update keeps them; slide the
offset up and watch the shortcut fall apart:

:::widget variance-cancellation

:::quiz
Q: A fused norm kernel reads a 4096-wide bfloat16 row once and writes it once. What limits its speed?
- [ ] FLOPs: the rsqrt is expensive
- [x] Memory bandwidth: a few FLOPs per element against 16 KB of traffic per row
- [ ] The reduction's synchronisation across the batch
> A norm does a handful of FLOPs per element, far below what a GPU can do per byte moved, so the time is the bytes: 8 KB in and 8 KB out per row. Rows are independent, so nothing synchronises across the batch; the one rsqrt per row is negligible.
:::

# What to take away

- **A norm is a reduction, a scale and an affine map per token.** The statistic is over the feature
  axis only; \`B × T\` rows are independent, in training and in a single-token decode.
- **LayerNorm's small print is where the bugs are.** Biased variance (\`unbiased=False\`), \`eps\` under the
  root, \`torch.rsqrt\`, \`keepdim=True\`: each one separates "agrees with \`F.layer_norm\`" from "close".
- **RMSNorm drops the centring, not the scaling.** One reduction, one parameter, the same stabilising
  invariance; it is the norm of every Llama-family model.
- **Take the statistic in float32 and cast the normalised row back.** A float16 square overflows at
  256 and the failure is a row of zeros, not an error. Upcast only what is below float32, so float64
  \`gradcheck\` sees the real Jacobian.
- **Frameworks fuse.** One read, one write, the statistic in registers, the residual add folded in; the
  eager module is the specification, not the kernel.

The primary references are Ba, Kiros and Hinton's
[*Layer Normalization*](https://arxiv.org/abs/1607.06450) and Zhang and Sennrich's
[*Root Mean Square Layer Normalization*](https://arxiv.org/abs/1910.07467); Meta's
[\`llama/model.py\`](https://github.com/meta-llama/llama/blob/v2/llama/model.py) is the \`RMSNorm\` the
drill reproduces, upcast included.
`;
