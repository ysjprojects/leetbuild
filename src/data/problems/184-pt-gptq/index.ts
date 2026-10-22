import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {int4RtnStep} from './steps/1-int4-rtn';
import {hessianStep} from './steps/2-hessian';
import {gptqSolverStep} from './steps/3-gptq-solver';
import {quantizeModelStep} from './steps/4-quantize-model';

/**
 * Deep-learning project: GPTQ from scratch in PyTorch. Asymmetric 4-bit group quantization with
 * nibble packing and a QuantLinear, the layer Hessian from calibration activations, the GPTQ solver
 * (Cholesky of H⁻¹, column-wise error feedback, lazy batch updates), and sequential quantization of a
 * small transformer LM measured by held-out perplexity against round-to-nearest.
 */
export const ptGptqProblem: Problem = {
  id: 'pt-gptq',
  title: 'GPTQ from scratch: 4-bit weights with error feedback',
  tagline:
    'Pack 4-bit weights with per-group scales, collect each layer’s Hessian from calibration data, and quantize column by column with the inverse Hessian’s Cholesky factor, then compress a small LM to 4.19 bits per weight.',
  difficulty: 'hard',
  track: 'dllm',
  language: 'python',
  concepts: ['pytorch'],
  minutes: 120,
  statement: `# GPTQ from scratch: 4-bit weights with error feedback

GPTQ (Frantar, Ashkboos, Hoefler and Alistarh, ICLR 2023) is the post-training quantizer that made
4-bit LLM checkpoints ordinary. It needs no training and no labels: a few hundred calibration sequences,
one layer at a time, and a closed-form update that quantizes a weight matrix column by column while
pushing each column's rounding error onto the columns not yet quantized. A 175B model quantizes in about
four GPU hours. In a modern stack it sits between the trained checkpoint and the server: AutoGPTQ and
GPTQModel produce the checkpoints, \`transformers\` loads them, and vLLM, TGI and ExLlama run them with
int4 kernels that dequantize inside the matmul, so a decode step reads a quarter of the fp16 bytes.

You write four files, each importing the previous one:

- \`quant_int4.py\`: \`quant_params(w, bits)\` and \`quantize(w, scale, zero, bits)\`;
  \`quantize_rtn(W (out, in), bits=4, group_size=128) -> (codes (out, in) uint8, scales (out, in/g) fp16,
  zeros (out, in/g) uint8)\`; \`dequantize\`; \`pack_int4\` / \`unpack_int4\` (two codes per byte, low nibble
  first); \`QuantLinear\` with buffers \`qweight (out, in/2) uint8\`, \`scales\`, \`zeros\`, \`bias\`, built by
  \`QuantLinear.from_quantized(linear, codes, scales, zeros, group_size)\`, and \`bits_per_weight()\`.
- \`gptq_hessian.py\`: \`HessianCollector(layer)\`, a forward pre-hook keeping \`H = (2/n) Σ x xᵀ\`
  \`(in, in)\` float32 as a running average over tokens, and \`prepare_hessian(H, W, percdamp=0.01)\` for
  dead columns and damping.
- \`gptq_solver.py\`: \`gptq_quantize(W, H, bits=4, group_size=128, blocksize=128) -> (codes, scales,
  zeros)\`, the paper's algorithm with the upper Cholesky factor of \`H⁻¹\` and lazy batch updates.
- \`gptq_model.py\`: \`quantize_model_gptq(model, calib)\` and \`quantize_model_rtn(model)\` on a small
  transformer LM, sequentially, block by block, and \`linear_weight_bytes(model)\`.

## What you build here

1. **The 4-bit format**: asymmetric per-group scale and zero point, round to nearest, two codes per
   byte, and a \`QuantLinear\` that dequantizes and multiplies, at 4.1875 bits per weight.
2. **The layer Hessian**: a pre-hook that averages \`2 x xᵀ\` over calibration tokens in float32, and the
   dead-column and damping fixes that make it factor.
3. **The solver**: Cholesky of \`H⁻¹\`, columns quantized left to right with group grids taken from the
   updated weights, each error spread over the rest of its block, one lazy update per block.
4. **The model**: calibration activations flowing through the layers already quantized, \`QuantLinear\`
   swapped in, held-out perplexity of fp32, GPTQ and round-to-nearest, and the weight memory.

## Run it on your machine

Put the four files in one directory and run \`python quant_int4.py\`, \`python gptq_hessian.py\`,
\`python gptq_solver.py\` and \`python gptq_model.py\` (PyTorch 2.x, CPU only). The first three take about
a second each; the last trains its small model for 400 steps first and takes about 15 s. Each prints
\`PASS\`: the format by its half-step error bound and exact packing round trip, the Hessian by the
explicit \`(2/n) XᵀX\`, the solver by a lower output error than round-to-nearest (about 5× on correlated
inputs) and by agreeing with a slow column-by-column reference, and the model by held-out perplexity
ordered fp32 ≤ GPTQ < RTN with 7.64× less block-weight memory than fp32.

## Left out on purpose

Act-order (columns in decreasing \`diag(H)\`) and static groups; symmetric grids and 2-, 3- and 8-bit
packings into \`int32\` words; quantized zero points (\`qzeros\`); fused int4 GPU kernels (ExLlama,
Marlin) that dequantize in registers; activation-aware scaling (AWQ) and outlier handling for
activations (LLM.int8()); calibration on C4 or WikiText and checkpoint serialisation.`,
  figures: [
    {
      title: 'GPTQ on one layer',
      architecture: {
        input: 'calibration tokens reaching this layer',
        output: 'QuantLinear: packed codes, scales, zeros',
        items: [
          {
            id: 'calib',
            label: 'Calibration inputs X',
            kind: 'io',
            sub: 'n tokens × d_in · fp32',
            shape: '[n, d_in]',
            detail:
              'The layer’s real inputs during a forward pass of the calibration batch, through the layers already quantized. Every token is one sample.',
          },
          {
            id: 'hessian',
            label: 'Layer Hessian',
            sub: 'H = (2/n) Σ x xᵀ · pre-hook',
            shape: '[d_in, d_in]',
            detail:
              '`HessianCollector`: a forward pre-hook keeps a running average in float32. The output error of any weight change is `(n/2) · tr(ΔW H ΔWᵀ)`, so `H` is the whole loss surface of the layer.',
          },
          {
            id: 'damp',
            label: 'Dead columns, damping',
            sub: 'H += λI · λ = 0.01 · mean diag',
            detail:
              'An input that was always 0 has `H[j, j] = 0`: set it to 1 and zero `W[:, j]`. Then 1% of the mean diagonal on the diagonal, so the factorisation succeeds in float32.',
          },
          {
            id: 'chol',
            label: 'Cholesky of H⁻¹',
            kind: 'attention',
            sub: 'U = chol(H⁻¹), upper',
            shape: '[d_in, d_in] upper',
            detail:
              '`cholesky`, `cholesky_inverse`, `cholesky(upper=True)`. Row `i` of `U` holds what column `i`’s error does to the columns after it, once columns `0..i−1` are fixed: every inverse downdate of OBQ, computed once.',
          },
          {
            tone: 'block',
            repeat: 'd_in / 128 ×',
            label: 'Block of 128 columns',
            items: [
              {
                tone: 'dotted',
                repeat: '128 ×',
                label: 'Column i, left to right',
                items: [
                  {
                    id: 'group-params',
                    label: 'Group grid',
                    sub: 'at i % g = 0: min, max → s, z',
                    detail:
                      'At a group’s first column, a new scale and zero point from the group’s columns **as they are now**, after earlier columns pushed their errors onto them.',
                  },
                  {
                    id: 'quant-col',
                    label: 'Quantize column i',
                    kind: 'attention',
                    sub: 'q = clamp(round(w/s) + z, 0, 15)',
                    shape: '[d_out]',
                    detail: 'The same round to nearest as RTN, applied to the updated column `w = W1[:, i]`.',
                  },
                  {
                    id: 'err',
                    label: 'Scaled error',
                    kind: 'loss',
                    sub: 'err = (w − s(q − z)) / U[i, i]',
                    detail: 'One number per output row: what this column got wrong, scaled for the update.',
                  },
                  {
                    id: 'update',
                    label: 'Update the rest of the block',
                    sub: 'W1[:, i:] −= err · U[i, i:]',
                    detail:
                      'An outer product over at most 128 columns. The next column is quantized from its updated value, so it can cancel this column’s error on the output.',
                  },
                ],
              },
              {
                id: 'lazy',
                label: 'Lazy batch update',
                sub: 'W[:, i2:] −= Err1 @ U[i1:i2, i2:]',
                detail:
                  'The 128 errors of the block reach every later column in one matmul, instead of 128 rank-1 updates of the whole matrix: the same arithmetic, compute bound instead of memory bound.',
              },
            ],
          },
          {
            id: 'codes',
            label: 'Codes, scales, zeros',
            kind: 'io',
            sub: 'uint8 codes · fp16 s · uint8 z',
            shape: '[d_out, d_in]',
            detail:
              'What `gptq_quantize` returns, the same format as `quantize_rtn`: `QuantLinear.from_quantized` packs it.',
          },
        ],
        notes: [
          {at: 'damp', text: 'λ = **1%** of the mean diagonal'},
          {at: 'chol', text: '**One** factorisation per layer, shared by every row'},
          {at: 'update', text: 'Errors go only to columns **not yet** quantized'},
          {at: 'lazy', text: '**One** matmul per 128 columns', side: 'left'},
        ],
      },
    },
    {
      title: 'Packed int4 storage',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'codes-row',
            label: 'Codes of one output row',
            sub: 'uint8 · values 0 … 15 · 4 of 8 bits used',
            items: [
              {
                array: 'codes[r, 0 … 15]',
                sub: 'one weight per cell · b0, b1: qweight bytes',
                cols: 16,
                cells: ['3', '10', '15', '0', '7', '7', '12', '4', '9', '1', '14', '6', '8', '2', '11', '5'],
                continues: true,
                marks: [
                  {cols: [0, 1], tone: 'a', label: 'b0'},
                  {cols: [2, 3], tone: 'b', label: 'b1'},
                ],
                detail:
                  'A device tensor in global memory. Column `2j` and column `2j + 1` share a byte: the two marked pairs become `qweight` bytes 0 and 1. Codes are integers in 0..15; the zero point of the group is one of them.',
              },
            ],
          },
          {
            id: 'quantlinear',
            label: 'QuantLinear buffers',
            sub: '4.1875 bits per weight at g = 128',
            tone: 'global',
            layout: 'column',
            align: 'start',
            items: [
              {
                id: 'qweight',
                array: 'qweight[r, 0 … 7]',
                sub: 'uint8 · (out, in/2) · low nibble first',
                cols: 8,
                cells: ['A3', '0F', '77', '4C', '19', '6E', '28', '5B'],
                continues: true,
                marks: [
                  {cols: [0, 0], tone: 'a'},
                  {cols: [1, 1], tone: 'b'},
                ],
                detail:
                  '`codes[..., 0::2] | (codes[..., 1::2] << 4)`: byte 0 holds codes 3 (low nibble) and 10 (high nibble), `0xA3`; byte 1 holds 15 and 0, `0x0F`. Unpacking is `p & 0xF` and `p >> 4`, interleaved back into column order.',
              },
              {
                id: 'scales',
                array: 'scales[r, :]',
                sub: 'fp16 · (out, in/128) · 16 bits/group',
                cols: 4,
                cells: ['s₀', 's₁', 's₂', 's₃'],
                detail:
                  'One scale per group of 128 input columns of this row, rounded up to fp16 so the 16 levels span the group’s range.',
              },
              {
                id: 'zeros',
                array: 'zeros[r, :]',
                sub: 'uint8 · (out, in/128) · 8 bits/group',
                cols: 4,
                cells: ['z₀', 'z₁', 'z₂', 'z₃'],
                detail:
                  'The code that 0.0 maps to in each group. Real checkpoints pack these as 4-bit `qzeros` too; here they take a byte.',
              },
            ],
          },
          {
            id: 'deq-forward',
            label: 'forward(x)',
            sub: 'unpack · (q − z)·s · F.linear',
            tone: 'compute',
            detail:
              'Dequantizes the whole weight and runs a float matmul: correct and small, but not fast. Fused kernels do the same per tile in registers so the weight crosses memory at 4 bits.',
          },
        ],
        arrows: [
          {from: 'codes-row', to: 'qweight', label: 'pack_int4 · 2 per byte'},
          {from: 'quantlinear', to: 'deq-forward', label: 'unpack_int4, dequantize'},
        ],
      },
    },
    {
      title: 'Quantizing the model',
      architecture: {
        input: 'calibration ids · 64 sequences × 64 tokens',
        output: 'fp32 · GPTQ · RTN compared',
        items: [
          {
            id: 'calib-ids',
            label: 'Calibration batch',
            kind: 'io',
            sub: '4,096 tokens, like training data',
            shape: '[64, 64] int64',
          },
          {
            id: 'embed-cache',
            label: 'Embeddings, once',
            kind: 'embed',
            sub: 'inps = model.embed(calib) · fp32',
            shape: '[64, 64, 128]',
            detail:
              'The first block’s inputs are computed once and then handed from block to block; the full model is never run again during quantization.',
          },
          {
            tone: 'block',
            repeat: '2 ×',
            label: 'Transformer block, in order',
            items: [
              {
                tone: 'dotted',
                repeat: '4 ×',
                label: 'qkv, proj, fc1, fc2',
                items: [
                  {
                    id: 'collect',
                    label: 'Collect H',
                    sub: 'HessianCollector · block(inps)',
                    detail:
                      'Hooks on this group’s linears, one forward of the block on the cached inputs. Earlier groups of the block are already quantized, so their errors are in these inputs.',
                  },
                  {
                    id: 'solve',
                    label: 'gptq_quantize',
                    kind: 'attention',
                    sub: 'codes, scales, zeros',
                  },
                  {
                    id: 'swap',
                    label: 'Swap in QuantLinear',
                    sub: 'QuantLinear.from_quantized',
                    detail: 'The float `nn.Linear` is replaced in its parent module; the bias is copied.',
                  },
                ],
              },
              {
                id: 'propagate',
                label: 'Run the quantized block',
                sub: 'inps = block(inps)',
                shape: '[64, 64, 128]',
                detail: 'The next block calibrates on what this quantized block really produces, its error included.',
              },
            ],
          },
          {id: 'head-fp', label: 'ln_f and head, fp32', kind: 'head', sub: '128 → 64 · not quantized'},
          {
            id: 'ppl',
            label: 'Held-out perplexity',
            kind: 'loss',
            sub: 'fp32 ≤ GPTQ < RTN',
            detail:
              'One run printed 8.142 (fp32), 8.285 (GPTQ) and 8.445 (RTN) against 64 for a uniform guess: GPTQ loses less than half of what round to nearest loses.',
          },
        ],
        notes: [
          {at: 'swap', text: 'Block weights **1,536 KiB → 201 KiB**, 7.64×'},
          {at: 'propagate', text: 'One more block forward per block'},
          {at: 'ppl', text: 'Perplexity **8.14 · 8.29 · 8.45**'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'paper',
      title: 'GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers',
      url: 'https://arxiv.org/abs/2210.17323',
      by: 'Elias Frantar et al.',
      date: '2022-10-31',
      venue: 'ICLR 2023',
      takes:
        'Algorithm 1 that `gptq_quantize` implements: one column order for every row, the upper Cholesky factor of `H⁻¹`, lazy batch updates of 128 columns, and sequential layer-by-layer calibration.',
    },
    {
      kind: 'paper',
      title: 'Optimal Brain Compression: A Framework for Accurate Post-Training Quantization and Pruning',
      url: 'https://arxiv.org/abs/2208.11580',
      by: 'Elias Frantar, Sidak Pal Singh and Dan Alistarh',
      date: '2022-08-24',
      venue: 'NeurIPS 2022',
      takes:
        'The layer-wise objective `‖WX − ŴX‖²` with Hessian `2XXᵀ`, the OBS update of the remaining weights and the inverse downdate that `gptq_reference` checks the fast solver against.',
    },
    {
      kind: 'code',
      title: 'gptq',
      url: 'https://github.com/IST-DASLab/gptq',
      by: 'IST-DASLab',
      date: '2022-10-19',
      venue: 'GitHub',
      takes:
        '`add_batch` and `fasterquant` in `gptq.py` (running-average `H`, dead columns, 1% damping, the block loop) and the `--true-sequential` order of `llama_sequential` that step 4 follows.',
    },
    {
      kind: 'code',
      title: 'AutoGPTQ',
      url: 'https://github.com/AutoGPTQ/AutoGPTQ',
      by: 'AutoGPTQ',
      date: '2023-04-13',
      venue: 'GitHub',
      takes:
        'The production checkpoint format that `QuantLinear` mirrors: packed `qweight`, per-group `scales` and `zeros`, `group_size=128`, and `damp_percent` for the damping.',
    },
    {
      kind: 'post',
      title: 'Making LLMs lighter with AutoGPTQ and transformers',
      url: 'https://huggingface.co/blog/gptq-integration',
      by: 'Marc Sun et al.',
      date: '2023-08-23',
      venue: 'Hugging Face blog',
      takes:
        'Why int4 weights with fp16 activations save memory and decode time: dequantization inside a fused kernel, near fp16 latency at batch size 1, and calibration with `GPTQConfig`.',
    },
  ],
  steps: [int4RtnStep, hessianStep, gptqSolverStep, quantizeModelStep],
  learn,
};
