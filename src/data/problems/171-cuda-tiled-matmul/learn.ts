/**
 * The learning guide for the tiled-matmul drill: arithmetic intensity and why the naive kernel is
 * memory-bound, tiling through shared memory and the 32× reuse it buys, coalesced loads from the
 * `[ty][tx]` index map, the two barriers (and the race the second one prevents), and what cuBLAS adds
 * on top — a figure or a table where one says it faster than prose, a pop quiz per section. Rendered
 * at \`/cuda-tiled-matmul/learn\`.
 */
export const learn = `# The mechanism at a glance

A matrix multiply \`C = A · B\` is the operation a transformer spends almost all of its FLOPs on: the Q, K, V
and output projections, the two MLP matrices, the LM head, and \`Q · Kᵀ\` and \`P · V\` inside attention.
The tiled kernel is the textbook GPU version — the one in the CUDA Programming Guide's
[shared-memory section](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#shared-memory) —
and the ancestor of every cuBLAS and CUTLASS kernel. It keeps the naive mapping (one thread, one output
element) and changes only where the operands come from: a block stages slabs of \`A\` and \`B\` in shared
memory and reuses each float 32 times.

:::diagram
{
  "nodes": [
    {"id": "host", "kind": "client", "label": "host", "sub": "main() · CPU reference · cudaEvent timing · PASS", "x": 8, "y": 50},
    {"id": "gmem", "kind": "db", "label": "global memory", "sub": "A[M×K] · B[K×N] · C[M×N] · slow, large", "x": 40, "y": 20},
    {"id": "tiled", "kind": "service", "label": "matmul_tiled", "sub": "one 32 × 32 block per 32 × 32 tile of C", "x": 40, "y": 60},
    {"id": "smem", "kind": "db", "label": "shared memory", "sub": "As[32][32] · Bs[32][32] · 8 KB · on-chip, per block", "x": 72, "y": 60},
    {"id": "naive", "kind": "external", "label": "matmul_naive", "sub": "baseline · 2K global loads per output", "x": 72, "y": 20}
  ],
  "edges": [
    {"from": "host", "to": "gmem", "kind": "plain", "label": "cudaMemcpy H2D · D2H"},
    {"from": "host", "to": "tiled", "kind": "plain", "label": "<<<grid, block>>>"},
    {"from": "tiled", "to": "gmem", "kind": "plain", "label": "1 coalesced load of A and B per thread per slab · 1 store"},
    {"from": "tiled", "to": "smem", "kind": "plain", "label": "load · __syncthreads · 32 FMAs · __syncthreads"},
    {"from": "host", "to": "naive", "kind": "plain", "label": "same grid · timed for comparison"},
    {"from": "naive", "to": "gmem", "kind": "plain", "label": "A and B re-read per output"}
  ]
}
:::

The contract, in one file \`tiled_matmul.cu\`:

- \`__global__ void matmul_tiled(const float* A, const float* B, float* C, int M, int N, int K)\` — row-major
  float32, \`A[M×K]\`, \`B[K×N]\`, \`C[M×N]\`, \`constexpr int TILE = 32\`.
- Launched with \`dim3 block(TILE, TILE)\` and \`dim3 grid((N + TILE - 1) / TILE, (M + TILE - 1) / TILE)\`:
  \`x\` along columns, \`y\` along rows; \`row = blockIdx.y * TILE + ty\`, \`col = blockIdx.x * TILE + tx\`.
- \`matmul_naive\` with the same signature, kept as the baseline.
- \`main()\` checks both against a CPU reference on \`97 × 75 × 131\` (max abs error \`< 1e-3\`), times both on
  \`1024³\` with \`cudaEvent\`s, prints GFLOP/s (\`2MNK / s\`) and \`PASS\`.

# Arithmetic intensity: why the naive kernel is memory-bound

A GPU has two budgets: how many FLOPs it can issue per second and how many bytes it can move from DRAM
per second. **Arithmetic intensity** — FLOPs per byte fetched — decides which one a kernel runs into; the
[roofline model](https://en.wikipedia.org/wiki/Roofline_model) draws the line. A modern data-centre GPU does
tens of TFLOP/s of float32 against 2–3 TB/s of bandwidth, so a kernel needs roughly 10 or more FLOPs per byte
before the arithmetic, not the memory, is the limit.

A GEMM on its own has plenty: \`2MNK\` FLOPs over \`MK + KN + MN\` floats. The naive kernel throws that away.

\`\`\`cuda
// one thread, one output, every operand straight from global memory
float acc = 0.0f;
for (int k = 0; k < K; ++k) acc += A[row * K + k] * B[k * N + col];
C[row * N + col] = acc;
\`\`\`

| Kernel | Global floats per output | FLOPs per output | FLOPs per byte | 1024³ global traffic |
| --- | --- | --- | --- | --- |
| Whole GEMM, ideal (each float once) | (MK + KN + MN) / MN = 3 at 1024³ | 2K | ≈ 170 | 12 MB |
| \`matmul_naive\` | 2K | 2K | 0.25 | ≈ 8.6 GB requested |
| \`matmul_tiled\`, TILE 32 | 2K / 32 | 2K | 8 | ≈ 270 MB |

- In the naive kernel every multiply-add needs two fresh 4-byte loads: 2 FLOPs per 8 bytes. Caches catch
  some of the repeats (neighbouring threads read the same row of \`A\`), which is why it is not even slower,
  but it stays a memory benchmark.
- The data is reused \`N\` times (each element of \`A\`) and \`M\` times (each element of \`B\`) across the
  whole product. The naive kernel leaves that reuse to the cache; tiling makes it explicit.

:::quiz
Q: The naive kernel reaches a small fraction of the GPU's peak FLOP/s on 1024³. What is the bottleneck?
- [ ] The 2K multiply-adds per thread — the arithmetic is too long
- [x] Global memory bandwidth — every FMA needs two fresh loads, so it does 0.25 FLOP per byte
- [ ] Too few threads — one per output is not enough parallelism
> 1024² outputs is over a million threads, and the FLOP count is the same for every kernel. What differs is bytes fetched per FLOP: at 0.25 FLOP/byte the kernel runs out of DRAM bandwidth long before it runs out of arithmetic.
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
  threads of its column. Global traffic per output drops from \`2K\` to \`2K / 32\`: the whole speedup.
- **Shared memory** is on-chip, per block, roughly register-speed when access is conflict-free. Two
  32 × 32 float tiles are 8 KB, small enough for several blocks per SM.
- **Edges by padding.** \`97 × 75 × 131\` has no dimension divisible by 32: the grid is 3 × 4 = 12 blocks and
  \`K = 131\` takes 5 slabs, the last with 3 valid columns. Out-of-range slots load \`0.0f\`, which adds nothing
  to \`acc\`, so the inner loop needs no branch.
- **One store.** \`acc\` lives in a register for the whole loop; \`C\` is written once, guarded.

| Shape | Grid | Slabs | Valid in last slab |
| --- | --- | --- | --- |
| 97 × 75 × 131 | ⌈75/32⌉ × ⌈97/32⌉ = 3 × 4 | ⌈131/32⌉ = 5 | 3 of 32 columns |
| 1024 × 1024 × 1024 | 32 × 32 | 32 | all 32 |

:::quiz
Q: Why does the tiled kernel load zeros past the matrix edges instead of skipping those threads with an early return?
- [ ] Zeros are faster to load than real values
- [x] Every thread must reach both __syncthreads() in every slab; zeros keep it in the loop without changing the sum
- [ ] cudaMemcpy cannot copy matrices whose sizes are not multiples of 32
> Out-of-range threads still load a slot of As and Bs that in-range threads read, and a barrier that part of a block skips is undefined behaviour. Padding with 0.0f keeps the control flow uniform; only the final store is guarded.
:::

# Coalescing: which thread loads which float

Global memory is read by the warp, not by the thread. When the 32 threads of a warp touch 32 consecutive
floats, the hardware serves them in one 128-byte transaction; when they touch 32 scattered addresses, it
takes up to 32 — see the
[coalescing post](https://developer.nvidia.com/blog/how-access-global-memory-efficiently-cuda-c-kernels/).
The \`[ty][tx]\` map is chosen for exactly this.

| Load | A warp (fixed \`ty\`, \`tx = 0…31\`) reads | Pattern |
| --- | --- | --- |
| \`A[row * K + t * TILE + tx]\` | 32 consecutive floats of one row of A | coalesced |
| \`B[(t * TILE + ty) * N + col]\` | 32 consecutive floats of one row of B | coalesced |
| \`C[row * N + col]\` | 32 consecutive floats of one row of C | coalesced |
| naive with \`x\` along rows | 32 floats \`K\` apart in A | 32 transactions |

- \`x\` along columns is the decision. Swap the roles (\`row\` from \`threadIdx.x\`) and every warp's load of
  \`A\` and store of \`C\` strides by a whole row — Boehm measures this alone as a several-fold slowdown.
- The shared reads are conflict-free too: \`As[ty][k]\` is one address per warp (a broadcast), \`Bs[k][tx]\`
  spans 32 consecutive banks. Storing \`Bs\` transposed would make it a 32-way bank conflict.

:::quiz
Q: In a warp, ty is fixed and tx runs 0…31. Which load of A is coalesced?
- [x] As[ty][tx] = A[row * K + t * TILE + tx] — consecutive tx, consecutive addresses
- [ ] As[tx][ty] = A[(blockIdx.y * TILE + tx) * K + t * TILE + ty] — consecutive tx, addresses K apart
- [ ] Both are, because shared memory absorbs the difference
> Coalescing is about the global addresses one warp touches in one instruction. The first form reads 128 contiguous bytes; the second reads 32 floats each a row apart, one transaction apiece. Shared memory is written after the load, so it cannot fix a scattered global read.
:::

# The two barriers

\`__syncthreads()\` stops every thread of the block until all have arrived, and makes their shared-memory
writes visible to each other. The slab loop needs it twice, for two different hazards:

- **After the loads** (read-after-write): no thread may multiply until every thread has written its slot of
  \`As\` and \`Bs\` — otherwise it reads a neighbour's slot from the previous slab, or garbage.
- **After the products** (write-after-read): no thread may start loading slab \`t + 1\` into \`As\`/\`Bs\` until
  every thread has finished reading slab \`t\`.

The first one is obvious; the second is the one that gets dropped, because a 32 × 32 block is 32 warps and
it is easy to picture them moving together. They do not:

:::sequence
{
  "participants": ["warp 0 (fast)", "shared As / Bs", "warp 7 (slow)"],
  "messages": [
    {"from": "warp 0 (fast)", "to": "shared As / Bs", "label": "slab t: store As[0][·], Bs[0][·]", "kind": "sync"},
    {"from": "warp 7 (slow)", "to": "shared As / Bs", "label": "slab t: store As[7][·], Bs[7][·]", "kind": "sync"},
    {"from": "warp 0 (fast)", "to": "warp 7 (slow)", "label": "__syncthreads() — slab t complete", "kind": "sync"},
    {"from": "shared As / Bs", "to": "warp 0 (fast)", "label": "acc += As[0][k] · Bs[k][·], k = 0…31 — done", "kind": "reply"},
    {"from": "warp 0 (fast)", "to": "shared As / Bs", "label": "no second barrier → slab t + 1: overwrite Bs[0][·]", "kind": "sync"},
    {"from": "shared As / Bs", "to": "warp 7 (slow)", "label": "warp 7 at k = 0 reads Bs[0][·] — now slab t + 1's row", "kind": "reply"},
    {"from": "warp 7 (slow)", "to": "warp 7 (slow)", "label": "acc gets a wrong product · wrong only sometimes", "kind": "sync"}
  ]
}
:::

With the second barrier, warp 0 waits after its products until warp 7 has finished slab \`t\`; only then does
anyone overwrite the tiles. The failure is timing-dependent: on one GPU, one size or one run the warps may
happen to stay in step, which is why the self-test compares every element on a \`K\` that is not a multiple
of 32, not just a checksum.

:::details Why not one barrier and two sets of tiles?
Alternating between two pairs of tiles — load slab \`t + 1\` into buffer B while multiplying buffer A — removes
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

The tiled kernel cuts global traffic 32×, but every FMA still reads two floats from shared memory: its
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

- \`torch.matmul\` reaches these kernels through cuBLASLt; Triton's \`tl.dot\` generates the same block
  structure from a few lines of Python.
- FlashAttention is this idea applied to attention: \`Q · Kᵀ\` and \`P · V\` are tiled through shared memory so
  the \`N × N\` score matrix never reaches global memory.

:::quiz
Q: After tiling, what is the next limit the tiled kernel runs into, and which technique addresses it?
- [ ] Global bandwidth again — fix with a larger TILE of 64 × 64 threads
- [x] Shared-memory bandwidth — each FMA still reads two floats from shared memory; register blocking reuses each in several FMAs
- [ ] Barrier cost — remove both __syncthreads()
> A block cannot have 64 × 64 = 4096 threads, and the barriers are needed for correctness. The inner loop does one FMA per two shared loads; computing a micro-tile per thread keeps values in registers and multiplies the FLOPs per shared load.
:::

# What to take away

- Arithmetic intensity, not FLOP count, decides a kernel's speed: the naive GEMM does 0.25 FLOP per byte and
  is a memory benchmark.
- Tiling makes reuse explicit: a block stages a 32 × 32 slab of \`A\` and \`B\` in shared memory and each float
  is used 32 times, cutting global traffic from \`2K\` to \`2K / 32\` per output.
- The \`[ty][tx]\` map with \`x\` along columns makes every global load and store coalesced and the shared reads
  conflict-free.
- Two barriers per slab: one before reading (the slab is complete), one before overwriting (everyone is done);
  edges are zero-padded so every thread reaches both.
- cuBLAS adds register blocking, double buffering and tensor cores on top of exactly this loop.

Primary reference: the CUDA C++ Programming Guide,
[Shared Memory](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#shared-memory).
`;
