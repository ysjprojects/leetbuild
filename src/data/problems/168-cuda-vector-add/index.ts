import type {GpuMark} from '@/lib/gpuFigure';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {vectorAddStep} from './steps/1-vector-add';

/** A warp's 32 floats as the four 32-byte sectors the memory system serves them in. */
const sectors: GpuMark[] = [0, 1, 2, 3].map(s => ({
  cols: [8 * s, 8 * s + 7],
  tone: 'global',
  label: '32 B sector',
}));

/** The same 32 floats in registers: lanes 8s … 8s + 7 hold sector s. */
const laneGroups: GpuMark[] = [0, 1, 2, 3].map(s => ({
  cols: [8 * s, 8 * s + 7],
  tone: 'register',
  label: `lanes ${8 * s}–${8 * s + 7}`,
}));

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
  track: 'dllm',
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
  figures: [
    {
      title: 'Grid over the arrays',
      gpu: {
        align: 'end',
        items: [
          {
            id: 'host',
            label: 'Host',
            sub: 'pageable memory',
            tone: 'host',
            layout: 'column',
            items: [
              {
                id: 'h-ab',
                array: 'h_a, h_b',
                sub: '2 × 16 MiB',
                cols: 12,
                tone: 'host',
                continues: true,
                detail:
                  '`main` fills both and computes the CPU reference `h_ref = h_a + h_b`. The kernel cannot read host memory: it has to be copied.',
              },
              {
                id: 'h-c',
                array: 'h_c',
                sub: 'max |h_c − h_ref| = 0',
                cols: 12,
                tone: 'host',
                continues: true,
                detail:
                  'Copied back after `cudaDeviceSynchronize()` and compared over all `n`: a float add rounds the same on both sides.',
              },
            ],
          },
          {
            id: 'gpu',
            label: 'GPU',
            layout: 'column',
            items: [
              {
                id: 'grid',
                label: 'Kernel grid',
                sub: 'vector_add<<<1024, 256>>>',
                count: '1,024 blocks',
                items: [
                  {
                    id: 'block0',
                    label: 'Block 0',
                    layout: 'column',
                    items: [{threads: 10, continues: true, label: '256 threads'}],
                    detail:
                      'Threads 0 … 255 start at elements 0 … 255: adjacent threads, adjacent floats, so a warp’s 32 loads are one coalesced 128-byte request.',
                  },
                  {
                    label: 'Block 1',
                    layout: 'column',
                    items: [{threads: 10, continues: true, label: '256 threads'}],
                  },
                  {gap: '…'},
                  {
                    label: 'Block 1023',
                    layout: 'column',
                    items: [{threads: 10, continues: true, label: '256 threads'}],
                  },
                ],
                detail:
                  '`(n + 255) / 256` = 16,385 blocks would cover `n` in one pass; the launch caps the grid at 1,024 and lets each thread loop instead.',
              },
              {
                id: 'gmem',
                label: 'Global memory',
                sub: 'cudaMalloc · HBM',
                tone: 'global',
                stretch: true,
                layout: 'column',
                items: [
                  {
                    id: 'd-ab',
                    array: 'd_a, d_b',
                    sub: 'a cell = one pass of 262,144 floats',
                    cols: 17,
                    cells: 'index',
                    marks: [
                      {cols: [0, 15], tone: 'global', label: '16 full passes'},
                      {cols: [16, 16], tone: 'muted', label: '37'},
                    ],
                    detail:
                      'Pass `p` covers elements `p · 262,144 + i`. The 17th pass has only 37 elements, so threads 37 … 262,143 find `i ≥ n` and leave the loop: the condition is the bounds test, nothing is read past the end.',
                  },
                  {
                    id: 'd-c',
                    array: 'd_c',
                    sub: 'each element written once',
                    cols: 17,
                    detail:
                      'One 4-byte store per element: 12 bytes of HBM traffic per add, which makes the kernel bandwidth-bound.',
                  },
                ],
              },
            ],
          },
        ],
        arrows: [
          {from: 'h-ab', to: 'd-ab', label: 'cudaMemcpy H2D'},
          {from: 'd-c', to: 'h-c', label: 'cudaMemcpy D2H'},
        ],
      },
    },
    {
      title: 'One warp, one pass',
      gpu: {
        align: 'end',
        items: [
          {
            id: 'warp-gmem',
            label: 'Global memory',
            sub: 'pass p: elements i … i + 31',
            tone: 'global',
            layout: 'column',
            items: [
              {
                id: 'w-a',
                array: 'a[i … i + 31]',
                sub: '128 B',
                cols: 32,
                marks: sectors,
                detail:
                  'Lane `k` asks for `a[i + k]`: 32 consecutive floats, 128 contiguous bytes. The memory system serves them as four 32-byte sectors in one request; every fetched byte is used.',
              },
              {
                id: 'w-b',
                array: 'b[i … i + 31]',
                sub: '128 B',
                cols: 32,
                marks: sectors,
                detail: 'The same pattern on `b`, at the same indices: four more sectors, fully used.',
              },
              {
                id: 'w-c',
                array: 'c[i … i + 31]',
                sub: '128 B',
                cols: 32,
                marks: sectors,
                detail:
                  'One 4-byte store per lane, four whole sectors written. Then `i += 262,144`: the next pass is 1 MiB further on, and still 32 adjacent floats per warp.',
              },
            ],
          },
          {
            id: 'warp',
            label: 'Warp 0 of block 0',
            sub: 'threads 0 … 31',
            count: '8 warps per block',
            layout: 'column',
            detail:
              'A block of 256 threads runs as 8 warps of 32. The 32 lanes of a warp issue each instruction together, so their 32 addresses reach the memory system as one request.',
            items: [
              {
                id: 'lanes',
                threads: 32,
                label: 'lane k handles element i + k',
                detail:
                  'Lane `k` of warp 0 is thread `k`: it starts at `i = k` and visits `k`, `k + 262,144`, `k + 524,288`, … while `i < n`, 16 or 17 times.',
              },
              {
                id: 'warp-regs',
                label: 'Registers',
                sub: 'one float of each per lane',
                tone: 'register',
                stretch: true,
                layout: 'column',
                items: [
                  {
                    id: 'r-a',
                    array: 'a',
                    cols: 32,
                    tone: 'register',
                    marks: laneGroups,
                    detail:
                      '`a[i + k]` lands in a register of lane `k`: lanes 0 … 7 got their floats from the first sector.',
                  },
                  {id: 'r-b', array: 'b', cols: 32, tone: 'register', marks: laneGroups},
                  {
                    id: 'r-c',
                    array: 'a + b',
                    sub: 'one FADD per lane',
                    cols: 32,
                    tone: 'register',
                    marks: laneGroups,
                    detail:
                      'The kernel’s only arithmetic: one add per 12 bytes moved, which is why it is bandwidth-bound.',
                  },
                ],
              },
            ],
          },
        ],
        arrows: [
          {from: 'w-a', to: 'r-a', label: 'load · 128 B'},
          {from: 'w-b', to: 'r-b', label: 'load · 128 B'},
          {from: 'r-c', to: 'w-c', label: 'store · 128 B'},
        ],
      },
    },
  ],
  sources: [
    {
      kind: 'post',
      title: 'An Even Easier Introduction to CUDA (Updated)',
      url: 'https://developer.nvidia.com/blog/even-easier-introduction-cuda/',
      by: 'Mark Harris',
      date: '2025-05-02',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The host-side shape of `run_vector_add`: allocate, launch `<<<blocks, threads>>>`, synchronise before reading, then the grid-stride `add` kernel the step generalises.',
    },
    {
      kind: 'post',
      title: 'CUDA Pro Tip: Write Flexible Kernels with Grid-Stride Loops',
      url: 'https://developer.nvidia.com/blog/cuda-pro-tip-write-flexible-kernels-grid-stride-loops/',
      by: 'Mark Harris',
      date: '2013-04-22',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The loop in `vector_add` that starts at the global thread index and advances by `gridDim.x * blockDim.x`, so the grid capped at `MAX_BLOCKS = 1024` still covers all 4,194,341 floats.',
    },
    {
      kind: 'post',
      title: 'How to Implement Performance Metrics in CUDA C/C++',
      url: 'https://developer.nvidia.com/blog/how-implement-performance-metrics-cuda-cc/',
      by: 'Mark Harris',
      date: '2012-11-07',
      venue: 'NVIDIA Technical Blog',
      takes:
        'The two `cudaEvent`s around the 20 timed launches and the effective-bandwidth line: three arrays of `n` floats over the elapsed milliseconds.',
    },
    {
      kind: 'docs',
      title: 'Error Checking in CUDA',
      url: 'https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/intro-to-cuda-cpp.html#intro-cpp-error-checking',
      venue: 'CUDA Programming Guide',
      takes:
        'Why `CUDA_CHECK` wraps every runtime call and why a launch needs `cudaGetLastError()` right after it: launch errors are reported there, kernel faults only at the next synchronise.',
    },
    {
      kind: 'docs',
      title: 'Thread and Grid Index Intrinsics',
      url: 'https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/intro-to-cuda-cpp.html#intro-cpp-thread-indexing',
      venue: 'CUDA Programming Guide',
      takes:
        '`blockIdx`, `blockDim`, `threadIdx` and `gridDim`, and the bounds check against `n` that keeps the last partial block from writing past the end.',
    },
  ],
  steps: [vectorAddStep],
  learn,
};
