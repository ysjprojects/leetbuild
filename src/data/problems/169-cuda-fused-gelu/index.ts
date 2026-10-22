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
  track: 'dl',
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
  architecture: {
    input: 'x: 4096 × 3072 float32 · bias: 3072',
    output: 'y = gelu(x + bias) · max abs err < 1e-5',
    items: [
      {
        id: 'host-in',
        label: 'Host buffers x, bias',
        kind: 'host',
        sub: '48 MiB + 12 KiB',
        detail:
          '`main` fills the GPT-2 small MLP activation (4096 tokens × 3072 columns) and its bias, and computes the reference `0.5·v·(1 + tanh(…))` in double.',
      },
      {
        id: 'h2d',
        label: 'cudaMemcpy host → device',
        kind: 'io',
        sub: 'x, bias',
        detail: 'Into `cudaMalloc` buffers, 256-byte aligned: every `float4` index is a legal 16-byte load.',
      },
      {
        id: 'gmem-in',
        label: 'Global memory x, bias',
        kind: 'memory',
        sub: 'x 48 MiB · bias 12 KiB',
        shape: 'float4[3,145,728] · float4[768]',
        detail:
          '`gelu_bias` reinterprets both as `float4*`: `n4 = n / 4` vectors of `x`, `cols4 = cols / 4 = 768` of the bias. The bias is read by every row, so after the first it is served from L2/L1.',
      },
      {
        columns: [
          [
            {
              tone: 'block',
              repeat: '12,288 ×',
              label: 'Thread block · 256 threads',
              items: [
                {
                  columns: [
                    [
                      {
                        id: 'ld-x',
                        label: 'float4 load x[i]',
                        kind: 'memory',
                        sub: 'LDG.128 · 16 B',
                        detail:
                          'Thread `i = blockIdx.x · 256 + threadIdx.x` returns when `i >= n4`; otherwise one 128-bit load of four consecutive elements. A warp asks for 512 contiguous bytes.',
                      },
                    ],
                    [
                      {
                        id: 'ld-b',
                        label: 'float4 load bias[i % 768]',
                        kind: 'memory',
                        sub: 'LDG.128 · cache-resident',
                        detail:
                          'With `cols % 4 == 0` the four lanes of `x[i]` are columns `4·(i % cols4) … + 3` of one row: exactly the lanes of `bias[i % cols4]`.',
                      },
                    ],
                  ],
                },
                {
                  tone: 'dotted',
                  label: 'Registers · four lanes',
                  items: [
                    {
                      id: 'add',
                      op: '+',
                      detail: '`v.x + b.x … v.w + b.w`: the bias add, fused. The sum `t` lives in registers only.',
                    },
                    {
                      id: 'gelu',
                      label: 'gelu_tanh × 4 lanes',
                      kind: 'kernel',
                      sub: '0.5v(1+tanh(√(2/π)(v+0.044715v³)))',
                      detail:
                        '`__forceinline__`, single precision, `tanhf` (not `tanh`, not `erff`): the tanh approximation GPT-2 was trained with. About 20 FLOPs per element.',
                    },
                  ],
                },
                {
                  id: 'st-y',
                  label: 'float4 store y[i]',
                  kind: 'kernel',
                  sub: 'STG.128 · 16 B',
                  detail: 'The four results assembled into one `float4 r` and stored once.',
                },
              ],
            },
          ],
          [
            {
              tone: 'dotted',
              label: 'Tail kernel · 1 block',
              items: [
                {
                  id: 'tail',
                  label: 'Scalar tail',
                  kind: 'kernel',
                  sub: 'y[i] = gelu(x[i] + bias[i % cols])',
                  detail:
                    '`gelu_bias_tail_kernel<<<1, n % 4>>>` from `start = 4 · n4`, guarded by `i >= n`, launched only when `n % 4 > 0`. Plain 4-byte loads and stores.',
                },
              ],
            },
          ],
        ],
      },
      {
        id: 'gmem-y',
        label: 'Global memory y',
        kind: 'memory',
        sub: '48 MiB · written once',
        shape: 'float[4096 × 3072]',
        detail:
          'Twenty timed launches between two `cudaEvent`s; `8 × n` bytes (x read once, y written once) over the time is the GB/s line.',
      },
      {
        id: 'd2h',
        label: 'cudaMemcpy device → host',
        kind: 'io',
        sub: 'y · 48 MiB',
      },
      {
        id: 'host-out',
        label: 'Host buffer y',
        kind: 'host',
        sub: 'vs double reference → PASS',
        detail:
          'Max abs error against the double-precision CPU reference, below `1e-5`, for n = 4096 × 3072 and for n = 1,000,003.',
      },
    ],
    notes: [
      {at: 'ld-x', text: '**16 B** per load: 512 B in flight per warp', side: 'left'},
      {at: 'add', text: 'Bias add in registers: **t** never reaches HBM', side: 'left'},
      {at: 'gelu', text: '~**2.5 FLOP/B** against a ridge near 20: memory-bound', side: 'left'},
      {at: 'gmem-y', text: '**96 MiB** per launch: one read of x, one write of y', side: 'left'},
    ],
    insets: [
      {
        for: 'gelu',
        title: 'Unfused: two kernels',
        items: [
          {id: 'u-x', label: 'Read x from HBM', kind: 'memory', sub: '48 MiB'},
          {id: 'u-add', label: 'add kernel', kind: 'kernel', sub: 't = x + b'},
          {id: 'u-t', label: 'Write t, read it back', kind: 'memory', sub: '2 × 48 MiB round trip'},
          {id: 'u-gelu', label: 'gelu kernel', kind: 'kernel', sub: 'F.gelu(t, approximate="tanh")'},
          {id: 'u-y', label: 'Write y to HBM', kind: 'memory', sub: '48 MiB'},
        ],
        note: '**192 MiB** of HBM traffic against **96 MiB** fused',
      },
    ],
  },
  steps: [fusedGeluStep],
  learn,
};
