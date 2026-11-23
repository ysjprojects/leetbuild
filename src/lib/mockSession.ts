/**
 * The mock interview's session, kept in localStorage as it changes, so Back, a reload, the logo or
 * the mode switch never throw an attempt away: the scenario page resumes it and the picker offers
 * to. One session is kept; starting another clock replaces it. The clock is a stored deadline, so
 * time spent away still counts. Beside it: every finished attempt per scenario (the history the
 * report and the picker show) and the workspace's pane widths.
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
  /** Distinct hints revealed so far. */
  hints: number;
  /** Each hint revealed (`flaw:<check id>`, `test`) and the AI pair message that carries it: a hint counts once. */
  revealed?: Record<string, number>;
  messages: MockMessage[];
  followUps: Record<number, string>;
  /** The latest verdict and the code it graded. */
  verdict: Verdict | null;
  verdictCode: string | null;
}

const KEY = 'leetbuild:mock-session';

const isOffered = (language: unknown): language is Language => LANGUAGES.includes(language as Language);

/** A saved session; its language may be one the site no longer offers, which `loadMockSession` repairs. */
const isSession = (value: unknown): value is MockSession => {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<MockSession>;
  return (
    typeof s.scenarioId === 'string' &&
    (s.phase === 'running' || s.phase === 'report') &&
    typeof s.language === 'string' &&
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
    // A language the site no longer offers resumes in Python, as the header preference does.
    return isSession(parsed) ? {...parsed, language: isOffered(parsed.language) ? parsed.language : 'python'} : null;
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

/** A finished attempt at a scenario, as its report graded it. */
export interface MockAttempt {
  /** When the clock started, in `Date.now()` milliseconds: the attempt's identity. */
  startedAt: number;
  /** Null when it was a language the site no longer offers (saved records are repaired, not dropped). */
  language: Language | null;
  accepted: boolean;
  passed: number;
  total: number;
  /** Seconds of the budget used. */
  seconds: number;
  submissions: number;
  hints: number;
  /** Graded by reading the code (a language that does not run here), not by running it. */
  read?: boolean;
}

const HISTORY_KEY = 'leetbuild:mock-history';
/** Attempts kept per scenario, newest first. */
const HISTORY_LIMIT = 20;

/** A saved attempt, repaired: a language the site no longer offers becomes null; malformed is null. */
const toAttempt = (value: unknown): MockAttempt | null => {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Partial<MockAttempt>;
  if (
    typeof a.startedAt !== 'number' ||
    typeof a.accepted !== 'boolean' ||
    typeof a.passed !== 'number' ||
    typeof a.total !== 'number' ||
    typeof a.seconds !== 'number' ||
    typeof a.submissions !== 'number' ||
    typeof a.hints !== 'number'
  )
    return null;
  const attempt: MockAttempt = {
    startedAt: a.startedAt,
    language: isOffered(a.language) ? a.language : null,
    accepted: a.accepted,
    passed: a.passed,
    total: a.total,
    seconds: a.seconds,
    submissions: a.submissions,
    hints: a.hints,
  };
  if (a.read === true) attempt.read = true;
  return attempt;
};

/** Every scenario's attempts, newest first; empty when storage holds none or is unavailable. */
export function loadMockHistory(): Record<string, MockAttempt[]> {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([id, list]) => [
        id,
        Array.isArray(list) ? list.flatMap(item => toAttempt(item) ?? []) : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** Record (or update, by `startedAt`) an attempt at `scenarioId`; returns the scenario's attempts. */
export function recordMockAttempt(scenarioId: string, attempt: MockAttempt): MockAttempt[] {
  const history = loadMockHistory();
  const list = [attempt, ...(history[scenarioId] ?? []).filter(a => a.startedAt !== attempt.startedAt)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify({...history, [scenarioId]: list}));
  } catch {
    // Storage full or blocked: the report still shows this attempt.
  }
  return list;
}

/** The best of `attempts`: accepted before not, run before read, then more checks, then less time. */
export const bestAttempt = (attempts: readonly MockAttempt[]): MockAttempt | null =>
  attempts.reduce<MockAttempt | null>((best, a) => {
    if (best === null) return a;
    if (a.accepted !== best.accepted) return a.accepted ? a : best;
    if ((a.read === true) !== (best.read === true)) return a.read === true ? best : a;
    const share = a.passed / Math.max(1, a.total);
    const bestShare = best.passed / Math.max(1, best.total);
    if (share !== bestShare) return share > bestShare ? a : best;
    return a.seconds < best.seconds ? a : best;
  }, null);

/** The workspace's widths on wide screens, as shares of its width: the brief on the left, the AI pair on the right. */
export interface MockLayout {
  brief: number;
  pair: number;
}

export const DEFAULT_MOCK_LAYOUT: MockLayout = {brief: 0.27, pair: 0.25};
export const MOCK_LAYOUT_BOUNDS = {min: 0.16, max: 0.42} as const;

const LAYOUT_KEY = 'leetbuild:mock-layout';

const inBounds = (share: unknown): share is number =>
  typeof share === 'number' && share >= MOCK_LAYOUT_BOUNDS.min && share <= MOCK_LAYOUT_BOUNDS.max;

export function loadMockLayout(): MockLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    const parsed = (raw === null ? null : JSON.parse(raw)) as Partial<MockLayout> | null;
    return parsed !== null && inBounds(parsed.brief) && inBounds(parsed.pair)
      ? {brief: parsed.brief, pair: parsed.pair}
      : DEFAULT_MOCK_LAYOUT;
  } catch {
    return DEFAULT_MOCK_LAYOUT;
  }
}

export function saveMockLayout(layout: MockLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The widths reset next time.
  }
}
