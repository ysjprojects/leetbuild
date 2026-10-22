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
  architecture: {
    input: 'Q, K, V · T × d float32',
    output: 'O = softmax(Q Kᵀ / √d) V',
    items: [
      {
        id: 'host',
        label: 'Host',
        sub: 'cudaMemcpy Q K V · <<<⌈T/64⌉, 64>>>',
        kind: 'host',
        detail:
          'Fills `Q`, `K`, `V` with deterministic values in `[−1, 1]`, copies them to the device, launches `flash_attn_fwd` with `scale = 1/√d` (non-causal, then causal) and compares `O` with a double-precision CPU reference.',
      },
      {
        id: 'hbm-in',
        label: 'Global memory (HBM)',
        sub: 'Q K V · T × d float each',
        kind: 'memory',
        shape: '3 × [T, d]',
        detail:
          'Row-major `T × d` arrays: 65,536 bytes each at `T = 256`, `d = 64`. There is no `T × T` buffer anywhere on the device.',
      },
      {
        tone: 'block',
        repeat: '⌈T/64⌉ ×',
        label: 'Thread block · BQ = 64 query rows',
        items: [
          {
            id: 'q-reg',
            label: 'Registers: query row',
            sub: 'q[k] = Q[row][k] · scale',
            kind: 'memory',
            shape: 'q: [64]',
            detail:
              'Thread `threadIdx.x` owns `row = blockIdx.x · 64 + threadIdx.x`. It keeps `q[D_MAX]` (pre-scaled, zero past `d`), the accumulator `o[D_MAX] = 0`, the running max `m = −∞` and the running sum `l = 0`, all in registers.',
          },
          {
            tone: 'block',
            repeat: '⌈T/32⌉ ×',
            label: 'K/V tile loop · BK = 32',
            items: [
              {
                id: 'skip',
                label: 'Causal tile skip',
                sub: 'break if kv0 > q_last',
                kind: 'kernel',
                detail:
                  'A tile whose first key is past the block’s last query row is entirely above the diagonal. The test depends on `blockIdx` only, so the whole block leaves together and no barrier is half-reached.',
              },
              {
                id: 'smem',
                label: 'Shared memory: Ks, Vs',
                sub: '2 × [32][64] float · __syncthreads',
                kind: 'memory',
                shape: 'Ks, Vs: [32, 64]',
                detail:
                  'Every thread loads a strided share of rows `kv0 … kv0 + 31` of `K` and `V` (zero past `T` and `d`), consecutive threads on consecutive floats, then `__syncthreads()` so no thread reads a half-filled tile.',
              },
              {
                id: 'scores',
                label: 'Scores in registers',
                sub: 's[j] = q · Ks[j], −∞ if masked',
                kind: 'kernel',
                shape: 's: [32]',
                detail:
                  'One row of `S = Q Kᵀ` for this tile: 32 dot products of length `d`. Padding keys (`key ≥ T`) and causal keys (`key > row`) get `−∞`, so they contribute `exp(−∞) = 0`. Every lane reads the same `Ks[j][k]`: a broadcast, not a conflict.',
              },
              {
                id: 'rescale',
                label: 'Online softmax rescale',
                sub: 'α = exp(m − m_new); o *= α',
                kind: 'kernel',
                detail:
                  '`m_new = fmaxf(m, tile_max)`, `alpha = __expf(m − m_new)`: the past accumulator and sum are re-expressed under the new maximum by one multiply. On the first tile `m = −∞`, so `alpha = 0`.',
              },
              {
                id: 'accum',
                label: 'Accumulate O in registers',
                sub: 'o += p · Vs[j]; l = l·α + Σp',
                kind: 'kernel',
                shape: 'o: [64]',
                detail:
                  '`p = __expf(s[j] − m_new) ≤ 1` for each key; `o[k] += p · Vs[j][k]`, `p_sum += p`; then `l = l · alpha + p_sum`, `m = m_new`. A second `__syncthreads()` ends the tile, so nobody overwrites `Ks`/`Vs` while a neighbour still reads them.',
              },
            ],
          },
          {
            id: 'normalise',
            label: 'Normalise once',
            sub: 'O[row][k] = o[k] / l',
            kind: 'kernel',
            shape: 'O[row]: [d]',
            detail:
              'One division per row after the last tile, exact because every term carries the same `exp(−m)`. Threads with `row ≥ T` skip the write but have reached every barrier.',
          },
        ],
      },
      {
        id: 'hbm-out',
        label: 'Global memory (HBM)',
        sub: 'O · T × d · written once',
        kind: 'memory',
        shape: '[T, d]',
        detail:
          'The only output: `T × d` floats. The `logsumexp` per row (`m + log l`) that a backward pass would need is left out of this drill.',
      },
    ],
    notes: [
      {at: 'hbm-out', text: 'No **T × T** buffer: 256 × 256 would be **256 KB**'},
      {at: 'smem', text: '**16 KB** of shared memory per block'},
      {at: 'skip', text: 'Causal: about **half** the tiles never loaded'},
      {at: 'q-reg', text: '**64** threads per block, one query row each'},
    ],
    insets: [
      {
        for: 'rescale',
        title: 'Online softmax, one tile',
        items: [
          {id: 'fold-max', label: 'New running max', sub: 'm_new = max(m, max_j s[j])'},
          {id: 'fold-alpha', label: 'Rescale the past', sub: 'α = exp(m − m_new); o, l *= α'},
          {id: 'fold-p', label: 'Weights for this tile', sub: 'p_j = exp(s[j] − m_new) ≤ 1'},
          {id: 'fold-add', label: 'Add the tile', sub: 'o += Σ p_j·Vs[j]; l += Σ p_j'},
        ],
        note: 'The past is rescaled by **exp(m_old − m_new)**',
      },
    ],
  },
  steps: [flashAttentionStep],
  learn,
};
