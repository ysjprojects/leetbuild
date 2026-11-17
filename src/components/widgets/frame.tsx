import {type FC, type KeyboardEvent, type ReactNode, type RefObject, memo, useEffect, useRef, useState} from 'react';

/** Whether the element's content is wider than the element: it scrolls sideways. */
export function useScrollsSideways(ref: RefObject<HTMLElement>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => setScrolls(el.scrollWidth > el.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
}

/**
 * A picture that keeps a readable size on a narrow screen: below `minWidth` it scrolls sideways
 * instead of shrinking its text, and then it takes keyboard focus (arrow keys scroll it) and says
 * it scrolls. `centered` opens it scrolled to the middle, for a figure whose subject is there.
 */
export const SideScroll: FC<{children: ReactNode; label: string; minWidth: number; centered?: boolean}> = memo(
  ({children, label, minWidth, centered = false}) => {
    const scroller = useRef<HTMLDivElement>(null);
    const scrolls = useScrollsSideways(scroller);
    useEffect(() => {
      const el = scroller.current;
      if (centered && scrolls && el !== null) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    }, [centered, scrolls]);
    return (
      <>
        <div
          aria-label={scrolls ? `${label}, scrolls sideways` : undefined}
          className="overflow-x-auto"
          ref={scroller}
          role={scrolls ? 'region' : undefined}
          tabIndex={scrolls ? 0 : undefined}>
          <div style={{minWidth}}>{children}</div>
        </div>
        {scrolls ? <p className="text-ink-400 mt-1 text-[10px]">scroll sideways for the whole picture</p> : null}
      </>
    );
  },
);
SideScroll.displayName = 'SideScroll';

/** The smallest a picture is drawn before it scrolls sideways instead: 85 % of its own size. */
const READABLE_SCALE = 0.85;

/**
 * The widest a picture's minimum gets, widgets' included: a desktop column (the step pane is about
 * 500 px at 1280) scales a picture to fit, and only a phone's column makes it scroll.
 */
export const SCROLL_MIN_CAP = 480;

/** The minimum width of a picture `width` units wide: `READABLE_SCALE` of it, at most `SCROLL_MIN_CAP`. */
export const readableMinWidth = (width: number): number => Math.min(width * READABLE_SCALE, SCROLL_MIN_CAP);

/**
 * Rounded panel every lesson widget renders inside: a tiny title line, the picture (scrolling
 * sideways on a narrow screen), then a one-sentence readout that is announced as it changes.
 */
const WidgetFrame: FC<{children: ReactNode; controls?: ReactNode; readout: ReactNode; title: string}> = memo(
  ({children, controls, readout, title}) => (
    <div className="border-ink-700 bg-ink-850 my-3 rounded-xl border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-iris-400 text-[11px] uppercase tracking-wider">{title}</div>
        {controls === undefined ? null : (
          <div className="text-ink-200 flex flex-wrap items-center gap-2 text-[11px]">{controls}</div>
        )}
      </div>
      <SideScroll label={title} minWidth={SCROLL_MIN_CAP}>
        {children}
      </SideScroll>
      <div aria-live="polite" className="text-ink-200 mt-2 text-[12px] leading-snug">
        {readout}
      </div>
    </div>
  ),
);
WidgetFrame.displayName = 'WidgetFrame';

export default WidgetFrame;

/** Enter or Space on a focusable SVG part (`role="button"`) clicks it, as on a real button. */
export const clickOnKey = (e: KeyboardEvent<Element>): void => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  e.currentTarget.dispatchEvent(new MouseEvent('click', {bubbles: true}));
};

export const RANGE_CLASS = 'h-1 w-24 cursor-pointer accent-iris-400';

export const tabClass = (active: boolean): string =>
  `rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
    active ? 'border-iris-400 bg-iris-400/15 text-ink-50' : 'border-ink-600 bg-ink-800 text-ink-200 hover:text-ink-50'
  }`;

export const numParam = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

export const boolParam = (params: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
};

export const stringParam = <T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const v = params[key];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

/** `[x, y, z]` with missing/invalid entries filled from `fallback`. */
export const tupleParam = (
  params: Record<string, unknown>,
  key: string,
  fallback: [number, number, number],
): [number, number, number] => {
  const v = params[key];
  if (!Array.isArray(v)) return fallback;
  const pick = (i: number): number => {
    const n = v[i];
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback[i];
  };
  return [pick(0), pick(1), pick(2)];
};

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
