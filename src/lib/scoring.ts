/**
 * Scoring, LeetCode-style: every step is worth points by problem difficulty; each hint revealed and
 * each wrong submission takes a slice off (never below a floor), and revealing the solution marks
 * the step done for zero points. Totals roll up into a rank title and per-concept mastery.
 */
import {type Concept, type Difficulty, type Language, type Problem, CONCEPTS, stepKey} from './types';

/** One judged submission, kept per step (newest last, capped) for the Submissions list. */
export interface Submission {
  at: number;
  language: Language;
  passed: number;
  total: number;
  accepted: boolean;
}

export const HISTORY_LENGTH = 12;

export interface StepAttempt {
  status: 'open' | 'accepted' | 'revealed';
  /** Hints revealed so far (0–hints.length). */
  hints: number;
  /** Submissions that did not pass every check. */
  wrong: number;
  /** Language of the accepted submission (or the last one judged). */
  language: Language | null;
  solvedAt: number | null;
  /** Absent in records written before histories were kept. */
  history?: Submission[];
}

export const OPEN_ATTEMPT: StepAttempt = {status: 'open', hints: 0, wrong: 0, language: null, solvedAt: null};

/**
 * Points per step by difficulty, chosen so the whole course adds up to exactly `COURSE_POINTS`
 * (10 easy + 17 medium + 29 hard steps: 110 + 357 + 870 = 1337). The verify script enforces the
 * total, so adding or removing a step means re-balancing these.
 */
export const STEP_POINTS: Record<Difficulty, number> = {easy: 11, medium: 21, hard: 30};

/** The course is worth exactly this many points — the number is the point. */
export const COURSE_POINTS = 1337;

/** Fraction of a step's points lost per hint revealed. */
export const HINT_COST = 0.2;
/** Fraction lost per wrong submission. */
export const WRONG_COST = 0.05;
/** An accepted step never scores below this fraction of its points. */
export const SCORE_FLOOR = 0.25;

export function stepScore(difficulty: Difficulty, attempt: StepAttempt): number {
  if (attempt.status !== 'accepted') return 0;
  const fraction = Math.max(SCORE_FLOOR, 1 - HINT_COST * attempt.hints - WRONG_COST * attempt.wrong);
  return Math.round(STEP_POINTS[difficulty] * fraction);
}

/** Points the step would score if accepted now, given the hints and wrong submissions so far. */
export function potentialScore(difficulty: Difficulty, attempt: StepAttempt): number {
  return stepScore(difficulty, {...attempt, status: 'accepted'});
}

export interface ProblemScore {
  score: number;
  max: number;
  /** Steps accepted or revealed. */
  done: number;
  accepted: number;
  total: number;
}

export function problemScore(problem: Problem, attempts: Record<string, StepAttempt>): ProblemScore {
  let score = 0;
  let done = 0;
  let accepted = 0;
  for (const step of problem.steps) {
    const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
    score += stepScore(problem.difficulty, attempt);
    if (attempt.status !== 'open') done += 1;
    if (attempt.status === 'accepted') accepted += 1;
  }
  return {
    score,
    max: STEP_POINTS[problem.difficulty] * problem.steps.length,
    done,
    accepted,
    total: problem.steps.length,
  };
}

export interface ConceptMastery {
  concept: Concept;
  accepted: number;
  total: number;
}

export interface Profile {
  score: number;
  max: number;
  /** Problems with every step accepted (a revealed step keeps the problem out of this count). */
  solved: Record<Difficulty, number>;
  problems: Record<Difficulty, number>;
  stepsAccepted: number;
  stepsRevealed: number;
  submissions: number;
  /** Accepted submissions over all submissions, 0–1. */
  acceptance: number;
  concepts: ConceptMastery[];
  rank: string;
}

/**
 * Rank titles by share of all available points, highest first: a guild ladder for people who build
 * systems — from a Novice sweeping the workshop to the Archmage whose machines run the realm.
 */
export const RANKS: [number, string][] = [
  [0.9, 'Archmage'],
  [0.7, 'Master Artificer'],
  [0.45, 'Artificer'],
  [0.25, 'Journeyman'],
  [0.1, 'Apprentice'],
  [0, 'Novice'],
];

export interface RankProgress {
  rank: string;
  /** Next title, or null at the top. */
  next: string | null;
  /** Points at which the current and next ranks start. */
  from: number;
  nextAt: number;
}

export function rankProgress(score: number, max: number): RankProgress {
  const share = max === 0 ? 0 : score / max;
  const index = RANKS.findIndex(([threshold]) => share >= threshold);
  const current = RANKS[index === -1 ? RANKS.length - 1 : index];
  const above = index > 0 ? RANKS[index - 1] : null;
  return {
    rank: current[1],
    next: above === null ? null : above[1],
    // A rank starts at the first whole point at or above its share, matching the `share >= threshold` test.
    from: Math.ceil(current[0] * max),
    nextAt: above === null ? max : Math.ceil(above[0] * max),
  };
}

export function profile(
  problems: readonly Problem[],
  attempts: Record<string, StepAttempt>,
  submissions: number,
  acceptedSubmissions: number,
): Profile {
  let score = 0;
  let max = 0;
  let stepsAccepted = 0;
  let stepsRevealed = 0;
  const solved: Record<Difficulty, number> = {easy: 0, medium: 0, hard: 0};
  const counts: Record<Difficulty, number> = {easy: 0, medium: 0, hard: 0};
  const byConcept: Record<Concept, ConceptMastery> = {
    http: {concept: 'http', accepted: 0, total: 0},
    grpc: {concept: 'grpc', accepted: 0, total: 0},
    kafka: {concept: 'kafka', accepted: 0, total: 0},
    redis: {concept: 'redis', accepted: 0, total: 0},
  };
  for (const problem of problems) {
    const p = problemScore(problem, attempts);
    score += p.score;
    max += p.max;
    counts[problem.difficulty] += 1;
    if (p.accepted === p.total) solved[problem.difficulty] += 1;
    for (const step of problem.steps) {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      byConcept[step.concept].total += 1;
      if (attempt.status === 'accepted') {
        stepsAccepted += 1;
        byConcept[step.concept].accepted += 1;
      } else if (attempt.status === 'revealed') stepsRevealed += 1;
    }
  }
  const share = max === 0 ? 0 : score / max;
  const rank = RANKS.find(([threshold]) => share >= threshold)?.[1] ?? RANKS[RANKS.length - 1][1];
  return {
    score,
    max,
    solved,
    problems: counts,
    stepsAccepted,
    stepsRevealed,
    submissions,
    acceptance: submissions === 0 ? 0 : acceptedSubmissions / submissions,
    concepts: CONCEPTS.map(c => byConcept[c]),
    rank,
  };
}
