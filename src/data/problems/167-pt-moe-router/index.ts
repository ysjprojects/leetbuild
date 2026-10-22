import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {moeStep} from './steps/1-moe';

/**
 * Drill: the sparse mixture-of-experts feed-forward layer of Switch Transformer, Mixtral and
 * DeepSeek — a top-k router with the load-balancing loss that keeps it from collapsing, a dispatch
 * that runs each expert once on the tokens it won, a capacity that bounds what each expert takes,
 * and a gate-weighted combine.
 */
export const ptMoeRouterProblem: Problem = {
  id: 'pt-moe-router',
  title: 'Mixture of experts: top-k routing with a load-balancing loss',
  tagline:
    'A router that picks k of E experts per token and the Switch loss that keeps it honest, a per-expert dispatch under a capacity, and a combine that still sends gradients to the gate.',
  difficulty: 'hard',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# Mixture of experts: top-k routing with a load-balancing loss

A dense transformer runs the same feed-forward network on every token. A **mixture of experts** keeps
\`E\` feed-forward networks and a small **router** that sends each token to the \`k\` it scores highest, so
the model holds many more parameters than any token touches — Switch Transformer's 1.6 T parameters at
the compute of a 1 B dense model, Mixtral 8×7B activating 2 of 8 experts, DeepSeek-V3 activating 8 of
256. The whole trick lives in three places: how the router chooses, what stops it from sending
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
  diagram: {
    nodes: [
      {id: 'tokens', kind: 'client', label: 'tokens', sub: 'x (B, S, D) → (T, D)', x: 8, y: 50},
      {id: 'router', kind: 'service', label: 'TopKRouter', sub: 'gate · softmax · top-k · aux loss', x: 32, y: 50},
      {id: 'experts', kind: 'service', label: 'E experts', sub: 'where(idx == e) · [:capacity] · FFN', x: 58, y: 50},
      {
        id: 'combine',
        kind: 'service',
        label: 'combine',
        sub: 'index_add_ · weights[tok, slot] · (y, aux)',
        x: 82,
        y: 50,
      },
      {id: 'reference', kind: 'external', label: 'moe_reference', sub: 'per-token loop · atol 1e-5', x: 58, y: 85},
    ],
    edges: [
      {from: 'tokens', to: 'router', kind: 'plain', label: 'logits (T, E)'},
      {from: 'router', to: 'experts', kind: 'plain', label: 'idx, weights (T, k)'},
      {from: 'experts', to: 'combine', kind: 'plain', label: 'out (n_e, D)'},
      {from: 'combine', to: 'reference', kind: 'plain', label: 'allclose'},
    ],
  },
  steps: [moeStep],
  learn,
};
