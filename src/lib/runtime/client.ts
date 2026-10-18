/**
 * Main-thread handle on a runtime worker — one per executing language: `prewarm()` when a step
 * that will run opens, `run()` on submit. The workers are `public/py/worker.js` (Python, Pyodide)
 * and `public/ts/worker.js` (TypeScript, esbuild-wasm), ES-module bundles built by
 * `yarn build:runtime` (Pyodide only runs in module workers, which webpack cannot emit here). A run
 * that overshoots its budget (a learner's infinite loop cannot be interrupted from outside the
 * worker) terminates the worker; the next run boots a fresh one.
 */
import type {Language} from '../types';
import type {Phase, RunJob, RunResult, WorkerIn, WorkerOut} from './types';

export type RuntimeStatus =
  | {state: 'idle'}
  | {state: 'booting'; phase: Phase}
  | {state: 'ready'}
  | {state: 'running'}
  | {state: 'failed'; message: string};

export const RUN_TIMEOUT_MS = 20_000;

/** Languages graded by execution, with their worker bundle (`yarn build:runtime` writes it under public/) and first boot phase. */
export const RUNTIMES: Partial<Record<Language, {workerUrl: string; firstPhase: Phase}>> = {
  python: {workerUrl: '/py/worker.js', firstPhase: 'pyodide'},
  typescript: {workerUrl: '/ts/worker.js', firstPhase: 'esbuild'},
};

export const STATUS_TEXT: Record<Phase, string> = {
  pyodide: 'starting Python (downloading the runtime, ~10 MB the first time)',
  packages: 'loading FastAPI, Redis, protobuf…',
  esbuild: 'starting TypeScript (downloading the compiler, ~14 MB the first time)',
  runtime: 'installing the LeetBuild runtime',
};

interface Pending {
  resolve: (result: RunResult) => void;
  /** The budget timer; starts when the runtime is ready, so a slow first download is never charged to the run. */
  timer: number | null;
}

export class RuntimeRunner {
  status: RuntimeStatus = {state: 'idle'};
  private worker: Worker | null = null;
  private ready = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();
  private nextId = 1;

  constructor(private readonly workerUrl: string, private readonly firstPhase: Phase) {}

  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start booting now so the first submit does not wait for the download. */
  prewarm(): void {
    if (this.worker === null) this.spawn().postMessage({type: 'boot'} satisfies WorkerIn);
  }

  run(job: RunJob): Promise<RunResult> {
    const worker = this.worker ?? this.spawn();
    const id = this.nextId++;
    if (this.ready) this.setStatus({state: 'running'});
    return new Promise<RunResult>(resolve => {
      this.pending.set(id, {resolve, timer: this.ready ? this.budget(id) : null});
      worker.postMessage({type: 'run', id, job} satisfies WorkerIn);
    });
  }

  private budget(id: number): number {
    return window.setTimeout(() => this.timeout(id), RUN_TIMEOUT_MS);
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, {type: 'module'});
    worker.onmessage = (event: MessageEvent<WorkerOut>) => this.receive(event.data);
    worker.onerror = event => this.fail(`the runtime worker crashed: ${event.message}`);
    this.worker = worker;
    this.ready = false;
    this.setStatus({state: 'booting', phase: this.firstPhase});
    return worker;
  }

  private receive(message: WorkerOut): void {
    switch (message.type) {
      case 'phase':
        this.setStatus({state: 'booting', phase: message.phase});
        return;
      case 'ready':
        this.ready = true;
        for (const [id, pending] of this.pending) if (pending.timer === null) pending.timer = this.budget(id);
        this.setStatus(this.pending.size > 0 ? {state: 'running'} : {state: 'ready'});
        return;
      case 'boot-failed':
        this.fail(`the runtime could not start: ${message.message}`);
        return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        if (pending.timer !== null) window.clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (this.pending.size === 0) this.setStatus(this.ready ? {state: 'ready'} : this.status);
        pending.resolve(message.result);
        return;
      }
    }
  }

  private timeout(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.terminate();
    this.setStatus({state: 'idle'});
    pending.resolve({
      checks: [],
      stdout: '',
      stderr: '',
      error: `the run did not finish within ${
        RUN_TIMEOUT_MS / 1000
      } s (an endless loop?); the runtime restarts on the next submit`,
      ms: RUN_TIMEOUT_MS,
    });
  }

  private fail(message: string): void {
    this.terminate();
    this.setStatus({state: 'failed', message});
    for (const [id, pending] of this.pending) {
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({checks: [], stdout: '', stderr: '', error: message, ms: 0});
    }
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

const runners = new Map<Language, RuntimeRunner>();

/** The runner for `language`, or null when it is graded statically. */
export function getRunner(language: Language): RuntimeRunner | null {
  const runtime = RUNTIMES[language];
  if (runtime === undefined) return null;
  let runner = runners.get(language);
  if (runner === undefined) {
    runner = new RuntimeRunner(runtime.workerUrl, runtime.firstPhase);
    runners.set(language, runner);
  }
  return runner;
}
