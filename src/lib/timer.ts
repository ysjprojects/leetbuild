/**
 * Timer mode: a countdown over one problem, from its first step, against a budget derived from the
 * problem's time estimate. One timer runs at a time and is persisted with the progress, so a
 * reload does not lose it. When it ends — every step done, the learner stopping it, or the budget
 * running out — a `TimedSession` joins the history; a session *counts* (goes on the board as the
 * learner's time for the problem) only when the problem was completed within the budget with no
 * solution revealed. Running on past the budget is allowed and recorded, but never counted.
 */
import {type StepAttempt, OPEN_ATTEMPT} from './scoring';
import {type Language, type Problem, stepKey} from './types';

export interface ActiveTimer {
  problemId: string;
  startedAt: number;
  /** Seconds allowed. */
  budget: number;
  /** The budget ran out and the learner chose to keep going: the run will not be counted. */
  overtime: boolean;
  language: Language;
}

export type SessionOutcome = 'completed' | 'ended' | 'expired';

export interface TimedSession {
  problemId: string;
  startedAt: number;
  budget: number;
  /** Seconds from the start to the end of the run. */
  elapsed: number;
  accepted: number;
  revealed: number;
  total: number;
  language: Language;
  /** `completed`: every step done; `ended`: stopped by the learner; `expired`: the budget ran out and the learner stopped. */
  outcome: SessionOutcome;
  /** Completed within the budget with nothing revealed: the learner's time for this problem. */
  counted: boolean;
}

/** Budgets offered when starting a run, as multiples of the problem's estimate. */
export const BUDGETS: readonly {factor: number; label: string; blurb: string}[] = [
  {factor: 0.75, label: 'Tight', blurb: 'three quarters of the estimate'},
  {factor: 1, label: 'Estimated', blurb: 'the problem’s own estimate'},
  {factor: 1.5, label: 'Relaxed', blurb: 'half again the estimate'},
];

/** Sessions kept in the history (oldest dropped first). */
export const SESSION_HISTORY = 200;

export function budgetSeconds(problem: Problem, factor: number): number {
  return Math.max(60, Math.round(problem.minutes * 60 * factor));
}

/** `m:ss` under an hour, `h:mm:ss` from then on; negative values are shown without a sign (callers add `+`/`−`). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(Math.abs(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds since the run started. */
export function elapsedSeconds(timer: ActiveTimer, now: number): number {
  return Math.max(0, (now - timer.startedAt) / 1000);
}

/** Seconds left in the budget; negative once it has run out. */
export function remainingSeconds(timer: ActiveTimer, now: number): number {
  return timer.budget - elapsedSeconds(timer, now);
}

export function startTimer(problem: Problem, factor: number, language: Language, now: number): ActiveTimer {
  return {problemId: problem.id, startedAt: now, budget: budgetSeconds(problem, factor), overtime: false, language};
}

/** Steps of the problem accepted / revealed right now. */
export function stepsDone(
  problem: Problem,
  attempts: Record<string, StepAttempt>,
): {accepted: number; revealed: number} {
  let accepted = 0;
  let revealed = 0;
  for (const step of problem.steps) {
    const status = (attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT).status;
    if (status === 'accepted') accepted += 1;
    else if (status === 'revealed') revealed += 1;
  }
  return {accepted, revealed};
}

/** Every step is done (accepted or revealed): the run is over, whether or not it counts. */
export function isComplete(problem: Problem, attempts: Record<string, StepAttempt>): boolean {
  const done = stepsDone(problem, attempts);
  return problem.steps.length > 0 && done.accepted + done.revealed === problem.steps.length;
}

/**
 * Close the run. `expired` records the budget itself as the time (the learner stopped when it ran
 * out); the other outcomes record the real elapsed time, past the budget included.
 */
export function finishSession(
  timer: ActiveTimer,
  problem: Problem,
  attempts: Record<string, StepAttempt>,
  outcome: SessionOutcome,
  now: number,
): TimedSession {
  const done = stepsDone(problem, attempts);
  const elapsed = outcome === 'expired' ? timer.budget : Math.round(elapsedSeconds(timer, now));
  return {
    problemId: timer.problemId,
    startedAt: timer.startedAt,
    budget: timer.budget,
    elapsed,
    accepted: done.accepted,
    revealed: done.revealed,
    total: problem.steps.length,
    language: timer.language,
    outcome,
    counted: outcome === 'completed' && !timer.overtime && elapsed <= timer.budget && done.revealed === 0,
  };
}

/** The learner's time for a problem: the fastest counted session, if any. */
export function bestSession(sessions: readonly TimedSession[], problemId: string): TimedSession | null {
  let best: TimedSession | null = null;
  for (const s of sessions) {
    if (s.problemId !== problemId || !s.counted) continue;
    if (best === null || s.elapsed < best.elapsed) best = s;
  }
  return best;
}

/** One line for a session in a history list. */
export function describeSession(session: TimedSession): string {
  const steps = `${session.accepted}${session.revealed > 0 ? `+${session.revealed} revealed` : ''}/${
    session.total
  } steps`;
  if (session.outcome === 'completed') {
    if (session.counted) return `completed in ${formatClock(session.elapsed)}`;
    const why =
      session.revealed > 0
        ? 'a solution was revealed'
        : `${formatClock(session.elapsed - session.budget)} over the budget`;
    return `completed in ${formatClock(session.elapsed)} · ${why} · not counted`;
  }
  if (session.outcome === 'expired') return `time ran out · ${steps}`;
  return `ended at ${formatClock(session.elapsed)} · ${steps}`;
}
