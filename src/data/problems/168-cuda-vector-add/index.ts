import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {vectorAddStep} from './steps/1-vector-add';

/**
 * Drill: the smallest complete CUDA program — a grid-stride vector add, a launch helper that
 * computes a capped grid and checks the launch, every runtime call through an error macro, a
 * synchronise before the copy back, events around the timed launches and a CPU reference. The
 * host-side shape every custom kernel in a training stack sits inside.
 */
export const cudaVectorAddProblem: Problem = {
  id: 'cuda-vector-add',
  title: 'Vector add: launch geometry, a grid-stride loop and error checking',
  tagline:
    'c[i] = a[i] + b[i] over 4 M floats: a capped grid, a loop that covers n, every API call checked, cudaGetLastError after the launch, a synchronise before the read, events around the timing, a CPU reference and PASS.',
  difficulty: 'easy',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 25,
  statement: `# Vector add: launch geometry, a grid-stride loop and error checking

Every elementwise operation in a transformer is this kernel wearing a different function: the residual
add \`x + attn(x)\`, a bias add, a dropout mask, the \`p -= lr * g\` of an optimizer step. PyTorch's \`a + b\`
on CUDA tensors launches one, and every custom kernel you will ever write — a fused GELU, a LayerNorm, a
softmax — sits inside the same host-side shape: allocate on the device, copy in, pick a grid, launch, check,
synchronise, copy out, compare, free. This drill is that shape, done right, on the simplest body there is.

The surface is one file, \`vector_add.cu\`, compiled with \`nvcc\`:

- \`__global__ void vector_add(const float* a, const float* b, float* c, int n)\` — a **grid-stride loop**:
  each thread starts at \`blockIdx.x * blockDim.x + threadIdx.x\` and advances by \`gridDim.x * blockDim.x\`
  until \`n\`, so any grid covers any \`n\` and nobody writes past the end.
- \`CUDA_CHECK(call)\` — a macro that prints \`cudaGetErrorString\` with \`__FILE__:__LINE__\` and exits when a
  runtime call fails; every runtime call in the file goes through it.
- \`launch_vector_add(d_a, d_b, d_c, n)\` — \`BLOCK_SIZE = 256\`, blocks = \`ceil(n / 256)\` capped at
  \`MAX_BLOCKS = 1024\`, the \`<<<blocks, BLOCK_SIZE>>>\` launch, and \`CUDA_CHECK(cudaGetLastError())\` right
  after it.
- \`run_vector_add(h_a, h_b, h_c, n)\` → ms per launch — \`cudaMalloc\`, \`cudaMemcpy\` in, a warm-up, 20
  launches between two \`cudaEvent\`s, \`cudaDeviceSynchronize\`, \`cudaMemcpy\` out, \`cudaFree\`.
- \`main\` — \`n = 4,194,341\` floats (16 MiB per array, not a multiple of 256, more than the capped grid
  holds), a CPU reference, the max abs error, a bandwidth line and \`PASS\`.

## What you build here

1. \`vector_add\`, \`CUDA_CHECK\`, \`launch_vector_add\`, \`run_vector_add\` and the self-test around them: the
   grid-stride loop with its bounds, the capped launch geometry, \`cudaGetLastError\` after the launch, the
   synchronise before the read-back, event timing, and a CPU comparison that prints the max abs error.

## Run it on your machine

\`\`\`text
nvcc -O2 -o vector_add vector_add.cu && ./vector_add
\`\`\`

A passing run prints one line of numbers and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
n=4194341  0.0412 ms/launch  1221.8 GB/s  max abs err 0.000e+00
PASS
\`\`\`

The bandwidth depends on the GPU (a laptop part prints tens of GB/s, an H100 over 2000); the error is
exactly 0 because a float add rounds the same way on both sides. The starter prints \`FAIL\` with a max abs
error around 2, because \`c\` comes back as the zeros it was filled with.

## Left out on purpose

Pinned host memory and \`cudaMemcpyAsync\` on streams, \`float4\` vectorised loads, choosing the grid cap from
\`cudaOccupancyMaxActiveBlocksPerMultiprocessor\` and the SM count, unified memory, multiple devices, and the
2-D and 3-D grids an image kernel uses. The runtime API as used here is the one every later kernel in this
track builds on.`,
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · main()',
        sub: 'fill a, b · CPU reference · max abs err · PASS',
        x: 8,
        y: 50,
      },
      {
        id: 'launch',
        kind: 'service',
        label: 'launch_vector_add',
        sub: 'blocks = min(⌈n/256⌉, 1024) · cudaGetLastError',
        x: 36,
        y: 50,
      },
      {
        id: 'kernel',
        kind: 'service',
        label: 'vector_add<<<blocks, 256>>>',
        sub: 'grid-stride loop over n',
        x: 64,
        y: 50,
      },
      {id: 'dmem', kind: 'db', label: 'Device memory', sub: 'd_a · d_b · d_c (16 MiB each)', x: 92, y: 50},
    ],
    edges: [
      {from: 'host', to: 'dmem', kind: 'plain', label: 'cudaMalloc · cudaMemcpy H2D / D2H · cudaFree'},
      {from: 'host', to: 'launch', kind: 'plain', label: 'warm-up · 20 timed launches'},
      {from: 'launch', to: 'kernel', kind: 'plain', label: '<<<blocks, BLOCK_SIZE>>>'},
      {from: 'kernel', to: 'dmem', kind: 'plain', label: 'c[i] = a[i] + b[i]'},
    ],
  },
  steps: [vectorAddStep],
  learn,
};
