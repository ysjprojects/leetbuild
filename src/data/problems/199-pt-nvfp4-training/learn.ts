/**
 * The learning guide for training in NVFP4: why 4-bit training differs from 4-bit inference, the three
 * GEMMs of a linear layer and their reduction dimensions, stochastic rounding, 16 × 16 weight blocks,
 * the random Hadamard transform and what it does and does not buy at block size 16, and the toy run.
 * Rendered at `/pt-nvfp4-training/learn`.
 */
export const learn = `# The mechanism at a glance

NVFP4 stores a tensor as 4-bit E2M1 values, ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}, in blocks of 16 that share an
FP8 E4M3 scale, under one FP32 scale per tensor. Blackwell tensor cores multiply such operands
directly. NVIDIA's [Pretraining Large Language Models with NVFP4](https://arxiv.org/abs/2509.25149)
(2025) is the recipe for doing that during training rather than only at inference: a 12B hybrid
Mamba-Transformer trained on 10T tokens with 84 % of its linear layers in NVFP4 stayed within about
1.5 % (relative) of its FP8 baseline's loss, with comparable downstream accuracy. The problem builds the recipe at toy scale in three files: \`quantize_nvfp4\` with stochastic
rounding and 16 × 16 blocks, the 16 × 16 random Hadamard transform \`rht\`, and \`NVFP4LinearFn\`, an
autograd function whose three GEMMs all run on NVFP4 operands.

:::architecture
{
  "input": "x · (N, in) activations",
  "output": "dX down · dW to AdamW",
  "items": [
    {"id": "g-x", "label": "Activations x", "kind": "io", "sub": "(N, in) · FP32"},
    {"columns": [
      [{"id": "g-qx", "label": "Q(x)", "kind": "attention", "sub": "1 × 16 along in · nearest"}],
      [{"id": "g-qw", "label": "Q(W)", "kind": "attention", "sub": "16 × 16 tiles · nearest", "side": {"label": "FP32 master W", "sub": "(out, in)"}}]
    ]},
    {"id": "g-fprop", "label": "Fprop", "kind": "ffn", "sub": "y = Q(x) Q(W)ᵀ · sums over in"},
    {"id": "g-dy", "label": "Gradient dY", "kind": "io", "sub": "(N, out) · FP32"},
    {"columns": [
      [
        {"id": "g-qdy", "label": "Q(dY)", "kind": "attention", "sub": "1 × 16 along out · SR"},
        {"id": "g-dgrad", "label": "Dgrad", "kind": "ffn", "sub": "dX = Q(dY) Q(W) · sums over out"}
      ],
      [
        {"id": "g-rht", "label": "dYᵀH and xᵀH", "kind": "attention", "sub": "16 × 16 RHT along tokens"},
        {"id": "g-qw2", "label": "Q(dYᵀH), Q(xᵀH)", "kind": "attention", "sub": "1 × 16 along tokens · SR, nearest"},
        {"id": "g-wgrad", "label": "Wgrad", "kind": "ffn", "sub": "dW = Q(dYᵀH) Q(xᵀH)ᵀ · sums over N"}
      ]
    ]},
    {"id": "g-out", "label": "dX and dW", "kind": "io", "sub": "FP32"}
  ],
  "notes": [
    {"at": "g-qw", "text": "the **same** Q(W) in fprop and dgrad"},
    {"at": "g-qdy", "text": "**E[Q(dY)] = dY**", "side": "left"},
    {"at": "g-rht", "text": "**H Hᵀ = I**: the product is unchanged"}
  ]
}
:::

The recipe has four parts. Each answers a different way a 4-bit training run goes wrong:

| part | what it fixes | where it goes |
|---|---|---|
| a few layers in BF16 | the final layers need more range and mantissa than FP4 | ~15 % of linear layers, mostly at the end |
| 16 × 16 weight blocks | fprop and dgrad would multiply by two different quantized weights | weights only |
| stochastic rounding | round-to-nearest biases gradients, and the bias accumulates | gradients only (dgrad and wgrad) |
| 16 × 16 random Hadamard transform | a block dominated by one value flushes the rest to zero | both wgrad inputs only |

Everything else stays in high precision: embeddings, the head, norms, non-linearities, the softmax and
the two attention matmuls, the FP32 master weights and the optimizer state. [Transformer Engine's
NVFP4 guide](https://docs.nvidia.com/deeplearning/transformer-engine/features/low_precision_training/nvfp4/nvfp4.html)
describes the same recipe as it ships in \`NVFP4BlockScaling\`, with a flag to turn each technique off.

# Three GEMMs, three reduction dimensions

A linear layer \`y = x Wᵀ\` costs three GEMMs per step, and each one sums over a different dimension:

| GEMM | product | sums over | 1 × 16 blocks run along | rounding |
|---|---|---|---|---|
| fprop | \`Q(x) · Q(W)ᵀ\` | \`in\` | rows of x, rows of W | nearest for both |
| dgrad | \`Q(dY) · Q(W)\` | \`out\` | rows of dY, columns of W | SR on dY, nearest on W |
| wgrad | \`Q(dYᵀ) · Q(xᵀ)ᵀ\` | tokens \`N\` | columns of dY and of x | SR on dY, nearest on x |

The block direction is not a free choice. A tensor core computes a dot product in chunks of 16 products
and applies one scale per chunk per operand, so the 16 values that share a scale must be 16 consecutive
terms of the sum: blocks always run along the reduction dimension. That is why \`dY\` is quantized twice
(once along \`out\` for dgrad, once along tokens for wgrad), why \`x\` is quantized twice, and why the
weight, with ordinary 1 × 16 blocks, would be quantized once along \`in\` and once along \`out\`.

Inference sees only the first row, once per weight. Training sees all three, on fresh data every step,
and adds the wgrad result into the same FP32 weights thousands of times. A rounding error that is
random from step to step averages out of that sum; a rounding error with a consistent sign does not.
That is the lens for the rest of the recipe.

:::quiz
Q: Why does the wgrad GEMM quantize \`dYᵀ\` and \`xᵀ\` in blocks of 16 tokens, not 16 channels?
- [ ] Tokens are more similar to each other than channels, so the scales fit better
- [x] The scale must be shared by consecutive terms of the dot product, and wgrad sums over tokens
- [ ] The tensor core only reads transposed operands
> \`dW[o, i] = Σ_t dY[t, o] · x[t, i]\` sums over tokens, and a block scale is applied to a chunk of 16
> consecutive products of that sum. Blocks along channels would give each product a different scale
> inside one chunk, which the hardware cannot apply.
:::

# Stochastic rounding: unbiased, not more accurate

Round-to-nearest-even (RNE) picks the closer of the two neighbouring grid points. Stochastic rounding
(SR, [Gupta et al., 2015](https://arxiv.org/abs/1502.02551)) picks between the same two at random:

\`\`\`text
a = min(|v|, 6)            v = x / (s_block · s_global), in E2M1 units
step = 0.5 if a < 2, 1 if a < 4, else 2
lo = floor(a / step) · step
q = sign(v) · (lo + step)  with probability (a − lo) / step
q = sign(v) · lo           otherwise
E[q] = sign(v) · (lo + step · (a − lo) / step) = sign(v) · a = v      for |v| ≤ 6
\`\`\`

The expectation is the value itself, for every value inside the grid: the two outcomes sit \`step\`
apart and the chance of the upper one is the fraction of \`step\` already covered. RNE's error, by contrast, is a
deterministic function of where the value sits in its interval, and gradients do not sit uniformly:
they are heavy-tailed, so most of a block lies far below the block maximum that sets the scale. Below
0.25 E2M1 units, RNE stores 0. On the step-1 self-test's heavy-tailed tensor (Gaussian times log-normal):

| measurement | round to nearest even | stochastic rounding |
|---|---|---|
| values below the smallest non-zero code, 0.5 | 70 % of the tensor | 70 % of the tensor |
| of those, stored as 0 by one draw | 85 % | about 79 %, the rest round up to 0.5 |
| total magnitude of those values after rounding | −41 % | +0.07 % (mean of 64 draws) |
| RMS error of one draw, in grid gaps | 0.22 | 0.34 |

The widget runs the same experiment on 2,048 values. The dots are the mean error per bin of |x|: RNE's
follow the sawtooth (negative just above every grid point, positive just below the next), SR's sit on
zero once a few draws are averaged. The histogram on the right is the price: one SR draw's error spans
a whole grid gap, RNE's only half of one.

:::widget stochastic-rounding {"mode": "rounding", "tail": 1}

Two consequences shape the recipe:

- **Gradients only.** SR's larger per-value error hurts where nothing averages it out. The paper
  finds SR on activations or weights makes training diverge, and SR on all backward tensors no better
  than SR on the gradients alone; for the 12B model it is needed on the gradients entering both dgrad
  and wgrad.
- **Not quite exact.** The E4M3 block scale is rounded to nearest, so it can land just below
  \`amax / 6\`, which puts the block maximum up to 1/16 above 6 (for a normal E4M3 scale), where it
  saturates. Those few values (3.4 % of the step-1 test tensor) are the one place SR is biased.

:::quiz
Q: A weight receives the same tiny gradient g every step, 0.2 E2M1 units after scaling. After 1,000 steps, what has each rounding added to it?
- [ ] Both about 1,000 g, since rounding errors cancel over many steps
- [x] RNE adds 0 every step; SR adds 0.5 units with probability 0.4, about 1,000 g in total
- [ ] RNE adds 1,000 g exactly; SR adds 1,000 g plus noise that grows without bound
> 0.2 is below the 0.25 tie between 0 and 0.5, so round-to-nearest stores 0 every time and the update
> is lost for good. SR picks 0.5 with probability 0.2 / 0.5 = 0.4, so each draw is g in expectation and
> the sum is 1,000 g; its noise grows only as the square root of the number of steps.
:::

# One weight for both passes: 16 × 16 blocks

With 1 × 16 blocks, fprop quantizes the weight along \`in\` and dgrad along \`out\`: two matrices,
\`W_fprop ≠ W_bprop\`. The backward then computes \`dX = dY · W_bprop\`, the gradient of
the product with \`W_bprop\`, a function the forward never evaluated. The paper calls this a chain-rule violation
and hypothesises that it costs accuracy. The fix is to give the weight one scale per 16 × 16 tile,
16 input channels by 16 output channels: a tile and its transpose have the same amax, the same scale
and the same codes, so \`Q(W)ᵀ = Q(Wᵀ)\` bit for bit and one quantized weight serves both GEMMs.

:::architecture
{
  "input": "FP32 master W · (out, in)",
  "output": "the function the backward differentiates",
  "items": [
    {"columns": [
      [
        {"id": "f-row", "label": "1 × 16 along in", "kind": "attention", "sub": "W_fprop · used by fprop"},
        {"id": "f-col", "label": "1 × 16 along out", "kind": "attention", "sub": "W_bprop ≠ W_fprop · used by dgrad"},
        {"id": "f-bad", "label": "Dgrad of another function", "kind": "loss", "sub": "bias stays: 0.081 at 64 draws"}
      ],
      [
        {"id": "f-tile", "label": "16 × 16 tiles", "kind": "attention", "sub": "Q(W)ᵀ = Q(Wᵀ)"},
        {"id": "f-same", "label": "One Q(W) for both GEMMs", "kind": "ffn", "sub": "fprop and dgrad"},
        {"id": "f-good", "label": "Dgrad of the forward", "kind": "io", "sub": "bias falls: 0.013 at 64 draws"}
      ]
    ]},
    {"id": "f-step", "label": "dX to the layer below", "kind": "io", "sub": "mean of 64 draws vs dY · W_fprop"}
  ],
  "notes": [
    {"at": "f-col", "text": "**69.5 %** of the elements differ", "side": "left"},
    {"at": "f-tile", "text": "one scale per **256** values"}
  ]
}
:::

The cost is a coarser block: one scale for 256 values instead of 16, so a tile holding one large weight
squeezes 255 others. Weights pay it, and the paper notes they tolerate it because training adapts them
to the FP4 grid. Activations and gradients keep 1 × 16 blocks because finer scaling is more accurate and
because, the paper finds, training is less sensitive to their inconsistency. The table is the step-3
ablation: the relative gap between the mean of K dgrad draws and \`dY · W_fwd\`, the true gradient of
what the forward computed, on a layer of the trained toy model.

| recipe | K = 4 | K = 64 | what the gap is |
|---|---|---|---|
| SR + 16 × 16 weights (the paper's) | 0.043 | 0.013 | SR noise, shrinking as 1/√K, plus the saturated maxima |
| round-to-nearest on dY | 0.059 | 0.059 | bias: the same error every draw |
| SR + 1 × 16 weights | 0.091 | 0.081 | the backward multiplies by W_bprop |

:::quiz
Q: Why does the recipe not simply use 16 × 16 blocks for activations and gradients too?
- [ ] The tensor cores cannot read 2-D scales for activations
- [x] Finer 1 × 16 blocks are more accurate, and inconsistency there costs less than for weights
- [ ] Activations are never transposed, so the problem does not arise
> Activations and gradients are transposed too (x and dY both enter wgrad along tokens), so the same
> inconsistency exists. The paper chooses accuracy there: a 1 × 16 block fits a heavy-tailed tensor far
> better than a 16 × 16 tile, and its ablations show training tolerates the activation mismatch better.
:::

# The random Hadamard transform, and what it buys at block size 16

A Sylvester Hadamard matrix doubles from \`[[1]]\` as \`[[H, H], [H, −H]]\`; divided by \`√d\` it is
orthogonal. The recipe multiplies its rows by a random sign vector \`S\`, shared by every layer for the
whole run, and applies \`H = S H₁₆ / 4\` to every 16-wide tile of the last dimension:

\`\`\`text
H Hᵀ = I                              orthogonal
(dYᵀ H)(xᵀ H)ᵀ = dYᵀ H Hᵀ x = dYᵀ x    the wgrad product is unchanged
one outlier o in a 16-tile  →  16 entries of magnitude |o| / 4
\`\`\`

This is the computational invariance [QuaRot](https://arxiv.org/abs/2404.00456) uses to quantize whole
LLMs in 4 bits: rotate both operands of a product, and the product does not change while each operand
becomes easier to quantize. The NVFP4 recipe applies it in tiles of 16, and only to wgrad.

:::widget stochastic-rounding {"mode": "hadamard", "outlier": 12}

What the transform does at block size 16 is narrower than "lower error". The step-2 self-test measures
it on 1,024 × 256 tensors:

| data | crest factor (max / rms) | stored as 0 | relative error |
|---|---|---|---|
| Gaussian, as is | 2.11 | 6.8 % | 0.095 |
| Gaussian, rotated | 2.11 | 6.8 % | 0.095 |
| Student-t(2), as is | 2.73 | 17.3 % | 0.076 |
| Student-t(2), rotated | 1.96 | 5.4 % | 0.097 |

A rotated Gaussian is a Gaussian, so nothing changes. A heavy-tailed block becomes Gaussian-like: its
maximum sits much closer to the rest and three times fewer values flush to 0. The relative error goes
**up**. NVFP4's E4M3 scale already maps a heavy-tailed block's maximum almost exactly onto 6, so the
block's largest value, which carries most of its energy, is stored well; the rotation spreads that
energy over all 16 entries, each rounded on the coarse E2M1 grid. Egiazarian et al.
([2025](https://arxiv.org/abs/2509.23202)) predict and measure this: at NVFP4's group size a Hadamard
transform raises the relative error on Laplace-like data and on real Llama tensors, and only larger
groups, or MXFP4's power-of-two scales, turn it into a gain. The widget's Hadamard tab shows both sides
on one block: the flushed values come back, the error need not fall.

Why keep it, then, and why only on wgrad?

- **Wgrad only.** Both wgrad operands are quantized fresh from activations and gradients, so both can be
  rotated along tokens and the rotation cancels. A weight cannot be rotated without breaking the 2-D
  consistency of the last section, and in the paper's ablations rotating the fprop or dgrad inputs made
  a 1.2B model worse: the paper's guess is that the extra quantization error the rotation adds outweighs
  the outliers it removes, the effect Egiazarian et al. measure.
- **For the sum, not the norm.** Rotating the wgrad inputs lowered the 1.2B model's validation loss, and
  removing it raised the 12B run's loss; the random signs and the matrix size made no measurable
  difference at 1.2B and only mattered at 12B. The paper credits the transform with bounding
  block-level outliers; the evidence is in the training loss, not in a tensor's error norm.

:::quiz
Q: The step-2 test asserts that rotating a Student-t tensor does not lower its NVFP4 relative error. What does the rotation lower?
- [ ] The number of distinct E4M3 scales the tensor needs
- [ ] The relative error of the block maxima
- [x] The crest factor of each block and the share of values stored as 0
> The rotation makes each block Gaussian-like, so its maximum is less extreme relative to the rest
> and far fewer small values fall below 0.25 E2M1 units. The maxima themselves get worse: their
> energy is spread over 16 coarsely rounded entries.
:::

# The toy run, and what it can show

The step-3 model is a 3-block GPT-style LM (\`d = 64\`, 4 heads, vocabulary 64) on a Markov stream whose
tokens have 4 successors each; its entropy is about 1.2 nats. The first two blocks use \`NVFP4Linear\`
for qkv, proj, fc and fc2; the last block, the embeddings, LayerNorms, attention and the head stay in
FP32. Both runs share the init and 200 batches of 8 × 64 tokens.

| run | validation loss |
|---|---|
| FP32 baseline | 1.274 |
| NVFP4, the full recipe | 1.277 |
| NVFP4 without SR | 1.281 |
| NVFP4 without the rotation | 1.276 |
| NVFP4 with 1 × 16 weight blocks | 1.279 |

The full recipe ends 0.003 nats behind FP32, and the self-test asserts less than 0.05. The ablated
runs land within 0.005 nats of each other, which is noise at this scale: 200 steps are too few for a
bias to compound, and the paper separated the techniques with 1.2B and 12B models over 1T to 10T
tokens. That is why
the self-test does not assert on them, and asserts on the gradient bias table above instead, which
measures the mechanism directly and separates the recipes by a factor of four or more.

:::quiz
Q: The toy run shows no loss difference without stochastic rounding. What is the right conclusion?
- [ ] SR is unnecessary; the paper over-engineers the recipe
- [x] 200 steps are too few for a gradient bias to show in the loss; measure the bias itself
- [ ] The bias cancels because the LM is too small to have heavy-tailed gradients
> The bias is there: the mean of 64 RNE dgrad draws misses the true gradient by 5.9 %, every time.
> Whether it moves the loss depends on how long it accumulates; the paper's ablations ran 1.2B and 12B
> models over 1T to 10T tokens.
:::

# What production adds

- **Real FP4 storage.** Two E2M1 codes per byte, the E4M3 scales in a swizzled layout the tensor cores
  read, and a transposed columnwise copy for the GEMMs that need the other axis; Transformer Engine
  supports only the TN layout for NVFP4 GEMMs, so it stores both copies.
- **Hardware rounding and GEMMs.** Blackwell's FP4 conversion instructions support round-to-nearest-even
  and stochastic rounding natively, and its GEMMs read NVFP4 operands and write BF16 or FP32.
- **The global scale's extra pass.** \`s_global\` needs the tensor's amax before any block can be scaled,
  one more read of the tensor; tensors gathered across ranks reduce their amax first so every rank uses
  the same scale.
- **The end of training.** Where a gap to the higher-precision loss remains, switching the last part of
  training (the learning-rate decay) back to BF16 closes it.

:::details Why E4M3 scales need the FP32 one
E4M3 covers 2⁻⁹ to 448, about 18 binades, which is not enough for every block scale of a tensor whose
values span more. \`s_global = amax / (6 · 448)\` moves the largest block scale to exactly 448, so the
others use E4M3's range from the top down; a block whose scale underflows E4M3 decodes to zeros. MXFP4
avoids the second level with E8M0 power-of-two scales, at the cost of a scale that can only move in
factors of 2, so a block maximum generally cannot land exactly on 6.
:::

:::quiz
Q: Why does NVFP4 need a second-level FP32 scale when MXFP4 does not?
- [ ] FP32 is needed to accumulate the GEMM
- [x] An E4M3 block scale has far less range than an E8M0 one, so the tensor is first moved into it
- [ ] The FP32 scale stores the sign of each block
> E8M0 spans 2⁻¹²⁷ to 2¹²⁷, enough for any block scale; E4M3 spans about 18 binades. The per-tensor FP32
> scale puts the largest block scale at 448 and the rest below it.
:::

# What to take away

- Training quantizes every operand of three GEMMs per layer, each along its own reduction dimension, and
  sums the results over thousands of steps: bias matters more than per-value error.
- Stochastic rounding is unbiased and noisier; the recipe uses it on gradients only.
- 16 × 16 weight tiles make the forward's and the backward's weight one matrix, so the backward
  differentiates the forward.
- The random Hadamard transform goes on both wgrad inputs only; at block size 16 it lowers the crest
  factor and the flush-to-zero rate, not the relative error.
- At toy scale the loss cannot separate the techniques; the gradient bias can.

Primary source: [Pretraining Large Language Models with NVFP4](https://arxiv.org/abs/2509.25149) (NVIDIA,
2025), with the [Transformer Engine](https://github.com/NVIDIA/TransformerEngine) implementation.
`;
