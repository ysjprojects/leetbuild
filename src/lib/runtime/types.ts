/** What every runtime (Python in Pyodide, TypeScript in the worker) takes and reports. */

export interface RunJob {
  /** The learner's files by file name (`thumb_server.py`, `thumb_server.ts`). */
  files: Record<string, string>;
  /** The course's support files by path (`payments/db.py`, `resizer_pb2.py`, `keys.proto`). */
  support: Record<string, string>;
  /** The step's harness module (`check_<id>(ctx)` functions; Go: `Check<Id>(ctx)` in harness_test.go). */
  harness: string;
  /** Check ids to run, in verdict order. */
  checks: string[];
  /**
   * The step's own file among `files` (`lease_lock.go`). Go needs it: every Go step file is a whole
   * program (`package main`), so the runtime compiles that one file with the harness.
   */
  entry?: string;
}

/**
 * What the learner's code did while one check ran, counted by the runtime's resources — Redis,
 * the broker, the gRPC registry, Postgres, the clock — with the harness's own calls left out.
 * Informational: the verdict never depends on it. The same fields in both runtimes, so a run in
 * Python and one in TypeScript compare.
 */
export interface RunMetrics {
  /** Round trips the learner's Redis clients made (a pipeline or a transaction is one). */
  redisTrips: number;
  /** Commands inside those round trips. */
  redisCommands: number;
  /** Records the learner's producers put on the broker (seeded records are not counted). */
  kafkaProduced: number;
  /** Records delivered to the learner's consumers. */
  kafkaDelivered: number;
  /** Offset commits, automatic or explicit. */
  kafkaCommits: number;
  /** RPCs the learner's code made (not the harness's calls into the learner's servers). */
  grpcCalls: number;
  /** SQL statements the learner's code ran (not the harness's). */
  sqlStatements: number;
  /** Virtual sleeps the learner's code took, and the virtual time they covered. */
  sleeps: number;
  sleptMs: number;
}

export interface RuntimeCheckResult {
  id: string;
  passed: boolean;
  /** Why it failed: the assertion message, or the exception and where in the learner's code it was raised. */
  message?: string;
  metrics?: RunMetrics;
}

export interface RunResult {
  checks: RuntimeCheckResult[];
  stdout: string;
  stderr: string;
  /** The run could not complete (runtime failure, timeout); `checks` is then empty. */
  error?: string;
  ms: number;
}

/** Boot phases the runtimes report: Pyodide's, esbuild's, the Go interpreter's, then the LeetBuild runtime itself. */
export type Phase = 'pyodide' | 'packages' | 'esbuild' | 'go' | 'runtime';

export type WorkerIn = {type: 'boot'} | {type: 'run'; id: number; job: RunJob};
export type WorkerOut =
  | {type: 'phase'; phase: Phase}
  | {type: 'ready'}
  | {type: 'boot-failed'; message: string}
  | {type: 'result'; id: number; result: RunResult};
