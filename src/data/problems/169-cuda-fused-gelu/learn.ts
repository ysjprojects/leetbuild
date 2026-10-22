/**
 * The learning guide for the fused-GELU drill: the GELU and its tanh approximation, why an
 * elementwise kernel is memory-bound (arithmetic intensity against the roofline), what fusing the
 * bias add saves, float4 loads with their alignment rule and the scalar tail, __restrict__, and how
 * to turn cudaEvent timings into GB/s against the card's peak. Rendered at `/cuda-fused-gelu/learn`.
 */
export const learn = `# The mechanism at a glance

A transformer MLP is \`W₂ · gelu(W₁x + b₁) + b₂\`. Between the two matrix multiplies sits an elementwise
step — add the bias, apply the GELU — over an activation of \`tokens × 4·d_model\` floats. For GPT-2 small at
4096 tokens that is 4096 × 3072 = 12,582,912 elements, 48 MiB. The step does almost no arithmetic per byte,
so its speed is set by how many bytes it moves and how it asks for them.

One launch over the activation: a grid of 12,288 blocks of 256 threads, each thread one \`float4\` of \`x\`,
three blocks to a row of 3072 floats. Every thread adds the bias lanes that sit over its four columns and
applies the GELU in registers, so \`x\` is read once and \`y\` written once. A scalar kernel picks up the last
\`n % 4\` elements when there are any.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "grid", "label": "Kernel grid", "sub": "gelu_bias_kernel<<<12,288, 256>>>", "count": "12,288 blocks", "detail": "n4 = 4096 × 3072 / 4 = 3,145,728 threads, one per float4, in blocks of 256: three blocks per row of 3072 floats.", "items": [
      {"id": "block0", "label": "Block 0", "layout": "column", "items": [{"threads": 8, "continues": true, "label": "256 float4s"}], "detail": "Threads 0 … 255 take floats 0 … 1023 of row 0, four each: a warp asks for 512 contiguous bytes per load."},
      {"label": "Block 1", "layout": "column", "items": [{"threads": 8, "continues": true, "label": "256 float4s"}]},
      {"label": "Block 2", "layout": "column", "items": [{"threads": 8, "continues": true, "label": "256 float4s"}]},
      {"gap": "…"},
      {"label": "Block 12,287", "layout": "column", "items": [{"threads": 8, "continues": true, "label": "256 float4s"}]}
    ]},
    {"id": "act-gmem", "label": "Global memory", "sub": "cudaMalloc · HBM", "tone": "global", "stretch": true, "items": [
      {"id": "act-x", "array": "x · 4096 × 3072", "sub": "a cell = 256 floats", "rows": 4, "cols": 12, "continues": true, "marks": [
        {"cols": [0, 3], "rows": [0, 0], "tone": "register", "label": "block 0"},
        {"cols": [4, 7], "rows": [0, 0], "tone": "register", "label": "block 1"},
        {"cols": [8, 11], "rows": [0, 0], "tone": "register", "label": "block 2"}
      ], "detail": "A block covers 1024 floats, a third of a row; every element is read exactly once."},
      {"id": "act-bias", "array": "bias · 3072", "sub": "every row", "cols": 12, "marks": [{"cols": [0, 11], "tone": "register", "label": "same lanes, every row"}], "detail": "All 4096 rows read the same 12 KiB; after the first row it comes from L2."},
      {"id": "act-y", "array": "y · 4096 × 3072", "sub": "written once", "rows": 4, "cols": 12, "continues": true, "detail": "Thread i writes the float4 it read."}
    ]}
  ]
}
:::

The contract, in one file \`fused_gelu.cu\`:

- \`gelu_tanh(float v)\`: \`0.5f * v * (1.0f + tanhf(0.79788456f * (v + 0.044715f * v * v * v)))\`, a
  \`__device__ __forceinline__\` function in single precision.
- \`gelu_bias_kernel(const float4* __restrict__ x, const float4* __restrict__ bias, float4* __restrict__ y, int n4, int cols4)\`:
  return if \`i >= n4\`; load \`x[i]\` and \`bias[i % cols4]\`; four \`gelu_tanh(v.x + b.x)\` … ; store \`y[i]\`.
- \`gelu_bias_tail_kernel(..., int start, int n, int cols)\`: the same on \`float\`, \`i = start + …\`, return if \`i >= n\`.
- \`gelu_bias(x, bias, y, n, cols)\`: \`n4 = n / 4\`, the vector launch with \`cols / 4\`, then the tail launch from
  \`4 * n4\` when \`n % 4 > 0\`, \`cudaGetLastError()\` after each. Requires \`cols % 4 == 0\` and \`cudaMalloc\`'d pointers.

# GELU and the tanh approximation

[Hendrycks & Gimpel (2016)](https://arxiv.org/abs/1606.08415) define the Gaussian Error Linear Unit as the
input weighted by the probability that a standard normal falls below it:

\`\`\`text
GELU(v) = v · Φ(v) = 0.5 · v · (1 + erf(v / √2))                       exact
GELU(v) ≈ 0.5 · v · (1 + tanh(√(2/π) · (v + 0.044715 · v³)))           tanh approximation
√(2/π) = 0.7978845608…   →   0.79788456f in the kernel
\`\`\`

Unlike ReLU it is smooth and slightly negative left of zero. GPT-2 and BERT shipped with the tanh form
because \`erf\` was slow in their frameworks; the checkpoints were trained with it, so inference has to match
it — which is why PyTorch's [\`nn.GELU\`](https://pytorch.org/docs/stable/generated/torch.nn.GELU.html) takes
\`approximate="tanh"\`.

| v | exact (erf) | tanh form | difference |
|---|---|---|---|
| −3 | −0.00405 | −0.00364 | 4.1e-4 |
| −1 | −0.15866 | −0.15881 | 1.5e-4 |
| 0 | 0 | 0 | 0 |
| 1 | 0.84134 | 0.84119 | 1.5e-4 |
| 3 | 2.99595 | 2.99636 | 4.1e-4 |

- The two forms differ by up to about 4.7e-4 — fifty times the drill's 1e-5 tolerance. Swapping in \`erff\` or
  \`normcdff\` is not a faster equivalent; it is a different function.
- \`tanhf\`, not \`tanh\`: on a \`float\` argument in device code, \`tanh\` may resolve to the double routine. Double
  throughput on consumer GPUs is 1/32 or 1/64 of float.
- \`__forceinline__\` puts the body inline in all four lanes, so nothing is a call; the cube is two multiplies,
  the polynomial an FMA.

:::quiz
Q: A colleague replaces tanhf with erff "because it is the exact GELU". What happens to the self-test?
- [ ] Nothing — erff is more accurate, so the error shrinks
- [x] It fails — the reference is the tanh form, and the two differ by up to ~4.7e-4
- [ ] It passes but runs slower
> The CPU reference is 0.5·v·(1 + tanh(…)) in double. The exact GELU is a different curve; near |v| = 2–3 it is off the reference by about forty times the 1e-5 bound. Models trained with one form expect that form.
:::

# Memory-bound: arithmetic intensity and the roofline

The [roofline model](https://dl.acm.org/doi/10.1145/1498765.1498785) bounds a kernel's speed by the smaller
of two ceilings: peak FLOP/s, and peak bandwidth × **arithmetic intensity** (FLOPs per byte moved). The
crossover — the ridge point — is peak FLOP/s ÷ peak bandwidth.

| Quantity | fused GELU | H100 SXM |
|---|---|---|
| bytes per element (HBM) | 4 read + 4 written = 8 | — |
| FLOPs per element | ~20 (cube, FMA, \`tanhf\`, scale) | — |
| arithmetic intensity | ~2.5 FLOP/byte | — |
| peak FP32 / peak bandwidth | — | ~67 TFLOP/s / 3.35 TB/s |
| ridge point | — | ~20 FLOP/byte |

- At 2.5 FLOP/byte the kernel sits far left of the ridge: the ALUs are idle most of the time, waiting on
  memory. Making \`gelu_tanh\` cheaper would not change the run time; moving fewer bytes, or moving them
  more efficiently, would.
- The bias is 3072 floats, 12 KiB. Every row reads the same 12 KiB, so after the first row it is served
  from L1/L2 and its HBM cost rounds to zero — which is why the drill counts \`8 × n\` bytes, not 12.
- A GEMM sits at the opposite end: hundreds of FLOP/byte. That is why the MLP's time goes to the matmuls
  and why the elementwise step between them must not add a second or third pass over the activation.

The kernels of this track on one roofline; pick a GPU and see how far left of the ridge an elementwise
op sits next to a matmul:

:::widget roofline

:::quiz
Q: You replace tanhf with a cheaper polynomial and halve the FLOPs per element. Roughly how much faster does the kernel get on an H100?
- [ ] About 2× — half the work
- [x] Barely at all — it was waiting on HBM, not on arithmetic
- [ ] Slower — polynomials diverge
> At ~2.5 FLOP/byte against a ridge of ~20, the run time is bytes ÷ bandwidth. Halving FLOPs moves the kernel further left on the roofline but leaves the bandwidth ceiling where it was.
:::

# Fusion: one read, one write

Eager PyTorch runs \`x + b\` and \`F.gelu\` as two kernels. The intermediate \`x + b\` is a full activation
that has to be written to HBM by the first and read back by the second. Side by side, from the same \`x\`
to the same \`y\`: above, every arrow is a 48 MiB pass over HBM; below, the sum lives in the four lanes of
a \`float4\` register and only \`x\` and \`y\` cross the memory boundary.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "eager", "label": "Eager PyTorch: two launches", "sub": "x + bias, then F.gelu(t)", "count": "192 MiB of HBM traffic", "items": [
      {"id": "u-in", "label": "HBM", "tone": "global", "layout": "column", "items": [
        {"id": "u-x", "array": "x", "sub": "48 MiB", "cols": 6, "continues": true},
        {"id": "u-b", "array": "bias", "sub": "12 KiB", "cols": 3}
      ]},
      {"id": "u-add", "label": "add kernel", "sub": "t = x + bias", "tone": "compute"},
      {"id": "u-mid", "label": "HBM", "tone": "global", "items": [
        {"id": "u-t", "array": "t", "sub": "48 MiB", "cols": 6, "continues": true, "detail": "A full round trip through HBM for values that were in registers a moment earlier."}
      ]},
      {"id": "u-gelu", "label": "gelu kernel", "sub": "y = gelu(t)", "tone": "compute"},
      {"id": "u-out", "label": "HBM", "tone": "global", "items": [{"id": "u-y", "array": "y", "sub": "48 MiB", "cols": 6, "continues": true}]}
    ]},
    {"id": "fused", "label": "Fused: one launch", "sub": "gelu_bias_kernel<<<12,288, 256>>>", "count": "96 MiB of HBM traffic", "items": [
      {"id": "f-in", "label": "HBM", "tone": "global", "layout": "column", "items": [
        {"id": "x", "array": "x", "sub": "48 MiB", "cols": 6, "continues": true},
        {"id": "bias", "array": "bias", "sub": "12 KiB · from L2", "cols": 3, "detail": "Read by every row, so it comes from L2 after the first."}
      ]},
      {"id": "thread", "label": "Thread i", "sub": "i = blockIdx.x · 256 + threadIdx.x", "count": "3,145,728 threads", "layout": "column", "items": [
        {"id": "regs", "label": "Registers", "sub": "t never leaves them", "tone": "register", "layout": "column", "items": [
          {"id": "v", "array": "v = x[i] + bias[i % 768]", "cols": 4, "cells": [".x", ".y", ".z", ".w"], "tone": "register", "detail": "The bias add, four FADDs, fused."},
          {"id": "r", "array": "r = gelu_tanh(v)", "sub": "× 4 lanes", "cols": 4, "cells": [".x", ".y", ".z", ".w"], "tone": "register", "detail": "Inlined, single precision, about 20 FLOPs per element."}
        ]}
      ]},
      {"id": "f-out", "label": "HBM", "tone": "global", "items": [{"id": "y", "array": "y", "sub": "48 MiB", "cols": 6, "continues": true}]}
    ]}
  ],
  "arrows": [
    {"from": "u-in", "to": "u-add", "label": "read 48 MiB"},
    {"from": "u-add", "to": "u-mid", "label": "write 48 MiB"},
    {"from": "u-mid", "to": "u-gelu", "label": "read 48 MiB"},
    {"from": "u-gelu", "to": "u-out", "label": "write 48 MiB"},
    {"from": "f-in", "to": "regs", "label": "float4 reads · 48 MiB"},
    {"from": "regs", "to": "f-out", "label": "float4 writes · 48 MiB"}
  ]
}
:::

| Implementation | kernels | HBM bytes per element | for 4096 × 3072 |
|---|---|---|---|
| GELU spelled out op by op (\`v**3\`, \`*\`, \`+\`, \`tanh\`, …) plus bias | ~8 | ~64 | ~768 MiB |
| \`x + b\` then \`F.gelu(approximate="tanh")\` | 2 | 16 | 192 MiB |
| fused \`gelu_bias_kernel\` | 1 | 8 | 96 MiB |

On a memory-bound op, bytes are time: the fused kernel is about twice as fast as the two-kernel version
without any change to the arithmetic.

:::quiz
Q: Why does fusing the bias add into the GELU halve the run time even though the arithmetic is unchanged?
- [ ] The compiler can skip the bias add when it is fused
- [ ] One launch instead of two saves most of the time
- [x] The intermediate x + b never goes to HBM, so 16 bytes per element become 8
> Launch overhead is microseconds; the activation is 48 MiB. The two-kernel version writes t and reads it straight back. Keeping t in a register removes exactly that round trip.
:::

# float4, alignment and the tail

Fusion fixes how many bytes move; vectorising fixes how they are requested.
[Vectorised loads](https://developer.nvidia.com/blog/cuda-pro-tip-increase-performance-with-vectorized-memory-access/)
make each thread fetch a \`float4\` — one 128-bit \`LDG.E.128\` instead of four 32-bit loads. The bytes are
the same; the instructions issued per byte drop by four, and each warp keeps 512 bytes in flight per load
instead of 128, which is what it takes to saturate HBM.

The rules that make \`reinterpret_cast<const float4*>(x)\` legal:

- **Alignment.** A 16-byte load needs a 16-byte-aligned address, or the kernel dies with a misaligned
  address error. \`cudaMalloc\` returns 256-byte-aligned memory; \`x + 1\` is not 16-aligned.
- **The bias lanes line up.** With \`cols % 4 == 0\`, the four lanes of \`x[i]\` are columns
  \`4·(i % cols4)\` … \`+3\` of one row — exactly the four lanes of \`bias[i % cols4]\`.
- **The tail.** \`n / 4\` vectors cover \`4 · n4\` elements; the last \`n % 4\` need scalar code.

For \`n = 1,000,003\` the split is two launches over two ranges of \`y\`. The last block of the vector
kernel has 112 threads past \`n4\` (dimmed): without the guard they would load past the end. The tail
kernel's three threads write the floats no \`float4\` covers: without that launch they stay 0 and the
self-test fails.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "launches", "label": "Two launches for n = 1,000,003", "sub": "n4 = 250,000 · n % 4 = 3", "align": "end", "items": [
      {"id": "vec-grid", "label": "gelu_bias_kernel", "sub": "<<<977, 256>>>", "count": "250,112 threads", "detail": "977 blocks: 250,112 threads for 250,000 vectors; if (i >= n4) return; stops the extra 112.", "items": [
        {"label": "Block 0", "layout": "column", "items": [{"threads": 9, "continues": true, "label": "256 work"}]},
        {"gap": "…"},
        {"id": "last-block", "label": "Block 976", "layout": "column", "items": [{"threads": 9, "idle": 4, "continues": true, "label": "144 work, 112 return"}]}
      ]},
      {"id": "tail", "label": "gelu_bias_tail_kernel", "sub": "<<<1, 3>>> · start = 1,000,000", "detail": "Launched only when n % 4 > 0, guarded by i >= n.", "items": [
        {"id": "tail-threads", "threads": 3, "label": "3 scalar threads"}
      ]}
    ]},
    {"id": "tail-gmem", "label": "Global memory", "sub": "y, 1,000,003 floats", "tone": "global", "stretch": true, "items": [
      {"id": "y-vec", "array": "y as float4", "sub": "a cell = 4 floats", "cols": 16, "continues": true, "marks": [{"cols": [0, 15], "tone": "global", "label": "y[0 … 999,999] · 250,000 × 16 B"}]},
      {"id": "y-tail", "array": "y tail", "sub": "3 floats", "cols": 3, "marks": [{"cols": [0, 2], "tone": "global", "label": "y[1,000,000 …]"}]}
    ]}
  ],
  "arrows": [
    {"from": "vec-grid", "to": "y-vec", "label": "STG.128"},
    {"from": "tail", "to": "y-tail", "label": "STG.32"}
  ]
}
:::

The correct host code launches the guarded vector kernel over 250,000 threads and then
\`gelu_bias_tail_kernel<<<1, 3>>>\` from \`start = 1,000,000\`. The alternative — padding the buffer to a
multiple of four — moves the problem to every allocator in the stack.

:::details What __restrict__ buys
Without it, the compiler must assume \`y\` might alias \`x\` or \`bias\`: a store to \`y[i]\` could change a later
load, so loads cannot be hoisted above stores, and \`x\` cannot be routed through the read-only (non-coherent)
data path. Marking all three pointers \`__restrict__\` is a promise that they do not overlap; the compiler can
issue both 16-byte loads before any arithmetic and use \`LDG.E.128.CONSTANT\`. Break the promise — call
\`gelu_bias(x, b, x + 4, …)\` — and the result is undefined.
:::

:::quiz
Q: The host calls gelu_bias(d_x + 2, d_b, d_y, n - 2, cols). What goes wrong?
- [ ] Nothing — the tail kernel absorbs the offset
- [x] d_x + 2 is 8-byte aligned, so the float4 loads are misaligned and the launch faults
- [ ] Only the bias lanes are shifted
> A float4 load requires a 16-byte-aligned address. cudaMalloc guarantees it for the base pointer; an offset of two floats breaks it. Real libraries check alignment and fall back to the scalar path.
:::

# Measuring GB/s against peak

The [Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#effective-bandwidth-calculation)
defines effective bandwidth as the bytes the kernel must move divided by its time:

\`\`\`text
bytes   = 8 × n = 8 × 12,582,912 = 100,663,296         (x read once, y written once)
ms      = cudaEventElapsedTime(start, stop) / 20
GB/s    = bytes / (ms × 1e6)
\`\`\`

| GPU | peak memory bandwidth | 80 % of peak → ms per launch |
|---|---|---|
| H100 SXM (HBM3) | ~3,350 GB/s | ~0.038 |
| A100 80 GB (HBM2e) | ~2,000 GB/s | ~0.063 |
| RTX 4090 (GDDR6X) | ~1,008 GB/s | ~0.125 |

- Count the bytes the algorithm needs, not what the hardware did. The bias is excluded because it is
  cache-resident; including it would inflate the number.
- Time many launches between two events and divide. One launch of a 40 µs kernel is too short for the
  event resolution to mean much.
- The correctness launch runs first, so the timed loop is warm.
- Use a buffer bigger than L2. H100's L2 is 50 MB; \`x\` and \`y\` together are 100 MB. A small \`n\` measures
  the cache, not HBM, and can exceed the "peak".
- 80–90 % of peak is the ceiling for a streaming kernel. A scalar version of the same kernel typically
  lands well below that because it cannot keep enough bytes in flight.

:::quiz
Q: The kernel reports 4,100 GB/s on an H100 SXM whose HBM peak is 3,350 GB/s. Most likely?
- [ ] The float4 loads double the effective bandwidth
- [x] The buffers fit in L2, or the byte count includes traffic that never reached HBM
- [ ] cudaEventElapsedTime is in microseconds, not milliseconds
> No kernel beats the DRAM ceiling. Numbers above it mean the data came from cache or the bytes were miscounted — the reason the drill uses a 48 MiB activation and counts only x and y.
:::

# What to take away

- The bias + GELU between the MLP's GEMMs is memory-bound: about 2.5 FLOP/byte against a ridge near 20.
  Its cost is bytes.
- Fusion removes the intermediate: one read of \`x\`, one write of \`y\`, 8 bytes per element instead of 16 or
  more.
- \`float4\` loads move the same bytes in a quarter of the instructions. They need 16-byte alignment,
  \`cols % 4 == 0\` for the bias lanes, and a scalar tail for \`n % 4\`.
- \`__restrict__\` lets the compiler issue the loads early and use the read-only path. The tanh form, in
  \`float\` with \`tanhf\`, is the GELU GPT-2 was trained with.
- Report GB/s as needed bytes ÷ time and compare with the card's peak. Production stacks go one step
  further and fuse the GELU into the GEMM epilogue (cuBLASLt \`EPILOGUE_GELU_BIAS\`, CUTLASS, Triton).

Primary reference: Hendrycks & Gimpel, [Gaussian Error Linear Units (GELUs)](https://arxiv.org/abs/1606.08415).
`;
