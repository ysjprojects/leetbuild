/**
 * The learning guide for Llama 3 from scratch: the 8B layer stack, RMSNorm and its float32 upcast, RoPE
 * with the Llama 3.1 frequency scaling, SwiGLU and Meta's width rule, grouped-query attention and the KV
 * cache's bytes, the offset mask that serves prefill and decode, and the closed-form parameter count.
 * Rendered at `/pt-llama3/learn`.
 */
export const learn = `# The system at a glance

Llama 3 is Meta's 2024 family of open-weights decoder-only Transformers: 8B, 70B and 405B parameters,
trained on about 15 trillion tokens, described in *The Llama 3 Herd of Models*.
The architecture is the one [LLaMA](https://arxiv.org/abs/2302.13971) settled on in 2023, with grouped-query
attention in every size, a larger vocabulary and a slower-turning RoPE. Meta publishes it as one PyTorch file,
\`models/llama3/model.py\` in its llama-models repository, and this project
rewrites that file without fairscale: \`RMSNorm\`, \`precompute_rope\` / \`apply_rope\`, \`FeedForward\`,
\`Attention\` with \`repeat_kv\` and a KV cache, \`Transformer.forward(tokens, start_pos)\`, \`generate\` and
\`num_params\`.

:::architecture
{
  "input": "tokens · (B, T) at positions start_pos …",
  "output": "logits · (B, T, 128,256) float32",
  "items": [
    {"id": "g-tokens", "label": "Token ids", "kind": "io", "sub": "tiktoken BPE · 128,256"},
    {"tone": "model", "items": [
      {"id": "g-emb", "label": "tok_embeddings", "kind": "embed", "sub": "128,256 × 4,096", "detail": "No position table: positions enter as rotations inside attention."},
      {"tone": "block", "repeat": "32 ×", "label": "Transformer block", "items": [
        {"id": "g-norm1", "label": "attention_norm", "kind": "norm", "sub": "RMSNorm · float32 statistics"},
        {"id": "g-attn", "label": "Grouped-query attention", "kind": "attention", "sub": "32 q heads · 8 kv heads", "side": {"label": "RoPE", "sub": "freqs_cis[start_pos : +T]"}, "detail": "wq 4,096 → 4,096; wk, wv 4,096 → 1,024; the cache holds the 8 KV heads only."},
        {"id": "g-add1", "op": "+", "from": "g-norm1"},
        {"id": "g-norm2", "label": "ffn_norm", "kind": "norm", "sub": "RMSNorm"},
        {"id": "g-ffn", "label": "SwiGLU", "kind": "ffn", "sub": "w2(silu(w1 x) · w3 x) · 14,336"},
        {"id": "g-add2", "op": "+", "from": "g-norm2"}
      ]},
      {"id": "g-normf", "label": "norm", "kind": "norm", "sub": "final RMSNorm"},
      {"id": "g-out", "label": "output", "kind": "head", "sub": "4,096 → 128,256 · untied"}
    ]}
  ],
  "notes": [
    {"at": "g-attn", "text": "**128 KiB** of K and V per token in bf16"},
    {"at": "g-ffn", "text": "**70 %** of the parameters"},
    {"at": "g-out", "text": "Its own **525 M** parameters"}
  ]
}
:::

Against GPT-2, every part is replaced and the shape is not:

| part | GPT-2 | Llama 3 |
|---|---|---|
| normalisation | LayerNorm, with bias | RMSNorm, no bias, float32 statistics |
| positions | learned table of 1,024 rows | RoPE, θ = 500,000, scaled for 128K |
| feed-forward | GELU, 4d | SwiGLU, about 3.5d (14,336 for d = 4,096) |
| attention | 12 heads, K and V per head | 32 query heads, 8 KV heads |
| biases | everywhere | nowhere |
| output layer | tied to the embedding | untied |
| vocabulary | 50,257 | 128,256 |

The three sizes differ only in their numbers:

| model | layers | dim | heads | KV heads | FFN | KV cache per token (bf16) |
|---|---|---|---|---|---|---|
| 8B | 32 | 4,096 | 32 | 8 | 14,336 | 128 KiB |
| 70B | 80 | 8,192 | 64 | 8 | 28,672 | 320 KiB |
| 405B | 126 | 16,384 | 128 | 8 | 53,248 | 504 KiB |

# RMSNorm and the float32 upcast

[RMSNorm](https://arxiv.org/abs/1910.07467) is LayerNorm without the mean: scale every vector by the reciprocal of
its root mean square, then by a learned gain.

\`\`\`text
LayerNorm(x) = (x − mean(x)) / sqrt(var(x) + eps) · γ + β
RMSNorm(x)   =  x / sqrt(mean(x²) + eps) · γ          eps = 1e-5 in Llama 3
\`\`\`

- **One reduction instead of two**, and no \`β\`. The RMSNorm paper found the re-centring contributed
  nothing measurable; the saving is small in FLOPs and real in kernel time, since both are memory-bound.
- **Pre-norm.** Each block normalises the input of its two sublayers (\`attention_norm\`, \`ffn_norm\`) and adds
  the sublayer's output back to the unnormalised stream; one final \`norm\` sits before the output layer.
- **Statistics in float32.** Meta's \`forward\` is \`self._norm(x.float()).type_as(x) * self.weight\`. In bf16
  (8 significant bits) every square, the mean and its reciprocal root would each be rounded, up to 0.4 % per
  rounding; in float32 the scale is right to about 1e-7 and the result is rounded to bf16 once.

| input | statistics | output | what goes wrong |
|---|---|---|---|
| bf16 | bf16 | bf16 | squares, mean and \`rsqrt\` each rounded: every activation is scaled by a slightly wrong factor, layer after layer |
| bf16 | float32, cast back | bf16 | nothing: the scale is right, only the result is rounded once |

:::quiz
Q: Why does Meta's RMSNorm call \`.type_as(x)\` before multiplying by \`self.weight\` rather than after?
- [ ] The weight is stored in float32 and would otherwise be downcast
- [x] The statistics are taken in float32, and the result returns to the model's dtype before the gain, so the block keeps running in bf16
- [ ] \`type_as\` is needed for autograd to reach the weight
> The upcast exists only to compute \`rsqrt(mean(x²) + eps)\` precisely. Casting back right after keeps the
> rest of the block (the gain, the projections, the residual add) in the model's dtype, so memory and
> matmul throughput stay those of bf16.
:::

# Rotary embeddings and the 3.1 scaling

[RoPE](https://arxiv.org/abs/2104.09864) stores no position vectors. It splits each head's 128 dimensions into
64 adjacent pairs, treats pair \`j\` as a complex number, and rotates it by the angle \`m · freq_j\` for the token
at position \`m\`:

\`\`\`text
freq_j = θ^(−2j / 128)            j = 0 … 63, θ = 500,000
q'_m = q_m · e^(i · m · freq_j)   per pair, the same for k
q'_m · k'_n = Re Σ_j q_m,j · conj(k_n,j) · e^(i · (m − n) · freq_j)
\`\`\`

The last line is the point: after rotation, the score between a query at \`m\` and a key at \`n\` depends on
\`m − n\` only. Attention sees relative positions, a cached key never needs updating, and the code is two
\`view_as_complex\` calls and a multiply. Meta's pairs are **adjacent** dimensions \`(2j, 2j + 1)\`; Hugging Face's
port permutes \`wq\` and \`wk\` so it can rotate halves instead, which is why loading weights into the wrong
rotation silently produces garbage.

:::widget rope-rotation

Llama 2 used θ = 10,000, whose slowest pair completes a turn every 54,000 tokens. Llama 3 raised θ to 500,000,
and the slowest pair now turns once in 2.56 million tokens. Llama 3.1 then extended the context from 8,192 to
131,072 tokens with \`apply_scaling\`, sorting the 64 pairs by wavelength \`2π / freq_j\`:

| pairs (head_dim 128) | wavelength | rule | example |
|---|---|---|---|
| 0 … 28 | under 2,048 tokens | kept | pair 16: 167 tokens |
| 29 … 34 | 2,048 to 8,192 | blended, 1.2× to 5.3× slower | pair 32: 4,443 → 11,972 tokens |
| 35 … 63 | over 8,192 tokens | divided by 8 | pair 48: 118,143 → 945,143 tokens |

\`\`\`python
smooth = (8192 / wavelen - 1) / (4 - 1)            # 0 at wavelength 8,192, 1 at 2,048
freq = (1 - smooth) * freq / 8 + smooth * freq     # only for 2,048 ≤ wavelength ≤ 8,192
\`\`\`

The fast pairs carry local word order and already turned many times within 8K tokens during pretraining,
so they are left alone. The slow pairs never completed a turn in pretraining; at position 100,000 they would
reach angles the model has never seen, so dividing their frequency by 8 maps 128K positions back into the
range it was trained on. That is [position interpolation](https://arxiv.org/abs/2306.15595) applied by
wavelength instead of to every pair, followed by a long-context stage of continued pretraining.

:::quiz
Q: Why is Llama 3.1's scaling applied only to the long-wavelength pairs?
- [ ] The short-wavelength pairs are not used by attention
- [x] Short wavelengths already cycled many times within the 8K pretraining context, so long positions give them no unseen angles; dividing them would blur local order
- [ ] Scaling every pair would change the parameter count
> A pair whose wavelength is 167 tokens has seen every angle thousands of times by position 8,192.
> Slowing it by 8 would make neighbouring tokens look 8× closer and damage short-range syntax. Only the
> pairs that never completed a turn need their angles kept inside the trained range.
:::

# SwiGLU and the width 14,336

[SwiGLU](https://arxiv.org/abs/2002.05202) gates the up-projection with a second projection through SiLU:

\`\`\`text
FFN(x) = w2( silu(w1 x) ⊙ w3 x )      silu(z) = z · σ(z), no biases
\`\`\`

Three matrices instead of GELU's two would cost 50 % more at the same width, so LLaMA shrank the hidden
width to 2/3 of 4d. Meta's code then applies a per-model multiplier and rounds **up** to a multiple that suits
tensor cores and tensor parallelism:

\`\`\`python
hidden = int(2 * (4 * dim) / 3)
hidden = int(ffn_dim_multiplier * hidden)
hidden = multiple_of * ((hidden + multiple_of - 1) // multiple_of)
\`\`\`

| model | 4d | 2/3 · 4d | × multiplier | multiple_of | hidden |
|---|---|---|---|---|---|
| 8B | 16,384 | 10,922 | × 1.3 = 14,198 | 1,024 | **14,336** |
| 70B | 32,768 | 21,845 | × 1.3 = 28,398 | 4,096 | **28,672** |
| 405B | 65,536 | 43,690 | × 1.2 = 52,428 | 4,096 | **53,248** |

The two \`int(...)\` truncations matter: rounding instead of truncating could cross a multiple and change
the matrix shapes, and then Meta's checkpoint would not load.

:::quiz
Q: A SwiGLU block at width 2/3 · 4d has how many parameters compared with a GELU MLP at width 4d (no biases)?
- [ ] 1.5 times as many
- [x] The same: 3 · d · (8d/3) = 8d² = 2 · d · 4d
- [ ] Two thirds as many
> GELU's MLP has two matrices of \`d × 4d\`. SwiGLU has three of \`d × 8d/3\`. Both are \`8d²\`; the
> multiplier 1.3 and the rounding then make Llama 3 8B's FFN slightly larger, \`3 · 4,096 · 14,336\`.
:::

# Grouped-query attention and the KV cache

Decoding one token reads every cached key and value of every layer. With multi-head attention, Llama 3 8B
would store 32 heads of K and V per layer, 512 KiB per token in bf16, 64 GiB for one 128K-token sequence: more
than the 16 GB of weights. [Multi-query attention](https://arxiv.org/abs/1911.02150) keeps one KV head for all
query heads and loses quality; [GQA](https://arxiv.org/abs/2305.13245) sits between them with \`n_kv_heads\`
groups. Llama 3 uses 8 KV heads in every size.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "g-q", "array": "query heads (32)", "sub": "query head h reads KV head h // 4", "cols": 32, "tone": "global", "cells": "index", "detail": "Colours are groups: the four query heads that share one KV head.",
     "marks": [{"cols": [0, 3], "tone": "a", "label": "kv 0"}, {"cols": [4, 7], "tone": "b", "label": "kv 1"}, {"cols": [8, 11], "tone": "a", "label": "kv 2"}, {"cols": [12, 15], "tone": "b", "label": "kv 3"}, {"cols": [16, 19], "tone": "a", "label": "kv 4"}, {"cols": [20, 23], "tone": "b", "label": "kv 5"}, {"cols": [24, 27], "tone": "a", "label": "kv 6"}, {"cols": [28, 31], "tone": "b", "label": "kv 7"}]},
    {"id": "g-kv", "array": "KV heads (8), cached", "sub": "repeat_kv expands them ×4 for the matmul", "cols": 8, "tone": "global", "cells": "index", "detail": "Each KV head has its group's colour.",
     "marks": [{"cols": [0, 0], "tone": "a"}, {"cols": [1, 1], "tone": "b"}, {"cols": [2, 2], "tone": "a"}, {"cols": [3, 3], "tone": "b"}, {"cols": [4, 4], "tone": "a"}, {"cols": [5, 5], "tone": "b"}, {"cols": [6, 6], "tone": "a"}, {"cols": [7, 7], "tone": "b"}]},
    {"id": "g-wrong", "array": "x.repeat(1, 1, 4, 1): the wrong pairing", "sub": "query head h would read KV head h % 8", "cols": 32, "tone": "global", "cells": ["0","1","2","3","4","5","6","7","0","1","2","3","4","5","6","7","0","1","2","3","4","5","6","7","0","1","2","3","4","5","6","7"],
     "marks": [{"cols": [1, 3], "tone": "bad", "label": "should be 0, 0, 0"}]}
  ],
  "arrows": [{"from": "g-kv", "to": "g-q", "label": "expand, no copy until reshape"}]
}
:::

Two details make the grouping right:

- **Which query heads share.** \`repeat_kv\` uses \`x[:, :, :, None, :].expand(...)\`, so KV head \`g\` serves query
  heads \`4g … 4g + 3\`, the grouping the checkpoint was trained with. Tiling with \`repeat\` gives the right shape
  and the wrong pairing: no error, just a broken model.
- **What is stored.** The cache is \`[max_batch, max_seq, n_kv_heads, head_dim]\`; the 32-head view exists only
  inside the matmul.

Change the grouping and the context and watch the bytes:

:::widget gqa-heads {"heads": 32, "kvHeads": 8, "layers": 32, "headDim": 128, "context": 8192}

| Llama 3 8B, bf16 | KV heads | per token | 8,192 tokens | 131,072 tokens |
|---|---|---|---|---|
| MHA | 32 | 512 KiB | 4 GiB | 64 GiB |
| GQA (Llama 3) | 8 | 128 KiB | 1 GiB | 16 GiB |
| MQA | 1 | 16 KiB | 128 MiB | 2 GiB |

:::quiz
Q: Llama 3 70B has 64 query heads and 8 KV heads. How many bytes of K and V does one token cost in bf16?
- [ ] 2.5 MiB, as with 64 heads
- [x] 320 KiB: 2 · 80 layers · 8 heads · 128 · 2 B
- [ ] 40 KiB: 2 · 8 heads · 128 · 2 B · 10
> The cache scales with KV heads, layers and head size, not with query heads:
> \`2 · 80 · 8 · 128 · 2 = 327,680\` bytes. With 64 KV heads it would be 8× that, 2.5 MiB per token.
:::

# One forward for prefill and decode

\`Transformer.forward(tokens, start_pos)\` is called with the whole prompt at \`start_pos = 0\` (the prefill), then
with one token at a time at \`start_pos = cur_pos\` (decode), and it may be called with a chunk of several tokens
at any \`start_pos\`. Three things follow \`start_pos\`: the RoPE rows \`freqs_cis[start_pos : start_pos + seqlen]\`,
the cache slice written, and the mask.

:::architecture
{
  "input": "prompt · (B, T)",
  "output": "(B, T + max_new_tokens)",
  "items": [
    {"id": "g-prefill", "label": "Prefill", "kind": "attention", "sub": "model(tokens[:, 0:T], 0)", "detail": "Every layer writes cache rows 0 … T − 1; the mask is a T × T triangle."},
    {"tone": "block", "repeat": "max_new_tokens ×", "label": "Decode step", "items": [
      {"id": "g-sample", "label": "Sample the last row", "sub": "softmax(logits / 0.6) · top-p 0.9", "detail": "Sort, cumulative mass, drop tokens whose preceding mass exceeds p, renormalise, multinomial, gather back to ids."},
      {"id": "g-append", "label": "Append", "kind": "io", "sub": "torch.cat([tokens, next], 1)"},
      {"id": "g-decode", "label": "Decode one token", "kind": "attention", "sub": "model(tokens[:, cur:cur + 1], cur)", "detail": "seqlen = 1: no mask, one query over cur + 1 cached keys."}
    ]}
  ],
  "notes": [
    {"at": "g-prefill", "text": "The prompt in **one** forward"},
    {"at": "g-decode", "text": "One query over **cur + 1** keys, no mask"}
  ]
}
:::

The mask is \`(seqlen, start_pos + seqlen)\`: row \`i\` is the token at position \`start_pos + i\`, which may see
keys \`0 … start_pos + i\`. For a chunk of 3 tokens after 2 cached ones:

\`\`\`text
             keys:  0     1     2     3     4
row 0 (pos 2)       0     0     0    -inf  -inf
row 1 (pos 3)       0     0     0     0    -inf
row 2 (pos 4)       0     0     0     0     0
\`\`\`

Meta builds it as \`torch.hstack([zeros(seqlen, start_pos), triu(full(-inf), diagonal=1)])\`. The tempting
version reuses the prefill mask and pads it:

| chunk at start_pos = 2 | mask | effect |
|---|---|---|
| naive: \`triu\` of a \`(3, 5)\` \`-inf\` matrix with \`diagonal=1\` | row \`i\` sees keys \`0 … i\` | the chunk loses the cached key 1 and its own newest keys: row 0 cannot see itself |
| naive: \`(3, 3)\` triangle, then zeros on the right | row 0 sees keys 0, 3 and 4 | the token at position 2 misses key 1 and itself, and attends to positions 3 and 4: the future leaks |
| correct: zeros on the **left**, then the triangle | row \`i\` sees \`0 … 2 + i\` | identical to the full forward over all five tokens |

A single decode token needs no mask at all: everything in the cache is in its past. That is why Meta passes
\`mask = None\` when \`seqlen == 1\`, and why one function serves both phases.

Generation must also draw the same random numbers in both paths if cached and uncached sampling are to agree:
one \`multinomial\` per token, always from \`logits[:, -1]\`. The prefill costs one forward over \`T\` tokens; each
decode step one token's projections and one row of attention over the cache, so decode is limited by reading
16 GB of weights and the cache per step, not by FLOPs.

:::quiz
Q: A decode step calls \`model(tokens[:, cur:cur + 1], cur)\`. What would go wrong with \`start_pos = 0\` instead?
- [ ] Nothing, because the cache already holds the earlier keys
- [x] The token would be rotated as position 0, overwrite cache row 0 and attend only to it
- [ ] The mask would hide every cached key
> \`start_pos\` picks the RoPE rows, the cache row written and the range read. At 0 the token is rotated as if
> it were first, its key replaces the first token's, and the read \`cache[:, :1]\` returns that one row.
:::

# Counting 8,030,261,248 parameters

Every tensor of Llama 3 8B is a matrix with no bias, or a norm gain:

| tensor | shape | count |
|---|---|---|
| tok_embeddings | 128,256 × 4,096 | 525,336,576 |
| per layer: wq + wo | 2 × 4,096 × 4,096 | 33,554,432 |
| per layer: wk + wv | 2 × 4,096 × 1,024 | 8,388,608 |
| per layer: w1 + w2 + w3 | 3 × 4,096 × 14,336 | 176,160,768 |
| per layer: two norms | 2 × 4,096 | 8,192 |
| one layer | | 218,112,000 |
| 32 layers | | 6,979,584,000 |
| final norm | 4,096 | 4,096 |
| output (untied) | 4,096 × 128,256 | 525,336,576 |
| **total** | | **8,030,261,248** |

\`num_params(args)\` writes this table as one expression of \`ModelArgs\`, so it can check 8B and 70B
(70,553,706,496) without allocating 32 GB of float32. The self-test then checks the same expression against
\`sum(p.numel() for p in model.parameters())\` on a tiny config: if the closed form and the model disagree, one
of them has a wrong shape.

:::details Why "8B" is 8.03 B and the cache is not in the count
The name rounds the total. The two vocabulary matrices are 13 % of it, attention 17 % and SwiGLU 70 %. The KV
cache and the RoPE table are buffers, not parameters: they are not trained, not saved in the checkpoint, and
their size depends on \`max_batch_size\` and \`max_seq_len\`, not on the model.
:::

:::quiz
Q: Llama 3 8B unties its output layer. How many parameters would tying it to \`tok_embeddings\` save?
- [ ] None: the output layer has a different shape
- [ ] 1,050,673,152
- [x] 525,336,576, one 128,256 × 4,096 matrix
> Tying makes the output layer reuse the embedding matrix, so one of the two \`128,256 × 4,096\` matrices
> disappears: 6.5 % of the model. Meta ties them only in the small Llama 3.2 models (1B and 3B), where
> the vocabulary matrices are a much larger share.
:::

# What to take away

- Llama 3 is GPT-2's loop with every part swapped: RMSNorm, RoPE, SwiGLU, GQA, no biases, an untied head.
- RMSNorm takes its statistics in float32 and returns to bf16; RoPE rotates adjacent pairs so scores depend
  on \`m − n\`, and Llama 3.1 slows only the pairs whose wavelength exceeds the 8K pretraining context.
- SwiGLU's width is 2/3 of 4d, times a multiplier, rounded up: 14,336 for 8B.
- GQA caches 8 KV heads for 32 query heads: 128 KiB per token for 8B instead of 512 KiB, and \`repeat_kv\`
  must pair query head \`h\` with KV head \`h // n_rep\`.
- One \`forward(tokens, start_pos)\` serves prefill, chunks and decode because RoPE rows, cache slice and mask
  all follow \`start_pos\`.

Primary reference: [The Llama 3 Herd of Models](https://arxiv.org/abs/2407.21783), as implemented in Meta's
[llama-models](https://github.com/meta-llama/llama-models) \`models/llama3/model.py\`.
`;
