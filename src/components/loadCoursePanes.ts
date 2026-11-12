import type * as Panes from './coursePanes';

export type CoursePanes = typeof Panes;

let loaded: CoursePanes | null = null;
let pending: Promise<CoursePanes> | null = null;

/** The course view's components, once they have been fetched. */
export const loadedCoursePanes = (): CoursePanes | null => loaded;

/**
 * Fetch the course view's components, once, beside a course's own chunk: concurrent callers share
 * the request, and a failed fetch (offline, or a deploy replaced the chunk) is tried again next call.
 */
export function loadCoursePanes(): Promise<CoursePanes> {
  if (loaded !== null) return Promise.resolve(loaded);
  pending ??= import('./coursePanes').then(
    panes => {
      loaded = panes;
      pending = null;
      return panes;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}
