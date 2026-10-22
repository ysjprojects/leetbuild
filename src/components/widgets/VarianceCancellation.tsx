import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

/** Fixed deviations around the offset: mean 0, population variance 0.67. */
const DEVIATIONS = [0.3, -0.8, 1.1, -0.2, 0.6, -1.4, 0.9, -0.5];
const N = DEVIATIONS.length;
const MAX_EXP = 8;
const SCAN_STEP = 0.025;
const ERR_FLOOR = -8;
const ERR_CEIL = 1;

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const HEIGHT = 250;
const PLOT_L = 44;
const PLOT_R = 316;
const PLOT_T = 20;
const PLOT_B = 196;
const PANEL_X = 340;
const STRIP_Y = 232;
const NAIVE_LINE = alpha(danger[400], 0.9);
const WELFORD_LINE = alpha(success[400], 0.9);
const DOT_FILL = alpha(iris[400], 0.7);

const f = Math.fround;

interface Run {
  /** The inputs as float32 holds them. */
  xs: number[];
  exact: number;
  sum: number;
  sumSq: number;
  meanSq: number;
  ex2: number;
  naive: number;
  welford: number;
}

const run = (offset: number): Run => {
  const xs = DEVIATIONS.map(d => f(offset + d));
  const true64 = DEVIATIONS.map(d => offset + d);
  const mean64 = true64.reduce((s, x) => s + x, 0) / N;
  const exact = true64.reduce((s, x) => s + (x - mean64) ** 2, 0) / N;
  let sum = 0;
  let sumSq = 0;
  for (const x of xs) {
    sum = f(sum + x);
    sumSq = f(sumSq + f(x * x));
  }
  const mean = f(sum / N);
  const meanSq = f(mean * mean);
  const ex2 = f(sumSq / N);
  const naive = f(ex2 - meanSq);
  let m = 0;
  let m2 = 0;
  xs.forEach((x, i) => {
    const delta = f(x - m);
    m = f(m + f(delta / (i + 1)));
    m2 = f(m2 + f(delta * f(x - m)));
  });
  return {xs, exact, sum, sumSq, meanSq, ex2, naive, welford: f(m2 / N)};
};

/** log10 of the relative error, clamped to the plot; a result ≤ 0 has no correct digits at all. */
const logErr = (v: number, exact: number): number => {
  if (v <= 0) return ERR_CEIL;
  const rel = Math.abs(v - exact) / exact;
  return rel === 0 ? ERR_FLOOR : Math.min(ERR_CEIL, Math.max(ERR_FLOOR, Math.log10(rel)));
};

const scan = Array.from({length: Math.round(MAX_EXP / SCAN_STEP) + 1}, (_, i) => {
  const e = i * SCAN_STEP;
  const r = run(10 ** e);
  return {e, naive: logErr(r.naive, r.exact), welford: logErr(r.welford, r.exact)};
});
/** First offset where the result keeps no correct digit (relative error ≥ 100%, or ≤ 0). */
const naiveDead = scan.find(s => s.naive >= 0)?.e ?? null;
const welfordDead = scan.find(s => s.welford >= 0)?.e ?? null;

const px = (e: number): number => PLOT_L + (e / MAX_EXP) * (PLOT_R - PLOT_L);
const py = (l: number): number => PLOT_T + ((ERR_CEIL - l) / (ERR_CEIL - ERR_FLOOR)) * (PLOT_B - PLOT_T);
const naivePath = scan.map((s, i) => `${i === 0 ? 'M' : 'L'}${px(s.e).toFixed(1)},${py(s.naive).toFixed(1)}`).join('');
const welfordPath = scan
  .map((s, i) => `${i === 0 ? 'M' : 'L'}${px(s.e).toFixed(1)},${py(s.welford).toFixed(1)}`)
  .join('');

const sci = (n: number): string => n.toExponential(2).replace('-', '−').replace('e+', 'e');
const num = (n: number): string =>
  Math.abs(n) >= 1e5 || (n !== 0 && Math.abs(n) < 1e-3) ? sci(n) : n.toPrecision(7).replace('-', '−');
/** Nine significant digits, enough to show every digit float32 keeps of the two terms being subtracted. */
const wide = (n: number): string => (n < 1e9 ? n.toPrecision(9) : n.toExponential(8).replace('e+', 'e'));
const pct = (v: number, exact: number): string => {
  const rel = Math.abs(v - exact) / exact;
  if (rel === 0) return 'exact';
  if (rel < 0.01) return sci(rel);
  if (rel < 10) return `${(rel * 100).toPrecision(3)}%`;
  return rel < 1e4 ? `${Math.round(rel * 100)}%` : `${sci(rel * 100)}%`;
};

/** Spacing between adjacent float32 values at magnitude x. */
const ulp32 = (x: number): number => 2 ** (Math.floor(Math.log2(x)) - 23);

const VarianceCancellation: FC<WidgetProps> = memo(() => {
  const [exp, setExp] = useState(3);
  const onExp = useCallback((e: ChangeEvent<HTMLInputElement>) => setExp(Number(e.target.value)), []);

  const offset = 10 ** exp;
  const r = useMemo(() => run(offset), [offset]);
  const spacing = ulp32(offset);
  const naiveBad = r.naive <= 0;
  const naiveRel = Math.abs(r.naive - r.exact) / r.exact;
  const welfordRel = Math.abs(r.welford - r.exact) / r.exact;

  const controls = useMemo(
    () => (
      <label className="flex items-center gap-1.5">
        <span className="text-ink-300">offset</span>
        <input
          aria-label="offset, log scale"
          className={RANGE_CLASS}
          max={MAX_EXP}
          min={0}
          onChange={onExp}
          step={SCAN_STEP}
          type="range"
          value={exp}
        />
        <span className="font-code text-ink-100 tabular-nums">{sci(offset)}</span>
      </label>
    ),
    [exp, offset, onExp],
  );

  const readout = useMemo(
    () => (
      <>
        At offset {sci(offset)}, E[x²] − E[x]² gives{' '}
        <b className="text-ink-100">
          {num(r.naive)}
          {naiveBad
            ? r.naive === 0
              ? ' (every digit cancelled)'
              : ' (a negative variance)'
            : ` (${pct(r.naive, r.exact)} off)`}
        </b>{' '}
        and Welford gives <b className="text-ink-100">{num(r.welford)}</b> ({pct(r.welford, r.exact)} off) against{' '}
        {num(r.exact)}. The naive formula keeps no correct digit from offset ≈{' '}
        {naiveDead === null ? 'never' : sci(10 ** naiveDead)} (x² needs twice the digits float32 has); Welford holds
        until ≈ {welfordDead === null ? `beyond ${sci(10 ** MAX_EXP)}` : sci(10 ** welfordDead)}, where the float32
        spacing reaches the deviations themselves.
      </>
    ),
    [naiveBad, offset, r.exact, r.naive, r.welford],
  );

  const stripL = PANEL_X;
  const stripR = WIDTH - 12;
  const sx = (d: number): number => stripL + ((d + 2) / 4) * (stripR - stripL);

  return (
    <WidgetFrame controls={controls} readout={readout} title="variance cancellation in float32">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>
          Relative error of float32 variance by E[x²] − E[x]² and by Welford&apos;s update as the offset grows
        </title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={PLOT_L} y={11}>
            relative error vs offset (log-log)
          </text>
          {[0, -2, -4, -6, -8].map(l => (
            <g key={l}>
              <line stroke={ink[700]} strokeWidth={0.75} x1={PLOT_L} x2={PLOT_R} y1={py(l)} y2={py(l)} />
              <text fill={ink[400]} textAnchor="end" x={PLOT_L - 4} y={py(l) + 3}>
                {l === 0 ? '100%' : `1e${l}`.replace('-', '−')}
              </text>
            </g>
          ))}
          <text fill={danger[300]} x={PLOT_L + 4} y={py(0) - 3}>
            no correct digits
          </text>
          <line
            stroke={ink[500]}
            strokeDasharray="3 3"
            strokeWidth={0.75}
            x1={PLOT_L}
            x2={PLOT_R}
            y1={py(Math.log10(2 ** -24))}
            y2={py(Math.log10(2 ** -24))}
          />
          <text fill={ink[400]} textAnchor="end" x={PLOT_R} y={py(Math.log10(2 ** -24)) - 3}>
            float32 rounding 2⁻²⁴
          </text>
          {[0, 2, 4, 6, 8].map(e => (
            <text fill={ink[400]} key={e} textAnchor="middle" x={px(e)} y={PLOT_B + 12}>
              1e{e}
            </text>
          ))}
          <path d={naivePath} fill="none" stroke={NAIVE_LINE} strokeWidth={1.25} />
          <path d={welfordPath} fill="none" stroke={WELFORD_LINE} strokeWidth={1.25} />
          <line stroke={iris[400]} strokeWidth={1} x1={px(exp)} x2={px(exp)} y1={PLOT_T} y2={PLOT_B} />
          <circle cx={px(exp)} cy={py(logErr(r.naive, r.exact))} fill={danger[400]} r={3} />
          <circle cx={px(exp)} cy={py(logErr(r.welford, r.exact))} fill={success[400]} r={3} />
          <line stroke={danger[400]} strokeWidth={1.5} x1={PLOT_L} x2={PLOT_L + 12} y1={PLOT_B + 24} y2={PLOT_B + 24} />
          <text fill={ink[200]} x={PLOT_L + 16} y={PLOT_B + 27}>
            E[x²] − E[x]²
          </text>
          <line
            stroke={success[400]}
            strokeWidth={1.5}
            x1={PLOT_L + 110}
            x2={PLOT_L + 122}
            y1={PLOT_B + 24}
            y2={PLOT_B + 24}
          />
          <text fill={ink[200]} x={PLOT_L + 126} y={PLOT_B + 27}>
            Welford
          </text>

          <text fill={ink[300]} x={PANEL_X} y={11}>
            8 values = {sci(offset)} + deviations
          </text>
          <text fill={ink[200]} fontSize={10} x={PANEL_X} y={32}>
            exact (float64) <tspan fill={ink[50]}>{num(r.exact)}</tspan>
          </text>
          <text fill={ink[300]} x={PANEL_X} y={54}>
            Σx² / 8 = {wide(r.ex2)}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={67}>
            (Σx / 8)² = {wide(r.meanSq)}
          </text>
          <text fill={naiveBad || naiveRel >= 1 ? danger[300] : ink[100]} fontSize={10} x={PANEL_X} y={84}>
            E[x²] − E[x]² = {num(r.naive)}
          </text>
          <text fill={naiveBad || naiveRel >= 1 ? danger[300] : ink[300]} x={PANEL_X} y={97}>
            {naiveBad
              ? r.naive === 0
                ? 'zero: every digit cancelled'
                : 'negative variance'
              : `error ${pct(r.naive, r.exact)}`}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={119}>
            mean, M2 += δ·(x − mean′)
          </text>
          <text fill={welfordRel >= 1 ? danger[300] : ink[100]} fontSize={10} x={PANEL_X} y={136}>
            Welford M2 / 8 = {num(r.welford)}
          </text>
          <text fill={welfordRel >= 1 ? danger[300] : ink[300]} x={PANEL_X} y={149}>
            error {pct(r.welford, r.exact)}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={175}>
            float32 spacing at offset: {num(spacing)}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={188}>
            {spacing >= 0.5 ? 'inputs already lose the deviations' : 'inputs still hold the deviations'}
          </text>

          <text fill={ink[400]} x={stripL} y={STRIP_Y - 18}>
            stored x − offset · true ▏ float32 ●
          </text>
          <line stroke={ink[600]} strokeWidth={0.75} x1={stripL} x2={stripR} y1={STRIP_Y} y2={STRIP_Y} />
          {[-2, -1, 0, 1, 2].map(d => (
            <text fill={ink[500]} key={d} textAnchor="middle" x={sx(d)} y={STRIP_Y + 12}>
              {d > 0 ? `+${d}` : `${d}`.replace('-', '−')}
            </text>
          ))}
          {DEVIATIONS.map((d, i) => (
            <line key={i} stroke={ink[300]} strokeWidth={1} x1={sx(d)} x2={sx(d)} y1={STRIP_Y - 7} y2={STRIP_Y + 2} />
          ))}
          {r.xs.map((x, i) => {
            const d = x - offset;
            return Math.abs(d) <= 2 ? <circle cx={sx(d)} cy={STRIP_Y - 3} fill={DOT_FILL} key={i} r={2.5} /> : null;
          })}
        </g>
      </svg>
    </WidgetFrame>
  );
});
VarianceCancellation.displayName = 'VarianceCancellation';

export default VarianceCancellation;
