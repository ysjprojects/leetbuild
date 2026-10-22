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
  architecture: {
    input: 'N = 4,194,304 float32 · 4 chunks of 4 MiB',
    output: 'h_out · speedup over the baseline · PASS',
    items: [
      {
        id: 'h-in',
        label: 'Pinned host buffer h_in',
        kind: 'host',
        sub: 'cudaMallocHost · 16 MiB',
        detail:
          'Page-locked, so the copy engine can DMA it directly and `cudaMemcpyAsync` returns at once. The host loop enqueues every chunk’s calls in microseconds, then waits once.',
      },
      {
        columns: [
          [
            {
              id: 'h2d-0',
              label: 'H2D · chunk 0',
              kind: 'io',
              sub: 'cudaMemcpyAsync · s0',
              detail:
                '`cudaMemcpyAsync(d_in + off, h_in + off, 4 MiB, cudaMemcpyHostToDevice, streams[0])`: a DMA queued on the stream; the call returns in microseconds.',
            },
            {
              id: 'heavy-0',
              label: 'heavy',
              kind: 'kernel',
              sub: '<<<4096, 256, 0, s0>>>',
              detail:
                '64 iterations of `e = m + 0.5f * sinf(e)` per element over chunk 0’s 1,048,576 floats: compute-heavy, so the copies hide under it.',
            },
            {
              id: 'carry-0',
              label: 'add_carry',
              kind: 'kernel',
              sub: 'carry = null',
              detail: 'Chunk 0 has no carry. `cudaEventRecord(computed[0], s0)` after it.',
            },
            {
              id: 'd2h-0',
              label: 'D2H · chunk 0',
              kind: 'io',
              sub: 'then record landed[0]',
              detail:
                '`cudaMemcpyAsync` device to host on `s0`, then `cudaEventRecord(landed[0], s0)`: the chunk’s landing time.',
            },
          ],
          [
            {
              id: 'h2d-1',
              label: 'H2D · chunk 1',
              kind: 'io',
              sub: 'cudaMemcpyAsync · s1',
              detail:
                '`cudaMemcpyAsync(d_in + off, h_in + off, 4 MiB, cudaMemcpyHostToDevice, streams[1])`: a DMA queued on the stream; the call returns in microseconds.',
            },
            {
              id: 'heavy-1',
              label: 'heavy',
              kind: 'kernel',
              sub: '<<<4096, 256, 0, s1>>>',
              detail:
                '64 iterations of `e = m + 0.5f * sinf(e)` per element over chunk 1’s 1,048,576 floats: compute-heavy, so the copies hide under it.',
            },
            {
              id: 'carry-1',
              label: 'add_carry',
              kind: 'kernel',
              sub: 'after wait computed[0]',
              detail:
                '`cudaStreamWaitEvent(s1, computed[0], 0)` first, then add `d_out[off − 1]`, the last output of chunk 0, to every element; then `cudaEventRecord(computed[1], s1)`.',
            },
            {
              id: 'd2h-1',
              label: 'D2H · chunk 1',
              kind: 'io',
              sub: 'then record landed[1]',
              detail:
                '`cudaMemcpyAsync` device to host on `s1`, then `cudaEventRecord(landed[1], s1)`: the chunk’s landing time.',
            },
          ],
          [
            {
              id: 'h2d-2',
              label: 'H2D · chunk 2',
              kind: 'io',
              sub: 'cudaMemcpyAsync · s2',
              detail:
                '`cudaMemcpyAsync(d_in + off, h_in + off, 4 MiB, cudaMemcpyHostToDevice, streams[2])`: a DMA queued on the stream; the call returns in microseconds.',
            },
            {
              id: 'heavy-2',
              label: 'heavy',
              kind: 'kernel',
              sub: '<<<4096, 256, 0, s2>>>',
              detail:
                '64 iterations of `e = m + 0.5f * sinf(e)` per element over chunk 2’s 1,048,576 floats: compute-heavy, so the copies hide under it.',
            },
            {
              id: 'carry-2',
              label: 'add_carry',
              kind: 'kernel',
              sub: 'after wait computed[1]',
              detail:
                '`cudaStreamWaitEvent(s2, computed[1], 0)` first, then add `d_out[off − 1]`, the last output of chunk 1, to every element; then `cudaEventRecord(computed[2], s2)`.',
            },
            {
              id: 'd2h-2',
              label: 'D2H · chunk 2',
              kind: 'io',
              sub: 'then record landed[2]',
              detail:
                '`cudaMemcpyAsync` device to host on `s2`, then `cudaEventRecord(landed[2], s2)`: the chunk’s landing time.',
            },
          ],
          [
            {
              id: 'h2d-3',
              label: 'H2D · chunk 3',
              kind: 'io',
              sub: 'cudaMemcpyAsync · s3',
              detail:
                '`cudaMemcpyAsync(d_in + off, h_in + off, 4 MiB, cudaMemcpyHostToDevice, streams[3])`: a DMA queued on the stream; the call returns in microseconds.',
            },
            {
              id: 'heavy-3',
              label: 'heavy',
              kind: 'kernel',
              sub: '<<<4096, 256, 0, s3>>>',
              detail:
                '64 iterations of `e = m + 0.5f * sinf(e)` per element over chunk 3’s 1,048,576 floats: compute-heavy, so the copies hide under it.',
            },
            {
              id: 'carry-3',
              label: 'add_carry',
              kind: 'kernel',
              sub: 'after wait computed[2]',
              detail:
                '`cudaStreamWaitEvent(s3, computed[2], 0)` first, then add `d_out[off − 1]`, the last output of chunk 2, to every element; then `cudaEventRecord(computed[3], s3)`.',
            },
            {
              id: 'd2h-3',
              label: 'D2H · chunk 3',
              kind: 'io',
              sub: 'then record landed[3]',
              detail:
                '`cudaMemcpyAsync` device to host on `s3`, then `cudaEventRecord(landed[3], s3)`: the chunk’s landing time.',
            },
          ],
        ],
      },
      {
        id: 'h-out',
        label: 'Pinned host buffer h_out',
        kind: 'host',
        sub: 'sync streams · stop · ElapsedTime',
        detail:
          'After the loop: `cudaStreamSynchronize` on every stream, record `stop`, read `start → stop` and `start → landed[c]` with `cudaEventElapsedTime`, destroy streams and events. Compared with the CPU reference and the baseline time.',
      },
    ],
    notes: [
      {at: 'h2d-3', text: 'H2D **copy engine**: chunk c + 1 during compute of c'},
      {at: 'heavy-3', text: '**SMs**: 64 sinf iterations per element, chunk c'},
      {at: 'carry-3', text: '**cudaStreamWaitEvent**: the one cross-stream edge'},
      {at: 'd2h-3', text: 'D2H **copy engine**: chunk c − 1, the other direction'},
      {at: 'h-out', text: '**≈ 1.5×** faster than the one-stream baseline'},
    ],
  },
  steps: [streamsPipelineStep],
  learn,
};
