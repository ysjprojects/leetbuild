/**
 * The learning guide for the WMMA matmul drill: tensor cores and the 16 × 16 × 16 fragment, fp16
 * inputs with fp32 accumulation and the error that leaves, the warp-per-tile mapping with leading
 * dimensions and layouts, shared-memory staging and the reuse it buys, and what CUTLASS, cuBLAS,
 * PTX mma.sync and Hopper's WGMMA add, with a figure or a table where one says it faster than prose and a
 * pop quiz per section. Rendered at \`/cuda-wmma-matmul/learn\`.
 */
export const learn = `# The mechanism at a glance

A **tensor core** is a unit inside each streaming multiprocessor that computes a small matrix
multiply-accumulate \`D = A·B + C\`, with A and B in half precision (here fp16) and C, D in fp32 or fp16.
CUDA C++ exposes it through the *warp matrix functions* of \`nvcuda::wmma\` (\`#include <mma.h>\`),
introduced with Volta in CUDA 9: a warp of 32 threads loads a 16 × 16 tile of A and one of B into
**fragments**, issues \`mma_sync\`, and stores a 16 × 16 tile of C. Every linear layer of a transformer
ends up on these units, through cuBLAS kernels built on the same hardware MMA instructions.

The figure follows the operands down the memory hierarchy: from global memory, either straight or through a
shared-memory block tile, into each warp's fragments in registers, where the tensor cores compute
\`acc = a @ b + acc\`; one store writes the warp's tile of C.

:::gpu
{
  "items": [
    {"id": "gmem", "label": "Global memory", "sub": "HBM · padded to multiples of 16", "tone": "global", "layout": "column", "align": "start", "items": [
      {"id": "g-ab", "array": "A, B", "sub": "half · row-major", "cols": 10, "continues": true, "detail": "The host rounds M, N, K up to multiples of 16 and copies the inputs into zeroed buffers with cudaMemcpy2D, so every fragment pointer is 32-byte aligned and every ldm a multiple of 8 halves."},
      {"id": "g-c", "array": "C", "sub": "float · M × N corner to host", "cols": 10, "continues": true, "detail": "Checked against an fp32 CPU reference over the same rounded inputs: max |C − ref| ≤ 2e-5 × K."}
    ]},
    {"id": "block", "label": "Thread block", "sub": "128 threads", "count": "4 warps", "layout": "column", "items": [
      {"id": "smem", "label": "Shared memory", "sub": "As, Bs block tile · staged kernel only", "tone": "shared", "stretch": true, "detail": "Only in wmma_matmul_smem: a 64 × 64 block tile filled once per K-step and read by all four warps. The direct kernel loads fragments straight from global memory."},
      {"id": "warp", "label": "Warp", "sub": "one 16 × 16 tile of C per warp", "count": "× 4", "layout": "column", "items": [
        {"threads": 16, "continues": true, "label": "32 lanes, every call together"},
        {"id": "tc", "label": "Tensor cores", "sub": "mma_sync · m16n16k16 · K/16 times", "tone": "compute", "items": [
          {"id": "f-d", "array": "acc", "sub": "float", "tone": "register", "rows": 4, "cols": 4, "detail": "fragment<accumulator, 16, 16, 16, float>: the sum stays in fp32 registers across all of K."},
          {"gap": "="},
          {"id": "f-a", "array": "a", "sub": "half", "tone": "register", "rows": 4, "cols": 4, "detail": "fragment<matrix_a, 16, 16, 16, half, row_major>: spread over the 32 lanes' registers in an opaque layout."},
          {"gap": "@"},
          {"id": "f-b", "array": "b", "sub": "half", "tone": "register", "rows": 4, "cols": 4, "detail": "fragment<matrix_b, 16, 16, 16, half, row_major>."},
          {"gap": "+"},
          {"id": "f-c", "array": "acc", "sub": "float", "tone": "register", "rows": 4, "cols": 4, "detail": "The same accumulator fragment, zeroed once by fill_fragment."}
        ], "detail": "One warp-collective mma_sync: 16 · 16 · 16 = 4,096 multiply-adds."}
      ]}
    ]}
  ],
  "arrows": [
    {"from": "g-ab", "to": "smem", "label": "fill (staged)"},
    {"from": "g-ab", "to": "warp", "label": "load_matrix_sync"},
    {"from": "smem", "to": "warp"},
    {"from": "warp", "to": "g-c", "label": "store_matrix_sync"}
  ]
}
:::

The contract, in \`wmma_matmul.cu\`: A (\`M × K\`) and B (\`K × N\`) are row-major \`half\`, C is \`float\`.
\`wmma_matmul\` gives each warp one 16 × 16 tile of C and loads fragments from global memory;
\`wmma_matmul_smem\` stages 64 × 64 block tiles through shared memory; the host pads every dimension with
\`pad16(x) = (x + 15) / 16 * 16\` and checks against an fp32 CPU reference with tolerance \`2e-5 × K\`.

# Tensor cores and the 16 × 16 × 16 fragment

One \`mma_sync\` on the m16n16k16 shape is 16 · 16 · 16 = 4,096 multiply-adds for the warp. The ordinary fp32
pipeline does one fused multiply-add per thread per instruction (32 per warp), so the same work takes 128
warp instructions there. A tensor core spends several cycles on each \`mma_sync\`, so the gain is not 128×:
it is the ratio of the two peaks, 8× on V100, 16× on A100 and 15× on H100.

| GPU | Tensor-core generation | Dense fp16 → fp32 | Plain fp32 (CUDA cores) |
| --- | --- | --- | --- |
| V100 (sm_70) | 1st, 8 per SM | 125 TFLOP/s | 15.7 TFLOP/s |
| A100 (sm_80) | 3rd, 4 per SM, + bf16, tf32 | 312 TFLOP/s | 19.5 TFLOP/s |
| H100 SXM (sm_90) | 4th, + fp8, \`wgmma\` | ≈ 990 TFLOP/s | 67 TFLOP/s |

On the roofline the tensor-core roof sits an order of magnitude above the fp32 one, and a kernel only reaches
it with enough FLOP per byte; compare the tiled fp32 matmul with the tensor-core GEMM:

:::widget roofline

The WMMA API in four types and four calls:

\`\`\`cuda
wmma::fragment<wmma::matrix_a,    16, 16, 16, half, wmma::row_major> a;   // 16 × 16 of A
wmma::fragment<wmma::matrix_b,    16, 16, 16, half, wmma::row_major> b;   // 16 × 16 of B
wmma::fragment<wmma::accumulator, 16, 16, 16, float>                 acc; // 16 × 16 of C
wmma::fill_fragment(acc, 0.0f);
wmma::load_matrix_sync(a, ptr_a, lda);          // ptr = tile's top-left element
wmma::load_matrix_sync(b, ptr_b, ldb);
wmma::mma_sync(acc, a, b, acc);                 // acc = a · b + acc
wmma::store_matrix_sync(ptr_c, acc, ldc, wmma::mem_row_major);
\`\`\`

- A fragment is **opaque**: its elements are spread over the 32 lanes' registers (\`x.num_elements\` per
  lane) in a layout the documentation does not specify and that differs between architectures.
  You may load, store, fill, and multiply it; indexing \`x[i]\` is allowed only for elementwise ops that do
  not care which element is which.
- The template parameters fix the shape (\`m16n16k16\`; \`m32n8k16\` and \`m8n32k16\` also exist for fp16), the
  element type and, for \`matrix_a\`/\`matrix_b\`, the memory layout the load expects. The accumulator has no
  layout of its own; the store names one.

:::quiz
Q: Why does a 1024³ fp16 matmul on WMMA run several times faster than the same matmul in a tiled fp32 kernel on the same GPU, with the same number of multiply-adds?
- [ ] fp16 values are half the size, so the kernel moves half the bytes and that is the whole gain
- [x] The tensor cores do a warp's 4,096 multiply-adds per mma_sync at a peak 8 to 16 times that of the fp32 FMA pipeline, so the arithmetic ceiling is roughly an order of magnitude higher
- [ ] Tensor cores skip the multiplications whose inputs round to zero in fp16
> Halving the bytes helps a bandwidth-bound kernel, but a well-tiled matmul is compute-bound. The tensor core raises the compute ceiling: 312 against 19.5 TFLOP/s on an A100. What is left is keeping it fed, which is the rest of this guide.
:::

# fp16 in, fp32 accumulate, and the error that leaves

The inputs are fp16 (1 sign, 5 exponent, 10 stored mantissa bits: 11 significant bits, max 65,504). The
product of two fp16 numbers has at most 22 significant bits, so it is **exact in fp32** (24 bits). All of
the error in a WMMA matmul with an fp32 accumulator therefore comes from two places:

| Source | Size | In the drill |
| --- | --- | --- |
| Rounding the inputs to fp16 | relative 2⁻¹¹ ≈ 4.9e-4 per element | part of the input: \`__float2half\` before upload, the CPU reference uses the same rounded values via \`__half2float\` |
| Products | exact | none |
| Summing K products in fp32 | about √K · 2⁻²⁴ · ‖C‖ typical, K · 2⁻²⁴ · Σ‖a·b‖ worst | the only difference left between GPU and CPU: the order and rounding of the sum |
| Summing K products in fp16 | the same with 2⁻¹¹: 8,192 × larger | avoided: the accumulator fragment is \`float\` |

"Rounding of the sum" is not a formality: tensor cores do not add in IEEE round-to-nearest.
[Fasi et al.](https://peerj.com/articles/cs-330/) measured V100, T4 and A100 and found exact products but
additions that truncate, with no guard digits. Truncation is biased, so the typical error drifts closer to
K than √K; it still stays far below the tolerance (the table below).

At K = 512 the entries of C here have an RMS of about 7.5 (inputs uniform in [-1, 1): √(512 / 9) ≈ 7.5),
where an fp16 ulp is 2⁻⁸ ≈ 0.004 and an fp32 ulp 2⁻²¹ ≈ 5e-7: \`2e-5 × K\` (1e-2) is generous for fp32
accumulation noise and out of reach for fp16.

The two accumulator types side by side at 256 × 384 × 512, simulated on the CPU over the drill's own inputs
(every add rounded to the accumulator type):

| Accumulator fragment | ulp at 7.5 | max abs error against the fp32 reference | Check at \`2e-5 × K\` |
| --- | --- | --- | --- |
| \`fragment<accumulator, 16, 16, 16, half>\` | 2⁻⁸ ≈ 0.004 | 0.24 | FAIL |
| \`fragment<accumulator, 16, 16, 16, float>\` | 2⁻²¹ ≈ 5e-7 | 3e-5 (7e-5 with truncating adds) | ok |

Slide a value through fp32 and fp16 to see the 11 significant bits and the 65,504 ceiling for yourself:

:::widget float-formats

This is the split [mixed-precision training](https://arxiv.org/abs/1710.03740) relies on: multiply in half
precision, accumulate in fp32.

:::quiz
Q: Why is the drill's CPU reference fed __half2float of the fp16 inputs rather than the fp32 values they came from?
- [ ] Because the CPU cannot multiply fp32 values fast enough at 1024³
- [x] So that both sides see exactly the same inputs and the only difference left is fp32 accumulation order, which a tight K-proportional tolerance can bound
- [ ] Because tensor cores convert their inputs back to fp32 before multiplying
> Input rounding is a property of the data type, not of the kernel. Removing it from the comparison isolates what the kernel controls; the products are exact in fp32, so what remains is summation order, which grows with K.
:::

# One warp per tile, leading dimensions and layouts

Every WMMA call is **warp-collective**: all 32 lanes must execute it together with the same arguments.
The unit of work is therefore a warp, not a thread. In the direct kernel a 128-thread block holds 4 warps,
each owning one 16 × 16 tile of C along a row of tiles: \`warpId = threadIdx.x / warpSize\`,
\`tileRow = blockIdx.y\`, \`tileCol = blockIdx.x * 4 + warpId\`. A warp whose tile lies past \`N\` returns as
a whole; a lane-dependent \`if\` around \`mma_sync\` is undefined behaviour.

A load takes the tile's **top-left element** and the **leading dimension** \`ldm\`: the distance in elements
between the starts of consecutive rows (for \`row_major\`) of the matrix the tile sits in, not the tile
width.

| Operand | Pointer | ldm | Layout |
| --- | --- | --- | --- |
| A tile (row-major M × K) | \`A + tileRow·16·K + k\` | \`K\` | \`wmma::row_major\` |
| B tile (row-major K × N) | \`B + k·N + tileCol·16\` | \`N\` | \`wmma::row_major\` |
| C tile (row-major M × N) | \`C + tileRow·16·N + tileCol·16\` | \`N\` | \`wmma::mem_row_major\` at the store |

The failure is silent: a wrong \`ldm\` still loads 256 valid elements, just the wrong ones. With \`A\` row-major
and \`K = 512\`:

| Load | Fragment row \`r\` holds | Outcome |
| --- | --- | --- |
| \`load_matrix_sync(a, A + k, 16)\`: \`ldm\` = tile width | row 1 = \`A[0][k+16 … k+31]\`, not \`A[1][k … k+15]\` | \`mma_sync\` on a scrambled tile: no fault, no warning |
| \`load_matrix_sync(a, A + tileRow·16·K + k, K)\` | \`A[tileRow·16 + r][k … k+15]\` | within tolerance |

The loads also have hard **alignment** rules: the pointer must be 256-bit (32-byte) aligned and \`ldm\` a
multiple of 8 for \`half\` and 4 for \`float\` (16 bytes either way). There is no bounds check and no slow
unaligned path, only undefined results. Hence the host: \`pad16\` rounds M, N, K up to multiples of 16,
\`cudaMemcpy2D\` copies the real rows into zeroed padded buffers, and the zero rows and columns contribute
nothing to the products. A 250 × 375 × 500 multiply runs as 256 × 384 × 512 and the host copies back the
250 × 375 corner. The drill's test uses non-square shapes on purpose: with M = N = K, swapping \`K\` and \`N\`
as \`ldm\` would go unnoticed.

:::quiz
Q: In the direct kernel, B is row-major K × N and the warp needs the tile at rows k … k+15, columns tileCol·16 … +15. Which load is right?
- [ ] load_matrix_sync(b, B + tileCol * 16 * K + k, K) with matrix_b row_major
- [x] load_matrix_sync(b, B + k * N + tileCol * 16, N) with matrix_b row_major
- [ ] load_matrix_sync(b, B + k * N + tileCol * 16, 16) with matrix_b col_major
> The pointer is the tile's top-left element, row k column tileCol·16, at offset k·N + tileCol·16 in a row-major K × N array; consecutive rows are N elements apart, so ldm = N. The first option addresses a transposed B; the third reads the tile with the wrong stride and the wrong layout.
:::

# Shared-memory staging and reuse

The direct kernel loads a 16 × 16 tile of A and of B (1 KiB) from global memory for every 4,096
multiply-adds, and the four warps of a block load the **same** A tile four times. A tensor core consumes
operands far faster than DRAM delivers them (an A100 40 GB needs 312 TFLOP/s ÷ 1.55 TB/s ≈ 200 FLOP per byte from HBM),
so the direct kernel leans on the L1 and L2 caches and is load-bound. Staging fixes the ratio by loading a
larger tile once per block and letting every warp reuse it:

| Kernel | Bytes loaded per K-step | FLOP per K-step | FLOP per byte from global |
| --- | --- | --- | --- |
| Direct, per warp | 16×16 + 16×16 halves = 1 KiB | 2 · 16³ = 8,192 | 8 |
| Staged, per block (64 × 64, BK = 32) | 64×32 + 32×64 halves = 8 KiB | 2 · 64 · 64 · 32 = 262,144 | 32 |
| CUTLASS-style 128 × 128, BK = 32 | 16 KiB | 1,048,576 | 64 |

Step through the K slabs of one block tile to see the reuse: every staged element feeds a whole row or column
of output tiles instead of one.

:::widget tiled-matmul

The staged loop has two barriers, and each prevents a different race. Read the figure left to right, one
K-step of the loop:

:::gpu
{
  "items": [
    {"id": "kstep", "label": "for (k0 = 0; k0 < K; k0 += 32)", "sub": "8 KiB per step feeds 262,144 FLOP", "count": "K/32 steps", "items": [
      {"id": "fill", "label": "Fill", "sub": "128 threads · 0 past M, N, K", "layout": "column", "items": [
        {"threads": 12, "continues": true, "label": "16 halves of each tile per thread"},
        {"label": "As[64][40] · Bs[32][72]", "sub": "being written", "tone": "shared", "stretch": true}
      ], "detail": "The 128 threads copy the 64 × 32 slab of A and the 32 × 64 slab of B cooperatively; rows past M or K and columns past N are zero-filled."},
      {"id": "sync1", "label": "__syncthreads()", "sub": "read after write", "detail": "No warp loads a fragment from a half-written tile."},
      {"id": "mma4", "label": "Multiply", "sub": "kk = 0, 16", "layout": "column", "items": [
        {"label": "As, Bs", "sub": "read only", "tone": "shared", "stretch": true},
        {"label": "2 × 2 warps", "sub": "each: 2 a, 2 b, 4 mma_sync", "items": [
          {"label": "Warp 0", "layout": "column", "items": [{"threads": 6, "continues": true, "label": "done"}]},
          {"gap": "…"},
          {"label": "Warp 3", "layout": "column", "items": [{"threads": 6, "continues": true, "label": "still loading"}]}
        ]},
        {"label": "acc[2][2]", "sub": "+= a[i] · b[j] · per warp", "tone": "register", "stretch": true}
      ], "detail": "For kk = 0 and 16: a fragments from &As[warpRow·32 + i·16][kk] with ldm 40, b fragments from &Bs[kk][warpCol·32 + j·16] with ldm 72, four mma_sync into the 2 × 2 accumulators."},
      {"id": "sync2", "label": "__syncthreads()", "sub": "write after read", "detail": "Nobody refills As and Bs for the next k0 while a slower warp still loads fragments from them."}
    ]},
    {"id": "store", "label": "After the loop", "sub": "each tile inside M × N", "layout": "column", "items": [
      {"label": "acc[2][2]", "sub": "per warp", "tone": "register", "stretch": true},
      {"label": "C", "sub": "store_matrix_sync × 4", "tone": "global", "stretch": true}
    ], "detail": "Four stores per warp with ldm = N and mem_row_major; M and N are multiples of 16, so a tile is wholly inside C or wholly outside."}
  ]
}
:::

- **Skew.** \`As[64][32 + 8]\` and \`Bs[32][64 + 8]\`: the 8 extra halves keep every row start a multiple of 16
  bytes (so \`ldm\` = 40 and 72 stay legal and \`&As[16·i][kk]\` stays 32-byte aligned) and shift consecutive
  rows across the 32 four-byte banks, so the rows a fragment load touches do not all start on the same
  bank. Without it, a 64-byte row stride puts every second row on the same banks.

:::quiz
Q: The staged kernel's second __syncthreads() (after the mma_sync loop) is removed. What happens?
- [ ] Nothing: the first barrier already orders the fill before the reads
- [x] A warp that finishes early can overwrite As/Bs with the next K-slice while another warp still loads fragments from the current one, so results become timing-dependent
- [ ] The kernel deadlocks because the barrier counts no longer match
> The first barrier orders this step's fill before this step's reads. Nothing orders this step's reads before the next step's fill except the second barrier; without it the race is real, intermittent, and invisible on small inputs.
:::

# What cuBLAS, CUTLASS and mma.sync / WGMMA add

The drill's structure (block tile in shared memory, warp tile in fragments, a K loop of \`mma_sync\`, one
store) is the skeleton of every production GEMM. [CUTLASS](https://github.com/NVIDIA/cutlass) makes that
hierarchy explicit as templates (threadblock tile → warp tile → instruction), and cuBLAS ships tuned
kernels of the same shape. What they add:

| Layer | The drill | Production |
| --- | --- | --- |
| Instruction | \`wmma::mma_sync\` 16×16×16, opaque fragments | PTX \`mma.sync.aligned.m16n8k16\` with a documented register layout; \`ldmatrix\` loads fragments from shared memory |
| Global → shared | each thread copies 2-byte \`half\`s through registers | \`cp.async\` 16-byte copies (sm_80) or TMA bulk tensor copies (sm_90), bypassing registers |
| Pipelining | load, barrier, compute, barrier | 3–5 stage ring of shared buffers: tile k+2 loads while tile k multiplies |
| Shared layout | 8-half skew | XOR swizzle: conflict-free with no wasted bytes |
| Tile shape | 64 × 64, 4 warps | 128 × 128 or 128 × 256, 8 warps, chosen per problem shape by a heuristic |
| Epilogue | store fp32 C | fused bias, GELU, residual, cast to bf16; split-K for skinny shapes |

On Hopper the instruction itself changes. [wgmma.mma_async](https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#asynchronous-warpgroup-level-matrix-instructions)
is issued by a **warpgroup** of 4 warps (128 threads), covers 64 × N × 16 per instruction with N up to 256,
reads B (and optionally A) directly from shared memory through a descriptor, and runs asynchronously so the
warps can issue the next TMA load while it computes. WMMA on sm_90 still works but compiles to the older
synchronous path and leaves a large share of the H100's tensor throughput unused. That is why FlashAttention-3
and current cuBLAS kernels are written against \`wgmma\` and TMA.

:::quiz
Q: A kernel that is correct with WMMA on an A100 is moved to an H100 and gains far less than the H100's tensor-core spec sheet suggests. What is the main reason?
- [ ] WMMA does not compile for sm_90
- [x] WMMA maps to synchronous warp-level mma, while Hopper's peak needs warpgroup-level asynchronous wgmma fed by TMA
- [ ] H100 tensor cores do not support fp16 inputs
> WMMA still runs on Hopper, but its fastest instructions are wgmma: issued per 4-warp warpgroup, reading operands from shared memory, overlapping with TMA loads. Reaching them takes PTX, CUTLASS 3 / CuTe, or cuBLAS.
:::

# What to take away

- **Tensor cores multiply tiles, not scalars.** One \`mma_sync\` is 4,096 multiply-adds on a 16 × 16 × 16
  shape; the tensor-core peak is 8× to 16× the fp32 CUDA cores' on data-center GPUs.
- **fp16 in, fp32 accumulate.** fp16 products are exact in fp32; with a \`float\` accumulator the only error
  left is the order and rounding of the sum, bounded by a tolerance that grows with K. An fp16 accumulator
  would not pass.
- **A warp owns a tile.** Fragments are opaque and every WMMA call is warp-collective; the tile index comes
  from \`threadIdx.x / warpSize\`, never from the lane.
- **Pointer, ldm, layout.** The pointer is the tile's top-left element and 32-byte aligned, \`ldm\` the row
  length of the matrix it sits in and a multiple of 16 bytes; the host pads to multiples of 16 so both hold.
- **Feeding the tensor core is the hard part.** Shared-memory staging with two barriers raises the reuse
  per byte; cuBLAS and CUTLASS add \`cp.async\`/TMA pipelines, swizzles, bigger tiles, and on Hopper \`wgmma\`.

The primary reference is the CUDA C++ Programming Guide's
[warp matrix functions](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/cpp-language-extensions.html#warp-matrix-functions);
NVIDIA's [*Programming Tensor Cores in CUDA 9*](https://developer.nvidia.com/blog/programming-tensor-cores-cuda-9/)
introduced the API with the same one-warp-per-tile example.
`;
