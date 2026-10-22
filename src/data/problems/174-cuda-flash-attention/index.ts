import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {flashAttentionStep} from './steps/1-flash-attention';

/**
 * Drill: the forward pass of FlashAttention for one head as one CUDA kernel — K/V tiles staged in
 * shared memory, scores in registers, softmax finished one tile at a time with a running max and
 * sum, the causal mask applied inside a tile and whole tiles above the diagonal skipped, the T × T
 * score matrix never written anywhere.
 */
export const cudaFlashAttentionProblem: Problem = {
  id: 'cuda-flash-attention',
  title: 'A FlashAttention-style fused attention kernel',
  tagline:
    'softmax(QKᵀ)V for one head in one kernel: K/V tiles in shared memory, scores in registers, online softmax with a running max and sum, causal tiles skipped — no T × T matrix ever hits global memory.',
  difficulty: 'hard',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# A FlashAttention-style fused attention kernel

Every transformer layer computes, per head, \`O = softmax(Q Kᵀ / √d) V\` over a sequence of \`T\` tokens.
Written as three matrix operations it is \`T × T\` scores to global memory, a softmax that reads and
rewrites them, and a second matmul that reads them again: for \`T = 8192\` that is 256 MB per head per
layer travelling through HBM three times while the arithmetic is cheap. Attention on a GPU is
memory-bound, and the fix — the kernel behind \`torch.nn.functional.scaled_dot_product_attention\`,
vLLM, and every long-context model since 2022 — is **FlashAttention**: compute the scores one tile at
a time, finish the softmax incrementally with a running max and a running sum, and write only \`O\`.

You write that kernel's forward pass for one head, in plain CUDA, for \`float\` inputs:

\`\`\`cuda
__global__ void flash_attn_fwd(const float* Q, const float* K, const float* V, float* O,
                               int T, int d, float scale, bool causal);
\`\`\`

\`Q\`, \`K\`, \`V\`, \`O\` are row-major \`T × d\`; \`scale = 1 / √d\`; \`causal\` masks \`j > i\`. Each block owns
\`BQ = 64\` query rows, one per thread, and loops over the keys in tiles of \`BK = 32\` rows staged in
\`__shared__\` memory; every thread keeps its query row, its \`BK\` scores, its output accumulator and
the running max \`m\` and sum \`l\` in registers. \`d ≤ D_MAX = 64\`.

## What you build here

1. \`flash_attn_fwd\`: the tile loop with two \`__syncthreads()\`, the scores in registers with the
   causal mask, the online-softmax fold (\`m_new\`, \`alpha = __expf(m − m_new)\`, rescale, accumulate,
   \`l\`), the block-uniform skip of tiles above the diagonal, and one normalised write of \`O\`.

## Run it on your machine

\`\`\`sh
nvcc -O2 -o flash_attention flash_attention.cu && ./flash_attention
\`\`\`

A passing run prints one line per case with the max absolute error against a double-precision CPU
reference (materialised softmax) and the kernel time from \`cudaEvent\`s, a memory note, and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
non-causal max|err| = 3.4e-07  kernel 0.052 ms
causal     max|err| = 2.9e-07  kernel 0.031 ms
memory: Q K V O 65536 bytes each on the device, 16384 bytes of shared memory per block for the K/V tiles, scores in registers (a 256 x 256 score matrix would be 262144 bytes; none allocated)
PASS
\`\`\`

The starter compiles and prints \`FAIL\` — the kernel writes nothing and \`O\` stays zero.

## Left out on purpose

The backward pass and the \`logsumexp\` it needs, multiple heads and a batch dimension (one more grid
axis), bf16/fp16 inputs and tensor-core matmuls (\`wmma\`, \`mma.sync\`), warp-level work partitioning
and the register-tile sizes of FlashAttention-2, the asynchronous pipelining of FlashAttention-3,
dropout, ALiBi/sliding-window masks, and the KV-cache layout of inference.`,
  diagram: {
    nodes: [
      {id: 'host', kind: 'client', label: 'Host', sub: 'fills Q K V · launches · max|err|', x: 10, y: 50},
      {id: 'hbm', kind: 'db', label: 'Global memory', sub: 'Q K V O · T × d each', x: 40, y: 20},
      {id: 'kernel', kind: 'service', label: 'flash_attn_fwd', sub: 'one block per BQ query rows', x: 40, y: 70},
      {id: 'smem', kind: 'db', label: 'Shared memory', sub: 'Ks, Vs · BK × D_MAX per tile', x: 70, y: 70},
      {id: 'ref', kind: 'external', label: 'CPU reference', sub: 'double · materialised softmax', x: 70, y: 20},
    ],
    edges: [
      {from: 'host', to: 'hbm', kind: 'plain', label: 'cudaMemcpy Q K V · O back'},
      {from: 'host', to: 'kernel', kind: 'plain', label: '<<<⌈T/BQ⌉, BQ>>>'},
      {from: 'kernel', to: 'hbm', kind: 'plain', label: 'read K/V tiles · write O once'},
      {from: 'kernel', to: 'smem', kind: 'plain', label: 'stage tile · __syncthreads'},
      {from: 'host', to: 'ref', kind: 'plain', label: 'max|err| < 1e-3'},
    ],
  },
  steps: [flashAttentionStep],
  learn,
};
