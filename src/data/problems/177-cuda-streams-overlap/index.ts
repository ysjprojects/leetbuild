import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {streamsPipelineStep} from './steps/1-streams-pipeline';

/**
 * Hard CUDA problem: hide host↔device copies under compute. Pinned host buffers, one stream per
 * chunk, cudaMemcpyAsync and kernel launches bound to that stream, a cudaStreamWaitEvent carrying the
 * one cross-chunk dependency, and events timing both the pipeline and a synchronous single-stream
 * baseline — the overlap is proven by the printed speedup.
 */
export const cudaStreamsOverlapProblem: Problem = {
  id: 'cuda-streams-overlap',
  title: 'Overlapping copies and compute with streams, events and pinned memory',
  tagline:
    '16 MiB in four chunks on four streams: pinned host buffers, cudaMemcpyAsync and launches bound to a stream, an event instead of a host sync for the carry between chunks, event timing per chunk, a synchronous baseline to beat by 1.2× and PASS.',
  difficulty: 'hard',
  track: 'dl',
  language: 'cuda',
  concepts: ['cuda'],
  minutes: 75,
  statement: `# Overlapping copies and compute with streams, events and pinned memory

A GPU has three engines that can run at once: the SMs that execute kernels, and (on every datacenter and
most consumer parts) two **copy engines**, one per direction across PCIe or NVLink. A program that does
\`cudaMemcpy\` in, kernel, \`cudaMemcpy\` out keeps exactly one of them busy at a time. Training input
pipelines (\`DataLoader(pin_memory=True)\` with \`.to(device, non_blocking=True)\`), CPU-offloaded optimizer
states and KV caches, and NCCL collectives that overlap the backward pass all rest on the same three
ingredients: **pinned host memory**, **streams** as independent ordered queues, and **events** as markers
that time the work and order one stream after another without stopping the host.

The surface is one file, \`streams_pipeline.cu\`, compiled with \`nvcc\`. \`N = 1 << 22\` floats (16 MiB) are
processed in \`NSTREAMS = 4\` chunks of \`CHUNK = N / NSTREAMS\`:

- \`__global__ void heavy(const float* in, float* out, int n)\` — per element, \`ITERS = 64\` fixed-point
  iterations of Kepler's equation \`e = m + ECC * sinf(e)\` (\`ECC = 0.5f\`): enough arithmetic per byte
  that a chunk's copies can hide under another chunk's compute.
- \`__global__ void add_carry(float* out, const float* carry, int n)\` — adds \`*carry\`, the last output of
  the previous chunk, to every element (null for chunk 0): the one dependency that crosses streams.
- \`run_baseline(h_in, h_out, d_in, d_out)\` → ms (given) — the same chunks on the default stream with
  synchronous \`cudaMemcpy\`.
- \`run_pipelined(h_in, h_out, d_in, d_out, chunk_ms)\` → ms — one stream per chunk; per chunk
  \`cudaMemcpyAsync\` H2D, \`heavy\`, \`cudaStreamWaitEvent\` on the previous chunk's \`computed\` event,
  \`add_carry\`, \`cudaEventRecord(computed[c])\`, \`cudaMemcpyAsync\` D2H, \`cudaEventRecord(landed[c])\`; the
  landing time of each chunk in \`chunk_ms\`.
- \`main\` — \`h_in\`/\`h_out\` from \`cudaMallocHost\`, a CPU reference, a warm-up, the fastest of \`REPS = 3\`
  runs of each version, and \`PASS\` when both max abs errors are below \`1e-4\` and the speedup exceeds 1.2×.

## What you build here

1. \`heavy\`, \`add_carry\`, \`run_pipelined\` and the pinned allocations in \`main\`: copies and launches on
   per-chunk streams, the event-carried dependency between neighbouring chunks, per-chunk and total event
   timing, and the release of every stream, event and pinned buffer.

## Run it on your machine

\`\`\`text
nvcc -O2 -o streams_pipeline streams_pipeline.cu && ./streams_pipeline
\`\`\`

A passing run prints both times, when each chunk landed, the speedup and \`PASS\`, like this (illustrative figures, not from a measured run):

\`\`\`text
baseline  (1 stream, cudaMemcpy)          3.018 ms   max abs err 9.54e-07
pipelined (4 streams, cudaMemcpyAsync)    1.941 ms   max abs err 9.54e-07
  chunk 0 landed at    0.737 ms
  chunk 1 landed at    1.139 ms
  chunk 2 landed at    1.540 ms
  chunk 3 landed at    1.938 ms
speedup 1.55x
PASS
\`\`\`

The numbers depend on the GPU and the link (PCIe 3, 4 or 5, NVLink-C2C); the shape does not — the chunks
land staggered by about one chunk's compute, and the total is well under the baseline's. The starter
compiles and runs, but its kernels are empty and the pipeline copies nothing back: both max abs errors are
far above \`1e-4\` and it prints \`FAIL\`.

## Left out on purpose

\`cudaStreamCreateWithFlags(cudaStreamNonBlocking)\` and per-thread default streams, stream priorities,
CUDA Graphs capture of the schedule, choosing \`NSTREAMS\` and the chunk size from a measured
copy-to-compute ratio, double-buffered device memory for an unbounded input stream, and
\`cudaMemcpyPeerAsync\` between GPUs. The three ingredients here are the ones all of those build on.`,
  diagram: {
    nodes: [
      {
        id: 'host',
        kind: 'client',
        label: 'Host · pinned h_in / h_out',
        sub: 'cudaMallocHost · enqueue 4 chunks · events',
        x: 8,
        y: 50,
      },
      {
        id: 'copy',
        kind: 'service',
        label: 'Copy engines',
        sub: 'H2D chunk c + 1 ∥ D2H chunk c − 1',
        x: 36,
        y: 30,
      },
      {
        id: 'sm',
        kind: 'service',
        label: 'SMs · heavy, add_carry',
        sub: 'chunk c · <<<GRID, BLOCK, 0, s>>>',
        x: 64,
        y: 70,
      },
      {id: 'dmem', kind: 'db', label: 'Device memory', sub: 'd_in · d_out · 16 MiB each', x: 92, y: 50},
    ],
    edges: [
      {from: 'host', to: 'copy', kind: 'plain', label: 'cudaMemcpyAsync(…, s)'},
      {from: 'copy', to: 'dmem', kind: 'plain', label: 'DMA, no host involvement'},
      {from: 'host', to: 'sm', kind: 'plain', label: 'launch on s · cudaStreamWaitEvent'},
      {from: 'sm', to: 'dmem', kind: 'plain', label: 'read d_in · write d_out'},
    ],
  },
  steps: [streamsPipelineStep],
  learn,
};
