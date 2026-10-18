/** What every runtime (Python in Pyodide, TypeScript in the worker) takes and reports. */

export interface RunJob {
  /** The learner's files by file name (`thumb_server.py`, `thumb_server.ts`). */
  files: Record<string, string>;
  /** The course's support files by path (`payments/db.py`, `resizer_pb2.py`, `keys.proto`). */
  support: Record<string, string>;
  /** The step's harness module (`check_<id>(ctx)` functions). */
  harness: string;
  /** Check ids to run, in verdict order. */
  checks: string[];
}

export interface RuntimeCheckResult {
  id: string;
  passed: boolean;
  /** Why it failed: the assertion message, or the exception and where in the learner's code it was raised. */
  message?: string;
}

export interface RunResult {
  checks: RuntimeCheckResult[];
  stdout: string;
  stderr: string;
  /** The run could not complete (runtime failure, timeout); `checks` is then empty. */
  error?: string;
  ms: number;
}

/** Boot phases the runtimes report: Pyodide's, esbuild's, then the LeetBuild runtime itself. */
export type Phase = 'pyodide' | 'packages' | 'esbuild' | 'runtime';

export type WorkerIn = {type: 'boot'} | {type: 'run'; id: number; job: RunJob};
export type WorkerOut =
  | {type: 'phase'; phase: Phase}
  | {type: 'ready'}
  | {type: 'boot-failed'; message: string}
  | {type: 'result'; id: number; result: RunResult};
