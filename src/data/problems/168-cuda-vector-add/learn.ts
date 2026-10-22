/**
 * The learning guide for the vector-add drill: the thread hierarchy and launch geometry, why a
 * grid-stride loop with a bounds test replaces one-thread-per-element, which errors show up where
 * (and why a launch needs cudaGetLastError and the read-back needs a synchronise), the memory
 * round trip, and what cudaEvent timing of a bandwidth-bound kernel actually measures — a figure or
 * a table where one says it faster than prose, a pop quiz per section. Rendered at
 * \`/cuda-vector-add/learn\`.
 */
export const learn = `# The mechanism at a glance

A CUDA program is two programs: host code that owns the data and the schedule, and a **kernel** that
runs on the GPU as thousands of threads at once. Vector add is the smallest kernel with a real body
— \`c[i] = a[i] + b[i]\` — and the host code around it is the shape every custom kernel in a training
stack sits inside: allocate, copy in, pick a grid, launch, check, synchronise, copy out, compare, free.

The figure is the program's layout in memory and threads: the host arrays on the left, the copies across
the link, and on the GPU a grid of 1,024 blocks of 256 threads over the device arrays. Each cell of
\`d_a, d_b\` is one pass of the whole grid; hover a part marked with a dot for what it does.

:::gpu
{
  "align": "end",
  "items": [
    {"id": "host", "label": "Host", "sub": "pageable memory", "tone": "host", "layout": "column", "items": [
      {"id": "h-ab", "array": "h_a, h_b", "sub": "2 × 16 MiB", "cols": 12, "tone": "host", "continues": true, "detail": "Filled by main, which also computes the CPU reference. The kernel cannot read host memory: it has to be copied."},
      {"id": "h-c", "array": "h_c", "sub": "max |h_c − h_ref| = 0", "cols": 12, "tone": "host", "continues": true, "detail": "Copied back after cudaDeviceSynchronize() and compared over all n."}
    ]},
    {"id": "gpu", "label": "GPU", "layout": "column", "items": [
      {"id": "grid", "label": "Kernel grid", "sub": "vector_add<<<1024, 256>>>", "count": "1,024 blocks", "detail": "(n + 255) / 256 = 16,385 blocks would cover n in one pass; the launch caps the grid at 1,024 and lets each thread loop instead.", "items": [
        {"id": "block0", "label": "Block 0", "layout": "column", "items": [{"threads": 10, "continues": true, "label": "256 threads"}], "detail": "Threads 0 … 255 start at elements 0 … 255: adjacent threads, adjacent floats."},
        {"label": "Block 1", "layout": "column", "items": [{"threads": 10, "continues": true, "label": "256 threads"}]},
        {"gap": "…"},
        {"label": "Block 1023", "layout": "column", "items": [{"threads": 10, "continues": true, "label": "256 threads"}]}
      ]},
      {"id": "gmem", "label": "Global memory", "sub": "cudaMalloc · HBM", "tone": "global", "stretch": true, "layout": "column", "items": [
        {"id": "d-ab", "array": "d_a, d_b", "sub": "a cell = one pass of 262,144 floats", "cols": 17, "cells": "index", "marks": [
          {"cols": [0, 15], "tone": "global", "label": "16 full passes"},
          {"cols": [16, 16], "tone": "muted", "label": "37"}
        ], "detail": "Pass p covers elements p · 262,144 + i. The 17th pass has only 37 elements; every other thread finds i ≥ n and leaves the loop."},
        {"id": "d-c", "array": "d_c", "sub": "each element written once", "cols": 17, "detail": "One 4-byte store per element: 12 bytes of HBM traffic per add."}
      ]}
    ]}
  ],
  "arrows": [
    {"from": "h-ab", "to": "d-ab", "label": "cudaMemcpy H2D"},
    {"from": "d-c", "to": "h-c", "label": "cudaMemcpy D2H"}
  ]
}
:::

The contract the drill implements, in one file \`vector_add.cu\`:

- \`__global__ void vector_add(const float* a, const float* b, float* c, int n)\`: every thread starts at
  \`blockIdx.x * blockDim.x + threadIdx.x\`, strides by \`gridDim.x * blockDim.x\`, stops at \`n\`.
- \`CUDA_CHECK(call)\`: a macro around **every** runtime call; a failure prints \`cudaGetErrorString\` with
  \`__FILE__:__LINE__\` and exits.
- \`launch_vector_add\`: \`BLOCK_SIZE = 256\`, \`blocks = (n + 255) / 256\` capped at \`MAX_BLOCKS = 1024\`,
  the launch, then \`CUDA_CHECK(cudaGetLastError())\`.
- \`run_vector_add\` → ms per launch: three \`cudaMalloc\`s, two copies in, a warm-up, twenty launches between
  two \`cudaEvent\`s, \`cudaDeviceSynchronize\`, the copy out, three \`cudaFree\`s.
- \`main\`: \`n = 4,194,341\`, a CPU reference, the max abs error (0), a bandwidth line, \`PASS\`.

Where it sits in a model: the residual add \`x + attn(x)\`, a bias add, an optimizer's \`p -= lr * g\` are all
this kernel. Frameworks rarely launch it alone — it is bandwidth-bound, so they fuse it into the kernel
before or after — but the host-side protocol is the one here, every time.

# Threads, blocks and the grid

A launch names a **grid** of **blocks** of **threads**; the
[thread hierarchy](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#thread-hierarchy)
is what \`<<<blocks, BLOCK_SIZE>>>\` fills in. Each thread finds out who it is from built-in variables:

| Built-in | Meaning | In the drill |
| --- | --- | --- |
| \`threadIdx.x\` | index within the block | 0 … 255 |
| \`blockDim.x\` | threads per block | 256 (8 warps of 32) |
| \`blockIdx.x\` | index of the block within the grid | 0 … 1023 |
| \`gridDim.x\` | blocks in the grid | min(⌈n / 256⌉, 1024) = 1024 |
| global index | \`blockIdx.x * blockDim.x + threadIdx.x\` | 0 … 262,143 |

- A block runs on one streaming multiprocessor (SM); its threads can share memory and synchronise. Blocks
  cannot talk to each other inside a launch, which is what lets the hardware run them in any order on
  any SM.
- A block is executed as **warps** of 32 threads in lockstep. 256 is the usual default: enough warps to
  hide memory latency, small enough that several blocks fit on an SM.
- Ceiling division \`(n + BLOCK_SIZE - 1) / BLOCK_SIZE\` gives the blocks needed to cover \`n\` with one
  thread each; \`n / BLOCK_SIZE\` would drop the last partial block and leave up to 255 elements undone.
- The grid is **capped**: 4,194,341 elements want 16,385 blocks, the drill launches 1024. A grid is not
  free — each block is scheduled, each SM holds a bounded number — and \`gridDim.x\` on one axis has a
  hardware maximum of 2³¹ − 1 blocks, which a 2 G-element tensor with one thread per element would hit.
  Real code picks the cap from the SM count times the blocks an SM can hold at once.

:::quiz
Q: n = 1000 elements, BLOCK_SIZE = 256. How many blocks does the ceiling division launch, and how many threads are idle if each thread handled exactly one element?
- [ ] 3 blocks, 0 idle — 1000 / 256 rounds to 3
- [x] 4 blocks, 24 idle — ⌈1000 / 256⌉ = 4, covering 1024 thread slots
- [ ] 1000 blocks of one thread each
> Integer division gives 3 blocks = 768 threads, leaving 232 elements untouched; (1000 + 255) / 256 = 4 covers all of them and the 24 extra threads must be stopped by a bounds test, not allowed to write c[1000 … 1023].
:::

# The grid-stride loop and the bounds test

The obvious kernel gives each thread one element: \`int i = blockIdx.x * blockDim.x + threadIdx.x; c[i] = a[i] + b[i];\`.
It is wrong twice. The last block's spare threads write past the end of \`c\`, and once the grid is capped,
elements beyond \`gridDim.x * blockDim.x\` are never visited at all:

| Launch, one element per thread | Threads | Elements of \`c\` written | Result |
| --- | --- | --- | --- |
| \`<<<1024, 256>>>\`, capped | 262,144 | \`c[0 … 262,143]\`; \`c[262,144 … 4,194,340]\` never written | max abs err ≈ 2, \`FAIL\` |
| \`<<<16385, 256>>>\`, uncapped, no bounds test | 4,194,560 | all of \`c\`, plus \`c[4,194,341 … 4,194,559]\`: 219 writes past the end | illegal address at the synchronise, or silent corruption |

The [grid-stride loop](https://developer.nvidia.com/blog/cuda-pro-tip-write-flexible-kernels-grid-stride-loops/)
fixes both with the same four lines:

\`\`\`cuda
int start  = blockIdx.x * blockDim.x + threadIdx.x;   // this thread's first element
int stride = gridDim.x * blockDim.x;                  // total threads in the grid
for (int i = start; i < n; i += stride) {
  c[i] = a[i] + b[i];
}
\`\`\`

Thread \`t\` visits \`t\`, \`t + stride\`, \`t + 2·stride\`, … while the index is below \`n\`. With 1024 × 256
threads, threads 0 … 36 write 17 elements (thread 0: \`c[0]\`, \`c[262,144]\`, … \`c[4,194,304]\`) and every
other thread writes 16; every \`i < n\` is written exactly once and nothing past it. The same loop on a small
array, where you can shrink the grid and watch the passes and the bounds check at the tail:

:::widget cuda-grid {"n": 50, "block": 8}

| Property | One thread per element | Grid-stride loop |
| --- | --- | --- |
| Bounds | needs an \`if (i < n)\` or writes past the end | the loop condition is the bounds test |
| Grid size | must equal ⌈n / blockDim⌉ — tied to the data | any grid; the cap is a tuning knob, not a correctness one |
| n = 37 with 1024 blocks | 262,107 threads write garbage | 37 threads do one element, the rest exit at once |
| n = 2³² | overflows \`gridDim.x\` | works, with 64-bit indices |
| Coalescing | thread t reads a[t] — contiguous | thread t reads a[t], then a[t + stride] — still contiguous within a warp at every step |
| Per-thread cost | one load pair, one store | plus one compare and one add per iteration — negligible against a 12-byte memory transaction |

Adjacent threads still touch adjacent addresses at every iteration — \`i\` differs by 1 across a warp — so
the loop keeps the **coalesced** access pattern that makes the kernel run at memory bandwidth; a thread
that instead walked its own contiguous chunk (\`i = t * 16 … t * 16 + 15\`) would scatter a warp's loads
across 16 cache lines.

One pass of warp 0, drawn at the level of bytes: the 32 lanes ask for 32 adjacent floats of \`a\`, the
memory system serves the 128 bytes as four 32-byte sectors, and lanes 0 to 7 get the first sector, lanes 8
to 15 the second, and so on. \`b\` the same; the sum is formed in registers and stored as four whole sectors.

:::gpu
{
  "align": "end",
  "items": [
    {"id": "warp-gmem", "label": "Global memory", "sub": "pass p: elements i … i + 31", "tone": "global", "layout": "column", "items": [
      {"id": "w-a", "array": "a[i … i + 31]", "sub": "128 B", "cols": 32, "marks": [
        {"cols": [0, 7], "tone": "global", "label": "32 B sector"}, {"cols": [8, 15], "tone": "global", "label": "32 B sector"},
        {"cols": [16, 23], "tone": "global", "label": "32 B sector"}, {"cols": [24, 31], "tone": "global", "label": "32 B sector"}
      ], "detail": "32 consecutive floats, 128 contiguous bytes: four sectors in one request, every fetched byte used."},
      {"id": "w-b", "array": "b[i … i + 31]", "sub": "128 B", "cols": 32, "marks": [
        {"cols": [0, 7], "tone": "global", "label": "32 B sector"}, {"cols": [8, 15], "tone": "global", "label": "32 B sector"},
        {"cols": [16, 23], "tone": "global", "label": "32 B sector"}, {"cols": [24, 31], "tone": "global", "label": "32 B sector"}
      ]},
      {"id": "w-c", "array": "c[i … i + 31]", "sub": "128 B", "cols": 32, "marks": [
        {"cols": [0, 7], "tone": "global", "label": "32 B sector"}, {"cols": [8, 15], "tone": "global", "label": "32 B sector"},
        {"cols": [16, 23], "tone": "global", "label": "32 B sector"}, {"cols": [24, 31], "tone": "global", "label": "32 B sector"}
      ], "detail": "Four whole sectors written. Then i += 262,144: the next pass is 1 MiB further on, still 32 adjacent floats per warp."}
    ]},
    {"id": "warp", "label": "Warp 0 of block 0", "sub": "threads 0 … 31", "count": "8 warps per block", "layout": "column", "items": [
      {"id": "lanes", "threads": 32, "label": "lane k handles element i + k", "detail": "The 32 lanes issue each load together, so their 32 addresses reach the memory system as one request."},
      {"id": "warp-regs", "label": "Registers", "sub": "one float of each per lane", "tone": "register", "stretch": true, "layout": "column", "items": [
        {"id": "r-a", "array": "a", "cols": 32, "tone": "register", "marks": [
          {"cols": [0, 7], "tone": "register", "label": "lanes 0–7"}, {"cols": [8, 15], "tone": "register", "label": "lanes 8–15"},
          {"cols": [16, 23], "tone": "register", "label": "lanes 16–23"}, {"cols": [24, 31], "tone": "register", "label": "lanes 24–31"}
        ]},
        {"id": "r-b", "array": "b", "cols": 32, "tone": "register", "marks": [
          {"cols": [0, 7], "tone": "register", "label": "lanes 0–7"}, {"cols": [8, 15], "tone": "register", "label": "lanes 8–15"},
          {"cols": [16, 23], "tone": "register", "label": "lanes 16–23"}, {"cols": [24, 31], "tone": "register", "label": "lanes 24–31"}
        ]},
        {"id": "r-c", "array": "a + b", "sub": "one FADD per lane", "cols": 32, "tone": "register", "marks": [
          {"cols": [0, 7], "tone": "register", "label": "lanes 0–7"}, {"cols": [8, 15], "tone": "register", "label": "lanes 8–15"},
          {"cols": [16, 23], "tone": "register", "label": "lanes 16–23"}, {"cols": [24, 31], "tone": "register", "label": "lanes 24–31"}
        ], "detail": "One add per 12 bytes moved: the kernel is bandwidth-bound."}
      ]}
    ]}
  ],
  "arrows": [
    {"from": "w-a", "to": "r-a", "label": "load · 128 B"},
    {"from": "w-b", "to": "r-b", "label": "load · 128 B"},
    {"from": "r-c", "to": "w-c", "label": "store · 128 B"}
  ]
}
:::

The same warp under other access patterns (strided, misaligned, \`float4\`), with the sectors each one
touches:

:::widget coalescing

:::quiz
Q: The grid is 1024 × 256 threads and n = 4,194,341. How many elements does thread 5 handle, and why not thread 100,000?
- [ ] Exactly 16 each — n / 262,144 rounded down
- [x] 17 for thread 5 (indices 5, 262,149, …, 4,194,309), 16 for thread 100,000 — the last partial stride only reaches the first 37 threads
- [ ] 1 each — the extra 3,932,197 elements need a second launch
> 4,194,341 = 16 × 262,144 + 37. Every thread does 16 full strides; threads 0 … 36 get one more because their 17th index is still below n. The loop condition decides per thread, per iteration — no second launch and no padding.
:::

# Errors: where they show up and why every call is checked

Almost every function in the runtime API returns a \`cudaError_t\`, and C++ lets you ignore it. The
[error-checking](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#error-checking) rules
are simple but the consequences of skipping them are not. An unchecked program, call by call:

| Call, unchecked | What it returns | What the program does next |
| --- | --- | --- |
| \`cudaMalloc(&d_c, 16 MiB)\` | \`cudaErrorMemoryAllocation\` | drops it; \`d_c\` stays \`nullptr\` |
| \`cudaMemcpy(d_a, …)\`, \`cudaMemcpy(d_b, …)\` | \`cudaSuccess\` | carries on |
| \`vector_add<<<1024, 256>>>(d_a, d_b, nullptr, n)\` | nothing: a launch has no return value | carries on; the kernel faults at \`c[0]\` on the device, and nobody is listening |
| \`cudaMemcpy(h_c, d_c, …)\` | \`cudaErrorIllegalAddress\` | drops it too |
| the comparison | zeros against the reference | prints \`FAIL\`, three calls from the cause, with no line number |

The macro turns that into one line on \`stderr\` at the \`cudaMalloc\`:

\`\`\`cuda
#define CUDA_CHECK(call)                                                      \\\\
  do {                                                                        \\\\
    cudaError_t err_ = (call);                                                \\\\
    if (err_ != cudaSuccess) {                                                \\\\
      fprintf(stderr, "CUDA error at %s:%d: %s\\\\n", __FILE__, __LINE__,       \\\\
              cudaGetErrorString(err_));                                      \\\\
      exit(EXIT_FAILURE);                                                     \\\\
    }                                                                         \\\\
  } while (0)
\`\`\`

The \`do { } while (0)\` makes the macro one statement so it survives an \`if\` without braces; the
backslashes continue the line. There are two kinds of error, and they surface in different places:

| Error | Example | When it is reported | Where the drill catches it |
| --- | --- | --- | --- |
| **Synchronous** | \`cudaMalloc\` out of memory, \`cudaMemcpy\` with a bad pointer | in that call's return value | \`CUDA_CHECK\` around the call |
| **Launch configuration** | 2048 threads per block, 0 blocks, too much shared memory | the launch has no return value; \`cudaGetLastError()\` right after it | \`CUDA_CHECK(cudaGetLastError())\` in \`launch_vector_add\` |
| **Asynchronous (execution)** | illegal address inside the kernel, an assert | at the **next** call that synchronises or checks: \`cudaDeviceSynchronize\`, a blocking \`cudaMemcpy\`, \`cudaEventSynchronize\` | \`CUDA_CHECK(cudaDeviceSynchronize())\` before the copy back |

- \`cudaGetLastError\` also **resets** the sticky error state, so calling it right after the launch attributes
  the error to this launch and not to whichever call happens to run next.
- An asynchronous error is **sticky**: once the context has faulted every later call returns the same
  error, which is why the drill checks the synchronise and not only the copy — the first checked call
  after the fault is the one that names it.
- \`#call\` in the macro (stringification) prints the expression as well, so the message reads
  \`cudaMalloc(&d_c, bytes)\` and not only a line number.

:::quiz
Q: The kernel is launched with 2048 threads per block. Which line reports it?
- [ ] The launch statement itself returns cudaErrorInvalidConfiguration
- [x] CUDA_CHECK(cudaGetLastError()) immediately after the launch
- [ ] Only cudaDeviceSynchronize, once the kernel has run
> A <<<…>>> launch is a statement with no return value. A configuration the device rejects never starts, and the error is left for cudaGetLastError, which is why the call sits on the line after the launch — before any other call can pick it up and misattribute it.
:::

# The memory round trip and the synchronise

Host and device memory are separate address spaces; nothing in the kernel can see \`std::vector\`. Each
run of \`run_vector_add\` moves the data across and back:

| Step | Call | Bytes | Blocking? |
| --- | --- | --- | --- |
| allocate | \`cudaMalloc(&d_a, bytes)\` × 3 | 3 × 16 MiB | yes; slow (hundreds of µs), which is why frameworks cache allocations |
| copy in | \`cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice)\` × 2 | 2 × 16 MiB over PCIe or NVLink | yes |
| launch | \`vector_add<<<1024, 256>>>\` × 21 | 3 × 16 MiB of HBM traffic each | **no** — returns to the host at once |
| wait | \`cudaDeviceSynchronize()\` | — | yes; also where an execution error surfaces |
| copy out | \`cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost)\` | 16 MiB | yes |
| free | \`cudaFree\` × 3 | — | yes |

- A kernel launch is **asynchronous**: the host thread continues while the GPU works. Reading \`c\` on the
  host without a synchronise would be a bug if the copy were asynchronous too; the plain \`cudaMemcpy\`
  happens to block, but the drill makes the wait explicit so the order — launch, wait, read — is stated
  and checked, and so the kernel's own error has a named place to appear.
- The pointers are typed \`float*\` on both sides, which is the trap: \`d_a\` is not dereferenceable on the
  host and \`h_a\` is not on the device. The \`d_\`/\`h_\` prefixes are the convention that keeps them apart.
- \`bytes\` is computed as \`static_cast<size_t>(n) * sizeof(float)\` — \`n * 4\` in \`int\` overflows at
  537 M elements.
- The copies dominate at this size: 48 MiB over a 25 GB/s PCIe link is about 2 ms, fifty times the kernel.
  That ratio is why a framework keeps tensors resident on the device between operations and why
  \`.cpu()\` in a training loop is a performance bug.

:::quiz
Q: The host reads h_c right after the launch statement, with no cudaMemcpy and no synchronise. What does it see?
- [ ] The sums — the launch returned, so the kernel is done
- [x] Whatever h_c held before: the launch is asynchronous and h_c is host memory the kernel never touches
- [ ] A segmentation fault, because h_c is now owned by the device
> The launch queues work and returns immediately; even once the kernel finishes, its results are in d_c on the device. Only a device-to-host copy after the work is complete brings the sums into h_c — hence synchronise, then cudaMemcpy.
:::

# Timing with events, and what the number means

A wall clock around the launch statement measures a few microseconds of launch overhead, because the
host returns before the GPU starts. [CUDA events](https://developer.nvidia.com/blog/how-implement-performance-metrics-cuda-cc/)
are markers recorded **on the stream**, so the interval between them is the GPU's own time:

\`\`\`cuda
cudaEvent_t start, stop;
CUDA_CHECK(cudaEventCreate(&start));
CUDA_CHECK(cudaEventCreate(&stop));
launch_vector_add(d_a, d_b, d_c, n);            // warm-up: module load, first-launch cost
CUDA_CHECK(cudaDeviceSynchronize());
CUDA_CHECK(cudaEventRecord(start));             // marker before the timed launches
for (int it = 0; it < ITERS; ++it) launch_vector_add(d_a, d_b, d_c, n);
CUDA_CHECK(cudaEventRecord(stop));              // marker after
CUDA_CHECK(cudaEventSynchronize(stop));         // wait for the marker to be reached
float ms = 0.0f;
CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));   // milliseconds, GPU clock
\`\`\`

- The **warm-up** launch matters: the first launch of a kernel loads its module and can cost more than
  the kernel itself. Twenty timed launches average out the launch jitter.
- The result is **ms per launch**; divide the bytes moved by it and you have achieved bandwidth. Vector
  add reads 8 bytes and writes 4 per element and does one addition: 12 bytes per FLOP. No GPU can feed
  that from HBM at its FLOP rate, so the kernel is **bandwidth-bound** and the GB/s line is the honest
  measure of how good it is.

| GPU | HBM bandwidth | 50.3 MB per launch at 80% of peak | FLOP/s used |
| --- | --- | --- | --- |
| laptop RTX 4060 | 272 GB/s | ≈ 0.23 ms | 18 GFLOP/s of 15 TFLOP/s |
| A100 | 1,555 GB/s | ≈ 0.040 ms | 100 GFLOP/s of 19.5 TFLOP/s |
| H100 SXM | 3,350 GB/s | ≈ 0.019 ms | 220 GFLOP/s of 67 TFLOP/s |

Fewer than 1% of the arithmetic units are busy on every row. That is the reason frameworks do not
launch an add on its own when they can avoid it: PyTorch's \`torch.compile\` and Triton **fuse** the
residual add into the LayerNorm or the GELU next to it, so the 16 MiB is read once for both operations
instead of making a round trip to HBM for each. The drill's number is the floor those fusions are measured
against.

:::details The reference comparison and why the error is exactly 0
The CPU computes \`h_ref[i] = h_a[i] + h_b[i]\` in \`float\` and the GPU does the same addition in the same
IEEE-754 single precision with the same round-to-nearest; there is no reassociation, no fused
multiply-add and no accumulation, so the two results are bit-identical and the max abs error prints
\`0.000e+00\`. The \`1e-6\` tolerance exists for the later kernels in the track — a reduction or a softmax
sums in a different order on the GPU and legitimately differs in the last bits. Comparing against a CPU
reference, rather than against another GPU kernel, is the habit: it is the only oracle that cannot share
the kernel's bug.
:::

:::quiz
Q: Timing the kernel with std::chrono around the launch statement reports 0.004 ms; the events report 0.040 ms. Which is the kernel's time?
- [ ] 0.004 ms — the clock is more precise than events
- [x] 0.040 ms — the launch returned before the GPU started; the clock measured the enqueue
- [ ] Neither; only nsys can time a kernel
> A launch is asynchronous. The host clock stops when the launch statement returns, which is before any thread has run. Events are recorded in stream order and resolved on the GPU, so their difference brackets the work itself.
:::

# What to take away

- **The loop covers n, the grid is a knob.** \`start = blockIdx.x * blockDim.x + threadIdx.x\`,
  \`stride = gridDim.x * blockDim.x\`, \`for (i = start; i < n; i += stride)\`: any grid, any \`n\`, nothing
  past the end, coalesced at every step.
- **Blocks from a ceiling division, capped.** \`(n + 255) / 256\` blocks of 256, no more than 1024; the cap
  is a tuning decision the loop makes safe.
- **Check every call where it happens.** \`CUDA_CHECK\` around each runtime call, \`cudaGetLastError\` on the
  line after a launch (the launch has no return value), and a checked \`cudaDeviceSynchronize\` before the
  read-back, because an error inside the kernel waits for the next synchronising call.
- **Launches are asynchronous.** Copy in, launch, wait, copy out — in that order, with the wait explicit;
  time with events on the stream, not with a host clock around the launch.
- **Vector add is bandwidth-bound.** 12 bytes per FLOP; the GB/s line is the measure, and it is why
  frameworks fuse elementwise work into the kernels beside it.

The primary reference is the
[CUDA C++ Programming Guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#thread-hierarchy)
(thread hierarchy, error checking); Mark Harris's
[*CUDA Pro Tip: Write Flexible Kernels with Grid-Stride Loops*](https://developer.nvidia.com/blog/cuda-pro-tip-write-flexible-kernels-grid-stride-loops/)
is the loop's origin, and the
[CUDA C++ Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#using-cuda-gpu-timers)
covers timing with events.
`;
