import {type FC, type ReactNode, memo} from 'react';

/** Rounded panel every lesson widget renders inside: a tiny title line, the picture, then a one-sentence readout. */
const WidgetFrame: FC<{children: ReactNode; controls?: ReactNode; readout: ReactNode; title: string}> = memo(
  ({children, controls, readout, title}) => (
    <div className="border-ink-700 bg-ink-850 my-3 rounded-xl border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-iris-400 text-[11px] uppercase tracking-wider">{title}</div>
        {controls === undefined ? null : (
          <div className="text-ink-200 flex flex-wrap items-center gap-2 text-[11px]">{controls}</div>
        )}
      </div>
      {children}
      <div className="text-ink-200 mt-2 text-[12px] leading-snug">{readout}</div>
    </div>
  ),
);
WidgetFrame.displayName = 'WidgetFrame';

export default WidgetFrame;

export const SELECT_CLASS =
  'rounded-md border border-ink-600 bg-ink-800 py-0.5 pl-2 pr-6 font-code text-[11px] text-ink-100 focus:border-iris-400 focus:ring-0';

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
