/**
 * The learning guide for the prefix-scan drill: what a scan is and where a model stack uses it,
 * Hillis–Steele against Blelloch (work efficiency), the up-sweep and down-sweep on a worked example
 * with the barrier race beside it, shared-memory bank conflicts and the padding offset, the carry
 * across blocks, and what CUB's single-pass decoupled look-back adds — a figure or a table where one
 * says it faster than prose, a pop quiz per section. Rendered at \`/cuda-prefix-scan/learn\`.
 */
export const learn = `# The mechanism at a glance

A **scan** (prefix sum) replaces every element with the sum of the elements before it. The exclusive
scan of \`[3, 1, 7, 0, 4, 1, 6, 3]\` is \`[0, 3, 4, 11, 11, 15, 16, 22]\`; the inclusive scan adds the element
itself, \`[3, 4, 11, 11, 15, 16, 22, 25]\`. It is the primitive that turns *counts* into *offsets*, which is
why a model stack runs it constantly: the token-to-expert offsets a mixture-of-experts layer scatters by,
the \`cu_seqlens\` of a variable-length attention batch, the compaction of kept tokens in a sampler, radix
sort, \`torch.cumsum\`.

:::diagram
{
  "nodes": [
    {"id": "host", "kind": "client", "label": "Host · exclusive_scan", "sub": "⌈n/1024⌉ blocks · recurse on block sums · CPU check", "x": 8, "y": 50},
    {"id": "scan", "kind": "service", "label": "scan_block<<<blocks, 512>>>", "sub": "padded tile · up-sweep · clear root · down-sweep", "x": 36, "y": 25},
    {"id": "sums", "kind": "db", "label": "block_sums → offsets", "sub": "one total per block, scanned by the same function", "x": 64, "y": 25},
    {"id": "add", "kind": "service", "label": "add_block_offsets<<<blocks, 512>>>", "sub": "out[i] += offsets[blockIdx.x]", "x": 64, "y": 75},
    {"id": "dmem", "kind": "db", "label": "Device memory", "sub": "in[n] · out[n]", "x": 92, "y": 50}
  ],
  "edges": [
    {"from": "host", "to": "scan", "kind": "plain", "label": "launch · LAUNCH_CHECK"},
    {"from": "scan", "to": "sums", "kind": "plain", "label": "root of each tile"},
    {"from": "sums", "to": "host", "kind": "plain", "label": "exclusive_scan(sums, offsets, blocks)"},
    {"from": "sums", "to": "add", "kind": "plain", "label": "offsets[b]"},
    {"from": "scan", "to": "dmem", "kind": "plain", "label": "per-block exclusive scan"},
    {"from": "add", "to": "dmem", "kind": "plain", "label": "carry added"}
  ]
}
:::

The contract the drill implements, in one file \`prefix_scan.cu\`, with \`BLOCK_THREADS = 512\` and
\`ELEMS_PER_BLOCK = 1024\`:

- \`scan_block(const int* in, int* out, int* block_sums, int n)\`: one block loads 1024 elements into a
  padded \`__shared__ int temp[]\` (two per thread, zero past \`n\`), runs the up-sweep, writes the root to
  \`block_sums[blockIdx.x]\` and clears it, runs the down-sweep, stores the guarded result.
- \`add_block_offsets(int* out, const int* offsets, int n)\`: adds \`offsets[blockIdx.x]\` to the block's
  elements.
- \`exclusive_scan(d_in, d_out, n)\`: one launch for one block; otherwise scan the blocks, scan
  \`block_sums\` by calling itself, add the offsets back. \`to_inclusive\` turns the result into
  \`incl[i] = excl[i] + in[i]\`.

The sequential version is one line, \`out[i] = acc; acc += in[i];\`, and every iteration depends on the last.
The parallel version rests on one fact: \`+\` is **associative**, so the sum of a range can be built from the
sums of its halves in any grouping — a tree.

# Work efficiency: Hillis–Steele against Blelloch

There are two classic parallel scans, and the chapter this drill follows
([GPU Gems 3, ch. 39](https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda))
starts with the wrong one.

**Hillis–Steele** (1986): at level k every element adds the one 2ᵏ behind it. After log₂n levels each
element holds its inclusive prefix.

\`\`\`text
level 0 (stride 1):  x[i] += x[i-1]   for i >= 1
level 1 (stride 2):  x[i] += x[i-2]   for i >= 2
level 2 (stride 4):  x[i] += x[i-4]   for i >= 4
...                  log2(n) levels, n - 2^k adds at level k
\`\`\`

**Blelloch** (1990): an **up-sweep** builds a reduction tree in place (n − 1 adds), the root is replaced by
the identity 0, and a **down-sweep** walks back down the same tree handing each left child its parent's
value and each right child parent + left (n − 1 adds, n − 1 swaps).

| | Hillis–Steele | Blelloch (this drill) |
| --- | --- | --- |
| Adds | n·log₂n − (n − 1) | 2(n − 1) |
| Adds, one 1024-element tile | 9,217 | 2,046 |
| Adds, n = 2²⁰ | 19,922,945 | 2,097,150 |
| Levels (barriers) | log₂n = 10 per tile | 2·log₂n = 20 per tile |
| Result | inclusive | exclusive |
| In place | no — needs two buffers, a level reads what its neighbours overwrite | yes |
| Work-efficient | no — O(n log n) against the sequential O(n) | yes — O(n) |

A scan is **work-efficient** when it does asymptotically as many operations as the sequential loop.
Hillis–Steele has fewer levels, which wins when the array fits in one warp and there are idle lanes to burn
(warp-shuffle scans use it); over a 1024-element tile and a million-element array, the 4.5× and 9.5× extra
adds cost more than the ten saved barriers. Each Blelloch level also halves (then doubles) the active
threads, so the tile needs only \`n / 2\` threads — two elements per thread, which is why
\`ELEMS_PER_BLOCK = 2 * BLOCK_THREADS\`.

:::quiz
Q: Why does the drill's tile hold 2 × BLOCK_THREADS elements rather than one per thread?
- [ ] Each thread needs a spare slot for the swap in the down-sweep
- [x] The busiest Blelloch level combines n/2 pairs, so n/2 threads cover it; one element per thread would leave half the block idle at every level
- [ ] Shared memory is allocated in pairs of words
> The first up-sweep level and the last down-sweep level have n/2 active threads, each touching two elements; every other level has fewer. With one thread per element, at least half the threads would do nothing at every level.
:::

# The up-sweep and the down-sweep

The tree is implicit in the indices. At stride \`offset\`, thread \`tid < d\` owns the pair
\`a = offset·(2·tid + 1) − 1\` and \`b = offset·(2·tid + 2) − 1\`: \`a\` is the root of a left subtree, \`b\` of the
right one, and \`b\` ends up the parent.

\`\`\`cuda
int offset = 1;
for (int d = ELEMS_PER_BLOCK >> 1; d > 0; d >>= 1) {   // up-sweep: 512, 256, ..., 1 active threads
  __syncthreads();
  if (tid < d) { /* a, b as above, padded */ temp[b] += temp[a]; }
  offset <<= 1;
}
if (tid == 0) { block_sums[blockIdx.x] = temp[last]; temp[last] = 0; }
for (int d = 1; d < ELEMS_PER_BLOCK; d <<= 1) {        // down-sweep: 1, 2, ..., 512 active threads
  offset >>= 1;
  __syncthreads();
  if (tid < d) { int t = temp[a]; temp[a] = temp[b]; temp[b] += t; }
}
__syncthreads();
\`\`\`

On eight elements, \`[3, 1, 7, 0, 4, 1, 6, 3]\`:

| Phase | offset | Active pairs (a, b) | temp after |
| --- | --- | --- | --- |
| load | | | 3 1 7 0 4 1 6 3 |
| up | 1 | (0,1) (2,3) (4,5) (6,7) | 3 **4** 7 **7** 4 **5** 6 **9** |
| up | 2 | (1,3) (5,7) | 3 4 7 **11** 4 5 6 **14** |
| up | 4 | (3,7) | 3 4 7 11 4 5 6 **25** |
| clear root | | block_sums = 25 | 3 4 7 11 4 5 6 **0** |
| down | 4 | (3,7) | 3 4 7 **0** 4 5 6 **11** |
| down | 2 | (1,3) (5,7) | 3 **0** 7 **4** 4 **11** 6 **16** |
| down | 1 | (0,1) (2,3) (4,5) (6,7) | **0 3 4 11 11 15 16 22** |

The root holds the total (25) after the up-sweep, which is exactly the number the next level of the
multi-block scan needs — the drill takes it for free before clearing it. Clearing it is what makes the
result exclusive: the down-sweep propagates "the sum of everything to my left" from the root, and the root
has nothing to its left.

Every level reads what the previous level wrote, in other threads' slots. The barrier before each level is
what makes that safe; leave one out and the tree reads stale values:

:::sequence
{
  "participants": ["warp 0 (tid 0–31)", "temp[] (shared)", "warp 1 (tid 32–63)"],
  "messages": [
    {"from": "warp 1 (tid 32–63)", "to": "temp[] (shared)", "label": "up, offset 1: temp[65] += temp[64] … (still running)", "kind": "async"},
    {"from": "warp 0 (tid 0–31)", "to": "temp[] (shared)", "label": "no __syncthreads() · up, offset 2: tid 16 reads temp[65]", "kind": "sync"},
    {"from": "temp[] (shared)", "to": "warp 0 (tid 0–31)", "label": "stale in[65], not in[64] + in[65]", "kind": "reply"},
    {"from": "warp 0 (tid 0–31)", "to": "temp[] (shared)", "label": "temp[67] = wrong partial sum, propagated up the tree", "kind": "sync"},
    {"from": "temp[] (shared)", "to": "warp 0 (tid 0–31)", "label": "max abs error ≠ 0, varies run to run → FAIL", "kind": "reply"}
  ]
}
:::

:::sequence
{
  "participants": ["warp 0 (tid 0–31)", "temp[] (shared)", "warp 1 (tid 32–63)"],
  "messages": [
    {"from": "warp 1 (tid 32–63)", "to": "temp[] (shared)", "label": "up, offset 1: temp[65] += temp[64]", "kind": "sync"},
    {"from": "warp 0 (tid 0–31)", "to": "warp 1 (tid 32–63)", "label": "__syncthreads(): every warp finished level offset 1", "kind": "sync"},
    {"from": "warp 0 (tid 0–31)", "to": "temp[] (shared)", "label": "up, offset 2: tid 16 reads temp[65] = in[64] + in[65]", "kind": "sync"},
    {"from": "temp[] (shared)", "to": "warp 0 (tid 0–31)", "label": "correct partial sum · same result every run", "kind": "reply"}
  ]
}
:::

The barrier sits *outside* \`if (tid < d)\`: \`__syncthreads()\` must be reached by every thread of the block,
and a barrier inside a branch only some threads take is undefined behaviour — a hang on some GPUs, silent
corruption on others; the CUDA C++ Programming Guide's synchronisation-functions section states the rule.

:::quiz
Q: The up-sweep's last level has one active thread (thread 0 adds temp[511] into temp[1023]). Does thread 0 need a __syncthreads() before reading the root to clear it?
- [x] No — thread 0 wrote the root itself, so it sees its own write; the down-sweep's first barrier publishes the cleared root to the rest
- [ ] Yes — shared memory writes are never visible to the writing thread until a barrier
- [ ] Yes — otherwise thread 1 might clear it first
> A thread always sees its own prior writes. The barrier is needed only where one thread reads another's write, which is the first down-sweep level reading the cleared root — and that level starts with __syncthreads().
:::

# Bank conflicts and the padding offset

Shared memory is split into 32 **banks**, 4 bytes wide; word \`i\` lives in bank \`i mod 32\`. A warp's 32 accesses
complete in one cycle when they fall in 32 different banks, and serialise when several hit one bank at
different addresses — a k-way **bank conflict** costs k cycles
([CUDA C++ Programming Guide, shared memory](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#shared-memory-5-x)).

The tree's indices are the worst case for this. At stride \`offset\`, consecutive threads touch
\`a = offset·(2·tid + 1) − 1\` — addresses \`2·offset\` apart. Once that spacing is a multiple of 32, every
active lane of a warp lands in the same bank:

| offset | Active threads | Spacing of \`a\` across a warp | Unpadded conflict | Padded (\`a + (a >> 5)\`) |
| --- | --- | --- | --- | --- |
| 1 | 512 | 2 | 2-way | none |
| 2 | 256 | 4 | 4-way | none |
| 4 | 128 | 8 | 8-way | none |
| 8 | 64 | 16 | 16-way | none |
| 16 | 32 | 32 | **32-way** | none |
| 32 | 16 | 64 | 16-way | none |
| 64 | 8 | 128 | 8-way | none |

The fix from GPU Gems is to waste one word every 32: index \`i\` is stored at \`i + (i >> LOG_NUM_BANKS)\`.

\`\`\`cuda
#define LOG_NUM_BANKS 5
#define CONFLICT_FREE_OFFSET(i) ((i) >> LOG_NUM_BANKS)
__shared__ int temp[ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)];   // 1024 + 31 ints
a += CONFLICT_FREE_OFFSET(a);
b += CONFLICT_FREE_OFFSET(b);
\`\`\`

At offset 16, thread \`t\` reads \`a = 32t + 15\`; padded it is \`33t + 15\`, bank \`(t + 15) mod 32\` — 32 lanes,
32 banks. The same shift spreads every other level of a 1024-element tile, and the load and the store (where
\`ai = tid\` is already contiguous) stay conflict-free because the pad only changes every 32 elements. The
cost is 31 words of shared memory (124 bytes on 4,096) and one shift and add per index.

- Every index into \`temp\` must be padded — the load, both tree indices, the root, the store. Padding one
  and not another reads the wrong slot, which is a correctness bug, not a slowdown.
- The padding is the reason \`temp\` is sized \`ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)\`:
  the largest padded index is \`1023 + 31 = 1054\`.

:::quiz
Q: Without padding, the offset-16 level takes about how much longer than it would conflict-free?
- [ ] No longer — the hardware broadcasts when addresses collide
- [x] About 32× — all 32 lanes hit bank 15 at 32 different addresses and are served one at a time
- [ ] About 2× — only the read conflicts, not the write
> Broadcast only helps when lanes read the *same* address. Here they read 32 different words in one bank, so the access replays 32 times; padding moves lane t to bank (t + 15) mod 32.
:::

:::details Why not just change the indexing instead of padding?
A tree can also be laid out so each level's active elements are contiguous (store level k's nodes in their own range), which removes conflicts without padding but makes the index arithmetic and the in-place down-sweep harder. Warp-level scans avoid the question altogether: CUB and most modern kernels scan within a warp in registers with \`__shfl_up_sync\`, and use shared memory only to combine the 16–32 warp totals of a block.
:::

# Scanning across blocks

One block scans 1024 elements; a million needs 977 blocks, and blocks cannot wait for each other inside a
launch — the hardware runs them in any order and need not have them resident at the same time. So the carry
crosses a launch boundary, and the carry is itself a scan:

:::sequence
{
  "participants": ["Host", "scan_block", "Device memory", "add_block_offsets"],
  "messages": [
    {"from": "Host", "to": "scan_block", "label": "<<<977, 512>>>(in, out, block_sums, 1000003)", "kind": "async"},
    {"from": "scan_block", "to": "Device memory", "label": "out = each block scanned as if it started at 0 · block_sums[b] = total of block b", "kind": "sync"},
    {"from": "Host", "to": "scan_block", "label": "exclusive_scan(block_sums, offsets, 977) → <<<1, 512>>>, block_sums = nullptr", "kind": "async"},
    {"from": "scan_block", "to": "Device memory", "label": "offsets[b] = total of blocks 0 … b−1", "kind": "sync"},
    {"from": "Host", "to": "add_block_offsets", "label": "<<<977, 512>>>(out, offsets, 1000003)", "kind": "async"},
    {"from": "add_block_offsets", "to": "Device memory", "label": "out[i] += offsets[blockIdx.x]", "kind": "sync"}
  ]
}
:::

- **Recursion depth.** Each level divides n by 1024: 977 block sums fit one block, so a million elements
  take two levels; a billion would take three. The recursion bottoms out at \`blocks == 1\` with
  \`block_sums = nullptr\`, which is why the root store is guarded.
- **The tail block.** n = 1,000,003 leaves 579 elements in the last block. It loads zeros past \`n\` —
  zero is the identity of \`+\`, so the scan of the real elements is unchanged — and guards the stores with
  \`< n\`. No thread's control flow inside the tree depends on \`n\`.
- **Bytes.** \`scan_block\` reads n and writes n ints; \`add_block_offsets\` reads and writes them again:
  about 4n ints of traffic for a scan whose minimum is 2n. That second pass is what production removes.
- **The obvious shortcut fails.** An \`atomicAdd\` on a running total gives each block *a* prefix, but in the
  order blocks happen to finish, not in index order; a spin-wait on the previous block's flag inside one
  launch can deadlock when the previous block is not resident yet.

| n | Blocks | Block-sum levels | Launches |
| --- | --- | --- | --- |
| 1, 1023, 1024 | 1 | 0 | 1 \`scan_block\` |
| 1,000,003 | 977 | 1 | 2 \`scan_block\` + 1 \`add_block_offsets\` |
| 2³⁰ | 1,048,576 | 2 | 3 \`scan_block\` + 2 \`add_block_offsets\` |

:::quiz
Q: Block 5 finishes its tile scan before block 4 has even started. Why is block 5's output still correct after the whole exclusive_scan returns?
- [ ] scan_block launches blocks in index order
- [x] Block 5 only scans its own tile; the totals of blocks 0–4 reach it later through offsets[5], computed in a separate launch after every block has written its sum
- [ ] add_block_offsets waits on a flag from block 4
> Within one launch, nothing orders blocks. The drill never asks a block for another block's result inside a launch: kernel boundaries on one stream are the only ordering it relies on.
:::

# What CUB adds: a single pass with decoupled look-back

Production scans — CUB's \`DeviceScan\`, which \`thrust::exclusive_scan\` and \`torch.cumsum\` on CUDA call —
make one pass over the data. Merrill and Garland's
[decoupled look-back](https://research.nvidia.com/publication/2016-03_single-pass-parallel-prefix-scan-decoupled-look-back)
lets a tile learn its prefix from its predecessors *during* the launch, without the deadlock a naive
spin-wait risks:

:::sequence
{
  "participants": ["tile 6", "tile status (global)", "tiles 3–5"],
  "messages": [
    {"from": "tile 6", "to": "tile status (global)", "label": "tile id = atomicAdd(counter, 1) — ids follow start order, so predecessors are running", "kind": "sync"},
    {"from": "tile 6", "to": "tile status (global)", "label": "reduce own tile · publish {A, aggregate}", "kind": "sync"},
    {"from": "tiles 3–5", "to": "tile status (global)", "label": "5: {A, 40} · 4: {A, 12} · 3: {P, 310}", "kind": "async"},
    {"from": "tile status (global)", "to": "tile 6", "label": "look back: 40 + 12 + 310 — stop at the first P", "kind": "reply"},
    {"from": "tile 6", "to": "tile status (global)", "label": "publish {P, 362 + aggregate} · scan tile with prefix 362 · write out", "kind": "sync"}
  ]
}
:::

| | This drill (scan-then-propagate) | CUB single pass |
| --- | --- | --- |
| Global traffic | ~4n words | ~2n words |
| Launches for n = 10⁶ | 3, plus two \`cudaMalloc\`s | 1, scratch sized by a query call |
| In-block scan | shared-memory tree, 2 elements per thread | warp shuffles in registers, many elements per thread |
| Operator | \`+\` on \`int\` | any associative operator and type; segmented and by-key variants |
| Ordering trick | kernel boundary | per-tile status flags {X, A, P} and a look-back window |

Each tile publishes its own aggregate (**A**) as soon as it has reduced its data, so a successor never waits
for a whole chain of inclusive prefixes; the first predecessor that has published its inclusive prefix
(**P**) ends the look-back. The paper takes the tile id from an atomic counter rather than \`blockIdx.x\`, so
every tile a block waits on has already started. The result runs at memory-copy speed, which is the ceiling
for a bandwidth-bound primitive.

:::quiz
Q: Why does decoupled look-back publish a tile's aggregate before its inclusive prefix?
- [ ] The aggregate is needed by add_block_offsets
- [x] A successor can sum aggregates of several predecessors without waiting for each of them to finish its own look-back, so the wait does not grow with the tile's position
- [ ] Publishing twice makes the status update atomic
> If tiles published only inclusive prefixes, tile k would wait for tile k−1, which waits for k−2 — a serial chain across the whole array. Aggregates are known early and locally; summing a few of them back to the first inclusive prefix keeps the latency short.
:::

# What to take away

- **Associativity turns a sequential loop into two trees.** The up-sweep reduces in place, the root
  becomes the block total and is cleared to 0, the down-sweep swaps and adds back down: 2(n − 1) adds,
  work-efficient, exclusive.
- **A barrier per level, outside the branch.** Each level reads other threads' writes from the level
  before; \`__syncthreads()\` before \`if (tid < d)\` and once more before the store.
- **Pad every shared index.** \`i + (i >> 5)\` turns the tree's power-of-two strides from a 32-way bank
  conflict into none, for 31 extra words.
- **Carry across blocks with a second scan.** Blocks cannot wait for each other inside a launch, so the block
  totals are scanned by the same function and added back in a later launch; the tail block scans zeros.
- **Production makes it one pass.** CUB's decoupled look-back, warp-shuffle tile scans and generic
  operators are the same idea at memory-copy speed.

The primary reference is Harris, Sengupta and Owens,
[*Parallel Prefix Sum (Scan) with CUDA*](https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda)
(GPU Gems 3, ch. 39), built on Blelloch's
[*Prefix Sums and Their Applications*](https://www.cs.cmu.edu/~guyb/papers/Ble93.pdf) (1990); Merrill and
Garland's decoupled look-back is what CUB adds.
`;
