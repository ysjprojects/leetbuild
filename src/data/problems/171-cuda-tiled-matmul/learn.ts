/**
 * The learning guide for the tiled-matmul drill: arithmetic intensity and why the naive kernel is
 * memory-bound, tiling through shared memory and the 32× reuse it buys, coalesced loads from the
 * `[ty][tx]` index map, the two barriers (and the race the second one prevents), and what cuBLAS adds
 * on top: a figure or a table where one says it faster than prose, a pop quiz per section. Rendered
 * at \`/cuda-tiled-matmul/learn\`.
 */
export const learn = `# The mechanism at a glance

A matrix multiply \`C = A · B\` is the operation a transformer spends almost all of its FLOPs on: the Q, K, V
and output projections, the two MLP matrices, the LM head, and \`Q · Kᵀ\` and \`P · V\` inside attention.
The tiled kernel is the textbook GPU version (the one the CUDA C++ Best Practices Guide walks through in
[Shared Memory in Matrix Multiplication](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#shared-memory-in-matrix-multiplication-c-ab))
and the ancestor of every cuBLAS and CUTLASS kernel. It keeps the naive mapping (one thread, one output
element) and changes only where the operands come from: a block stages slabs of \`A\` and \`B\` in shared
memory and reuses each float 32 times.

The figure puts the two kernels on either side of the same global memory. The naive one feeds its registers
straight from \`A\` and \`B\`; the tiled one stages each slab of \`K\` in shared memory first, where 32 threads read
every float it fetched. Both write \`C\` once per output.

:::gpu
{
  "items": [
    {"id": "naive", "label": "matmul_naive", "sub": "block 32 × 32 · no shared memory", "layout": "column", "items": [
      {"id": "n-acc", "label": "Registers", "sub": "acc, one per thread", "tone": "register", "stretch": true, "detail": "Every multiply-add brings two fresh floats from global memory into registers: 8 bytes for 2 FLOPs."},
      {"threads": 12, "continues": true, "label": "1,024 threads · one output each"}
    ], "detail": "The baseline: one thread, one output, every operand straight from global memory. Caches catch most repeats, but every load still crosses the memory pipeline: it stays memory-bound."},
    {"id": "gmem", "label": "Global memory", "sub": "HBM · off-chip, large, slow", "tone": "global", "layout": "column", "items": [
      {"id": "g-ab", "array": "A, B", "sub": "float32 · read", "cols": 10, "continues": true, "detail": "DRAM: an H100 SXM does 67 TFLOP/s of float32 against 3.35 TB/s, so a kernel needs about 20 FLOPs per byte fetched to be compute-bound."},
      {"id": "g-c", "array": "C", "sub": "written once", "cols": 10, "continues": true, "detail": "One guarded store per output from each kernel."}
    ]},
    {"id": "tiled", "label": "matmul_tiled", "sub": "block 32 × 32 · ⌈K/32⌉ slabs", "layout": "column", "items": [
      {"id": "t-smem", "label": "Shared memory", "sub": "As[32][32] · Bs[32][32] · 8 KB", "tone": "shared", "stretch": true, "detail": "On-chip, per block. Each thread loads one float of A and one of B per slab, coalesced; two barriers fence the slab."},
      {"id": "t-acc", "label": "Registers", "sub": "acc, one per thread", "tone": "register", "stretch": true, "detail": "32 FMAs per slab out of shared memory into a register accumulator."},
      {"threads": 12, "continues": true, "label": "1,024 threads · one output each"}
    ], "detail": "The same mapping, one thread per output; only the operands' source changes."}
  ],
  "arrows": [
    {"from": "g-ab", "to": "n-acc", "label": "2K floats per output"},
    {"from": "g-ab", "to": "t-smem", "label": "2K / 32 per output"},
    {"from": "t-smem", "to": "t-acc", "label": "read 32 times"}
  ]
}
:::

The contract, in one file \`tiled_matmul.cu\`:

- \`__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K)\`: row-major
  float32, \`A[M×K]\`, \`B[K×N]\`, \`C[M×N]\`, \`constexpr int TILE = 32\`.
- Launched with \`dim3 block(TILE, TILE)\` and \`dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE)\`:
  \`x\` along columns, \`y\` along rows; \`row = blockIdx.y * TILE + ty\`, \`col = blockIdx.x * TILE + tx\`.
- \`matmul_naive\` with the same signature, kept as the baseline.
- \`main()\` checks both against a CPU reference on \`97 × 75 × 131\` (max abs error \`< 1e-3\`), times both on
  \`1024³\` with \`cudaEvent\`s, prints GFLOP/s (\`2MNK / s\`) and \`PASS\`.

# Arithmetic intensity: why the naive kernel is memory-bound

A GPU has two budgets: how many FLOPs it can issue per second and how many bytes it can move from DRAM
per second. **Arithmetic intensity** (FLOPs per byte fetched) decides which one a kernel runs into; the
[roofline model](https://en.wikipedia.org/wiki/Roofline_model) draws the line. An H100 SXM does 67 TFLOP/s of
float32 (without tensor cores) against 3.35 TB/s of HBM bandwidth, so a kernel needs about 20 FLOPs per byte
before the arithmetic, not the memory, is the limit.

A GEMM on its own has plenty: \`2MNK\` FLOPs over \`MK + KN + MN\` floats. The naive kernel throws that away.

\`\`\`cuda
// one thread, one output, every operand straight from global memory
float acc = 0.0f;
for (int k = 0; k < K; ++k) acc += A[row * K + k] * B[k * N + col];
C[row * N + col] = acc;
\`\`\`

| Kernel | Global floats per output | FLOPs per output | FLOPs per byte | 1024³ global loads |
| --- | --- | --- | --- | --- |
| Whole GEMM, ideal (each float once) | (MK + KN + MN) / MN = 3 at 1024³ | 2K | ≈ 170 | 12.6 MB |
| \`matmul_naive\` | 2K | 2K | 0.25 | ≈ 8.6 GB requested |
| \`matmul_tiled\`, TILE 32 | 2K / 32 | 2K | 8 | ≈ 270 MB requested |

- In the naive kernel every multiply-add needs two fresh 4-byte loads: 2 FLOPs per 8 bytes. Caches catch
  most of the repeats (a warp's 32 threads read the same float of \`A\`, and neighbouring warps the same
  floats of \`B\`), so DRAM sees far less than 8.6 GB. Every load still goes through the L1/L2 pipeline, and
  that is where the naive kernel runs out of bandwidth.
- The data is reused \`N\` times (each element of \`A\`) and \`M\` times (each element of \`B\`) across the
  whole product. The naive kernel leaves that reuse to the cache; tiling makes it explicit.

Place the kernels on the roofline: the naive GEMM sits far left, under the bandwidth slope; the tiled one moves
right, toward the compute roof.

:::widget roofline

:::quiz
Q: The naive kernel reaches a small fraction of the GPU's peak FLOP/s on 1024³. What is the bottleneck?
- [ ] The 2K multiply-adds per thread: the arithmetic is too long
- [x] Memory bandwidth: every FMA needs two fresh loads, so it does 0.25 FLOP per byte requested
- [ ] Too few threads: one per output is not enough parallelism
> 1024² outputs is over a million threads, and the FLOP count is the same for every kernel. What differs is bytes loaded per FLOP: at 0.25 FLOP/byte the kernel runs out of memory bandwidth (the L1 and L2 that serve most repeats, then DRAM) long before it runs out of arithmetic.
:::

# Tiling: stage once, reuse 32 times

A block of 32 × 32 threads owns a 32 × 32 tile of \`C\`. To produce it, the block needs a 32 × K strip of
\`A\` and a K × 32 strip of \`B\`. It walks \`K\` in slabs of 32: in slab \`t\` it copies the 32 × 32 piece of each
strip into shared memory, then every thread does 32 multiply-adds out of shared memory.

\`\`\`cuda
__shared__ float As[TILE][TILE];
__shared__ float Bs[TILE][TILE];
float acc = 0.0f;
for (int t = 0; t < (K + TILE - 1) / TILE; ++t) {
  int a_col = t * TILE + tx, b_row = t * TILE + ty;
  As[ty][tx] = (row < M && a_col < K) ? A[row * K + a_col] : 0.0f;
  Bs[ty][tx] = (b_row < K && col < N) ? B[b_row * N + col] : 0.0f;
  __syncthreads();
  for (int k = 0; k < TILE; ++k) acc += As[ty][k] * Bs[k][tx];
  __syncthreads();
}
if (row < M && col < N) C[row * N + col] = acc;
\`\`\`

- **Reuse.** Each float loaded into \`As\` is read by the 32 threads of its row; each in \`Bs\` by the 32
  threads of its column. Global loads per output drop from \`2K\` to \`2K / 32\`. The measured gain is far
  smaller than 32×: Boehm's worklog has this kernel at 1.5× the coalesced naive one on an RTX A6000,
  because the naive kernel's loads already hit L1 often.
- **Shared memory** is on-chip, per block, with much higher bandwidth and lower latency than global memory
  when access is free of bank conflicts. Two 32 × 32 float tiles are 8 KB.
- **Occupancy.** 8 KB is not the limit (an SM has 100 to 228 KB); the 1,024-thread block is. An SM holds at
  most 1,536 resident threads on RTX 30/40 GPUs and 2,048 on A100/H100, and its 64 K registers fit two such
  blocks only at ≤ 32 registers per thread (Boehm's build uses 37). So one block runs per SM, and at each
  \`__syncthreads()\` all its warps stall with no other block to switch to.
- **Edges by padding.** \`97 × 75 × 131\` has no dimension divisible by 32: the grid is 3 × 4 = 12 blocks and
  \`K = 131\` takes 5 slabs, the last with 3 valid columns. Out-of-range slots load \`0.0f\`, which adds nothing
  to \`acc\`, so the inner loop needs no branch.
- **One store.** \`acc\` lives in a register for the whole loop; \`C\` is written once, guarded.

| Shape | Grid | Slabs | Valid in last slab |
| --- | --- | --- | --- |
| 97 × 75 × 131 | ⌈75/32⌉ × ⌈97/32⌉ = 3 × 4 | ⌈131/32⌉ = 5 | 3 of 32 columns |
| 1024 × 1024 × 1024 | 32 × 32 | 32 | all 32 |

Pick an output tile and step through its slabs: one tile of \`A\` and one of \`B\` per slab, each float read by
\`TILE\` threads (32 in the drill).

:::widget tiled-matmul

:::quiz
Q: Why does the tiled kernel load zeros past the matrix edges instead of skipping those threads with an early return?
- [ ] Zeros are faster to load than real values
- [x] Every thread must reach both __syncthreads() in every slab; zeros keep it in the loop without changing the sum
- [ ] cudaMemcpy cannot copy matrices whose sizes are not multiples of 32
> Out-of-range threads still load a slot of As and Bs that in-range threads read, and a barrier that part of a block skips is undefined behaviour. Padding with 0.0f keeps the control flow uniform; only the final store is guarded.
:::

# Coalescing: which thread loads which float

Global memory is read by the warp, not by the thread, in 32-byte sectors. When the 32 threads of a warp touch
32 consecutive aligned floats, the hardware serves them with four sectors, 128 bytes, all used; when each
touches an address 32 bytes or more from the others, it takes 32 sectors, 1,024 bytes for 128 useful. See the
[coalescing post](https://developer.nvidia.com/blog/how-access-global-memory-efficiently-cuda-c-kernels/).
The \`[ty][tx]\` map is chosen for exactly this.

| Load | A warp (fixed \`ty\`, \`tx = 0…31\`) reads | Pattern |
| --- | --- | --- |
| \`A[row * K + t * TILE + tx]\` | 32 consecutive floats of one row of A | coalesced |
| \`B[(t * TILE + ty) * N + col]\` | 32 consecutive floats of one row of B | coalesced |
| \`C[row * N + col]\` | 32 consecutive floats of one row of C | coalesced |
| naive with \`x\` along rows | 32 floats \`K\` apart in A | 32 sectors |

:::gpu
{
  "items": [
    {"id": "coal-good", "label": "x along columns", "sub": "col = blockIdx.x * 32 + tx", "layout": "column", "items": [
      {"id": "good-a", "array": "A · row-major", "sub": "a cell = 1 float", "rows": 4, "cols": 12, "continues": true, "marks": [{"cols": [0, 11], "rows": [1, 1], "tone": "shared", "label": "lanes 0 … 31"}], "detail": "Warp \`ty\` reads \`A[row * K + t * 32 + tx]\`: 32 neighbours in one row, 128 bytes in four 32-byte sectors."},
      {"threads": 12, "continues": true, "label": "one warp · 4 sectors"}
    ], "detail": "The drill's map: \`tx\` picks the column, so a warp's load of \`A\`, of \`B\` and its store of \`C\` are each one contiguous run."},
    {"id": "coal-bad", "label": "x along rows", "sub": "row = blockIdx.x * 32 + tx", "layout": "column", "items": [
      {"id": "bad-a", "array": "A · row-major", "sub": "a cell = 1 float", "rows": 4, "cols": 12, "continues": true, "marks": [{"cols": [0, 0], "rows": [0, 3], "tone": "bad", "label": "lanes"}], "detail": "Lane \`tx\` reads \`A[(… + tx) * K + k]\`: 32 floats a whole row (\`4K\` bytes) apart, one 32-byte sector each."},
      {"threads": 12, "continues": true, "label": "one warp · 32 sectors"}
    ], "detail": "Boehm's first kernel: the same arithmetic, 8× the sectors for \`A\` and a strided store of \`C\`; fixing the map alone took it from 309 to 1,987 GFLOP/s."}
  ]
}
:::

- \`x\` along columns is the decision. Swap the roles (\`row\` from \`threadIdx.x\`) and every warp's load of
  \`A\` and store of \`C\` strides by a whole row: Boehm measures this alone as a 6× slowdown.
- **Banks, in brief.** Shared memory is split into 32 banks of 4-byte words; word \`i\` lives in bank
  \`i mod 32\`. A warp's access takes one pass when its lanes hit 32 different banks, or the same word
  (broadcast); \`n\` lanes on different words of one bank take \`n\` passes, an \`n\`-way conflict.
- The shared reads here are conflict-free: \`As[ty][k]\` is one address per warp (a broadcast), \`Bs[k][tx]\`
  spans 32 consecutive banks. Storing \`Bs\` transposed would make the read \`Bs[tx][k]\`, words 32 apart, all
  in one bank: a 32-way conflict.

Set the stride to 1 for \`Bs[k][tx]\` and to 32 for a transposed read, then toggle the padding that removes the
conflict:

:::widget bank-conflicts

:::quiz
Q: In a warp, ty is fixed and tx runs 0…31. Which load of A is coalesced?
- [x] \`As[ty][tx] = A[row * K + t * TILE + tx]\`: consecutive tx, consecutive addresses
- [ ] \`As[tx][ty] = A[(blockIdx.y * TILE + tx) * K + t * TILE + ty]\`: consecutive tx, addresses K apart
- [ ] Both are, because shared memory absorbs the difference
> Coalescing is about the global addresses one warp touches in one instruction. The first form reads 128 contiguous bytes; the second reads 32 floats each a row apart, one transaction apiece. Shared memory is written after the load, so it cannot fix a scattered global read.
:::

# The two barriers

\`__syncthreads()\` stops every thread of the block until all have arrived, and makes their shared-memory
writes visible to each other. The slab loop needs it twice, for two different hazards:

- **After the loads** (read-after-write): no thread may multiply until every thread has written its slot of
  \`As\` and \`Bs\`, otherwise it reads a neighbour's slot from the previous slab, or garbage.
- **After the products** (write-after-read): no thread may start loading slab \`t + 1\` into \`As\`/\`Bs\` until
  every thread has finished reading slab \`t\`.

The first one is obvious; the second is the one that gets dropped, because a 32 × 32 block is 32 warps and
it is easy to picture them moving together. They do not. Follow a fast and a slow warp through one slab with
the second barrier missing:

| Moment | Warp 0 (fast) | Warp 7 (slow) | Row \`Bs[0][·]\` holds |
| --- | --- | --- | --- |
| 1 | stores \`As[0][·]\`, \`Bs[0][·]\` for slab \`t\` | stores \`As[7][·]\`, \`Bs[7][·]\` | slab \`t\` |
| 2 | first \`__syncthreads()\`: slab \`t\` complete | same barrier | slab \`t\` |
| 3 | done: \`acc += As[0][k] · Bs[k][·]\` for \`k = 0…31\` | still at \`k = 0\` | slab \`t\` |
| 4 | no second barrier: stores slab \`t + 1\` into \`Bs[0][·]\` | reads \`Bs[0][·]\` for \`k = 0\` | **slab t + 1** |
| 5 | | adds a wrong product: wrong only sometimes | |

With the second barrier, warp 0 waits after its products until warp 7 has finished slab \`t\`; only then does
anyone overwrite the tiles. The failure is timing-dependent: on one GPU, one size or one run the warps may
happen to stay in step, which is why the self-test compares every element, on the small shape and again on
\`1024³\` (32 slabs of 32 warps) against the naive kernel, not just a checksum.

:::details Why not one barrier and two sets of tiles?
Alternating between two pairs of tiles (load slab \`t + 1\` into buffer B while multiplying buffer A) removes
the write-after-read hazard on the same buffer, so one barrier per slab suffices. That is **double
buffering**, and production kernels do it with asynchronous copies (\`cp.async\`, TMA) so the next load
overlaps the current arithmetic. It costs twice the shared memory; the drill keeps one pair and two barriers.
:::

:::quiz
Q: A kernel with only the first __syncthreads() passes on 64 × 64 × 64 and fails intermittently on 1024³. Why?
- [ ] 1024³ overflows the float accumulator
- [x] Without the second barrier a fast warp loads the next slab over tiles a slow warp is still reading; more slabs and more warps make the race more likely
- [ ] The first barrier is only valid for square tiles
> The missing barrier is a write-after-read race. Whether it bites depends on warp scheduling, so small runs can pass by luck; 32 slabs of 32 warps give it many more chances. A correctness test has to compare every element, on sizes that exercise many slabs.
:::

# What cuBLAS adds

The tiled kernel cuts global loads 32×, but every FMA still reads two floats from shared memory: its
intensity against shared memory is still 0.25 FLOP per byte. Simon Boehm's
[How to Optimize a CUDA Matmul Kernel](https://siboehm.com/articles/22/CUDA-MMM) walks the steps from here to
near-cuBLAS, each built on the same slab loop and barriers:

| Technique | What changes | What it buys |
| --- | --- | --- |
| Register blocking | each thread computes a 4 × 4 to 8 × 8 micro-tile of C | one shared load feeds 4–8 FMAs |
| Larger block and warp tiles | 128 × 128 block tiles split among warps | more reuse per slab, fewer blocks |
| Double buffering | \`cp.async\` / TMA load slab t + 1 while slab t is multiplied | hides global latency |
| Swizzled shared layouts | XOR-permuted tile addresses | no bank conflicts for transposed reads |
| Tensor cores | \`mma.sync\` / \`wmma\` on half or tf32 fragments | an order of magnitude more FLOP/s |
| Split-K | several blocks share one C tile, reduce at the end | parallelism for thin shapes |

- \`torch.matmul\` reaches these kernels through cuBLAS by default (\`torch.backends.cuda.preferred_blas_library\`
  can switch it to cuBLASLt); Triton's \`tl.dot\` generates the same block structure from a few lines of Python.
- FlashAttention is this idea applied to attention: \`Q · Kᵀ\` and \`P · V\` are tiled through shared memory so
  the \`N × N\` score matrix never reaches global memory.

:::quiz
Q: After tiling, what is the next limit the tiled kernel runs into, and which technique addresses it?
- [ ] Global bandwidth again: fix with a larger TILE of 64 × 64 threads
- [x] Shared-memory bandwidth: each FMA still reads two floats from shared memory; register blocking reuses each in several FMAs
- [ ] Barrier cost: remove both __syncthreads()
> A block cannot have 64 × 64 = 4096 threads, and the barriers are needed for correctness. The inner loop does one FMA per two shared loads; computing a micro-tile per thread keeps values in registers and multiplies the FLOPs per shared load.
:::

# What to take away

- Arithmetic intensity, not FLOP count, decides a kernel's speed: the naive GEMM does 0.25 FLOP per byte and
  is a memory benchmark.
- Tiling makes reuse explicit: a block stages a 32 × 32 slab of \`A\` and \`B\` in shared memory and each float
  is used 32 times, cutting global loads from \`2K\` to \`2K / 32\` per output.
- The \`[ty][tx]\` map with \`x\` along columns makes every global load and store coalesced and the shared reads
  conflict-free.
- Two barriers per slab: one before reading (the slab is complete), one before overwriting (everyone is done);
  edges are zero-padded so every thread reaches both.
- cuBLAS adds register blocking, double buffering and tensor cores on top of exactly this loop.

Primary reference: the CUDA C++ Best Practices Guide,
[Shared Memory in Matrix Multiplication](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#shared-memory-in-matrix-multiplication-c-ab).
`;
