/**
 * The learning guide for the stable-softmax drill: the terms, why the textbook formula overflows and
 * why subtracting the max costs nothing (derived step by step, worked by hand), log-sum-exp as the one
 * primitive the other two derive from, cross-entropy as a gather rather than a one-hot, what label
 * smoothing and ignore_index change, the common mistakes, and what fused, online and chunked kernels
 * add. A figure, a table or a formula where one says it faster than prose, a pop quiz per section.
 * Rendered at `/pt-stable-softmax/learn`.
 */
export const learn = `# The mechanism at a glance

A language model's last layer outputs one raw score per vocabulary entry for the next token. These
scores are **logits**: any real numbers, positive or negative, not yet probabilities. **Softmax** turns a
row of logits into a probability distribution (every entry in \`(0, 1)\`, the row summing to \`1\`), and
**cross-entropy** scores that distribution against the right answer: it is \`-log p\` of the correct class,
\`0\` when the model gave it probability \`1\` and large when it gave it almost nothing.

A transformer runs softmax in every attention head over the \`(seq, seq)\` attention scores, and softmax
with cross-entropy over the output head's \`(tokens, vocab)\` logits, where the mean \`-log p\` of the next
token is the pre-training loss. The output-head version is the one the drill models: a row is as wide as
the vocabulary, 32k to 150k entries. Read the figure bottom to top: one \`log_softmax\` feeds both outputs.

:::architecture
{
  "input": "logits x · (N, C) · one row near 1e4",
  "items": [
    {"id": "logits", "label": "Logits", "sub": "(N, C) · float32 or float64", "kind": "io", "shape": "[N, C]"},
    {"tone": "dotted", "label": "log_softmax(x, dim=-1)", "items": [
      {"id": "shift", "label": "Subtract the row max", "sub": "s = x − m ≤ 0", "shape": "[N, C]",
       "side": {"label": "Row max m", "sub": "x.amax(-1, keepdim)", "detail": "Shape (N, 1), broadcast back over the row; its gradient cancels, so it may be detached."},
       "detail": "A shared shift leaves the ratio of exponentials unchanged and makes the largest exponent exactly 0."},
      {"id": "exp", "label": "Exponentiate", "sub": "exp(s) ∈ (0, 1]", "detail": "Nothing can overflow; terms far below the max underflow to 0, the nearest float to their true probability."},
      {"id": "sum", "label": "Sum over the row", "sub": "Σ exp(s) ∈ [1, C]", "shape": "[N, 1]", "detail": "The max term is exactly 1, so the sum is never 0."},
      {"id": "log", "label": "Log, negated", "sub": "−log Σ exp(s) ∈ [−log C, 0]"},
      {"id": "logp", "op": "+", "from": "exp", "detail": "log p = s − log Σ exp(s): the shifted row comes around and the log-sum-exp is subtracted."}
    ]},
    {"columns": [
      [{"id": "softmax", "label": "softmax", "sub": "p = exp(log p)", "kind": "io", "shape": "[N, C]", "detail": "One more exp over the log-probabilities, never a second formula."}],
      [
        {"columns": [
          [{"id": "gather", "label": "Gather the target", "sub": "(1 − ε) · −logp[t]", "shape": "[N]", "detail": "logp.gather(1, t.unsqueeze(1)): one entry per row, no one-hot."}],
          [{"id": "smooth", "label": "Uniform term", "sub": "ε · −logp.mean(-1)", "shape": "[N]", "detail": "Label smoothing's share: ε times minus the row mean of logp."}]
        ]},
        {"id": "mix", "op": "+", "detail": "(1 − ε) · nll + ε · smooth, per row."},
        {"id": "mask", "label": "Mask ignored rows", "sub": "loss = 0 where target is −100", "detail": "Applied after the mixture: an ignored row contributes neither term."},
        {"id": "loss", "label": "cross_entropy", "sub": "Σ loss / count of kept rows", "kind": "loss", "shape": "scalar", "detail": "reduction=\\"mean\\" with ignored targets: divide by the kept rows, not N."}
      ]
    ]}
  ],
  "notes": [
    {"at": "shift", "text": "exp(1e4) is **inf**; exp(x − m) is at most **1**"},
    {"at": "sum", "text": "Never **0**, so its log is finite"},
    {"at": "logp", "text": "**log p**: the one (N, C) tensor, no one-hot"},
    {"at": "mix", "text": "Label smoothing is **a target**, not a new loss"},
    {"at": "loss", "text": "Divide by **kept rows**, not N"}
  ]
}
:::

The words the guide uses, each defined again where it first matters:

| Term | Meaning |
| --- | --- |
| \`N\`, \`C\` | rows (tokens) and columns (classes, the vocabulary) of the logit tensor |
| log-probability | \`log p\`, always \`≤ 0\`; the loss is built from these, not from \`p\` |
| log-sum-exp (\`lse\`) | \`log Σ_j exp(x_j)\`, the normaliser of softmax in log space |
| overflow · underflow | a result too large for the dtype becomes \`inf\`; one too close to \`0\` becomes \`0\` |
| \`nan\` | "not a number": the result of \`inf / inf\` or \`inf − inf\`, and it spreads through every later op |
| label smoothing (\`ε\`) | training against a target that puts \`1 − ε\` on the answer and \`ε\` spread over all classes |
| \`ignore_index\` | a target value (\`-100\`) meaning "this row is padding: leave it out of the loss" |

The contract the drill implements, with plain tensor ops and none of \`torch.nn.functional\`'s versions:

- \`log_softmax(x, dim=-1)\` → \`x - m - log(Σ exp(x - m))\` with \`m = x.amax(dim, keepdim=True)\`; any
  shape, any \`dim\`, float32 or float64 in and the same dtype out.
- \`softmax(x, dim=-1)\` → \`log_softmax(x, dim).exp()\`.
- \`cross_entropy(logits, targets, label_smoothing=0.0, ignore_index=-100)\` → for \`logits\` \`(N, C)\` and
  \`targets\` \`(N,)\` int64, the mean over rows whose target is not \`ignore_index\` of
  \`(1 - ε) · (-logp[target]) + ε · (-mean_c logp[c])\`.
- Agreement with \`F.log_softmax\`, \`F.softmax\` and \`F.cross_entropy\` to \`1e-5\` in float32 and \`1e-10\` in
  float64 on a batch with a row near \`1e4\`, and \`torch.autograd.gradcheck\` in float64.

# Where exp overflows, and why the shift is free

The textbook formula is a ratio of exponentials:

\`\`\`text
p_i = exp(x_i) / Σ_j exp(x_j)
\`\`\`

A float has a largest finite value. When \`exp(x)\` would exceed it, the result **overflows** to \`inf\`, and
logits cross that line long before they look unusual:

| dtype | largest finite | \`exp(x)\` overflows at | mantissa |
| --- | --- | --- | --- |
| float16 | 65 504 | \`x > 11.09\` | 10 bits |
| bfloat16 | 3.39 × 10³⁸ | \`x > 88.72\` | 7 bits |
| float32 | 3.40 × 10³⁸ | \`x > 88.72\` | 23 bits |
| float64 | 1.80 × 10³⁰⁸ | \`x > 709.78\` | 52 bits |

A row of logits around \`1e4\` (a scale a linear head produces on an unnormalised activation, or a
temperature of \`0.01\` on scores of order \`100\`) exponentiates to \`inf\` in every entry, and \`inf / inf\`
is \`nan\`. The loss is \`nan\`, the gradient is \`nan\`, and after one optimizer step every parameter is
\`nan\`:

:::architecture
{
  "input": "x = [1e4, 1e4 + 1, 1e4 − 3] · float32",
  "output": "loss nan, gradient nan",
  "items": [
    {"id": "n-exp", "label": "exp(x)", "sub": "[inf, inf, inf]", "detail": "Every entry is above 88.72, where float32's exp overflows."},
    {"id": "n-sum", "label": "Sum over the row", "sub": "inf"},
    {"id": "n-div", "label": "Divide", "sub": "[inf, inf, inf] / inf"},
    {"id": "n-p", "label": "Probabilities", "sub": "[nan, nan, nan]", "kind": "loss", "detail": "inf / inf is nan; the backward pass is nan too, and one optimizer step spreads it to every parameter."}
  ],
  "notes": [
    {"at": "n-exp", "text": "**1e4 > 88.72**: every term overflows"},
    {"at": "n-p", "text": "**inf / inf = nan**, forward and backward"}
  ]
}
:::

The fix rests on one identity. Pick any constant \`m\` and follow three steps:

\`\`\`text
1.  exp(x_i − m)      = exp(x_i) · exp(−m)                exp of a difference is a product
2.  Σ_j exp(x_j − m)  = exp(−m) · Σ_j exp(x_j)            the constant factor leaves the sum
3.  exp(x_i − m) / Σ_j exp(x_j − m)
                      = exp(x_i) · exp(−m) / (exp(−m) · Σ_j exp(x_j))
                      = exp(x_i) / Σ_j exp(x_j)  =  p_i   exp(−m) cancels
\`\`\`

Subtracting the same number from every logit in a row leaves softmax unchanged. Choose \`m = max_j x_j\`:

- Every exponent \`x_i − m\` is now \`≤ 0\`, so every \`exp\` is in \`(0, 1]\`: nothing can overflow.
- The largest term is exactly \`exp(0) = 1\`, so the sum is in \`[1, C]\`: it cannot be \`0\`, and its log is
  in \`[0, log C]\`.

In PyTorch, \`m = x.amax(dim=-1, keepdim=True)\`. \`amax\` returns the maximum along \`dim\` (unlike
\`x.max(dim)\`, it returns no indices). \`keepdim=True\` keeps that dimension with size \`1\`, so \`m\` is
\`(N, 1)\` rather than \`(N,)\`, and \`x - m\` **broadcasts**: PyTorch repeats the single column across the
\`C\` columns, subtracting each row's own max from that row.

Worked by hand on the row above, in float32:

| Step | Arithmetic | Value |
| --- | --- | --- |
| 1. row max | \`max(1e4, 1e4 + 1, 1e4 − 3)\` | \`m = 1e4 + 1\` |
| 2. shift | \`x − m\` | \`s = [−1, 0, −4]\`, all \`≤ 0\` |
| 3. exponentiate | \`exp(−1), exp(0), exp(−4)\` | \`[0.368, 1, 0.018]\` |
| 4. sum | \`0.368 + 1 + 0.018\` | \`1.386\` |
| 5. log of the sum | \`log 1.386\` | \`0.327\` |
| 6. log-probabilities | \`s − 0.327\` | \`[−1.327, −0.327, −4.327]\`, finite |
| 7. probabilities | \`exp\` of step 6 | \`[0.265, 0.721, 0.013]\`, sums to \`1\` |

The widget starts on four logits near \`1e4\`: every naive bar is NaN, the shifted bars are finite and sum
to \`1\`. Switch to small logits and the two agree; the temperature and \`ε\` sliders move the distribution,
the smoothed target and the cross-entropy.

:::widget softmax-stability {"preset": "huge"}

- The shift is **free**: one reduction and one broadcast subtract per row, next to an \`exp\` and a
  \`sum\` that were needed anyway. Fused kernels do it in the same launch.
- The max is a **constant for the gradient**. Differentiate \`x_i − m − log Σ_j exp(x_j − m)\` with
  respect to \`m\`: the first \`−m\` gives \`−1\`, the log-sum-exp gives \`+Σ_j p_j = +1\`, total \`0\`.
  Detaching it (\`x.amax(...).detach()\`) changes nothing numerically and saves autograd a node;
  \`gradcheck\` passes either way.
- A logit at \`-1e4\` in a row near \`0\` **underflows** to probability exactly \`0\` after the shift. The
  true value, \`e^(−1e4)\`, is far below the smallest float, so \`0\` is the nearest representable answer,
  and its log-probability (\`-1e4 - lse\`) is still a finite number, which is the next section's point.

:::quiz
Q: Logits are [1e4, 1e4 + 1, 1e4 − 3] in float32. Which formulation gives finite probabilities?
- [ ] Neither; values that large need float64
- [x] exp(x − max) / Σ exp(x − max): the exponents become [−1, 0, −4]
- [ ] exp(x) / Σ exp(x), as long as the sum is computed in float64
> The ratio is invariant under a shared shift, so subtracting the max puts every exponent at or below 0. float64 only moves the cliff from 88.7 to 709.8; 1e4 is beyond both, and a float64 sum of float32 infinities is still inf.
:::

# log-sum-exp first; softmax and the loss follow

Take the log of the shifted softmax and simplify, one rule per line:

\`\`\`text
log p_i = log( exp(x_i − m) / Σ_j exp(x_j − m) )
        = log exp(x_i − m) − log Σ_j exp(x_j − m)    log of a quotient is a difference
        = (x_i − m)        − log Σ_j exp(x_j − m)    log undoes exp
\`\`\`

The quantity \`lse(x) = m + log Σ_j exp(x_j − m)\` is the
[log-sum-exp](https://gregorygundersen.com/blog/2020/02/09/log-sum-exp/), \`log Σ_j exp(x_j)\` computed
without overflow. It is a smooth maximum: at least \`max x\` and at most \`max x + log C\`. Everything else
is a line of arithmetic on it:

\`\`\`text
log_softmax(x)_i = x_i − lse(x)
softmax(x)_i     = exp(log_softmax(x)_i)
cross_entropy    = −log_softmax(x)_target
\`\`\`

Making \`log_softmax\` the primitive, rather than \`softmax\`, is not taste. \`log(softmax(x))\` loses
precision when a probability is tiny, and the loss is a log-probability:

| Row | \`F.log_softmax\` | \`log(F.softmax)\` in float32 | What happened |
| --- | --- | --- | --- |
| \`[0, 100]\` | \`[−100, 0]\` | \`[−99.983, 0]\` | \`exp(−100) ≈ 3.7e−44\` is a denormal (a float below the normal range, with few significant bits); its log is off by \`0.017\`, and the backward's \`1 / p\` overflows, so the gradient is \`nan\` |
| \`[0, 200]\` | \`[−200, 0]\` | \`[−inf, 0]\` | \`exp(−200)\` underflows to \`0\`; \`log 0 = −inf\`, and the gradient is \`nan\` |
| \`[3, 1, 0, 0, 0]\` | \`[−0.2505, −2.2505, −3.2505, …]\` | same | nothing extreme: the two agree |

- The log-probability of an unlikely class is a moderate negative number (\`−200\`) that float32 holds
  with full precision; its probability (\`1e−87\`) is not representable at all. Keep the computation in
  log space until a probability is actually needed.
- \`softmax\` as \`log_softmax(x).exp()\` costs one extra \`exp\` over the row and inherits the shift. The
  [\`F.softmax\` docs](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.softmax.html)
  say the same of a softmax followed by a log: use \`log_softmax\` instead, "it's faster and has better
  numerical properties".

The gradient of the loss follows from the same lines. With \`t\` the target class:

\`\`\`text
L           = −log p_t = −x_t + lse(x)
∂lse/∂x_i   = exp(x_i) / Σ_j exp(x_j) = p_i    derivative of log Σ exp
∂L/∂x_i     = p_i − [i = t]                    [i = t] is 1 for the target, else 0
\`\`\`

For \`x = [3, 1, 0, 0, 0]\` and \`t = 0\`: \`p = [0.778, 0.105, 0.039, 0.039, 0.039]\`, so the gradient is
\`[−0.222, 0.105, 0.039, 0.039, 0.039]\`. It pushes the target logit up and the others down, and every
entry is in \`[−1, 1]\` however large the logits. A stable forward pass gives a stable backward pass for
free: autograd differentiates the shifted expression, and the shift's own gradient cancels.

:::quiz
Q: Why does the drill define softmax as log_softmax(x).exp() rather than the other way round?
- [ ] It is faster: one exp instead of a division
- [x] log(softmax(x)) underflows for unlikely classes (−inf, then nan gradients); exp(log_softmax) never does
- [ ] softmax cannot be written stably on its own
> softmax can be made stable by the same shift. The asymmetry is in the composition: log of a probability that underflowed is −inf, while exp of a finite log-probability is a clean 0. Since the loss needs the log, that is the primitive.
:::

# Cross-entropy is a gather

\`-log p_target\` reads **one** entry per row of \`log_softmax\`. The textbook form, \`-Σ_c y_c log p_c\`
with \`y\` a **one-hot** (a row of zeros with a single \`1\` at the target), multiplies \`C − 1\` zeros per
row for the same number, and in an LLM \`C\` is the vocabulary:

| Batch | Vocabulary | \`(tokens, vocab)\` logits, float32 | One-hot targets, float32 |
| --- | --- | --- | --- |
| 8 × 4 096 tokens | 32 000 (Llama 2) | 4.2 GB | 4.2 GB more |
| 4 × 4 096 tokens | 128 256 (Llama 3) | 8.4 GB | 8.4 GB more |
| 8 × 8 192 tokens | 128 256 | 33.6 GB | 33.6 GB more |

The logit tensor is already the largest activation in the model; doubling it for a tensor that is zero
everywhere but one column per row is memory a training run does not have. \`gather\` reads the column:

\`\`\`python
logp = log_softmax(logits, dim=-1)                       # (N, C): the only full-width tensor
nll  = -logp.gather(1, targets.unsqueeze(1)).squeeze(1)  # (N,): -log p[target]
\`\`\`

By hand, for two rows of three classes:

\`\`\`text
logp    = [[−0.41, −1.41, −2.41],                         log_softmax of [2, 1, 0]
           [−1.18, −0.68, −1.68]]                         log_softmax of [0, 0.5, −0.5]
targets = [2, 0]  →  unsqueeze(1)  →  [[2], [0]]           shape (2, 1)
gather(1, …)      =  [[logp[0, 2]], [logp[1, 0]]]  =  [[−2.41], [−1.18]]
squeeze(1), negate  →  nll = [2.41, 1.18]
\`\`\`

- \`gather(1, index)\` with an index of shape \`(N, 1)\` returns \`(N, 1)\`: element \`i\` is
  \`logp[i, index[i, 0]]\`. \`unsqueeze(1)\` adds the size-1 column and \`squeeze(1)\` removes it again.
  Every index value must be a real column, which is why \`ignore_index\` needs handling *before* the
  gather (next section).
- \`gather\` is differentiable: its backward writes the incoming gradient into the gathered positions
  and zeros elsewhere, which is exactly the \`−[i = t]\` term of \`p − [i = t]\`.
- The probability tensor is never formed for the loss. \`exp\` of the whole \`(N, C)\` row would cost
  another full-width tensor and gain nothing; the only reason the loss touches all \`C\` columns is the
  smoothing term's mean, and that is a reduction, not a materialised tensor.
- [\`F.cross_entropy\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.cross_entropy.html)
  is documented as \`log_softmax\` followed by \`nll_loss\` in one function; the drill reproduces its
  arithmetic, so the two agree to float precision.

:::quiz
Q: What does logp.gather(1, targets.unsqueeze(1)) compute for logp of shape (N, C) and targets of shape (N,)?
- [x] An (N, 1) tensor whose row i is logp[i, targets[i]]
- [ ] The C columns of logp selected by targets, shape (N, C)
- [ ] A one-hot matrix of the targets, shape (N, C)
> gather picks one element per index entry along the given dim: with dim=1 and an (N, 1) index, output[i, 0] = logp[i, index[i, 0]]. squeeze(1) turns it into the (N,) vector of target log-probabilities.
:::

# Label smoothing and ignore_index

Two arguments change what a row contributes.

## Label smoothing: a different target, not a different loss

A one-hot target asks the model for probability \`1\` on the answer, which no finite logit reaches, so the
loss keeps pushing the target logit up. **Label smoothing**
([Szegedy et al. 2016](https://arxiv.org/abs/1512.00567)) asks for less: \`1 − ε\` on the label and \`ε\`
spread uniformly over all \`C\` classes. The original Transformer trained with \`ε = 0.1\`; GPT-style
pre-training code such as nanoGPT uses none. Because cross-entropy is linear in the target, the mixture
splits into two terms over the same log-probabilities:

\`\`\`text
y_c   = (1 − ε) · [c = target] + ε / C                               the smoothed target
loss  = −Σ_c y_c · logp_c                                            cross-entropy against it
      = −(1 − ε) · Σ_c [c = target] · logp_c − (ε / C) · Σ_c logp_c  split the sum
      = (1 − ε) · (−logp_target)  +  ε · (−mean_c logp_c)            Σ_c / C is the mean
\`\`\`

A worked row, \`logits = [3, 1, 0, 0, 0]\`, target \`0\`, \`C = 5\`:

| Quantity | Value |
| --- | --- |
| \`lse = log(e³ + e¹ + 3 · e⁰)\` | \`log(20.086 + 2.718 + 3) = log 25.804 = 3.2505\` |
| \`logp = x − lse\` | \`[−0.2505, −2.2505, −3.2505, −3.2505, −3.2505]\` |
| \`nll = −logp[0]\` | \`0.2505\` |
| \`smooth = −mean(logp)\` | \`(0.2505 + 2.2505 + 3 × 3.2505) / 5 = 2.4505\` |
| \`ε = 0\` | \`0.2505\`, the plain loss |
| \`ε = 0.1\` | \`0.9 × 0.2505 + 0.1 × 2.4505 = 0.4705\`, what \`F.cross_entropy(label_smoothing=0.1)\` returns |

- The target row still sums to one: \`0.9 + 0.02\` on the label, \`0.02\` on each of the other four.
- The gradient becomes \`p − y\`: it reaches zero when \`p = y\`, that is \`0.92\` on the target and \`0.02\`
  elsewhere, at finite logits, so the logits stop growing without bound. That is the regularising effect
  (smaller logit gaps, better-calibrated probabilities:
  [Müller, Kornblith and Hinton 2019](https://arxiv.org/abs/1906.02629)), and it is why the
  \`−mean(logp)\` term, a reduction over the whole row, is the one thing the loss needs beyond the
  gathered column.

## ignore_index: a row that is not there

Sequences in a batch are padded to one length, and the pad positions have no next token to predict. The
convention PyTorch's \`cross_entropy\` and Hugging Face's data collators share is a target of \`-100\`: not
a class, a marker. Such a row must contribute nothing to the sum **and** nothing to the count:

\`\`\`text
valid  = targets != ignore_index
loss_i = 0                         for invalid rows
result = Σ_i loss_i / Σ_i valid    not / N
\`\`\`

By hand, three rows with targets \`[0, 1, -100]\` and \`ε = 0\`:

| Row | logits | target | kept | \`loss_i\` |
| --- | --- | --- | --- | --- |
| 0 | \`[3, 1, 0, 0, 0]\` | \`0\` | yes | \`0.2505\` |
| 1 | \`[0, 2, 0, 0, 0]\` | \`1\` | yes | \`0.4327\` |
| 2 | \`[1, 1, 1, 1, 1]\` | \`-100\` | no | \`0\` |
| result | | | 2 kept | \`(0.2505 + 0.4327) / 2 = 0.3416\` |

A plain \`.mean()\` would return \`0.6832 / 3 = 0.2277\`, about a third too small, with no error.

- \`-100\` is not a column, so gathering it raises \`index -100 is out of bounds\`. Replace it by any
  real index (\`targets.masked_fill(~valid, 0)\`; \`masked_fill\` writes a value wherever the mask is
  \`True\`), gather, then zero the loss of those rows with \`masked_fill\`: the index is substituted, not
  the loss.
- A plain \`.mean()\` divides by \`N\` and scales the loss and its gradient by \`kept / N\`. The padding
  fraction changes from batch to batch, so batches are silently reweighted. \`reduction="mean"\` with
  ignored targets divides by the number of kept rows; \`valid.sum().clamp(min=1)\` keeps a batch of only
  padding at \`0\` instead of \`0 / 0\`.
- The mask is applied *after* the smoothing mixture, so an ignored row contributes neither its NLL nor its
  uniform term.

:::quiz
Q: A batch of 8 rows has 2 targets equal to −100. The 6 kept rows have losses summing to 12. What does cross_entropy return?
- [ ] 12 / 8 = 1.5
- [x] 12 / 6 = 2.0
- [ ] 12 / 8 for the mean plus the two rows' NLL at index 0
> Ignored rows leave both the numerator and the denominator. The gather needs a stand-in index for them, but their loss is zeroed before the sum, and the count is of kept rows only, which is what PyTorch's reduction="mean" does with ignore_index.
:::

# How to approach it, and the common mistakes

Write the file in this order, running the self-test after each function:

1. \`log_softmax\`: the max with \`keepdim=True\`, the shift, then \`exp\`, \`sum\` (with \`keepdim=True\`),
   \`log\`, and subtract. Three lines.
2. \`softmax\`: one line, \`log_softmax(x, dim).exp()\`.
3. \`cross_entropy\`: \`logp\`, the \`valid\` mask, the safe index, the gather, the uniform term, the
   mixture, the mask on the loss, the division by the kept count.

The mistakes that run without an error, or fail far from their cause:

| Mistake | What happens |
| --- | --- |
| \`x - x.amax(-1)\` without \`keepdim\` | \`(N, C) − (N,)\` lines the max up with the columns: a shape error, or when \`N == C\` a silently wrong shift that leaves positive exponents |
| \`x - x.max(-1, keepdim=True)\` | \`max\` with a \`dim\` returns \`(values, indices)\`; subtracting the pair is a \`TypeError\`. Take \`.values\`, or use \`amax\` |
| \`.sum(dim)\` without \`keepdim=True\` | the \`(N,)\` sum does not broadcast back over \`(N, C)\` |
| \`torch.log(softmax(x))\` for the loss | \`−inf\` and \`nan\` gradients once a probability underflows (previous section) |
| gathering with the raw \`targets\` | \`index -100 is out of bounds\` on the first padded row |
| substituting the index but not masking the loss | the padded row adds \`−logp[0]\` as if class \`0\` were its answer |
| \`loss.mean()\` | divides by \`N\` instead of the kept count; off by \`kept / N\` with no error |

:::quiz
Q: x has shape (4, 4). Which line computes the shift for a stable softmax over the last dim?
- [ ] s = x - x.amax(-1)
- [x] s = x - x.amax(-1, keepdim=True)
- [ ] s = x - x.max(-1, keepdim=True)
> Without keepdim the (4,) max broadcasts along the last dim, so column j is shifted by row j's max: no error because N == C, but wrong. max with a dim returns (values, indices), so the third line is a TypeError. amax with keepdim=True gives (4, 1), which subtracts each row's own max.
:::

# What production systems add

The three functions are the arithmetic; frameworks change how often the row is read, in what precision,
and whether the full tensor ever exists.

| Concern | The drill | Production |
| --- | --- | --- |
| Passes over the row | \`amax\`, subtract, \`exp\`, \`sum\`, \`log\`, subtract: six eager kernels, five of them reading or writing \`(N, C)\` | one fused kernel per row (PyTorch's own softmax, Triton, \`torch.compile\`); the online normaliser below cuts the max-then-sum-then-write passes from three to two |
| Softmax inside attention | the \`(seq, seq)\` score matrix, then softmax over it | FlashAttention's **online softmax**: a running max and a rescaled running sum per tile, the matrix never written to memory |
| The \`(tokens, vocab)\` logits | materialised in the input dtype | upcast to float32 for the softmax (bf16 keeps 7 mantissa bits, too few to accumulate a sum of 128k exponentials), then computed in chunks so the full tensor never exists (fused, chunked cross-entropy kernels such as Liger Kernel's) |
| Gradient | autograd through \`gather\`, \`mean\`, \`masked_fill\` | the closed form \`p − y\`, written into the logits' buffer in place |

The online softmax ([Milakov and Gimelshein 2018](https://arxiv.org/abs/1805.02867)) is the drill's shift
made incremental: when a new tile raises the max from \`m\` to \`m'\`, the sum accumulated so far is
multiplied by \`exp(m − m')\` and the new tile's terms are added at \`exp(x − m')\`. It is the identity from
the second section applied twice, and it is what lets [FlashAttention](https://arxiv.org/abs/2205.14135)
compute an exact softmax without the \`(seq, seq)\` matrix. The paper counts the memory traffic: the safe
softmax reads the row three times and writes it once (4 accesses per element), the online version 3.

:::details Where the shift is not enough
The shift bounds the exponent, not the precision of the sum. Near \`1\`, bfloat16's spacing is
\`2⁻⁷ = 0.0078\`, so \`1 + 0.003\` rounds back to \`1\`. A sum that starts at the max term (\`1\`) and adds
128 000 terms of \`0.003\` one at a time stays at \`1\` instead of reaching \`385\`: every probability comes
out 385 times too large. That is why mixed-precision recipes keep logits, softmax and the loss in float32
and only the matmuls in bf16, and why the drill tests float32 and float64 rather than half precision.
:::

:::quiz
Q: A training run keeps its matmuls in bf16. Why are the logits upcast to float32 before the softmax, when the max shift already prevents overflow?
- [ ] bf16 cannot represent numbers above 65 504
- [x] With 7 mantissa bits, adding many small exponentials to a running sum near 1 rounds them away
- [ ] gather does not accept bf16 tensors
> bf16 has float32's exponent range (its largest finite value is 3.39 × 10³⁸, not float16's 65 504), so overflow is not the issue. Its spacing near 1 is 0.0078: any term below half of that vanishes when added, and a 128k-wide row is mostly such terms.
:::

# What to take away

- **Shift by the max.** \`exp(x − max)\` is in \`(0, 1]\`, its sum is in \`[1, C]\`; the ratio is unchanged,
  so nothing is lost and nothing overflows. One reduction, one subtract, free in a fused kernel.
- **log_softmax is the primitive.** \`softmax\` is its \`exp\`; the loss is one of its columns. \`log\` of a
  probability underflows to \`−inf\`; \`exp\` of a log-probability never does.
- **The loss is a gather.** \`logp.gather(1, targets[:, None])\` reads one value per row; a one-hot is a
  second \`(tokens, vocab)\` tensor for nothing. Its gradient is \`p − onehot\`.
- **Smoothing is a target, ignoring is a mask.** \`(1 − ε) · nll + ε · (−mean logp)\` per row; \`-100\`
  rows contribute zero and are not counted. Divide by kept rows, never by \`N\`.
- **Frameworks fuse and tile.** Online softmax carries a running max across tiles, chunked cross-entropy
  never materialises the logits, and bf16 logits are upcast before any of this happens.

The primary reference is the PyTorch documentation for
[\`torch.nn.functional.cross_entropy\`](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.cross_entropy.html),
which defines the \`label_smoothing\` and \`ignore_index\` semantics the drill matches; Gregory Gundersen's
[*The Log-Sum-Exp Trick*](https://gregorygundersen.com/blog/2020/02/09/log-sum-exp/) walks the shift
itself, and Milakov and Gimelshein's [*Online normalizer calculation for softmax*](https://arxiv.org/abs/1805.02867)
is the version that attention kernels run.
`;
