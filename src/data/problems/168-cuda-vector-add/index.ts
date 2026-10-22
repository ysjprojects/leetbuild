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
  architecture: {
    input: 'h_a, h_b · n = 4,194,341 float32',
    output: 'h_c · max abs err 0 → PASS',
    items: [
      {
        id: 'host-in',
        label: 'Host buffers h_a, h_b',
        kind: 'host',
        sub: 'pageable · 2 × 16 MiB',
        detail:
          '`main` fills `h_a[i] = 0.001f · (i mod 1000)` and `h_b[i] = 1 − 0.0005f · (i mod 2000)` and computes the CPU reference `h_ref = h_a + h_b`. Host memory: the kernel cannot dereference it.',
      },
      {
        id: 'h2d',
        label: 'cudaMemcpy host → device',
        kind: 'io',
        sub: '2 × 16 MiB · blocking',
        detail:
          '`cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice)` and the same for `b`, after three `cudaMalloc`s. `bytes = size_t(n) * sizeof(float)`; every call goes through `CUDA_CHECK`.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory d_a, d_b',
        kind: 'memory',
        sub: 'cudaMalloc · 2 × 16 MiB',
        shape: 'float[4,194,341] × 2',
        detail:
          'Device (HBM) buffers from `cudaMalloc`, 256-byte aligned. Each launch reads both once: 8 bytes per element.',
      },
      {
        tone: 'block',
        repeat: '1,024 ×',
        label: 'Thread block · 256 threads',
        items: [
          {
            id: 'idx',
            label: 'Global index',
            kind: 'kernel',
            sub: 'i = blockIdx.x·256 + threadIdx.x',
            side: {
              label: 'launch_vector_add',
              sub: '<<<1024, 256>>>',
              detail:
                '`blocks = (n + 255) / 256` = 16,385, capped at `MAX_BLOCKS = 1024`; the launch, then `CUDA_CHECK(cudaGetLastError())` for a bad configuration.',
            },
            detail:
              'Each of the 262,144 threads starts at its global index: 0 … 255 in block 0, 256 … 511 in block 1, and so on. Adjacent threads, adjacent elements.',
          },
          {
            tone: 'dotted',
            repeat: '16–17 ×',
            label: 'Grid-stride loop',
            items: [
              {
                columns: [
                  [
                    {
                      id: 'ld-a',
                      label: 'Load a[i]',
                      kind: 'memory',
                      sub: 'into a register',
                      detail:
                        'One 4-byte load per thread; across a warp, 32 consecutive floats: 128 bytes, four 32-byte sectors, fully coalesced.',
                    },
                  ],
                  [
                    {
                      id: 'ld-b',
                      label: 'Load b[i]',
                      kind: 'memory',
                      sub: 'into a register',
                      detail: 'The same coalesced pattern on `b`, at the same index.',
                    },
                  ],
                ],
              },
              {
                id: 'add',
                op: '+',
                detail: '`a[i] + b[i]`: one FADD in registers, the kernel’s only arithmetic.',
              },
              {
                id: 'st-c',
                label: 'Store c[i]',
                kind: 'kernel',
                sub: 'then i += gridDim.x · blockDim.x',
                detail:
                  'One 4-byte store, then the index advances by the whole grid, 262,144. The loop condition `i < n` is the bounds test: nothing is written past `c[n − 1]`.',
              },
            ],
          },
        ],
      },
      {
        id: 'gmem-out',
        label: 'Global memory d_c',
        kind: 'memory',
        sub: '16 MiB · each element written once',
        shape: 'float[4,194,341]',
        detail:
          'Written by the kernel, read by nobody on the device. Twenty timed launches between two `cudaEvent`s give ms per launch; `3 · n · 4` bytes over it is the GB/s line.',
      },
      {
        id: 'd2h',
        label: 'cudaMemcpy device → host',
        kind: 'io',
        sub: '16 MiB · after the synchronise',
        detail:
          '`CUDA_CHECK(cudaDeviceSynchronize())` first, where an illegal address inside the kernel surfaces, then `cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost)` and three `cudaFree`s.',
      },
      {
        id: 'host-out',
        label: 'Host buffer h_c',
        kind: 'host',
        sub: 'max |h_c − h_ref| → PASS',
        detail:
          'Compared with the CPU reference over all `n`. A float add rounds the same on both sides, so the max abs error is exactly 0.',
      },
    ],
    notes: [
      {at: 'idx', text: '**1,024 × 256** = 262,144 threads: a capped grid'},
      {at: 'st-c', text: '**16 or 17** passes per thread for n = 4,194,341'},
      {at: 'gmem-in', text: '**12 B** of HBM per FLOP: bandwidth-bound', side: 'left'},
      {at: 'h2d', text: 'Every runtime call wrapped in **CUDA_CHECK**', side: 'left'},
      {at: 'd2h', text: '**cudaDeviceSynchronize** first: kernel faults surface there'},
    ],
  },
  steps: [vectorAddStep],
  learn,
};
