import type {Step} from '@/lib/types';

/** The reduce phase: strides halve from ELEMS_PER_BLOCK / 2 down to 1. */
const UP_SWEEP_FOR =
  /for\s*\(\s*int\s+(\w+)\s*=\s*(ELEMS_PER_BLOCK\s*>>\s*1|ELEMS_PER_BLOCK\s*\/\s*2|BLOCK_THREADS)\s*;\s*\1\s*>\s*0\s*;\s*\1\s*(>>=\s*1|\/=\s*2)\s*\)/;

/** The distribute phase: strides double from 1 up to ELEMS_PER_BLOCK / 2. */
const DOWN_SWEEP_FOR =
  /for\s*\(\s*int\s+(\w+)\s*=\s*1\s*;\s*\1\s*<\s*ELEMS_PER_BLOCK\s*;\s*\1\s*(<<=\s*1|\*=\s*2)\s*\)/;

export const blellochScanStep: Step = {
  id: 'blelloch-scan',
  title: 'scan_block + add_block_offsets: a work-efficient exclusive scan of any length',
  concept: 'cuda',
  file: 'prefix_scan',
  focus: ['scan', 'sums', 'add'],
  task: `## Task

Implement an **exclusive prefix sum** of \`n\` \`int\`s on the device, for any \`n ≥ 1\`, as three kernels
and one host function. \`BLOCK_THREADS = 512\` and \`ELEMS_PER_BLOCK = 2 * BLOCK_THREADS\` are given.

- \`__global__ void scan_block(const int* in, int* out, int* block_sums, int n)\`: block \`b\` scans elements
  \`[b × ELEMS_PER_BLOCK, (b + 1) × ELEMS_PER_BLOCK)\` in a \`__shared__ int temp[]\` tile, two elements per
  thread (\`tid\` and \`tid + BLOCK_THREADS\`), **zero past \`n\`**. The **up-sweep** (\`for (int d = ELEMS_PER_BLOCK >> 1; d > 0; d >>= 1)\`)
  builds the reduction tree in place, \`temp[b] += temp[a]\`, the stride \`offset\` doubling each level.
  Thread 0 then writes the root \`temp[ELEMS_PER_BLOCK - 1]\` to \`block_sums[blockIdx.x]\` (when
  \`block_sums\` is not \`nullptr\`) and **clears it to 0**. The **down-sweep**
  (\`for (int d = 1; d < ELEMS_PER_BLOCK; d <<= 1)\`) halves \`offset\` each level and swaps-and-adds:
  \`t = temp[a]; temp[a] = temp[b]; temp[b] += t\`. A \`__syncthreads()\` before every level and one
  before the guarded store to \`out\`. The result is the exclusive scan of the block, as if the block were
  the whole array.
- **Bank-conflict-free indexing**: \`#define LOG_NUM_BANKS 5\` and
  \`#define CONFLICT_FREE_OFFSET(i) ((i) >> LOG_NUM_BANKS)\`; every index into \`temp\` is padded,
  \`a += CONFLICT_FREE_OFFSET(a)\`, and \`temp\` is declared
  \`ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)\` long.
- \`__global__ void add_block_offsets(int* out, const int* offsets, int n)\`: block \`b\` adds
  \`offsets[b]\` to each of its \`ELEMS_PER_BLOCK\` elements of \`out\` (guarded by \`n\`).
- \`void exclusive_scan(const int* d_in, int* d_out, int n)\` on the host: \`blocks = (n + ELEMS_PER_BLOCK - 1) / ELEMS_PER_BLOCK\`;
  one block → a single \`scan_block\` launch with \`block_sums = nullptr\`; otherwise \`scan_block\` over
  the grid writing \`block_sums\`, **\`exclusive_scan\` of the block sums by calling itself** (they may
  span many blocks), then \`add_block_offsets\` with the scanned sums. Every launch is followed by
  \`LAUNCH_CHECK()\`.
- \`__global__ void to_inclusive(const int* in, const int* excl, int* incl, int n)\`: the inclusive variant
  is the exclusive scan shifted by one, \`incl[i] = excl[i] + in[i]\`; \`inclusive_scan\` runs it in place
  after \`exclusive_scan\`.
- Forbidden: a serial loop by one thread over the tile (\`if (tid == 0) for …\`), \`atomicAdd\` for the
  carry, \`thrust\`/\`cub\`. The block scan is the Blelloch tree, O(n) adds.
- The self-test (given, keep it) runs \`n = 1, 1023, 1024, 1000003\` — one partial block, one exact block,
  977 blocks with a partial tail — against a CPU loop for both variants, reports the **max abs error**
  (must be 0) and the \`cudaEvent\` time of the largest exclusive scan, and prints \`PASS\`.

> A scan looks sequential — every output depends on every input before it — but the sum is associative,
> so a tree reduces the array in log n levels and a second tree walks the partial sums back down. Two
> trees, 2n adds, no element waits for its predecessor.`,
  sequence: {
    participants: ['Host', 'scan_block', 'Device memory', 'add_block_offsets'],
    messages: [
      {from: 'Host', to: 'Device memory', label: 'cudaMemcpy in[n]  (n = 1,000,003)', kind: 'sync'},
      {from: 'Host', to: 'scan_block', label: '<<<977, 512>>>(in, out, block_sums, n)', kind: 'async'},
      {
        from: 'scan_block',
        to: 'scan_block',
        label: 'load 1024 → temp (zero past n) · up-sweep ×10 · root → block_sums[b], root = 0 · down-sweep ×10',
        kind: 'sync',
      },
      {
        from: 'scan_block',
        to: 'Device memory',
        label: 'out[b·1024 …] = exclusive scan of the block · block_sums[b] = total',
        kind: 'sync',
      },
      {from: 'Host', to: 'scan_block', label: 'exclusive_scan(block_sums, offsets, 977) → <<<1, 512>>>', kind: 'async'},
      {from: 'scan_block', to: 'Device memory', label: 'offsets[b] = sum of totals of blocks 0 … b−1', kind: 'sync'},
      {from: 'Host', to: 'add_block_offsets', label: '<<<977, 512>>>(out, offsets, n)', kind: 'async'},
      {from: 'add_block_offsets', to: 'Device memory', label: 'out[i] += offsets[blockIdx.x]', kind: 'sync'},
      {
        from: 'Device memory',
        to: 'Host',
        label: 'cudaMemcpy out[n] · compare with the CPU loop · max abs error 0',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Load `temp[ai + CONFLICT_FREE_OFFSET(ai)]` and `temp[bi + CONFLICT_FREE_OFFSET(bi)]` with `ai = tid`, `bi = tid + BLOCK_THREADS`, zero when `base + ai >= n`. Up-sweep: `offset = 1`; for `d` from `ELEMS_PER_BLOCK >> 1` down to 1, after a `__syncthreads()` threads `tid < d` take `a = offset * (2 * tid + 1) - 1`, `b = offset * (2 * tid + 2) - 1`, pad both, `temp[b] += temp[a]`; then `offset <<= 1`.',
    'Between the sweeps thread 0 saves `temp[last]` (`last = ELEMS_PER_BLOCK - 1` padded) to `block_sums[blockIdx.x]` and sets it to 0. Down-sweep mirrors the up-sweep: `d` from 1 doubling, `offset >>= 1` first, `__syncthreads()`, the same `a`/`b`, then `t = temp[a]; temp[a] = temp[b]; temp[b] += t`. One more `__syncthreads()` before writing `out`.',
    'On the host, `scan_block` over `blocks` leaves every block correct relative to its own start; the scan of `block_sums` is what each block is missing, and it is just another exclusive scan — call `exclusive_scan(d_sums, d_offsets, blocks)` and let the recursion bottom out at one block. Then `add_block_offsets` adds `offsets[blockIdx.x]` to each element.',
  ],
  checks: [
    {
      id: 'shared-tile',
      title: 'Each block scans 2 × blockDim.x elements staged in shared memory',
      detail:
        'Expected a `__shared__ int temp[...]` tile loaded with two elements per thread, `tid` and `tid + BLOCK_THREADS`, so a 512-thread block scans 1024 elements and the global loads stay coalesced. A scan in registers or straight from global memory cannot share partial sums across threads.',
      match: {
        cuda: {
          all: [
            /__shared__\s+int\s+temp\s*\[/,
            /(tid|threadIdx\.x)\s*\+\s*(BLOCK_THREADS|blockDim\.x)/,
            /temp\s*\[[^\]]+\]\s*=\s*\(/,
          ],
        },
      },
    },
    {
      id: 'up-sweep',
      title: 'The up-sweep reduces the tile in log n levels',
      detail:
        'Expected `for (int d = ELEMS_PER_BLOCK >> 1; d > 0; d >>= 1)` with the active threads doing `temp[b] += temp[a]` and the stride `offset` doubling per level (`offset <<= 1`). This is the reduction tree: n − 1 adds in total, the root at `temp[ELEMS_PER_BLOCK - 1]`.',
      match: {
        cuda: {
          all: [UP_SWEEP_FOR, /temp\s*\[\s*\w+\s*\]\s*\+=\s*temp\s*\[\s*\w+\s*\]/, /offset\s*(<<=\s*1|\*=\s*2)/],
        },
      },
    },
    {
      id: 'down-sweep',
      title: 'The root is cleared, then the down-sweep distributes partial sums',
      detail:
        'Expected the root set to 0 after the up-sweep and `for (int d = 1; d < ELEMS_PER_BLOCK; d <<= 1)` doing the swap-and-add `t = temp[a]; temp[a] = temp[b]; temp[b] += t` — the step that turns a reduction tree into an exclusive scan. Without the clear the result is off by the block total.',
      match: {
        cuda: {
          all: [
            DOWN_SWEEP_FOR,
            /int\s+(\w+)\s*=\s*temp\s*\[\s*(\w+)\s*\]\s*;\s*temp\s*\[\s*\2\s*\]\s*=\s*temp\s*\[\s*(\w+)\s*\]\s*;\s*temp\s*\[\s*\3\s*\]\s*\+=\s*\1\s*;/,
          ],
          order: [UP_SWEEP_FOR, /temp\s*\[\s*\w+\s*\]\s*=\s*0\s*;/, DOWN_SWEEP_FOR],
        },
      },
    },
    {
      id: 'barriers',
      title: 'A __syncthreads() separates every tree level and precedes the store',
      detail:
        'Expected `__syncthreads();` right before the `if (tid < d)` of each level and one before `out[...] = temp[...]`: level d reads what level 2d wrote. A barrier inside the `if (tid < d)` branch is undefined (not every thread reaches it) — expected none there.',
      match: {
        cuda: {
          all: [
            /__syncthreads\(\)\s*;\s*if\s*\(\s*(tid|threadIdx\.x)\s*<\s*\w+\s*\)/,
            /__syncthreads\(\)\s*;\s*(if\s*\([^)]*\)\s*)?out\s*\[/,
          ],
          none: [/if\s*\(\s*(tid|threadIdx\.x)\s*<\s*\w+\s*\)\s*\{[^}]*__syncthreads/],
        },
      },
    },
    {
      id: 'bank-conflicts',
      title: 'Tree indices are padded so a level never hits one bank 32 times',
      detail:
        'Expected `#define LOG_NUM_BANKS 5`, `#define CONFLICT_FREE_OFFSET(i) ((i) >> LOG_NUM_BANKS)`, `temp` declared `ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)` long, and every tree index padded with `a += CONFLICT_FREE_OFFSET(a)`. At stride 16 and above the unpadded indices `offset·(2·tid+1)−1` of a warp all fall in one bank and the level serialises 32-way.',
      match: {
        cuda: {
          all: [
            /#define\s+LOG_NUM_BANKS\s+5\b/,
            /#define\s+CONFLICT_FREE_OFFSET\(\s*(\w+)\s*\)\s*\(\s*\(\s*\1\s*\)\s*>>\s*LOG_NUM_BANKS\s*\)/,
            /temp\s*\[\s*ELEMS_PER_BLOCK\s*\+\s*CONFLICT_FREE_OFFSET\(/,
            /\w+\s*\+=\s*CONFLICT_FREE_OFFSET\(\s*\w+\s*\)/,
          ],
        },
      },
    },
    {
      id: 'block-carry',
      title: 'Block totals are scanned and added back, so n may span many blocks',
      detail:
        'Expected thread 0 to write the root to `block_sums[blockIdx.x]`, `exclusive_scan` to scan those sums by calling itself (or a second `scan_block` launch), and `add_block_offsets(int* out, const int* offsets, int n)` launched after `scan_block` to add `offsets[blockIdx.x]` to every element of the block. Blocks cannot synchronise with each other inside one launch; the carry has to cross a launch boundary.',
      match: {
        cuda: {
          all: [
            /block_sums\s*\[\s*blockIdx\.x\s*\]\s*=\s*temp\s*\[/,
            /__global__\s+void\s+add_block_offsets\s*\(\s*int\s*\*\s*out\s*,\s*const\s+int\s*\*\s*offsets\s*,\s*int\s+n\s*\)/,
            /offsets\s*\[\s*blockIdx\.x\s*\]/,
            /out\s*\[[^\]]+\]\s*\+=/,
            /(?:void\s+exclusive_scan\s*\([^{]*\{(?:(?!^\})[\s\S])*?\bexclusive_scan\s*\()|(?:scan_block\s*<<<[\s\S]*scan_block\s*<<<)/m,
          ],
          order: [/scan_block\s*<<</, /add_block_offsets\s*<<</],
        },
      },
    },
    {
      id: 'tail-block',
      title: 'Any n works: the tail block is zero-padded and stores are guarded',
      detail:
        'Expected `blocks = (n + ELEMS_PER_BLOCK - 1) / ELEMS_PER_BLOCK`, loads `(base + i < n) ? in[base + i] : 0` so the tail block scans zeros past the end, stores guarded by `< n`, and `block_sums` only written when it is not `nullptr` (the single-block case). n = 1, 1023 and 1,000,003 each exercise a partial block.',
      match: {
        cuda: {
          all: [
            /\(\s*n\s*\+\s*ELEMS_PER_BLOCK\s*-\s*1\s*\)\s*\/\s*ELEMS_PER_BLOCK/,
            /\?\s*in\s*\[[^\]]+\]\s*:\s*0\b/,
            /if\s*\([^)]*<\s*n\s*\)\s*out\s*\[/,
            /if\s*\(\s*block_sums\s*(!=\s*nullptr\s*)?\)/,
          ],
        },
      },
    },
    {
      id: 'no-serial-scan',
      title: 'No single thread walks the tile, no atomics, no library scan',
      detail:
        'Expected `scan_block` with the given signature and no `if (tid == 0) for (...)` loop over the tile (one thread doing 1023 serial adds while 511 wait), no `atomicAdd` carry (serialised across blocks, nondeterministic order), and no `thrust::`/`cub::` — the point is the tree.',
      match: {
        cuda: {
          all: [
            /__global__\s+void\s+scan_block\s*\(\s*const\s+int\s*\*\s*in\s*,\s*int\s*\*\s*out\s*,\s*int\s*\*\s*block_sums\s*,\s*int\s+n\s*\)/,
          ],
          none: [
            /if\s*\(\s*(tid|threadIdx\.x)\s*==\s*0\s*\)\s*\{?\s*for\s*\(/,
            /atomicAdd\s*\(/,
            /thrust::|cub::|#include\s*<(cub|thrust)/,
          ],
        },
      },
    },
  ],
  code: {
    cuda: {
      starter: `// prefix_scan.cu — work-efficient (Blelloch) exclusive scan of int arrays of any length.
// Build and run: nvcc -O2 -o prefix_scan prefix_scan.cu && ./prefix_scan
#include <cuda_runtime.h>

#include <cstdio>
#include <cstdlib>
#include <vector>

static void cuda_check(cudaError_t err, const char* what, int line) {
  if (err != cudaSuccess) {
    fprintf(stderr, "%s failed at line %d: %s\\n", what, line, cudaGetErrorString(err));
    exit(1);
  }
}
#define CUDA_CHECK(call) cuda_check((call), #call, __LINE__)
#define LAUNCH_CHECK() cuda_check(cudaGetLastError(), "kernel launch", __LINE__)

#define BLOCK_THREADS 512
#define ELEMS_PER_BLOCK (2 * BLOCK_THREADS)
// TODO: LOG_NUM_BANKS (32 banks) and CONFLICT_FREE_OFFSET(i), the padding added to every shared index.

// One block scans ELEMS_PER_BLOCK consecutive elements of in (zero past n) in shared memory:
// up-sweep, root -> block_sums[blockIdx.x] and cleared, down-sweep, guarded store to out.
__global__ void scan_block(const int* in, int* out, int* block_sums, int n) {
  // TODO: __shared__ int temp[ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)];
  // TODO: load two elements per thread (tid, tid + BLOCK_THREADS), zero when past n
  // TODO: up-sweep: for (int d = ELEMS_PER_BLOCK >> 1; d > 0; d >>= 1) { __syncthreads(); ... }
  // TODO: thread 0: block_sums[blockIdx.x] = root (if block_sums != nullptr); root = 0
  // TODO: down-sweep: for (int d = 1; d < ELEMS_PER_BLOCK; d <<= 1) { offset >>= 1; __syncthreads(); ... }
  // TODO: __syncthreads(); guarded store to out
}

// Adds the scanned block total to every element of the block that produced it.
__global__ void add_block_offsets(int* out, const int* offsets, int n) {
  // TODO
}

// Exclusive scan shifted by one: incl[i] = excl[i] + in[i].
__global__ void to_inclusive(const int* in, const int* excl, int* incl, int n) {
  // TODO
}

// Exclusive scan of n device ints: scan every block, scan the block totals (recursively, since
// the totals may themselves span many blocks), add each block's scanned total back.
static void exclusive_scan(const int* d_in, int* d_out, int n) {
  // TODO: blocks = ceil(n / ELEMS_PER_BLOCK); one block -> scan_block with block_sums = nullptr
  // TODO: otherwise cudaMalloc d_sums / d_offsets, scan_block over the grid, exclusive_scan(d_sums, d_offsets, blocks),
  //       add_block_offsets, free. LAUNCH_CHECK() after every launch.
}

static void inclusive_scan(const int* d_in, int* d_out, int n) {
  exclusive_scan(d_in, d_out, n);
  // In place: to_inclusive reads excl[i] and writes incl[i] from the same thread, no cross-thread hazard.
  to_inclusive<<<(n + BLOCK_THREADS - 1) / BLOCK_THREADS, BLOCK_THREADS>>>(d_in, d_out, d_out, n);
  LAUNCH_CHECK();
}

// ---- self-test: both variants against a CPU loop, timing of the largest exclusive scan ----------
static bool check_scan(int n) {
  std::vector<int> h_in(n), h_excl(n), h_incl(n);
  for (int i = 0; i < n; ++i) h_in[i] = (i * 7) % 13 - 3;  // small signed ints: no overflow in 1e6 of them
  int* d_in = nullptr;
  int* d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, n * sizeof(int)));
  CUDA_CHECK(cudaMalloc(&d_out, n * sizeof(int)));
  CUDA_CHECK(cudaMemcpy(d_in, h_in.data(), n * sizeof(int), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(d_out, 0, n * sizeof(int)));

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  exclusive_scan(d_in, d_out, n);
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaMemcpy(h_excl.data(), d_out, n * sizeof(int), cudaMemcpyDeviceToHost));

  inclusive_scan(d_in, d_out, n);
  CUDA_CHECK(cudaMemcpy(h_incl.data(), d_out, n * sizeof(int), cudaMemcpyDeviceToHost));

  long long acc = 0;
  long long max_err = 0;
  for (int i = 0; i < n; ++i) {
    long long e = h_excl[i] - acc;  // exclusive: sum of in[0 .. i)
    acc += h_in[i];
    long long f = h_incl[i] - acc;  // inclusive: sum of in[0 .. i]
    if (e < 0) e = -e;
    if (f < 0) f = -f;
    if (e > max_err) max_err = e;
    if (f > max_err) max_err = f;
  }
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  const int blocks = (n + ELEMS_PER_BLOCK - 1) / ELEMS_PER_BLOCK;
  printf("n=%d  blocks=%d  max abs error %lld  exclusive scan %.3f ms  (%.1f GB/s)\\n", n, blocks, max_err, ms,
         ms > 0.0f ? 2.0 * n * sizeof(int) / (ms * 1e6) : 0.0);
  return max_err == 0;
}

int main() {
  const int sizes[] = {1, 1023, 1024, 1000003};
  bool ok = true;
  for (int n : sizes) ok = check_scan(n) && ok;
  if (!ok) {
    printf("FAIL\\n");
    return 1;
  }
  printf("PASS\\n");
  return 0;
}
`,
      solution: `// prefix_scan.cu — work-efficient (Blelloch) exclusive scan of int arrays of any length.
// Build and run: nvcc -O2 -o prefix_scan prefix_scan.cu && ./prefix_scan
#include <cuda_runtime.h>

#include <cstdio>
#include <cstdlib>
#include <vector>

static void cuda_check(cudaError_t err, const char* what, int line) {
  if (err != cudaSuccess) {
    fprintf(stderr, "%s failed at line %d: %s\\n", what, line, cudaGetErrorString(err));
    exit(1);
  }
}
#define CUDA_CHECK(call) cuda_check((call), #call, __LINE__)
#define LAUNCH_CHECK() cuda_check(cudaGetLastError(), "kernel launch", __LINE__)

#define BLOCK_THREADS 512
#define ELEMS_PER_BLOCK (2 * BLOCK_THREADS)
#define LOG_NUM_BANKS 5
#define CONFLICT_FREE_OFFSET(i) ((i) >> LOG_NUM_BANKS)

// One block scans ELEMS_PER_BLOCK consecutive elements of in (zero past n) in shared memory:
// up-sweep builds a reduction tree in place, the root becomes the block total, down-sweep turns
// the tree into an exclusive scan. Every shared index is padded by CONFLICT_FREE_OFFSET so the
// strided tree accesses of a warp spread over the 32 banks instead of landing on one.
__global__ void scan_block(const int* in, int* out, int* block_sums, int n) {
  __shared__ int temp[ELEMS_PER_BLOCK + CONFLICT_FREE_OFFSET(ELEMS_PER_BLOCK - 1)];
  const int tid = threadIdx.x;
  const int base = blockIdx.x * ELEMS_PER_BLOCK;
  const int ai = tid;
  const int bi = tid + BLOCK_THREADS;
  const int pad_a = CONFLICT_FREE_OFFSET(ai);
  const int pad_b = CONFLICT_FREE_OFFSET(bi);
  temp[ai + pad_a] = (base + ai < n) ? in[base + ai] : 0;
  temp[bi + pad_b] = (base + bi < n) ? in[base + bi] : 0;

  // Up-sweep (reduce): at stride offset, thread tid adds the left child into the right child.
  int offset = 1;
  for (int d = ELEMS_PER_BLOCK >> 1; d > 0; d >>= 1) {
    __syncthreads();
    if (tid < d) {
      int a = offset * (2 * tid + 1) - 1;
      int b = offset * (2 * tid + 2) - 1;
      a += CONFLICT_FREE_OFFSET(a);
      b += CONFLICT_FREE_OFFSET(b);
      temp[b] += temp[a];
    }
    offset <<= 1;
  }

  // The root holds the block total: hand it to the next level, then clear it for the exclusive scan.
  if (tid == 0) {
    int last = ELEMS_PER_BLOCK - 1;
    last += CONFLICT_FREE_OFFSET(last);
    if (block_sums != nullptr) block_sums[blockIdx.x] = temp[last];
    temp[last] = 0;
  }

  // Down-sweep: each node passes its value to the left child and value + left child to the right.
  for (int d = 1; d < ELEMS_PER_BLOCK; d <<= 1) {
    offset >>= 1;
    __syncthreads();
    if (tid < d) {
      int a = offset * (2 * tid + 1) - 1;
      int b = offset * (2 * tid + 2) - 1;
      a += CONFLICT_FREE_OFFSET(a);
      b += CONFLICT_FREE_OFFSET(b);
      int t = temp[a];
      temp[a] = temp[b];
      temp[b] += t;
    }
  }
  __syncthreads();
  if (base + ai < n) out[base + ai] = temp[ai + pad_a];
  if (base + bi < n) out[base + bi] = temp[bi + pad_b];
}

// Adds the scanned block total to every element of the block that produced it.
__global__ void add_block_offsets(int* out, const int* offsets, int n) {
  const int base = blockIdx.x * ELEMS_PER_BLOCK;
  const int carry = offsets[blockIdx.x];
  const int i = base + threadIdx.x;
  if (i < n) out[i] += carry;
  if (i + BLOCK_THREADS < n) out[i + BLOCK_THREADS] += carry;
}

// Exclusive scan shifted by one: incl[i] = excl[i] + in[i].
__global__ void to_inclusive(const int* in, const int* excl, int* incl, int n) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) incl[i] = excl[i] + in[i];
}

// Exclusive scan of n device ints: scan every block, scan the block totals (recursively, since
// the totals may themselves span many blocks), add each block's scanned total back.
static void exclusive_scan(const int* d_in, int* d_out, int n) {
  const int blocks = (n + ELEMS_PER_BLOCK - 1) / ELEMS_PER_BLOCK;
  if (blocks == 1) {
    scan_block<<<1, BLOCK_THREADS>>>(d_in, d_out, nullptr, n);
    LAUNCH_CHECK();
    return;
  }
  int* d_sums = nullptr;
  int* d_offsets = nullptr;
  CUDA_CHECK(cudaMalloc(&d_sums, blocks * sizeof(int)));
  CUDA_CHECK(cudaMalloc(&d_offsets, blocks * sizeof(int)));
  scan_block<<<blocks, BLOCK_THREADS>>>(d_in, d_out, d_sums, n);
  LAUNCH_CHECK();
  exclusive_scan(d_sums, d_offsets, blocks);
  add_block_offsets<<<blocks, BLOCK_THREADS>>>(d_out, d_offsets, n);
  LAUNCH_CHECK();
  CUDA_CHECK(cudaFree(d_sums));
  CUDA_CHECK(cudaFree(d_offsets));
}

static void inclusive_scan(const int* d_in, int* d_out, int n) {
  exclusive_scan(d_in, d_out, n);
  // In place: to_inclusive reads excl[i] and writes incl[i] from the same thread, no cross-thread hazard.
  to_inclusive<<<(n + BLOCK_THREADS - 1) / BLOCK_THREADS, BLOCK_THREADS>>>(d_in, d_out, d_out, n);
  LAUNCH_CHECK();
}

// ---- self-test: both variants against a CPU loop, timing of the largest exclusive scan ----------
static bool check_scan(int n) {
  std::vector<int> h_in(n), h_excl(n), h_incl(n);
  for (int i = 0; i < n; ++i) h_in[i] = (i * 7) % 13 - 3;  // small signed ints: no overflow in 1e6 of them
  int* d_in = nullptr;
  int* d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, n * sizeof(int)));
  CUDA_CHECK(cudaMalloc(&d_out, n * sizeof(int)));
  CUDA_CHECK(cudaMemcpy(d_in, h_in.data(), n * sizeof(int), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(d_out, 0, n * sizeof(int)));

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start));
  exclusive_scan(d_in, d_out, n);
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaMemcpy(h_excl.data(), d_out, n * sizeof(int), cudaMemcpyDeviceToHost));

  inclusive_scan(d_in, d_out, n);
  CUDA_CHECK(cudaMemcpy(h_incl.data(), d_out, n * sizeof(int), cudaMemcpyDeviceToHost));

  long long acc = 0;
  long long max_err = 0;
  for (int i = 0; i < n; ++i) {
    long long e = h_excl[i] - acc;  // exclusive: sum of in[0 .. i)
    acc += h_in[i];
    long long f = h_incl[i] - acc;  // inclusive: sum of in[0 .. i]
    if (e < 0) e = -e;
    if (f < 0) f = -f;
    if (e > max_err) max_err = e;
    if (f > max_err) max_err = f;
  }
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  const int blocks = (n + ELEMS_PER_BLOCK - 1) / ELEMS_PER_BLOCK;
  printf("n=%d  blocks=%d  max abs error %lld  exclusive scan %.3f ms  (%.1f GB/s)\\n", n, blocks, max_err, ms,
         ms > 0.0f ? 2.0 * n * sizeof(int) / (ms * 1e6) : 0.0);
  return max_err == 0;
}

int main() {
  const int sizes[] = {1, 1023, 1024, 1000003};
  bool ok = true;
  for (int n : sizes) ok = check_scan(n) && ok;
  if (!ok) {
    printf("FAIL\\n");
    return 1;
  }
  printf("PASS\\n");
  return 0;
}
`,
    },
  },
  debrief: `The kernel is GPU Gems 3's chapter 39 with the two details that chapter spends most of its pages on. **Work efficiency** is why there are two sweeps rather than one: the obvious parallel scan (Hillis–Steele: at stride k every element adds the one k behind it) does n·log₂n − (n − 1) adds, 9,217 per 1024-element tile; the up-sweep/down-sweep pair does 2(n − 1) = 2,046, and the GPU's adds are not free. **Bank-conflict-free indexing** is why every index into \`temp\` is padded by \`i >> 5\`: the tree touches \`offset·(2·tid+1)−1\`, and from stride 16 upward those 32 addresses of a warp are 32 apart or more — the same bank each — so the level serialises 32-way; adding one word every 32 moves each of them to its own bank. The carry across blocks is a second scan because blocks cannot wait for each other inside a launch: \`block_sums\` is what each block is missing, scanning it is the same problem on \`n / 1024\` elements, and the recursion bottoms out at one block. The tail block scans zeros rather than branching, so no thread's control flow depends on \`n\`. What production does differently: CUB's \`DeviceScan\` (what \`torch.cumsum\` and \`thrust::exclusive_scan\` call) runs a **single pass** — Merrill and Garland's decoupled look-back lets each block publish its aggregate and then its inclusive prefix in global memory, and the next block spins briefly on its predecessors instead of waiting for a second launch, which halves the bytes moved; inside the block it scans with warp shuffles (\`__shfl_up_sync\`) and registers rather than a shared-memory tree, and it is templated over the operator, so the same code does max-scan, segmented scan and the scatter offsets of a radix sort. In an LLM serving stack this is the kernel behind the token-to-expert offsets of a mixture-of-experts layer, the \`cu_seqlens\` of a variable-length attention batch and every stream compaction of a sampling loop.`,
};
