/**
 * Whether the visitor has been here before, known before first paint. Progress lives in IndexedDB,
 * which answers only after the page has painted, so a flag in localStorage mirrors "there is
 * progress" and `RETURNING_BOOT_SCRIPT` copies it onto <html> as `data-returning`, the way the theme
 * boot script sets `data-theme`. The landing hero and its skeleton style the compact form off that
 * attribute (`[[data-returning]_&]:` classes), so a returning learner sees it from the first frame.
 * The attribute stays as the document booted: progress made on this visit compacts the next one,
 * never the page under the reader.
 */
import type {StepAttempt} from './scoring';

export const RETURNING_KEY = 'leetbuild:returning';

export const RETURNING_BOOT_SCRIPT =
  `(function(){try{if(localStorage.getItem(${JSON.stringify(RETURNING_KEY)})==='1')` +
  `document.documentElement.dataset.returning=''}catch(e){}})()`;

/** Mirrors the progress into the flag: any judged submission or a step done (accepted or revealed) makes a returning learner. */
export function rememberReturning(progress: {submissions: number; attempts: Record<string, StepAttempt>}): void {
  const returning = progress.submissions > 0 || Object.values(progress.attempts).some(a => a.status !== 'open');
  try {
    if (returning) localStorage.setItem(RETURNING_KEY, '1');
    else localStorage.removeItem(RETURNING_KEY);
  } catch {
    // Storage unavailable (private mode, quota): every visit gets the full hero.
  }
}
