import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {stochasticRoundingStep} from './steps/1-stochastic-rounding';
import {randomHadamardStep} from './steps/2-random-hadamard';
import {nvfp4TrainStep} from './steps/3-nvfp4-train';

/**
 * Deep-learning problem: the NVFP4 pretraining recipe of arXiv 2509.25149 at toy scale. Stochastic
 * rounding and 16 × 16 weight tiles in the quantizer, the 16 × 16 random Hadamard transform, and a custom
 * autograd linear layer whose fprop, dgrad and wgrad GEMMs run on NVFP4 operands, trained against FP32.
 */
export const ptNvfp4TrainingProblem: Problem = {
  id: 'pt-nvfp4-training',
  title: 'Training in NVFP4: SR, Hadamard, 2-D weight blocks',
  tagline:
    "Build NVIDIA's NVFP4 pretraining recipe at toy scale: stochastic rounding for gradients, 16 × 16 weight blocks, a 16 × 16 random Hadamard transform on the wgrad inputs, and a linear layer whose three GEMMs train a tiny LM within 0.05 nats of FP32.",
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 90,
  statement: `# Training in NVFP4: SR, Hadamard, 2-D weight blocks

NVFP4 is NVIDIA's 4-bit floating-point format for Blackwell tensor cores: E2M1 values (±{0, 0.5, 1,
1.5, 2, 3, 4, 6}) in blocks of 16 that share an FP8 E4M3 scale, under one FP32 scale per tensor.
Inference only has to round each tensor once. Training rounds every operand of every GEMM again on
every step, in the forward and in the backward pass, and sums the results into FP32 master weights,
so a small systematic error compounds. NVIDIA's "Pretraining Large Language Models with NVFP4" (2025)
trained a 12B hybrid Mamba-Transformer on 10T tokens in NVFP4 within about 1.5 % of its FP8 baseline's
loss with four additions: a few sensitive layers kept in BF16, **16 × 16 random Hadamard transforms** on the inputs of
the weight-gradient GEMM, **16 × 16 blocks for weights** so the forward and the backward see one
quantized weight, and **stochastic rounding for gradients**. Transformer Engine ships the recipe as
\`NVFP4BlockScaling\`. It sits under every linear layer of a model: attention, softmax, norms,
embeddings and the optimizer stay in higher precision.

You write three files, each importing the previous one. Every quantizer is fake quantization: it
returns the decoded values \`q · s_block · s_global\` in float32, so an FP32 matmul of two quantized
operands computes what the NVFP4 GEMM computes.

- \`nvfp4_sr.py\`: the canonical quantizer is given; you add
  \`round_e2m1_stochastic(v, generator=None)\` and the 2-D branch of
  \`quantize_nvfp4(x, rounding="nearest" | "stochastic", generator=None, block=(1, 16) | (16, 16))\`,
  which returns a float32 tensor the shape of \`x\`.
- \`nvfp4_rht.py\`: \`sylvester_hadamard(d=16)\` (normalised, \`(16, 16)\`), \`random_signs(d, generator)\`,
  \`rht_matrix(signs)\`, \`rht(x, H)\` and \`inverse_rht(y, H)\` over 16-wide tiles of the last dim.
- \`nvfp4_train.py\`: \`NVFP4LinearFn\`, a \`torch.autograd.Function\` with \`forward(ctx, x (N, in),
  weight (out, in), recipe, generator) -> y (N, out)\` and \`backward(ctx, dy) -> (dx, dw, None,
  None)\`; \`Recipe(stochastic_grads, rht_wgrad, weights_2d)\` turns each technique off for an ablation.
  \`NVFP4Linear\`, a 3-block GPT-style \`TinyLM\`, the data and the training loop are given.

## What you build here

1. **Stochastic rounding and 2-D blocks**: round up with probability equal to the distance from the
   lower grid point, so the mean of the rounding is the value; and one scale per 16 × 16 tile, so
   \`quantize(W).T == quantize(W.T)\`.
2. **The random Hadamard transform**: a normalised 16 × 16 Sylvester matrix with a random sign per row,
   applied tile by tile; orthogonal, so \`(x H)(w H)ᵀ = x wᵀ\`.
3. **NVFP4 training**: fprop, dgrad and wgrad on NVFP4 operands, each quantized along its own reduction
   dimension, a tiny LM trained against an FP32 baseline, and a measured ablation of the gradient bias.

## Run it on your machine

Put the three files in one directory and run \`python nvfp4_sr.py\`, \`python nvfp4_rht.py\` and
\`python nvfp4_train.py\` (PyTorch ≥ 2.1 with \`torch.float8_e4m3fn\`, CPU only, no downloads). The
first two take about a second each, the third about 15 s. \`PASS\` means: stochastic rounding is
unbiased within a stated statistical bound while round-to-nearest shrinks small gradients by over 20 %,
2-D blocks commute with the transpose; the transform is orthogonal, keeps GEMMs exact, lowers the
crest factor and the share of values flushed to zero on heavy-tailed data (but does not lower the
relative error at block size 16); and the NVFP4 LM ends within 0.05 nats of FP32 while
dgrad's bias falls with averaging only when SR and 2-D weights are both on.

## Left out on purpose

Real FP4 storage (packed codes, swizzled scale layouts) and Blackwell's NVFP4 GEMMs: every product here
is an FP32 matmul of decoded values. BF16 for the high-precision parts (FP32 here), the selection of
high-precision layers at scale (the last of three blocks here, 4 of 12 linears instead of the paper's
16 %), amax reduction across ranks, the switch back to higher precision at the end of training,
MXFP4 and FP8 baselines, and anything about speed.`,
  figures: [
    {
      title: 'One NVFP4 linear layer',
      architecture: {
        input: 'x · (N, in) FP32 activations',
        output: 'dX to the layer below · dW to AdamW',
        items: [
          {
            id: 'x-in',
            label: 'Activations x',
            kind: 'io',
            sub: '(N, in) · FP32',
            detail:
              'The layer input, kept in high precision and saved for the backward pass: wgrad quantizes it again, along tokens.',
          },
          {
            tone: 'dotted',
            label: 'forward',
            items: [
              {
                columns: [
                  [
                    {
                      id: 'q-x',
                      label: 'Quantize x',
                      kind: 'attention',
                      sub: '1 × 16 along in · nearest',
                      detail:
                        '`quantize_nvfp4(x, "nearest", block=(1, 16))`: blocks run along `in_features`, the reduction dimension of `x Wᵀ`. Round-to-nearest-even: SR on activations only adds error.',
                    },
                  ],
                  [
                    {
                      id: 'q-w',
                      label: 'Quantize W',
                      kind: 'attention',
                      sub: '16 × 16 tiles · nearest',
                      side: {
                        id: 'w-master',
                        label: 'FP32 master W',
                        sub: '(out, in) · AdamW',
                        detail: 'The optimizer keeps and updates FP32 weights; every step quantizes them anew.',
                      },
                      detail:
                        '`quantize_nvfp4(weight, block=(16, 16))`: one E4M3 scale per 16 × 16 tile, so `Q(W)ᵀ = Q(Wᵀ)` and fprop and dgrad multiply by the same matrix.',
                    },
                  ],
                ],
              },
              {
                id: 'fprop',
                label: 'Fprop GEMM',
                kind: 'ffn',
                sub: 'y = Q(x) · Q(W)ᵀ',
                shape: '(N, out)',
                detail:
                  'Sums over `in`. On Blackwell an NVFP4 GEMM with FP32 accumulation; here an FP32 matmul of decoded values.',
              },
            ],
          },
          {
            id: 'dy',
            label: 'Gradient dY',
            kind: 'io',
            sub: '(N, out) · FP32 · from above',
            detail: 'The upstream gradient arriving in `backward(ctx, dy)`.',
          },
          {
            tone: 'dotted',
            label: 'backward',
            items: [
              {
                columns: [
                  [
                    {
                      id: 'q-dy',
                      label: 'Quantize dY',
                      kind: 'attention',
                      sub: '1 × 16 along out · stochastic',
                      detail:
                        '`quantize_nvfp4(dy, "stochastic", generator)`: blocks along `out`, the reduction dimension of `dY W`; SR makes `E[Q(dY)] = dY`.',
                    },
                    {
                      id: 'dgrad',
                      label: 'Dgrad GEMM',
                      kind: 'ffn',
                      sub: 'dX = Q(dY) · Q(W)',
                      side: {
                        id: 'w-reuse',
                        label: 'Q(W) from fprop',
                        sub: 'the same 16 × 16 tiles',
                        detail:
                          "With 2-D tiles the forward's quantized weight is already blocked along `out` too, so dgrad reuses it and differentiates the function fprop computed.",
                      },
                      detail:
                        'Sums over `out`. In expectation over the SR draws it is `dY · Q(W)`, the exact gradient of the forward.',
                    },
                  ],
                  [
                    {
                      id: 'rht',
                      label: 'Random Hadamard',
                      kind: 'attention',
                      sub: 'dYᵀH, xᵀH · 16 × 16 tiles',
                      detail:
                        '`rht(dy.T, RHT)` and `rht(x.T, RHT)`: both wgrad operands rotated along the token dimension by one 16 × 16 `H = S H₁₆ / 4`, shared by every layer. `H Hᵀ = I`, so the product is unchanged.',
                    },
                    {
                      id: 'q-wgrad',
                      label: 'Quantize both',
                      kind: 'attention',
                      sub: '1 × 16 along tokens',
                      detail: 'Stochastic rounding on `dYᵀH`, round-to-nearest on `xᵀH`, blocks of 16 tokens.',
                    },
                    {
                      id: 'wgrad',
                      label: 'Wgrad GEMM',
                      kind: 'ffn',
                      sub: 'dW = Q(dYᵀH) · Q(xᵀH)ᵀ',
                      detail:
                        "Sums over the N tokens: `(dYᵀH)(xᵀH)ᵀ = dYᵀ x`. The output goes to the FP32 master weight's `.grad`.",
                    },
                  ],
                ],
              },
            ],
          },
          {
            id: 'grads',
            label: 'dX and dW',
            kind: 'io',
            sub: 'FP32 · dX (N, in), dW (out, in)',
            detail: '`backward` returns `dx, dw, None, None`: one gradient per forward input.',
          },
        ],
        notes: [
          {at: 'q-w', text: '**16 × 16** tiles: Q(W)ᵀ = Q(Wᵀ)'},
          {at: 'q-dy', text: 'SR: **E[Q(dY)] = dY**', side: 'left'},
          {at: 'rht', text: 'one sign vector, **16 × 16** H'},
          {at: 'fprop', text: 'every GEMM: blocks along its **reduction** dim'},
        ],
      },
    },
    {
      title: 'The tiny LM by precision',
      architecture: {
        input: 'tokens · (8, 64) from a Markov stream',
        output: 'next-token loss · FP32 vs NVFP4',
        items: [
          {
            tone: 'model',
            items: [
              {
                id: 'lm-embed',
                label: 'Token + position embedding',
                kind: 'embed',
                sub: '64 × 64 each · FP32',
                detail: 'Embeddings stay in high precision, as in the paper.',
              },
              {
                tone: 'block',
                repeat: '2 ×',
                label: 'NVFP4 block',
                items: [
                  {id: 'lm-ln1', label: 'LayerNorm', kind: 'norm', sub: 'FP32'},
                  {
                    id: 'lm-qkv',
                    label: 'qkv · NVFP4Linear',
                    kind: 'attention',
                    sub: '64 → 192',
                    detail: 'Fprop, dgrad and wgrad on NVFP4 operands.',
                  },
                  {
                    id: 'lm-sdpa',
                    label: 'Causal attention',
                    sub: '4 heads × 16 · FP32',
                    detail: 'The softmax and both batched matmuls stay in high precision, as in the paper.',
                  },
                  {id: 'lm-proj', label: 'proj · NVFP4Linear', kind: 'attention', sub: '64 → 64'},
                  {id: 'lm-add1', op: '+', from: 'lm-ln1'},
                  {id: 'lm-ln2', label: 'LayerNorm', kind: 'norm', sub: 'FP32'},
                  {id: 'lm-fc', label: 'fc · NVFP4Linear', kind: 'attention', sub: '64 → 256'},
                  {id: 'lm-gelu', label: 'GELU', sub: 'FP32'},
                  {id: 'lm-fc2', label: 'fc2 · NVFP4Linear', kind: 'attention', sub: '256 → 64'},
                  {id: 'lm-add2', op: '+', from: 'lm-ln2'},
                ],
              },
              {
                tone: 'block',
                label: 'last block, high precision',
                items: [
                  {
                    id: 'lm-hp',
                    label: 'The same block, nn.Linear',
                    kind: 'ffn',
                    sub: 'qkv, proj, fc, fc2 in FP32',
                    detail:
                      '`Config.hp_last = 1`: the paper keeps its final layers in BF16 because they need more range and mantissa than FP4 gives.',
                  },
                ],
              },
              {id: 'lm-lnf', label: 'Final LayerNorm', kind: 'norm', sub: 'FP32'},
              {id: 'lm-head', label: 'Head', kind: 'head', sub: '64 → 64 · FP32'},
            ],
          },
          {
            id: 'lm-loss',
            label: 'Cross-entropy',
            kind: 'loss',
            sub: 'AdamW · FP32 master weights',
            detail:
              'Both runs share the init and the 200 batches; the self-test asserts the validation losses are within 0.05 nats.',
          },
        ],
        notes: [
          {at: 'lm-fc', text: '**8 of 12** block linears in NVFP4'},
          {at: 'lm-hp', text: 'the last block stays high precision', side: 'left'},
          {at: 'lm-loss', text: 'val loss **1.277** vs FP32 **1.274**'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'Pretraining Large Language Models with NVFP4',
      url: 'https://arxiv.org/abs/2509.25149',
      by: 'NVIDIA et al.',
      date: '2025-09-29',
      venue: 'arXiv',
      takes:
        'The recipe all three steps build: stochastic rounding on gradients only, 16 × 16 weight blocks for fprop/dgrad consistency, 16 × 16 random Hadamard transforms on the wgrad inputs with one shared sign vector, and the last layers kept in high precision.',
    },
    {
      kind: 'paper',
      title: 'Deep Learning with Limited Numerical Precision',
      url: 'https://arxiv.org/abs/1502.02551',
      by: 'Suyog Gupta et al.',
      date: '2015-02-09',
      venue: 'ICML 2015',
      takes:
        'Stochastic rounding, up with probability equal to the distance from the lower grid point, which `round_e2m1_stochastic` implements and step 1 shows to be unbiased where round-to-nearest is not.',
    },
    {
      kind: 'paper',
      title: 'QuaRot: Outlier-Free 4-Bit Inference in Rotated LLMs',
      url: 'https://arxiv.org/abs/2404.00456',
      by: 'Saleh Ashkboos et al.',
      date: '2024-03-30',
      venue: 'NeurIPS 2024',
      takes:
        'Computational invariance under Hadamard rotations: rotating both operands of a product leaves it unchanged, the identity `(x H)(w H)ᵀ = x wᵀ` step 2 tests blockwise.',
    },
    {
      kind: 'paper',
      title: 'Bridging the Gap Between Promise and Performance for Microscaling FP4 Quantization',
      url: 'https://arxiv.org/abs/2509.23202',
      by: 'Vage Egiazarian et al.',
      date: '2025-09-27',
      venue: 'ICLR 2026',
      takes:
        "Why a Hadamard transform does not lower NVFP4's relative error at group size 16, which step 2 measures (0.076 to 0.097 on Student-t data) instead of claiming the opposite.",
    },
    {
      kind: 'code',
      title: 'TransformerEngine',
      url: 'https://github.com/NVIDIA/TransformerEngine',
      by: 'NVIDIA',
      date: '2022-09-20',
      venue: 'GitHub',
      takes:
        'The production `NVFP4BlockScaling` recipe the toy mirrors: `disable_stochastic_rounding`, `disable_rht` and `disable_2d_quantization` are the three `Recipe` flags of step 3.',
    },
    {
      kind: 'docs',
      title: 'NVFP4',
      url: 'https://docs.nvidia.com/deeplearning/transformer-engine/features/low_precision_training/nvfp4/nvfp4.html',
      by: 'NVIDIA',
      venue: 'Transformer Engine documentation',
      takes:
        'The two-level scale formulas, SR for gradients only, 2-D scaling for weights and 1 × 16 for activations and gradients, and the RHT `H = S H_d / √d` tiled along the last dimension with d = 16 on the wgrad operands.',
    },
  ],
  steps: [stochasticRoundingStep, randomHadamardStep, nvfp4TrainStep],
  learn,
};
