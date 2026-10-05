/**
 * The game layer on top of scoring: badges earned from the attempt record, daily streaks from the
 * days a step was accepted, and the Wordle-style result card for sharing. Everything here is a pure
 * function of persisted progress, so badges can be recomputed (and never lost) from the attempts.
 */
import {type StepAttempt, OPEN_ATTEMPT, problemScore, profile as computeProfile, RANKS} from './scoring';
import {type Language, type Problem, CONCEPT_LABEL, LANGUAGE_LABEL, stepKey} from './types';

export interface Badge {
  id: string;
  title: string;
  /** How to earn it, shown as the tooltip and in the toast. */
  blurb: string;
  /** Two or three characters drawn on the badge. */
  glyph: string;
}

export const BADGES: readonly Badge[] = [
  {id: 'first-light', title: 'First light', blurb: 'Get a step accepted.', glyph: '1'},
  {id: 'unassisted', title: 'Unassisted', blurb: 'Accept a step without revealing a hint.', glyph: '0h'},
  {id: 'first-try', title: 'First try', blurb: 'Accept a step on the first submission, no hints.', glyph: '1x'},
  {id: 'comeback', title: 'Comeback', blurb: 'Accept a step after three or more wrong submissions.', glyph: '↺'},
  {id: 'shipped', title: 'Shipped', blurb: 'Accept every step of a problem.', glyph: '✓'},
  {
    id: 'clean-sweep',
    title: 'Clean sweep',
    blurb: 'Accept every step of a problem with no hints and no wrong submissions.',
    glyph: '★',
  },
  {id: 'hard-mode', title: 'Hard mode', blurb: 'Accept every step of a hard problem.', glyph: 'H'},
  {id: 'bilingual', title: 'Bilingual', blurb: 'Accept steps in two different languages.', glyph: '2L'},
  {id: 'polyglot', title: 'Polyglot', blurb: 'Accept steps in all four languages.', glyph: '4L'},
  {id: 'http-master', title: 'HTTPS master', blurb: 'Accept every HTTPS step in the course.', glyph: 'TLS'},
  {id: 'grpc-master', title: 'gRPC master', blurb: 'Accept every gRPC step in the course.', glyph: 'RPC'},
  {id: 'kafka-master', title: 'Kafka master', blurb: 'Accept every Kafka step in the course.', glyph: 'LOG'},
  {id: 'redis-master', title: 'Redis master', blurb: 'Accept every Redis step in the course.', glyph: 'KV'},
  {id: 'streak-3', title: 'Three in a row', blurb: 'Accept a step on three consecutive days.', glyph: '3d'},
  {id: 'streak-7', title: 'One week', blurb: 'Accept a step on seven consecutive days.', glyph: '7d'},
  {id: 'halfway', title: 'Halfway there', blurb: 'Earn half of all available points.', glyph: '½'},
  {id: 'archmage', title: 'Archmage', blurb: 'Reach the top of the guild ladder.', glyph: '✦'},
];

const BADGE_BY_ID: Record<string, Badge> = {};
for (const badge of BADGES) BADGE_BY_ID[badge.id] = badge;

export function badgeOf(id: string): Badge | undefined {
  return BADGE_BY_ID[id];
}

/** Local calendar day as `YYYY-MM-DD`; streaks count days, not 24-hour windows. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const previousDay = (key: string): string => {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
};

export interface Streak {
  /** Consecutive active days ending today or yesterday (a day off resets it). */
  current: number;
  best: number;
}

export function streakOf(activeDays: readonly string[], today: string): Streak {
  const days = new Set(activeDays);
  let best = 0;
  for (const day of days) {
    if (days.has(previousDay(day))) continue; // not the start of a run
    let length = 1;
    let next = day;
    for (;;) {
      const [y, m, d] = next.split('-').map(Number);
      next = dayKey(new Date(y, m - 1, d + 1));
      if (!days.has(next)) break;
      length += 1;
    }
    best = Math.max(best, length);
  }
  let current = 0;
  let cursor = days.has(today) ? today : previousDay(today);
  while (days.has(cursor)) {
    current += 1;
    cursor = previousDay(cursor);
  }
  return {current, best};
}

/** Every badge the attempt record earns right now (badges are never revoked; the store keeps the union). */
export function earnedBadges(
  problems: readonly Problem[],
  attempts: Record<string, StepAttempt>,
  activeDays: readonly string[],
  today: string,
): string[] {
  const earned: string[] = [];
  const languages = new Set<Language>();
  let anyAccepted = false;
  let unassisted = false;
  let firstTry = false;
  let comeback = false;
  let shipped = false;
  let cleanSweep = false;
  let hardMode = false;
  for (const problem of problems) {
    let allAccepted = problem.steps.length > 0;
    let spotless = true;
    for (const step of problem.steps) {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      if (attempt.status !== 'accepted') {
        allAccepted = false;
        continue;
      }
      anyAccepted = true;
      if (attempt.language !== null) languages.add(attempt.language);
      if (attempt.hints === 0) unassisted = true;
      if (attempt.hints === 0 && attempt.wrong === 0) firstTry = true;
      else spotless = false;
      if (attempt.wrong >= 3) comeback = true;
    }
    if (allAccepted) {
      shipped = true;
      if (spotless) cleanSweep = true;
      if (problem.difficulty === 'hard') hardMode = true;
    }
  }
  if (anyAccepted) earned.push('first-light');
  if (unassisted) earned.push('unassisted');
  if (firstTry) earned.push('first-try');
  if (comeback) earned.push('comeback');
  if (shipped) earned.push('shipped');
  if (cleanSweep) earned.push('clean-sweep');
  if (hardMode) earned.push('hard-mode');
  if (languages.size >= 2) earned.push('bilingual');
  if (languages.size >= 4) earned.push('polyglot');
  const summary = computeProfile(problems, attempts, 0, 0);
  for (const c of summary.concepts) if (c.total > 0 && c.accepted === c.total) earned.push(`${c.concept}-master`);
  const streak = streakOf(activeDays, today);
  if (streak.best >= 3) earned.push('streak-3');
  if (streak.best >= 7) earned.push('streak-7');
  if (summary.max > 0 && summary.score * 2 >= summary.max) earned.push('halfway');
  if (summary.rank === RANKS[0][1]) earned.push('archmage');
  return earned;
}

/** The result card for one problem, Wordle style: one square per step, then the score. */
export function shareText(
  problem: Problem,
  attempts: Record<string, StepAttempt>,
  language: Language,
  url: string,
): string {
  const squares = problem.steps
    .map(step => {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      if (attempt.status === 'accepted') return attempt.hints === 0 && attempt.wrong === 0 ? '■' : '▣';
      return attempt.status === 'revealed' ? '□' : '·';
    })
    .join(' ');
  const score = problemScore(problem, attempts);
  const concepts = problem.concepts.map(c => CONCEPT_LABEL[c]).join('/');
  return [
    `LeetBuild · ${problem.title} (${problem.difficulty}, ${concepts}) · ${LANGUAGE_LABEL[language]}`,
    `${squares}  ${score.score}/${score.max} pts`,
    '■ first try · ▣ with help · □ revealed · · open',
    url,
  ].join('\n');
}
