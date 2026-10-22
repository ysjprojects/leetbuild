import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {fusedGeluStep} from './steps/1-fused-gelu';

/**
 * Drill: the bias add and the GELU of a transformer MLP fused into one memory-bound kernel — one
 * 16-byte float4 load of the activation, one of the bias, four tanh-approximation GELUs, one
 * 16-byte store — plus a scalar kernel for the n % 4 tail, __restrict__ pointers, and a self-test
 * that reports GB/s against a double-precision CPU reference.
 */
export const cudaFusedGeluProblem: Problem = {
  id: 'cuda-fused-gelu',
  title: 'A fused, vectorised GELU kernel',
  tagline:
    "y = gelu(x + bias) over GPT-2 small's 4096 × 3072 MLP activation in one pass: float4 loads and stores, the tanh approximation in single precision, __restrict__ pointers, a scalar tail for n % 4, and a bandwidth line in GB/s.",
  difficulty: 'easy',
  track: 'dllm',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 25,
  statement: `# A fused, vectorised GELU kernel

Every transformer MLP is \`W₂ · gelu(W₁x + b₁) + b₂\`, and between the two matrix multiplies sits an
elementwise step: add the bias, apply the GELU. GPT-2 and BERT use the **tanh approximation** of GELU from
Hendrycks & Gimpel, \`0.5 v (1 + tanh(√(2/π) (v + 0.044715 v³)))\`. In eager PyTorch that step is two kernels —
\`x + b\` and \`F.gelu(..., approximate="tanh")\` — and each reads and writes the whole activation through HBM.
The arithmetic is a dozen instructions per element; the bytes are what cost. This drill writes the step the
way \`torch.compile\` and the fused-epilogue libraries do: one pass, the bias added in registers, sixteen bytes
per load.

The surface is one file, \`fused_gelu.cu\`, compiled with \`nvcc\`:

- \`__device__ __forceinline__ float gelu_tanh(float v)\` — \`0.5f * v * (1.0f + tanhf(0.79788456f * (v + 0.044715f * v * v * v)))\`,
  single precision throughout.
- \`__global__ void gelu_bias_kernel(const float4* __restrict__ x, const float4* __restrict__ bias, float4* __restrict__ y, int n4, int cols4)\`
  — one thread per \`float4\`: one load of \`x[i]\`, one of \`bias[i % cols4]\`, four \`gelu_tanh\` calls, one store.
- \`__global__ void gelu_bias_tail_kernel(const float* __restrict__ x, const float* __restrict__ bias, float* __restrict__ y, int start, int n, int cols)\`
  — the scalar version for the last \`n % 4\` elements.
- \`void gelu_bias(const float* x, const float* bias, float* y, int n, int cols)\` — \`n4 = n / 4\`, the vector
  launch over \`reinterpret_cast\` buffers (256 threads per block), the tail launch when \`n % 4 > 0\`,
  \`cudaGetLastError()\` after each. Precondition: \`cols % 4 == 0\` and \`cudaMalloc\`'d pointers.
- \`main\` — \`n = 4096 × 3072\` (GPT-2 small's MLP activation: 4096 tokens, \`4 × d_model = 3072\` columns)
  timed over 20 launches, then \`n = 1,000,003\` (a tail of 3); both against a double-precision CPU reference,
  max abs error below \`1e-5\`, \`PASS\`.

## What you build here

1. \`gelu_tanh\`, \`gelu_bias_kernel\`, \`gelu_bias_tail_kernel\` and \`gelu_bias\`: the tanh-approximation GELU
   in \`float\`, the fused bias add on all four lanes of a \`float4\`, the bounds guards, \`__restrict__\` on every
   pointer, and the host split into a vectorised body and a scalar tail.

## Run it on your machine

\`\`\`text
nvcc -O2 -o fused_gelu fused_gelu.cu && ./fused_gelu
\`\`\`

A passing run prints two lines of numbers and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
n=12582912 cols=3072  0.0410 ms  2455.3 GB/s  max abs err 4.77e-07
n=1000003 cols=3072  max abs err 4.77e-07
PASS
\`\`\`

The bandwidth depends on the GPU — compare it with the card's peak HBM/GDDR bandwidth (about 3.35 TB/s on an
H100 SXM, 1 TB/s on an RTX 4090, a few hundred GB/s on a laptop part); a good elementwise kernel reaches
80–90 % of it. The error is a few float ulps. The starter prints \`FAIL\` with a max abs error near 4, because
\`y\` comes back as the zeros it was filled with.

## Left out on purpose

The exact \`erf\` GELU, the backward pass, \`half\`/\`bfloat16\` inputs (\`__half2\`, eight elements per 16-byte
load), a grid-stride loop, unaligned pointers and \`cols % 4 != 0\`, inline-PTX \`tanh.approx.f32\`, and
fusing the GELU into the GEMM epilogue itself. The kernel is the standalone fused elementwise op a compiler
emits when it cannot reach into the matmul.`,
  figures: [
    {
      title: 'Unfused against fused',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'eager',
            label: 'Eager PyTorch: two launches',
            sub: 'x + bias, then F.gelu(t)',
            count: '192 MiB of HBM traffic',
            detail:
              '`x + b` and `F.gelu(…, approximate="tanh")` are two kernels. The intermediate `t` is a full activation: written by the first, read straight back by the second.',
            items: [
              {
                id: 'u-in',
                label: 'HBM',
                tone: 'global',
                layout: 'column',
                items: [
                  {id: 'u-x', array: 'x', sub: '48 MiB', cols: 6, continues: true},
                  {id: 'u-b', array: 'bias', sub: '12 KiB', cols: 3},
                ],
              },
              {
                id: 'u-add',
                label: 'add kernel',
                sub: 't = x + bias',
                tone: 'compute',
                detail: 'Reads `x` (and the cached bias), writes `t`: 8 bytes of HBM per element for one add.',
              },
              {
                id: 'u-mid',
                label: 'HBM',
                tone: 'global',
                items: [
                  {
                    id: 'u-t',
                    array: 't',
                    sub: '48 MiB',
                    cols: 6,
                    continues: true,
                    detail:
                      'The intermediate makes a full round trip through HBM: 96 MiB moved for values that existed in registers a moment earlier.',
                  },
                ],
              },
              {
                id: 'u-gelu',
                label: 'gelu kernel',
                sub: 'y = gelu(t)',
                tone: 'compute',
                detail: 'Reads `t` back, writes `y`: another 8 bytes per element.',
              },
              {
                id: 'u-out',
                label: 'HBM',
                tone: 'global',
                items: [{id: 'u-y', array: 'y', sub: '48 MiB', cols: 6, continues: true}],
              },
            ],
          },
          {
            id: 'fused',
            label: 'Fused: one launch',
            sub: 'gelu_bias_kernel<<<12,288, 256>>>',
            count: '96 MiB of HBM traffic',
            detail:
              'One read of `x`, one write of `y`: 8 bytes per element instead of 16, so about twice as fast on a memory-bound step.',
            items: [
              {
                id: 'f-in',
                label: 'HBM',
                tone: 'global',
                layout: 'column',
                items: [
                  {
                    id: 'x',
                    array: 'x',
                    sub: '48 MiB',
                    cols: 6,
                    continues: true,
                    detail:
                      'Reinterpreted as `float4*`: `n4 = n / 4` = 3,145,728 vectors. `cudaMalloc` aligns the base to 256 bytes, so every `x[i]` is a legal 16-byte load.',
                  },
                  {
                    id: 'bias',
                    array: 'bias',
                    sub: '12 KiB · from L2',
                    cols: 3,
                    detail:
                      '`cols4 = 768` vectors, read by every row: after the first row it comes from L2/L1, so the byte count leaves it out.',
                  },
                ],
              },
              {
                id: 'thread',
                label: 'Thread i',
                sub: 'i = blockIdx.x · 256 + threadIdx.x',
                count: '3,145,728 threads',
                layout: 'column',
                detail:
                  'One thread per `float4`; it returns at once when `i >= n4`. `__restrict__` on all three pointers lets the compiler issue both 16-byte loads before any arithmetic.',
                items: [
                  {
                    id: 'regs',
                    label: 'Registers',
                    sub: 't never leaves them',
                    tone: 'register',
                    layout: 'column',
                    items: [
                      {
                        id: 'v',
                        array: 'v = x[i] + bias[i % 768]',
                        cols: 4,
                        cells: ['.x', '.y', '.z', '.w'],
                        tone: 'register',
                        detail:
                          'With `cols % 4 == 0` the four lanes of `x[i]` are columns `4·(i % 768) … + 3` of one row: exactly the lanes of `bias[i % 768]`. The bias add is four FADDs, fused.',
                      },
                      {
                        id: 'r',
                        array: 'r = gelu_tanh(v)',
                        sub: '× 4 lanes',
                        cols: 4,
                        cells: ['.x', '.y', '.z', '.w'],
                        tone: 'register',
                        detail:
                          '`0.5f·v·(1 + tanhf(0.79788456f·(v + 0.044715f·v³)))`, inlined, in single precision: about 20 FLOPs per element against 8 bytes, still memory-bound.',
                      },
                    ],
                  },
                ],
              },
              {
                id: 'f-out',
                label: 'HBM',
                tone: 'global',
                items: [
                  {
                    id: 'y',
                    array: 'y',
                    sub: '48 MiB',
                    cols: 6,
                    continues: true,
                    detail: 'Written once, one 16-byte store per thread. `8 × n` bytes over the time is the GB/s line.',
                  },
                ],
              },
            ],
          },
        ],
        arrows: [
          {from: 'u-in', to: 'u-add', label: 'read 48 MiB'},
          {from: 'u-add', to: 'u-mid', label: 'write 48 MiB'},
          {from: 'u-mid', to: 'u-gelu', label: 'read 48 MiB'},
          {from: 'u-gelu', to: 'u-out', label: 'write 48 MiB'},
          {from: 'f-in', to: 'regs', label: 'float4 reads · 48 MiB'},
          {from: 'regs', to: 'f-out', label: 'float4 writes · 48 MiB'},
        ],
      },
    },
    {
      title: 'Threads over the activation',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'grid',
            label: 'Kernel grid',
            sub: 'gelu_bias_kernel<<<12,288, 256>>>',
            count: '12,288 blocks',
            detail:
              '`n4 = 4096 × 3072 / 4` = 3,145,728 threads, one per `float4`, in blocks of 256: `(n4 + 255) / 256` = 12,288 blocks, three per row of 3072 floats.',
            items: [
              {
                id: 'block0',
                label: 'Block 0',
                layout: 'column',
                items: [{threads: 8, continues: true, label: '256 float4s'}],
                detail:
                  'Threads 0 … 255 take floats 0 … 1023 of row 0, four each: a warp asks for 512 contiguous bytes per load.',
              },
              {label: 'Block 1', layout: 'column', items: [{threads: 8, continues: true, label: '256 float4s'}]},
              {label: 'Block 2', layout: 'column', items: [{threads: 8, continues: true, label: '256 float4s'}]},
              {gap: '…'},
              {label: 'Block 12,287', layout: 'column', items: [{threads: 8, continues: true, label: '256 float4s'}]},
            ],
          },
          {
            id: 'act-gmem',
            label: 'Global memory',
            sub: 'cudaMalloc · HBM',
            tone: 'global',
            stretch: true,
            layout: 'row',
            items: [
              {
                id: 'act-x',
                array: 'x · 4096 × 3072',
                sub: 'a cell = 256 floats',
                rows: 4,
                cols: 12,
                continues: true,
                marks: [
                  {cols: [0, 3], rows: [0, 0], tone: 'register', label: 'block 0'},
                  {cols: [4, 7], rows: [0, 0], tone: 'register', label: 'block 1'},
                  {cols: [8, 11], rows: [0, 0], tone: 'register', label: 'block 2'},
                ],
                detail:
                  'A block covers 1024 floats, a third of a row; rows 1 … 4095 go to blocks 3 … 12,287 the same way. Every element is read exactly once.',
              },
              {
                id: 'act-bias',
                array: 'bias · 3072',
                sub: 'every row',
                cols: 12,
                marks: [{cols: [0, 11], tone: 'register', label: 'same lanes, every row'}],
                detail:
                  'Column `c` of every row adds `bias[c]`, so all 4096 rows read the same 12 KiB. It stays in L2 after the first row: no HBM cost to speak of.',
              },
              {
                id: 'act-y',
                array: 'y · 4096 × 3072',
                sub: 'written once',
                rows: 4,
                cols: 12,
                continues: true,
                detail: 'The same tiling as `x`: thread `i` writes the `float4` it read.',
              },
            ],
          },
        ],
      },
    },
    {
      title: 'float4 body and scalar tail',
      gpu: {
        layout: 'column',
        items: [
          {
            id: 'launches',
            label: 'Two launches for n = 1,000,003',
            sub: 'n4 = 250,000 · n % 4 = 3',
            align: 'end',
            items: [
              {
                id: 'vec-grid',
                label: 'gelu_bias_kernel',
                sub: '<<<977, 256>>>',
                count: '250,112 threads',
                detail:
                  '`(250,000 + 255) / 256` = 977 blocks: 250,112 threads for 250,000 vectors. The guard `if (i >= n4) return;` stops the extra 112 before they load past the end.',
                items: [
                  {label: 'Block 0', layout: 'column', items: [{threads: 9, continues: true, label: '256 work'}]},
                  {gap: '…'},
                  {
                    id: 'last-block',
                    label: 'Block 976',
                    layout: 'column',
                    items: [{threads: 9, idle: 4, continues: true, label: '144 work, 112 return'}],
                    detail:
                      'Threads 249,856 … 250,111: the first 144 have a vector, the last 112 find `i >= n4` and return.',
                  },
                ],
              },
              {
                id: 'tail',
                label: 'gelu_bias_tail_kernel',
                sub: '<<<1, 3>>> · start = 1,000,000',
                detail:
                  'Launched only when `n % 4 > 0`, from `start = 4 · n4`, guarded by `i >= n`: plain 4-byte loads and stores for the last three elements.',
                items: [{id: 'tail-threads', threads: 3, label: '3 scalar threads'}],
              },
            ],
          },
          {
            id: 'tail-gmem',
            label: 'Global memory',
            sub: 'y, 1,000,003 floats',
            tone: 'global',
            stretch: true,
            items: [
              {
                id: 'y-vec',
                array: 'y as float4',
                sub: 'a cell = 4 floats',
                cols: 16,
                continues: true,
                marks: [{cols: [0, 15], tone: 'global', label: 'y[0 … 999,999] · 250,000 × 16 B'}],
                detail:
                  '`reinterpret_cast<float4*>(y)`: 250,000 vectors cover `4 · n4` = 1,000,000 floats, one 16-byte store each.',
              },
              {
                id: 'y-tail',
                array: 'y tail',
                sub: '3 floats',
                cols: 3,
                marks: [{cols: [0, 2], tone: 'global', label: 'y[1,000,000 …]'}],
                detail:
                  'No `float4` covers them. Without the tail launch they keep the zeros they were filled with and the self-test fails.',
              },
            ],
          },
        ],
        arrows: [
          {from: 'vec-grid', to: 'y-vec', label: 'STG.128'},
          {from: 'tail', to: 'y-tail', label: 'STG.32'},
        ],
      },
    },
  ],
  steps: [fusedGeluStep],
  learn,
};
