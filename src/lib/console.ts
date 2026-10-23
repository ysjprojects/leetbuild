import type {OutputLine, RunResult} from './runtime/types';

/** The bottom panel's two views: the step's objectives (checks) or the console of the last run. */
export type BottomTab = 'checks' | 'console';

/** What the console shows: the last run's output, line by line as it was printed, and how it ended. */
export interface ConsoleRun {
  /** The command line it stands for: `python bpe.py`, `run · example check`, `submit · 5 checks`. */
  label: string;
  lines: OutputLine[];
  running: boolean;
  /** A program's exit status, once it finished (harness runs have none). */
  exit?: number;
  /** How long the run took, once it finished. */
  ms?: number;
  /** The run could not complete (runtime failure, timeout). */
  error?: string;
}

const split = (text: string, stream: OutputLine['stream']): OutputLine[] =>
  text === '' ? [] : text.split('\n').map(line => ({stream, text: line}));

/** A finished run's output as console lines: what it streamed, or else (TypeScript, Go) its stdout then stderr. */
export const finished = (run: ConsoleRun, result: RunResult): ConsoleRun => ({
  ...run,
  running: false,
  lines: run.lines.length > 0 ? run.lines : [...split(result.stdout, 'stdout'), ...split(result.stderr, 'stderr')],
  exit: result.exit,
  ms: result.ms,
  error: result.error,
});
