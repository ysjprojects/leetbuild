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

Bottom to top, one launch: the activation and the bias come in from global memory as 16-byte vectors, the
bias add and the GELU happen in registers, and \`y\` goes out once. A scalar kernel picks up the last
\`n % 4\` elements.

:::architecture
{
  "input": "x: 4096 × 3072 float32 · bias: 3072",
  "output": "y = gelu(x + bias)",
  "items": [
    {"id": "gmem-in", "label": "Global memory x, bias", "kind": "memory", "sub": "x 48 MiB · bias 12 KiB", "shape": "float4[3,145,728] · float4[768]", "detail": "Reinterpreted as float4: n4 = n / 4 vectors of x, cols4 = 768 of the bias."},
    {"columns": [
      [{"tone": "block", "repeat": "12,288 ×", "label": "Thread block · 256 threads", "items": [
        {"columns": [
          [{"id": "ld-x", "label": "float4 load x[i]", "kind": "memory", "sub": "LDG.128 · 16 B", "detail": "Returns first when i >= n4. A warp asks for 512 contiguous bytes."}],
          [{"id": "ld-b", "label": "float4 load bias[i % 768]", "kind": "memory", "sub": "LDG.128 · cache-resident", "detail": "The four lanes of x[i] are the four lanes of bias[i % cols4] when cols % 4 == 0."}]
        ]},
        {"tone": "dotted", "label": "Registers · four lanes", "items": [
          {"id": "add", "op": "+", "detail": "v.x + b.x … v.w + b.w: the fused bias add."},
          {"id": "gelu", "label": "gelu_tanh × 4 lanes", "kind": "kernel", "sub": "0.5v(1+tanh(√(2/π)(v+0.044715v³)))", "detail": "Single precision, tanhf, inlined: about 20 FLOPs per element."}
        ]},
        {"id": "st-y", "label": "float4 store y[i]", "kind": "kernel", "sub": "STG.128 · 16 B"}
      ]}],
      [{"tone": "dotted", "label": "Tail kernel · 1 block", "items": [
        {"id": "tail", "label": "Scalar tail", "kind": "kernel", "sub": "y[i] = gelu(x[i] + bias[i % cols])", "detail": "Launched with n % 4 threads from 4 · n4, only when n % 4 > 0."}
      ]}]
    ]},
    {"id": "gmem-y", "label": "Global memory y", "kind": "memory", "sub": "48 MiB · written once", "shape": "float[4096 × 3072]"}
  ],
  "notes": [
    {"at": "ld-x", "text": "**16 B** per load: 512 B in flight per warp", "side": "left"},
    {"at": "gelu", "text": "~**2.5 FLOP/B** against a ridge near 20: memory-bound"},
    {"at": "tail", "text": "Only when **n % 4 > 0**"},
    {"at": "gmem-y", "text": "**8 B** of HBM per element: one read, one write"}
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
to the same \`y\`:

:::architecture
{
  "input": "x, bias",
  "output": "y = gelu(x + bias)",
  "items": [
    {"id": "gmem-x", "label": "Global memory x", "kind": "memory", "sub": "48 MiB", "detail": "Read once by either version; the bias comes from cache."},
    {"columns": [
      [{"tone": "dotted", "label": "Eager · 2 kernels", "items": [
        {"id": "e-add", "label": "add kernel", "kind": "kernel", "sub": "t = x + b"},
        {"id": "e-t", "label": "Global memory t", "kind": "memory", "sub": "48 MiB written, then read back", "detail": "The intermediate makes a full round trip through HBM: the bytes just written are read straight back."},
        {"id": "e-gelu", "label": "gelu kernel", "kind": "kernel", "sub": "F.gelu(t), tanh form"}
      ]}],
      [{"tone": "dotted", "label": "Fused · 1 kernel", "items": [
        {"id": "f-add", "label": "Registers: v + b", "kind": "memory", "sub": "t never leaves the thread"},
        {"id": "f-gelu", "label": "gelu_tanh × 4 lanes", "kind": "kernel", "sub": "in registers"}
      ]}]
    ]},
    {"id": "gmem-y", "label": "Global memory y", "kind": "memory", "sub": "48 MiB"}
  ],
  "notes": [
    {"at": "e-t", "text": "**192 MiB** moved, two launches", "side": "left"},
    {"at": "f-gelu", "text": "**96 MiB** moved, one launch"}
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

For \`n = 1,000,003\` the split is two launches over two ranges of \`y\`; the notes mark what each missing
piece costs:

:::architecture
{
  "input": "n = 1,000,003 · n4 = 250,000",
  "output": "all 1,000,003 elements of y",
  "items": [
    {"id": "gmem-x", "label": "Global memory x, bias", "kind": "memory", "sub": "x: 1,000,003 floats"},
    {"columns": [
      [{"tone": "block", "repeat": "977 ×", "label": "Vector kernel · 256 threads", "items": [
        {"id": "guard", "label": "Guard: i >= n4 returns", "kind": "kernel", "sub": "250,112 threads, 112 spare"},
        {"id": "vec", "label": "float4 path", "kind": "kernel", "sub": "y[0 … 999,999]"}
      ]}],
      [{"tone": "dotted", "label": "Tail kernel · 3 threads", "items": [
        {"id": "tk", "label": "Scalar tail", "kind": "kernel", "sub": "y[1,000,000 … 1,000,002]", "detail": "gelu_bias_tail_kernel with start = 4 · n4 = 1,000,000."}
      ]}]
    ]},
    {"id": "gmem-y", "label": "Global memory y", "kind": "memory", "sub": "every element written once"}
  ],
  "notes": [
    {"at": "vec", "text": "No guard: **112** threads load past the end", "side": "left"},
    {"at": "tk", "text": "No tail launch: the last **3** stay 0, FAIL"}
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
