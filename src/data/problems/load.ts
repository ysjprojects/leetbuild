import type {Problem} from '@/lib/types';

import {problemModules} from './modules';

/**
 * The courses fetched so far. A course is a chunk of its own (`problemModules`), fetched the first
 * time it opens; afterwards it is here, and opening it again renders without waiting.
 */
const loaded = new Map<string, Problem>();
const pending = new Map<string, Promise<Problem>>();

/** The course, once it has been fetched. */
export const loadedProblem = (id: string): Problem | undefined => loaded.get(id);

/**
 * Fetch a course, once: concurrent callers share the request. Rejects for an id no course has and
 * when the chunk cannot be fetched (offline, or a deploy replaced it); a later call tries again.
 */
export function loadProblem(id: string): Promise<Problem> {
  const done = loaded.get(id);
  if (done !== undefined) return Promise.resolve(done);
  const inFlight = pending.get(id);
  if (inFlight !== undefined) return inFlight;
  const load = problemModules[id];
  if (load === undefined) return Promise.reject(new Error(`no course '${id}'`));
  const request = load().then(
    problem => {
      loaded.set(id, problem);
      pending.delete(id);
      return problem;
    },
    (error: unknown) => {
      pending.delete(id);
      throw error;
    },
  );
  pending.set(id, request);
  return request;
}
