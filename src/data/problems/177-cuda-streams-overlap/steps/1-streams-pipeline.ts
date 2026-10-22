import type {Step} from '@/lib/types';

/** A four-argument launch: `name<<<grid, block, smem, stream>>>` — the kernel is bound to a stream. */
const launchOnStream = (kernel: string): RegExp => new RegExp(`${kernel}<<<[^>]*,[^>]*,[^>]*,[^>]*>>>`);

/** `cudaMemcpyAsync(…, kind, stream)` with an explicit fifth argument; without it the copy lands on stream 0. */
const asyncCopy = (kind: string): RegExp => new RegExp(`cudaMemcpyAsync\\([^;]*${kind}\\s*,\\s*[^;)]+\\)`);

/** A synchronous `cudaMemcpy(` anywhere in the body of `run_pipelined` (up to its closing brace at column 0). */
const SYNC_COPY_IN_PIPELINE = /run_pipelined\([^{]*\{(?:(?!\n\})[\s\S])*?cudaMemcpy\(/;

export const streamsPipelineStep: Step = {
  id: 'streams-pipeline',
  title: 'run_pipelined(): NSTREAMS chunks in flight, one event between neighbours',
  concept: 'cuda',
  file: 'streams_pipeline',
  focus: ['host', 'copy', 'sm', 'dmem'],
  task: `## Task

Process \`N = 1 << 22\` floats in \`NSTREAMS = 4\` chunks of \`CHUNK = N / NSTREAMS\` through two kernels,
with every chunk's copies and kernels on its own stream, so that the copy engines move chunk \`c + 1\` in
and chunk \`c − 1\` out while the SMs compute chunk \`c\`. A synchronous single-stream version of the same
work is the baseline; the program times both with events, prints the speedup, validates both against the
CPU and prints \`PASS\`.

- **Kernels.** \`heavy(const float* in, float* out, int n)\`: for each element solve Kepler's equation
  \`E = M + ECC · sin E\` by \`ITERS = 64\` fixed-point iterations of \`e = m + ECC * sinf(e)\` starting from
  \`e = m\` (\`ECC = 0.5f\`), and write \`e\`. \`add_carry(float* out, const float* carry, int n)\`: add
  \`*carry\` to every element when \`carry\` is not null — the carry is the **last output of the previous
  chunk** (\`d_out + off − 1\`), null for chunk 0. Launch both with \`BLOCK = 256\` threads and
  \`GRID = (CHUNK + BLOCK − 1) / BLOCK\` blocks.
- **Pinned host memory.** \`h_in\` and \`h_out\` come from \`cudaMallocHost\` (or \`cudaHostAlloc\`) and go
  back with \`cudaFreeHost\`; no \`malloc\`/\`new\` for them — a copy from pageable memory is staged
  through a driver buffer and is **not** asynchronous.
- **\`run_baseline(h_in, h_out, d_in, d_out) → ms\`** (given): for each chunk, synchronous \`cudaMemcpy\`
  H2D, \`heavy\`, \`add_carry\`, synchronous \`cudaMemcpy\` D2H, on the default stream; timed between two
  events.
- **\`run_pipelined(h_in, h_out, d_in, d_out, chunk_ms) → ms\`**: create \`NSTREAMS\` streams, per chunk one
  \`computed\` event (\`cudaEventDisableTiming\`) and one \`landed\` event, plus \`start\`/\`stop\`. Record
  \`start\`; then for chunk \`c\` on stream \`c\`: \`cudaMemcpyAsync\` H2D **with the stream as fifth
  argument**, \`heavy<<<GRID, BLOCK, 0, s>>>\`, for \`c > 0\` \`cudaStreamWaitEvent(s, computed[c − 1], 0)\`,
  \`add_carry<<<GRID, BLOCK, 0, s>>>\`, \`cudaEventRecord(computed[c], s)\`, \`cudaMemcpyAsync\` D2H on \`s\`,
  \`cudaEventRecord(landed[c], s)\`. After the loop \`cudaStreamSynchronize\` every stream, record \`stop\`,
  fill \`chunk_ms[c]\` with \`cudaEventElapsedTime(start, landed[c])\`, return the \`start → stop\` time,
  and destroy every stream and event. No synchronous \`cudaMemcpy\` and no host-side synchronisation
  inside the loop.
- **Self-test** (kept in the file): fills \`h_in[i] = (i % 1000) · 0.00628 − 3.14\`, computes the CPU
  reference, warms both kernels up once, runs each version \`REPS = 3\` times and keeps the fastest,
  prints both times, the per-chunk landing times, the speedup, and \`PASS\` when both max abs errors are
  below \`1e-4\` (a speedup at or below \`1.2×\` prints a warning: it depends on the GPU's copy engines and link); the host output is zeroed between the two versions so a
  pipeline that never copies back cannot pass.

> One stream serialises copies and kernels; several streams let the copy engines and the SMs work on
> different chunks at once — and an event, not a host sync, is how chunk \`c\` learns that chunk \`c − 1\`
> is done.`,
  sequence: {
    participants: ['host', 'stream 0', 'stream 1', 'GPU'],
    messages: [
      {
        from: 'host',
        to: 'stream 0',
        label: 'cudaMemcpyAsync H2D chunk 0 · heavy · add_carry · record computed[0] · D2H · record landed[0]',
        kind: 'async',
      },
      {
        from: 'host',
        to: 'stream 1',
        label:
          'cudaMemcpyAsync H2D chunk 1 · heavy · cudaStreamWaitEvent(computed[0]) · add_carry · D2H · record landed[1]',
        kind: 'async',
      },
      {from: 'stream 0', to: 'GPU', label: 'copy engine: H2D 0 → SMs: heavy 0', kind: 'sync'},
      {from: 'stream 1', to: 'GPU', label: 'copy engine: H2D 1 while SMs run heavy 0; then heavy 1', kind: 'sync'},
      {
        from: 'stream 0',
        to: 'stream 1',
        label: 'computed[0] fires → add_carry 1 may read d_out[CHUNK − 1]',
        kind: 'async',
      },
      {from: 'stream 0', to: 'host', label: 'landed[0]: chunk 0 is in h_out (D2H overlapped heavy 1)', kind: 'reply'},
      {from: 'stream 1', to: 'host', label: 'landed[1]', kind: 'reply'},
      {
        from: 'host',
        to: 'GPU',
        label: 'cudaStreamSynchronize × NSTREAMS · record stop · cudaEventElapsedTime',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The pinned buffers are the precondition: `cudaMallocHost(&h_in, bytes)` for both host arrays, `cudaFreeHost` at the end. With pageable memory `cudaMemcpyAsync` silently degrades to a staged, host-blocking copy and nothing overlaps.',
    'Per chunk, everything goes on `streams[c]`: `cudaMemcpyAsync(d_in + off, h_in + off, bytes, cudaMemcpyHostToDevice, s)`, `heavy<<<GRID, BLOCK, 0, s>>>`, `add_carry<<<GRID, BLOCK, 0, s>>>`, `cudaMemcpyAsync(h_out + off, d_out + off, bytes, cudaMemcpyDeviceToHost, s)`. A launch without the fourth `<<<>>>` argument goes to stream 0, which the other streams wait for.',
    'The dependency is two calls: `cudaEventRecord(computed[c], s)` right after `add_carry` of chunk `c`, and `cudaStreamWaitEvent(s, computed[c - 1], 0)` right before `add_carry` of chunk `c + 1` — after `heavy`, so `heavy` still overlaps. Record `landed[c]` after the D2H copy and `cudaEventElapsedTime(&chunk_ms[c], start, landed[c])` gives the timeline.',
  ],
  checks: [
    {
      id: 'pinned-host',
      title: 'Host buffers are pinned',
      detail:
        '`h_in` and `h_out` are allocated with `cudaMallocHost` or `cudaHostAlloc`, not `malloc`/`new`: only page-locked memory can be read by the copy engine directly, so only then is `cudaMemcpyAsync` asynchronous with respect to the host and able to overlap a kernel.',
      match: {
        cuda: {
          all: [/cudaMallocHost\(|cudaHostAlloc\(/],
          none: [/(?<![\w.])malloc\(/, /\bnew\s+float\s*\[/],
        },
      },
    },
    {
      id: 'async-copies',
      title: 'Both copy directions are asynchronous and bound to a stream',
      detail:
        'A `cudaMemcpyAsync(…, cudaMemcpyHostToDevice, stream)` and a `cudaMemcpyAsync(…, cudaMemcpyDeviceToHost, stream)` with an explicit stream argument. Without the fifth argument the copy is enqueued on stream 0 and serialises against every other stream.',
      match: {
        cuda: {all: [asyncCopy('cudaMemcpyHostToDevice'), asyncCopy('cudaMemcpyDeviceToHost')]},
      },
    },
    {
      id: 'kernel-on-stream',
      title: 'Both kernels launch on the chunk’s stream',
      detail:
        '`heavy<<<GRID, BLOCK, 0, s>>>` and `add_carry<<<GRID, BLOCK, 0, s>>>` with the stream as the fourth launch argument. A two-argument launch goes to the default stream, which the copy streams synchronise with — the pipeline collapses to the baseline.',
      match: {cuda: {all: [launchOnStream('heavy'), launchOnStream('add_carry')]}},
    },
    {
      id: 'event-dependency',
      title: 'Chunk c’s add_carry waits on chunk c − 1 through an event',
      detail:
        '`cudaStreamWaitEvent(s, computed[c - 1], 0)` sits before `add_carry<<<…, s>>>`, and `cudaEventRecord(computed[c], s)` after it, both inside the chunk loop: the read of `d_out[off - 1]` is ordered after the previous stream’s write without blocking the host or the other streams.',
      match: {
        cuda: {
          all: [/cudaStreamWaitEvent\(/],
          order: [/cudaStreamWaitEvent\(/, launchOnStream('add_carry'), /cudaEventRecord\(\s*\w+\s*\[/],
        },
      },
    },
    {
      id: 'event-timing',
      title: 'Timed with events, per chunk and in total, and the speedup is printed',
      detail:
        'A `landed[c]` event recorded after each chunk’s D2H copy, `cudaEventElapsedTime(&chunk_ms[c], start, landed[c])` for the timeline, `start → stop` for the total of each version, and a printed `speedup` — the evidence that the copies hid under the kernels.',
      match: {
        cuda: {
          all: [
            /cudaEventElapsedTime\([^;]*,\s*\w+\s*\[\s*\w+\s*\]\s*\)/,
            /cudaEventSynchronize\(|cudaStreamSynchronize\(|cudaDeviceSynchronize\(/,
            /speedup/,
          ],
        },
      },
    },
    {
      id: 'no-sync-copy',
      title: 'No synchronous cudaMemcpy in the pipelined path',
      detail:
        'Inside `run_pipelined` every copy is `cudaMemcpyAsync`; one `cudaMemcpy` blocks the host until that stream drains and the chunks behind it are never enqueued early. The baseline keeps its `cudaMemcpy`.',
      match: {cuda: {all: [/cudaMemcpyAsync\(/], none: [SYNC_COPY_IN_PIPELINE]}},
    },
    {
      id: 'cleanup',
      title: 'Streams, events and pinned memory are released',
      detail:
        '`cudaStreamDestroy` for every stream, `cudaEventDestroy` for every event, `cudaFreeHost` for the pinned buffers. Pinned pages are a scarce, non-swappable resource; streams and events are driver objects that leak per call otherwise.',
      match: {cuda: {all: [/cudaStreamDestroy\(/, /cudaEventDestroy\(/, /cudaFreeHost\(/]}},
    },
  ],
  code: {
    cuda: {
      starter: `// streams_pipeline.cu — process a large array in NSTREAMS chunks, overlapping H2D copies, compute and
// D2H copies across streams, with an event-carried dependency between chunks and a synchronous
// single-stream baseline timed the same way.
//
//   nvcc -O2 -o streams_pipeline streams_pipeline.cu && ./streams_pipeline
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                \\
    cudaError_t err_ = (call);                                                                        \\
    if (err_ != cudaSuccess) {                                                                        \\
      std::fprintf(stderr, "CUDA error at %s:%d: %s\\n", __FILE__, __LINE__, cudaGetErrorString(err_)); \\
      std::exit(EXIT_FAILURE);                                                                        \\
    }                                                                                                 \\
  } while (0)

constexpr int NSTREAMS = 4;
constexpr int N = 1 << 22;             // 4M floats: 16 MiB per buffer
constexpr int CHUNK = N / NSTREAMS;    // 1M floats per chunk
constexpr int ITERS = 64;              // sinf evaluations per element
constexpr float ECC = 0.5f;            // eccentricity of the Kepler iteration (< 1: a contraction)
constexpr int BLOCK = 256;
constexpr int GRID = (CHUNK + BLOCK - 1) / BLOCK;
constexpr int REPS = 3;                // each version runs REPS times; the fastest counts
constexpr float TOL = 1e-4f;
constexpr float MIN_SPEEDUP = 1.2f;
static_assert(N % NSTREAMS == 0, "N must split into equal chunks");

// Stage 1 — compute-heavy: solve Kepler's equation E = M + ECC * sin E by fixed-point iteration,
// ITERS sinf per element. Long enough that a chunk's copies can hide under another chunk's compute.
__global__ void heavy(const float* __restrict__ in, float* __restrict__ out, int n) {
  // TODO: e = m; ITERS times e = m + ECC * sinf(e); out[i] = e
}

// Stage 2 — the carried dependency: every element of a chunk is shifted by the previous chunk's last
// output (the carry-in of a chunked scan). carry is null for chunk 0. It reads memory another stream
// wrote, so it may only run once that stream's add_carry has finished.
__global__ void add_carry(float* out, const float* carry, int n) {
  // TODO: out[i] += *carry when carry is not null
}

// CPU reference: the same chunks, the same carry.
static void cpu_reference(const float* in, float* out) {
  for (int c = 0; c < NSTREAMS; ++c) {
    const size_t off = static_cast<size_t>(c) * CHUNK;
    const float carry = c > 0 ? out[off - 1] : 0.f;
    for (size_t i = off; i < off + CHUNK; ++i) {
      float e = in[i];
      for (int k = 0; k < ITERS; ++k) e = in[i] + ECC * sinf(e);
      out[i] = e + carry;
    }
  }
}

static float max_abs_err(const float* got, const float* want) {
  float err = 0.f;
  for (int i = 0; i < N; ++i) {
    const float d = fabsf(got[i] - want[i]);
    if (std::isnan(d) || d > err) err = d;
  }
  return err;
}

// Control: the same chunks, one after the other on the default stream with synchronous copies.
// Nothing overlaps: H2D, kernel, kernel, D2H, repeat.
static float run_baseline(const float* h_in, float* h_out, float* d_in, float* d_out) {
  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start, 0));
  for (int c = 0; c < NSTREAMS; ++c) {
    const size_t off = static_cast<size_t>(c) * CHUNK;
    CUDA_CHECK(cudaMemcpy(d_in + off, h_in + off, CHUNK * sizeof(float), cudaMemcpyHostToDevice));
    heavy<<<GRID, BLOCK>>>(d_in + off, d_out + off, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    add_carry<<<GRID, BLOCK>>>(d_out + off, c > 0 ? d_out + off - 1 : nullptr, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaMemcpy(h_out + off, d_out + off, CHUNK * sizeof(float), cudaMemcpyDeviceToHost));
  }
  CUDA_CHECK(cudaEventRecord(stop, 0));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  return ms;
}

// The pipeline: chunk c's H2D copy, two kernels and D2H copy go on stream c; the only cross-stream
// edge is add_carry's read of the previous chunk, carried by an event. Fills chunk_ms[c] with the
// time at which chunk c's results landed in h_out and returns the total.
static float run_pipelined(const float* h_in, float* h_out, float* d_in, float* d_out, float* chunk_ms) {
  // TODO: NSTREAMS streams; per chunk a computed event (cudaEventDisableTiming) and a landed event;
  //       start/stop. Per chunk on its stream: cudaMemcpyAsync H2D, heavy, wait on computed[c - 1],
  //       add_carry, record computed[c], cudaMemcpyAsync D2H, record landed[c]. Then synchronise the
  //       streams, record stop, fill chunk_ms, destroy everything.
  for (int c = 0; c < NSTREAMS; ++c) chunk_ms[c] = 0.f;
  return 0.f;
}

int main() {
  const size_t bytes = static_cast<size_t>(N) * sizeof(float);
  // TODO: pinned (page-locked) host buffers — cudaMallocHost — so the copies can be truly asynchronous.
  float* h_in = static_cast<float*>(malloc(bytes));
  float* h_out = static_cast<float*>(malloc(bytes));
  for (int i = 0; i < N; ++i) h_in[i] = static_cast<float>(i % 1000) * 0.00628f - 3.14f;  // mean anomalies in [-pi, pi)

  float *d_in = nullptr, *d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, bytes));
  CUDA_CHECK(cudaMalloc(&d_out, bytes));

  std::vector<float> ref(N);
  cpu_reference(h_in, ref.data());

  // Warm-up: the first launch of each kernel loads its module; keep that out of the timings.
  heavy<<<GRID, BLOCK>>>(d_in, d_out, CHUNK);
  add_carry<<<GRID, BLOCK>>>(d_out, nullptr, CHUNK);
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  float base_ms = 1e30f;
  for (int r = 0; r < REPS; ++r) base_ms = std::min(base_ms, run_baseline(h_in, h_out, d_in, d_out));
  const float base_err = max_abs_err(h_out, ref.data());
  std::printf("baseline  (1 stream, cudaMemcpy)       %8.3f ms   max abs err %.2e\\n", base_ms, base_err);

  std::memset(h_out, 0, bytes);  // a pipeline that never copies back must not inherit the baseline's answer
  CUDA_CHECK(cudaMemset(d_out, 0, bytes));
  float chunk_ms[NSTREAMS];
  float pipe_ms = 1e30f;
  for (int r = 0; r < REPS; ++r) pipe_ms = std::min(pipe_ms, run_pipelined(h_in, h_out, d_in, d_out, chunk_ms));
  const float pipe_err = max_abs_err(h_out, ref.data());
  std::printf("pipelined (%d streams, cudaMemcpyAsync) %8.3f ms   max abs err %.2e\\n", NSTREAMS, pipe_ms, pipe_err);
  for (int c = 0; c < NSTREAMS; ++c) std::printf("  chunk %d landed at %8.3f ms\\n", c, chunk_ms[c]);
  const float speedup = base_ms / pipe_ms;
  std::printf("speedup %.2fx\\n", speedup);

  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  // TODO: cudaFreeHost
  free(h_in);
  free(h_out);

  // Correctness decides the verdict. The speedup depends on the GPU (copy engines, the link, compute
  // against copy time), so a small one is reported, not failed.
  if (speedup <= MIN_SPEEDUP)
    std::printf("warning: speedup %.2fx is at most %.1fx: check for the default stream or pageable memory; "
                "a GPU with one copy engine overlaps less\\n", speedup, MIN_SPEEDUP);
  if (base_err < TOL && pipe_err < TOL) {
    std::printf("PASS\\n");
    return 0;
  }
  std::printf("FAIL: max abs err above %.0e\\n", TOL);
  return 1;
}
`,
      solution: `// streams_pipeline.cu — process a large array in NSTREAMS chunks, overlapping H2D copies, compute and
// D2H copies across streams, with an event-carried dependency between chunks and a synchronous
// single-stream baseline timed the same way.
//
//   nvcc -O2 -o streams_pipeline streams_pipeline.cu && ./streams_pipeline
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#define CUDA_CHECK(call)                                                                              \\
  do {                                                                                                \\
    cudaError_t err_ = (call);                                                                        \\
    if (err_ != cudaSuccess) {                                                                        \\
      std::fprintf(stderr, "CUDA error at %s:%d: %s\\n", __FILE__, __LINE__, cudaGetErrorString(err_)); \\
      std::exit(EXIT_FAILURE);                                                                        \\
    }                                                                                                 \\
  } while (0)

constexpr int NSTREAMS = 4;
constexpr int N = 1 << 22;             // 4M floats: 16 MiB per buffer
constexpr int CHUNK = N / NSTREAMS;    // 1M floats per chunk
constexpr int ITERS = 64;              // sinf evaluations per element
constexpr float ECC = 0.5f;            // eccentricity of the Kepler iteration (< 1: a contraction)
constexpr int BLOCK = 256;
constexpr int GRID = (CHUNK + BLOCK - 1) / BLOCK;
constexpr int REPS = 3;                // each version runs REPS times; the fastest counts
constexpr float TOL = 1e-4f;
constexpr float MIN_SPEEDUP = 1.2f;
static_assert(N % NSTREAMS == 0, "N must split into equal chunks");

// Stage 1 — compute-heavy: solve Kepler's equation E = M + ECC * sin E by fixed-point iteration,
// ITERS sinf per element. Long enough that a chunk's copies can hide under another chunk's compute.
__global__ void heavy(const float* __restrict__ in, float* __restrict__ out, int n) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  const float m = in[i];
  float e = m;
  for (int k = 0; k < ITERS; ++k) e = m + ECC * sinf(e);
  out[i] = e;
}

// Stage 2 — the carried dependency: every element of a chunk is shifted by the previous chunk's last
// output (the carry-in of a chunked scan). carry is null for chunk 0. It reads memory another stream
// wrote, so it may only run once that stream's add_carry has finished.
__global__ void add_carry(float* out, const float* carry, int n) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  if (carry != nullptr) out[i] += *carry;
}

// CPU reference: the same chunks, the same carry.
static void cpu_reference(const float* in, float* out) {
  for (int c = 0; c < NSTREAMS; ++c) {
    const size_t off = static_cast<size_t>(c) * CHUNK;
    const float carry = c > 0 ? out[off - 1] : 0.f;
    for (size_t i = off; i < off + CHUNK; ++i) {
      float e = in[i];
      for (int k = 0; k < ITERS; ++k) e = in[i] + ECC * sinf(e);
      out[i] = e + carry;
    }
  }
}

static float max_abs_err(const float* got, const float* want) {
  float err = 0.f;
  for (int i = 0; i < N; ++i) {
    const float d = fabsf(got[i] - want[i]);
    if (std::isnan(d) || d > err) err = d;
  }
  return err;
}

// Control: the same chunks, one after the other on the default stream with synchronous copies.
// Nothing overlaps: H2D, kernel, kernel, D2H, repeat.
static float run_baseline(const float* h_in, float* h_out, float* d_in, float* d_out) {
  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  CUDA_CHECK(cudaEventRecord(start, 0));
  for (int c = 0; c < NSTREAMS; ++c) {
    const size_t off = static_cast<size_t>(c) * CHUNK;
    CUDA_CHECK(cudaMemcpy(d_in + off, h_in + off, CHUNK * sizeof(float), cudaMemcpyHostToDevice));
    heavy<<<GRID, BLOCK>>>(d_in + off, d_out + off, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    add_carry<<<GRID, BLOCK>>>(d_out + off, c > 0 ? d_out + off - 1 : nullptr, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaMemcpy(h_out + off, d_out + off, CHUNK * sizeof(float), cudaMemcpyDeviceToHost));
  }
  CUDA_CHECK(cudaEventRecord(stop, 0));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0.f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  return ms;
}

// The pipeline: chunk c's H2D copy, two kernels and D2H copy go on stream c; the only cross-stream
// edge is add_carry's read of the previous chunk, carried by an event. Fills chunk_ms[c] with the
// time at which chunk c's results landed in h_out and returns the total.
static float run_pipelined(const float* h_in, float* h_out, float* d_in, float* d_out, float* chunk_ms) {
  cudaStream_t streams[NSTREAMS];
  cudaEvent_t computed[NSTREAMS], landed[NSTREAMS];
  for (int c = 0; c < NSTREAMS; ++c) {
    CUDA_CHECK(cudaStreamCreate(&streams[c]));
    CUDA_CHECK(cudaEventCreateWithFlags(&computed[c], cudaEventDisableTiming));  // a pure dependency: cheaper
    CUDA_CHECK(cudaEventCreate(&landed[c]));                                      // timed: when chunk c reached h_out
  }
  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));

  CUDA_CHECK(cudaEventRecord(start, 0));
  for (int c = 0; c < NSTREAMS; ++c) {
    const size_t off = static_cast<size_t>(c) * CHUNK;
    cudaStream_t s = streams[c];
    CUDA_CHECK(cudaMemcpyAsync(d_in + off, h_in + off, CHUNK * sizeof(float), cudaMemcpyHostToDevice, s));
    heavy<<<GRID, BLOCK, 0, s>>>(d_in + off, d_out + off, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    // The wait sits as late as possible: heavy of chunk c already overlaps chunk c - 1; only the
    // carry read must be ordered after the previous stream's add_carry.
    if (c > 0) CUDA_CHECK(cudaStreamWaitEvent(s, computed[c - 1], 0));
    add_carry<<<GRID, BLOCK, 0, s>>>(d_out + off, c > 0 ? d_out + off - 1 : nullptr, CHUNK);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaEventRecord(computed[c], s));
    CUDA_CHECK(cudaMemcpyAsync(h_out + off, d_out + off, CHUNK * sizeof(float), cudaMemcpyDeviceToHost, s));
    CUDA_CHECK(cudaEventRecord(landed[c], s));
  }
  // The host enqueued 4 x 5 operations in microseconds; now it waits for all of them.
  for (int c = 0; c < NSTREAMS; ++c) CUDA_CHECK(cudaStreamSynchronize(streams[c]));
  CUDA_CHECK(cudaEventRecord(stop, 0));
  CUDA_CHECK(cudaEventSynchronize(stop));

  float ms = 0.f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  for (int c = 0; c < NSTREAMS; ++c) CUDA_CHECK(cudaEventElapsedTime(&chunk_ms[c], start, landed[c]));

  for (int c = 0; c < NSTREAMS; ++c) {
    CUDA_CHECK(cudaStreamDestroy(streams[c]));
    CUDA_CHECK(cudaEventDestroy(computed[c]));
    CUDA_CHECK(cudaEventDestroy(landed[c]));
  }
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  return ms;
}

int main() {
  const size_t bytes = static_cast<size_t>(N) * sizeof(float);
  // Pinned (page-locked) host buffers: the copy engine reads them directly, so the copies can be
  // truly asynchronous. Pageable memory would be staged through a driver buffer, blocking the host.
  float *h_in = nullptr, *h_out = nullptr;
  CUDA_CHECK(cudaMallocHost(&h_in, bytes));
  CUDA_CHECK(cudaMallocHost(&h_out, bytes));
  for (int i = 0; i < N; ++i) h_in[i] = static_cast<float>(i % 1000) * 0.00628f - 3.14f;  // mean anomalies in [-pi, pi)

  float *d_in = nullptr, *d_out = nullptr;
  CUDA_CHECK(cudaMalloc(&d_in, bytes));
  CUDA_CHECK(cudaMalloc(&d_out, bytes));

  std::vector<float> ref(N);
  cpu_reference(h_in, ref.data());

  // Warm-up: the first launch of each kernel loads its module; keep that out of the timings.
  heavy<<<GRID, BLOCK>>>(d_in, d_out, CHUNK);
  add_carry<<<GRID, BLOCK>>>(d_out, nullptr, CHUNK);
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  float base_ms = 1e30f;
  for (int r = 0; r < REPS; ++r) base_ms = std::min(base_ms, run_baseline(h_in, h_out, d_in, d_out));
  const float base_err = max_abs_err(h_out, ref.data());
  std::printf("baseline  (1 stream, cudaMemcpy)       %8.3f ms   max abs err %.2e\\n", base_ms, base_err);

  std::memset(h_out, 0, bytes);  // a pipeline that never copies back must not inherit the baseline's answer
  CUDA_CHECK(cudaMemset(d_out, 0, bytes));
  float chunk_ms[NSTREAMS];
  float pipe_ms = 1e30f;
  for (int r = 0; r < REPS; ++r) pipe_ms = std::min(pipe_ms, run_pipelined(h_in, h_out, d_in, d_out, chunk_ms));
  const float pipe_err = max_abs_err(h_out, ref.data());
  std::printf("pipelined (%d streams, cudaMemcpyAsync) %8.3f ms   max abs err %.2e\\n", NSTREAMS, pipe_ms, pipe_err);
  for (int c = 0; c < NSTREAMS; ++c) std::printf("  chunk %d landed at %8.3f ms\\n", c, chunk_ms[c]);
  const float speedup = base_ms / pipe_ms;
  std::printf("speedup %.2fx\\n", speedup);

  CUDA_CHECK(cudaFree(d_in));
  CUDA_CHECK(cudaFree(d_out));
  CUDA_CHECK(cudaFreeHost(h_in));
  CUDA_CHECK(cudaFreeHost(h_out));

  // Correctness decides the verdict. The speedup depends on the GPU (copy engines, the link, compute
  // against copy time), so a small one is reported, not failed.
  if (speedup <= MIN_SPEEDUP)
    std::printf("warning: speedup %.2fx is at most %.1fx: check for the default stream or pageable memory; "
                "a GPU with one copy engine overlaps less\\n", speedup, MIN_SPEEDUP);
  if (base_err < TOL && pipe_err < TOL) {
    std::printf("PASS\\n");
    return 0;
  }
  std::printf("FAIL: max abs err above %.0e\\n", TOL);
  return 1;
}
`,
    },
  },
  debrief: `Three things make the overlap real, and each one is a line a learner tends to skip. **Pinned memory** first: \`cudaMemcpyAsync\` from pageable memory is legal and returns the same error-free status, but the driver has to stage the pages through its own locked buffer and the call blocks the host while it does — the pipeline silently becomes the baseline. **The stream argument everywhere**: a \`cudaMemcpyAsync\` without its fifth argument and a kernel without its fourth launch argument both land on stream 0, and because streams made by \`cudaStreamCreate\` are *blocking* streams, every one of them waits for stream 0 and stream 0 waits for all of them. One forgotten argument serialises the whole schedule, which is why the checks pin both. **An event, not a sync, for the dependency**: \`cudaStreamWaitEvent\` is a GPU-side barrier — the host records it in a microsecond and moves on to enqueue the next chunk, while \`cudaStreamSynchronize\` in the loop would drain stream \`c\` before stream \`c + 1\` is even submitted. The wait is placed after \`heavy\`, not at the top of the chunk, so only the kernel that actually reads the other stream's output waits for it. The timeline the program prints is the proof: with four streams the chunks land staggered by roughly one chunk's compute, and the last lands long before four times the baseline's chunk time. Production code keeps the same three ingredients and adds machinery around them: PyTorch's \`DataLoader(pin_memory=True)\` with \`tensor.to(device, non_blocking=True)\` is exactly this H2D half of the pipeline, \`torch.cuda.Stream\` and \`torch.cuda.Event\` are these objects with Python names, NCCL runs collectives on their own streams so that the all-reduce of layer *l*'s gradients overlaps the backward pass of layer *l − 1*, and CUDA Graphs capture a whole multi-stream schedule like this one so it can be replayed without the host enqueueing twenty calls each iteration.`,
};
