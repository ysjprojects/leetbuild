import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {moeStep} from './steps/1-moe';

/**
 * Drill: the sparse mixture-of-experts feed-forward layer of Switch Transformer, Mixtral and
 * DeepSeek: a top-k router with the load-balancing loss that keeps it from collapsing, a dispatch
 * that runs each expert once on the tokens it won, a capacity that bounds what each expert takes,
 * and a gate-weighted combine.
 */
export const ptMoeRouterProblem: Problem = {
  id: 'pt-moe-router',
  title: 'Mixture of experts: top-k routing with a load-balancing loss',
  tagline:
    'A router that picks k of E experts per token and the Switch loss that keeps it honest, a per-expert dispatch under a capacity, and a combine that still sends gradients to the gate.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# Mixture of experts: top-k routing with a load-balancing loss

A dense transformer runs the same feed-forward network on every token. A **mixture of experts** keeps
\`E\` feed-forward networks and a small **router** that sends each token to the \`k\` it scores highest, so
the model holds many more parameters than any token touches: Switch-Base holds 7 B parameters at the FLOPs of
the 0.2 B T5-Base, Mixtral 8×7B activates 2 of 8 experts, DeepSeek-V3 8 of its 256 routed experts.
The whole trick lives in three places: how the router chooses, what stops it from sending
everything to one expert, and how the tokens reach their experts without a Python loop per token.

The surface is two modules. \`TopKRouter(d_model, n_experts, k, z_loss_coef=0.0)\` maps \`(T, D)\` tokens
to \`(idx (T, k), weights (T, k), aux)\`: gate logits in float32, softmax, top-k, the \`k\` probabilities
renormalised to sum to 1, and the auxiliary loss \`n_experts · Σ_e f_e · P_e\` (fraction of slots that went
to expert \`e\` times its mean probability) plus an optional router z-loss. \`MoE(d_model, d_ff, n_experts,
k, capacity_factor=1.25, z_loss_coef=0.0)\` maps \`(B, S, D)\` to \`(y, aux)\`: a capacity of
\`ceil(capacity_factor · T · k / n_experts)\` slots per expert, one loop over experts that gathers each
expert's tokens with \`torch.where\`, keeps the first \`capacity\`, runs the expert once and scatters the
gate-weighted output back with \`index_add_\`. A token dropped by every expert it chose leaves a zero row;
the block's residual carries it on.

## What you build here

1. \`TopKRouter\` (softmax, top-k, renormalised weights, load-balancing loss, z-loss) and \`MoE\`
   (capacity, per-expert gather → expert → \`index_add_\` combine), returning \`(y, aux)\`, matching a
   per-token reference within \`1e-5\`.

## Run it on your machine

\`\`\`bash
python moe.py
\`\`\`

A passing run prints \`PASS\`: the aux loss is 1 under a zeroed gate and about \`E\` when every token picks
expert 0, the vectorised layer matches \`moe_reference\` to \`1e-5\`, \`capacity_factor = 0.5\` drops exactly
the overflow, and \`gate.weight.grad\` is non-zero.

## Left out on purpose

Expert parallelism and the all-to-all that moves tokens between devices, the permute/unpermute kernels
that replace the expert loop, dropless (block-sparse) MoE, shared experts, DeepSeek's bias-based
balancing, expert-choice routing, and the sequence-level and device-level balancing losses that
production trainers add to the token-level one built here.`,
  figures: [
    {
      title: 'Mixture-of-experts block',
      architecture: {
        input: 'h · (B, S, D) = (2, 16, 32)',
        items: [
          {
            tone: 'block',
            label: 'Transformer block · MoE',
            items: [
              {id: 'ln1', label: 'LayerNorm 1', kind: 'norm'},
              {
                id: 'attn',
                label: 'Masked self-attention',
                sub: 'dense · every token',
                detail: 'Unchanged from a dense transformer: an MoE model only swaps the feed-forward sub-layer.',
              },
              {id: 'add1', op: '+', from: 'ln1'},
              {id: 'ln2', label: 'LayerNorm 2', kind: 'norm', shape: '(2, 16, 32) → tokens (32, 32)'},
              {
                tone: 'dotted',
                label: 'MoE layer · the FFN slot',
                items: [
                  {
                    id: 'gate',
                    label: 'Router gate',
                    kind: 'attention',
                    sub: 'nn.Linear 32 → 4 · float32',
                    shape: 'logits (32, 4)',
                    detail:
                      '`TopKRouter.gate`, `bias=False`: one score per expert. Input and weight are cast to float32 before the matmul, so the router stays float32 in a bf16 model (Switch’s selective precision).',
                  },
                  {
                    id: 'softmax',
                    label: 'Softmax over experts',
                    kind: 'attention',
                    sub: 'probs (T, E)',
                    shape: 'probs (32, 4)',
                    detail:
                      'Soft routing: the path the gradient takes into the gate, and the `P_e = probs.mean(0)` of the balancing loss.',
                  },
                  {
                    id: 'topk',
                    label: 'Top-k, renormalised',
                    kind: 'attention',
                    sub: 'k = 2 · weights sum to 1',
                    shape: 'idx, weights (32, 2)',
                    detail:
                      '`torch.topk(probs, k)`, then `weights = p / p.sum(-1, keepdim=True)` so the combine is a convex mix. `idx` gives `f_e`, the hard share of slots per expert.',
                  },
                  {
                    id: 'dispatch',
                    label: 'Dispatch under capacity',
                    kind: 'attention',
                    sub: 'where(idx == e)[:capacity]',
                    side: {
                      label: 'Capacity',
                      sub: '⌈1.25·T·k/E⌉ = 20',
                      detail:
                        '`ceil(capacity_factor · T · k / n_experts)` slots per expert; the rest are dropped in token order.',
                    },
                    detail:
                      'One loop over experts: `tok, slot = torch.where(idx == e)` lists the tokens that chose `e` in token order; the first `capacity` are kept and gathered with `tokens[tok]`.',
                  },
                  {
                    columns: [
                      [{id: 'expert-0', label: 'Expert 0', kind: 'ffn', sub: '32 → 64 → 32'}],
                      [{id: 'expert-1', label: 'Expert 1', kind: 'ffn', sub: '32 → 64 → 32'}],
                      [{id: 'expert-2', label: 'Expert 2', kind: 'ffn', sub: '32 → 64 → 32'}],
                      [{id: 'expert-3', label: 'Expert 3', kind: 'ffn', sub: '32 → 64 → 32'}],
                    ],
                  },
                  {
                    id: 'combine',
                    label: 'Weighted sum',
                    kind: 'attention',
                    sub: 'index_add_(0, tok, w · out)',
                    shape: 'y (2, 16, 32)',
                    detail:
                      'Each expert output row, times its gate weight `weights[tok, slot]`, is scattered back with `index_add_`; a token with two slots gets two adds. A token every expert dropped stays a zero row.',
                  },
                ],
              },
              {
                id: 'add2',
                op: '+',
                from: 'ln2',
                detail:
                  '`h + moe(norm(h))`: the residual carries a dropped token on. The layer never adds its own input.',
              },
            ],
          },
          {
            id: 'loss',
            label: 'Training loss',
            kind: 'loss',
            sub: 'LM loss + α · aux · α = 0.01',
            side: {
              label: 'Load-balancing aux',
              sub: 'E · Σ_e f_e · P_e',
              detail:
                'The router returns `aux`: `f_e` (hard share of the `T·k` slots, no gradient) times `P_e` (mean probability, soft). Optional z-loss `z_loss_coef · mean(logsumexp(logits)²)`, folded into the same `aux`.',
            },
            detail:
              'The drill returns `aux` unscaled; the training loop adds `α · aux` from every MoE layer to the language-modelling loss. Because the z-loss is folded in, α scales it too.',
          },
        ],
        notes: [
          {at: 'gate', text: 'Gate: **4 × 32** weights, in float32'},
          {at: 'topk', text: '**2** of **4** experts per token'},
          {at: 'expert-0', text: 'Each expert runs **once**, on the tokens it won', side: 'left'},
          {at: 'loss', text: 'aux = **1** when balanced, **4** when collapsed'},
          {at: 'add2', text: 'A dropped token rides the residual', side: 'left'},
        ],
        insets: [
          {
            for: 'expert-3',
            title: 'Expert',
            items: [
              {id: 'w1', label: 'Linear w1', sub: '32 → 64'},
              {id: 'gelu', label: 'GELU'},
              {id: 'w2', label: 'Linear w2', sub: '64 → 32'},
            ],
            note: 'Each expert is a small FFN with **d_ff = 64**',
          },
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer',
      url: 'https://arxiv.org/abs/1701.06538',
      by: 'Noam Shazeer et al.',
      date: '2017-01-23',
      venue: 'ICLR 2017',
      takes:
        'The layer itself: top-`k` gating with a softmax over the kept scores (the drill drops the noise), and the self-reinforcing imbalance its auxiliary losses counter.',
    },
    {
      kind: 'paper',
      title: 'GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding',
      url: 'https://arxiv.org/abs/2006.16668',
      by: 'Dmitry Lepikhin et al.',
      date: '2020-06-30',
      venue: 'ICLR 2021',
      takes:
        'Top-2 gates renormalised over the two chosen, and an expert capacity: tokens past it are dropped and carried on by the residual, as `MoE` does.',
    },
    {
      kind: 'paper',
      title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity',
      url: 'https://arxiv.org/abs/2101.03961',
      by: 'William Fedus, Barret Zoph and Noam Shazeer',
      date: '2021-01-11',
      venue: 'JMLR 2022',
      takes:
        'The load-balancing loss `n_experts · Σ_e f_e · P_e` with α = 0.01, the expert capacity and its `capacity_factor`, dropped tokens riding the residual, and the router computed in float32.',
    },
    {
      kind: 'paper',
      title: 'ST-MoE: Designing Stable and Transferable Sparse Expert Models',
      url: 'https://arxiv.org/abs/2202.08906',
      by: 'Barret Zoph et al.',
      date: '2022-02-17',
      venue: 'arXiv',
      takes:
        'The router z-loss `z_loss_coef` weights (the mean squared logsumexp of the gate logits, coefficient 0.001), and the 1.25 train and 2.0 eval capacity factors.',
    },
    {
      kind: 'paper',
      title: 'Mixtral of Experts',
      url: 'https://arxiv.org/abs/2401.04088',
      by: 'Albert Q. Jiang et al.',
      date: '2024-01-08',
      venue: 'arXiv',
      takes:
        '2 of 8 experts per token with the gate weights renormalised over the chosen `k`, the routing `TopKRouter` returns.',
    },
  ],
  steps: [moeStep],
  learn,
};
