import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {loraStep} from './steps/1-lora';

/**
 * Deep-learning drill: LoRA as module surgery — a frozen `nn.Linear` wrapped with a zero-initialised
 * rank-r update scaled by alpha / r, merged into the weight for inference and unmerged again, applied in
 * place to the attention projections of a small transformer, with adapter-only training and checkpoints.
 */
export const ptLoraProblem: Problem = {
  id: 'pt-lora',
  title: 'LoRA: low-rank adapters, freezing, merging',
  tagline:
    'Wrap a frozen nn.Linear with B @ A scaled by alpha / r, B = 0 at start: the identity at step 0, under 1 % of the parameters trained, merged into W for zero-cost inference.',
  difficulty: 'hard',
  track: 'dl',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 75,
  statement: `# LoRA: low-rank adapters, freezing, merging

Fine-tuning a 7B model end to end means gradients and two AdamW moments for every one of its seven billion
weights. LoRA (Hu et al., 2021) fine-tunes it on one GPU instead: freeze the pre-trained weight \`W\` of
selected linear layers — usually the attention projections \`q_proj\` and \`v_proj\` — and learn the change
as a product of two thin matrices, \`ΔW = B @ A · alpha / r\`, with \`A\` of shape \`(r, in)\`, \`B\` of shape
\`(out, r)\` and \`r\` of 4 to 64. \`B\` starts at zero, so the adapted model is the pre-trained model at
step 0; only \`A\` and \`B\` get gradients and optimizer state; and when training ends \`ΔW\` is added into
\`W\`, so the served model is a plain transformer with no extra latency. Every open-weight fine-tuning
stack — Hugging Face PEFT, Axolotl, torchtune, Unsloth — and every multi-adapter server is built on this.

The surface is one class and three functions, in \`torch\` only:

- \`LoRALinear(base: nn.Linear, r: int, alpha: float, dropout: float = 0.0)\` — keeps \`base\` frozen as a
  submodule, owns \`lora_A\` \`(r, in_features)\` and \`lora_B\` \`(out_features, r)\`, \`scaling = alpha / r\`,
  \`merged\`; \`forward(x)\` for \`x\` of shape \`(…, in_features)\`, \`merge()\`, \`unmerge()\`.
- \`apply_lora(model, target_names, r, alpha, dropout=0.0) -> nn.Module\` — swaps every \`nn.Linear\` whose
  attribute name is in \`target_names\` for a \`LoRALinear\` around it, in place.
- \`mark_only_lora_trainable(model) -> int\` — \`requires_grad\` on \`lora_\` parameters only; returns the
  trainable count.
- \`lora_state_dict(model) -> dict\` — the adapter checkpoint: the \`lora_\` entries of \`state_dict()\`.

## What you build here

1. \`LoRALinear\` with zero-init \`B\` and Kaiming-init \`A\`, the scaled low-rank forward (through \`A\`, then
   \`B\`), idempotent \`merge()\` / \`unmerge()\` under \`torch.no_grad()\`, and the three module-level
   functions that apply it to a model, freeze everything else and extract the adapter weights.

## Run it on your machine

\`python lora.py\` — the self-test checks that a fresh adapter reproduces the original layer bit for bit,
that only \`lora_A\` and \`lora_B\` receive gradients, and that merge/unmerge round-trips in float64 (output
within \`1e-6\`, weight within \`1e-12\`). It then adapts \`q_proj\` and \`v_proj\` of a two-block \`d = 128\`
transformer with \`r = 4\`, \`alpha = 8\` — 4096 of 462336 parameters train — runs five \`AdamW\` steps,
asserts the loss fell, every adapter moved and no frozen weight did, reloads the eight-tensor adapter
checkpoint into a fresh copy, and compares merged against unmerged inference within \`1e-5\`. A passing run
prints the trainable fraction and \`PASS\`.

## Left out on purpose

Quantised bases (QLoRA's 4-bit NF4 weights with on-the-fly dequantisation), DoRA's magnitude/direction
split, rsLoRA's \`alpha / sqrt(r)\` scaling, LoRA on embeddings and convolutions, fused \`qkv\` projections,
multiple named adapters per layer and adapter switching, and the batched multi-adapter kernels of serving
systems (S-LoRA, Punica, vLLM).`,
  diagram: {
    nodes: [
      {
        id: 'trainer',
        kind: 'client',
        label: 'Training loop',
        sub: 'apply_lora · mark_only_lora_trainable · AdamW',
        x: 10,
        y: 50,
      },
      {
        id: 'lora',
        kind: 'service',
        label: 'LoRALinear',
        sub: 'base(x) + dropout(x) @ Aᵀ @ Bᵀ · alpha / r',
        x: 42,
        y: 50,
      },
      {id: 'base', kind: 'db', label: 'base nn.Linear', sub: 'W (out, in) · b — frozen', x: 75, y: 22},
      {
        id: 'adapter',
        kind: 'db',
        label: 'lora_A · lora_B',
        sub: 'A (r, in) Kaiming · B (out, r) zeros — trained',
        x: 75,
        y: 78,
      },
      {
        id: 'ckpt',
        kind: 'external',
        label: 'lora_state_dict',
        sub: 'lora_ tensors only · load strict=False',
        x: 42,
        y: 90,
      },
    ],
    edges: [
      {from: 'trainer', to: 'lora', kind: 'plain', label: 'forward · backward'},
      {from: 'lora', to: 'base', kind: 'plain', label: 'W x + b · merge: W += B A · s'},
      {from: 'lora', to: 'adapter', kind: 'plain', label: 'x → (…, r) → (…, out)'},
      {from: 'adapter', to: 'ckpt', kind: 'plain', label: 'ship the adapter'},
    ],
  },
  steps: [loraStep],
  learn,
};
