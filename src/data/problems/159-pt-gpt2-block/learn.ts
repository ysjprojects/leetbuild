/**
 * The learning guide for the GPT-2 block drill: the residual stream and why the LayerNorm moved in
 * front of each sublayer, the 4× GELU MLP and the tanh formula every GPT-2 checkpoint is trained on,
 * the N(0, 0.02) init and the 1/√(2·n_layer) rule for the two projections that write into the stream,
 * where a block's parameters and FLOPs go, and what frameworks fuse. Rendered at `/pt-gpt2-block/learn`.
 */
export const learn = `# The mechanism at a glance

A GPT is a token embedding, \`n_layer\` identical **blocks**, a final LayerNorm and an unembedding. The
block is where the model computes: it reads the context with causal self-attention, then transforms each
position on its own with a two-layer MLP, and adds each result to a running vector per position: the
**residual stream**. GPT-2 (Radford et al., 2019) put the LayerNorm *before* each sublayer, the form later
decoder-only models kept, and paired it with a hidden layer four times the model width, GELU, and an
initialisation that shrinks the two matrices that write into the stream.

:::architecture
{
  "input": "x · (B, T, 768) from the block below",
  "output": "x · (B, T, 768) to the next block",
  "items": [
    {"id": "x", "label": "Residual stream", "kind": "io", "sub": "one vector per position", "shape": "[B, T, 768]", "detail": "Only ever added to, from the embedding to the final ln_f."},
    {"tone": "block", "repeat": "12 ×", "label": "GPT-2 small block", "items": [
      {"id": "ln1", "label": "LayerNorm ln_1", "kind": "norm", "sub": "768 · weight 1, bias 0", "detail": "A normalised copy for the attention to read; the stream is not touched."},
      {"id": "attn", "label": "Causal self-attention", "kind": "attention", "sub": "12 heads × 64", "shape": "[B, T, 768]", "side": {"label": "tril mask", "sub": "1,024 × 1,024"}, "detail": "Reads the context: position t mixes the values of positions 0..t. Given in the drill; its own problem."},
      {"id": "add1", "op": "+", "from": "ln1", "detail": "x = x + attn(ln_1(x))"},
      {"id": "ln2", "label": "LayerNorm ln_2", "kind": "norm", "sub": "768 · weight 1, bias 0"},
      {"id": "mlp", "label": "MLP", "kind": "ffn", "sub": "768 → 3,072 → 768", "shape": "[B, T, 768]", "detail": "Transforms every position on its own, with the same weights everywhere."},
      {"id": "add2", "op": "+", "from": "ln2", "detail": "x = x + mlp(ln_2(x))"}
    ]}
  ],
  "notes": [
    {"at": "attn", "text": "c_attn **768 → 2,304**, c_proj **768 → 768**"},
    {"at": "mlp", "text": "**4.72 M** of the block's **7.09 M** parameters", "side": "left"},
    {"at": "add2", "text": "Both c_proj write at std **0.02/√24**", "side": "left"}
  ],
  "insets": [
    {"for": "mlp", "title": "MLP", "items": [
      {"id": "c-fc", "label": "Linear c_fc", "sub": "768 → 3,072", "shape": "[B, T, 3,072]"},
      {"id": "gelu", "label": "gelu_tanh", "sub": "tanh(√(2/π)(x + 0.044715x³))"},
      {"id": "c-proj", "label": "Linear c_proj", "sub": "3,072 → 768"},
      {"id": "drop", "label": "Dropout", "sub": "p = cfg.dropout, 0 here"}
    ], "note": "Hidden width **4 × 768 = 3,072**"}
  ]
}
:::

The figure is GPT-2 small (\`n_embd = 768\`); the drill builds the same block at \`n_embd = 64\`. Attention
is the only sublayer in which positions exchange information, and its causal mask limits every query row
to the past:

:::widget attention-heatmap {"causal": true}

The contract the drill implements, over a \`GPTConfig(n_embd, n_head, n_layer, block_size, dropout)\`:

- \`gelu_tanh(x)\` = \`0.5 · x · (1 + tanh(√(2/π) · (x + 0.044715 · x³)))\`, element-wise.
- \`MLP\`: \`c_fc: Linear(C, 4C)\` → \`gelu_tanh\` → \`c_proj: Linear(4C, C)\` → \`dropout\`.
- \`Block.forward(x)\`: \`x = x + attn(ln_1(x))\`; \`x = x + mlp(ln_2(x))\`. Shape \`(B, T, C)\` in and out.
- \`Block.__init__\`: \`self.apply(_init_weights)\` (linears \`N(0, 0.02)\`, biases \`0\`, LayerNorm weight \`1\`,
  bias \`0\`), then every \`c_proj.weight\` re-drawn at \`std = 0.02 / √(2 · n_layer)\`.

# The residual stream and why the LayerNorm moved

The original Transformer wrote a sublayer as \`x = LayerNorm(x + f(x))\`: **post-LN**. GPT-2 writes
\`x = x + f(LayerNorm(x))\`: **pre-LN**. The difference is where the stream is standardised, and it
decides whether a deep stack trains without a learning-rate warm-up.

A refresher: \`LayerNorm\` works on each position's \`C\`-vector on its own. It subtracts the vector's mean,
divides by \`√(var + ε)\` (biased variance, \`ε = 1e-5\` in \`nn.LayerNorm\`), then applies a learned
per-feature scale \`γ\` (\`weight\`) and shift \`β\` (\`bias\`). Whatever the input's scale, the output at init
has mean 0 and variance 1 across the features.

Drawn the same way, bottom to top, the two forms differ only in where the LayerNorm sits on the path.
**Post-LN**, the original Transformer: the norm is on the stream itself, after the add.

:::architecture
{
  "input": "x",
  "output": "LN(x + f(x))",
  "items": [
    {"id": "f", "label": "Sublayer f", "kind": "attention", "sub": "attention or MLP"},
    {"id": "add", "op": "+", "from": "f", "detail": "The residual: x is added back to f(x)."},
    {"id": "ln", "label": "LayerNorm", "kind": "norm", "sub": "on the sum: the stream itself", "detail": "Every block re-standardises the stream, so the identity path runs through a LayerNorm Jacobian."}
  ],
  "notes": [{"at": "ln", "text": "Rescales the stream **every** block"}]
}
:::

**Pre-LN**, GPT-2 and its descendants: the norm feeds only the sublayer, and the stream passes through
the ⊕ untouched.

:::architecture
{
  "input": "x",
  "output": "x + f(LN(x))",
  "items": [
    {"id": "ln", "label": "LayerNorm", "kind": "norm", "sub": "on a copy, for f only", "detail": "ln_1 or ln_2: a temporary the sublayer reads."},
    {"id": "f", "label": "Sublayer f", "kind": "attention", "sub": "attention or MLP"},
    {"id": "add", "op": "+", "from": "ln", "detail": "The residual wire leaves below the LayerNorm: the raw x is what gets added to."}
  ],
  "notes": [{"at": "add", "text": "Exactly **x** when f writes zero"}]
}
:::

- **The stream is never rescaled.** From the embedding to the final \`ln_f\`, \`x\` is only ever *added to*.
  A block whose two \`c_proj\` are zero is the exact identity (the drill's self-test asserts
  \`torch.equal(blk(x), x)\` after zeroing them), and a block with small \`c_proj\` is a small perturbation
  of the identity.
- **Gradients have a clean path.** \`∂x_out/∂x_in = I + ∂f/∂x\`: whatever the sublayers do, the identity term
  carries the gradient straight through all \`n_layer\` blocks. With post-LN, the LayerNorm sits *on* the
  path and its Jacobian at init scales the gradient by something depth-dependent; Xiong et al. show the
  expected gradient at the last layers is large and at the first layers small, which is what the warm-up
  in the original recipe was papering over.
- **The normaliser only feeds the sublayer.** \`ln_1(x)\` is a temporary; attention reads it, and the result
  is added to the original \`x\`. Writing \`x = ln_1(x)\` first and then adding is a different (and worse)
  network: it throws away the stream's scale every block.

| | Post-LN (Vaswani 2017) | Pre-LN (GPT-2, Llama, …) |
| --- | --- | --- |
| Sublayer | \`x = LN(x + f(x))\` | \`x = x + f(LN(x))\` |
| Stream after a block | unit variance, by construction | grows with depth, by \`2·n_layer\` small writes |
| Identity at init? | no: \`LN\` rescales even when \`f = 0\` | yes, when \`c_proj = 0\` |
| Needs warm-up? | yes | not for stability; often kept anyway |
| Final norm | none needed | \`ln_f\` before the unembedding |

:::quiz
Q: Which line is GPT-2's attention sublayer?
- [ ] x = self.ln_1(x + self.attn(x))
- [x] x = x + self.attn(self.ln_1(x))
- [ ] x = self.attn(self.ln_1(x))
> Pre-LN normalises the sublayer's input and adds the result to the raw stream. The first option is post-LN (the stream is re-standardised after every block); the third has no residual at all, and a 12-layer stack of it would not train.
:::

:::quiz
Q: Both c_proj matrices of a block are zeroed (biases too). What does Block.forward return?
- [x] Exactly x: attention and the MLP each add zero
- [ ] ln_2(x): the last LayerNorm still runs
- [ ] A tensor of zeros
> Each sublayer's output passes through its c_proj, so a zero c_proj makes the sublayer write zero into the stream. The LayerNorms only feed the sublayers; they do not touch the stream. The block is the identity, bit for bit.
:::

# The MLP: four times wider, GELU with a tanh

Attention moves information *between* positions; the MLP transforms each position *on its own*, and the
same weights serve every position and every sequence. Its shape is two linears around a nonlinearity:

| Stage | Shape in → out | Parameters at \`C = 768\` |
| --- | --- | --- |
| \`c_fc\` | \`(B, T, C)\` → \`(B, T, 4C)\` | \`768 × 3072 + 3072\` ≈ 2.36 M |
| \`gelu_tanh\` | element-wise | 0 |
| \`c_proj\` | \`(B, T, 4C)\` → \`(B, T, C)\` | \`3072 × 768 + 768\` ≈ 2.36 M |
| \`dropout\` | element-wise, identity in \`eval()\` | 0 |

The \`4×\` is a convention from the original Transformer that GPT-2 kept; later models vary it (Llama uses
a gated MLP at about \`8/3×\`), but the structure (expand, activate, contract, add) is the same.

The activation is [GELU](https://arxiv.org/abs/1606.08415), \`x · Φ(x)\` with \`Φ\` the Gaussian CDF. GPT-2's
TensorFlow code shipped the **tanh approximation**, which that paper offers as the faster form, and every
GPT-2 checkpoint has been trained on it:

\`\`\`python
def gelu_tanh(x):
    return 0.5 * x * (1.0 + torch.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * torch.pow(x, 3.0))))
\`\`\`

- The two formulas differ by at most \`4.7e-4\`, near \`|x| ≈ 2.7\`. nanoGPT runs the OpenAI weights under
  exact \`nn.GELU()\` anyway and its outputs shift slightly; to reproduce a checkpoint, use the formula it was
  trained with (Hugging Face calls it \`gelu_new\`). PyTorch exposes the choice as
  \`F.gelu(x, approximate="tanh")\`, which is the drill's reference, to \`1e-12\` in float64.
- GELU is smooth (ReLU has a kink at 0), so \`gradcheck\` in float64 passes cleanly with finite differences
  of \`1e-6\`: the drill runs it on an 8-wide \`MLP\`.
- Dropout is the last thing in the MLP, on the vector that joins the residual stream. Hugging Face's
  \`GPT2Config\` defaults it to \`0.1\`; nanoGPT pretrains with \`0\`. In \`eval()\` the module is the identity,
  which is why the self-test's reference needs no dropout term.

:::quiz
Q: A GPT-2 checkpoint is evaluated with exact F.gelu(x) instead of the tanh formula it was trained with. What happens?
- [ ] Nothing: the two are the same function
- [x] Each activation moves by at most about 5e-4, so the outputs shift slightly away from the checkpoint's own
- [ ] The model breaks, because exact GELU is unbounded below
> The tanh form approximates x·Φ(x) to within 4.7e-4, so a model run with the other one still works (nanoGPT does exactly this) but no longer reproduces the reference outputs. Both forms are bounded below at about -0.17.
:::

# Initialisation and the 1/√(2·n_layer) rule

PyTorch's \`nn.Linear\` initialises itself Kaiming-uniform, which is not what GPT-2 is trained with. GPT-2's
rule set is short, and the drill applies it from \`Block.__init__\`:

| Parameter | Init | Why |
| --- | --- | --- |
| every \`Linear.weight\` | \`N(0, 0.02)\` | small weights: each sublayer starts as a small perturbation |
| every \`Linear.bias\` | \`0\` | no offset before anything is learned |
| \`LayerNorm.weight\`, \`.bias\` | \`1\`, \`0\` | the normaliser starts as plain standardisation |
| \`attn.c_proj.weight\`, \`mlp.c_proj.weight\` | \`N(0, 0.02 / √(2·n_layer))\` | the two writes into the residual stream, per block |

\`\`\`python
self.apply(self._init_weights)                 # visits every submodule, Linear and LayerNorm alike
for name, p in self.named_parameters():        # then, and only then, the residual projections
    if name.endswith("c_proj.weight"):
        nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layer))
\`\`\`

The order matters: \`apply\` sets every linear to \`0.02\`, so the \`c_proj\` loop must come after it or it is
overwritten. The rule itself is about variance. Each \`c_proj\` output is a sum over its fan-in of
weight × activation; with the sublayer's input standardised by its LayerNorm, each write into the stream
adds roughly the same variance \`v\`, whatever the stream's scale. The writes are independent at init, so
their variances add: after \`L\` blocks they contribute \`2L·v\` unscaled, \`2L·v / (2·n_layer)\` with the rule.
A worked example at GPT-2 XL's depth (\`n_layer = 48\`, so \`2·n_layer = 96\`), with the measured std of the
stream through 48 of the drill's blocks at \`n_embd = 256\`, fed an input of std \`0.028\` (two \`N(0, 0.02)\`
embeddings summed, as nanoGPT initialises them):

| Stream after | Writes | Variance added, unscaled | Variance added, std ÷ √96 | Std, unscaled | Std, scaled |
| --- | --- | --- | --- | --- | --- |
| the input | 0 | 0 | 0 | 0.028 | 0.028 |
| block 1 | 2 | 2v | v/48 | 0.117 | 0.031 |
| block 12 | 24 | 24v | v/4 | 0.456 | 0.050 |
| block 24 | 48 | 48v | v/2 | 0.658 | 0.065 |
| block 48 | 96 | 96v | v | 0.940 | 0.090 |

- Unscaled, the stream's std grows like \`√L\`: block 48 is 8× block 1, near the \`√48 ≈ 6.9\` the sum predicts.
  Scaling a weight's standard deviation by \`1/√(2·n_layer)\` divides each write's variance by \`2·n_layer\`,
  so the sum of all writes stays at about \`v\` whatever the depth. At the top of the stack the two columns
  differ by \`10.4×\`, close to \`√96 ≈ 9.8\`, before the first gradient step, and the final \`ln_f\` would have
  to undo it.
- Only the two \`c_proj\` get the rule. \`c_attn\` and \`c_fc\` feed a sublayer from a normalised input; their
  outputs never touch the stream directly.
- Zero is the limit of this idea: initialise \`c_proj\` at \`0\` and every block starts as the exact identity.
  Several later recipes do that; a small non-zero draw also gives \`c_fc\` a gradient at step 0, which a zero
  \`c_proj\` would block.
- The drill checks the statistics on a 256-wide block: the linears' sample std within 5 % of \`0.02\`, the
  \`c_proj\`s within 5 % of \`0.02/√24 ≈ 0.0041\`, biases exactly zero, LayerNorms exactly one.

:::quiz
Q: The c_proj rescale loop is moved to before self.apply(self._init_weights). What changes?
- [ ] Nothing: named_parameters() and apply() touch different tensors
- [x] apply() redraws every Linear at std 0.02, so the c_proj end up unscaled and the stream's variance grows with depth
- [ ] The LayerNorms are skipped, because apply() stops at the first module it has already seen
> apply() visits every submodule including the two c_proj, and _init_weights sets any nn.Linear to N(0, 0.02). Run after the loop, it overwrites the scaled draw. The drill's "c_proj std" assertion is exactly this mistake.
:::

# Where the parameters and the FLOPs go

GPT-2 small is \`n_embd = 768\`, \`n_head = 12\`, \`n_layer = 12\`, context \`1024\`. One block:

| Module | Weight shape | Parameters |
| --- | --- | --- |
| \`attn.c_attn\` | \`768 × 2304\` (+ bias) | 1 771 776 |
| \`attn.c_proj\` | \`768 × 768\` (+ bias) | 590 592 |
| \`mlp.c_fc\` | \`768 × 3072\` (+ bias) | 2 362 368 |
| \`mlp.c_proj\` | \`3072 × 768\` (+ bias) | 2 360 064 |
| \`ln_1\`, \`ln_2\` | \`768\` each, weight and bias | 3 072 |
| **block** | | **7 087 872** |

Twelve blocks are 85.1 M parameters; the token embedding (\`50257 × 768\`), the position embedding
(\`1024 × 768\`) and \`ln_f\` bring the model to 124.4 M: the "124M" of the GPT-2 family (the paper's Table 2
says 117M). Two thirds of a block is the MLP, and the forward FLOPs follow the parameters: about
\`2 × 7.09 M ≈ 14 MFLOPs\` per token per block in the linears, plus \`4 · T · C\` per token for the attention
scores and their product with \`v\`: \`3.1 MFLOPs\` at the full \`T = 1024\`, less at short contexts. The
\`(B, T, 4C)\` hidden activation is the largest tensor the MLP creates: at \`B = 8\`, \`T = 1024\` it is 100 MB
in float32, kept for the backward pass. The given attention's \`(B, H, T, T)\` scores are four times that
(403 MB), which is what FlashAttention removes.

The same arithmetic for any width, depth and vocabulary, with the weight and KV-cache memory it implies:

:::widget model-size {"preset": "gpt2"}

:::details The same block in the OpenAI and Hugging Face checkpoints
Both keep this file's names (\`ln_1\`, \`attn.c_attn\`, \`attn.c_proj\`, \`ln_2\`, \`mlp.c_fc\`, \`mlp.c_proj\`) but
store the linears as a \`Conv1D\` whose weight is \`(in, out)\`, the transpose of \`nn.Linear\`'s \`(out, in)\`.
Loading an official checkpoint into \`nn.Linear\` modules is therefore a \`state_dict\` copy with a \`.t()\` on
each of the four matrices and none on the biases or the LayerNorms. The names are also why the drill's
rescale loop keys on \`endswith("c_proj.weight")\`: it finds the attention's and the MLP's projection with one
test.
:::

:::quiz
Q: In a GPT-2 block, where do most of the parameters sit?
- [ ] In attention: four matrices against the MLP's two
- [x] In the MLP: its two 768 × 3072 matrices are two thirds of the block
- [ ] Split evenly; the 4× expansion and the 3× q/k/v projection cancel out
> c_fc and c_proj are 768 × 3072 each (4.72 M together); c_attn is 768 × 2304 and the attention c_proj 768 × 768 (2.36 M together). The MLP is where the parameters (and the matmul FLOPs) are.
:::

# What production systems add

The drill's block is the reference semantics; a training or serving stack keeps the math and changes the
execution.

- **Fusion.** \`torch.compile\` fuses each LayerNorm into one kernel, and the bias, the tanh and its
  multiplies into one pointwise pass after the \`c_fc\` GEMM (into the GEMM's epilogue under
  \`mode="max-autotune"\`), so the GELU's intermediates never round-trip through HBM on their own.
- **Attention.** \`F.scaled_dot_product_attention\` picks FlashAttention-2 or a memory-efficient kernel,
  which never materialises the \`(B, H, T, T)\` score tensor the given \`CausalSelfAttention\` builds. The
  drill's reference uses it with \`is_causal=True\`.
- **Tensor parallelism.** Megatron-LM splits \`c_fc\` by columns and \`c_proj\` by rows across GPUs: each
  device holds a slice of the \`4C\` hidden layer, computes its partial \`c_proj\` product, and one
  all-reduce per MLP (and one per attention) restores the stream. The \`(B, T, 4C)\` tensor never exists on
  one device.
- **Precision.** The matmuls run in bfloat16 under autocast; LayerNorm and the residual add stay in
  float32, because the stream is a sum that must not lose low bits as it grows.
- **The block as a unit.** Activation checkpointing recomputes a whole block in the backward pass rather
  than storing its \`(B, T, 4C)\` hidden; pipeline parallelism assigns contiguous blocks to devices. Both
  rely on the block being a pure function of \`x\` and its parameters, which the pre-LN residual form is.

:::quiz
Q: Megatron-LM splits c_fc by columns and c_proj by rows across GPUs. Why that pairing?
- [x] Each device holds whole hidden units, applies the GELU locally, and produces a partial c_proj sum: one all-reduce per MLP
- [ ] It halves the MLP's parameter count
- [ ] Rows and columns are interchangeable; the pairing is a naming convention
> GELU is element-wise, so a column split of c_fc gives every device complete hidden activations to apply it to, with no communication. A row split of c_proj then makes each device's output a partial sum, and one all-reduce adds them. Splitting c_fc by rows would need an all-reduce before the GELU, since GELU(a + b) ≠ GELU(a) + GELU(b).
:::

# What to take away

- **A block is the identity plus two corrections.** \`x + attn(ln_1(x))\`, then \`+ mlp(ln_2(x))\`; with both
  \`c_proj\` zero it is exactly \`x\`.
- **Pre-LN normalises the sublayer's input, not the stream.** The stream is only ever added to; the
  gradient's identity path through every block is what lets deep stacks train without the warm-up post-LN
  depends on.
- **The MLP is two linears, 4× wide, around the tanh GELU.** \`c_fc\` → \`0.5·x·(1 + tanh(√(2/π)·(x + 0.044715·x³)))\`
  → \`c_proj\` → dropout; it is two thirds of the block's parameters and matmul FLOPs.
- **Init is N(0, 0.02), zero biases, unit LayerNorms, and then scale the writers.** Every \`c_proj.weight\`
  at \`0.02/√(2·n_layer)\`, after \`apply\`, so \`2·n_layer\` writes add about one write's variance \`v\` instead
  of \`2·n_layer · v\`.
- **Frameworks keep the math and fuse the rest:** \`torch.compile\` epilogues, FlashAttention, tensor-parallel
  column/row splits, bf16 matmuls with a float32 stream.

The primary reference is the GPT-2 paper,
[*Language Models are Unsupervised Multitask Learners*](https://cdn.openai.com/better-language-models/language_models_are_unsupervised_multitask_learners.pdf)
(Radford et al., 2019), whose block this is; Xiong et al.'s
[*On Layer Normalization in the Transformer Architecture*](https://arxiv.org/abs/2002.04745) is the pre-LN
argument, [nanoGPT's \`model.py\`](https://github.com/karpathy/nanoGPT/blob/master/model.py) the cleanest
PyTorch rendering of the same block and init, and the
[\`nn.LayerNorm\`](https://pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html) page the normaliser's
exact definition.
`;
