/**
 * The learning guide for the LayerNorm / RMSNorm drill: why a transformer normalises its residual
 * stream before every sublayer, the LayerNorm statistics and their small print (biased variance, eps
 * under the root, rsqrt), what RMSNorm drops and why, the float32 upcast that keeps a half-precision
 * row from overflowing, and what fused kernels add — a figure or a table where one says it faster
 * than prose, a pop quiz per section. Rendered at \`/pt-layernorm-rmsnorm/learn\`.
 */
export const learn = `# The mechanism at a glance

A transformer keeps a **residual stream**: one vector of \`D\` features per token, shape \`(B, T, D)\`,
that every block reads from and adds into. Before each sublayer — attention, then the MLP — the row is
**normalised** so the sublayer sees inputs of a fixed magnitude whatever the stream has accumulated.
Two normalisations cover every modern LLM: **LayerNorm** (GPT-2, BERT, ViT) centres the row and divides
by its standard deviation; **RMSNorm** (Llama, Mistral, Gemma, Qwen) skips the centring and divides by
the root mean square. Each is a reduction over the feature axis, a per-row scale, and a learned
per-feature affine map. Here are both inside one pre-norm sublayer, read bottom to top:

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
    {"at": "ln-scale", "text": "eps **inside** the root: a flat row gives bias, not NaN", "side": "left"},
    {"at": "rms-up", "text": "fp16 x² overflows at **|x| > 256**"},
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
transformer the residual stream grows with depth — each block *adds* to it — and without a norm the
logits of block 40 would be scaled by whatever the first 39 blocks happened to add.

Where the norm sits matters as much as what it computes:

| Placement | Block | Used by | Property |
| --- | --- | --- | --- |
| post-norm | \`x = norm(x + attn(x))\` | the original Transformer, BERT | gradients flow through every norm; deep stacks need warm-up and small learning rates |
| pre-norm | \`x = x + attn(norm(x))\` | GPT-2, Llama, every current LLM | the residual path is an identity; the norm only shapes what each sublayer *reads* |

- [Xiong et al. (2020)](https://arxiv.org/abs/2002.04745) show the pre-norm gradient at
  initialisation is well behaved at any depth, while post-norm's grows with the number of layers.
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

Three details decide whether the module agrees with
[\`torch.nn.LayerNorm\`](https://pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html):

- **Biased variance.** \`torch.var\` defaults to Bessel's correction (divide by D − 1); every
  normalisation kernel divides by D. The difference is a factor of \`sqrt(D / (D − 1))\` on the whole
  output — 0.8% at D = 64, 0.01% at D = 4096 — small enough to pass a loose tolerance and wrong in
  every layer. \`unbiased=False\` (or \`correction=0\`) makes the two agree to float32 precision.
- **eps inside the root.** A row of identical values has σ² = 0. With \`eps\` added before the root the
  row normalises to \`0 · weight + bias\`; added after, it is \`0 / 0\`. The default 1e-5 is a floor on
  the variance, not a nudge on the result.
- \`rsqrt\`, **not** \`1 / sqrt\`. One reciprocal square root per row, then a multiply per element,
  instead of a square root and a division per element. The arithmetic is the same; the instruction
  count and the rounding are not, and it is the form the fused kernels and the reference use.
- \`keepdim=True\` keeps the reduced axis as size 1, \`(B, T, 1)\`, so \`x − mean\` broadcasts back over
  the row without a \`reshape\`.

Autograd derives the backward, but it is worth knowing its shape: with \`g\` the incoming gradient,
\`x̂ = (x − μ) · r\` and \`h = g · weight\`,

\`\`\`text
dx = r · (h − mean(h) − x̂ · mean(h · x̂))
dweight = Σ_rows g · x̂          dbias = Σ_rows g
\`\`\`

The gradient of a row is the gradient projected away from the two directions the norm removed — the
row's mean and its scale. \`gradcheck\` in float64 confirms the forward written above produces exactly
this.

:::quiz
Q: A hand-written LayerNorm passes allclose against F.layer_norm at rtol 1e-2 and fails at 1e-5. The most likely cause?
- [x] torch.var's default Bessel correction: the output is scaled by sqrt(D / (D − 1))
- [ ] eps was added after the square root instead of inside it
- [ ] weight and bias were initialised to zeros and ones instead of ones and zeros
> A uniform factor of sqrt(64 / 63) ≈ 1.008 is a 0.8% error on every element — inside 1e-2, outside 1e-5. eps placement only shows on near-constant rows, and swapped initialisation would zero the output entirely.
:::

# RMSNorm: scale without centring

[Root mean square layer normalization](https://arxiv.org/abs/1910.07467) (Zhang and Sennrich, 2019)
asked which half of LayerNorm does the work. Their finding: the **re-scaling** invariance is what
stabilises training; the **re-centring** is dispensable. Drop it and the module is one reduction:

\`\`\`text
rms = sqrt(mean(x²) + eps)
y   = x / rms · weight             no mean, no bias
\`\`\`

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
| parameters per layer | 2D (\`weight\`, \`bias\`) | D (\`weight\`) |
| default \`eps\` | 1e-5 | 1e-6 (Llama 2), 1e-5 (Llama 3) |
| invariant to | adding a constant to the row, scaling the row | scaling the row |
| used by | GPT-2, BERT, OPT, ViT | Llama, Mistral, Gemma, Qwen, T5 |

- The variance of a row *after* centring and its mean of squares *before* centring differ by μ²:
  \`mean(x²) = σ² + μ²\`. RMSNorm therefore does not map a row to zero mean; a row with a large common
  offset is scaled down by it. In practice the residual stream's rows are close to zero-mean and the
  difference is immaterial to quality.
- No bias: a learned per-feature shift would re-introduce the offset the norm is indifferent to, and
  the next linear layer has a bias of its own if it wants one.
- The saving is small per layer — one reduction and D parameters — and real in aggregate: a 7B Llama
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
> RMSNorm divides by the root mean square, not the standard deviation. The row's RMS is 3, so every element becomes 1. LayerNorm on the same row would subtract the mean and give bias (zeros); only an eps *outside* the root would reach a NaN.
:::

# The upcast rule: where overflow is allowed

Models train and serve in \`bfloat16\`, and some in \`float16\`. The residual stream's activations grow
with depth — rows of magnitude in the hundreds are ordinary in a large model — and the norm squares
them:

| dtype | exponent bits | mantissa bits | largest finite | \`x²\` overflows at |
| --- | --- | --- | --- | --- |
| float16 | 5 | 10 | 65 504 | \`|x| > 256\` |
| bfloat16 | 8 | 7 | 3.4 × 10³⁸ | \`|x| > 1.8 × 10¹⁹\` — never in practice |
| float32 | 8 | 23 | 3.4 × 10³⁸ | never |

The naive module squares in the input dtype:

| Stage, all in float16 | Value |
| --- | --- |
| \`x\` | magnitudes up to 600 |
| \`x.pow(2)\` | \`inf\` wherever a magnitude exceeds 256 |
| \`mean(x²)\` | \`inf\`: one overflow poisons the row |
| \`rsqrt(inf + eps)\` | \`0\` |
| \`x · 0 · weight\` | zeros: finite, silent, wrong |

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
  Jacobian is taken with float64 perturbations of 1e-6 that vanish in float32. The rule is "at least
  float32", not "exactly float32".
- \`bfloat16\` cannot overflow here, but its 7-bit mantissa makes a sum of 4096 squares lose precision;
  PyTorch's reductions accumulate in float32 internally, the upcast makes it explicit and covers the
  element-wise steps too.

:::details Why eps differs between the two modules
LayerNorm's \`eps\` is added to a variance; RMSNorm's to a mean of squares, which for a zero-mean row is
the same quantity. The defaults differ by convention, not by mathematics: PyTorch chose 1e-5 for
\`nn.LayerNorm\`; Llama 2 ships 1e-6 for its RMSNorm and Llama 3 raised it to 1e-5. In half-precision
models the value matters slightly more than it looks: a float16 \`eps\` of 1e-6 is representable (the
smallest subnormal is 6e-8) but 1e-8 would round to zero, which is one more reason to add it in float32.
:::

:::quiz
Q: RMSNorm on a float16 row containing a 300 returns a row of zeros, no error. Which line is wrong?
- [ ] rsqrt(... + eps): the eps is too small for float16
- [x] x.pow(2) in float16: 300² = 90 000 exceeds 65 504, the mean is inf and rsqrt(inf) is 0
- [ ] .type_as(x): the cast back truncated the result
> 300 squared overflows float16's range; one inf in the row makes the mean inf and the scale 0. Squaring in float32 (x.float() first) keeps the statistic finite; the cast back then only touches values of order 1.
:::

# What production systems add

The two modules are six lines of tensor arithmetic, and PyTorch runs them as six kernels, each reading
and writing a \`(B, T, D)\` tensor. For D = 4096 in bfloat16 one row is 8 KB; the stream for a 4k-token
batch is 32 MB per pass:

| Implementation | Passes over the row | What moves |
| --- | --- | --- |
| eager \`x.mean\`, \`x.var\`, \`x − mean\`, \`· rsqrt\`, \`· weight\`, \`+ bias\` | 2 reads + 4 read-writes | ~10 × the tensor |
| \`F.layer_norm\` / \`F.rms_norm\` (one fused kernel) | 1 read + 1 write | 2 × the tensor |
| fused residual-add + norm (vLLM, TensorRT-LLM) | 1 read of two inputs + 2 writes | the add's traffic disappears |

- **Fused kernels.** \`F.layer_norm\` and \`F.rms_norm\` compute the statistic with a single pass that
  keeps the running sum and sum of squares in registers (Welford's algorithm for the variance),
  then write the row once. Apex's \`FusedLayerNorm\`, Triton's layer-norm tutorial and
  \`torch.compile\` generate the same shape, with the backward fused too.
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

# What to take away

- **A norm is a reduction, a scale and an affine map per token.** The statistic is over the feature
  axis only; \`B × T\` rows are independent, in training and in a single-token decode.
- **LayerNorm's small print is where the bugs are.** Biased variance (\`unbiased=False\`), \`eps\` under the
  root, \`torch.rsqrt\`, \`keepdim=True\` — each one separates "agrees with \`F.layer_norm\`" from "close".
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
[\`llama/model.py\`](https://github.com/meta-llama/llama/blob/main/llama/model.py) is the \`RMSNorm\` the
drill reproduces, upcast included.
`;
