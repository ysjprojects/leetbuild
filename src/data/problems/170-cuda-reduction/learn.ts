/**
 * The learning guide for the reduction drill: the tree reduction and Mark Harris's sequence of
 * kernels, why the naive shared-memory trees diverge and hit bank conflicts, warp shuffles,
 * grid-stride partials, combining blocks with an atomic or a second pass, and the accuracy of
 * float summation (pairwise order, Kahan). Rendered at \`/cuda-reduction/learn\`.
 */
export const learn = `# The mechanism at a glance

A **reduction** folds \`n\` values into one with an associative operator. On a GPU the question is where
each partial lives: a register per thread, registers passed between the 32 lanes of a warp, a few
kilobytes of shared memory per block, and global memory between blocks. A good reduction uses each level
once, in that order, and moves as little as possible to the next.

Bottom to top, how many partials are left at each level for the 512 × 256 launch:

:::architecture
{
  "input": "2²⁴ floats · 512 blocks × 256 threads",
  "output": "one float",
  "items": [
    {"id": "g-in", "label": "Global memory", "sub": "in[n] · 16,777,216 floats", "kind": "memory", "shape": "16.8 M values", "detail": "Read once, coalesced: 64 MiB for 16 M adds, so the kernel is as fast as it reads."},
    {"tone": "block", "repeat": "512 ×", "label": "Thread block · 256 threads", "items": [
      {"id": "g-reg", "label": "Register per thread", "sub": "grid-stride: 128 adds each", "kind": "kernel", "shape": "131,072 partials", "detail": "Each thread folds every 131,072nd element into one register before any tree starts."},
      {"tone": "dotted", "label": "each of 8 warps", "items": [
        {"id": "g-warp", "label": "Warp shuffles", "sub": "32 lanes → lane 0", "kind": "kernel", "shape": "4,096 warp sums", "detail": "Five \`__shfl_down_sync\` steps: registers move lane to lane, no shared memory, no barrier."}
      ]},
      {"id": "g-smem", "label": "Shared memory", "sub": "warp_sums[8] per block", "kind": "memory", "shape": "8 slots per block", "detail": "Lane 0 of each warp writes its slot; one \`__syncthreads()\` makes them visible."},
      {"id": "g-block", "label": "Warp 0 per block", "sub": "8 slots → lane 0", "kind": "kernel", "shape": "512 block sums", "detail": "Warp 0 reads the slots (0 past the warp count) and shuffles again."}
    ]},
    {"id": "g-atomic", "label": "atomicAdd into out", "sub": "one per block", "kind": "kernel", "shape": "1 float", "detail": "Blocks cannot synchronise inside a launch; their totals meet in global memory."},
    {"id": "g-out", "label": "Global memory", "sub": "out · 4 bytes", "kind": "memory"}
  ],
  "notes": [
    {"at": "g-reg", "text": "**131,072** partials, one register each"},
    {"at": "g-warp", "text": "**4,096** warp sums, no barrier"},
    {"at": "g-block", "text": "**512** block sums after **1** barrier each"},
    {"at": "g-atomic", "text": "**512** atomics into one address"}
  ]
}
:::

The contract the drill implements, in \`reduce_sum.cu\`:

- \`__device__ float warp_reduce_sum(float v)\`: \`v += __shfl_down_sync(0xffffffff, v, offset)\` for
  \`offset = 16, 8, 4, 2, 1\`; lane 0 ends with the sum of the 32 lanes.
- \`__global__ void reduce_sum(const float* in, float* out, int n)\`: \`*out\` is 0 on entry and the sum of
  \`in[0..n)\` on exit; \`blockDim.x\` is a multiple of 32, at most 1024; any grid size works.
- Inside: a grid-stride partial per thread, a shuffle reduction per warp, \`__shared__ float warp_sums[32]\`
  written by each warp's lane 0, \`__syncthreads()\`, warp 0 reduces the slots, lane 0 does one
  \`atomicAdd(out, v)\`.

Where it sits in a model: the mean and variance of LayerNorm, the sum of squares of RMSNorm, the row max
and row sum of softmax, the loss over a batch, the global gradient norm for clipping, the \`absmax\` of FP8
scaling. All are bandwidth-bound: 16 M floats are 64 MiB read for 16 M adds, so the kernel is as fast as
it reads.

# The tree, and why the first versions are slow

Summing \`n\` values sequentially takes \`n − 1\` dependent adds. A **tree** does the same adds in
\`log₂ n\` levels: pair up, add, repeat. Mark Harris's
[Optimizing Parallel Reduction in CUDA](https://developer.download.nvidia.com/assets/cuda/files/reduction.pdf)
walks seven kernels from the textbook tree to near-peak bandwidth; the first three are the lesson.

| Kernel | Inner step | What goes wrong |
| --- | --- | --- |
| 1 · interleaved, divergent | \`if (tid % (2*s) == 0) sdata[tid] += sdata[tid + s]\`, \`s *= 2\` | half the lanes of every warp idle at level 1; \`%\` is slow |
| 2 · interleaved, strided index | \`index = 2*s*tid; if (index < blockDim.x) …\` | no divergence, but **bank conflicts** in shared memory |
| 3 · sequential addressing | \`for (s = blockDim.x/2; s > 0; s >>= 1) if (tid < s) …\` | conflict-free; half the threads idle from the first level |
| 4–7 | first add during load, unrolled last warp, templates, many elements per thread | bandwidth-bound at last |

- **Divergence.** A warp executes one instruction for all 32 lanes. In kernel 1 the active threads are
  0, 2, 4, …, then 0, 4, 8, …: every warp stays busy, but most lanes are masked off. The work done drops
  by half per level while the warps issued do not.
- **Bank conflicts.** Shared memory is 32 banks of 4 bytes; lanes that hit different addresses in the
  same bank are serialised. Kernel 2 reads \`sdata[2*s*tid]\`: at \`s = 16\` lanes 0 and 1 hit addresses 0
  and 32, both bank 0 — a 16-way conflict at that level.
- **Sequential addressing** (kernel 3) makes lane \`tid\` read \`sdata[tid + s]\`: consecutive lanes,
  consecutive banks, and the active threads are a contiguous prefix so whole warps retire.
- Every level still costs a \`__syncthreads()\` and a round trip through shared memory. That is what the
  next two ideas remove.

Step through a shared-memory tree and watch the idle threads pile up level by level; beside it is the warp
shuffle of the next section, which needs neither the barriers nor the shared memory:

:::widget warp-reduce

:::quiz
Q: Kernel 1 (\`tid % (2*s) == 0\`) and kernel 3 (\`tid < s\`) do exactly the same number of adds. Why is kernel 3 faster?
- [ ] It does fewer \`__syncthreads()\` calls
- [x] Its active threads are a contiguous prefix, so whole warps go idle and the remaining ones read consecutive banks
- [ ] It uses registers instead of shared memory
> Both take log₂(blockDim) levels with a barrier each. In kernel 1 every warp keeps issuing with most lanes masked; in kernel 3 the idle threads form whole warps that are skipped, and \`sdata[tid + s]\` maps consecutive lanes to consecutive banks.
:::

# Warp shuffles

Inside a warp no shared memory and no barrier is needed: the
[warp shuffle functions](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#warp-shuffle-functions)
read another lane's register directly.

\`\`\`cuda
__device__ float warp_reduce_sum(float v) {
  for (int offset = 16; offset > 0; offset >>= 1)
    v += __shfl_down_sync(0xffffffff, v, offset);
  return v;  // lane 0 holds the sum of the 32 lanes
}
\`\`\`

| offset | lane \`l\` adds lane | lanes still meaningful |
| --- | --- | --- |
| 16 | \`l + 16\` | 0–15 |
| 8 | \`l + 8\` | 0–7 |
| 4 | \`l + 4\` | 0–3 |
| 2 | \`l + 2\` | 0–1 |
| 1 | \`l + 1\` | 0 |

- Five register moves replace five shared-memory levels and their barriers. Lanes above the
  meaningful range compute garbage that nobody reads; that costs nothing, since the warp issues once.
- \`__shfl_down_sync\` from a lane past 31 returns the caller's own value — harmless, for the same reason.
- **The mask.** \`0xffffffff\` declares that all 32 lanes take part, and the hardware waits for them. Since
  Volta, lanes of a warp may sit at different program counters (independent thread scheduling);
  \`__activemask()\` only reports who happens to be converged right now, so a reduction over it may sum a
  subset. The pre-CUDA 9 \`__shfl_down\` without \`_sync\` is gone for the same reason.
- \`__reduce_add_sync\` (sm_80+) does the warp sum in one instruction, for integers only; float sums stay
  on shuffles.

:::quiz
Q: Why does the drill pass 0xffffffff rather than __activemask() to __shfl_down_sync?
- [ ] __activemask() is slower to compute
- [x] The mask must name the lanes that are meant to participate; __activemask() names whoever is converged at that instant, which may be fewer
- [ ] __activemask() is only available on pre-Volta GPUs
> Every thread reaches warp_reduce_sum with a value, so all 32 must take part. With independent thread scheduling, a lane delayed by an earlier branch is absent from __activemask() and its partial would be silently dropped.
:::

# Grid-stride partials and the block hand-off

Harris's kernels 4–7 get their speed mostly from one change: each thread sums **many** elements before any
tree starts. The drill does that with a grid-stride loop:

\`\`\`cuda
float v = 0.f;
for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += gridDim.x * blockDim.x)
  v += in[i];
\`\`\`

| Launch | threads | elements per thread (n = 2^24) | atomics |
| --- | --- | --- | --- |
| 512 × 256 | 131,072 | 128 | 512 |
| 64 × 128 | 8,192 | 2,048 | 64 |

- Consecutive lanes read consecutive addresses on every iteration: each warp load is one 128-byte
  transaction, and each element is read exactly once.
- The grid no longer depends on \`n\`. The tree's cost — shuffles, a barrier, an atomic — is paid once per
  thread or block, amortised over hundreds of loads. Too few threads (the 64 × 128 run) cannot keep enough
  loads in flight to saturate the bus; that is the GB/s gap the host prints.
- **Block hand-off.** After \`warp_reduce_sum\`, lane 0 (\`threadIdx.x % 32 == 0\`) writes
  \`warp_sums[threadIdx.x / 32]\`; \`__syncthreads()\`; warp 0 reads \`lane < blockDim.x / 32 ? warp_sums[lane] : 0\`
  and shuffles again. With at most 1024 threads there are at most 32 warps, so one warp finishes any block.
- The guard matters: a 128-thread block fills four slots and leaves 28 uninitialised.

The hand-off inside one 256-thread block, bottom to top:

:::architecture
{
  "input": "one grid-stride partial v per thread",
  "output": "*out += block sum",
  "items": [
    {"tone": "block", "repeat": "512 ×", "label": "One block · 8 warps", "items": [
      {"columns": [
        [{"id": "h-w0", "label": "Warp 0 shuffles", "sub": "lane 0 → warp_sums[0]", "kind": "kernel"}],
        [{"id": "h-w1", "label": "Warp 1 shuffles", "sub": "lane 0 → warp_sums[1]", "kind": "kernel"}],
        [{"id": "h-w7", "label": "… warp 7", "sub": "lane 0 → warp_sums[7]", "kind": "kernel"}]
      ]},
      {"id": "h-smem", "label": "__shared__ warp_sums[32]", "sub": "slots 0–7 written, 8–31 stale", "kind": "memory", "detail": "Shared memory is not initialised: only the slots of existing warps hold sums."},
      {"id": "h-sync", "label": "__syncthreads()", "sub": "every slot visible to warp 0", "kind": "kernel", "detail": "The only barrier in the kernel. Every thread must reach it, including those whose loop did zero iterations."},
      {"id": "h-read", "label": "Warp 0 reads the slots", "sub": "lane < 8 ? warp_sums[lane] : 0", "kind": "kernel", "detail": "Lanes past \`blockDim.x / 32\` contribute 0, the identity of the sum."},
      {"id": "h-shfl", "label": "warp_reduce_sum again", "sub": "5 shuffles → lane 0", "kind": "kernel"},
      {"id": "h-atomic", "label": "atomicAdd(out, v)", "sub": "lane 0 of warp 0 only", "kind": "kernel"}
    ]},
    {"id": "h-out", "label": "Global memory", "sub": "out · 4 bytes", "kind": "memory"}
  ],
  "notes": [
    {"at": "h-smem", "text": "A 128-thread block: **4** slots written, **28** stale"},
    {"at": "h-read", "text": "The guard reads **0** past blockDim.x / 32"}
  ]
}
:::

:::quiz
Q: The 64 × 128 launch computes the same sum as 512 × 256. Why is it several times slower?
- [ ] Each thread runs out of registers holding 2,048 partials
- [x] 8,192 threads cannot keep enough memory requests in flight to saturate HBM bandwidth
- [ ] It does eight times as many atomics
> The partial is one register regardless of how many elements a thread folds. A bandwidth-bound kernel needs enough outstanding loads per SM to cover memory latency; 64 small blocks leave most SMs empty or under-occupied.
:::

# Combining blocks: atomics or a second pass

Blocks cannot synchronise with each other inside a launch, so the per-block totals meet in global memory.
Two ways:

| | One atomic per block (the drill) | Two-stage |
| --- | --- | --- |
| Kernel 1 writes | \`atomicAdd(out, v)\` | \`partial[blockIdx.x] = v\` |
| Then | done | second launch, one block, reduces \`partial[]\` |
| Launches | 1 (plus \`cudaMemset(out, 0)\`) | 2 |
| Result bits | vary run to run | identical every run |
| Extra memory | one float | one float per block |

- **Contention is not the issue.** 512 atomics against 16 M loads is noise. A per-thread atomic would be
  16 M serialised updates to one address — that is the version to avoid.
- **Zero first, every time.** Atomics accumulate: the host must \`cudaMemset(out, 0)\` before each launch,
  or the second timed launch reports twice the sum.
- **Determinism.** Float addition is not associative and blocks finish in any order, so the last digits of
  \`sum\` move between runs. PyTorch's \`torch.use_deterministic_algorithms(True)\` rejects atomic-based
  reductions for that reason; the two-stage form fixes the order.

:::details Single-pass without atomics on the value
CUB's \`DeviceReduce\` and "last block" kernels write per-block partials, then increment an atomic
*counter*; the block that sees the counter reach \`gridDim.x − 1\` (after a \`__threadfence()\`) reduces all
partials in a fixed order. One launch, deterministic result — at the cost of a fence and a counter that
must be reset.
:::

:::quiz
Q: A teammate times twenty launches of the drill's kernel and gets sum = 20× the reference on the last one. What is missing?
- [ ] A __syncthreads() after the atomicAdd
- [x] A cudaMemset(out, 0) before every launch, because atomicAdd accumulates into whatever *out holds
- [ ] cudaDeviceSynchronize between launches
> Each launch adds its total into *out. Kernels on one stream already run in order, so synchronisation is not the bug; the stale accumulator is.
:::

# Summation order and accuracy

A float has a 24-bit significand. Adding a value near 0.5 to a running sum of 8 M loses everything below
0.5 (float spacing near 2²³ is 1.0), so a naive left-to-right loop over 16 M floats drifts by an error that grows like
\`O(n · ε)\`.

| Method | Error bound (ε = 2⁻²⁴) | Where |
| --- | --- | --- |
| Sequential | \`(n − 1) · ε · Σ abs(xᵢ)\` | one CPU thread, \`float\` |
| Pairwise / tree | \`log₂ n · ε · Σ abs(xᵢ)\` | the GPU kernel, NumPy's \`sum\` |
| [Kahan](https://en.wikipedia.org/wiki/Kahan_summation_algorithm) | \`2ε · Σ abs(xᵢ)\`, independent of \`n\` | the drill's reference |

\`\`\`c
double sum = 0, c = 0;
for (int i = 0; i < n; ++i) {
  double y = x[i] - c;   // subtract the error carried from the last step
  double t = sum + y;
  c = (t - sum) - y;     // what was lost rounding t
  sum = t;
}
\`\`\`

- The GPU kernel is accurate *because* it is parallel: each thread folds about 128 values, then the
  shuffles and the block combine form a tree. The drill's rel err of \`1e-8\`-ish is well inside \`1e-5\`.
- The reference is Kahan in double so that its own error is negligible; comparing two naive float sums
  would test which one is worse, not whether the kernel is right.
- The tolerance is **relative**: \`|sum − ref| / |ref|\`. An absolute tolerance on a sum of 8 M would be
  either meaningless or unattainable.
- Compilers must not reassociate the Kahan loop; \`-ffast-math\` would delete \`c\` entirely.

:::quiz
Q: Why is the GPU's float sum of 16 M values typically *more* accurate than a single-threaded float loop on the CPU?
- [ ] The GPU uses fused multiply-add
- [x] Its order is a tree of short sums, so the error grows like log n instead of n
- [ ] GPU floats carry extra hidden precision bits
> Each partial stays small relative to the values it adds, and the levels of the tree are few; a sequential loop adds tiny values to an ever-larger total and rounds them away.
:::

# What to take away

- A reduction is bandwidth-bound: read each element once, coalesced, and keep everything after the load
  in registers or shared memory.
- Grid-stride partials amortise the tree over hundreds of loads per thread and decouple the grid from \`n\`.
- Inside a warp, \`__shfl_down_sync(0xffffffff, …)\` replaces the shared-memory tree, its barriers, its
  divergence and its bank conflicts.
- One shared slot per warp and one \`atomicAdd\` per block finish the job; the atomic costs determinism,
  which the two-stage form buys back.
- Float sums depend on order; trees are more accurate than loops, and a Kahan reference in double is the
  right yardstick.

Primary reference: Mark Harris, [Optimizing Parallel Reduction in CUDA](https://developer.download.nvidia.com/assets/cuda/files/reduction.pdf).
`;
