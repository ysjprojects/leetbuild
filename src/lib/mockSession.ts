/**
 * The mock interview's session, kept in localStorage as it changes, so Back, a reload, the logo or
 * the mode switch never throw an attempt away: the scenario page resumes it and the picker offers
 * to. One session is kept; starting another clock replaces it. The clock is a stored deadline, so
 * time spent away still counts.
 */
import type {Verdict} from './judge';
import {type Language, LANGUAGES} from './types';

export interface MockMessage {
  id: number;
  from: 'ai' | 'you';
  text: string;
  tone?: 'ok' | 'warn';
}

export interface MockSession {
  scenarioId: string;
  phase: 'running' | 'report';
  language: Language;
  /** The code in each language, as the candidate left it. */
  code: Partial<Record<Language, string>>;
  /** When the clock runs out, in `Date.now()` milliseconds. */
  deadline: number;
  /** When the session ended (Finish, acceptance or time-up); null while the clock runs. */
  endedAt: number | null;
  attempts: number;
  hints: number;
  messages: MockMessage[];
  followUps: Record<number, string>;
  /** The latest verdict and the code it graded. */
  verdict: Verdict | null;
  verdictCode: string | null;
}

const KEY = 'leetbuild:mock-session';

const isSession = (value: unknown): value is MockSession => {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<MockSession>;
  return (
    typeof s.scenarioId === 'string' &&
    (s.phase === 'running' || s.phase === 'report') &&
    LANGUAGES.includes(s.language as Language) &&
    typeof s.code === 'object' &&
    s.code !== null &&
    typeof s.deadline === 'number' &&
    (s.endedAt === null || typeof s.endedAt === 'number') &&
    typeof s.attempts === 'number' &&
    typeof s.hints === 'number' &&
    Array.isArray(s.messages) &&
    typeof s.followUps === 'object' &&
    s.followUps !== null
  );
};

/** The saved session, or null when there is none (or storage is unavailable or holds something else). */
export function loadMockSession(): MockSession | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveMockSession(session: MockSession): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage full or blocked: the session still runs, it just cannot be resumed.
  }
}

export function clearMockSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing was stored.
  }
}

/** Whole seconds left on a session's clock at `at` (it stops at `endedAt`). */
export const secondsLeftAt = (deadline: number, endedAt: number | null, at: number): number =>
  Math.max(0, Math.ceil((deadline - (endedAt ?? at)) / 1000));
