/**
 * Main-thread handle on the Python runtime worker: `prewarm()` when a step that will run opens,
 * `run()` on submit. The worker is `public/py/worker.js`, an ES-module bundle built by
 * `yarn build:runtime` (Pyodide only runs in module workers, which webpack cannot emit here). A run
 * that overshoots its budget (a learner's infinite loop cannot be interrupted from outside Pyodide)
 * terminates the worker; the next run boots a fresh one.
 */
import type {BootPhase, RunJob, RunResult} from './python';
import type {WorkerIn, WorkerOut} from './worker';

export type RuntimeStatus =
  | {state: 'idle'}
  | {state: 'booting'; phase: BootPhase}
  | {state: 'ready'}
  | {state: 'running'}
  | {state: 'failed'; message: string};

export const RUN_TIMEOUT_MS = 20_000;

/** The worker bundle `yarn build:runtime` writes under public/. */
export const WORKER_URL = '/py/worker.js';

export const STATUS_TEXT: Record<BootPhase, string> = {
  pyodide: 'starting Python (downloading the runtime, ~10 MB the first time)',
  packages: 'loading FastAPI, Redis, protobuf…',
  runtime: 'installing the LeetBuild runtime',
};

interface Pending {
  resolve: (result: RunResult) => void;
  /** The budget timer; starts when the runtime is ready, so a slow first download is never charged to the run. */
  timer: number | null;
}

export class PythonRunner {
  status: RuntimeStatus = {state: 'idle'};
  private worker: Worker | null = null;
  private ready = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();
  private nextId = 1;

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
    const worker = new Worker(WORKER_URL, {type: 'module'});
    worker.onmessage = (event: MessageEvent<WorkerOut>) => this.receive(event.data);
    worker.onerror = event => this.fail(`the runtime worker crashed: ${event.message}`);
    this.worker = worker;
    this.ready = false;
    this.setStatus({state: 'booting', phase: 'pyodide'});
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

let singleton: PythonRunner | null = null;

export function getPythonRunner(): PythonRunner {
  if (singleton === null) singleton = new PythonRunner();
  return singleton;
}
