import {type Guide, type PracticeStep, GUIDES_PATH} from '@/lib/export';
import {type GuideId, type Problem, type Source, stepPath} from '@/lib/types';

import * as atomicState from './atomic-state';
import * as consumingEvents from './consuming-events';
import * as deadlinesAndRetries from './deadlines-and-retries';
import * as failingDependencies from './failing-dependencies';
import * as honestReads from './honest-reads';
import * as idempotentRequests from './idempotent-requests';
import * as keysAndExpiry from './keys-and-expiry';
import * as leases from './leases';
import {GUIDES} from './meta';
import * as modelOutput from './model-output';
import * as producingEvents from './producing-events';
import * as requestBoundaries from './request-boundaries';

/** Each failure-mode guide's text (the course markdown dialect, sections at `#`) and the pieces it cites. */
export const GUIDE_CONTENT: Record<GuideId, {guide: string; sources: Source[]}> = {
  'request-boundaries': requestBoundaries,
  'idempotent-requests': idempotentRequests,
  'atomic-state': atomicState,
  'keys-and-expiry': keysAndExpiry,
  leases,
  'deadlines-and-retries': deadlinesAndRetries,
  'failing-dependencies': failingDependencies,
  'producing-events': producingEvents,
  'consuming-events': consumingEvents,
  'honest-reads': honestReads,
  'model-output': modelOutput,
};

/** The steps that name the guide, by course in catalogue order: where a reader practises it. */
export function practiceOf(id: GuideId, catalogue: readonly Problem[]): {course: string; steps: PracticeStep[]}[] {
  return catalogue.flatMap(problem => {
    const steps = problem.steps
      .map((step, i) => ({step, i}))
      .filter(({step}) => step.guides?.includes(id) === true)
      .map(({step, i}) => ({title: `${i + 1}. ${step.title}`, href: stepPath(problem, step)}));
    return steps.length === 0 ? [] : [{course: problem.title, steps}];
  });
}

/** A failure-mode guide as its page renders it: the text, the steps to practise it on, its sources. */
export const sharedGuide = (id: GuideId, catalogue: readonly Problem[]): Guide => ({
  id,
  back: {href: GUIDES_PATH, label: 'all guides'},
  title: GUIDES[id].title,
  tagline: GUIDES[id].tagline,
  learn: GUIDE_CONTENT[id].guide,
  sources: GUIDE_CONTENT[id].sources,
  practice: practiceOf(id, catalogue),
});
