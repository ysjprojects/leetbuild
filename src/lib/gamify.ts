/**
 * The game layer on top of scoring: badges earned from the attempt record, daily streaks from the
 * days a step was accepted, and the Wordle-style result card for sharing. Everything here is a pure
 * function of persisted progress, so badges can be recomputed (and never lost) from the attempts.
 *
 * Every badge reports *progress* (`badgeProgress`), not just earned-or-not: "Kafka master 3/16",
 * "Shipped 4/6 · Image Cache". A badge is earned exactly when its progress is complete, which is
 * what the profile shows and what the toasts announce.
 */
import {type StepAttempt, OPEN_ATTEMPT, problemScore, profile as computeProfile, RANKS} from './scoring';
import {type Concept, type Language, type Problem, CONCEPT_LABEL, CONCEPTS, LANGUAGE_LABEL, stepKey} from './types';

/** Badges are grouped into tracks so the catalog reads as a few short lists, not one wall. */
export type BadgeTrack = 'milestone' | 'craft' | 'mastery' | 'habit' | 'languages';

export const TRACKS: readonly {id: BadgeTrack; title: string; blurb: string}[] = [
  {id: 'milestone', title: 'Milestones', blurb: 'The road from the first accepted step to the top of the ladder.'},
  {id: 'craft', title: 'Craft', blurb: 'How you solve, not just whether.'},
  {id: 'mastery', title: 'Mastery', blurb: 'Every step of a concept, across the whole course.'},
  {id: 'habit', title: 'Habit', blurb: 'Accept a step on consecutive days.'},
  {id: 'languages', title: 'Languages', blurb: 'The same systems in more than one language.'},
];

export interface Badge {
  id: string;
  title: string;
  /** How to earn it, shown in the catalog, the tooltip and the toast. */
  blurb: string;
  /** One or two characters drawn on the badge. */
  glyph: string;
  track: BadgeTrack;
  /** Mastery badges carry their concept's colour. */
  concept?: Concept;
}

export const BADGES: readonly Badge[] = [
  {id: 'first-light', title: 'First light', blurb: 'Get a step accepted.', glyph: '✦', track: 'milestone'},
  {id: 'shipped', title: 'Shipped', blurb: 'Accept every step of a problem.', glyph: '✓', track: 'milestone'},
  {id: 'hard-mode', title: 'Hard mode', blurb: 'Accept every step of a hard problem.', glyph: 'H', track: 'milestone'},
  {id: 'halfway', title: 'Halfway there', blurb: 'Earn half of all available points.', glyph: '½', track: 'milestone'},
  {id: 'archmage', title: 'Archmage', blurb: 'Reach the top of the ladder.', glyph: '♛', track: 'milestone'},
  {
    id: 'unassisted',
    title: 'Unassisted',
    blurb: 'Accept a step without revealing a hint.',
    glyph: '0h',
    track: 'craft',
  },
  {
    id: 'first-try',
    title: 'First try',
    blurb: 'Accept a step on the first submission, no hints.',
    glyph: '1st',
    track: 'craft',
  },
  {
    id: 'clean-sweep',
    title: 'Clean sweep',
    blurb: 'Accept every step of a problem with no hints and no wrong submissions.',
    glyph: '★',
    track: 'craft',
  },
  {
    id: 'comeback',
    title: 'Comeback',
    blurb: 'Accept a step after three or more wrong submissions.',
    glyph: '↺',
    track: 'craft',
  },
  {
    id: 'http-master',
    title: 'HTTPS master',
    blurb: 'Accept every HTTPS step in the course.',
    glyph: 'TLS',
    track: 'mastery',
    concept: 'http',
  },
  {
    id: 'grpc-master',
    title: 'gRPC master',
    blurb: 'Accept every gRPC step in the course.',
    glyph: 'RPC',
    track: 'mastery',
    concept: 'grpc',
  },
  {
    id: 'kafka-master',
    title: 'Kafka master',
    blurb: 'Accept every Kafka step in the course.',
    glyph: 'LOG',
    track: 'mastery',
    concept: 'kafka',
  },
  {
    id: 'redis-master',
    title: 'Redis master',
    blurb: 'Accept every Redis step in the course.',
    glyph: 'KV',
    track: 'mastery',
    concept: 'redis',
  },
  {
    id: 'streak-3',
    title: 'Three in a row',
    blurb: 'Accept a step on three consecutive days.',
    glyph: '3d',
    track: 'habit',
  },
  {id: 'streak-7', title: 'One week', blurb: 'Accept a step on seven consecutive days.', glyph: '7d', track: 'habit'},
  {
    id: 'bilingual',
    title: 'Bilingual',
    blurb: 'Accept steps in two different languages.',
    glyph: '2',
    track: 'languages',
  },
  {id: 'polyglot', title: 'Polyglot', blurb: 'Accept steps in all four languages.', glyph: '4', track: 'languages'},
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
  /** A step was accepted today: the streak is safe until tomorrow. */
  today: boolean;
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
  return {current, best, today: days.has(today)};
}

/** How far along a badge is: earned when `value >= target`. Binary badges have a target of 1. */
export interface BadgeProgress {
  value: number;
  target: number;
  /** What the numbers refer to, when it helps: the problem closest to being shipped, the languages used. */
  detail?: string;
}

const flag = (earned: boolean): BadgeProgress => ({value: earned ? 1 : 0, target: 1});

/** The problem with the highest `done/total` among those `eligible` (ties: the one with more steps done). */
const closest = (
  problems: readonly Problem[],
  eligible: (problem: Problem) => boolean,
  done: (problem: Problem) => number,
): BadgeProgress => {
  let best: BadgeProgress = {value: 0, target: 1};
  let bestRatio = -1;
  for (const problem of problems) {
    if (!eligible(problem) || problem.steps.length === 0) continue;
    const value = done(problem);
    const ratio = value / problem.steps.length;
    if (ratio > bestRatio || (ratio === bestRatio && value > best.value)) {
      bestRatio = ratio;
      // Which problem is "closest" only means something once one has moved.
      best = {value, target: problem.steps.length, detail: value > 0 ? problem.title : undefined};
    }
  }
  return best;
};

/** Progress toward every badge, by id. */
export function badgeProgress(
  problems: readonly Problem[],
  attempts: Record<string, StepAttempt>,
  activeDays: readonly string[],
  today: string,
): Record<string, BadgeProgress> {
  const languages = new Set<Language>();
  let accepted = 0;
  let unassisted = false;
  let firstTry = false;
  let comeback = false;
  const acceptedIn = (problem: Problem): number =>
    problem.steps.filter(s => (attempts[stepKey(problem.id, s.id)] ?? OPEN_ATTEMPT).status === 'accepted').length;
  /** Accepted steps of a problem whose record is still spotless (no hints, no wrong submissions, nothing revealed). */
  const spotlessIn = (problem: Problem): number => {
    let count = 0;
    for (const step of problem.steps) {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      if (attempt.status === 'revealed' || attempt.hints > 0 || attempt.wrong > 0) return -1;
      if (attempt.status === 'accepted') count += 1;
    }
    return count;
  };
  for (const problem of problems) {
    for (const step of problem.steps) {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      if (attempt.status !== 'accepted') continue;
      accepted += 1;
      if (attempt.language !== null) languages.add(attempt.language);
      if (attempt.hints === 0) unassisted = true;
      if (attempt.hints === 0 && attempt.wrong === 0) firstTry = true;
      if (attempt.wrong >= 3) comeback = true;
    }
  }
  const summary = computeProfile(problems, attempts, 0, 0);
  const streak = streakOf(activeDays, today);
  const languageList = [...languages].map(l => LANGUAGE_LABEL[l]).join(', ');
  const progress: Record<string, BadgeProgress> = {
    'first-light': flag(accepted > 0),
    shipped: closest(problems, () => true, acceptedIn),
    'hard-mode': closest(problems, p => p.difficulty === 'hard', acceptedIn),
    halfway: {
      value: Math.min(summary.score, Math.ceil(summary.max / 2)),
      target: Math.ceil(summary.max / 2),
      detail: 'points',
    },
    archmage: {
      value: Math.min(summary.score, Math.ceil(RANKS[0][0] * summary.max)),
      target: Math.ceil(RANKS[0][0] * summary.max),
      detail: 'points',
    },
    unassisted: flag(unassisted),
    'first-try': flag(firstTry),
    'clean-sweep': closest(
      problems,
      p => spotlessIn(p) >= 0,
      p => Math.max(0, spotlessIn(p)),
    ),
    comeback: flag(comeback),
    // A past run does not count toward a streak badge; only the current one can reach it.
    'streak-3': {value: streak.best >= 3 ? 3 : Math.min(streak.current, 3), target: 3, detail: 'days'},
    'streak-7': {value: streak.best >= 7 ? 7 : Math.min(streak.current, 7), target: 7, detail: 'days'},
    bilingual: {value: Math.min(languages.size, 2), target: 2, detail: languageList || undefined},
    polyglot: {value: Math.min(languages.size, 4), target: 4, detail: languageList || undefined},
  };
  for (const concept of CONCEPTS) {
    const mastery = summary.concepts.find(c => c.concept === concept);
    progress[`${concept}-master`] = {
      value: mastery?.accepted ?? 0,
      target: Math.max(1, mastery?.total ?? 0),
      detail: `${CONCEPT_LABEL[concept]} steps`,
    };
  }
  return progress;
}

/** Every badge the attempt record earns right now (badges are never revoked; the store keeps the union). */
export function earnedBadges(
  problems: readonly Problem[],
  attempts: Record<string, StepAttempt>,
  activeDays: readonly string[],
  today: string,
): string[] {
  const progress = badgeProgress(problems, attempts, activeDays, today);
  return BADGES.filter(b => progress[b.id].value >= progress[b.id].target).map(b => b.id);
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
