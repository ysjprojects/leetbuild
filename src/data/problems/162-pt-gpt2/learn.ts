/**
 * The learning guide for GPT-2 end to end: the architecture and its shapes, weight tying and the
 * residual-scaled init, the next-token loss and the training recipe (decay groups, warmup + cosine,
 * clipping, bf16), the samplers, and the KV cache with its memory. Rendered at `/pt-gpt2/learn`.
 */
export const learn = `# The mechanism at a glance

GPT-2 (Radford et al., 2019) is a decoder-only Transformer: a token table and a learned position table,
\`n_layer\` identical pre-norm blocks, a final LayerNorm, and a projection back to the vocabulary that
reuses the token table. It is trained to predict the next token at every position, and it produces text
by sampling one token, appending it, and running again. The problem implements it after nanoGPT in three
files: \`GPT.forward(idx, targets=None) -> (logits, loss)\`, \`train(…)\` around \`torch.optim.AdamW\`, and
\`generate\` / \`generate_cached\` with temperature, \`top_k\`, \`top_p\` and a KV cache.

:::architecture
{
  "input": "idx · (B, T) token ids",
  "output": "logits · (B, T, 50,257)",
  "items": [
    {"id": "tokens", "label": "Token ids", "kind": "io", "sub": "windows, or prompt + samples"},
    {"tone": "model", "items": [
      {"columns": [
        [{"id": "wte", "label": "Token embedding wte", "kind": "embed", "sub": "50,257 × 768", "detail": "Row i is token i's vector; the same tensor is the output layer's weight."}],
        [{"id": "wpe", "label": "Position embedding wpe", "kind": "embed", "sub": "1,024 × 768 · arange(T)", "detail": "Learned absolute positions: the context length is its number of rows."}]
      ]},
      {"id": "emb", "op": "+", "detail": "x = wte(idx) + wpe(arange(T)), then dropout."},
      {"tone": "block", "repeat": "12 ×", "label": "Pre-norm block", "items": [
        {"id": "ln1", "label": "LayerNorm ln_1", "kind": "norm"},
        {"id": "attn", "label": "Causal self-attention", "kind": "attention", "sub": "12 heads × 64"},
        {"id": "add1", "op": "+", "from": "ln1"},
        {"id": "ln2", "label": "LayerNorm ln_2", "kind": "norm"},
        {"id": "mlp", "label": "MLP", "kind": "ffn", "sub": "768 → 3,072 → 768"},
        {"id": "add2", "op": "+", "from": "ln2"}
      ]},
      {"id": "lnf", "label": "Final LayerNorm ln_f", "kind": "norm"},
      {"id": "head", "label": "lm_head", "kind": "head", "sub": "768 → 50,257 · weight = wte", "detail": "Training scores every position against the shifted targets; generation reads only the last row."}
    ]}
  ],
  "notes": [
    {"at": "wpe", "text": "**1,024** rows: the context length"},
    {"at": "attn", "text": "tril mask: position t sees **0..t** only"},
    {"at": "add2", "text": "Both c_proj start at std **0.02 / √24**"},
    {"at": "head", "text": "Tied: **one** 50,257 × 768 tensor, **38.6 M**"}
  ]
}
:::

Training reads every row of the logits with cross-entropy against the next token; generation reads the
last row, samples one id, appends it and runs again. The family:

| model | n_layer | n_embd | n_head | parameters (with wpe) |
|---|---|---|---|---|
| GPT-2 small | 12 | 768 | 12 | 124M |
| GPT-2 medium | 24 | 1024 | 16 | 355M |
| GPT-2 large | 36 | 1280 | 20 | 774M |
| GPT-2 XL | 48 | 1600 | 25 | 1,558M |

All four share \`vocab_size = 50257\` (byte-level BPE) and \`block_size = 1024\`. Nothing in the design
changes with size except these three numbers. The counts are exact sums of the released shapes; the
paper's table says 117M, 345M, 762M and 1542M. The calculator splits any of them by component, with the
weight and KV-cache memory:

:::widget model-size {"preset": "gpt2"}

# The model: shapes, tying and the init

One block, in the shapes the code uses (\`B\` batch, \`T\` sequence, \`d = n_embd\`, \`hd = d / n_head\`):

\`\`\`text
x                       (B, T, d)
qkv = c_attn(ln_1(x))   (B, T, 3d)    one fused matmul, split into q, k, v
q, k, v                 (B, nh, T, hd) view + transpose
att = q @ kᵀ / √hd      (B, nh, T, T)  tril mask → −inf, softmax over the last axis
y = att @ v             (B, nh, T, hd) → transpose → (B, T, d) → c_proj
x = x + y               residual
x = x + c_proj(gelu(c_fc(ln_2(x))))     c_fc: d → 4d, c_proj: 4d → d
\`\`\`

- **Pre-norm.** LayerNorm sits on the branch, so the residual stream is a plain sum of every block's
  output and the gradient reaches the embeddings through identities. The 2017 Transformer normalised
  after the add; GPT-2 moved it, and added \`ln_f\` before the head.
- **Causal mask.** A \`tril\` buffer of shape \`(1, 1, block_size, block_size)\`, sliced to \`[:T, :T]\`,
  sets future scores to \`−inf\` before the softmax; that is the only thing that makes the model
  autoregressive.
- **GELU.** nanoGPT's \`nn.GELU()\` is the exact erf form; OpenAI's GPT-2 code used the tanh
  approximation (\`nn.GELU(approximate="tanh")\`). They differ by under 1e-3 per activation, which
  matters only when you compare logits against the released checkpoint.
- **Weight tying.** \`lm_head = nn.Linear(d, V, bias=False)\` and then
  \`self.lm_head.weight = self.transformer.wte.weight\`: one \`(50257, 768)\` parameter, 38.6M numbers,
  used to embed ids on the way in and to score every vocabulary entry on the way out
  ([Press & Wolf, 2017](https://arxiv.org/abs/1608.05859)). Both gradients accumulate into it.

Parameter count for GPT-2 small, with biases:

| part | formula | count |
|---|---|---|
| wte (also the head) | V · d | 38,597,376 |
| wpe | block_size · d | 786,432 |
| one block | 12d² + 13d | 7,087,872 |
| 12 blocks | | 85,054,464 |
| ln_f | 2d | 1,536 |
| total | | 124,439,808 |
| without wpe | what \`num_params()\` reports | 123,653,376 |

The init is \`N(0, 0.02)\` for every Linear and Embedding weight and zero biases, plus one GPT-2
addition: the two projections per block that write into the residual stream (\`attn.c_proj\`,
\`mlp.c_proj\`) get \`std = 0.02 / √(2 · n_layer)\`. Each block adds two terms to the stream; with
\`2 · n_layer\` roughly independent additions the stream's variance would grow linearly with depth, and
the rescale keeps it of order one at the last layer. The head is small too: \`ln_f\` emits unit-variance
vectors and the tied rows have std 0.02, so the logits have std about \`0.02 · √768 ≈ 0.55\`. A fresh
model predicts nearly uniformly, with a loss near \`ln 50257 + 0.55² / 2 ≈ 11.0\` (10.96 measured).

:::quiz
Q: After \`self.lm_head.weight = self.transformer.wte.weight\`, what does \`model.parameters()\` yield for the two names?
- [ ] Two tensors that are copied into each other after every optimizer step
- [x] One tensor, once: the optimizer updates it once with the sum of both gradients
- [ ] Two tensors, so the optimizer state for the table is stored twice
> The assignment rebinds the head's \`weight\` attribute to the same \`nn.Parameter\`. \`parameters()\`
> de-duplicates by identity, autograd accumulates the embedding's and the head's gradients into one
> \`.grad\`, and AdamW keeps one pair of moments for it.
:::

# One loss at every position, and the recipe around it

A window of \`block_size + 1\` tokens gives \`block_size\` training examples at once: \`x\` is the first
\`block_size\` tokens, \`y\` the same window shifted by one, and the causal mask guarantees position *t*
saw only \`x[:t+1]\`. The loss is \`F.cross_entropy(logits.view(-1, V), y.view(-1))\`, the mean over all
\`B · T\` positions. The recipe around that one line comes from the
[GPT-3 paper](https://arxiv.org/abs/2005.14165) (its appendix B and Table 2.1, whose 125M model trains at
6e-4 with 0.5M-token batches), as nanoGPT configures it for GPT-2 small:

| knob | value (GPT-2 small in nanoGPT) | why |
|---|---|---|
| optimizer | AdamW, \`betas=(0.9, 0.95)\` | a lower β2 adapts \`v\` faster to the spiky gradients of large models |
| weight decay | 0.1 on \`p.dim() >= 2\` only | biases and LayerNorm gains are not over-fitting knobs |
| learning rate | 6e-4, warmup 2000 steps, cosine to 6e-5 | \`v\` is noise early; anneal into a minimum late |
| clipping | global norm 1.0 | bounds the length of a step after a bad batch |
| precision | bf16 autocast, fp32 weights | tensor-core matmuls, fp32's exponent range, no loss scaling |
| batch | ~0.5M tokens via gradient accumulation | the gradient noise level the learning rate was tuned for |

The order inside an iteration is fixed: forward under autocast, \`zero_grad\`, \`backward\`, clip, step.

:::architecture
{
  "input": "it = 0, 1, …, max_iters − 1",
  "output": "every training loss, as a list",
  "items": [
    {"id": "lr", "label": "Set the learning rate", "sub": "group[\\"lr\\"] = get_lr(it)", "detail": "By hand on every parameter group: linear warmup, then cosine to min_lr."},
    {"tone": "dotted", "label": "every eval_interval", "items": [
      {"id": "eval", "label": "estimate_loss", "sub": "no_grad · eval() · train and val", "detail": "The mean of eval_iters batches per split, then model.train() again."},
      {"id": "ckpt", "label": "Checkpoint if val improved", "kind": "io", "sub": "{model, optimizer, config, step}"}
    ]},
    {"id": "batch", "label": "get_batch", "kind": "io", "sub": "x, y = window[:-1], window[1:]"},
    {"id": "fwd", "label": "Forward under autocast", "sub": "logits, loss = model(x, y)"},
    {"id": "zero", "label": "zero_grad", "sub": "set_to_none=True"},
    {"id": "bwd", "label": "loss.backward()", "kind": "loss", "sub": "one .grad per parameter"},
    {"id": "clip", "label": "clip_grad_norm_", "sub": "one global norm ≤ 1.0", "detail": "All parameters at once: the direction is kept, only the length is bounded."},
    {"id": "step", "label": "AdamW step", "sub": "decay on p.dim() ≥ 2 only"}
  ],
  "notes": [
    {"at": "lr", "text": "Peak **6e-4**, cosine to **6e-5**"},
    {"at": "fwd", "text": "**bf16** matmuls, fp32 weights, no GradScaler"},
    {"at": "clip", "text": "Bounds the step after an **unlucky** batch"},
    {"at": "step", "text": "betas **(0.9, 0.95)**, weight decay **0.1**"}
  ]
}
:::

Each piece answers one way an early step goes wrong:

| an unlucky batch, global gradient norm 40× the typical | naive: \`lr = 6e-4\` from step 0, no clipping | the recipe: warmup and \`clip_grad_norm_(…, 1.0)\` |
| --- | --- | --- |
| learning rate | full from the first step | \`6e-4 · (it + 1) / warmup\`: tiny |
| Adam's \`v\` | a handful of steps old, so the step is near full \`lr\` in every coordinate | still noisy, but the step is scaled down |
| gradient | used as is; the spike enters \`m\` and \`v\` at full size | rescaled to norm 1.0, direction kept |
| outcome | every weight moves by about \`lr\` at once; the loss can spike and not recover | a small step; \`v\` keeps learning the scale |

Adam's normalisation is why both are needed. On step 1 the update is exactly \`lr · sign(g)\` whatever
the gradient's norm, so clipping cannot shrink the earliest steps: only the warmup does. Later, once \`v\`
holds the typical scale, a spike 40× the norm adds \`(1 − β2) · 40² = 80\` times the typical \`g²\` to
\`v\` and keeps it inflated for tens of steps (its time constant is \`1 / (1 − β2) = 20\`); clipping stops
that.

The schedule of the step-2 self-test (20 warmup iterations of a 300-iteration overfit run):

:::widget lr-schedule {"warmup": 20, "total": 300}

Two details matter for resuming. A checkpoint stores \`{model, optimizer, config, step}\`: without the
optimizer's two moments per parameter a resumed run is a cold start at full learning rate, and without
\`step\` the schedule restarts its warmup. And \`config\` is saved as a plain dict (\`asdict\`), because
\`torch.load\` defaults to \`weights_only=True\` since PyTorch 2.6 and refuses arbitrary classes. The
autocast rules are in the [PyTorch AMP documentation](https://docs.pytorch.org/docs/stable/amp.html).

:::quiz
Q: Why does the bf16 training loop need no \`GradScaler\`, while fp16 does?
- [ ] bf16 has more mantissa bits, so small gradients are represented exactly
- [x] bf16 has fp32's 8-bit exponent, so small gradients do not underflow to zero
- [ ] Autocast keeps the backward pass entirely in fp32
> fp16's 5-bit exponent flushes values below about 6e-8 to zero, so fp16 training multiplies the loss
> up before backward and divides the gradients back. bf16 trades mantissa (7 bits) for fp32's exponent
> range; small gradients survive, and the weights and optimizer state stay fp32 anyway.
:::

# Sampling: temperature, top-k, nucleus

At inference only \`logits[:, -1, :]\` matters: the distribution of the next token. How it is turned into
a token decides the text's character. With logits \`[2, 1, 0, −1]\`:

| setting | p(token 0..3) | effect |
|---|---|---|
| temperature 1.0 | .644 .237 .087 .032 | the model's own distribution |
| temperature 0.5 | .865 .117 .016 .002 | sharper; → greedy as T → 0 |
| temperature 2.0 | .455 .276 .167 .102 | flatter; more surprising tokens |
| top_k = 2 | .731 .269 0 0 | a fixed-size head, renormalised |
| top_p = 0.9 | .665 .245 .090 0 | the smallest head with ≥ 90 % of the mass |

\`\`\`python
logits = logits / temperature
v, _ = torch.topk(logits, k);  logits[logits < v[:, [-1]]] = -inf          # top-k
p = softmax(sorted logits); remove = cumsum(p) - p >= top_p                 # nucleus, crossing token kept
next_id = torch.multinomial(softmax(logits), num_samples=1)
\`\`\`

Try the three knobs on a toy next-token distribution, and sample from what survives:

:::widget sampling

Top-k's weakness is that *k* is fixed: when the model is confident, k = 40 still admits 39 bad tokens;
when it is uncertain, 40 may cut real options. [Nucleus sampling](https://arxiv.org/abs/1904.09751)
(Holtzman et al.) sizes the head by probability mass instead: the smallest set whose probability
reaches p. That is why most sampling APIs expose \`top_p\`. Greedy decoding (\`top_k=1\`) is
deterministic but loops on repetitions, the degeneration that paper documents.

:::quiz
Q: The model is 97 % sure of the next token. What do top_k = 40 and top_p = 0.9 keep?
- [ ] Both keep only that token
- [x] top-k keeps 40 tokens; top-p keeps only the one, since it alone covers 90 % of the mass
- [ ] top-k keeps one token; top-p keeps 40
> Top-k ignores the shape of the distribution and always keeps k candidates. Top-p keeps the smallest
> set whose cumulative probability reaches p, and here the first token alone already exceeds 0.9.
:::

# The KV cache and its memory

The uncached loop re-runs the whole context for every new token: token *t* costs *t* positions through
every block, so *n* tokens cost about n²/2 position-forwards. Yet nothing about past positions changes
(the causal mask means position *i* never sees anything after *i*), so their keys and values can be
stored per block and reused. A decode step then embeds one token at position \`pos\`, computes one row of
q, k, v per block, writes k and v into the cache at \`pos\`, and attends one query over \`pos + 1\` keys.

Step through decoding with and without the cache, and watch the work and the memory counters diverge:

:::widget kv-cache

The obvious cached version gets the positions wrong. Feeding one token through the unmodified
\`forward\` embeds it with \`wpe(arange(1))\` (position 0) and slices the mask's row 0:

| decode step | positions embedded | mask rows | result |
| --- | --- | --- | --- |
| naive: the unmodified \`forward\` on one token | \`wpe(arange(1))\`: position 0 every time | \`mask[:1, :1]\`: one key, not \`pos + 1\` | every token looks like the start of a document |
| correct: \`forward_cached\` | \`wpe(arange(pos, pos + T))\` | \`mask[pos : pos + T, : pos + T]\` over the cached keys | identical to the full forward (1e-10 in float64) |

The cost is memory, \`2 · n_layer · T · n_embd\` numbers per sequence:

| model | per token (fp16) | full context |
|---|---|---|
| GPT-2 small (12 × 768) | 36 KiB | 36 MiB at 1024 |
| GPT-2 XL (48 × 1600) | 300 KiB | 300 MiB at 1024 |
| 70B, 80 layers × 8192, no GQA | 2.5 MiB | 10 GiB at 4096 |
| 70B with 8 KV heads (GQA) | 320 KiB | 1.25 GiB at 4096 |

Multiply by the batch and the cache rivals the weights: serving a 13B model on a 40 GB A100, vLLM's
[PagedAttention paper](https://arxiv.org/abs/2309.06180) puts about 65 % of memory in weights and close
to 30 % in KV cache. Hence grouped-query attention (fewer k, v heads), paged caches in vLLM, and
quantised caches. Decoding also turns compute-bound matmuls into memory-bound reads of the whole cache
per token.

:::details Why a full cache is re-encoded
GPT-2's positions are a learned table of \`block_size\` rows. Once 1024 tokens are cached, the next token
has no row, and sliding the window shifts every remaining token's position by one, so their cached keys,
computed with the old positions, are stale. The only exact answer is to re-encode the cropped window,
which is what the uncached loop does every step. Rotary embeddings (LLaMA) encode position inside q and
k by rotation, which is why later models can keep rolling caches.
:::

:::quiz
Q: Generating 1,000 tokens from a short prompt, how does per-token attention work grow with and without the cache?
- [ ] Constant with the cache, linear without
- [x] Linear in the position with the cache (one query over t keys), quadratic without (t queries over t keys)
- [ ] The same in both: attention is O(t²) either way
> With the cache one new query attends over the t cached keys: O(t) per token. Without it every step
> recomputes all t queries against t keys, O(t²) per token, plus t positions through every MLP.
:::

# What to take away

- GPT-2 is embed → \`n_layer\` pre-norm blocks → \`ln_f\` → tied head; later LLMs swap the parts, not the
  shape.
- Weight tying makes the token table the output projection: one tensor, both gradients, 38.6M
  parameters saved at small scale.
- \`0.02 / √(2 · n_layer)\` on the residual projections keeps the stream's variance flat with depth.
- The loss is cross-entropy at every position; the recipe around it (decay on matrices, warmup +
  cosine, clipping at 1.0, bf16) is what keeps it from diverging.
- Sampling is temperature, then top-k or nucleus, then \`multinomial\`; the KV cache makes each token
  O(t) and costs \`2 · n_layer · n_embd\` numbers per token of context.

Primary reference: Radford et al., [Language Models are Unsupervised Multitask Learners](https://cdn.openai.com/better-language-models/language_models_are_unsupervised_multitask_learners.pdf) (2019), as implemented in Karpathy's [nanoGPT](https://github.com/karpathy/nanoGPT).
`;
