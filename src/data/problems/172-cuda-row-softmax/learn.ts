/**
 * The learning guide for the row-softmax drill: why softmax is computed as exp(x − max), how one block
 * per row turns the max and the sum into two block reductions (warp shuffles, then shared memory), the
 * fully masked row and the NaN it would produce, the online softmax that fuses both reductions into one
 * pass, and why the kernel is bound by memory bandwidth — a figure or a table where one says it faster
 * than prose, a pop quiz per section. Rendered at \`/cuda-row-softmax/learn\`.
 */
export const learn = `# The mechanism at a glance

Softmax maps a row of logits to a probability distribution: \`y_c = exp(x_c) / Σ_k exp(x_k)\`. A transformer
runs it over every row of the attention scores \`QKᵀ / √d\`, over the vocabulary at the output head, and inside
the cross-entropy loss. On a GPU it is one kernel launch over a \`rows × cols\` matrix, and the whole design
follows from one fact: the formula as written overflows, and the fix needs the row max before the first \`exp\`.

:::diagram
{
  "nodes": [
    {"id": "host", "kind": "client", "label": "Host · main()", "sub": "fills x · row 0 at 1e4 · masks rows 1, 2 · CPU double reference", "x": 8, "y": 50},
    {"id": "kernel", "kind": "service", "label": "softmax_rows<<<rows, 256>>>", "sub": "block r owns row r · pass 1 max · pass 2 sum · pass 3 write", "x": 38, "y": 50},
    {"id": "smem", "kind": "db", "label": "Shared memory", "sub": "s_max[8] · s_sum[8] — one slot per warp", "x": 66, "y": 22},
    {"id": "hbm", "kind": "db", "label": "Global memory", "sub": "x and y · 4096 × 1000 fp32 · 16 MB each", "x": 66, "y": 78}
  ],
  "edges": [
    {"from": "host", "to": "hbm", "kind": "plain", "label": "cudaMemcpy x in · y out"},
    {"from": "host", "to": "kernel", "kind": "plain", "label": "LAUNCH · 50 timed launches"},
    {"from": "kernel", "to": "smem", "kind": "plain", "label": "warp partials · __syncthreads"},
    {"from": "kernel", "to": "hbm", "kind": "plain", "label": "read x row · write y row"}
  ]
}
:::

The contract the drill implements, in one file \`row_softmax.cu\`:

- \`__global__ void softmax_rows(const float* x, float* y, int rows, int cols)\`: row-major fp32,
  \`y[r][c] = exp(x[r][c] − m_r) / Σ_c exp(x[r][c] − m_r)\`, \`m_r = max_c x[r][c]\`, any \`cols\`.
- \`row = blockIdx.x\`; the 256 threads of the block visit \`c = threadIdx.x, threadIdx.x + blockDim.x, …\`
  while \`c < cols\`. The host launches \`LAUNCH(softmax_rows, rows, THREADS, …)\` with \`THREADS = 256\`.
- Pass 1 is a block max (\`fmaxf\`), pass 2 a block sum of \`__expf(x − m)\`, pass 3 writes
  \`__expf(x − m) / sum\`. Both reductions run through warp shuffles, then shared memory.
- A fully masked row (every element \`-inf\`) is written as zeros; no NaN anywhere.
- The self-test: \`4096 × 1000\`, \`U(−3, 3)\`, row 0 at magnitudes of \`1e4\`, row 1 all \`-inf\`, the second half of
  row 2 \`-inf\`; \`max |gpu − cpu| < 1e-5\` against a double reference, \`max |row sum − 1| < 1e-4\`, \`PASS\`.

# Why exp(x − max)

Shifting every logit by the same constant does not change the result — the factor \`exp(−m)\` appears in the
numerator and in every term of the denominator, and cancels:

\`\`\`text
exp(x_c − m) / Σ_k exp(x_k − m)  =  exp(−m)·exp(x_c) / (exp(−m)·Σ_k exp(x_k))  =  exp(x_c) / Σ_k exp(x_k)
\`\`\`

Choosing \`m = max_k x_k\` makes the largest exponent exactly \`0\`. Every term lies in \`(0, 1]\`, at least one
equals \`1\`, so the sum lies in \`[1, cols]\` — it can neither overflow nor underflow to zero. Unshifted, the
numbers break at modest magnitudes:

| Input | \`expf(x)\` in fp32 | Unshifted softmax |
| --- | --- | --- |
| \`x = 80\` | 5.5e34 | fine for one term; a sum of 1000 such terms is still finite |
| \`x = 89\` | \`inf\` (limit ≈ 88.72) | \`inf / inf = NaN\` |
| \`x = 1e4\` (row 0) | \`inf\` | NaN for the whole row |
| \`x = −104\` everywhere | 0 (below the denormals) | \`0 / 0 = NaN\` |

:::sequence
{
  "participants": ["block 0", "global mem"],
  "messages": [
    {"from": "block 0", "to": "global mem", "label": "naive: sum += expf(x[0][c]) — x up to 1e4", "kind": "sync"},
    {"from": "block 0", "to": "block 0", "label": "expf(x) = inf for any x > 88.7 → sum = inf", "kind": "sync"},
    {"from": "block 0", "to": "global mem", "label": "y = inf / inf = NaN, other entries 0 / inf → row 0 garbage", "kind": "sync"},
    {"from": "block 0", "to": "global mem", "label": "shifted: pass 1 finds m ≈ 1e4 first", "kind": "sync"},
    {"from": "block 0", "to": "block 0", "label": "__expf(x − m) ∈ (0, 1], max term = 1 → sum ∈ [1, 1000]", "kind": "sync"},
    {"from": "block 0", "to": "global mem", "label": "y = __expf(x − m) / sum — finite, sums to 1", "kind": "sync"}
  ]
}
:::

The cost of the shift is ordering, not arithmetic: the max is a reduction over the whole row and must finish
before any thread may take an \`exp\`. That is why softmax is two reductions rather than one. Frameworks
compute it this way everywhere — the [PyTorch softmax](https://pytorch.org/docs/stable/generated/torch.nn.functional.softmax.html)
kernels, cuDNN, and the \`logsumexp\` inside \`cross_entropy\`, which is \`m + log Σ exp(x − m)\` for the same reason.

:::quiz
Q: Row 0 of the self-test has magnitudes up to 1e4. After the shift, what is the range of the denominator?
- [ ] (0, 1] — every term is at most 1
- [x] [1, 1000] — the max element contributes exactly exp(0) = 1, and there are 1000 terms each at most 1
- [ ] Unbounded — 1e4 still overflows after the shift
> The shift pins the largest exponent at 0, so one term is exactly 1 and none exceeds it. The denominator is therefore at least 1 (no division by a tiny number) and at most cols (no overflow), whatever the input scale.
:::

# One block per row, two block reductions

A row of 1000 floats is 4 KB — one block of 256 threads covers it in four strided rounds. Mapping one block
to one row means each reduction stays inside the block: no global atomics, no second launch, no other block
to wait for. Threads stride by \`blockDim.x\`, so on each round the 32 lanes of a warp read 32 consecutive
floats — one coalesced 128-byte transaction.

A block reduction has two levels:

1. **Within a warp**, in registers. Five rounds of
   [warp shuffles](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#warp-shuffle-functions)
   halve the distance: \`v = fmaxf(v, __shfl_xor_sync(0xffffffff, v, offset))\` for \`offset = 16, 8, 4, 2, 1\`.
   With \`xor\` the exchange is a butterfly and every lane ends holding the warp's result; with
   \`__shfl_down_sync\` only lane 0 does, which is enough here.
2. **Across warps**, through shared memory. Lane 0 of each of the 8 warps writes its partial to
   \`shared[warp]\`, \`__syncthreads()\`, warp 0 loads the 8 partials (the identity, \`-INFINITY\` or \`0.f\`, for
   lanes 8–31), warp-reduces again, thread 0 writes \`shared[0]\`, a second \`__syncthreads()\`, and every thread
   reads the result.

:::sequence
{
  "participants": ["warps 0–7", "s_max[8]", "warp 0"],
  "messages": [
    {"from": "warps 0–7", "to": "warps 0–7", "label": "local max over c = t, t+256, t+512, t+768", "kind": "sync"},
    {"from": "warps 0–7", "to": "warps 0–7", "label": "fmaxf + __shfl_xor_sync, offsets 16 … 1 → 8 warp maxima", "kind": "sync"},
    {"from": "warps 0–7", "to": "s_max[8]", "label": "lane 0 writes s_max[warp]", "kind": "sync"},
    {"from": "warps 0–7", "to": "warps 0–7", "label": "__syncthreads() — all 8 slots written", "kind": "sync"},
    {"from": "s_max[8]", "to": "warp 0", "label": "lanes 0–7 load partials, lanes 8–31 load -INFINITY", "kind": "reply"},
    {"from": "warp 0", "to": "s_max[8]", "label": "warp_max → thread 0 writes s_max[0] = m", "kind": "sync"},
    {"from": "warps 0–7", "to": "warps 0–7", "label": "__syncthreads() — m published", "kind": "sync"},
    {"from": "s_max[8]", "to": "warps 0–7", "label": "every thread reads m", "kind": "reply"}
  ]
}
:::

The sum is the same shape with \`+\` and identity \`0\`. Each barrier guards one hand-off; drop either and a
warp reads a slot before another warp has written it.

| Level | Mechanism | Rounds for 256 threads | Synchronisation |
| --- | --- | --- | --- |
| Thread | strided loop over the row | ⌈cols / 256⌉ = 4 | none |
| Warp | \`__shfl_xor_sync\` | 5 | implicit in the \`_sync\` mask |
| Block | \`__shared__\` slots + warp 0 | 1 write, 5 shuffles | two \`__syncthreads()\` |

:::details Why the max and the sum get separate shared slots
After the max reduction, every thread reads \`s_max[0]\` — but a fast warp that has finished reading may race
ahead into the sum reduction and its lane 0 may write its partial sum before a slow warp has read the max. If
both reductions used the same array, warp 0's \`shared[0] = partial_sum\` could overwrite \`m\` under a reader
that has not got there yet. Separate arrays (\`s_max\`, \`s_sum\`) remove the race at the cost of 32 bytes; the
alternative is a third \`__syncthreads()\` between the two reductions.
:::

:::quiz
Q: Warp 0 reduces the 8 warp partials with a full 32-lane warp_max. What must lanes 8–31 load?
- [ ] s_max[lane] — the array is zero-initialised
- [x] -INFINITY, the identity of max (and 0 for the sum)
- [ ] Nothing — they can skip the shuffle
> Shared memory is not initialised, and the shuffle with mask 0xffffffff needs all 32 lanes to participate. Lanes past the warp count must contribute a value that cannot change the result: fmaxf(v, -inf) = v and v + 0 = v.
:::

# The masked row

Attention masks are written into the logits as \`-inf\`: \`exp(-inf) = 0\`, so masked positions get zero
probability. A **partially masked** row — a causal mask cutting off the second half, as row 2 does — is
ordinary: \`m\` is finite, \`exp(-inf − m) = 0\`, the rest normalises. A **fully masked** row is not. Padding
can mask every key for a query (an all-padding sequence, an empty segment), and then:

:::sequence
{
  "participants": ["block 1", "global mem"],
  "messages": [
    {"from": "global mem", "to": "block 1", "label": "x[1][c] = -inf for all c", "kind": "reply"},
    {"from": "block 1", "to": "block 1", "label": "pass 1: m = fmaxf over -inf = -inf", "kind": "sync"},
    {"from": "block 1", "to": "block 1", "label": "naive pass 2: __expf(-inf − (-inf)) = __expf(NaN) = NaN", "kind": "sync"},
    {"from": "block 1", "to": "global mem", "label": "y[1][c] = NaN → NaN loss, NaN gradients, the run is dead", "kind": "sync"},
    {"from": "block 1", "to": "block 1", "label": "guarded: if (m == -INFINITY) m = 0 → __expf(-inf) = 0, sum = 0", "kind": "sync"},
    {"from": "block 1", "to": "global mem", "label": "inv = sum > 0 ? 1 / sum : 0 → y = 0 × 0 = 0", "kind": "sync"}
  ]
}
:::

| Row | m | sum | Without guards | With guards |
| --- | --- | --- | --- | --- |
| ordinary (row 3 …) | finite | ≥ 1 | correct | correct |
| half masked (row 2) | finite | ≥ 1 | correct, masked half is 0 | same |
| fully masked (row 1) | \`-inf\` | NaN or 0 | NaN everywhere | zeros |

Mathematically a fully masked softmax is undefined; zeros is the convention that keeps the rest of the
network finite — the attention output for that query is a zero vector instead of NaN. Two guards are needed
because they cover different failures: the shift guard stops \`-inf − (-inf)\`, the division guard stops
\`0 / 0\`. PyTorch's own \`softmax\` returns NaN here; FlashAttention's kernels special-case it the way this
drill does, shifting by 0 when the running max is \`-inf\`.

:::quiz
Q: Row 2 has its second half set to -inf. Does it need the masked-row guard?
- [ ] Yes — any -inf in the row produces NaN
- [x] No — m is the max of the unmasked half, finite, so exp(-inf − m) = 0 and the sum is at least 1
- [ ] Yes — the sum over the masked half is 0, so the division fails
> NaN needs -inf − (-inf), which only happens when m itself is -inf, i.e. when every element is masked. A partial mask leaves m finite, the masked entries become exact zeros, and the unmasked ones normalise as usual.
:::

# Online softmax: one pass instead of two

The kernel reads the row three times: max, sum, write. Milakov and Gimelshein,
[Online normalizer calculation for softmax](https://arxiv.org/abs/1805.02867) (2018), fold the first two into
one pass by keeping a **running** max and rescaling the running sum each time the max moves:

\`\`\`text
m = -inf, d = 0
for each x_j:
    m_new = max(m, x_j)
    d     = d · exp(m − m_new) + exp(x_j − m_new)
    m     = m_new
y_c = exp(x_c − m) / d
\`\`\`

The invariant is \`d = Σ_{k ≤ j} exp(x_k − m)\` after every step. Two partial states \`(m_a, d_a)\` and
\`(m_b, d_b)\` combine associatively — \`m = max(m_a, m_b)\`, \`d = d_a·exp(m_a − m) + d_b·exp(m_b − m)\` — so the
online version is still a single block reduction, of a pair instead of a scalar.

| | Three-pass (this drill) | Online (two-pass) |
| --- | --- | --- |
| Reads of x | 3 (two hit L1/L2) | 2 |
| Reductions | max, then sum | one, over (m, d) pairs |
| \`exp\` per element | 2 | 3 (two in the fused pass, one in the write) |
| Masked-row hazard | \`-inf − (-inf)\` once | the same, in every rescale — needs the same guard |

For a 4 KB row that sits in cache the saving is small. The idea matters where the row does **not** fit:
FlashAttention never materialises a row of \`QKᵀ\` at all, computing it tile by tile and keeping \`(m, d)\` and
an output accumulator that is rescaled by \`exp(m_old − m_new)\` whenever a new tile raises the max.

:::quiz
Q: In the online update, why is d multiplied by exp(m − m_new)?
- [ ] To normalise d to 1 after every element
- [x] d was accumulated relative to the old max; multiplying by exp(m − m_new) re-expresses every term relative to the new one
- [ ] To keep d below the overflow threshold of expf
> Each term in d is exp(x_k − m). When the max becomes m_new, the correct term is exp(x_k − m_new) = exp(x_k − m)·exp(m − m_new), so the whole sum is rescaled by that one factor. When the max does not change the factor is exp(0) = 1.
:::

# Memory-bound by construction

Per element the kernel does a compare, two \`__expf\` (a hardware approximation on the special-function
units), an add and a multiply — a handful of operations against 8 bytes of DRAM traffic (4 read, 4 written).
That is far below the arithmetic intensity at which an A100 or H100 becomes compute-bound, so the only number
that matters is bytes moved per second.

| Quantity | Value for 4096 × 1000 fp32 |
| --- | --- |
| x read from DRAM | 16.4 MB (once; passes 2 and 3 hit L1/L2) |
| y written | 16.4 MB |
| Total DRAM traffic | 32.8 MB |
| Ideal time at 3.35 TB/s (H100 SXM) | ≈ 10 µs |
| Ideal time at 2.0 TB/s (A100 80 GB) | ≈ 16 µs |

- The self-test reports \`2 · n · 4\` bytes over the measured time — the right denominator only because the
  re-reads are cached. A 4 KB row per block, a few blocks per SM, fits comfortably in L1.
- Coalescing is what makes the bound reachable: consecutive lanes read consecutive floats on every round.
- 4096 blocks keep every SM busy; with a handful of rows (one block each) most SMs would idle, which is when
  libraries split a row across blocks or switch to a different mapping.
- For short rows (\`cols ≤ 1024\`) PyTorch uses a variant that keeps the row in registers across all passes
  and maps rows to warps; the [Triton fused-softmax tutorial](https://triton-lang.org/main/getting-started/tutorials/02-fused-softmax.html)
  shows the same kernel in a few lines and benchmarks it against \`torch.softmax\`.

The real win is fusion: softmax inside attention moves the \`rows × cols\` score matrix through DRAM twice
more than necessary, which is what FlashAttention removes.

:::quiz
Q: Pass 3 recomputes __expf(x − m) instead of storing the pass-2 values. Why is that the cheaper choice here?
- [ ] __expf is free — it is computed at compile time
- [x] The kernel is memory-bound; recomputing re-reads x from L1/L2 and spends a few SFU cycles, whereas storing the values would need registers or extra DRAM traffic
- [ ] Storing them would overflow the fp32 range
> Arithmetic is idle capacity in a bandwidth-bound kernel. Recomputing the exponent costs cycles the GPU had to spare; keeping 1000 values per row would need either 4 registers per thread (fine for short rows, which is the register-resident variant) or a round trip through memory.
:::

# What to take away

- \`exp(x − m) / Σ exp(x − m)\` equals \`exp(x) / Σ exp(x)\`, but its largest exponent is 0: no overflow, and a
  denominator in \`[1, cols]\`. The max must therefore be known before the first \`exp\`.
- One block per row makes the max and the sum block reductions: warp shuffles in registers, then one slot per
  warp in shared memory between two \`__syncthreads()\`, with separate slots for the two reductions.
- A fully masked row gives \`-inf − (-inf) = NaN\`; shift by 0 when \`m == -INFINITY\` and multiply by 0 when the
  sum is 0, so the row is zeros.
- Online softmax keeps \`(m, d)\` and rescales \`d\` by \`exp(m − m_new)\`, fusing the two reductions into one —
  the recurrence FlashAttention runs over tiles.
- The kernel is memory-bound: 8 bytes per element, coalesced, re-reads served from cache.

Primary reference: Milakov and Gimelshein, [Online normalizer calculation for softmax](https://arxiv.org/abs/1805.02867).
`;
