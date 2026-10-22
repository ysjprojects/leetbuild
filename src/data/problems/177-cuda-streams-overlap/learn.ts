/**
 * The learning guide for the streams-overlap problem: pageable versus pinned host memory and the copy
 * engines, streams as ordered queues and the legacy default stream that serialises them, events for
 * timing and for cross-stream dependencies, how chunk count and size bound the speedup, and what
 * production adds (non-blocking streams, CUDA Graphs, pinned DataLoader buffers). Rendered at
 * \`/cuda-streams-overlap/learn\`.
 */
export const learn = `# The mechanism at a glance

A discrete GPU has separate engines that can run at the same time: the **SMs** that execute kernels and
one or two **copy engines** (DMA units) that move bytes across PCIe or NVLink without the SMs or the host
CPU. A program that does \`cudaMemcpy\` in, kernel, \`cudaMemcpy\` out keeps one of them busy at a time.
Overlapping them needs three things together: host memory the copy engine can read directly
(**pinned**), work split into independent queues (**streams**), and markers that time the work and order
one queue after another without stopping the host (**events**).

The figure is the schedule the host enqueues: four chunks, each on its own stream, each stream a queue
holding its chunk's copy in, two kernels and copy out. The only edges between streams are the dashed
events: chunk \`c\`'s \`add_carry\` waits for \`computed[c − 1]\`, recorded after chunk \`c − 1\`'s \`add_carry\`.

:::gpu
{
  "items": [
    {"id": "stream-0", "label": "Stream 0", "sub": "chunk 0 · streams[0]", "layout": "column", "detail": "A FIFO: its operations run in issue order. Different streams have no order between them except the events they wait on.", "items": [
      {"id": "h2d-0", "label": "H2D chunk 0", "sub": "cudaMemcpyAsync", "tone": "compute", "detail": "On the H2D copy engine; the call returns in microseconds."},
      {"id": "heavy-0", "label": "heavy", "sub": "<<<4096, 256, 0, s0>>>", "tone": "compute", "detail": "On the SMs: 64 sinf iterations per element of chunk 0."},
      {"id": "carry-0", "label": "add_carry", "sub": "carry = null", "tone": "compute", "detail": "No carry for chunk 0; cudaEventRecord(computed[0], s0) right after."},
      {"id": "d2h-0", "label": "D2H chunk 0", "sub": "then record landed[0]", "tone": "compute", "detail": "On the D2H copy engine, then the landing-time event."}
    ]},
    {"id": "stream-1", "label": "Stream 1", "sub": "chunk 1 · streams[1]", "layout": "column", "items": [
      {"id": "h2d-1", "label": "H2D chunk 1", "sub": "cudaMemcpyAsync", "tone": "compute"},
      {"id": "heavy-1", "label": "heavy", "sub": "<<<4096, 256, 0, s1>>>", "tone": "compute", "detail": "Touches only chunk 1, so it waits for nothing but its own copy."},
      {"id": "carry-1", "label": "add_carry", "sub": "after wait computed[0]", "tone": "compute", "detail": "cudaStreamWaitEvent(s1, computed[0], 0) first, then adds d_out[off − 1], the last output of chunk 0."},
      {"id": "d2h-1", "label": "D2H chunk 1", "sub": "then record landed[1]", "tone": "compute"}
    ]},
    {"id": "stream-2", "label": "Stream 2", "sub": "chunk 2 · streams[2]", "layout": "column", "items": [
      {"id": "h2d-2", "label": "H2D chunk 2", "sub": "cudaMemcpyAsync", "tone": "compute"},
      {"id": "heavy-2", "label": "heavy", "sub": "<<<4096, 256, 0, s2>>>", "tone": "compute"},
      {"id": "carry-2", "label": "add_carry", "sub": "after wait computed[1]", "tone": "compute"},
      {"id": "d2h-2", "label": "D2H chunk 2", "sub": "then record landed[2]", "tone": "compute"}
    ]},
    {"id": "stream-3", "label": "Stream 3", "sub": "chunk 3 · streams[3]", "layout": "column", "items": [
      {"id": "h2d-3", "label": "H2D chunk 3", "sub": "cudaMemcpyAsync", "tone": "compute"},
      {"id": "heavy-3", "label": "heavy", "sub": "<<<4096, 256, 0, s3>>>", "tone": "compute"},
      {"id": "carry-3", "label": "add_carry", "sub": "after wait computed[2]", "tone": "compute"},
      {"id": "d2h-3", "label": "D2H chunk 3", "sub": "then record landed[3]", "tone": "compute"}
    ]}
  ],
  "arrows": [
    {"from": "carry-0", "to": "carry-1", "label": "computed[0]", "dashed": true},
    {"from": "carry-1", "to": "carry-2", "label": "computed[1]", "dashed": true},
    {"from": "carry-2", "to": "carry-3", "label": "computed[2]", "dashed": true}
  ]
}
:::

The contract, in one file \`streams_pipeline.cu\`:

- \`N = 1 << 22\` floats (16 MiB) in \`NSTREAMS = 4\` chunks of \`CHUNK = N / NSTREAMS\`, \`BLOCK = 256\`,
  \`GRID = (CHUNK + BLOCK − 1) / BLOCK\`.
- \`heavy(in, out, n)\`: \`ITERS = 64\` iterations of \`e = m + ECC * sinf(e)\` per element (\`ECC = 0.5f\`) —
  compute-heavy on purpose, so a chunk's copies have something to hide under.
- \`add_carry(out, carry, n)\`: adds the previous chunk's last output \`d_out[off − 1]\` (null for chunk 0) —
  the one read that crosses streams.
- \`run_pipelined(h_in, h_out, d_in, d_out, chunk_ms)\`: per chunk on its own stream, \`cudaMemcpyAsync\` H2D,
  \`heavy\`, \`cudaStreamWaitEvent(s, computed[c − 1], 0)\`, \`add_carry\`, \`cudaEventRecord(computed[c], s)\`,
  \`cudaMemcpyAsync\` D2H, \`cudaEventRecord(landed[c], s)\`; then synchronise, time, destroy.
- \`main\`: \`h_in\`/\`h_out\` from \`cudaMallocHost\`, a synchronous single-stream \`run_baseline\` timed the same
  way, \`PASS\` when both max abs errors are below \`1e-4\` and the speedup exceeds 1.2×.

The same shape is under PyTorch's \`DataLoader(pin_memory=True)\` with \`.to(device, non_blocking=True)\`,
under CPU offload of optimizer states and KV-cache pages, and under NCCL overlapping the all-reduce of one
layer's gradients with the backward pass of the next.

# Pageable memory, pinned memory and the copy engine

A copy engine does DMA: it reads physical pages directly. Ordinary \`malloc\`/\`new\` memory is
**pageable** — the OS may move or swap a page at any time — so the driver cannot hand its address to the
DMA unit. It copies the data with the CPU into a small pinned staging buffer of its own, DMAs that, and
repeats. The [Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#asynchronous-and-overlapping-transfers-with-computation)
puts the consequence plainly: \`cudaMemcpyAsync\` needs pinned host memory to be asynchronous.

| Host buffer | Allocated with | What \`cudaMemcpyAsync\` does | Overlap with a kernel |
| --- | --- | --- | --- |
| pageable | \`malloc\`, \`new\`, \`std::vector\` | CPU stages through a driver buffer; the call returns only once the data is staged (D2H: once it has arrived) | none — the host is busy, the next chunk is not enqueued |
| pinned | \`cudaMallocHost\`, \`cudaHostAlloc\` | queues a DMA on the stream and returns in microseconds | yes, with the other stream's kernel |
| registered | \`cudaHostRegister\` on existing memory | as pinned, after pinning the pages in place | yes |

- Pinned copies are also **faster**, close to the link's rate (about 25 GB/s on PCIe 4 ×16), because there
  is no CPU staging pass.
- The call from pageable memory still returns \`cudaSuccess\`. Nothing reports that the overlap was lost;
  only the timeline shows it, which is why the program times both versions.
- Pinned pages cannot be swapped. Pinning gigabytes starves the OS, so allocate pinned buffers once, reuse
  them, and release them with \`cudaFreeHost\` — never \`free\`.

With pinned buffers on both sides, one moment of the pipeline looks like this: the H2D engine moves chunk
2 in, the SMs compute chunk 1, the D2H engine moves chunk 0 out, and the CPU is idle.

:::gpu
{
  "items": [
    {"id": "host", "label": "Host", "sub": "cudaMallocHost · pinned", "tone": "host", "layout": "column", "detail": "Page-locked, so a copy engine can DMA the pages directly.", "items": [
      {"id": "h-in", "array": "h_in", "sub": "a cell = one 4 MiB chunk", "cols": 4, "cells": ["0", "1", "2", "3"], "tone": "host", "marks": [{"cols": [2, 2], "tone": "global", "label": "H2D now"}]},
      {"id": "h-out", "array": "h_out", "sub": "chunks land in order", "cols": 4, "cells": ["0", "1", "2", "3"], "tone": "host"}
    ]},
    {"id": "gpu", "label": "GPU", "sub": "chunk 2 in, chunk 1 computing, chunk 0 out", "items": [
      {"id": "copy-engines", "label": "Copy engines", "sub": "DMA over PCIe or NVLink", "layout": "column", "items": [
        {"id": "h2d-engine", "label": "H2D copy engine", "sub": "host → device", "tone": "compute", "detail": "Moves chunk c + 1 in while the SMs compute chunk c."},
        {"id": "d2h-engine", "label": "D2H copy engine", "sub": "device → host", "tone": "compute", "detail": "Moves chunk c − 1 out at the same time. With one copy engine both directions share it."}
      ]},
      {"id": "dev-gmem", "label": "Global memory", "sub": "cudaMalloc · 2 × 16 MiB", "tone": "global", "layout": "column", "items": [
        {"id": "d-in", "array": "d_in", "cols": 4, "cells": ["0", "1", "2", "3"], "marks": [{"cols": [1, 1], "tone": "register", "label": "heavy now"}]},
        {"id": "d-out", "array": "d_out", "cols": 4, "cells": ["0", "1", "2", "3"], "marks": [{"cols": [0, 0], "tone": "host", "label": "D2H now"}]}
      ]},
      {"id": "sms", "label": "SMs", "sub": "chunk 1, on stream 1", "tone": "compute", "layout": "column", "items": [
        {"id": "sm-heavy", "label": "heavy", "sub": "64 sinf per element"},
        {"id": "sm-carry", "label": "add_carry", "sub": "+ d_out[off − 1]"}
      ]}
    ]}
  ],
  "arrows": [
    {"from": "h-in", "to": "h2d-engine", "label": "chunk 2"},
    {"from": "h2d-engine", "to": "d-in"},
    {"from": "d-in", "to": "sms", "label": "chunk 1"},
    {"from": "sms", "to": "d-out", "label": "chunk 1"},
    {"from": "d-out", "to": "d2h-engine", "label": "chunk 0"},
    {"from": "d2h-engine", "to": "h-out"}
  ]
}
:::

From pageable memory the H2D arrow would run through the CPU first, and the host would not get back to
enqueue the next chunk until it had.

:::quiz
Q: h_in comes from malloc and every call is cudaMemcpyAsync on its own stream. What does the timeline look like?
- [ ] Fully overlapped — the Async suffix is what makes a copy asynchronous
- [x] Close to the baseline: each H2D call blocks the host while the driver stages the pages, so the next chunk is enqueued late and the copy engine sits behind the CPU
- [ ] An error at the first cudaMemcpyAsync, because pageable memory is not allowed
> Pageable memory is legal for cudaMemcpyAsync but the driver has to copy it through a pinned staging buffer with the CPU first. The call does not return until that is done, so the host cannot run ahead and fill the other streams. The suffix promises asynchrony only for pinned memory.
:::

# Streams are ordered queues; the default stream is a barrier

A [stream](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#streams) is a FIFO of GPU
work. Operations in one stream run in the order they were issued; operations in different streams have
no order between them and may run at the same time on different engines. Every async call names its
stream — the fifth argument of \`cudaMemcpyAsync\`, the fourth of \`<<<grid, block, smem, stream>>>\`. Leave
it out and the work goes to **stream 0**, the legacy default stream, with its implicit synchronisation:
an operation on stream 0 waits for all earlier work in every blocking stream (every stream made by
\`cudaStreamCreate\`), and later work in those streams waits for it. One forgotten argument puts a barrier
in the middle of the schedule:

| Engine (one slot per stage) | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| H2D copy engine | H2D 0 | | | H2D 1 | | |
| SMs | | heavy 0 (stream 0) | | | heavy 1 (stream 0) | |
| D2H copy engine | | | D2H 0 | | | D2H 1 |

Each \`heavy\` on stream 0 waits for everything before it in every stream, and everything after waits for
it: copy, compute, copy, one engine at a time, which is the baseline again.

With every call on its chunk's stream, the copy engines and the SMs pick up different chunks at once:

| Engine (one slot per stage) | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| H2D copy engine | H2D 0 | H2D 1 | H2D 2 | H2D 3 | | |
| SMs | | heavy 0 | heavy 1 | heavy 2 | heavy 3 | |
| D2H copy engine | | | D2H 0 | D2H 1 | D2H 2 | D2H 3 |

The chunks land staggered by one chunk's compute. The table draws every stage the same length; with real
proportions, and with one copy engine instead of two:

:::widget stream-timeline

- The host's loop runs in microseconds: it only enqueues. Twenty-odd calls are submitted before the first
  copy finishes, which is what lets the GPU look ahead.
- Overlap needs a free engine of the right kind. With one copy engine (older or low-end parts,
  \`deviceProp.asyncEngineCount == 1\`) H2D and D2H share it and only copy–compute overlap remains;
  issuing order then matters, as NVIDIA's
  [overlap post](https://developer.nvidia.com/blog/how-overlap-data-transfers-cuda-cc/) shows.
- Two \`heavy\` kernels from different streams can share the SMs only when one leaves room; each here fills
  the GPU, so compute runs chunk after chunk while the copies fill the gaps.

:::quiz
Q: Every copy is cudaMemcpyAsync on streams[c], but add_carry is launched as add_carry<<<GRID, BLOCK>>>. What happens?
- [ ] Nothing changes — kernels run on the SMs whatever stream they are in
- [ ] add_carry runs on stream c because it follows a copy on stream c
- [x] Each add_carry goes to the legacy default stream, which waits for all earlier work in every stream and blocks all later work: the chunks serialise
> A launch without a stream argument is a launch on stream 0. Blocking streams created with cudaStreamCreate synchronise with it in both directions, so every add_carry becomes a device-wide barrier between chunks.
:::

# Events: timing and dependencies without stopping the host

An event is a marker in a stream. \`cudaEventRecord(e, s)\` enqueues it; it **completes** when everything
issued to \`s\` before it has completed. That one primitive does two jobs:

\`\`\`cuda
// 1. a GPU-side dependency: stream s waits for e, the host does not
cudaEventCreateWithFlags(&computed[c], cudaEventDisableTiming);  // no timestamp: cheaper
cudaEventRecord(computed[c - 1], streams[c - 1]);                 // after add_carry of chunk c - 1
cudaStreamWaitEvent(streams[c], computed[c - 1], 0);              // before add_carry of chunk c

// 2. timing on the GPU clock
cudaEventRecord(landed[c], streams[c]);                           // after D2H of chunk c
cudaEventElapsedTime(&chunk_ms[c], start, landed[c]);             // ms since start, ~0.5 µs resolution
\`\`\`

\`add_carry\` of chunk \`c\` reads \`d_out[off − 1]\`, which chunk \`c − 1\`'s stream writes. Without an order
between the two streams the read races the write. The event is the order, and it holds back exactly
one operation: the dashed edge runs from the record in stream 0 to the wait in stream 1, and \`heavy\` of
chunk 1 sits above the wait, free to overlap chunk 0. Drop the wait and \`add_carry\` 1 may read a stale
carry: max abs error far above \`1e-4\`, \`FAIL\`.

:::gpu
{
  "layout": "column",
  "items": [
    {"id": "two-streams", "label": "Chunks 0 and 1", "sub": "enqueued back to back", "align": "start", "items": [
      {"id": "s0", "label": "Stream 0", "layout": "column", "items": [
        {"id": "heavy-0", "label": "heavy · chunk 0", "sub": "<<<4096, 256, 0, s0>>>", "tone": "compute"},
        {"id": "carry-0", "label": "add_carry · chunk 0", "sub": "writes d_out[CHUNK − 1]", "tone": "compute"},
        {"id": "rec-0", "label": "cudaEventRecord", "sub": "computed[0], s0", "detail": "Completes once everything issued to s0 before it, add_carry 0 included, has completed."}
      ]},
      {"id": "s1", "label": "Stream 1", "layout": "column", "items": [
        {"id": "heavy-1", "label": "heavy · chunk 1", "sub": "<<<4096, 256, 0, s1>>>", "tone": "compute", "detail": "Touches only chunk 1, so it is not held back."},
        {"id": "wait-1", "label": "cudaStreamWaitEvent", "sub": "s1, computed[0]", "detail": "Stream 1 waits on the GPU; the host returns at once and keeps enqueueing."},
        {"id": "carry-1", "label": "add_carry · chunk 1", "sub": "reads d_out[CHUNK − 1]", "tone": "compute"}
      ]}
    ]},
    {"id": "dout", "label": "Global memory", "sub": "d_out, chunks 0 and 1", "tone": "global", "stretch": true, "items": [
      {"id": "dout-cells", "array": "d_out", "sub": "a cell = ¼ chunk, numbered by chunk", "cols": 8, "cells": ["0", "0", "0", "0", "1", "1", "1", "1"], "marks": [
        {"cols": [3, 3], "tone": "register", "label": "carry"}
      ], "detail": "The last element of chunk 0 is the one value stream 1 reads from stream 0's output."}
    ]}
  ],
  "arrows": [
    {"from": "rec-0", "to": "wait-1", "label": "computed[0]", "dashed": true}
  ]
}
:::

| Ordering tool | Who waits | Effect on the pipeline |
| --- | --- | --- |
| \`cudaDeviceSynchronize\` | host, for every stream | nothing is enqueued until the GPU drains |
| \`cudaStreamSynchronize(s)\` | host, for one stream | the next chunk is enqueued only after this one finishes |
| \`cudaStreamWaitEvent(s, e)\` | stream \`s\` only, on the GPU | the host keeps enqueueing; only the dependent operation waits |
| synchronous \`cudaMemcpy\` | host, and stream 0 semantics | both of the above at once |

- The wait sits **after** \`heavy\`, not at the top of the chunk: \`heavy\` of chunk \`c\` does not read chunk
  \`c − 1\` and still overlaps it; only \`add_carry\` waits.
- \`computed\` events only order work, so they are created with \`cudaEventDisableTiming\`; \`start\`, \`stop\`
  and \`landed\` carry timestamps.
- The host synchronises once, after the loop — every stream, then \`stop\`. That is the only host wait.

:::quiz
Q: Why is cudaStreamWaitEvent(s, computed[c − 1], 0) placed between heavy and add_carry rather than before chunk c's H2D copy?
- [ ] cudaStreamWaitEvent may only precede a kernel launch, not a copy
- [x] Waiting before the copy would also hold back chunk c's H2D and heavy, which do not depend on chunk c − 1; placed late, only the read of d_out[off − 1] waits
- [ ] Before the copy the event has not been recorded yet, so the wait would deadlock
> A dependency should guard exactly the operation that needs it. Copy and heavy of chunk c touch only chunk c's slices; add_carry is the one consumer of the previous chunk's output. A wait at the top of the chunk would turn the pipeline back into a chain.
:::

# Chunk count and the speedup you can get

With three engines and \`n\` chunks, the pipeline costs the slowest stage plus the fill and drain of the
other two:

\`\`\`text
T_baseline ≈ T_h2d + T_kernel + T_d2h
T_pipe     ≈ T_h2d / n + max(T_h2d, T_kernel, T_d2h) + T_d2h / n      (compute-bound case: max = T_kernel)
\`\`\`

For 16 MiB over about 25 GB/s (0.67 ms each way) and 1.6 ms of \`heavy\`:

| \`NSTREAMS\` | Chunk | \`T_pipe\` | Speedup | Cost |
| --- | --- | --- | --- | --- |
| 1 | 16 MiB | 2.94 ms | 1.0× | no overlap at all |
| 2 | 8 MiB | 2.27 ms | 1.3× | fill and drain are half the copies |
| 4 | 4 MiB | 1.94 ms | 1.5× | the problem's setting |
| 8 | 2 MiB | 1.77 ms | 1.7× | 8 streams, 16 events |
| 64 | 256 KiB | ≈ 1.7 ms | < 1.8× | launch and copy overheads (~5–10 µs each) start to dominate |

- The ceiling is \`T_baseline / max(stage)\`: here 2.94 / 1.6 ≈ 1.8×. More chunks only shrink fill and
  drain toward it.
- If the copies dominated instead, the kernel would hide under them and the bound would be the link.
  Overlap never makes the slowest engine faster.
- Small copies lose bandwidth: each DMA has a fixed setup cost, and below a few hundred KiB the link runs
  well under its peak. Chunks of a few MiB are the usual sweet spot.
- Streams are reused, not one per chunk forever: a long input cycles chunk \`c\` onto
  \`streams[c % NSTREAMS]\`, which also bounds how many device buffers are in flight.

:::quiz
Q: The kernel takes 1.6 ms for the whole array and each copy direction 0.67 ms. Can any number of streams reach a 2.5× speedup over the 2.94 ms baseline?
- [ ] Yes, with 64 or more streams
- [x] No — the SMs still need 1.6 ms, so the best is about 2.94 / 1.6 ≈ 1.8×
- [ ] Yes, if the two heavy kernels run concurrently on the SMs
> Overlap hides the shorter stages under the longest; it cannot shorten the longest. Here that is compute, and concurrent kernels that each fill the GPU still share the same SMs.
:::

# What production adds

The three ingredients stay; the machinery around them grows.

- **Non-blocking streams.** \`cudaStreamCreateWithFlags(&s, cudaStreamNonBlocking)\` or compiling with
  \`--default-stream per-thread\` removes the implicit barrier with stream 0, so a library call that uses
  the default stream cannot serialise your pipeline. PyTorch's \`torch.cuda.Stream\` objects are this kind.
- **CUDA Graphs.** The host still spends microseconds per call; at many small chunks that becomes the
  bottleneck. [CUDA Graphs](https://developer.nvidia.com/blog/cuda-graphs/) capture a whole multi-stream
  schedule — copies, kernels, event edges — once with \`cudaStreamBeginCapture\` and replay it with one
  \`cudaGraphLaunch\`. \`torch.cuda.graphs\` and the decode loops of LLM servers use exactly this.
- **Pinned pools.** Frameworks allocate pinned memory once and recycle it: PyTorch's caching host allocator
  behind \`pin_memory()\`, the \`DataLoader(pin_memory=True)\` worker that copies each batch into it, and
  \`.to(device, non_blocking=True)\` that issues the H2D copy on the current stream.
- **Communication streams.** NCCL runs collectives on their own streams with events toward the compute
  stream, so the all-reduce of one bucket of gradients overlaps the backward pass of the next layers —
  the same \`cudaStreamWaitEvent\` edge as \`add_carry\`'s.

:::details Why the program reports the fastest of three runs
The first run of each version pays one-time costs that are not part of the mechanism: the warm-up launch
already loads the kernel modules, but the first pipelined run also creates streams and events and may
find the copy engines cold. Taking the minimum of \`REPS = 3\` runs measures the steady state, and zeroing
\`h_out\` and \`d_out\` between the two versions makes sure a pipeline that never copies back cannot pass on
the baseline's leftovers.
:::

:::quiz
Q: A training loop calls .to(device, non_blocking=True) on a batch that came from a DataLoader with pin_memory=False. What does non_blocking buy?
- [x] Almost nothing for H2D — the source is pageable, so the copy is staged by the CPU and the host does not run ahead
- [ ] Full overlap, because non_blocking makes PyTorch pin the tensor on the fly before every copy
- [ ] A crash, because non_blocking requires pinned memory
> non_blocking=True becomes cudaMemcpyAsync. From pageable memory that call is legal but staged and effectively synchronous, which is the pageable row of the table above; the batch must be pinned first.
:::

# What to take away

- **Pinned memory is the precondition.** \`cudaMallocHost\` (or \`cudaHostAlloc\`) for every buffer a copy
  should overlap, \`cudaFreeHost\` at the end; from pageable memory \`cudaMemcpyAsync\` silently stages and
  blocks.
- **Name the stream on every call.** The fifth argument of \`cudaMemcpyAsync\`, the fourth of
  \`<<<GRID, BLOCK, 0, s>>>\`; anything without one lands on the legacy default stream and serialises the
  others.
- **Order streams with events, not host syncs.** \`cudaEventRecord\` after the producer,
  \`cudaStreamWaitEvent\` right before the consumer; the host enqueues the whole schedule and waits once.
- **Time with events on the GPU clock.** \`start\`, per-chunk \`landed\`, \`stop\`, \`cudaEventElapsedTime\`; the
  staggered landing times are the proof of overlap.
- **Overlap hides, it does not shrink.** The speedup is bounded by the slowest engine; a few MiB per chunk
  amortises fill, drain and per-call overhead, and CUDA Graphs remove the host's share.

The primary reference is the
[CUDA C++ Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#asynchronous-and-overlapping-transfers-with-computation)
on asynchronous and overlapping transfers; Mark Harris's
[*How to Overlap Data Transfers in CUDA C/C++*](https://developer.nvidia.com/blog/how-overlap-data-transfers-cuda-cc/)
walks the same pipeline on real timelines.
`;
