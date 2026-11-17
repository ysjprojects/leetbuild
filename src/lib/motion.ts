/** Motion that honours the reader's `prefers-reduced-motion`: no confetti, no animated scrolling. */

const QUERY = '(prefers-reduced-motion: reduce)';

/** Whether the reader asked the system for reduced motion (false where there is no `matchMedia`). */
export const prefersReducedMotion = (): boolean => typeof matchMedia !== 'undefined' && matchMedia(QUERY).matches;

/** The `behavior` for `scrollIntoView`/`scrollTo`: an instant jump under reduced motion, else smooth. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
