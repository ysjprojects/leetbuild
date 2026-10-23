import {type ChangeEvent, type FC, type ReactElement, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const MODES = ['rounding', 'hadamard'] as const;
type Mode = (typeof MODES)[number];

const BLOCK = 16;
const N = 2048;
const E2M1 = [0, 0.5, 1, 1.5, 2, 3, 4, 6] as const;
const E2M1_MAX = 6;
const E4M3_MAX = 448;
const DRAWS = [1, 4, 16, 64, 256] as const;
/** Bins of |v| (the value in E2M1 units of its block scale), 0.25 wide: every rounding tie falls on an edge. */
const BIN_W = 0.25;
const BINS = E2M1_MAX / BIN_W;
/** Bins of the error divided by the local grid gap, over [−1, 1]. */
const HIST_BINS = 20;
/** The outlier's slot in the Hadamard block. */
const OUTLIER_AT = 5;

const WIDTH = 600;
const HEIGHT = 236;
const L_X0 = 48;
const L_X1 = 300;
const BIAS_TOP = 30;
const BIAS_BOTTOM = 140;
const DENS_TOP = 150;
const DENS_BOTTOM = 182;
const R_X0 = 340;
const R_X1 = 592;
const HIST_TOP = 30;
const HIST_BOTTOM = 182;
const H_PANELS = [48, 340] as const;
const H_PANEL_W = 252;
const H_MID = 104;
const H_HALF = 72;

const RNE_COLOR = warning[400];
const SR_COLOR = success[400];

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Box–Muller standard normal. */
const gauss = (rand: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());

/** Round half to even. */
const rne = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  if (d !== 0.5) return d < 0.5 ? f : f + 1;
  return f % 2 === 0 ? f : f + 1;
};

/** floor(log2(a)) for a > 0, exact at powers of two. */
const ilog2 = (a: number): number => {
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  return e;
};

/** A non-negative value cast to FP8 E4M3 (3 mantissa bits, subnormals from 2⁻⁹), nearest-even, saturating at 448. */
const toE4m3 = (v: number): number => {
  if (v <= 0) return 0;
  if (v >= E4M3_MAX) return E4M3_MAX;
  const ulp = 2 ** (Math.max(ilog2(v), -6) - 3);
  return Math.min(rne(v / ulp) * ulp, E4M3_MAX);
};

/** The E2M1 grid spacing at magnitude a in [0, 6]. */
const stepAt = (a: number): number => (a < 2 ? 0.5 : a < 4 ? 1 : 2);

/** E2M1 magnitude by round-to-nearest-even, saturating at 6. */
const nearestMag = (a: number): number => {
  const m = Math.min(a, E2M1_MAX);
  const step = stepAt(m);
  return rne(m / step) * step;
};

/** E2M1 magnitude by stochastic rounding: up to the next grid point with probability (a − lo) / step. */
const stochasticMag = (a: number, u: number): number => {
  const m = Math.min(a, E2M1_MAX);
  const step = stepAt(m);
  const lo = Math.floor(m / step) * step;
  return u < (m - lo) / step ? lo + step : lo;
};

/** Each value's decode scale s_block · s_global under canonical NVFP4 (1 × 16 blocks, E4M3 block scales). */
const blockScales = (xs: readonly number[]): number[] => {
  const amax = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const sGlobal = amax > 0 ? amax / (E2M1_MAX * E4M3_MAX) : 1;
  const out: number[] = [];
  for (let b = 0; b < xs.length; b += BLOCK) {
    const blk = xs.slice(b, b + BLOCK);
    const amaxB = blk.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const denom = toE4m3(amaxB / E2M1_MAX / sGlobal) * sGlobal;
    for (let i = 0; i < blk.length; i++) out.push(denom);
  }
  return out;
};

interface RoundingStats {
  count: number[];
  rneBias: (number | null)[];
  srBias: (number | null)[];
  rneHist: number[];
  srHist: number[];
  smallShare: number;
  flushed: number;
  rneSmall: number;
  srSmall: number;
  rneRms: number;
  srRms: number;
}

const roundingStats = (seed: number, tail: number, draws: number): RoundingStats => {
  const rand = mulberry32(seed);
  const xs = Array.from({length: N}, () => 1e-3 * gauss(rand) * Math.exp(tail * gauss(rand)));
  const denoms = blockScales(xs);
  const sr = mulberry32(seed * 7919 + 13);
  const count = new Array<number>(BINS).fill(0);
  const rneSum = new Array<number>(BINS).fill(0);
  const srSum = new Array<number>(BINS).fill(0);
  const rneHist = new Array<number>(HIST_BINS).fill(0);
  const srHist = new Array<number>(HIST_BINS).fill(0);
  let small = 0;
  let smallMag = 0;
  let rneSmallErr = 0;
  let srSmallErr = 0;
  let flushed = 0;
  let rneSq = 0;
  let srSq = 0;
  const histBin = (r: number): number => clamp(Math.floor(((r + 1) / 2) * HIST_BINS), 0, HIST_BINS - 1);
  xs.forEach((x, i) => {
    const d = denoms[i];
    if (d === 0) return;
    const a = Math.abs(x) / d;
    const gap = stepAt(Math.min(a, E2M1_MAX));
    const qn = nearestMag(a);
    let mean = 0;
    let first = 0;
    for (let k = 0; k < draws; k++) {
      const q = stochasticMag(a, sr());
      if (k === 0) first = q;
      mean += q / draws;
    }
    const bin = Math.min(Math.floor(a / BIN_W), BINS - 1);
    count[bin]++;
    rneSum[bin] += qn - a;
    srSum[bin] += mean - a;
    rneHist[histBin((qn - a) / gap)]++;
    srHist[histBin((first - a) / gap)]++;
    rneSq += ((qn - a) / gap) ** 2;
    srSq += ((first - a) / gap) ** 2;
    if (qn === 0 && x !== 0) flushed++;
    if (a < 0.5) {
      small++;
      smallMag += a * d;
      rneSmallErr += (qn - a) * d;
      srSmallErr += (mean - a) * d;
    }
  });
  const n = count.reduce((s, c) => s + c, 0);
  return {
    count,
    rneBias: count.map((c, b) => (c === 0 ? null : rneSum[b] / c)),
    srBias: count.map((c, b) => (c === 0 ? null : srSum[b] / c)),
    rneHist,
    srHist,
    smallShare: small / n,
    flushed: flushed / n,
    rneSmall: smallMag > 0 ? rneSmallErr / smallMag : 0,
    srSmall: smallMag > 0 ? srSmallErr / smallMag : 0,
    rneRms: Math.sqrt(rneSq / n),
    srRms: Math.sqrt(srSq / n),
  };
};

/** The 16 × 16 Sylvester Hadamard matrix, normalised by 1/4. */
const hadamard16: number[][] = Array.from({length: BLOCK}, (_, i) =>
  Array.from({length: BLOCK}, (__, j) => {
    let bits = i & j;
    let parity = 0;
    while (bits > 0) {
      parity ^= bits & 1;
      bits >>= 1;
    }
    return (parity === 0 ? 1 : -1) / 4;
  }),
);

interface BlockView {
  xs: number[];
  qs: number[];
  denom: number;
  crest: number;
  flushed: number;
  relErr: number;
}

/** One 16-value tensor quantized to NVFP4 (its own s_global, so the block scale is e4m3(448) = 448). */
const viewBlock = (xs: number[]): BlockView => {
  const denom = blockScales(xs)[0];
  const qs = xs.map(x => (denom === 0 ? 0 : Math.sign(x) * nearestMag(Math.abs(x) / denom) * denom));
  const amax = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const norm = Math.sqrt(xs.reduce((s, v) => s + v * v, 0));
  const err = Math.sqrt(xs.reduce((s, v, i) => s + (qs[i] - v) ** 2, 0));
  return {
    xs,
    qs,
    denom,
    crest: norm > 0 ? amax / (norm / Math.sqrt(BLOCK)) : 0,
    flushed: xs.filter((x, i) => x !== 0 && qs[i] === 0).length,
    relErr: norm > 0 ? err / norm : 0,
  };
};

const hadamardViews = (seed: number, outlier: number): [BlockView, BlockView] => {
  const rand = mulberry32(seed);
  const xs = Array.from({length: BLOCK}, () => gauss(rand));
  const others = xs.filter((_, i) => i !== OUTLIER_AT);
  const rms = Math.sqrt(others.reduce((s, v) => s + v * v, 0) / others.length);
  xs[OUTLIER_AT] = outlier * rms;
  const signs = Array.from({length: BLOCK}, () => (rand() < 0.5 ? -1 : 1));
  // x' = x H with H = S hadamard16: row i of hadamard16 flipped by sign i.
  const ys = Array.from({length: BLOCK}, (_, j) => xs.reduce((s, x, i) => s + x * signs[i] * hadamard16[i][j], 0));
  return [viewBlock(xs), viewBlock(ys)];
};

/** A fraction as a percentage, with a true minus sign. */
const pct = (v: number): string => `${v < 0 ? '−' : ''}${(100 * Math.abs(v)).toFixed(1)}%`;

const StochasticRounding: FC<WidgetProps> = memo(({params}) => {
  const [mode, setMode] = useState<Mode>(() => stringParam(params, 'mode', MODES, 'rounding'));
  const [tail, setTail] = useState(() => clamp(numParam(params, 'tail', 1), 0, 2));
  const [drawsIdx, setDrawsIdx] = useState(3);
  const [outlier, setOutlier] = useState(() => clamp(Math.round(numParam(params, 'outlier', 12)), 1, 30));
  const [seed, setSeed] = useState(() => Math.max(1, Math.floor(numParam(params, 'seed', 1))));

  const onRounding = useCallback(() => setMode('rounding'), []);
  const onHadamard = useCallback(() => setMode('hadamard'), []);
  const onTail = useCallback((e: ChangeEvent<HTMLInputElement>) => setTail(Number(e.target.value)), []);
  const onDraws = useCallback((e: ChangeEvent<HTMLInputElement>) => setDrawsIdx(Number(e.target.value)), []);
  const onOutlier = useCallback((e: ChangeEvent<HTMLInputElement>) => setOutlier(Number(e.target.value)), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const draws = DRAWS[drawsIdx];
  const stats = useMemo(
    () => (mode === 'rounding' ? roundingStats(seed, tail, draws) : null),
    [draws, mode, seed, tail],
  );
  const views = useMemo(() => (mode === 'hadamard' ? hadamardViews(seed, outlier) : null), [mode, outlier, seed]);

  const controls = useMemo(
    () => (
      <>
        <button
          aria-pressed={mode === 'rounding'}
          className={tabClass(mode === 'rounding')}
          onClick={onRounding}
          type="button">
          rounding
        </button>
        <button
          aria-pressed={mode === 'hadamard'}
          className={tabClass(mode === 'hadamard')}
          onClick={onHadamard}
          type="button">
          hadamard
        </button>
        {mode === 'rounding' ? (
          <>
            <label className="flex items-center gap-1.5">
              <span className="text-ink-300">tail σ</span>
              <input
                aria-label="heavy-tail spread of the gradient values"
                className={RANGE_CLASS}
                max={2}
                min={0}
                onChange={onTail}
                step={0.25}
                type="range"
                value={tail}
              />
              <span className="font-code text-ink-100 tabular-nums">{tail.toFixed(2)}</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-ink-300">SR draws</span>
              <input
                aria-label="number of stochastic-rounding draws averaged"
                className={RANGE_CLASS}
                max={DRAWS.length - 1}
                min={0}
                onChange={onDraws}
                step={1}
                type="range"
                value={drawsIdx}
              />
              <span className="font-code text-ink-100 tabular-nums">{draws}</span>
            </label>
          </>
        ) : (
          <label className="flex items-center gap-1.5">
            <span className="text-ink-300">outlier × rms</span>
            <input
              aria-label="outlier magnitude in multiples of the other values' rms"
              className={RANGE_CLASS}
              max={30}
              min={1}
              onChange={onOutlier}
              step={1}
              type="range"
              value={outlier}
            />
            <span className="font-code text-ink-100 tabular-nums">{outlier}</span>
          </label>
        )}
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample
        </button>
      </>
    ),
    [draws, drawsIdx, mode, onDraws, onHadamard, onOutlier, onResample, onRounding, onTail, outlier, tail],
  );

  const readout = useMemo(() => {
    if (stats !== null)
      return (
        <>
          {N.toLocaleString('en-US')} gradient-like values in {N / BLOCK} blocks of 16: {pct(stats.smallShare)} sit
          below the smallest non-zero code, 0.5. Round-to-nearest stores {pct(stats.flushed)} of all values as 0 and
          moves the small ones by{' '}
          <b className="text-ink-100">
            {stats.rneSmall >= 0 ? '+' : ''}
            {pct(stats.rneSmall)}
          </b>{' '}
          of their magnitude; the mean of {draws} stochastic draw{draws === 1 ? '' : 's'} moves them by{' '}
          <b className="text-ink-100">
            {stats.srSmall >= 0 ? '+' : ''}
            {pct(stats.srSmall)}
          </b>
          . SR pays in variance: one draw&apos;s RMS error is {stats.srRms.toFixed(2)} of a grid gap against{' '}
          {stats.rneRms.toFixed(2)} for RNE, so the recipe uses it on gradients only.
        </>
      );
    if (views === null) return null;
    const [before, after] = views;
    return (
      <>
        Outlier {outlier}× the rms of the other 15. As stored, the block scale is {before.denom.toFixed(3)} per E2M1
        unit: crest factor {before.crest.toFixed(2)}, <b className="text-ink-100">{before.flushed} values flush to 0</b>
        . After x·H every entry carries ±outlier/4: crest {after.crest.toFixed(2)},{' '}
        <b className="text-ink-100">{after.flushed} flush</b>. Relative error {pct(before.relErr)} → {pct(after.relErr)}
        : the transform keeps the small values alive but spreads the outlier&apos;s energy over the whole coarse grid,
        so at block size 16 the error itself need not fall.
      </>
    );
  }, [draws, outlier, stats, views]);

  const xOfV = (v: number): number => L_X0 + (v / E2M1_MAX) * (L_X1 - L_X0);
  const yOfBias = (b: number): number => {
    const mid = (BIAS_TOP + BIAS_BOTTOM) / 2;
    return mid - clamp(b / 0.5, -1, 1) * ((BIAS_BOTTOM - BIAS_TOP) / 2);
  };
  const xOfErr = (r: number): number => R_X0 + ((r + 1) / 2) * (R_X1 - R_X0);

  const drawRounding = (s: RoundingStats): ReactElement => {
    const maxCount = Math.max(...s.count, 1);
    const curve: string[] = [];
    for (let i = 0; i <= 600; i++) {
      const v = (i / 600) * E2M1_MAX;
      curve.push(`${i === 0 ? 'M' : 'L'}${xOfV(v).toFixed(1)},${yOfBias(nearestMag(v) - v).toFixed(1)}`);
    }
    const maxHist = Math.max(...s.rneHist, ...s.srHist, 1);
    const histPath = (h: number[]): string =>
      h
        .map((c, b) => {
          const x0 = xOfErr(-1 + (2 * b) / HIST_BINS);
          const x1 = xOfErr(-1 + (2 * (b + 1)) / HIST_BINS);
          const y = HIST_BOTTOM - (c / maxHist) * (HIST_BOTTOM - HIST_TOP);
          return `${b === 0 ? `M${x0},${HIST_BOTTOM}` : ''} L${x0},${y.toFixed(1)} L${x1},${y.toFixed(1)}`;
        })
        .join(' ') + ` L${R_X1},${HIST_BOTTOM} Z`;
    return (
      <g fontFamily={MONO} fontSize={9}>
        <text fill={ink[300]} x={L_X0} y={14}>
          mean error per bin of |x| / scale (E2M1 units)
        </text>
        <text fill={ink[300]} x={R_X0} y={14}>
          error / local grid gap, one draw
        </text>
        {E2M1.map(g => (
          <g key={g}>
            <line stroke={alpha(ink[400], 0.35)} x1={xOfV(g)} x2={xOfV(g)} y1={BIAS_TOP} y2={DENS_BOTTOM} />
            <text fill={ink[300]} textAnchor="middle" x={xOfV(g)} y={DENS_BOTTOM + 12}>
              {g}
            </text>
          </g>
        ))}
        <line stroke={ink[500]} x1={L_X0} x2={L_X1} y1={yOfBias(0)} y2={yOfBias(0)} />
        {[0.5, 0, -0.5].map(b => (
          <text fill={ink[300]} key={b} textAnchor="end" x={L_X0 - 4} y={yOfBias(b) + 3}>
            {b > 0 ? '+0.5' : b < 0 ? '−0.5' : '0'}
          </text>
        ))}
        <path d={curve.join(' ')} fill="none" stroke={ink[400]} strokeDasharray="3 2" strokeWidth={1} />
        {s.count.map((c, b) => {
          const x0 = xOfV(b * BIN_W);
          const w = xOfV((b + 1) * BIN_W) - x0;
          const h = (c / maxCount) * (DENS_BOTTOM - DENS_TOP);
          return (
            <rect fill={alpha(iris[400], 0.45)} height={h} key={b} width={w - 1} x={x0 + 0.5} y={DENS_BOTTOM - h} />
          );
        })}
        {s.rneBias.map((v, b) =>
          v === null ? null : (
            <circle cx={xOfV((b + 0.5) * BIN_W)} cy={yOfBias(v)} fill={RNE_COLOR} key={`r${b}`} r={2.6} />
          ),
        )}
        {s.srBias.map((v, b) =>
          v === null ? null : (
            <circle cx={xOfV((b + 0.5) * BIN_W)} cy={yOfBias(v)} fill={SR_COLOR} key={`s${b}`} r={2.6} />
          ),
        )}
        <text fill={ink[300]} textAnchor="end" x={L_X0 - 4} y={DENS_BOTTOM - 2}>
          count
        </text>
        <path d={histPath(s.rneHist)} fill={alpha(RNE_COLOR, 0.22)} stroke={RNE_COLOR} strokeWidth={1.2} />
        <path d={histPath(s.srHist)} fill={alpha(SR_COLOR, 0.14)} stroke={SR_COLOR} strokeWidth={1.2} />
        <line stroke={ink[500]} x1={R_X0} x2={R_X1} y1={HIST_BOTTOM} y2={HIST_BOTTOM} />
        {[-1, -0.5, 0, 0.5, 1].map(r => (
          <text fill={ink[300]} key={r} textAnchor="middle" x={xOfErr(r)} y={HIST_BOTTOM + 12}>
            {r < 0 ? `−${-r}` : r}
          </text>
        ))}
        <g transform={`translate(${L_X0}, ${HEIGHT - 16})`}>
          <circle cx={4} cy={-3} fill={RNE_COLOR} r={3} />
          <text fill={ink[200]} x={11} y={0}>
            round to nearest even
          </text>
          <circle cx={134} cy={-3} fill={SR_COLOR} r={3} />
          <text fill={ink[200]} x={141} y={0}>
            stochastic, mean of {draws}
          </text>
          <line stroke={ink[400]} strokeDasharray="3 2" x1={290} x2={306} y1={-3} y2={-3} />
          <text fill={ink[200]} x={311} y={0}>
            RNE error at each |x|
          </text>
          <rect fill={alpha(iris[400], 0.45)} height={7} width={9} x={430} y={-7} />
          <text fill={ink[200]} x={443} y={0}>
            values per bin
          </text>
        </g>
      </g>
    );
  };

  const drawHadamard = ([before, after]: [BlockView, BlockView]): ReactElement => {
    const top = Math.max(...before.xs.map(Math.abs), ...after.xs.map(Math.abs), E2M1_MAX * after.denom) * 1.05;
    const yOf = (v: number): number => H_MID - (v / top) * H_HALF;
    const colW = H_PANEL_W / BLOCK;
    const panel = (view: BlockView, p: number, title: string): ReactElement => {
      const x0 = H_PANELS[p];
      const levels = E2M1.flatMap(g => (g === 0 ? [0] : [g, -g])).map(g => g * view.denom);
      return (
        <g>
          <text fill={ink[300]} x={x0} y={14}>
            {title}
          </text>
          {levels.map(l => (
            <line
              key={l}
              stroke={alpha(ink[400], l === 0 ? 0.7 : 0.3)}
              x1={x0}
              x2={x0 + H_PANEL_W}
              y1={yOf(l)}
              y2={yOf(l)}
            />
          ))}
          {view.xs.map((x, i) => {
            const flushed = x !== 0 && view.qs[i] === 0;
            const cx = x0 + (i + 0.5) * colW;
            return (
              <g key={i}>
                <rect
                  fill={alpha(iris[400], p === 0 && i === OUTLIER_AT ? 0.75 : 0.45)}
                  height={Math.abs(yOf(x) - yOf(0))}
                  stroke={flushed ? danger[400] : 'none'}
                  strokeWidth={1.2}
                  width={colW - 4}
                  x={cx - colW / 2 + 2}
                  y={Math.min(yOf(x), yOf(0))}
                />
                <line
                  stroke={flushed ? danger[400] : SR_COLOR}
                  strokeWidth={2}
                  x1={cx - colW / 2 + 1}
                  x2={cx + colW / 2 - 1}
                  y1={yOf(view.qs[i])}
                  y2={yOf(view.qs[i])}
                />
              </g>
            );
          })}
          <text fill={ink[300]} x={x0} y={H_MID + H_HALF + 16}>
            crest {view.crest.toFixed(2)} · {view.flushed} flushed · error {pct(view.relErr)}
          </text>
        </g>
      );
    };
    return (
      <g fontFamily={MONO} fontSize={9}>
        {panel(before, 0, 'one 16-block as stored')}
        {panel(after, 1, 'after x·H (16 × 16, random signs)')}
        <g transform={`translate(${H_PANELS[0]}, ${HEIGHT - 16})`}>
          <rect fill={alpha(iris[400], 0.45)} height={7} width={9} x={0} y={-7} />
          <text fill={ink[200]} x={13} y={0}>
            value
          </text>
          <line stroke={SR_COLOR} strokeWidth={2} x1={60} x2={74} y1={-3} y2={-3} />
          <text fill={ink[200]} x={79} y={0}>
            NVFP4 value
          </text>
          <line stroke={danger[400]} strokeWidth={2} x1={160} x2={174} y1={-3} y2={-3} />
          <text fill={ink[200]} x={179} y={0}>
            flushed to 0
          </text>
          <line stroke={alpha(ink[400], 0.5)} x1={262} x2={276} y1={-3} y2={-3} />
          <text fill={ink[200]} x={281} y={0}>
            the block&apos;s E2M1 levels
          </text>
        </g>
      </g>
    );
  };

  return (
    <WidgetFrame controls={controls} readout={readout} title="stochastic rounding and the hadamard transform">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>
          {mode === 'rounding'
            ? 'Mean rounding error per magnitude bin for round-to-nearest-even and stochastic rounding of gradient-like values, and the histogram of one draw’s error'
            : 'One 16-value block with an outlier before and after a 16 × 16 random Hadamard transform, with its NVFP4 values'}
        </title>
        {stats !== null ? drawRounding(stats) : views !== null ? drawHadamard(views) : null}
      </svg>
    </WidgetFrame>
  );
});
StochasticRounding.displayName = 'StochasticRounding';

export default StochasticRounding;
