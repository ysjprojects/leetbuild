/**
 * Sharing on LinkedIn, and the certificate a completed course earns. Everything is a URL the
 * browser opens or a string drawn on a canvas; nothing is posted on the learner's behalf.
 *
 * LinkedIn offers two useful deep links: the feed composer prefilled with text
 * (`/feed/?shareActive=true&text=…`) for badges and accepted steps, and "Add to profile"
 * (`/profile/add?startTask=CERTIFICATION_NAME&…`) for a completed course's certificate, which lands
 * it in the Licenses & certifications section with a link back to the certificate page here.
 */
import type {Badge} from './gamify';
import {problemScore} from './scoring';
import type {Progress} from './storage';
import {bestSession, formatClock} from './timer';
import {type Concept, type Difficulty, type Language, type Problem, type Step, LANGUAGE_LABEL, stepKey} from './types';

export const ORGANIZATION = 'LeetBuild';
const HASHTAGS = '#LeetBuild #SystemDesign #DistributedSystems';

export function linkedInPostUrl(text: string): string {
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
}

/** What a certificate needs to know about a course — a tenth of a `Problem`, so the certificate page ships no step code. */
export interface CourseSummary {
  id: string;
  title: string;
  tagline: string;
  difficulty: Difficulty;
  concepts: Concept[];
  steps: number;
}

export const summarize = (problem: Problem): CourseSummary => ({
  id: problem.id,
  title: problem.title,
  tagline: problem.tagline,
  difficulty: problem.difficulty,
  concepts: problem.concepts,
  steps: problem.steps.length,
});

export interface CertificateDetails {
  /** The learner's name as it appears on the certificate. */
  name: string;
  problem: CourseSummary;
  /** When the last step was accepted. */
  completedAt: number;
  language: Language;
  /** Points scored on the course, of its maximum. */
  score: number;
  max: number;
  /** The counted timed run's time in seconds, when there is one. */
  time: number | null;
}

/** What a certificate for `problem` says right now: the learner's name, the last accept, the score, the best timed run. */
export function certificateDetails(problem: Problem, progress: Progress, language: Language): CertificateDetails {
  let completedAt = 0;
  for (const s of problem.steps)
    completedAt = Math.max(completedAt, progress.attempts[stepKey(problem.id, s.id)]?.solvedAt ?? 0);
  const score = problemScore(problem, progress.attempts);
  return {
    name: progress.name,
    problem: summarize(problem),
    completedAt: completedAt || Date.now(),
    language,
    score: score.score,
    max: score.max,
    time: bestSession(progress.sessions, problem.id)?.elapsed ?? null,
  };
}

/**
 * Stable id for a certificate: a short base-36 FNV-1a hash of who, what and when. It verifies
 * nothing on its own (there is no server); it makes the certificate page's address reproducible.
 */
export function certificateId(details: Pick<CertificateDetails, 'name' | 'problem' | 'completedAt'>): string {
  const input = `${details.problem.id}|${details.completedAt}|${details.name.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const prefix = details.problem.id
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 4)
    .toUpperCase();
  return `LB-${prefix}-${hash.toString(36).toUpperCase().padStart(7, '0')}`;
}

/** The certificate's own page: everything it needs travels in the query string (there is no server). */
export function certificateUrl(origin: string, details: CertificateDetails): string {
  const params = new URLSearchParams({
    n: details.name,
    d: String(details.completedAt),
    l: details.language,
    s: String(details.score),
    id: certificateId(details),
  });
  if (details.time !== null) params.set('t', String(details.time));
  return `${origin}/certificate/${details.problem.id}?${params.toString()}`;
}

export function certificateTitle(problem: Pick<CourseSummary, 'title'>): string {
  return `${problem.title} — built step by step on LeetBuild`;
}

/** LinkedIn's "Add to profile" deep link for a certification. */
export function linkedInAddCertificateUrl(details: CertificateDetails, url: string): string {
  const date = new Date(details.completedAt);
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: certificateTitle(details.problem),
    organizationName: ORGANIZATION,
    issueYear: String(date.getFullYear()),
    issueMonth: String(date.getMonth() + 1),
    certUrl: url,
    certId: certificateId(details),
  });
  return `https://www.linkedin.com/profile/add?${params.toString()}`;
}

export function badgeShareText(badge: Badge, url: string): string {
  return `Earned the “${badge.title}” badge on LeetBuild — ${badge.blurb.replace(
    /\.$/,
    '',
  )}.\n\nLeetBuild is LeetCode for systems: real systems built step by step over HTTPS, gRPC, Kafka and Redis.\n\n${url}\n\n${HASHTAGS}`;
}

export function stepShareText(problem: Problem, step: Step, language: Language, url: string): string {
  return `Built “${step.title}” — a step of the ${problem.title} on LeetBuild, in ${LANGUAGE_LABEL[language]}, judged by running the code against in-browser Redis, Kafka, gRPC and Postgres.\n\n${url}\n\n${HASHTAGS}`;
}

export function courseShareText(details: CertificateDetails, url: string): string {
  const time = details.time === null ? '' : ` in a timed run of ${formatClock(details.time)}`;
  return `Completed the ${details.problem.title} course on LeetBuild — ${details.problem.steps} steps in ${
    LANGUAGE_LABEL[details.language]
  }, ${details.score}/${details.max} points${time}.\n\n${
    details.problem.tagline
  }\n\nCertificate: ${url}\n\n${HASHTAGS}`;
}

/** Open a share link in a popup-sized window (falls back to a tab when popups are blocked). */
export function openShare(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer,width=720,height=640');
}
