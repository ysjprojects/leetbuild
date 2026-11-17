/**
 * The way back to the list a course was opened from. The landing page scrolls inside `<main>`, not
 * the window, so the browser never restores its place; and a filtered view lives in the query string,
 * which a plain link to `/` drops. `rememberListView` keeps both for this tab (sessionStorage):
 * ProblemList calls it as any navigation leaves the list (and on `pagehide`), "← problems" goes to
 * `listHref()`, and ProblemList restores the scroll when it mounts on the view it remembered.
 */
import Router from 'next/router';

const KEY = 'leetbuild:list-view';

/** ProblemList's root: the list scrolls with the `<main>` around it. */
export const LIST_ROOT_ID = 'problem-list';

interface ListView {
  search: string;
  scroll: number;
}

function remembered(): ListView | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const {search, scroll} = value as Partial<ListView>;
    return typeof search === 'string' && typeof scroll === 'number' ? {search, scroll} : null;
  } catch {
    return null;
  }
}

/**
 * The query of the page the router shows. Not `location.search`: on Back and Forward the browser has
 * already moved `location` to the next page when the router announces the change.
 */
const shownSearch = (): string => new URL(Router.asPath, location.href).search;

/** Saves the list's address (its query) and scroll position; a no-op unless the list is on the page. */
export function rememberListView(): void {
  const main = document.getElementById(LIST_ROOT_ID)?.closest('main') ?? null;
  if (main === null) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({search: shownSearch(), scroll: main.scrollTop}));
  } catch {
    // Storage unavailable (private mode, quota): the way back is plain `/`.
  }
}

/** The remembered list address, track, filters and search included; `'/'` if none. */
export function listHref(): string {
  if (typeof window === 'undefined') return '/';
  const view = remembered();
  return view === null || view.search === '' ? '/' : `/${view.search}`;
}

/** Puts the list back where it was left when it shows the remembered view (the same query); call once its rows have rendered. */
export function restoreListView(): void {
  const view = remembered();
  const main = document.getElementById(LIST_ROOT_ID)?.closest('main') ?? null;
  if (view !== null && main !== null && view.search === shownSearch()) main.scrollTop = view.scroll;
}
