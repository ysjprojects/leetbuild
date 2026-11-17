import {githubSlug, GUIDES_PATH} from '@/lib/export';
import {type GuideId, GUIDE_IDS} from '@/lib/types';

import {PART as PART1} from './part1';
import {PART as PART2} from './part2';
import {PART as PART3} from './part3';
import {PART as PART4} from './part4';

/**
 * The guide sections that explain what each check of a debugging course tests, so a failed check
 * can link straight to the part of the guide it needs. Keys are `<problemId>/<stepId>/<checkId>`,
 * values `<guideId>#<anchor>` (one or two, most relevant first), the anchor being `githubSlug` of
 * one of the guide's headings, the id its page gives that heading. `yarn verify` checks every key
 * and every section resolves.
 */
export const CHECK_SECTIONS: Record<string, string[]> = {...PART1, ...PART2, ...PART3, ...PART4};

/**
 * Every heading of every guide, in order, so a link can carry its section's title without loading
 * the guide's text. `yarn verify` checks this matches the guides.
 */
export const GUIDE_HEADINGS: Record<GuideId, readonly string[]> = {
  'request-boundaries': [
    'The failure mode at a glance',
    'How it shows up',
    'Identity comes from the credential',
    'A foreign record is a missing record',
    'Admission: every limit before any work',
    'Bytes, not characters',
    'Egress: what responses and logs may carry',
    'The fix, as a pattern',
    'Proving the fix',
  ],
  'idempotent-requests': [
    'A retry is not a new request',
    'How it shows up in the courses',
    'The mechanism: claim, act, record, replay',
    'In Python, with Redis as the key store',
    'In TypeScript, with the record in the same transaction',
    'In Go, the replay branch',
    'Versions, natural keys and retries told apart',
    'The fix and its trade-offs',
    'Proving it with an outcome test',
    'What to take away',
  ],
  'atomic-state': [
    'Two clients, one budget',
    'How it shows up in the courses',
    'Why two round trips interleave',
    'Fix 1: one command, when one exists',
    'Fix 2: a Lua script for a decision with several steps',
    'Fix 3: compare-and-set with a version',
    'Fix 4: MULTI with WATCH, and its retry loop',
    'What does not work',
    'Proving it',
    'What to take away',
  ],
  'keys-and-expiry': [
    'The failure mode',
    'How it shows up',
    'The mechanism',
    'A key names its whole scope',
    'Normalising key parts',
    'The TTL travels in the write',
    'Fixed windows expire with their window',
    'The cost of a sliding expiry',
    'State that must never expire',
    'Unbounded growth',
    'The fix and its trade-offs',
    'Proving it on a virtual clock',
  ],
  leases: [
    'The failure mode',
    'How it shows up',
    'The mechanism',
    'A claim is a deadline, written in the same step as the take',
    'Renewal only by the holder, checked in the same script',
    'Reaping once, guarded by the removal',
    'Fencing: the holder proves it is still the holder',
    'Releasing on every path',
    'Leases versus locks',
    'The fix and its trade-offs',
    'Proving it: a paused worker on a virtual clock',
  ],
  'deadlines-and-retries': [
    'The failure mode',
    'How it shows up in the courses',
    'The mechanism: what a deadline and a status code tell you',
    'A deadline belongs to the call',
    'Per attempt, and inside one overall budget',
    'Which statuses earn another attempt',
    'Bounded, backed off, jittered',
    'One id on every attempt',
    'A stream resumes where it stopped',
    'A timeout is an unknown outcome',
    'The fix and its trade-offs',
    'Proving the fix',
  ],
  'failing-dependencies': [
    'The failure mode',
    'How it shows up',
    'The mechanism',
    'The failure branch is shaped like success',
    'The outage everyone discovers separately',
    'The fix',
    'Fallbacks that say so, and never act',
    'Degraded, not wrong',
    'Failing closed, failing open',
    'Never remember a failure',
    'Last-good data, with a bound',
    'Quorum and partial results, reported',
    'A side path never fails the request',
    'Routing to people',
    'Proving it',
  ],
  'producing-events': [
    'The failure mode',
    'How it shows up',
    'The mechanism',
    'The key is the ordering scope',
    'acks and idempotence prevent two different losses',
    'produce() queues; the delivery report decides',
    'Publish after the commit',
    'The payload is a reference, not the content',
    'The fix and its trade-offs',
    'Proving it',
  ],
  'consuming-events': [
    'The failure mode',
    'How it shows up',
    'The mechanism',
    'Offsets are the only memory',
    'Where duplicates come from',
    'Auto-commit is not "commit after processing"',
    'Consumer groups and partition assignment',
    'Poison records',
    'The fix and its trade-offs',
    '1. Effect, then commit, explicitly',
    '2. Make the effect safe to apply twice',
    '3. Handle poison records deliberately',
    'Proving the fix',
    'What to take away',
  ],
  'honest-reads': [
    'A read that looks right and is not',
    'How it shows up in the courses',
    'Reads scoped to the caller',
    'Live counters and the source of truth',
    'Caches keyed by everything that varies',
    'The caches you do not run',
    'Statistics that earn their verdict',
    'Pagination by cursor, with caps',
    'Partial, pending, stale and degraded, said out loud',
    'The fix and its trade-offs',
    'Proving the fix',
  ],
  'model-output': [
    'The failure mode',
    'How it shows up',
    'Retrieved text is data, not instructions',
    'Grounding: quotes are checked, absence is refused',
    'What a cache may keep',
    'Before a model acts alone',
    'Evals gate releases; versions are pinned',
    'Templates rendered in one pass',
    'The fix and what it costs',
    'Proving it',
  ],
};

const HEADING_BY_SECTION = new Map<string, string>(
  GUIDE_IDS.flatMap(id => GUIDE_HEADINGS[id].map(heading => [`${id}#${githubSlug(heading)}`, heading] as const)),
);

/** The sections a check links to, as `/guides/<id>#<anchor>` and the section's heading; empty if none is mapped. */
export function checkGuideLinks(problemId: string, stepId: string, checkId: string): {href: string; label: string}[] {
  return (CHECK_SECTIONS[`${problemId}/${stepId}/${checkId}`] ?? []).flatMap(section => {
    const label = HEADING_BY_SECTION.get(section);
    return label === undefined ? [] : [{href: `${GUIDES_PATH}/${section}`, label}];
  });
}
