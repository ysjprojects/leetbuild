/**
 * The learning guide for the FlashAttention drill: why attention is memory-bound (HBM vs SRAM,
 * IO-awareness), the online softmax and its rescale, tiling with two barriers and causal tile
 * skipping, recomputation in the backward pass, and what FlashAttention-2 and -3 add — a figure or
 * a table where one says it faster than prose, a pop quiz per section. Rendered at
 * \`/cuda-flash-attention/learn\`.
 */
export const learn = `# The mechanism at a glance

FlashAttention (Dao, Fu, Ermon, Rudra, Ré, 2022) computes exact attention, \`O = softmax(Q Kᵀ / √d) V\`,
without ever writing the \`T × T\` score matrix to GPU memory. It is not an approximation: it is the same
arithmetic, reordered so that each byte of \`K\` and \`V\` is read from global memory once per block of
queries and the softmax is finished one tile at a time. Every long-context model since 2022 trains and
serves on a descendant of it; \`torch.nn.functional.scaled_dot_product_attention\` dispatches to one.

:::diagram
{
  "nodes": [
    {"id": "host", "kind": "client", "label": "Host", "sub": "fills Q K V · launches · compares to a CPU reference", "x": 10, "y": 50},
    {"id": "hbm", "kind": "db", "label": "Global memory (HBM)", "sub": "Q K V O · T × d each · no T × T buffer", "x": 40, "y": 20},
    {"id": "kernel", "kind": "service", "label": "flash_attn_fwd", "sub": "one block per 64 query rows · one thread per row", "x": 40, "y": 70},
    {"id": "smem", "kind": "db", "label": "Shared memory (SRAM)", "sub": "Ks, Vs · 32 × 64 floats each per tile", "x": 72, "y": 70},
    {"id": "ref", "kind": "external", "label": "CPU reference", "sub": "double · materialised softmax", "x": 72, "y": 20}
  ],
  "edges": [
    {"from": "host", "to": "hbm", "kind": "plain", "label": "cudaMemcpy Q K V · O back"},
    {"from": "host", "to": "kernel", "kind": "plain", "label": "<<<⌈T/BQ⌉, BQ>>>"},
    {"from": "kernel", "to": "hbm", "kind": "plain", "label": "read each K/V tile once · write O once"},
    {"from": "kernel", "to": "smem", "kind": "plain", "label": "stage tile · __syncthreads"},
    {"from": "host", "to": "ref", "kind": "plain", "label": "max|err| < 1e-3"}
  ]
}
:::

The contract the drill implements, in one file \`flash_attention.cu\`:

- \`__global__ void flash_attn_fwd(const float* Q, const float* K, const float* V, float* O, int T, int d,
  float scale, bool causal)\` — row-major \`T × d\` arrays, \`scale = 1 / √d\`, \`causal\` masks keys \`j > i\`.
- \`BQ = 64\` query rows per block, one per thread; \`BK = 32\` key/value rows per tile in
  \`__shared__ float Ks[BK][D_MAX]\`, \`Vs[BK][D_MAX]\`; \`D_MAX = 64\`, \`d ≤ D_MAX\`.
- Per thread, in registers: \`q[D_MAX]\` (pre-scaled), \`o[D_MAX]\`, \`s[BK]\`, the running max \`m\` and
  running sum \`l\`.
- \`main()\`: \`T = 256\`, \`d = 64\`, non-causal and causal, max-abs-error against a double CPU reference
  below \`1e-3\`, \`cudaEvent\` timing, a memory note, \`PASS\`.

# Attention is memory-bound: HBM, SRAM and IO-awareness

A GPU has two memories that matter here. **HBM** (global memory) is large and slow; **SRAM** (shared
memory and registers, per SM) is tiny and fast. The FlashAttention paper's numbers for an A100:

| Memory | Size | Bandwidth |
|---|---|---|
| HBM | 40–80 GB | ~1.5–2.0 TB/s |
| SRAM (shared memory, 108 SMs) | 192 KB per SM | ~19 TB/s |
| Registers | 256 KB per SM | faster still |

The standard implementation is three kernels, each a round trip through HBM:

\`\`\`text
S = Q Kᵀ · scale      write T × T
P = softmax(S)        read T × T, write T × T
O = P V               read T × T
\`\`\`

For \`T = 8192\` one head's \`S\` is \`8192² · 4 = 256 MiB\`, moved four times per layer, while \`Q\`, \`K\`, \`V\`, \`O\`
are 2 MiB each at \`d = 64\`. The FLOPs are \`~4 T² d\` either way; what differs is bytes. The paper calls
the remedy **IO-awareness**: count HBM reads and writes, not FLOPs, and arrange the computation so the
big intermediate never leaves SRAM.

| | HBM traffic | Extra memory |
|---|---|---|
| Standard attention | \`Θ(T d + T²)\` | \`T × T\` per head |
| FlashAttention | \`Θ(T² d² / M)\` for SRAM size \`M\` | \`O(T)\` (the statistics) |

With \`d\` in 64–128 and \`M\` around 100 KB, \`d² / M\` is well below 1, so traffic drops many-fold — and the
paper proves no exact algorithm does asymptotically better across the range of \`M\`. In the drill the
memory note makes the same point at \`T = 256\`: 16,384 bytes of shared memory per block against a score
matrix of 262,144 bytes that is never allocated.

:::quiz
Q: Why does fusing attention into one kernel speed it up when it performs the same FLOPs?
- [ ] Shared memory performs floating-point arithmetic faster than global memory
- [x] Attention is limited by HBM bandwidth, and fusion removes the T × T reads and writes
- [ ] The fused kernel skips the scaling by 1/√d
> Standard attention spends its time moving the score matrix through HBM, not multiplying. Removing that traffic is the whole speed-up; the arithmetic is unchanged and the result is exact.
:::

# The online softmax and its rescale

A softmax needs the row's maximum (for stability) and its sum (for normalisation) before any output is
known — apparently the whole row at once. The [online softmax](https://arxiv.org/abs/1805.02867) of
Milakov & Gimelshein removes that requirement with one identity:

\`\`\`text
exp(s − m_new) = exp(s − m_old) · exp(m_old − m_new)
\`\`\`

So a row can keep a running max \`m\`, a running sum \`l\` and an unnormalised accumulator \`o\`, and correct
all three by one multiply whenever a larger score arrives. Per tile of \`BK\` scores:

\`\`\`cuda
m_new = fmaxf(m, tile_max);
alpha = __expf(m - m_new);          // exp(m_old − m_new) ≤ 1
for k: o[k] *= alpha;               // re-express the past under the new max
for j: p = __expf(s[j] - m_new);    // ≤ 1, never overflows
       p_sum += p;  for k: o[k] += p * Vs[j][k];
l = l * alpha + p_sum;
m = m_new;
// after the last tile: O = o / l
\`\`\`

- **First tile.** \`m = -INFINITY\`, so \`alpha = __expf(-inf) = 0\` and the zero accumulator stays zero — no
  special case.
- **Masked scores.** \`s[j] = -INFINITY\` gives \`p = 0\`; padding and the causal mask need no branches in the
  fold.
- **Normalise once.** Dividing by \`l\` at the end instead of every tile saves \`d\` divides per tile and is
  exact: every term was scaled by the same \`exp(−m)\`.

The failure the max avoids is overflow. A naive one-pass softmax that sums \`exp(s)\` directly works
until a score passes about 88, where \`expf\` overflows float:

:::sequence
{
  "participants": ["thread (row i)", "registers"],
  "messages": [
    {"from": "thread (row i)", "to": "registers", "label": "naive: l += exp(s[j]), o += exp(s[j]) · v_j", "kind": "sync"},
    {"from": "thread (row i)", "to": "registers", "label": "s = 95 → exp(95) = inf", "kind": "sync"},
    {"from": "registers", "to": "thread (row i)", "label": "O = inf / inf = NaN for the whole row", "kind": "reply"},
    {"from": "thread (row i)", "to": "registers", "label": "online: m_new = 95, alpha = exp(m − 95), o *= alpha, l = l·alpha + Σ exp(s − 95)", "kind": "sync"},
    {"from": "registers", "to": "thread (row i)", "label": "every exp ≤ 1 · O = o / l finite and exact", "kind": "reply"}
  ]
}
:::

Forgetting \`o[k] *= alpha\` is the subtler bug: the output is finite but wrong, because contributions
from earlier tiles stay weighted against a stale maximum while \`l\` is corrected.

:::quiz
Q: A new tile raises the running max from 3 to 7. What must happen to the accumulator before the tile's contributions are added?
- [ ] Nothing; the final division by l corrects it
- [x] Multiply it, and l, by exp(3 − 7)
- [ ] Reset it to zero and restart the row
> Past terms were computed as exp(s − 3). To sum them with new terms exp(s − 7) they must be re-expressed under the same max, which is one multiply by exp(3 − 7). The final division only works if numerator and denominator share that scale.
:::

:::details Why __expf rather than expf
\`__expf\` maps to the hardware special-function unit (\`ex2.approx\` after a multiply by log₂e); \`expf\` is
an accurate software sequence several times longer. Every argument here is ≤ 0, where \`__expf\`'s error
is a few ulps — far inside the drill's \`1e-3\` tolerance. Once the matmuls move to tensor cores the
exponentials become the bottleneck, which is why FlashAttention-3 works hard to overlap them.
:::

# Tiles, barriers and the causal skip

Tiling is what turns the identity into bandwidth. A block owns \`BQ = 64\` query rows and walks the keys
in tiles of \`BK = 32\`: each tile of \`K\` and \`V\` is read from HBM once into shared memory and used by
all 64 rows, so \`K\` and \`V\` are read \`⌈T / BQ⌉\` times in total instead of \`T\` times.

| Buffer | Where | Size in the drill |
|---|---|---|
| \`q\`, \`o\` | registers, per thread | 64 floats each |
| \`s\` | registers, per thread | 32 floats |
| \`m\`, \`l\` | registers, per thread | 1 float each |
| \`Ks\`, \`Vs\` | shared, per block | 32 × 64 floats = 8 KB each |

- **Coalesced staging.** The load loop strides \`idx\` by \`BQ\` over \`BK × D_MAX\` with \`j = idx / D_MAX\`,
  \`k = idx % D_MAX\`, so consecutive threads read consecutive floats of one row — see
  [coalesced access](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#coalesced-access-to-global-memory).
- **Broadcast, not conflict.** In the score loop every thread of a warp reads the same \`Ks[j][k]\`, which
  shared memory serves as a broadcast.
- **Two barriers.** \`__syncthreads()\` after the load so no thread reads a half-filled tile, and again
  after the fold so no thread overwrites the tile a neighbour is still reading.

The second barrier is the one people drop. Without it, the race is:

:::sequence
{
  "participants": ["warp 0", "Ks / Vs (shared)", "warp 1"],
  "messages": [
    {"from": "warp 0", "to": "Ks / Vs (shared)", "label": "stage tile kv0 = 0", "kind": "sync"},
    {"from": "warp 1", "to": "Ks / Vs (shared)", "label": "stage tile kv0 = 0", "kind": "sync"},
    {"from": "warp 0", "to": "warp 1", "label": "__syncthreads()", "kind": "sync"},
    {"from": "warp 0", "to": "Ks / Vs (shared)", "label": "finishes its fold first, loops, stages tile kv0 = 32", "kind": "sync"},
    {"from": "Ks / Vs (shared)", "to": "warp 1", "label": "still folding tile 0 — reads rows of tile 1", "kind": "reply"},
    {"from": "warp 1", "to": "warp 1", "label": "scores mix two tiles: wrong O, varies run to run", "kind": "sync"}
  ]
}
:::

**Causal tile skipping.** Under the causal mask query \`i\` sees keys \`0 … i\`. Masking is per element, but
whole tiles can be dropped: with \`q_last = min(blockIdx.x × BQ + BQ, T) − 1\`, a tile with
\`kv0 > q_last\` is entirely above the diagonal, so \`if (causal && kv0 > q_last) break;\` ends the loop.

- The condition depends on \`blockIdx\` only, so every thread of the block breaks together and no
  \`__syncthreads()\` is reached by half a block — which would be undefined behaviour.
- Tiles straddling the diagonal keep the per-element test \`causal && key > row\` → \`-INFINITY\`.
- Roughly half the tiles of a causal head are never loaded; the drill's causal timing reflects it.
- Threads with \`row ≥ T\` skip the arithmetic but still load and reach every barrier, for the same reason.

:::quiz
Q: Why must the causal skip be decided per block rather than per thread?
- [ ] Per-thread decisions would produce the wrong mask
- [x] A thread that leaves the loop early would miss a __syncthreads() its block-mates still wait on
- [ ] Shared memory cannot be read after a break
> The tile loop contains barriers, and every thread of a block must reach the same barriers. A block-uniform condition keeps the block in lockstep; the per-thread mask is applied by writing -INFINITY instead of branching around the barrier.
:::

# The backward pass: recompute rather than store

Training needs gradients, and the gradient of softmax needs \`P\`. Storing it would bring back the \`T × T\`
matrix. FlashAttention stores only \`O\` and one number per row, \`logsumexp = m + log l\`, and in the
backward pass **recomputes** \`S\` and \`P = exp(S − logsumexp)\` tile by tile from \`Q\` and \`K\`.

| Saved for backward | Standard | FlashAttention |
|---|---|---|
| Scores / probabilities | \`T × T\` | none |
| Per-row statistics | none | \`T\` floats (\`logsumexp\`) |
| Extra FLOPs | — | one more \`Q Kᵀ\` |

- The extra matmul costs less than the HBM traffic it replaces, so the backward is faster as well as
  smaller — the same IO argument as the forward.
- \`D_i = rowsum(dO_i ∘ O_i)\` replaces the softmax Jacobian's row sum, so no full row is needed.
- The drill leaves this out; its kernel would need only to write \`m + logf(l)\` beside \`O\`.

:::quiz
Q: Why does FlashAttention recompute the attention probabilities in the backward pass instead of saving them?
- [x] Saving them costs T × T memory and HBM traffic that outweigh one extra matmul
- [ ] The probabilities change between the forward and backward pass
- [ ] Recomputation is required for numerical stability
> Recompute trades cheap FLOPs for expensive bytes. With logsumexp per row, P is exactly reconstructible tile by tile, so nothing quadratic is ever stored.
:::

# What FlashAttention-2 and -3 add

The drill keeps the algorithm and simplifies the hardware mapping: one thread per row, float, CUDA
cores. Production kernels keep the tiles, the online softmax and the causal skip and change who does
which work:

| | FlashAttention | [FlashAttention-2](https://arxiv.org/abs/2307.08691) | [FlashAttention-3](https://arxiv.org/abs/2407.08608) |
|---|---|---|---|
| Loop order | outer over K/V, inner over Q | outer over Q blocks, inner over K/V | same as FA-2 |
| Parallelism | batch × heads | + sequence (Q blocks) | + producer/consumer warpgroups |
| Within a block | warps split K/V, reduce via shared memory | warps split Q, no cross-warp reduction | warp specialisation, TMA loads |
| Normalisation | rescale O every tile | keep O unnormalised, divide once | same, overlapped with matmul |
| Matmuls | tensor cores, fp16/bf16 | tensor cores, \`mma.sync\` | Hopper \`wgmma\`, async, FP8 option |
| Reported utilisation | ~25–40% of A100 peak | ~50–73% of A100 peak | up to ~75% of H100 peak (FP16) |

- **Fewer non-matmul FLOPs.** FA-2 drops per-tile normalisation (as the drill does) because exponentials
  and divides run at a small fraction of tensor-core throughput.
- **Work partitioning.** Parallelising over query blocks fills the GPU even at batch 1 with long
  sequences; giving each warp its own query rows removes shared-memory reductions.
- **Asynchrony.** FA-3 lets producer warps load the next tile with TMA while consumer warps compute, and
  ping-pongs the softmax of one warpgroup against the matmul of another.
- **Frameworks.** PyTorch's [\`scaled_dot_product_attention\`](https://pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
  chooses a FlashAttention or memory-efficient backend; FlexAttention generates masked variants from a
  Python function; inference engines add paged KV-cache layouts.

:::quiz
Q: What is FlashAttention-2's main change relative to the original kernel?
- [ ] It approximates the softmax to save FLOPs
- [x] It parallelises over query blocks and splits work across warps by query rows, cutting non-matmul work
- [ ] It stores the score matrix in L2 cache
> FA-2 is the same exact algorithm with a better mapping: query blocks as an extra grid axis, warps that own rows so their reductions stay in registers, and one normalisation at the end.
:::

# What to take away

- Attention is bound by HBM bandwidth, not FLOPs; IO-awareness means counting bytes moved.
- The online softmax identity lets a row be finished tile by tile: running max, running sum, and one
  rescale \`alpha = exp(m_old − m_new)\` of the accumulator.
- Tiles of \`K\`/\`V\` in shared memory are read once per block of queries; two barriers fence each tile's
  lifetime, and the causal skip must be block-uniform.
- The backward pass recomputes probabilities from \`logsumexp\` instead of storing \`T × T\` values.
- FA-2 and FA-3 keep the algorithm and add work partitioning, warp specialisation and tensor-core
  asynchrony.

Primary reference: Dao et al., [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135).
`;
