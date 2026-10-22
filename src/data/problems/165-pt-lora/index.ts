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
  figures: [
    {
      title: 'LoRA on the query projection',
      architecture: {
        input: 'token ids · (4, 16)',
        output: 'next-token logits',
        items: [
          {
            tone: 'model',
            items: [
              {
                id: 'embed',
                label: 'Token embedding',
                kind: 'embed',
                sub: 'nn.Embedding · 256 × 128 · frozen',
                shape: '[4, 16, 128]',
                detail: 'A byte-level vocabulary of 256 and `d = 128`. Frozen like every weight outside the adapters.',
              },
              {
                tone: 'block',
                repeat: '2 ×',
                label: 'Transformer block',
                items: [
                  {id: 'ln1', label: 'LayerNorm 1', kind: 'norm', detail: 'Pre-norm, frozen.'},
                  {
                    tone: 'dotted',
                    label: 'q_proj as LoRALinear',
                    items: [
                      {
                        columns: [
                          [
                            {
                              id: 'base',
                              label: 'Frozen base W',
                              sub: 'nn.Linear 128 → 128',
                              shape: '[4, 16, 128]',
                              detail:
                                'The original `q_proj`, kept as `self.base` and frozen with `base.requires_grad_(False)`: no gradient and no optimizer state for `W` or `b`. Reused in place, never copied.',
                            },
                          ],
                          [
                            {
                              id: 'lora-a',
                              label: 'lora_A',
                              kind: 'attention',
                              sub: '128 → 4 · Kaiming init',
                              shape: '[4, 16, 4]',
                              detail:
                                '`dropout(x) @ lora_A.T`, with `lora_A` of shape `(r, in) = (4, 128)` and `kaiming_uniform_(a=√5)`: a random projection of the input down to `r = 4` dimensions.',
                            },
                            {
                              id: 'lora-b',
                              label: 'lora_B',
                              kind: 'attention',
                              sub: '4 → 128 · zeros',
                              shape: '[4, 16, 128]',
                              detail:
                                '`@ lora_B.T`, with `lora_B` of shape `(out, r) = (128, 4)` and all zeros at the start, so the adapter adds exactly 0 until the first optimizer step.',
                            },
                            {
                              id: 'scale',
                              label: 'Scale by α / r',
                              kind: 'attention',
                              sub: 'alpha 8 / r 4 = 2.0',
                              detail:
                                '`scaling = alpha / r` keeps the size of the update roughly independent of the rank, so a learning rate tuned at one `r` carries to another.',
                            },
                          ],
                        ],
                      },
                      {
                        id: 'add-lora',
                        op: '+',
                        detail:
                          '`base(x) + (dropout(x) @ Aᵀ @ Bᵀ) · alpha / r`. After `merge()`, `W += B @ A · alpha / r` and the layer returns `base(x)` alone.',
                      },
                    ],
                  },
                  {
                    id: 'attn',
                    label: 'Masked self-attention',
                    sub: '4 heads × 32 · o_proj',
                    shape: '[4, 16, 128]',
                    side: {
                      label: 'k_proj · v_proj',
                      sub: 'v_proj gets LoRA too',
                      detail:
                        '`apply_lora(model, ["q_proj", "v_proj"], r=4, alpha=8)`: `k_proj` and `o_proj` stay plain frozen `nn.Linear`s.',
                    },
                    detail: 'Causal attention over the adapted queries and values; every weight in it is frozen.',
                  },
                  {id: 'add1', op: '+', from: 'ln1', detail: '`x = x + o_proj(attn)`: the residual stream.'},
                  {id: 'ln2', label: 'LayerNorm 2', kind: 'norm'},
                  {
                    id: 'mlp',
                    label: 'Feed forward',
                    kind: 'ffn',
                    sub: '128 → 512 → 128 · frozen',
                    detail: '`down_proj(gelu(up_proj(x)))`; not targeted, so frozen and untouched.',
                  },
                  {id: 'add2', op: '+', from: 'ln2'},
                ],
              },
              {id: 'lnf', label: 'Final LayerNorm', kind: 'norm'},
              {
                id: 'head',
                label: 'Linear output layer',
                kind: 'head',
                sub: 'lm_head · 128 → 256 · frozen',
                shape: '[4, 16, 256]',
              },
            ],
          },
        ],
        notes: [
          {at: 'lora-b', text: 'B = **0** at init: the model is unchanged at step 0'},
          {at: 'lora-a', text: 'Rank **4**: **1,024** params instead of **16,384**'},
          {at: 'add-lora', text: 'merge() folds B·A·α/r into W: **one** matmul'},
          {at: 'head', text: '**4,096** of **462,336** parameters train (0.89 %)'},
          {at: 'base', text: 'Frozen: no gradient, no Adam state', side: 'left'},
        ],
      },
    },
  ],
  steps: [loraStep],
  learn,
};
