import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {tpLinearStep} from './steps/1-tp-linear';
import {tpBlockStep} from './steps/2-tp-block';
import {tpVocabStep} from './steps/3-tp-vocab';

/**
 * Deep-learning problem: Megatron-LM tensor parallelism from scratch on real gloo processes. The
 * conjugate operators f and g with the column- and row-parallel linears, a parallel transformer block
 * (MLP, attention by heads, replicated LayerNorms) with its collectives counted, and the
 * vocabulary-parallel embedding, tied head and cross-entropy.
 */
export const ptTensorParallelProblem: Problem = {
  id: 'pt-tensor-parallel',
  title: 'Megatron tensor parallelism from scratch',
  tagline:
    'Split a transformer across processes as Megatron-LM does: f and g as autograd functions, column- and row-parallel linears, a block with one all-reduce per sublayer, and a cross-entropy that never gathers the logits.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 120,
  statement: `# Megatron tensor parallelism from scratch

Megatron-LM (Shoeybi et al., NVIDIA, 2019) trains a transformer too large for one GPU by splitting every
weight matrix across the GPUs of a node. Each of \`p\` ranks holds \`1/p\` of every layer, computes its share
of every token, and the ranks sum activations with all-reduces inside each layer. It is the TP of 3D
parallelism: tensor parallelism inside a server over NVLink, pipeline stages across servers, data
parallelism or ZeRO over the rest. GPT-3-scale runs and Llama 3 405B use \`p = 8\`, and serving engines
that shard a model over several GPUs run the same layers.

The method rests on two operators. **f** is the identity forward and an all-reduce backward; **g** is an
all-reduce forward and the identity backward. A column-parallel linear (output features split) behind f
and a row-parallel linear (input features split) in front of g make an MLP or an attention sublayer that
communicates once each way.

You write three files, each importing the previous one, and run them as real processes:
\`torch.multiprocessing.spawn\`, backend \`gloo\` on the CPU, world sizes 2 and 4. All tensors are float32.

- \`tp_linear.py\`:
  - \`CopyToTP\` (f), \`ReduceFromTP\` (g), \`GatherFromTP\` and \`ScatterToTP\` as \`torch.autograd.Function\`s,
    applied by \`copy_to_tp\`, \`reduce_from_tp\`, \`gather_from_tp\`, \`scatter_to_tp\`.
  - \`ColumnParallelLinear(in_features, out_features, bias=True, gather_output=False)\`: weight
    \`(out_features / p, in_features)\`, bias \`(out_features / p,)\`.
  - \`RowParallelLinear(in_features, out_features, bias=True, input_is_parallel=True)\`: weight
    \`(out_features, in_features / p)\`, a whole bias \`(out_features,)\` added once after g.
  - \`from_dense(nn.Linear)\` on both. \`launch(fn, world, *args)\`, given, runs \`fn(rank, world, *args)\` in
    \`world\` gloo processes and returns each rank's result to the parent.
- \`tp_block.py\`: \`ParallelMLP(d_model, d_ff)\`, \`ParallelAttention(d_model, n_heads, block_size)\` with
  \`n_heads / p\` local heads, and \`ParallelBlock(d_model, n_heads, d_ff, block_size)\` (pre-LN, LayerNorms
  replicated), each with \`from_dense\` from the dense references in the file; \`CollectiveCounter\`, a
  context manager counting \`dist.all_reduce\` / \`dist.all_gather\` calls and their bytes.
- \`tp_vocab.py\`: \`vocab_range(V, rank, world)\`, \`VocabParallelEmbedding(num_embeddings,
  embedding_dim)\`, \`parallel_lm_logits(hidden, weight) -> (B, T, V / p)\`, and
  \`vocab_parallel_cross_entropy(logits (B, T, V / p), target (B, T) int64) -> loss (B, T)\`, a custom
  autograd function. Full-vocabulary logits never exist on one rank.

## What you build here

1. **Parallel linears**: f, g, the gather and the scatter as autograd functions; the column and row
   shards and their sharding from \`nn.Linear\`; outputs and every gradient equal to \`nn.Linear\` on 2 and 4
   ranks.
2. **A parallel block**: the MLP as column, GELU, row; attention with whole heads per rank and the fused
   qkv weight sharded by head; a pre-LN block with replicated LayerNorms; one all-reduce per sublayer
   forward and one backward, counted.
3. **The vocabulary**: an embedding that masks foreign ids, a tied head that never gathers, and a
   cross-entropy from three all-reduces of one float per token, with its softmax-minus-one-hot backward.

## Run it on your machine

Put the three files in one directory and run \`python tp_linear.py\`, \`python tp_block.py\` and
\`python tp_vocab.py\` (PyTorch 2.1 or later, CPU only). Each spawns 2 and then 4 processes and takes 3 to
5 s on a laptop, most of it process start-up. Each prints \`PASS\` when every output, input gradient and
weight gradient, reassembled from the ranks' shards in the parent, matches the single-process dense
module to \`1e-5\`; the counters show one all-reduce per sublayer each way and three per cross-entropy; and
the loss matches \`F.cross_entropy\`, including on logits that overflow a naive \`exp\`.

The processes rendezvous through a file in a temporary directory (\`init_method="file://<tmp>/rendezvous"\`) instead of
\`MASTER_ADDR\` / \`MASTER_PORT\`: one machine needs no TCP store, and on a host whose name does not
resolve the TCP store's start-up stalls for tens of seconds.

## Left out on purpose

Sequence parallelism (LayerNorm and dropout split along the sequence, each all-reduce replaced by a
reduce-scatter and an all-gather), pipeline and data parallelism and their composition, overlapping the
collectives with the GEMMs, NCCL and GPUs, dropout and its per-rank RNG state, grouped-query attention,
initialising the master weight whole so a fresh model is independent of \`p\`, and PyTorch's DTensor
\`parallelize_module\`, which does all of this for you.`,
  figures: [
    {
      title: 'Megatron block with f and g',
      architecture: {
        input: 'x · (B, T, d), the same on every rank',
        output: 'x · (B, T, d), the same on every rank',
        items: [
          {
            tone: 'block',
            label: 'ParallelBlock · p = 2 ranks',
            items: [
              {
                id: 'ln1',
                label: 'LayerNorm ln1',
                kind: 'norm',
                sub: 'replicated on every rank',
                detail:
                  'The residual stream is whole on every rank, so each computes the same normalisation; f in the next box makes their gradients equal too.',
              },
              {
                id: 'f-attn',
                label: 'f · copy to TP',
                kind: 'attention',
                sub: 'fwd identity · bwd all-reduce',
                detail:
                  '`CopyToTP`: forward returns `x`; backward all-reduces dL/dx, because every rank’s qkv shard read the whole `x`.',
              },
              {
                columns: [
                  [
                    {
                      id: 'qkv-r0',
                      label: 'qkv shard, rank 0',
                      sub: 'd → 3d/p · heads 0 … n/p − 1',
                      detail:
                        '`ColumnParallelLinear(d, 3d)`: rank 0’s rows of q, of k and of v, regrouped from the dense `[Q; K; V]` weight by head.',
                    },
                    {
                      id: 'heads-r0',
                      label: 'Causal attention',
                      kind: 'attention',
                      sub: 'n/p local heads · tril mask',
                      detail:
                        'A head’s softmax only reads its own q and k, so the local heads need nothing from the other rank.',
                    },
                    {
                      id: 'o-r0',
                      label: 'proj shard, rank 0',
                      sub: 'd/p → d · partial sum',
                      detail:
                        '`RowParallelLinear(d, d)`: columns of `W_o` for rank 0’s heads; its output is a partial sum.',
                    },
                  ],
                  [
                    {id: 'qkv-r1', label: 'qkv shard, rank 1', sub: 'd → 3d/p · heads n/p … n − 1'},
                    {id: 'heads-r1', label: 'Causal attention', kind: 'attention', sub: 'n/p local heads · tril mask'},
                    {id: 'o-r1', label: 'proj shard, rank 1', sub: 'd/p → d · partial sum'},
                  ],
                ],
              },
              {
                id: 'g-attn',
                label: 'g · all-reduce',
                kind: 'attention',
                sub: 'Σ partials, then + b_o',
                detail:
                  '`ReduceFromTP`: one all-reduce of `B · T · d` floats forward, identity backward. The replicated bias is added after it, once.',
              },
              {id: 'add1', op: '+', from: 'ln1', detail: '`x = x + attn(ln1(x))`, the same on every rank.'},
              {id: 'ln2', label: 'LayerNorm ln2', kind: 'norm', sub: 'replicated on every rank'},
              {
                id: 'f-mlp',
                label: 'f · copy to TP',
                kind: 'attention',
                sub: 'fwd identity · bwd all-reduce',
                detail: 'In front of the column-parallel `fc`: the input gradient is the sum of both shards’ partials.',
              },
              {
                columns: [
                  [
                    {
                      id: 'fc-r0',
                      label: 'fc shard, rank 0',
                      sub: 'd → 4d/p · column-parallel',
                      detail:
                        '`ColumnParallelLinear(d, 4d, gather_output=False)`: output rows 0 … 4d/p − 1 of `fc.weight`.',
                    },
                    {
                      id: 'gelu-r0',
                      label: 'GELU',
                      kind: 'ffn',
                      sub: 'on the local 4d/p units',
                      detail: 'Elementwise on complete hidden units: GELU of a column slice is the slice of GELU.',
                    },
                    {
                      id: 'down-r0',
                      label: 'proj shard, rank 0',
                      sub: '4d/p → d · row-parallel',
                      detail:
                        '`RowParallelLinear(4d, d, input_is_parallel=True)`: input columns 0 … 4d/p − 1 of `proj.weight`.',
                    },
                  ],
                  [
                    {id: 'fc-r1', label: 'fc shard, rank 1', sub: 'd → 4d/p · column-parallel'},
                    {id: 'gelu-r1', label: 'GELU', kind: 'ffn', sub: 'on the local 4d/p units'},
                    {id: 'down-r1', label: 'proj shard, rank 1', sub: '4d/p → d · row-parallel'},
                  ],
                ],
              },
              {
                id: 'g-mlp',
                label: 'g · all-reduce',
                kind: 'attention',
                sub: 'Σ partials, then + b',
                detail: 'The MLP’s one forward collective: `B · T · d` floats, the same size as the attention’s.',
              },
              {id: 'add2', op: '+', from: 'ln2', detail: '`x = x + mlp(ln2(x))`'},
            ],
          },
        ],
        notes: [
          {at: 'f-attn', text: '**0** bytes forward, all-reduce backward'},
          {at: 'g-attn', text: '**1** all-reduce of **B·T·d** forward'},
          {at: 'g-mlp', text: '**4** all-reduces per layer per step'},
          {at: 'ln2', text: 'Replicated: same input, same gradient', side: 'left'},
        ],
      },
    },
    {
      title: 'Vocabulary-parallel ends',
      architecture: {
        input: 'ids · (B, T) int64, global vocabulary ids',
        output: 'loss · (B, T), the same on every rank',
        items: [
          {
            id: 'vocab-embed',
            label: 'VocabParallelEmbedding',
            kind: 'embed',
            sub: 'rows [r·V/p, (r+1)·V/p) · mask · g',
            shape: '(B, T, d)',
            detail:
              'Foreign ids look up local row 0 and have their output zeroed; `reduce_from_tp` sums the `p` vectors, exactly one of them non-zero.',
          },
          {
            id: 'tp-blocks',
            label: 'ParallelBlock × n_layer',
            sub: 'step 2 · 2 all-reduces forward each',
            shape: '(B, T, d)',
          },
          {id: 'lnf', label: 'LayerNorm ln_f', kind: 'norm', sub: 'replicated', shape: '(B, T, d)'},
          {
            id: 'lm-logits',
            label: 'parallel_lm_logits',
            kind: 'head',
            sub: 'f · h @ W_rᵀ · tied to the shard',
            shape: '(B, T, V/p)',
            detail:
              '`F.linear(copy_to_tp(h), wte.weight)`: the rows a rank looks up are the rows it scores. Never gathered.',
          },
          {
            id: 'ce-max',
            label: 'Global max m',
            sub: 'local max → all-reduce MAX',
            shape: '(B, T)',
            detail: 'Every rank shifts by the same global max, so no shard’s `exp` overflows.',
          },
          {
            columns: [
              [
                {
                  id: 'ce-sumexp',
                  label: 'Sum of exps S',
                  sub: 'Σ exp(z − m) → all-reduce SUM',
                  detail: 'Each rank sums its `V / p` exps; one SUM makes the softmax denominator.',
                },
              ],
              [
                {
                  id: 'ce-target',
                  label: 'Target logit',
                  sub: 'owner: z_t − m, others 0 → SUM',
                  detail: 'Only the rank whose range holds the target picks its logit; the SUM hands it to every rank.',
                },
              ],
            ],
          },
          {
            id: 'ce-loss',
            label: 'loss = log S − (z_t − m)',
            kind: 'loss',
            sub: 'VocabParallelCrossEntropy',
            side: {
              label: 'backward',
              sub: 'softmax − one-hot',
              detail: 'Both terms of the gradient already sit on the right shard: no communication.',
            },
            detail: 'A custom `torch.autograd.Function`; it saves this shard’s softmax and the target mask.',
          },
        ],
        notes: [
          {at: 'vocab-embed', text: '**1** all-reduce of **B·T·d** forward'},
          {at: 'lm-logits', text: '**V/p** logits per token per rank'},
          {at: 'ce-max', text: '**3** all-reduces of **1 float** per token'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism',
      url: 'https://arxiv.org/abs/1909.08053',
      by: 'Mohammad Shoeybi et al.',
      date: '2019-09-17',
      venue: 'arXiv',
      takes:
        'The conjugate operators f and g, the column-then-row MLP and attention of its figure 3, and the vocabulary-parallel embedding and cross-entropy that `tp_linear`, `tp_block` and `tp_vocab` build.',
    },
    {
      kind: 'paper',
      title: 'Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM',
      url: 'https://arxiv.org/abs/2104.04473',
      by: 'Deepak Narayanan et al.',
      date: '2021-04-09',
      venue: 'SC 2021',
      takes:
        'Why tensor parallelism stays inside an 8-GPU NVLink server and composes with pipeline and data parallelism, the cost argument behind the four all-reduces per layer the step-2 counter checks.',
    },
    {
      kind: 'paper',
      title: 'Reducing Activation Recomputation in Large Transformer Models',
      url: 'https://arxiv.org/abs/2205.05198',
      by: 'Vijay Korthikanti et al.',
      date: '2022-05-10',
      venue: 'MLSys 2023',
      takes:
        'Sequence parallelism, the next step for the replicated LayerNorms of `ParallelBlock`: each all-reduce becomes a reduce-scatter plus an all-gather of the same volume.',
    },
    {
      kind: 'code',
      title: 'Megatron-LM',
      url: 'https://github.com/NVIDIA/Megatron-LM',
      by: 'NVIDIA',
      date: '2019-03-21',
      venue: 'GitHub',
      takes:
        'The reference implementation in `megatron/core/tensor_parallel`: `_CopyToModelParallelRegion`, `ColumnParallelLinear`, `RowParallelLinear`, `VocabParallelEmbedding` and `_VocabParallelCrossEntropy`, which the three files follow name for name.',
    },
    {
      kind: 'docs',
      title: 'Tensor Parallelism - torch.distributed.tensor.parallel',
      url: 'https://docs.pytorch.org/docs/2.14/distributed.tensor.parallel.html',
      venue: 'PyTorch 2.14 documentation',
      takes:
        'PyTorch’s DTensor version of the same plan, `ColwiseParallel` then `RowwiseParallel` under `parallelize_module`, which this problem forbids and rebuilds by hand.',
    },
    {
      kind: 'post',
      title: 'The Ultra-Scale Playbook: Training LLMs on GPU Clusters',
      url: 'https://huggingface.co/spaces/nanotron/ultrascale-playbook',
      by: 'Nouamane Tazi et al.',
      date: '2025-02-19',
      venue: 'Hugging Face',
      takes:
        'A measured walk through tensor and sequence parallelism, with the column-then-row MLP and the bytes per collective that the `tensor-parallel` widget draws.',
    },
  ],
  steps: [tpLinearStep, tpBlockStep, tpVocabStep],
  learn,
};
