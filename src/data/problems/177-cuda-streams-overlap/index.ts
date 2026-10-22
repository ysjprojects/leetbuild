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
  figures: [
    {
      title: 'Three engines at once',
      gpu: {
        items: [
          {
            id: 'host',
            label: 'Host',
            sub: 'cudaMallocHost · pinned',
            tone: 'host',
            layout: 'column',
            detail:
              'Page-locked, so a copy engine can DMA the pages directly and `cudaMemcpyAsync` returns at once. From `malloc` memory the driver would stage every copy through the CPU first, and nothing would overlap.',
            items: [
              {
                id: 'h-in',
                array: 'h_in',
                sub: 'a cell = one 4 MiB chunk',
                cols: 4,
                cells: ['0', '1', '2', '3'],
                tone: 'host',
                marks: [{cols: [2, 2], tone: 'global', label: 'H2D now'}],
                detail:
                  '16 MiB in `NSTREAMS = 4` chunks of `CHUNK = N / 4` floats; chunk `c` starts at `off = c · CHUNK`.',
              },
              {
                id: 'h-out',
                array: 'h_out',
                sub: 'chunks land in order',
                cols: 4,
                cells: ['0', '1', '2', '3'],
                tone: 'host',
                detail:
                  'After the loop the host synchronises every stream once, then reads `start → landed[c]` for each chunk and `start → stop` for the whole pipeline.',
              },
            ],
          },
          {
            id: 'gpu',
            label: 'GPU',
            sub: 'chunk 2 in, chunk 1 computing, chunk 0 out',
            detail:
              'One moment of the pipeline: the three engines work on three different chunks, each queued on its own stream.',
            items: [
              {
                id: 'copy-engines',
                label: 'Copy engines',
                sub: 'DMA over PCIe or NVLink',
                layout: 'column',
                items: [
                  {
                    id: 'h2d-engine',
                    label: 'H2D copy engine',
                    sub: 'host → device',
                    tone: 'compute',
                    detail:
                      'Moves chunk `c + 1` in while the SMs compute chunk `c`. Neither the SMs nor the CPU spend a cycle on it.',
                  },
                  {
                    id: 'd2h-engine',
                    label: 'D2H copy engine',
                    sub: 'device → host',
                    tone: 'compute',
                    detail:
                      'Moves chunk `c − 1` out at the same time. With one copy engine (`asyncEngineCount == 1`) both directions share it and only copy–compute overlap remains.',
                  },
                ],
              },
              {
                id: 'dev-gmem',
                label: 'Global memory',
                sub: 'cudaMalloc · 2 × 16 MiB',
                tone: 'global',
                layout: 'column',
                items: [
                  {
                    id: 'd-in',
                    array: 'd_in',
                    cols: 4,
                    cells: ['0', '1', '2', '3'],
                    marks: [{cols: [1, 1], tone: 'register', label: 'heavy now'}],
                    detail:
                      'Chunk `c` lands at `d_in + off`; `heavy` on stream `c` reads it only after the copy before it in the same stream.',
                  },
                  {
                    id: 'd-out',
                    array: 'd_out',
                    cols: 4,
                    cells: ['0', '1', '2', '3'],
                    marks: [{cols: [0, 0], tone: 'host', label: 'D2H now'}],
                    detail:
                      '`heavy` writes chunk `c`, `add_carry` adds `d_out[off − 1]`, the last output of chunk `c − 1`: the one read that crosses streams.',
                  },
                ],
              },
              {
                id: 'sms',
                label: 'SMs',
                sub: 'chunk 1, on stream 1',
                tone: 'compute',
                layout: 'column',
                detail:
                  'The kernels of one chunk fill the GPU, so compute runs chunk after chunk while the copy engines fill the gaps around it.',
                items: [
                  {
                    id: 'sm-heavy',
                    label: 'heavy',
                    sub: '64 sinf per element',
                    detail:
                      '64 iterations of `e = m + 0.5f * sinf(e)` per element: enough arithmetic that a chunk’s compute takes longer than its copies, so the copies hide under it.',
                  },
                  {
                    id: 'sm-carry',
                    label: 'add_carry',
                    sub: '+ d_out[off − 1]',
                    detail:
                      'Waits on the GPU for `computed[0]`, then adds the last output of chunk 0 to every element of chunk 1.',
                  },
                ],
              },
            ],
          },
        ],
        arrows: [
          {from: 'h-in', to: 'h2d-engine', label: 'chunk 2'},
          {from: 'h2d-engine', to: 'd-in'},
          {from: 'd-in', to: 'sms', label: 'chunk 1'},
          {from: 'sms', to: 'd-out', label: 'chunk 1'},
          {from: 'd-out', to: 'd2h-engine', label: 'chunk 0'},
          {from: 'd2h-engine', to: 'h-out'},
        ],
      },
    },
    {
      title: 'Four streams, one event chain',
      gpu: {
        items: [0, 1, 2, 3].map(c => ({
          id: `stream-${c}`,
          label: `Stream ${c}`,
          sub: `chunk ${c} · streams[${c}]`,
          layout: 'column' as const,
          detail:
            c === 0
              ? 'A stream is a FIFO: its four operations run in the order they were issued. Different streams have no order between them, except the events they wait on.'
              : `Issued right after stream ${
                  c - 1
                }, in microseconds: the host enqueues the whole schedule and waits once at the end.`,
          items: [
            {
              id: `h2d-${c}`,
              label: `H2D chunk ${c}`,
              sub: 'cudaMemcpyAsync',
              tone: 'compute' as const,
              detail: `\`cudaMemcpyAsync(d_in + off, h_in + off, 4 MiB, cudaMemcpyHostToDevice, streams[${c}])\`: on the H2D copy engine. Without the fifth argument it would land on stream 0 and serialise everything.`,
            },
            {
              id: `heavy-${c}`,
              label: 'heavy',
              sub: `<<<4096, 256, 0, s${c}>>>`,
              tone: 'compute' as const,
              detail: `On the SMs, over chunk ${c}’s 1,048,576 floats. It touches only chunk ${c}, so it waits for nothing but its own copy.`,
            },
            {
              id: `carry-${c}`,
              label: 'add_carry',
              sub: c === 0 ? 'carry = null' : `after wait computed[${c - 1}]`,
              tone: 'compute' as const,
              detail:
                c === 0
                  ? 'Chunk 0 has no carry. `cudaEventRecord(computed[0], s0)` right after it.'
                  : `\`cudaStreamWaitEvent(s${c}, computed[${
                      c - 1
                    }], 0)\` first, then add \`d_out[off − 1]\`, the last output of chunk ${
                      c - 1
                    }; then \`cudaEventRecord(computed[${c}], s${c})\`.`,
            },
            {
              id: `d2h-${c}`,
              label: `D2H chunk ${c}`,
              sub: `then record landed[${c}]`,
              tone: 'compute' as const,
              detail: `\`cudaMemcpyAsync\` device to host on the D2H copy engine, then \`cudaEventRecord(landed[${c}], s${c})\`: the chunk’s landing time.`,
            },
          ],
        })),
        arrows: [1, 2, 3].map(c => ({
          from: `carry-${c - 1}`,
          to: `carry-${c}`,
          label: `computed[${c - 1}]`,
          dashed: true,
        })),
      },
    },
  ],
  steps: [streamsPipelineStep],
  learn,
};
