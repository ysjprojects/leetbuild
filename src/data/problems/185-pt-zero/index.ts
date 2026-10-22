import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {ddpStep} from './steps/1-ddp';
import {zero1Step} from './steps/2-zero1';
import {zero3Step} from './steps/3-zero3';

/**
 * Deep-learning problem: data parallelism from scratch up to ZeRO-3, in real gloo processes: a
 * bucketed async all-reduce driven by post-accumulate-grad hooks, AdamW with its moments sharded over
 * the ranks, and layers whose full weight exists only inside their forward and backward.
 */
export const ptZeroProblem: Problem = {
  id: 'pt-zero',
  title: 'ZeRO from scratch: DDP buckets, sharded AdamW, ZeRO-3',
  tagline:
    'Train one model on several real processes: average gradients with bucketed async all-reduces during backward, shard AdamW’s moments across ranks, then shard the weights so each layer exists whole only while it runs.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 120,
  statement: `# ZeRO from scratch: DDP buckets, sharded AdamW, ZeRO-3

Data parallelism is how almost every large model is trained: N ranks each hold the model, each runs
forward and backward on its own slice of the batch, and the gradients are averaged before the step so
every replica takes the same step. PyTorch's \`DistributedDataParallel\` (Li et al., VLDB 2020) does the
averaging with bucketed all-reduces that overlap backward. Replication has a price: mixed-precision Adam
keeps 16 bytes per parameter (fp16 weights and gradients, fp32 master weights and two moments), so a
7.5B-parameter model needs 120 GB on every GPU however many GPUs there are. ZeRO (Rajbhandari et al.,
Microsoft DeepSpeed, SC 2020) removes the redundancy in three stages: shard the optimizer states (ZeRO-1),
the gradients too (ZeRO-2), and the parameters too (ZeRO-3), which PyTorch ships as FSDP. Every LLM
pre-training stack today runs one of these, usually beside tensor and pipeline parallelism.

You write three files, each importing the previous one. Everything runs as real processes:
\`torch.multiprocessing.spawn\` with the \`gloo\` backend on CPU, world sizes 2 and 4.

- \`ddp.py\`:
  - \`setup(rank, world_size, init_file)\` joins a gloo group; \`run_ranks(worker, world_size, *args) -> list\`
    spawns the ranks and returns each one's result (given).
  - \`broadcast_parameters(module, src=0)\` copies rank \`src\`'s parameters and buffers to every rank.
  - \`GradBucketer(module, bucket_cap_bytes)\`: \`buckets\` (lists of parameters in reverse order, each closed
    once it reaches the byte cap), one flat buffer per bucket, a \`register_post_accumulate_grad_hook\` on
    every parameter that launches \`dist.all_reduce(buf, async_op=True)\` when its bucket is complete, and
    \`finish()\`, which waits, divides by the world size and writes the mean back into every \`.grad\`.
- \`zero1.py\`:
  - \`reduce_scatter_(flat) -> shard\` and \`all_gather_(flat, shard)\` over a flat tensor whose length is a
    multiple of the world size.
  - \`ShardedAdamW(params, lr, betas, eps, weight_decay)\`: the parameters re-pointed into one flat buffer
    padded to a multiple of the world size, \`exp_avg\` and \`exp_avg_sq\` for this rank's shard only, and
    \`step()\`: reduce the gradients to their owners, AdamW on the own shard, all-gather the parameters.
- \`zero3.py\`:
  - \`GatheredLinear\`, a \`torch.autograd.Function\` that all-gathers the weight in forward and again in
    backward, saves only the input, and reduce-scatters the weight gradient to the shard.
  - \`ShardedLinear(linear)\` holding \`shard\`, this rank's slice of the padded flat \`[weight, bias]\`, with
    \`gather() -> (weight, bias)\`.
  - \`shard_module(model)\`, which replaces every \`nn.Linear\` with a \`ShardedLinear\`.

The self-tests use a 5-layer MLP (16 → 32 → 32 → 32 → 32 → 3, Tanh, 3,811 parameters) in float64, 16
examples split evenly across the ranks, and 5 AdamW steps at \`lr = 1e-2\`.

## What you build here

1. **DDP**: the process group, the parameter broadcast, and the gradient bucketer whose all-reduces start
   during backward; its parameters match a single process on the full batch.
2. **ZeRO-1**: AdamW over a padded flat view whose moments live on one rank per shard, with gradients
   reduced to their owners and parameters all-gathered after the update; it matches DDP with
   \`torch.optim.AdamW\` while each rank keeps 1/N of the state.
3. **ZeRO-3**: layers stored as shards whose full weight is gathered for forward, freed, gathered again for
   backward and freed, with the gradient reduce-scattered to the shard; it matches DDP while at most one
   layer is whole on any rank.

## Run it on your machine

\`\`\`text
python ddp.py && python zero1.py && python zero3.py
\`\`\`

PyTorch 2.1 or newer (for \`register_post_accumulate_grad_hook\`), CPU only, no GPU needed. Each file spawns
2 and then 4 processes and finishes in about 5 to 10 s on a laptop. \`PASS\` means: the DDP parameters equal
the single-process ones within 1e-6, with exactly one all-reduce per bucket per step, the first one
launched while backward is still running; ZeRO-1 equals DDP within 1e-6 with 2·padded/N moment numbers
per rank; ZeRO-3 equals DDP within 1e-6, its gradients are shard-sized, and the gathered full weights alive
at any moment never exceed one layer.

## Left out on purpose

NCCL and GPUs, fp16/bf16 compute with fp32 master weights (the self-tests use float64 so that
AdamW's normalisation cannot amplify the last-bit differences between reduction orders), gradient
accumulation and \`no_sync\`, prefetching the next layer's gather, ZeRO-2 as a separate stage,
ZeRO-Offload and ZeRO-Infinity, hybrid sharding across nodes, checkpointing a sharded state, mixed
precision collectives, and multi-node rendezvous through a TCP store.`,
  figures: [
    {
      title: 'Who holds what',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'stage-ddp',
            label: 'DDP',
            sub: '16Ψ per rank',
            detail:
              'Data parallelism (step 1): every rank holds every byte in its HBM; only the batch is split. The gradient array is cut into buckets `b3` … `b0`, each averaged by one async all-reduce.',
            items: [
              {
                id: 'ddp-r0',
                label: 'Rank 0',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    detail:
                      'The whole model on every rank, identical after `broadcast_parameters` and after every step.',
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'global', label: 'b3'},
                      {cols: [2, 3], tone: 'b', label: 'b2'},
                      {cols: [4, 5], tone: 'global', label: 'b1'},
                      {cols: [6, 7], tone: 'b', label: 'b0'},
                    ],
                    detail:
                      'Four buckets in reverse parameter order: `b0` (the last layer) is all-reduced while backward still computes `b1` … `b3`.',
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    detail:
                      '`torch.optim.AdamW` keeps both moments for every parameter on every rank: 12Ψ bytes in mixed precision, replicated N times.',
                  },
                ],
              },
              {
                id: 'ddp-r1',
                label: 'Rank 1',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'global', label: 'b3'},
                      {cols: [2, 3], tone: 'b', label: 'b2'},
                      {cols: [4, 5], tone: 'global', label: 'b1'},
                      {cols: [6, 7], tone: 'b', label: 'b0'},
                    ],
                  },
                  {array: 'Adam m, v', cols: 8},
                ],
              },
              {
                id: 'ddp-r2',
                label: 'Rank 2',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'global', label: 'b3'},
                      {cols: [2, 3], tone: 'b', label: 'b2'},
                      {cols: [4, 5], tone: 'global', label: 'b1'},
                      {cols: [6, 7], tone: 'b', label: 'b0'},
                    ],
                  },
                  {array: 'Adam m, v', cols: 8},
                ],
              },
              {
                id: 'ddp-r3',
                label: 'Rank 3',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'global', label: 'b3'},
                      {cols: [2, 3], tone: 'b', label: 'b2'},
                      {cols: [4, 5], tone: 'global', label: 'b1'},
                      {cols: [6, 7], tone: 'b', label: 'b0'},
                    ],
                  },
                  {array: 'Adam m, v', cols: 8},
                ],
              },
            ],
          },
          {
            id: 'stage-zero1',
            label: 'ZeRO-1',
            sub: '4Ψ + 12Ψ/N per rank',
            detail:
              "Optimizer states partitioned (step 2): coloured cells are this rank's shard of the gradients and of Adam's m and v, grey cells are held by other ranks. Rank r updates only its shard of the flat parameters, then all-gathers the shards.",
            items: [
              {
                id: 'zero1-r0',
                label: 'Rank 0',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    detail:
                      "Still whole on every rank: the all-gather after each step refills it from the owners' updated shards.",
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [{cols: [0, 1], tone: 'b'}],
                    detail:
                      "The full flat gradient is computed locally, but only this rank's shard is reduced here; the rest is scratch.",
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'c'},
                      {cols: [2, 7], tone: 'muted'},
                    ],
                    detail:
                      '`exp_avg` and `exp_avg_sq` for `[r·S, (r+1)·S)` only: `ShardedAdamW.state_numel() · N = 2 · padded`.',
                  },
                ],
              },
              {
                id: 'zero1-r1',
                label: 'Rank 1',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {array: 'grads G', cols: 8, marks: [{cols: [2, 3], tone: 'b'}]},
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'muted'},
                      {cols: [2, 3], tone: 'c'},
                      {cols: [4, 7], tone: 'muted'},
                    ],
                  },
                ],
              },
              {
                id: 'zero1-r2',
                label: 'Rank 2',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {array: 'grads G', cols: 8, marks: [{cols: [4, 5], tone: 'b'}]},
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 3], tone: 'muted'},
                      {cols: [4, 5], tone: 'c'},
                      {cols: [6, 7], tone: 'muted'},
                    ],
                  },
                ],
              },
              {
                id: 'zero1-r3',
                label: 'Rank 3',
                layout: 'column',
                items: [
                  {array: 'params W', cols: 8},
                  {array: 'grads G', cols: 8, marks: [{cols: [6, 7], tone: 'b'}]},
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 5], tone: 'muted'},
                      {cols: [6, 7], tone: 'c'},
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: 'stage-zero3',
            label: 'ZeRO-3',
            sub: '16Ψ/N + one layer',
            detail:
              "Parameters, gradients and optimizer states partitioned (step 3): coloured cells are this rank's shard of W, G and Adam's m and v, grey cells are held by other ranks. A layer's full weight exists only inside its forward and backward.",
            items: [
              {
                id: 'zero3-r0',
                label: 'Rank 0',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'a'},
                      {cols: [2, 7], tone: 'muted'},
                    ],
                    detail:
                      "`ShardedLinear.shard`: 1/N of every layer's flat `[weight, bias]`. The full weight of one layer is gathered for its forward and again for its backward, then freed.",
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'b'},
                      {cols: [2, 7], tone: 'muted'},
                    ],
                    detail:
                      '`shard.grad`: the reduce-scatter in `GatheredLinear.backward` leaves each rank the averaged gradient of its shard only.',
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'c'},
                      {cols: [2, 7], tone: 'muted'},
                    ],
                    detail:
                      '`torch.optim.AdamW(model.parameters())` over shards: its state is already 1/N of the model.',
                  },
                ],
              },
              {
                id: 'zero3-r1',
                label: 'Rank 1',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'muted'},
                      {cols: [2, 3], tone: 'a'},
                      {cols: [4, 7], tone: 'muted'},
                    ],
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'muted'},
                      {cols: [2, 3], tone: 'b'},
                      {cols: [4, 7], tone: 'muted'},
                    ],
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 1], tone: 'muted'},
                      {cols: [2, 3], tone: 'c'},
                      {cols: [4, 7], tone: 'muted'},
                    ],
                  },
                ],
              },
              {
                id: 'zero3-r2',
                label: 'Rank 2',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    marks: [
                      {cols: [0, 3], tone: 'muted'},
                      {cols: [4, 5], tone: 'a'},
                      {cols: [6, 7], tone: 'muted'},
                    ],
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 3], tone: 'muted'},
                      {cols: [4, 5], tone: 'b'},
                      {cols: [6, 7], tone: 'muted'},
                    ],
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 3], tone: 'muted'},
                      {cols: [4, 5], tone: 'c'},
                      {cols: [6, 7], tone: 'muted'},
                    ],
                  },
                ],
              },
              {
                id: 'zero3-r3',
                label: 'Rank 3',
                layout: 'column',
                items: [
                  {
                    array: 'params W',
                    cols: 8,
                    marks: [
                      {cols: [0, 5], tone: 'muted'},
                      {cols: [6, 7], tone: 'a'},
                    ],
                  },
                  {
                    array: 'grads G',
                    cols: 8,
                    marks: [
                      {cols: [0, 5], tone: 'muted'},
                      {cols: [6, 7], tone: 'b'},
                    ],
                  },
                  {
                    array: 'Adam m, v',
                    cols: 8,
                    marks: [
                      {cols: [0, 5], tone: 'muted'},
                      {cols: [6, 7], tone: 'c'},
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      title: 'One ZeRO-3 layer step',
      architecture: {
        input: "x · this rank's micro-batch",
        output: 'updated shard · gathered again next step',
        items: [
          {
            id: 'shard-rest',
            label: 'Weight shard at rest',
            kind: 'io',
            sub: 'self.shard · padded / N',
            detail:
              "Between uses a layer is only this rank's slice of its padded flat `[weight, bias]`: `ceil(numel / N)` numbers.",
          },
          {
            tone: 'dotted',
            label: 'Forward of layer ℓ',
            items: [
              {
                id: 'fwd-gather',
                label: 'All-gather W',
                kind: 'attention',
                sub: 'gather() · all_gather_(flat, shard)',
                detail:
                  "`ShardedLinear.gather()` fills a padded flat from every rank's shard and views `weight (out, in)` and `bias (out,)` out of it.",
              },
              {
                id: 'fwd-compute',
                label: 'Linear forward',
                sub: 'y = x Wᵀ + b · save x only',
                shape: '(B/N, out)',
                detail:
                  '`GatheredLinear.forward` runs under no-grad inside the autograd function: `ctx.save_for_backward(x)` keeps the input, never the weight.',
              },
              {
                id: 'fwd-free',
                label: 'Free the full W',
                sub: 'flat, weight, bias dropped',
                detail:
                  'Nothing references the gathered buffer once `forward` returns, so CPython frees it at once; `METER.live` drops by `padded`.',
              },
            ],
          },
          {
            id: 'rest-of-model',
            label: 'Layers above, loss, backward',
            kind: 'loss',
            sub: 'each gathers and frees its own W',
            detail:
              'The same gather, compute, free for every other layer, the loss, then backward down to layer ℓ. Collectives run in the same order on every rank.',
          },
          {
            tone: 'dotted',
            label: 'Backward of layer ℓ',
            items: [
              {
                id: 'bwd-gather',
                label: 'All-gather W again',
                kind: 'attention',
                sub: 'gather() · second time this step',
                detail:
                  "The weight was freed after forward, so backward gathers it again: the third Ψ of ZeRO-3's traffic.",
              },
              {
                id: 'bwd-compute',
                label: 'Local gradients',
                sub: 'gx = g W · gW = gᵀ x · gb = Σ g',
                detail:
                  "`grad_y @ weight` goes on down the graph; `grad_W` and `grad_b` are this rank's micro-batch sums, written into a padded flat.",
              },
              {
                id: 'reduce-shard',
                label: 'Reduce-scatter to shard',
                kind: 'attention',
                sub: 'reduce_scatter_(grad_flat) ÷ N',
                detail:
                  'Each rank receives the sum of its shard from every rank, divides by N, and returns it as `shard.grad`. The full gradient is freed with the full weight.',
              },
            ],
          },
          {
            id: 'opt-step',
            label: 'Sharded AdamW step',
            sub: 'torch.optim.AdamW over shards',
            detail:
              'The optimizer only ever sees the shard parameters, so its `exp_avg` and `exp_avg_sq` are 1/N of the model with no extra code.',
          },
        ],
        notes: [
          {at: 'fwd-gather', text: "**One** layer's full W alive at a time"},
          {at: 'bwd-gather', text: "**3Ψ** traffic per step, DDP's is **2Ψ**"},
          {at: 'reduce-shard', text: 'Gradient memory: **1/N** of the layer', side: 'left'},
          {at: 'opt-step', text: 'Adam state: **1/N** of the model'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'ZeRO: Memory Optimizations Toward Training Trillion Parameter Models',
      url: 'https://arxiv.org/abs/1910.02054',
      by: 'Samyam Rajbhandari et al.',
      date: '2019-10-04',
      venue: 'SC 2020',
      takes:
        'The 2Ψ + 2Ψ + 12Ψ memory count, the three partitioning stages that steps 2 and 3 build, and the 2Ψ against 3Ψ communication argument.',
    },
    {
      kind: 'paper',
      title: 'PyTorch Distributed: Experiences on Accelerating Data Parallel Training',
      url: 'https://arxiv.org/abs/2006.15704',
      by: 'Shen Li et al.',
      date: '2020-06-28',
      venue: 'VLDB 2020',
      takes:
        'Gradient buckets in reverse parameter order, hooks that launch an async all-reduce when a bucket is full, and launching in bucket order so ranks agree: `GradBucketer`.',
    },
    {
      kind: 'paper',
      title: 'PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel',
      url: 'https://arxiv.org/abs/2304.11277',
      by: 'Yanli Zhao et al.',
      date: '2023-04-21',
      venue: 'VLDB 2023',
      takes:
        'Flat padded parameter shards, all-gather before forward and again before backward, reduce-scatter of the gradient, and a plain optimizer over shards: `ShardedLinear` and `GatheredLinear`.',
    },
    {
      kind: 'code',
      title: 'DeepSpeed',
      url: 'https://github.com/deepspeedai/DeepSpeed',
      by: 'deepspeedai',
      date: '2020-01-23',
      venue: 'GitHub',
      takes:
        'The reference ZeRO implementation (stages 1 to 3, partitioned flat buffers per rank) that `ShardedAdamW` and `zero3.py` reduce to their core.',
    },
    {
      kind: 'post',
      title: 'The Ultra-Scale Playbook: Training LLMs on GPU Clusters',
      url: 'https://huggingface.co/spaces/nanotron/ultrascale-playbook',
      by: 'Nouamane Tazi et al.',
      date: '2025-02-19',
      venue: 'Hugging Face',
      takes:
        'Bucketing and overlap in data parallelism and the ZeRO stage diagrams with their memory and communication per stage, which the `zero-memory` widget recomputes.',
    },
  ],
  steps: [ddpStep, zero1Step, zero3Step],
  learn,
};
