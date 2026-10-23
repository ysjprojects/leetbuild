import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {nvfp4QuantizeStep} from './steps/1-nvfp4-quantize';

/**
 * Deep-learning problem: the NVFP4 format from scratch in PyTorch. E2M1 rounding with ties to even
 * and saturation, the 4-bit codes and their packing, the FP32 tensor scale and the E4M3 scale per
 * block of 16, dequantization, and a comparison with OCP MXFP4 on Gaussian data with outliers.
 */
export const ptNvfp4FormatProblem: Problem = {
  id: 'pt-nvfp4-format',
  title: 'NVFP4: the format and its two-level scales',
  tagline:
    'Write NVFP4 bit by bit: E2M1 rounding with ties to even, 4-bit codes packed two per byte, an E4M3 scale per 16 values under one FP32 tensor scale, and 3.6× less error than MXFP4 on data with outliers.',
  difficulty: 'easy',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 25,
  statement: `# NVFP4: the format and its two-level scales

NVFP4 is the 4-bit floating-point format NVIDIA introduced with the Blackwell architecture. Each value is
an E2M1 number (1 sign, 2 exponent and 1 mantissa bits: ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}). Every 16
consecutive values share one FP8 E4M3 scale, and the whole tensor shares one FP32 scale. It refines OCP's
MXFP4, which scales blocks of 32 by a power of two. Blackwell's tensor cores multiply NVFP4 operands
natively, scales included. In a modern stack it sits under the matmuls: TensorRT Model Optimizer and
LLM Compressor write NVFP4 checkpoints, TensorRT-LLM and vLLM serve them, and Transformer Engine uses
it for the GEMMs of pretraining.

You write one file, \`nvfp4.py\`:

- Constants \`E2M1_VALUES\` (the 8 magnitudes, indexed by the 3-bit code), \`BLOCK = 16\`,
  \`E4M3_MAX = 448.0\`, \`E2M1_MAX = 6.0\`.
- \`round_to_e2m1(x) -> Tensor\`: nearest E2M1 value, ties to the even code, saturating at ±6.
- \`e2m1_to_codes(v) -> uint8\` (sign in bit 3, exponent in bits 2..1, mantissa in bit 0) and
  \`codes_to_e2m1(codes) -> float32\`.
- \`pack_fp4(codes (..., n) uint8) -> (..., n/2) uint8\` (low nibble first) and \`unpack_fp4\`.
- \`quantize_nvfp4(x (..., K)) -> NVFP4Tensor(packed uint8 (..., K/2), scales float8_e4m3fn (..., K/16),
  global_scale float32 0-d, shape)\` and \`dequantize_nvfp4(t) -> float32 (..., K)\`.

## What you build here

1. **The format**: E2M1 rounding written by hand, the 16 codes and their bits, two codes per byte,
   the tensor scale \`amax / (6 · 448)\`, the E4M3 block scales, the elements divided by the stored
   scales, dequantization, and the MXFP4 baseline it beats.

## Run it on your machine

Run \`python nvfp4.py\` (a PyTorch recent enough to have \`torch.float8_e8m0fnu\`, CPU only; a few seconds).
It prints \`PASS\` once it has checked:
- the ties, saturation and signs, and the rounding against a brute-force nearest-even search;
- every code and the packing round trip;
- a half-step error bound on a \`64 × 256\` Gaussian matrix with 1% outliers (every block with a normal
  E4M3 scale);
- a zero block, and agreement with a block-by-block reference;
- a mean squared error below MXFP4's (0.00929 against 0.01315 on plain Gaussian values, 0.03661
  against 0.13196 with the outliers);
- 4.5 bits per value plus 32 bits per tensor.

## Left out on purpose

The tensor-core GEMM and its swizzled scale layout (the next problem multiplies NVFP4 matrices);
stochastic rounding, 16 × 16 2D weight blocks and random Hadamard transforms (the training recipe,
two problems on); the rowwise and columnwise copies a training step needs; amax reduction across ranks;
calibrated or MSE-searched scales; serialisation to a checkpoint.`,
  figures: [
    {
      title: 'Quantizing a tensor to NVFP4',
      architecture: {
        input: 'x · (..., K) float32, K a multiple of 16',
        output: 'x̂ ≈ x, float32',
        items: [
          {
            id: 'x-in',
            label: 'Input tensor x',
            kind: 'io',
            sub: '(..., K) · blocks along K',
            shape: '[..., K]',
            detail:
              'Weights or activations, blocked along the reduction dimension K, the dimension a matmul sums over. One block scale is then one factor per 16-wide partial dot product.',
          },
          {
            id: 'amax',
            label: 'Tensor amax',
            sub: 'amax = max |x|',
            detail: 'One number for the whole tensor. In distributed training it is reduced (max) across ranks first.',
          },
          {
            id: 's-global',
            label: 'FP32 tensor scale',
            sub: 's_g = amax / (6 · 448)',
            shape: '0-d float32',
            detail:
              'A decode scale: the tensor amax divided by the largest E2M1 value times the largest E4M3 value. Then the block holding the amax gets block scale exactly 448, and all the others lie below it. An all-zero tensor gets 1.',
          },
          {
            tone: 'block',
            repeat: 'K/16 ×',
            label: 'Block of 16 values',
            items: [
              {
                id: 'block-amax',
                label: 'Block amax',
                sub: 'a_b = max of 16 |x|',
                shape: '[..., K/16]',
              },
              {
                id: 's-block',
                label: 'E4M3 block scale',
                kind: 'attention',
                sub: 's_b = e4m3(min(a_b/6/s_g, 448))',
                shape: '[..., K/16] e4m3',
                detail:
                  '`torch.float8_e4m3fn`, round to nearest even: 3 mantissa bits put `s_b · s_g` within 6.25% of `a_b / 6`, not within a factor of 2 like a power of two. A block 459,000 times quieter than the loudest gets 0.',
              },
              {
                id: 'e2m1-round',
                label: 'Round to E2M1',
                kind: 'attention',
                sub: 'q = rne(x / (s_b · s_g)), ±6',
                shape: '[..., K/16, 16]',
                detail:
                  'Divided by the **stored** scale, so the decoder multiplies by the number the encoder used. Nearest of ±{0, 0.5, 1, 1.5, 2, 3, 4, 6}, ties to the even code, clamped at ±6 (the block amax can land at up to 6.375 when E4M3 rounded its scale down).',
              },
              {
                id: 'codes',
                label: '4-bit codes',
                sub: 'sign · bit 3 · E2M1 index · 2..0',
                shape: '[..., K] uint8',
                detail: '1.5 is `0b0011`, −6 is `0b1111`. The low three bits index `E2M1_VALUES`.',
              },
            ],
          },
          {
            id: 'pack',
            label: 'Pack two per byte',
            sub: 'c[0::2] | c[1::2] << 4',
            shape: '[..., K/2] uint8',
            detail: 'Element `2j` in the low nibble, `2j + 1` in the high nibble: `[3, 10]` becomes `0xA3`.',
          },
          {
            id: 'nvfp4-out',
            label: 'NVFP4Tensor',
            kind: 'io',
            sub: 'packed · scales · global_scale',
            detail: '8 bytes of codes and 1 byte of scale per 16 values, plus 4 bytes per tensor.',
          },
          {
            id: 'dequant',
            label: 'Dequantize',
            sub: 'x̂ = E2M1[code] · s_b · s_g',
            shape: '[..., K] float32',
            detail:
              'What a tensor core does per 16-wide block inside the GEMM: the two operands’ block scales multiply each partial dot product, and the two tensor scales multiply the output once.',
          },
        ],
        notes: [
          {at: 's-global', text: '**6 · 448 = 2,688**: the loudest block scale is 448'},
          {at: 's-block', text: 'Scale error **≤ 6.25%**, against up to 2× for E8M0'},
          {at: 'e2m1-round', text: 'Ties to even: **2.5 → 2**, **5 → 4**'},
          {at: 'pack', text: '**4.5 bits** per value + 32 per tensor'},
          {at: 'dequant', text: 'MSE **3.6×** below MXFP4 with outliers', side: 'left'},
        ],
      },
    },
    {
      title: 'One block in memory',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'block-codes',
            label: 'One block: 16 E2M1 codes',
            sub: 'uint8 · values 0 … 15 · 4 of 8 bits used',
            items: [
              {
                array: 'codes[r, 16b … 16b + 15]',
                sub: 'hex · marks: packed bytes b0, b1, b7',
                cols: 16,
                cells: ['9', '3', 'D', '1', '4', 'A', '7', 'F', '0', 'A', '2', 'A', '5', '1', '4', '3'],
                marks: [
                  {cols: [0, 1], tone: 'a', label: 'b0'},
                  {cols: [2, 3], tone: 'b', label: 'b1'},
                  {cols: [14, 15], tone: 'c', label: 'b7'},
                ],
                detail:
                  'The codes of the block x = [−0.08, 0.36, −0.78, 0.07, 0.66, −0.25, 1.62, −1.60, 0.03, −0.31, 0.29, −0.22, 0.85, 0.11, 0.55, 0.43] in a tensor whose amax is 10. Code 7 is +6 (the block amax), F is −6, 9 is −0.5, 0 is 0. An intermediate tensor, one byte per code before packing.',
              },
            ],
          },
          {
            id: 'hbm-tensor',
            label: 'NVFP4Tensor in global memory',
            sub: '8 + 1 bytes per 16 values · 4.5 bits each',
            tone: 'global',
            layout: 'column',
            align: 'start',
            items: [
              {
                id: 'packed-bytes',
                array: 'packed[r, 8b … 8b + 7]',
                sub: 'uint8 · low nibble first',
                cols: 8,
                cells: ['39', '1D', 'A4', 'F7', 'A0', 'A2', '15', '34'],
                marks: [
                  {cols: [0, 0], tone: 'a'},
                  {cols: [1, 1], tone: 'b'},
                  {cols: [7, 7], tone: 'c'},
                ],
                detail:
                  'Byte 0 holds codes 9 (low nibble) and 3 (high nibble): `9 | 3 << 4 = 0x39`. Byte 7 holds 4 and 3: `0x34`.',
              },
              {
                id: 'scale-byte',
                array: 'scales[r, b]',
                sub: 'E4M3 · 1 byte per 16 values',
                cols: 1,
                cells: ['0x69'],
                detail:
                  'The block amax 1.62 over 6 over `s_g = 10 / 2,688` is 72.58, stored as E4M3 72.0 = 1.125 · 2⁶ (sign 0, exponent 1101, mantissa 001). 1.62 then scales to 6.05 and saturates to code 7.',
              },
              {
                id: 'global-scale',
                array: 'global_scale',
                sub: 'FP32 · 4 bytes per tensor',
                cols: 1,
                cells: ['s_g'],
                detail: '`10 / 2,688 = 0.00372` here: one number shared by every block of the tensor.',
              },
            ],
          },
          {
            id: 'deq',
            label: 'dequantize_nvfp4',
            sub: 'E2M1[code] · 72.0 · s_g → float32',
            tone: 'compute',
            detail:
              'Code 3 decodes to 1.5 · 72 · 0.00372 = 0.402 (from 0.36); code 7 to 6 · 72 · 0.00372 = 1.607 (from 1.62). Block MSE 0.0022, against 0.0038 for MXFP4’s `X = 0.25` on the same 16 values.',
          },
        ],
        arrows: [
          {from: 'block-codes', to: 'hbm-tensor', label: 'pack_fp4 → packed · 2 per byte'},
          {from: 'hbm-tensor', to: 'deq', label: 'unpack_fp4, codes_to_e2m1'},
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
        'Appendix B’s quantization procedure that `quantize_nvfp4` follows: the global encode scale `6 · 448 / amax`, the E4M3 block decode scale `amax_b / 6` times it with round to nearest even, elements scaled by the stored scale, and why power-of-two MXFP4 scales lose up to a binade.',
    },
    {
      kind: 'paper',
      title: 'Microscaling Data Formats for Deep Learning',
      url: 'https://arxiv.org/abs/2310.10537',
      by: 'Bita Darvish Rouhani et al.',
      date: '2023-10-16',
      venue: 'arXiv',
      takes:
        'The block-scaled family NVFP4 refines: one shared scale per small block of narrow elements, and MXFP4 as the 4-bit member that the self-test’s baseline implements.',
    },
    {
      kind: 'docs',
      title: 'OCP Microscaling Formats (MX) Specification Version 1.0',
      url: 'https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf/',
      by: 'Bita Darvish Rouhani et al.',
      date: '2023-09',
      venue: 'Open Compute Project',
      takes:
        'The E2M1 element (bias 1, values to ±6, round ties to even, saturation), the E8M0 scale, blocks of 32, and the conversion rule `X = 2^⌊log₂ amax⌋ / 4` that `mxfp4_roundtrip` uses.',
    },
    {
      kind: 'code',
      title: 'Transformer Engine',
      url: 'https://github.com/NVIDIA/TransformerEngine',
      by: 'NVIDIA',
      date: '2022-09-20',
      venue: 'GitHub',
      takes:
        'The production `NVFP4Quantizer` this file reproduces on CPU: rowwise 1 × 16 blocks with `scales` of shape `[A, B/16]`, an FP32 global scale from the tensor amax, and the `NVFP4BlockScaling` recipe around it.',
    },
    {
      kind: 'docs',
      title: 'NVFP4',
      url: 'https://docs.nvidia.com/deeplearning/transformer-engine/features/low_precision_training/nvfp4/nvfp4.html',
      by: 'NVIDIA',
      venue: 'Transformer Engine documentation',
      takes:
        'The formulas the task states, `x = x_e2m1 · s_block · s_global`, `s_global = amax / (448 · 6)` and `s_block = (amax_b / 6) / s_global` stored in E4M3, and what the training recipe adds (2D weight blocks, stochastic rounding, Hadamard transforms).',
    },
    {
      kind: 'post',
      title: 'Introducing NVFP4 for Efficient and Accurate Low-Precision Inference',
      url: 'https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/',
      by: 'Eduardo Alvarez et al.',
      date: '2025-06-24',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The comparison of FP4, MXFP4 and NVFP4 behind the self-test’s baseline, fractional E4M3 against power-of-two E8M0 scales, and the 4.5 bits per value that `NVFP4Tensor` stores.',
    },
  ],
  steps: [nvfp4QuantizeStep],
  learn,
};
