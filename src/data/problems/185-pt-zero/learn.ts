/**
 * The learning guide for ZeRO from scratch: data parallelism and its collectives, DDP's buckets and
 * overlap, where the 16 bytes per parameter go, ZeRO-1's sharded optimizer and ZeRO-3's per-layer
 * gather. Rendered at `/pt-zero/learn`.
 */
export const learn = `# The system at a glance

Data-parallel training runs one model on N ranks (GPUs, here processes). Each rank holds a replica,
runs forward and backward on its own slice of the batch, and the ranks average their gradients before
the optimizer step, so every replica takes the same step and stays identical. PyTorch's
\`DistributedDataParallel\` (DDP) is the standard implementation; its design is described in
[PyTorch Distributed](https://arxiv.org/abs/2006.15704) (Li et al., VLDB 2020).

DDP replicates everything, and for large models that is the problem. Mixed-precision Adam keeps 16
bytes per parameter on every rank, so adding GPUs adds compute but never memory headroom.
[ZeRO](https://arxiv.org/abs/1910.02054) (Rajbhandari et al., Microsoft, SC 2020) removes the
replication in three stages, and PyTorch's [FSDP](https://arxiv.org/abs/2304.11277) is its stage 3 as a
PyTorch module. The problem builds the path in three files, on real gloo processes:

| File | Builds | Per-rank memory it reaches |
|---|---|---|
| \`ddp.py\` | \`broadcast_parameters\`, \`GradBucketer\` | 2Ψ + 2Ψ + 12Ψ |
| \`zero1.py\` | \`reduce_scatter_\`, \`all_gather_\`, \`ShardedAdamW\` | 2Ψ + 2Ψ + 12Ψ/N |
| \`zero3.py\` | \`GatheredLinear\`, \`ShardedLinear\`, \`shard_module\` | (2 + 2 + 12)Ψ/N + one layer |

One DDP training step, as \`ddp.py\` runs it:

:::architecture
{
  "input": "this rank's micro-batch · x.chunk(N)[r]",
  "output": "identical replicas on every rank",
  "items": [
    {"id": "g-fwd", "label": "Forward on the replica", "sub": "model(x_r) · 16/N rows", "detail": "Every rank runs the whole model on its own rows; nothing is communicated in forward."},
    {"id": "g-loss", "label": "Local loss", "kind": "loss", "sub": "mse_loss(·, y_r) · mean of N rows", "detail": "The mean over this rank's rows. With equal shards, the mean of the N local means is the full batch's mean."},
    {"tone": "block", "repeat": "4 buckets ×", "label": "Backward, last layer first", "items": [
      {"id": "g-hook", "label": "Gradients land in a bucket", "sub": "post-accumulate hook · copy .grad", "detail": "\`register_post_accumulate_grad_hook\` fires once \`p.grad\` is final; the hook copies it into its slot of the bucket's flat buffer."},
      {"id": "g-launch", "label": "Async all-reduce", "kind": "attention", "sub": "dist.all_reduce(buf, async_op=True)", "detail": "Launched the moment the bucket is complete, in bucket order on every rank. Autograd keeps computing the earlier layers meanwhile."}
    ]},
    {"id": "g-wait", "label": "Wait and average", "sub": "work.wait() · buf / N → .grad", "detail": "\`finish()\` waits on every handle, divides by the world size and copies the means back into \`.grad\`."},
    {"id": "g-step", "label": "AdamW step", "sub": "same gradient, same step everywhere", "detail": "Each rank runs \`torch.optim.AdamW\` on identical parameters with identical gradients, so the replicas stay bitwise equal."}
  ],
  "notes": [
    {"at": "g-launch", "text": "Bucket 0 leaves after **4** of 10 gradients"},
    {"at": "g-wait", "text": "About **2Ψ** sent per rank per step"}
  ]
}
:::

In a modern pre-training run this is one axis of three. Tensor parallelism splits each matrix
multiply across the GPUs of a node, pipeline parallelism splits the layers across nodes, and data
parallelism, usually as ZeRO or FSDP, replicates or shards whatever is left across the remaining ranks.
Data parallelism is the axis that scales the batch, and the only one that needs no change to the model's
code: the model runs unchanged on every rank, and all of the machinery lives in hooks around backward
and in the optimizer step.

The figures that matter for the rest of this guide are the memory per rank, the traffic per step, and
when each byte must exist.

:::widget zero-memory {"psi": 7.5, "gpus": 64, "stage": "ddp"}

# Averaging gradients across ranks

Split a batch of B examples into N equal shards. Rank r computes the gradient of the mean loss over its
B/N examples. Because the gradient is linear in the loss, the mean of the N shard gradients is the
gradient of the full batch's mean loss:

\`\`\`text
g_full = (1/B) Σ_i ∇ℓ_i = (1/N) Σ_r (N/B) Σ_{i in shard r} ∇ℓ_i = (1/N) Σ_r g_r
\`\`\`

So data parallelism needs one collective: sum the gradients over ranks (an all-reduce), then divide by
N. The ranks must also start equal, which is what \`broadcast_parameters\` does: in the self-test every
rank seeds its model differently, and only rank 0's weights survive the broadcast.

The collectives this problem uses, and what each leaves on rank r:

| Collective | Input on each rank | Result on rank r | Bytes sent per rank (ring) |
|---|---|---|---|
| broadcast | rank src's tensor | the same tensor | about Ψ |
| all-reduce | a tensor of Ψ | the sum, all Ψ | 2Ψ(N − 1)/N |
| reduce-scatter | a tensor of Ψ | the sum of shard r, Ψ/N | Ψ(N − 1)/N |
| all-gather | one shard of Ψ/N | all N shards, Ψ | Ψ(N − 1)/N |

A ring all-reduce *is* a reduce-scatter followed by an all-gather, which is why its cost is 2Ψ and
nearly independent of N. ZeRO's communication argument rests on that identity: ZeRO-1 and ZeRO-2
replace the all-reduce by its two halves and pay nothing extra.

:::quiz
Q: Four ranks each compute the mean loss over 4 of 16 examples and all-reduce their gradients. What must happen before \`optimizer.step()\` for the result to equal one process on all 16?
- [ ] Nothing: the all-reduce already averages
- [x] Divide the summed gradient by 4
- [ ] Multiply the learning rate by 4
> An all-reduce sums. Each local gradient is already a mean over its 4 examples, so the sum is 4 times the full-batch mean; dividing by the world size gives it back. Scaling the learning rate instead is equivalent only for SGD, not for Adam, whose update is invariant to gradient scale.
:::

# Buckets and overlap

The naive version waits for backward to finish and then all-reduces each \`.grad\` tensor one by one.
Both halves of that are slow. A collective costs a fixed latency plus bytes over bandwidth, so hundreds
of small calls pay the latency hundreds of times. And waiting for the end of backward leaves the network
idle while the GPU computes, then the GPU idle while the network works.

DDP fixes both with **buckets**. Parameters are grouped, in reverse of \`model.parameters()\`, into
buckets of about 25 MB (the first one 1 MiB). Backward produces gradients roughly last layer first, so
the first bucket fills after a few layers, and its all-reduce runs while autograd computes the rest. In
the self-test, with an 8,192-byte cap on a float64 MLP:

| Bucket | Parameters | Launched after |
|---|---|---|
| 0 | \`8.bias\`, \`8.weight\`, \`6.bias\`, \`6.weight\` | gradient 4 of 10 |
| 1 | \`4.bias\`, \`4.weight\` | gradient 6 |
| 2 | \`2.bias\`, \`2.weight\` | gradient 8 |
| 3 | \`0.bias\`, \`0.weight\` | gradient 10 |

The trigger is \`register_post_accumulate_grad_hook\`, which fires after \`.grad\` holds this backward's
final value, also for a parameter used twice. The hook copies the gradient into the bucket's flat
buffer and, when the bucket is complete, calls \`dist.all_reduce(buf, async_op=True)\`, which returns a
work handle at once. \`finish()\` waits on all of them before the step.

What goes wrong without each piece:

| Mistake | What happens |
|---|---|
| No broadcast at start | Replicas start apart and stay apart; averaged gradients cannot fix that |
| Tensor \`register_hook\` instead of post-accumulate | The hook sees a gradient before it is accumulated into \`.grad\`; a shared parameter is sent twice, partially |
| Launch whichever bucket completes first | Ranks may issue bucket 2 before bucket 1 in different orders; gloo pairs the wrong buffers, or hangs |
| Read the buffer without \`wait()\` | The step uses a partially reduced gradient |
| No division by N | The update uses N times the gradient; SGD diverges, Adam hides it until weight decay and eps matter |

Launch order is the subtle one. Every rank must issue the same collectives in the same order, because
the backend matches the k-th call on one rank with the k-th call on the others. Launching strictly in
bucket order makes the sequence deterministic even if hooks fire in a slightly different order.

:::details Why the self-tests run in float64
DDP and a single process sum the same numbers in a different order, so their gradients differ in the
last bit. Adam divides by \`√v\`: for an entry whose gradient is near zero by cancellation, a last-bit
difference can flip the sign of the update, a whole \`lr\` apart. In float32 this MLP ends about 1e-7 from
the single process after 5 steps, but a 16 → 64 → 64 → 4 variant ended 2e-5 apart, with both runs
correct. In float64 the difference stays near 1e-15, so the 1e-6 tolerance tests the mechanism and
not the luck of the data.
:::

:::quiz
Q: Why are the buckets filled in reverse parameter order?
- [ ] The all-reduce is faster for the last layers
- [x] Backward produces the last layers' gradients first, so their bucket can be sent while earlier layers are still computing
- [ ] It keeps the buffers aligned in memory
> Reverse order matches the order in which gradients become ready. The first bucket closes early in backward and its communication overlaps the remaining computation; in forward order, nothing could be sent until the end.
:::

# Where the memory goes

Training with Adam in mixed precision keeps, per parameter:

| What | Format | Bytes per parameter | ZeRO's name |
|---|---|---|---|
| Weights used in forward and backward | fp16 or bf16 | 2 | parameters |
| Gradients | fp16 or bf16 | 2 | gradients |
| Master weights | fp32 | 4 | optimizer states |
| Adam's first moment \`m\` | fp32 | 4 | optimizer states |
| Adam's second moment \`v\` | fp32 | 4 | optimizer states |

That is 2Ψ + 2Ψ + KΨ with K = 12: 16Ψ bytes, before activations. A 7.5B-parameter model needs 120 GB on
every GPU under DDP, more than one 80 GB device, whether there are 8 GPUs or 1,024. ZeRO partitions the
three terms one at a time:

\`\`\`text
DDP        2Ψ + 2Ψ + 12Ψ          7.5B, N = 64: 120 GB
ZeRO-1     2Ψ + 2Ψ + 12Ψ/N                      31.4 GB
ZeRO-2     2Ψ + (2 + 12)Ψ/N                     16.6 GB
ZeRO-3     (2 + 2 + 12)Ψ/N                       1.9 GB
\`\`\`

Move Ψ and N in the widget: ZeRO-1 already removes most of the memory because the optimizer state is
three quarters of it, and ZeRO-3 is the only stage whose memory keeps falling as N grows.

:::widget zero-memory {"psi": 7.5, "gpus": 64, "stage": "zero1"}

:::quiz
Q: A 13B model trains with DDP on 64 GPUs. Which single change cuts the most memory per GPU?
- [ ] Sharding the gradients only
- [x] Sharding the optimizer states only
- [ ] Sharding the fp16 weights only
> The fp32 master weights and both moments are 12 of the 16 bytes per parameter. Sharding them over 64 ranks takes 208 GB down to about 54.4 GB; sharding either 2-byte term alone saves under 26 GB.
:::

# ZeRO-1: shard the optimizer

Adam is elementwise. Element i's update needs element i's gradient and element i's two moments, and
nothing else. So the state can be cut into N pieces with no communication between them: rank r keeps
\`m\` and \`v\` for its slice, updates that slice, and sends the result to everyone.

\`ShardedAdamW\` makes the slices cheap with a flat view. All parameters are copied into one buffer padded
to a multiple of N, and each parameter's \`.data\` is re-pointed into it, so the model's tensors *are*
slices of the buffer:

\`\`\`text
numel = 3,811        N = 4:  padded = 3,812, S = 953
flat:  [ rank 0: 0 … 952 | rank 1: 953 … 1,905 | rank 2: … | rank 3: … 3,811 (1 pad) ]
step:  flat_grad ── reduce to owners ──▶ g[r·S : (r+1)·S] / N
       AdamW on flat[r·S : (r+1)·S] with m, v of length S
       all_gather(shards) ──▶ flat   (the model's parameters, in place)
\`\`\`

The padding is harmless: its gradient is zero, so \`m = v = 0\`, the update is \`0 / (0 + eps) = 0\`, and
decay keeps zero at zero. The traffic is a reduce-scatter of the gradients and an all-gather of the
parameters, the two halves of DDP's all-reduce, so ZeRO-1 costs no extra bandwidth. Gloo in PyTorch 2.0
has no reduce-scatter, so \`reduce_scatter_\` emulates it with one \`dist.reduce\` per shard, each to its
owner. The self-test checks equality with DDP and \`torch.optim.AdamW\` within 1e-6, and that
\`state_numel() · N == 2 · padded\`.

This file still computes the full flat gradient on every rank and keeps it; only the owned slice is
meaningful after the reduce. Freeing the rest as soon as each bucket is reduced is ZeRO-2, which takes
gradient memory from 2Ψ to 2Ψ/N for the same traffic.

:::quiz
Q: Why does ZeRO-1 move no more data per step than DDP?
- [ ] Because it only sends the optimizer states
- [x] Because reduce-scatter plus all-gather is exactly what a ring all-reduce already does
- [ ] Because each rank only sends its own gradients once
> A ring all-reduce is a reduce-scatter (each rank ends with the sum of one shard) followed by an all-gather (every rank collects all shards). ZeRO-1 runs the optimizer between the two halves, on the shard each rank already has, and gathers parameters instead of gradients.
:::

# ZeRO-3: shard the parameters

After ZeRO-1 and ZeRO-2, every rank still holds the 2Ψ of weights. ZeRO-3 observes that a layer's
weight is only needed while that layer runs. Each \`ShardedLinear\` keeps one padded flat shard of its
\`[weight, bias]\`; \`GatheredLinear\`, a custom \`torch.autograd.Function\`, assembles the full weight by an
all-gather at the start of forward, drops it when forward returns, assembles it again in backward, and
reduce-scatters the weight gradient so each rank keeps its shard's mean. The optimizer only sees shard
parameters, so a stock \`torch.optim.AdamW\` is already sharded.

The custom function decides the memory, through what it saves for backward. The failure is to save the
gathered weight:

:::gpu
{
  "layout": "row",
  "align": "start",
  "items": [
    {"id": "ok", "label": "Saves only x", "sub": "peak: shards + one layer", "layout": "column", "items": [
      {"array": "weight shards", "sub": "1/N of each layer, always", "cols": 5, "cells": ["L0", "L1", "L2", "L3", "L4"], "tone": "global"},
      {"array": "gathered during forward of L2", "cols": 5, "cells": ["L0", "L1", "L2", "L3", "L4"], "tone": "global", "marks": [{"cols": [0, 1], "tone": "muted"}, {"cols": [2, 2], "tone": "a", "label": "alive"}, {"cols": [3, 4], "tone": "muted"}], "detail": "\`ctx.save_for_backward(x)\` only: the gathered buffer has no reference after \`forward\` returns, so CPython frees it. \`METER.peak\` = 1,056 numbers."}
    ]},
    {"gap": "vs"},
    {"id": "bad", "label": "Saves W in ctx", "sub": "peak: shards + every layer", "layout": "column", "items": [
      {"array": "weight shards", "sub": "1/N of each layer, always", "cols": 5, "cells": ["L0", "L1", "L2", "L3", "L4"], "tone": "global"},
      {"array": "gathered at the end of forward", "cols": 5, "cells": ["L0", "L1", "L2", "L3", "L4"], "tone": "global", "marks": [{"cols": [0, 4], "tone": "bad", "label": "all alive until backward"}], "detail": "\`ctx.save_for_backward(x, weight)\` keeps every layer's full weight from its forward to its backward: DDP's 2Ψ of weights plus ZeRO-3's traffic."}
    ]}
  ]
}
:::

The self-test counts it. \`METER.track\` registers a finalizer on the gathered buffer and its two views,
so a buffer counts as alive until the last of them is collected. The solution peaks at 1,056 numbers,
one 32 × 32 layer with its bias, and leaves nothing alive after a step:

| N | Shards per rank | Peak gathered | Total | DDP |
|---|---|---|---|---|
| 2 | 1,906 | 1,056 | 2,962 | 3,811 |
| 4 | 953 | 1,056 | 2,009 | 3,811 |

The price is communication. Per step, every rank all-gathers the weights in forward (Ψ), again in
backward (Ψ), and reduce-scatters the gradients (Ψ): 3Ψ against DDP's 2Ψ, the 1.5× the ZeRO paper
reports. Production systems hide it by prefetching layer ℓ + 1's gather while layer ℓ computes, and by
grouping each transformer block's parameters into one flat unit so each collective is large.

FSDP is this design as a PyTorch wrapper. Each wrapped unit (typically one transformer block) owns one
flat parameter sharded across ranks, gathers it in a pre-forward hook, frees it in a post-forward hook,
and repeats both around backward. It can keep a unit gathered between forward and backward when memory
allows (\`reshard_after_forward=False\`, ZeRO-2's trade), and shard within a node while replicating across
nodes (hybrid sharding), so that the expensive all-gathers stay on the fast intra-node links.

:::widget zero-memory {"psi": 70, "gpus": 256, "stage": "zero3"}

:::quiz
Q: In \`GatheredLinear.forward\`, what should \`ctx.save_for_backward\` receive?
- [ ] The input and the gathered weight, so backward does not need a second all-gather
- [x] Only the input; backward gathers the weight again
- [ ] Nothing; backward recomputes the input as well
> Saving the weight keeps every layer's full weight alive from its forward to its backward, which is exactly the memory ZeRO-3 exists to remove. The second all-gather is the extra Ψ of traffic that buys it. Recomputing the input is activation checkpointing, a separate trade.
:::

# What to take away

- Data parallelism is one identity: the mean of equal shards' mean gradients is the full batch's
  gradient. Broadcast first, all-reduce, divide by N.
- DDP's speed is overlap: buckets in reverse order, launched by post-accumulate hooks as soon as they
  fill, in the same order on every rank, and waited on only before the step.
- Mixed-precision Adam costs 16 bytes per parameter, 12 of them optimizer state; DDP replicates all 16.
- ZeRO-1 shards the state because Adam is elementwise, and costs no extra traffic, since reduce-scatter
  plus all-gather is an all-reduce.
- ZeRO-3 keeps each layer whole only inside its forward and backward, for 1.5× DDP's traffic; a custom
  autograd function that saves the input and not the weight is what makes it real.

Primary reference: Rajbhandari et al., [ZeRO: Memory Optimizations Toward Training Trillion Parameter Models](https://arxiv.org/abs/1910.02054) (SC 2020), implemented in [DeepSpeed](https://github.com/deepspeedai/DeepSpeed); the [Ultra-Scale Playbook](https://huggingface.co/spaces/nanotron/ultrascale-playbook) walks through the same stages at GPU-cluster scale.
`;
