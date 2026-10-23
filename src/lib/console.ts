import type {OutputLine, RunResult} from './runtime/types';
import type {StepCheck} from './types';

/** The bottom panel's two views: the step's objectives (checks) or the console of the last run. */
export type BottomTab = 'checks' | 'console';

/** A check the run executed, as the console reports it: like a test runner's line. */
export interface ConsoleCheck {
  title: string;
  passed: boolean;
  /** Why it failed: the assertion, or the exception and where in the learner's code it was raised. */
  message?: string;
}

/** What the console shows: the last run's output, line by line as it was printed, and how it ended. */
export interface ConsoleRun {
  /** The command line it stands for: `python bpe.py`, `run · example check`, `submit · 5 checks`. */
  label: string;
  lines: OutputLine[];
  running: boolean;
  /** The checks a harness run executed, in order, once it finished (a program runs none). */
  checks?: ConsoleCheck[];
  /** A program's exit status, once it finished (harness runs have none). */
  exit?: number;
  /** How long the run took, once it finished. */
  ms?: number;
  /** The run could not complete (runtime failure, timeout). */
  error?: string;
}

const split = (text: string, stream: OutputLine['stream']): OutputLine[] =>
  text === '' ? [] : text.split('\n').map(line => ({stream, text: line}));

/**
 * A finished run as the console shows it: its output (what it streamed, or else, TypeScript and Go,
 * its stdout then stderr), then each check it executed by the title the step gives it.
 */
export const finished = (run: ConsoleRun, result: RunResult, checks: readonly StepCheck[] = []): ConsoleRun => ({
  ...run,
  running: false,
  lines: run.lines.length > 0 ? run.lines : [...split(result.stdout, 'stdout'), ...split(result.stderr, 'stderr')],
  checks: result.checks.map(check => ({
    title: checks.find(c => c.id === check.id)?.title ?? check.id,
    passed: check.passed,
    message: check.message,
  })),
  exit: result.exit,
  ms: result.ms,
  error: result.error,
});
