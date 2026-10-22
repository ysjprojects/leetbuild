import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {nvfp4GemmStep} from './steps/1-nvfp4-gemm';
import {nvfp4PtqStep} from './steps/2-nvfp4-ptq';

/**
 * Deep-learning project: NVFP4 for inference in PyTorch. The block-scaled GEMM a Blackwell tensor core
 * runs on two NVFP4 operands (exact FP4 products per block of 16, E4M3 block scales on the partial sums,
 * FP32 accumulation, two per-tensor scales once per output), an NVFP4Linear with weights quantized once
 * and activations quantized per forward under a calibrated global scale, and post-training quantization
 * of a small LM compared against MXFP4 and INT4 on output error, perplexity and memory.
 */
export const ptNvfp4LinearProblem: Problem = {
  id: 'pt-nvfp4-linear',
  title: 'NVFP4 inference: block-scaled GEMM and PTQ',
  tagline:
    'Multiply two NVFP4 tensors the way a Blackwell tensor core does, wrap it in a calibrated W4A4 linear layer, and quantize a small LM against MXFP4 and INT4 at the same 4.5 bits.',
  difficulty: 'medium',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 50,
  statement: `# NVFP4 inference: block-scaled GEMM and PTQ

NVFP4 is the 4-bit floating-point format NVIDIA introduced with the Blackwell architecture. Every value
is an E2M1 number, one of ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}. Every 16 consecutive values along the reduction
dimension share one FP8 E4M3 scale, and one FP32 scale covers the whole tensor. That is 4.5 bits per value.
Blackwell tensor cores multiply such operands directly: they form the 4-bit products of a block exactly,
apply the two block scales to the partial sum and accumulate in FP32. In a modern stack, a post-training
quantization tool (NVIDIA Model Optimizer, LLM Compressor) turns a bf16 checkpoint into NVFP4 weights plus
calibrated activation scales. TensorRT-LLM or vLLM then serve it with the weights and the activations of
every linear layer in 4 bits (W4A4). NVIDIA reports 1% or less accuracy loss against FP8 on DeepSeek-R1-0528
with about 3.5× less memory than FP16.

You write two files, the second importing the first:

**\`nvfp4_gemm.py\`** gives the canonical quantizer: \`nvfp4_quantize(x (rows, K), s_global=None) ->
NVFP4Tensor(codes (rows, K/2) uint8, scales (rows, K/16) float8_e4m3fn, s_global () float32)\`,
\`nvfp4_dequantize\` and \`global_scale(amax) = amax / (6 · 448)\`. You write:

- \`nvfp4_matmul(a (M, K), b (N, K)) -> (M, N)\` float32, block by block;
- \`NVFP4Linear.from_linear(linear, act_amax=None)\`, with buffers \`w_codes\`, \`w_scales\`, \`w_global\`,
  \`act_amax\` and \`bias\`;
- \`NVFP4Linear.forward(x (..., in)) -> (..., out)\`.

**\`nvfp4_ptq.py\`** gives a \`TinyLM\` (2 blocks, width 128, vocabulary 64). You write:

- \`mxfp4_quantize(x) -> (codes uint8, scales float8_e8m0fnu)\` (blocks of 32, OCP MX v1.0);
- \`int4_quantize(x) -> (codes uint8, scales float16)\` (symmetric, groups of 32);
- \`collect_act_amax(model, calib, names) -> {name: amax}\`;
- \`quantize_model(model, fmt, act_amax=None)\` for \`fmt\` in \`"nvfp4"\`, \`"mxfp4"\`, \`"int4"\`;
- \`weight_bytes(model) -> int\`.

## What you build here

1. **The block-scaled GEMM and NVFP4Linear**: one exact FP4 dot product per K block, scaled by the two
   operands' E4M3 block scales and summed in FP32, then the two global scales. A linear layer whose weight
   is quantized once and whose input is quantized on every forward under a calibrated global scale.
2. **Post-training quantization**: train a small LM, calibrate activation ranges with hooks, swap its block
   linears and keep the embeddings and head in fp32. Then compare NVFP4 with MXFP4 and INT4 per group on
   layer output error, perplexity and bytes.

## Run it on your machine

Put both files in one directory and run \`python nvfp4_gemm.py\`, then \`python nvfp4_ptq.py\` (PyTorch 2.x
with \`float8_e4m3fn\` and \`float8_e8m0fnu\`, CPU only). The first takes about 2 s. The second about 15 s,
8 of them training. Each prints \`PASS\`:
- The first proves the GEMM equals dequantize-then-matmul to fp32 rounding and a float64 block-by-block
  loop to 1e-6. It also proves that it differs from the fp32 product only by quantization error, and that
  the layer stores 4.5 bits per weight.
- The second proves the orderings it measured: output error NVFP4 < INT4 < MXFP4, and held-out perplexity
  fp32 < NVFP4 < INT4 < MXFP4 (8.41, 8.96, 9.22, 9.57). Block weights take 216 KiB in NVFP4 against 1,536
  KiB in fp32.

## Left out on purpose

Real Blackwell kernels: \`tcgen05.mma\`, the swizzled scale-factor layout, accumulators in tensor memory,
activation quantization fused into the previous kernel. Also left out: NVFP4 KV caches; SmoothQuant, AWQ
or Hadamard rotations before quantizing; GPTQ-style error feedback on the 4-bit grid; quantization-aware
training and training in NVFP4; per-layer format search; checkpoint export.`,
  figures: [
    {
      title: 'The NVFP4 linear layer',
      architecture: {
        input: 'x · tokens × in, fp32',
        output: 'y · tokens × out, fp32',
        items: [
          {
            id: 'x-in',
            label: 'Activations x',
            kind: 'io',
            sub: '(tokens, in) · fp32',
            shape: '[T, in]',
            detail: '`forward` flattens every leading dimension into tokens: K is the last axis, `in_features`.',
          },
          {
            id: 'act-quant',
            label: 'Quantize x along K',
            kind: 'attention',
            sub: 'E2M1 · E4M3 per 16 · FP32 s_x',
            shape: 'codes [T, in/2] · scales [T, in/16]',
            detail:
              '`nvfp4_quantize(x, s_x)` on every forward: `s_block = e4m3(amax_block / 6 / s_x)`, `q = e2m1(x / (s_block · s_x))`, packed two codes per byte. `s_x = global_scale(act_amax)` once calibrated, else from this input’s own amax.',
            side: {
              id: 'calib-amax',
              label: 'Calibrated amax',
              sub: 'max |x| on calib batches',
              detail:
                'Fixed before serving: `s_x = amax / (6 · 448)` is a constant, so no reduction over the input is needed before quantizing it. Inputs past it clip.',
            },
          },
          {
            tone: 'block',
            repeat: 'in/16 ×',
            label: 'K block b',
            items: [
              {
                id: 'block-dot',
                label: 'FP4 dot products',
                kind: 'attention',
                sub: 'P = Σ₁₆ q_x · q_w · exact fp32',
                shape: '[T, out]',
                detail:
                  'One 16-term dot product of E2M1 values per (token, output). Each product is a multiple of 1/4 at most 36, so the block sum (at most 576) is exact in fp32.',
                side: {
                  id: 'w-nvfp4',
                  label: 'W in NVFP4',
                  sub: 'quantized once · 4.5 bits',
                  detail:
                    '`from_linear` stores `w_codes (out, in/2)` uint8, `w_scales (out, in/16)` E4M3 and `w_global = amax(W) / (6 · 448)`. No float weight is kept.',
                },
              },
              {
                id: 'block-scale',
                label: 'Block scales',
                sub: 'acc += P · s_x[t, b] · s_w[o, b]',
                detail:
                  'The E4M3 scales of the same K block of the input row and the weight row. Their product is exact in fp32; the only rounding is the fp32 accumulation across blocks.',
              },
            ],
          },
          {
            id: 'global-scale',
            label: 'Global scales',
            sub: 'acc · s_x,global · s_w,global',
            detail:
              'Two FP32 scalars per GEMM, applied once to the fp32 result: the second level that keeps every block scale inside E4M3’s range.',
          },
          {
            id: 'bias-add',
            label: 'Bias in fp32',
            sub: 'y = acc + b',
            detail: 'The bias is never quantized. The output stays fp32 here; kernels usually write bf16.',
          },
          {
            id: 'y-out',
            label: 'Output y',
            kind: 'io',
            sub: '(…, out) · fp32',
            shape: '[T, out]',
          },
        ],
        notes: [
          {at: 'act-quant', text: '**4.5** bits per value: 4 + 8/16'},
          {at: 'block-dot', text: 'Block sums exact: **≤ 576**, multiples of 1/4'},
          {at: 'global-scale', text: '**2** FP32 scalars per GEMM'},
        ],
      },
    },
    {
      title: 'Scales along the K blocks',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'g-hbm',
            label: 'Operands in HBM',
            sub: 'two K blocks of 16 shown',
            tone: 'global',
            layout: 'row',
            align: 'start',
            items: [
              {
                label: 'A · activations',
                layout: 'column',
                align: 'start',
                items: [
                  {
                    id: 'g-a',
                    array: 'A codes · M × K',
                    sub: 'one E2M1 value per cell',
                    cols: 32,
                    rows: 4,
                    continues: true,
                    marks: [
                      {cols: [0, 15], tone: 'a', label: 'block 0'},
                      {cols: [16, 31], tone: 'b', label: 'block 1'},
                    ],
                    detail:
                      'Rows are tokens, columns are K. Each run of 16 columns in one row is a block; packed, it is 8 bytes.',
                  },
                  {
                    id: 'g-sfa',
                    array: 'SFA · M × K/16',
                    sub: 'E4M3 · s_a[m, blk]',
                    cols: 2,
                    rows: 4,
                    continues: true,
                    marks: [
                      {cols: [0, 0], tone: 'a'},
                      {cols: [1, 1], tone: 'b'},
                    ],
                    detail:
                      'One E4M3 scale per row and K block: column `blk` scales columns `16·blk … 16·blk + 15` of A.',
                  },
                ],
              },
              {
                label: 'B · weights',
                layout: 'column',
                align: 'start',
                items: [
                  {
                    id: 'g-b',
                    array: 'B codes · N × K',
                    sub: 'one E2M1 value per cell',
                    cols: 32,
                    rows: 4,
                    continues: true,
                    marks: [
                      {cols: [0, 15], tone: 'a', label: 'block 0'},
                      {cols: [16, 31], tone: 'b', label: 'block 1'},
                    ],
                    detail:
                      'The weight, `(out, in)`: blocked along the same K as A, so block `blk` of A always meets block `blk` of B.',
                  },
                  {
                    id: 'g-sfb',
                    array: 'SFB · N × K/16',
                    sub: 'E4M3 · s_b[n, blk]',
                    cols: 2,
                    rows: 4,
                    continues: true,
                    marks: [
                      {cols: [0, 0], tone: 'a'},
                      {cols: [1, 1], tone: 'b'},
                    ],
                    detail: 'Quantized once, with the weight. A scale per output row and K block.',
                  },
                ],
              },
            ],
          },
          {
            id: 'g-mma',
            label: 'Block-scaled MMA',
            sub: 'D += s_a · s_b · Σ₁₆ a · b',
            tone: 'compute',
            items: [
              {
                id: 'g-acc',
                array: 'D · M × N',
                sub: 'fp32 accumulator, on chip',
                tone: 'register',
                cols: 4,
                rows: 4,
                detail:
                  'Every K block adds one scaled partial sum to each entry. After the last block, the two global scales multiply D once. On Blackwell the accumulator lives in tensor memory.',
              },
            ],
          },
        ],
        arrows: [{from: 'g-hbm', to: 'g-mma', label: 'codes + matching scales'}],
      },
    },
    {
      title: 'PTQ of the small LM',
      architecture: {
        input: 'token ids · calibration or held-out',
        output: 'perplexity, layer error, bytes per format',
        items: [
          {
            id: 'calib-batch',
            label: 'Token ids',
            kind: 'io',
            sub: 'calib 32 × 64 · held-out 128 × 64',
            shape: '[B, 64] int64',
            detail:
              'Drawn from the same order-2 Markov chain as the training data. Calibration is one float forward over 32 sequences; evaluation uses 128 others.',
          },
          {
            id: 'keep-embed',
            label: 'wte + wpe, fp32',
            kind: 'embed',
            sub: '64 → 128 · kept',
            detail: 'A lookup, not a GEMM: NVFP4 would save its memory but speed up nothing.',
          },
          {
            tone: 'block',
            repeat: '2 ×',
            label: 'Transformer block',
            items: [
              {id: 'ln1', label: 'LayerNorm', kind: 'norm', sub: 'fp32'},
              {
                id: 'q-qkv',
                label: 'qkv · 4-bit linear',
                kind: 'attention',
                sub: '128 → 384 · W4A4',
                detail:
                  '`NVFP4Linear.from_linear(linear, act_amax[name])`, or a `QDQLinear` for MXFP4 and INT4. The same for every linear of the block.',
                side: {
                  id: 'calib-hooks',
                  label: 'amax pre-hook',
                  sub: 'max |x| per layer',
                  detail:
                    '`collect_act_amax` hooks each block linear during one float forward over the calibration batch, then removes the hooks.',
                },
              },
              {id: 'sdpa', label: 'Causal attention', sub: '4 heads · fp32'},
              {id: 'q-proj', label: 'proj · 4-bit linear', kind: 'attention', sub: '128 → 128'},
              {id: 'res1', op: '+', from: 'ln1'},
              {id: 'ln2', label: 'LayerNorm', kind: 'norm', sub: 'fp32'},
              {id: 'q-fc1', label: 'fc1 · 4-bit linear', kind: 'attention', sub: '128 → 512'},
              {id: 'gelu', label: 'GELU', sub: 'fp32'},
              {
                id: 'q-fc2',
                label: 'fc2 · 4-bit linear',
                kind: 'attention',
                sub: '512 → 128',
                detail: 'Its input is GELU output: skewed, mostly small, a long positive tail.',
              },
              {id: 'res2', op: '+', from: 'ln2'},
            ],
          },
          {id: 'ln-f', label: 'Final LayerNorm', kind: 'norm', sub: 'fp32'},
          {
            id: 'keep-head',
            label: 'LM head, fp32',
            kind: 'head',
            sub: '128 → 64 · not quantized',
            detail:
              'Its error lands on the logits with nothing after it. Quantizing it too raised perplexity from 8.957 to 9.044 in one run; ModelOpt’s defaults exclude `*lm_head*`.',
          },
          {
            id: 'compare',
            label: 'Compare formats',
            kind: 'loss',
            sub: 'NVFP4 · MXFP4 · INT4 g = 32',
            detail:
              'Mean relative output error of the 8 linears on the float model’s inputs, held-out perplexity, and `weight_bytes`. One run: errors 0.107, 0.138, 0.113; perplexity 8.957, 9.565, 9.219 (fp32 8.405).',
          },
        ],
        notes: [
          {at: 'q-fc1', text: 'Block weights **1,536 → 216 KiB**'},
          {at: 'keep-head', text: 'Quantized head: ppl **8.96 → 9.04**'},
          {at: 'compare', text: 'NV **8.96** · INT4 **9.22** · MX **9.57**'},
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
        'The two-level scaling `nvfp4_quantize` follows: a per-tensor encode scale `6 · 448 / amax`, its FP32 inverse applied after the NVFP4 GEMM, and E4M3 scales per block of 16.',
    },
    {
      kind: 'paper',
      title: 'Microscaling Data Formats for Deep Learning',
      url: 'https://arxiv.org/abs/2310.10537',
      by: 'Bita Darvish Rouhani et al.',
      date: '2023-10-16',
      venue: 'arXiv',
      takes:
        'The MX family that MXFP4, the baseline of step 2, belongs to: blocks of 32 elements sharing one power-of-two scale, evaluated as a drop-in replacement for FP32 in inference.',
    },
    {
      kind: 'code',
      title: 'NVIDIA Model Optimizer',
      url: 'https://github.com/NVIDIA/Model-Optimizer',
      by: 'NVIDIA',
      date: '2024-04-23',
      venue: 'GitHub',
      takes:
        'The PTQ recipe of step 2: max calibration of a static activation scale `amax / (6 · 448)`, weight scales from `NVFP4QTensor`, and default exclusions that keep `*lm_head*` unquantized.',
    },
    {
      kind: 'post',
      title: 'Introducing NVFP4 for Efficient and Accurate Low-Precision Inference',
      url: 'https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/',
      by: 'Eduardo Alvarez et al.',
      date: '2025-06-24',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The comparison step 2 measures: 16-value blocks with E4M3 scales against MXFP4’s 32-value power-of-two blocks, 4.5 bits per value, and about 3.5× less memory than FP16.',
    },
    {
      kind: 'docs',
      title: 'OCP Microscaling Formats (MX) Specification Version 1.0',
      url: 'https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf/',
      by: 'Bita Darvish Rouhani et al.',
      date: '2023-09-07',
      venue: 'Open Compute Project',
      takes:
        'The rules `mxfp4_quantize` implements: E2M1 elements, an E8M0 scale equal to the largest power of two not above amax divided by 4, saturation at 6, and the dot product with the block scales factored out.',
    },
    {
      kind: 'docs',
      title: 'Blackwell SM100 GEMMs',
      url: 'https://docs.nvidia.com/cutlass/latest/media/docs/cpp/blackwell_functionality.html',
      venue: 'NVIDIA CUTLASS Documentation',
      takes:
        'The block-scaled GEMM `nvfp4_matmul` computes, `D = C + Σ_k (A · SFA[i, k/SV]) (B · SFB[j, k/SV])`, with `SV = 16` and E4M3 scales for `nv_float4_t`, 32 and E8M0 for `mx_float4_t`.',
    },
  ],
  steps: [nvfp4GemmStep, nvfp4PtqStep],
  learn,
};
