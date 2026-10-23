/**
 * The learning guide for Megatron tensor parallelism: the conjugate operators f and g, why column then
 * row needs one all-reduce, attention split by head, the vocabulary-parallel embedding and cross-entropy,
 * and what the collectives cost. Rendered at `/pt-tensor-parallel/learn`.
 */
export const learn = `# The system at a glance

Megatron-LM ([Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053)) trains a transformer that does not fit
on one GPU by splitting every weight matrix across the GPUs of a node. Each of the \`p\` ranks holds \`1/p\` of
every layer, computes its share of every token, and the ranks exchange activations with all-reduces inside
each layer. The paper trained an 8.3-billion-parameter GPT-2 on 512 GPUs this way, 8-way tensor parallel
inside each server and 64-way data parallel across them, at 76% scaling efficiency. It needed no compiler
and no new library: a few communication calls inserted into ordinary PyTorch modules, which is what this
problem writes.

Tensor parallelism (TP) is one axis of the 3D parallelism every frontier run uses: TP inside a node over
NVLink, pipeline stages across nodes, data parallelism (or ZeRO / FSDP) over the rest. Serving engines that
shard a model over several GPUs run the same layers at inference time.

:::architecture
{
  "input": "ids · (B, T) int64, the same on every rank",
  "output": "loss · (B, T), the same on every rank",
  "items": [
    {"id": "g-emb", "label": "VocabParallelEmbedding", "kind": "embed", "sub": "V/p rows · mask · g", "detail": "Each rank looks up the ids it owns, zeroes the rest, and one all-reduce sums the vectors."},
    {"tone": "block", "repeat": "n_layer ×", "label": "ParallelBlock", "items": [
      {"id": "g-ln1", "label": "LayerNorm ln1", "kind": "norm", "sub": "replicated"},
      {"id": "g-attn", "label": "f · attention · g", "kind": "attention", "sub": "n/p heads per rank", "detail": "Column-parallel qkv behind f, whole heads on each rank, row-parallel output projection in front of g."},
      {"id": "g-add1", "op": "+", "from": "g-ln1"},
      {"id": "g-ln2", "label": "LayerNorm ln2", "kind": "norm", "sub": "replicated"},
      {"id": "g-mlp", "label": "f · MLP · g", "kind": "ffn", "sub": "4d/p hidden units per rank", "detail": "Column-parallel fc behind f, GELU on the local slice, row-parallel proj in front of g."},
      {"id": "g-add2", "op": "+", "from": "g-ln2"}
    ]},
    {"id": "g-lnf", "label": "LayerNorm ln_f", "kind": "norm", "sub": "replicated"},
    {"id": "g-head", "label": "parallel_lm_logits", "kind": "head", "sub": "f · h @ W_rᵀ → (B, T, V/p)", "detail": "Tied to the embedding shard: the rows a rank looks up are the rows it scores."},
    {"id": "g-ce", "label": "Vocab-parallel cross-entropy", "kind": "loss", "sub": "3 all-reduces of B·T floats", "detail": "A global max, a global sum of exps and the target logit from its owner; the full logits never exist."}
  ],
  "notes": [
    {"at": "g-attn", "text": "**1** all-reduce forward, **1** backward"},
    {"at": "g-mlp", "text": "**1** all-reduce forward, **1** backward"},
    {"at": "g-emb", "text": "Rank r owns ids **[r·V/p, (r+1)·V/p)**"},
    {"at": "g-ce", "text": "**12 B** a token, not **4·V B**"},
    {"at": "g-ln2", "text": "Same stream, same gradients on every rank", "side": "left"}
  ]
}
:::

What each rank holds and sends, piece by piece (\`p\` ranks, \`d\` the model width, \`B · T\` tokens):

| piece | dense weight | per rank | forward | backward |
|---|---|---|---|---|
| token embedding | V × d | V/p × d | all-reduce B·T·d | none |
| attention qkv (column) | d × 3d | d × 3d/p, n/p heads | none (f) | all-reduce B·T·d |
| attention out (row) | d × d | d/p × d, whole bias | all-reduce B·T·d (g) | none |
| MLP fc (column) | d × 4d | d × 4d/p | none (f) | all-reduce B·T·d |
| MLP proj (row) | 4d × d | 4d/p × d, whole bias | all-reduce B·T·d (g) | none |
| LayerNorms | 2d each | replicated | none | none |
| tied head | V × d | the embedding shard | none (f) | all-reduce B·T·d |
| cross-entropy | B·T·V logits | B·T·V/p logits | 3 all-reduces of B·T | none |

At GPT-3 175B's width (\`d = 12,288\`, 96 layers) a layer's \`12d²\` weights are 1.81 B parameters; at
\`p = 8\` a rank keeps 226 M of them, 453 MB in bf16, and the 96 layers' 174 B weights become 21.7 B per
rank.

# f and g: two conjugate operators

Write the paper's \`Y = X A\` (\`A = Wᵀ\` for an \`nn.Linear\`). There are two ways to split \`A\` over two
ranks, and each needs one sum, on a different side of the matmul:

\`\`\`text
column split   A = [A₁ A₂]          Y = [X A₁, X A₂]        each rank: X (whole) → its slice Yᵣ
               dL/dX = dL/dY₁ A₁ᵀ + dL/dY₂ A₂ᵀ              a sum over ranks, in backward
row split      A = [A₁ ; A₂], X = [X₁ X₂]
               Y = X₁ A₁ + X₂ A₂                            a sum over ranks, in forward
               dL/dXᵣ = dL/dY Aᵣᵀ                           each rank: its own slice, no sum
\`\`\`

The column split's input is used by every shard, so its gradient is a sum; the row split's output is a
sum, so its gradient reaches every term unchanged. Megatron names the two sums:

| operator | forward | backward | where it sits |
|---|---|---|---|
| f, \`CopyToTP\` | identity | all-reduce (SUM) | in front of a column-parallel layer |
| g, \`ReduceFromTP\` | all-reduce (SUM) | identity | behind a row-parallel layer |
| \`GatherFromTP\` | all-gather, last dim | keep own slice | a column layer with \`gather_output\` |
| \`ScatterToTP\` | keep own slice | all-gather, last dim | a row layer without \`input_is_parallel\` |

f and g are each other's transpose: the forward of one is the backward of the other. Put a column layer
behind f and a row layer in front of g, and anything elementwise in between stays local. The paper's
figure 3, for the MLP:

:::architecture
{
  "input": "X · (B, T, d), replicated",
  "output": "Z · (B, T, d), replicated",
  "items": [
    {"id": "m-f", "label": "f", "kind": "attention", "sub": "fwd identity · bwd all-reduce", "detail": "Every rank's fc shard reads the whole X, so dL/dX is the sum of p partial gradients."},
    {"columns": [
      [
        {"id": "m-a1", "label": "Y₁ = X A₁", "sub": "fc shard · d → 4d/p"},
        {"id": "m-gelu1", "label": "GELU(Y₁)", "kind": "ffn", "sub": "local, elementwise"},
        {"id": "m-b1", "label": "Z₁ = GELU(Y₁) B₁", "sub": "proj shard · 4d/p → d"}
      ],
      [
        {"id": "m-a2", "label": "Y₂ = X A₂", "sub": "fc shard · d → 4d/p"},
        {"id": "m-gelu2", "label": "GELU(Y₂)", "kind": "ffn", "sub": "local, elementwise"},
        {"id": "m-b2", "label": "Z₂ = GELU(Y₂) B₂", "sub": "proj shard · 4d/p → d"}
      ]
    ]},
    {"id": "m-g", "label": "g", "kind": "attention", "sub": "Z = Z₁ + Z₂, then + b", "detail": "One all-reduce of B·T·d values; the replicated bias is added after it, once."}
  ],
  "notes": [
    {"at": "m-f", "text": "**0** bytes forward"},
    {"at": "m-g", "text": "**1** all-reduce of **B·T·d** forward"}
  ]
}
:::

What goes wrong when one piece is wrong. The first three fail the step-1 self-test; the fourth raises in
backward:

| mistake | what you see | why |
|---|---|---|
| f is the identity in backward too | \`x.grad\` differs across ranks, each \`1/p\`-ish of the truth | each rank keeps only its shard's partial dL/dX |
| bias inside the row-parallel matmul | output off by \`(p − 1) · b\` | g sums the bias \`p\` times |
| g all-reduces in backward too | input gradients \`p\` times too large | the incoming gradient is already whole and the same on every rank |
| an in-place all-reduce on a tensor autograd saved | "modified by an inplace operation" at \`backward()\` | the version counter catches it; the \`.clone()\` makes f and g safe anywhere |

:::quiz
Q: A column-parallel layer's f is accidentally the identity in both directions. Forward outputs are exact. What breaks?
- [ ] Nothing: the weight gradients of the shard are still correct, so training is unaffected
- [x] The gradient flowing into the replicated part (LayerNorm, residual stream) is a different partial sum on each rank, so the replicas drift apart
- [ ] The forward deadlocks, because the row layer waits for an all-reduce that never comes
> The weight gradient of each shard only needs its own output gradient, so it is right. But dL/dX is
> the sum over every shard that read X, and without f each rank sees only its own term. Everything
> upstream, which is replicated, then gets a different update on every rank: the copies stop being copies.
:::

# Column then row: one all-reduce per sublayer

The order is the design. Split the first matrix by columns and the second by rows, and the activation
between them is split by columns too: rank \`r\` holds \`GELU(X A_r)\`, exactly the slice the row-parallel
\`B_r\` needs. Reverse it and the first product is a partial sum, and the nonlinearity does not distribute
over a sum:

\`\`\`text
GELU(X₁A₁ + X₂A₂)  ≠  GELU(X₁A₁) + GELU(X₂A₂)
\`\`\`

So row then column must all-reduce the \`4d\`-wide hidden activation **before** GELU, run GELU \`p\` times
redundantly on the replicated result, and all-gather the column-split output at the end. Pick a layer and a
rank count and flip the order:

:::widget tensor-parallel {"layer": "mlp", "ranks": 8}

Per token per layer, at GPT-3 175B width (\`d = 12,288\`, bf16) and \`p = 8\`, counting what one rank sends
on a ring (an all-reduce of \`n\` values sends \`2(p − 1)/p · n\`, an all-gather \`(p − 1)/p · n\`):

| sublayer | order | forward | backward | sent per rank |
|---|---|---|---|---|
| MLP | column → row | all-reduce d | all-reduce d | 84 KiB |
| MLP | row → column | all-reduce 4d + all-gather d | all-reduce 4d + all-gather d | 378 KiB |
| attention | column → row | all-reduce d | all-reduce d | 84 KiB |
| attention | row → column | all-reduce 3d + all-gather d | all-reduce d + all-gather d | 210 KiB |

Column then row is 4.5× less traffic in the MLP, two collectives instead of four, and no redundant GELU.
Every Megatron sublayer follows it, and so does PyTorch's
[tensor-parallel plan](https://docs.pytorch.org/docs/2.14/distributed.tensor.parallel.html) for an MLP:
\`ColwiseParallel\` on the first linear, \`RowwiseParallel\` on the second.

:::quiz
Q: Why can GELU run on each rank's slice in the column-then-row MLP but not in row-then-column?
- [ ] GELU is cheap, so the redundant copy in row-then-column is harmless and only the bytes differ
- [x] After a column split each rank holds complete hidden units, and GELU is elementwise; after a row split each rank holds a partial sum of every hidden unit, and GELU of a sum is not the sum of GELUs
- [ ] GELU needs statistics over the whole hidden dimension, which only the column split provides
> The column split partitions the 4d hidden units: rank r computes units r·4d/p onward completely, so
> applying GELU to them is exact. The row split partitions the inner dimension instead, and every hidden
> unit is then a sum of p partials that has to be completed before any nonlinearity touches it.
:::

# Attention splits by head

Attention is column then row too, and the unit of the split is the head. \`qkv\` is column-parallel: rank
\`r\` computes q, k and v for heads \`r · n/p … (r+1) · n/p − 1\`, runs causal attention on those heads alone
(a head's softmax only ever looks at its own q and k), and the output projection \`W_o\` is row-parallel
over the same heads' columns. One all-reduce forward, one backward, exactly like the MLP. It requires
\`n_heads % p == 0\`: GPT-3's 96 heads allow any divisor of 96, which inside an 8-GPU node means 1, 2, 3, 4, 6
or 8.

The trap is the fused weight. GPT-2's checkpoint stores \`qkv\` (\`c_attn\`) as \`[Q; K; V]\`, each block
ordered by head. Rank \`r\` needs **its** heads' rows from each of the three blocks, not a contiguous third:

:::gpu
{
  "layout": "column",
  "align": "start",
  "items": [
    {"id": "qkv-by-head", "array": "W_qkv rows · sharded by head", "sub": "4 heads, p = 2 · cell = one head", "tone": "global", "cols": 12, "cells": ["q0", "q1", "q2", "q3", "k0", "k1", "k2", "k3", "v0", "v1", "v2", "v3"], "marks": [{"cols": [0, 1], "tone": "a", "label": "r0"}, {"cols": [2, 3], "tone": "b", "label": "r1"}, {"cols": [4, 5], "tone": "a", "label": "r0"}, {"cols": [6, 7], "tone": "b", "label": "r1"}, {"cols": [8, 9], "tone": "a", "label": "r0"}, {"cols": [10, 11], "tone": "b", "label": "r1"}], "detail": "torch.cat([w_q[heads], w_k[heads], w_v[heads]]): rank 0 gets q, k and v of heads 0 and 1."},
    {"id": "qkv-chunk", "array": "W_qkv rows · chunk(2, dim=0)", "sub": "the naive split of the fused weight", "tone": "global", "cols": 12, "cells": ["q0", "q1", "q2", "q3", "k0", "k1", "k2", "k3", "v0", "v1", "v2", "v3"], "marks": [{"cols": [0, 5], "tone": "bad", "label": "rank 0"}, {"cols": [6, 11], "tone": "bad", "label": "rank 1"}], "detail": "Rank 0 would score q of four heads against k of two and have no v at all: shapes may even line up, the numbers do not."}
  ]
}
:::

Megatron avoids the regrouping by storing its \`linear_qkv\` interleaved per head group, so a plain chunk is
correct for its own checkpoints; converting a checkpoint between the two layouts is a common source of
silently wrong models. With grouped-query attention \`p\` must divide the number of KV heads as well; with
fewer KV heads than ranks, each KV head is replicated on \`p / n_kv\` ranks.

:::quiz
Q: Why does tensor-parallel attention need no communication between the qkv projection and the output projection?
- [ ] Because the all-reduce of f already gave every rank all the keys and values
- [x] Because each head lives entirely on one rank: its q, k and v come from that rank's column shard, and the softmax over keys is within the head
- [ ] Because causal masking makes each position depend only on itself
> Heads are independent until W_o mixes them. Assigning whole heads to ranks keeps everything up to the
> merged head outputs local, and the row-parallel W_o turns the mixing into partial sums that g adds.
:::

# The vocabulary: embedding and loss without the full logits

The two ends of the model are split by vocabulary, the paper's column split of the \`h × V\` table \`E\`. For
the lookup that dimension is contracted (a one-hot \`(B, T, V)\` times the table), so
\`VocabParallelEmbedding\` acts as a row-parallel layer: rank \`r\` holds ids \`[r · V/p, (r+1) · V/p)\`, rows of
the \`(V, d)\` \`nn.Embedding\` weight.
An id outside that range looks up a dummy row whose output is then zeroed, and g
sums the \`p\` vectors, of which exactly one is non-zero. The head, tied to that shard, is column-parallel
behind f: each rank produces \`(B, T, V/p)\` logits for the ids it owns. Gathering them would cost \`V\` floats per token and a
\`B · T · V\` buffer on every rank, which at Llama 3's 128,256-token vocabulary is the largest tensor in the
model. The loss needs only two global numbers per token, plus the target logit from its owner:

\`\`\`text
m   = all_reduce_MAX( max_v z_v )                      one float per token
S   = all_reduce_SUM( Σ_v exp(z_v − m) )               one float per token
z_t = all_reduce_SUM( z_target − m if owned else 0 )   one float per token
loss = log S − z_t
dL/dz_v = softmax_v − [v == target]                    local: both terms are on this shard
\`\`\`

:::architecture
{
  "input": "logits · (B, T, V/p) on rank r, target · (B, T)",
  "output": "loss · (B, T), the same on every rank",
  "items": [
    {"id": "v-max", "label": "Global max m", "sub": "local max → all-reduce MAX", "detail": "Subtracting the global max keeps exp() finite on every shard, and every rank shifts by the same m."},
    {"columns": [
      [{"id": "v-sum", "label": "Sum of exps S", "sub": "Σ exp(z − m) → all-reduce SUM"}],
      [{"id": "v-target", "label": "Target logit z_t − m", "sub": "owner only, else 0 → SUM", "detail": "The rank whose range holds the target gathers its logit; the others contribute 0."}]
    ]},
    {"id": "v-loss", "label": "loss = log S − (z_t − m)", "kind": "loss", "sub": "custom autograd Function", "side": {"label": "backward", "sub": "softmax − one-hot, local"}}
  ],
  "notes": [
    {"at": "v-max", "text": "**3** all-reduces of **1 float** per token"},
    {"at": "v-loss", "text": "Gradient needs **no** communication"}
  ]
}
:::

| per token, fp32 | gather the logits | vocab-parallel loss |
|---|---|---|
| GPT-2, V = 50,257 | 201 KB gathered, 201 KB held | 12 B, V/p logits held |
| Llama 3, V = 128,256 | 513 KB gathered, 513 KB held | 12 B, V/p logits held |

The max is not optional. The step-3 self-test feeds logits with one entry at 1,000: \`exp(1000)\` is
\`inf\` in float32 (the limit is about 88.7), and a loss without the global max shift returns \`nan\` where
\`F.cross_entropy\` returns a finite number. The MAX has to be global, too: a per-shard max would give each
rank's partial sum a different scale, and the SUM would add incompatible numbers.

:::quiz
Q: Rank 2 of 4 owns the target id. What does each rank contribute to the all-reduce of the target logit, and why does that work?
- [ ] Every rank contributes its local max, and the owner subtracts the rest
- [x] Rank 2 contributes its shifted logit at the target, the other three contribute 0, so the SUM is exactly the target logit on every rank
- [ ] Rank 2 broadcasts the logit and the other ranks skip the collective
> A SUM where only one term is non-zero is a broadcast that every rank already participates in, so the
> code is the same on every rank and no rank needs to know who the owner is. The same trick makes the
> embedding work: a zeroed row for a foreign id.
:::

# What the collectives cost, and what production adds

Per layer per training step, TP issues four all-reduces of \`B · T · d\` values (two forward, two backward),
on the critical path: no rank can start the next sublayer until the sum arrives. That is why TP stays
inside a server. [Narayanan et al., 2021](https://arxiv.org/abs/2104.04473) quantify it and compose TP
with pipeline and data parallelism (PTD-P): TP up to the 8 GPUs that share NVLink, pipeline stages across
nodes, data parallelism over the rest, reaching 502 petaFLOP/s on 3,072 GPUs for a one-trillion-parameter
model. Across servers the same all-reduces would be far slower: in that paper's DGX A100 cluster a GPU has
300 GB/s of NVLink each way and one 200 Gb/s (25 GB/s) InfiniBand card, 12× less.

| concern | this problem | Megatron-LM in production |
|---|---|---|
| transport | gloo over loopback, CPU | NCCL over NVLink |
| rendezvous | a file store in a temp dir | TCP store, \`torchrun\` |
| overlap | none | input-gradient all-reduce overlapped with the weight-gradient GEMM |
| replicated LayerNorm and dropout | \`p\` copies of their activations | sequence parallelism: split along T |
| init | sharded from a dense model | each shard drawn on its GPU from a tracked RNG (depends on \`p\`), or with \`use_cpu_initialization\` a master weight drawn whole, then split |
| dropout | none | a per-rank CUDA RNG state for split regions |

Sequence parallelism ([Korthikanti et al., 2022](https://arxiv.org/abs/2205.05198)) attacks the replicated
regions: LayerNorm and dropout run on a \`T/p\` slice of the sequence, and each all-reduce becomes a
reduce-scatter (into the sequence-split region) plus an all-gather (out of it), the same total volume.
With selective activation recomputation it cuts activation memory by 5× and removes over 90% of the
recomputation overhead. [Megatron-LM](https://github.com/NVIDIA/Megatron-LM) implements all of it in
\`megatron/core/tensor_parallel\`, and the
[Ultra-Scale Playbook](https://huggingface.co/spaces/nanotron/ultrascale-playbook) walks through the same
operators with measured throughput.

:::quiz
Q: Why do large runs keep tensor parallelism within one 8-GPU server and use pipeline or data parallelism across servers?
- [ ] Because tensor parallelism only works up to 8 ranks for mathematical reasons
- [x] Because TP puts several all-reduces of activations on the critical path of every layer, which only NVLink's bandwidth makes cheap; pipeline and data parallelism communicate less often or overlap it
- [ ] Because the model's heads are always a multiple of 8
> TP's communication is synchronous and per layer: four activation all-reduces per layer per step that
> the next matmul waits for. Pipeline parallelism sends one activation per stage boundary, data
> parallelism one gradient all-reduce per step that overlaps the backward pass, so they tolerate slower links.
:::

# What to take away

- Two operators are the whole method: f (identity forward, all-reduce backward) and g (all-reduce forward,
  identity backward), each the other's transpose.
- Column-parallel behind f, row-parallel in front of g: everything between them (GELU, whole attention
  heads) stays local, and a sublayer costs one all-reduce each way. The reverse order costs four
  collectives and a redundant nonlinearity.
- Attention splits by head; a fused \`[Q; K; V]\` weight must be sharded within each of q, k and v, never
  chunked as one block.
- The vocabulary end needs no gather: a masked embedding plus g, a tied head on the shard, and a
  cross-entropy from three all-reduces of one float per token, with a local softmax-minus-one-hot backward.
- Replicated regions (LayerNorm, the residual stream) get identical gradients only because f sums them;
  sequence parallelism later splits even those.

Primary source: [Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism](https://arxiv.org/abs/1909.08053).
`;
