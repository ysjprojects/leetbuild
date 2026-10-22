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
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · gelu_bias()',
        sub: 'n4 = n / 4 · tail = n % 4 · CPU reference · GB/s · PASS',
        x: 8,
        y: 50,
      },
      {
        id: 'kernel',
        kind: 'service',
        label: 'gelu_bias_kernel<<<⌈n4/256⌉, 256>>>',
        sub: 'float4 load x, bias · 4 × gelu_tanh · float4 store',
        x: 40,
        y: 28,
      },
      {
        id: 'tail',
        kind: 'service',
        label: 'gelu_bias_tail_kernel<<<1, n % 4>>>',
        sub: 'scalar, from 4 · n4 to n',
        x: 40,
        y: 74,
      },
      {id: 'hbm', kind: 'db', label: 'Device memory (HBM)', sub: 'x, y: 48 MiB each · bias: 12 KiB', x: 82, y: 50},
    ],
    edges: [
      {from: 'host', to: 'kernel', kind: 'plain', label: 'reinterpret_cast<float4*> · cols / 4'},
      {from: 'host', to: 'tail', kind: 'plain', label: 'only if n % 4 > 0'},
      {from: 'kernel', to: 'hbm', kind: 'plain', label: 'LDG.128 ×2 · STG.128'},
      {from: 'tail', to: 'hbm', kind: 'plain', label: '≤ 3 scalar elements'},
    ],
  },
  steps: [fusedGeluStep],
  learn,
};
