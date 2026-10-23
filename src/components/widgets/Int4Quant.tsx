import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const GROUPS = [8, 16, 32, 64, 128] as const;
/** Calibration tokens of the small example, mixed from FACTORS latent signals plus NOISE: correlated inputs. */
const SAMPLES = 128;
const FACTORS = 8;
const NOISE = 0.5;
/** GPTQ's percdamp: λ = 0.01 · mean(diag H). */
const PERCDAMP = 0.01;

const WIDTH = 600;
const PLOT_L = 92;
const PLOT_R = 566;
const PLOT_T = 12;
const PLOT_B = 172;
const BARS_T = 202;
const BAR_X = [150, 390] as const;
const BAR_MAX = 140;
const HEIGHT = 262;

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

interface Example {
  /** One group of weights (one output row, g input columns). */
  w: number[];
  /** SAMPLES calibration inputs of g correlated features. */
  x: number[][];
}

const makeExample = (seed: number, g: number): Example => {
  const rand = mulberry32(seed);
  const w = Array.from({length: g}, () => 0.5 * gauss(rand));
  w[Math.floor(rand() * g)] *= 3; // one larger weight stretches the group's range
  const mix = Array.from({length: FACTORS}, () => Array.from({length: g}, () => gauss(rand)));
  const x = Array.from({length: SAMPLES}, () => {
    const z = Array.from({length: FACTORS}, () => gauss(rand));
    return Array.from({length: g}, (_, j) => z.reduce((s, zk, k) => s + zk * mix[k][j], 0) + NOISE * gauss(rand));
  });
  return {w, x};
};

/** Lower Cholesky factor L of a symmetric positive-definite matrix, M = L Lᵀ. */
const cholesky = (m: number[][]): number[][] => {
  const n = m.length;
  const l = m.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      l[i][j] = i === j ? Math.sqrt(s) : s / l[j][j];
    }
  return l;
};

/** U, the upper Cholesky factor of H⁻¹ (H⁻¹ = UᵀU), from H = (2/n) XᵀX + λI, as GPTQ prepares it. */
const inverseFactor = (x: number[][], g: number): number[][] => {
  const h = Array.from({length: g}, (_, i) =>
    Array.from({length: g}, (_, j) => (2 / x.length) * x.reduce((s, r) => s + r[i] * r[j], 0)),
  );
  const damp = (PERCDAMP * h.reduce((s, r, i) => s + r[i], 0)) / g;
  h.forEach((r, i) => (r[i] += damp));
  const l = cholesky(h);
  const li = h.map(() => new Array<number>(g).fill(0)); // L⁻¹, lower triangular
  for (let i = 0; i < g; i++) {
    li[i][i] = 1 / l[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s += l[i][k] * li[k][j];
      li[i][j] = -s / l[i][i];
    }
  }
  const hinv = h.map((_, i) => h.map((__, j) => li.reduce((s, r) => s + r[i] * r[j], 0))); // L⁻ᵀ L⁻¹
  const lower = cholesky(hinv);
  return lower.map((_, i) => lower.map((__, j) => lower[j][i]));
};

interface Result {
  scale: number;
  zero: number;
  maxq: number;
  wmin: number;
  wmax: number;
  /** Dequantized weights, round to nearest. */
  rtn: number[];
  /** Dequantized weights, sequential error feedback. */
  fb: number[];
  /** Each weight as error feedback had moved it when its turn came. */
  seen: number[];
  /** ‖w − ŵ‖². */
  weightErr: [number, number];
  /** ‖(w − ŵ)X‖² / ‖wX‖². */
  outputErr: [number, number];
}

const quantizeGroup = ({w, x}: Example, bits: number): Result => {
  const g = w.length;
  const maxq = 2 ** bits - 1;
  const wmin = Math.min(...w);
  const wmax = Math.max(...w);
  const scale = (Math.max(wmax, 0) - Math.min(wmin, 0)) / maxq;
  const zero = Math.round(-Math.min(wmin, 0) / scale);
  const level = (v: number): number => scale * (clamp(Math.round(v / scale) + zero, 0, maxq) - zero);

  const rtn = w.map(level);
  const u = inverseFactor(x, g);
  const cur = [...w];
  const seen: number[] = [];
  const fb: number[] = [];
  for (let i = 0; i < g; i++) {
    seen.push(cur[i]);
    fb.push(level(cur[i]));
    const err = (cur[i] - fb[i]) / u[i][i];
    for (let j = i + 1; j < g; j++) cur[j] -= err * u[i][j];
  }

  const ref = x.reduce((s, r) => s + r.reduce((t, xi, i) => t + xi * w[i], 0) ** 2, 0);
  const errors = (q: number[]): [number, number] => [
    q.reduce((s, v, i) => s + (w[i] - v) ** 2, 0),
    x.reduce((s, r) => s + r.reduce((t, xi, i) => t + xi * (w[i] - q[i]), 0) ** 2, 0) / ref,
  ];
  const [wr, or] = errors(rtn);
  const [wf, of] = errors(fb);
  return {scale, zero, maxq, wmin, wmax, rtn, fb, seen, weightErr: [wr, wf], outputErr: [or, of]};
};

const pct = (v: number): string => `${(100 * v).toPrecision(2)}%`;

const Int4Quant: FC<WidgetProps> = memo(({params}) => {
  const [bits, setBits] = useState(() => clamp(Math.round(numParam(params, 'bits', 4)), 2, 8));
  const [groupIdx, setGroupIdx] = useState(() => {
    const i = GROUPS.indexOf(numParam(params, 'group', 32) as (typeof GROUPS)[number]);
    return i === -1 ? 2 : i;
  });
  const [feedback, setFeedback] = useState(false);
  const [seed, setSeed] = useState(2);

  const onBits = useCallback((e: ChangeEvent<HTMLInputElement>) => setBits(Number(e.target.value)), []);
  const onGroup = useCallback((e: ChangeEvent<HTMLInputElement>) => setGroupIdx(Number(e.target.value)), []);
  const onRound = useCallback(() => setFeedback(false), []);
  const onFeedback = useCallback(() => setFeedback(true), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const g = GROUPS[groupIdx];
  const example = useMemo(() => makeExample(seed, g), [g, seed]);
  const r = useMemo(() => quantizeGroup(example, bits), [bits, example]);
  const {maxq, scale, zero} = r;
  const shown = feedback ? r.fb : r.rtn;
  const at = feedback ? r.seen : example.w;

  // Value axis: the whole grid plus every point drawn, with a little air.
  const gridLo = -zero * scale;
  const gridHi = (maxq - zero) * scale;
  const lo = Math.min(gridLo, ...r.seen);
  const hi = Math.max(gridHi, ...r.seen);
  const pad = (hi - lo) * 0.04;
  const y = (v: number): number => PLOT_B - ((v - lo + pad) / (hi - lo + 2 * pad)) * (PLOT_B - PLOT_T);
  const colW = (PLOT_R - PLOT_L) / g;
  const dot = g >= 64 ? 1.7 : 2.6;
  const stride = Math.max(1, 2 ** (bits - 5)); // past 32 levels, draw every stride-th line
  const levels = [
    ...new Set([...Array.from({length: Math.floor(maxq / stride) + 1}, (_, k) => k * stride), zero, maxq]),
  ];
  const labelled = bits <= 4 ? levels : [0, zero, maxq];

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">bits</span>
          <input
            aria-label="bits per weight"
            className={RANGE_CLASS}
            max={8}
            min={2}
            onChange={onBits}
            step={1}
            type="range"
            value={bits}
          />
          <span className="font-code text-ink-100 tabular-nums">{bits}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">group</span>
          <input
            aria-label="group size"
            className={RANGE_CLASS}
            max={GROUPS.length - 1}
            min={0}
            onChange={onGroup}
            step={1}
            type="range"
            value={groupIdx}
          />
          <span className="font-code text-ink-100 tabular-nums">{g}</span>
        </label>
        <button aria-pressed={!feedback} className={tabClass(!feedback)} onClick={onRound} type="button">
          round to nearest
        </button>
        <button aria-pressed={feedback} className={tabClass(feedback)} onClick={onFeedback} type="button">
          error feedback
        </button>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample
        </button>
      </>
    ),
    [bits, feedback, g, groupIdx, onBits, onFeedback, onGroup, onResample, onRound],
  );

  const [outR, outF] = r.outputErr;
  const [wR, wF] = r.weightErr;
  const readout = useMemo(
    () => (
      <>
        {bits} bits, {maxq + 1} levels: scale = (max − min) / {maxq} = {scale.toFixed(4)}, zero point {zero}, so 0.0 is
        exactly level {zero}
        {stride > 1 ? ` (every ${stride}th level drawn)` : ''}.{' '}
        {feedback ? (
          <>
            Error feedback quantizes left to right and spreads each error over the columns not yet quantized through
            H⁻¹: weight error {(wF / wR).toFixed(2)}× that of rounding, output error{' '}
            <b className="text-ink-100">{pct(outF)}</b> of ‖wX‖² against {pct(outR)} (
            {outF < outR ? `${(outR / outF).toFixed(1)}× lower` : 'no better on this draw: the greedy order can lose'}
            ).
          </>
        ) : (
          <>
            Round to nearest leaves every weight within scale / 2 = {(scale / 2).toFixed(4)} of its level; the output
            error ‖(w − ŵ)X‖² is <b className="text-ink-100">{pct(outR)}</b> of ‖wX‖² on {SAMPLES} correlated inputs.
          </>
        )}
      </>
    ),
    [bits, feedback, maxq, outF, outR, scale, stride, wF, wR, zero],
  );

  const rows = [
    {name: 'round to nearest', values: [wR, outR], active: !feedback},
    {name: 'error feedback', values: [wF, outF], active: feedback},
  ];

  return (
    <WidgetFrame controls={controls} readout={readout} title="4-bit group quantization">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`One group of ${g} weights on a ${
          maxq + 1
        }-level grid set by its min and max, each weight's rounding error, and the weight and output errors of round to nearest and of error feedback`}</title>
        <g fontFamily={MONO} fontSize={9}>
          {levels.map(c => (
            <line
              key={c}
              stroke={c === zero ? iris[400] : ink[700]}
              strokeWidth={c === zero ? 1 : 0.6}
              x1={PLOT_L}
              x2={PLOT_R}
              y1={y((c - zero) * scale)}
              y2={y((c - zero) * scale)}
            />
          ))}
          {labelled.map(c => (
            <text
              fill={c === zero ? iris[300] : ink[300]}
              fontSize={8}
              key={c}
              x={PLOT_R + 4}
              y={y((c - zero) * scale) + 3}>
              {c}
            </text>
          ))}
          {[
            {v: r.wmax, label: `max ${r.wmax.toFixed(2)}`},
            {v: r.wmin, label: `min ${r.wmin.toFixed(2)}`},
          ].map(({v, label}) => (
            <g key={label}>
              <line
                stroke={success[400]}
                strokeDasharray="3 3"
                strokeWidth={0.8}
                x1={PLOT_L - 6}
                x2={PLOT_R}
                y1={y(v)}
                y2={y(v)}
              />
              <text fill={success[300]} textAnchor="end" x={PLOT_L - 8} y={y(v) + 3}>
                {label}
              </text>
            </g>
          ))}
          <text fill={iris[300]} textAnchor="end" x={PLOT_L - 8} y={y(0) + 3}>
            0.0 → {zero}
          </text>

          {example.w.map((w, i) => {
            const cx = PLOT_L + (i + 0.5) * colW;
            return (
              <g key={i}>
                {feedback ? (
                  <>
                    <line
                      stroke={ink[400]}
                      strokeDasharray="2 2"
                      strokeWidth={0.8}
                      x1={cx}
                      x2={cx}
                      y1={y(w)}
                      y2={y(at[i])}
                    />
                    <circle cx={cx} cy={y(w)} fill="none" r={dot} stroke={ink[400]} strokeWidth={0.8} />
                  </>
                ) : null}
                <line stroke={warning[400]} strokeWidth={1.4} x1={cx} x2={cx} y1={y(at[i])} y2={y(shown[i])} />
                <line
                  stroke={iris[300]}
                  strokeWidth={1.6}
                  x1={cx - Math.min(colW / 2 - 0.5, 5)}
                  x2={cx + Math.min(colW / 2 - 0.5, 5)}
                  y1={y(shown[i])}
                  y2={y(shown[i])}
                />
                <circle cx={cx} cy={y(at[i])} fill={ink[100]} r={dot} />
              </g>
            );
          })}
          <text fill={ink[300]} x={PLOT_L} y={PLOT_B + 14}>
            {feedback
              ? 'left to right · ring: original · dot: after earlier errors · bar: level · orange: error'
              : `columns 0 … ${g - 1} · dot: weight · bar: its level · orange: rounding error`}
          </text>

          <text fill={ink[300]} x={BAR_X[0]} y={BARS_T}>
            weight error ‖w − ŵ‖²
          </text>
          <text fill={ink[300]} x={BAR_X[1]} y={BARS_T}>
            output error ‖(w − ŵ)X‖² / ‖wX‖²
          </text>
          {rows.map((row, k) => {
            const ty = BARS_T + 14 + k * 22;
            return (
              <g key={row.name}>
                <text fill={row.active ? iris[300] : ink[200]} fontWeight={row.active ? 700 : 400} x={8} y={ty + 9}>
                  {row.name}
                </text>
                {row.values.map((v, col) => {
                  const max = Math.max(rows[0].values[col], rows[1].values[col]) || 1;
                  const len = Math.max(1, (v / max) * BAR_MAX);
                  return (
                    <g key={col}>
                      <rect
                        fill={row.active ? alpha(iris[400], 0.7) : alpha(ink[400], 0.45)}
                        height={12}
                        rx={2}
                        width={len}
                        x={BAR_X[col]}
                        y={ty}
                      />
                      <text fill={ink[100]} x={BAR_X[col] + len + 5} y={ty + 9}>
                        {col === 0 ? v.toPrecision(3) : pct(v)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
    </WidgetFrame>
  );
});
Int4Quant.displayName = 'Int4Quant';

export default Int4Quant;
