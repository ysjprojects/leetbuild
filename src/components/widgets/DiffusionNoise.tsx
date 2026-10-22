import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {concept, ink, iris} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const SCHEDULES = ['linear', 'cosine'] as const;
type Schedule = (typeof SCHEDULES)[number];

const T = 1000;
const N_POINTS = 150;
/** Cosine schedule offset s (Nichol & Dhariwal 2021). */
const COSINE_S = 0.008;
const MAX_BETA = 0.999;

const WIDTH = 600;
const HEIGHT = 262;
const SCATTER_X = 10;
const SCATTER_Y = 18;
const SCATTER_SIZE = 232;
/** The scatter shows x and y in [-DOMAIN, DOMAIN]. */
const DOMAIN = 3.6;
const PLOT_X0 = 306;
const PLOT_X1 = 590;
const AB_TOP = 18;
const AB_BOTTOM = 108;
const SNR_TOP = 144;
const SNR_BOTTOM = 234;
const SNR_MIN = -22;
const SNR_MAX = 13;
const T_TICKS = [0, 250, 500, 750, 1000];
const SNR_TICKS = [-20, -10, 0, 10];

const COLOR: Record<Schedule, string> = {linear: iris[400], cosine: concept.kafka};

/** ᾱ_t for t = 0..T as the running product of (1 − β_t); ᾱ_0 = 1 is the clean data. */
const cumulative = (beta: (t: number) => number): number[] => {
  const out = [1];
  for (let t = 1; t <= T; t++) out.push(out[t - 1] * (1 - beta(t)));
  return out;
};

/** Ho et al. 2020: β rises linearly from 1e-4 to 0.02 over T = 1000 steps. */
const linearAlphaBar = cumulative(t => 1e-4 + ((0.02 - 1e-4) * (t - 1)) / (T - 1));

const cosineF = (t: number): number => Math.cos(((t / T + COSINE_S) / (1 + COSINE_S)) * (Math.PI / 2)) ** 2;
/** Nichol & Dhariwal 2021: ᾱ_t = f(t)/f(0), with β_t = 1 − ᾱ_t/ᾱ_{t−1} clipped at 0.999 (only the last step clips). */
const cosineAlphaBar = cumulative(t => Math.min(1 - cosineF(t) / cosineF(t - 1), MAX_BETA));

const ALPHA_BAR: Record<Schedule, number[]> = {linear: linearAlphaBar, cosine: cosineAlphaBar};

const logSnr = (ab: number): number => Math.log(ab / (1 - ab));

const tx = (t: number): number => PLOT_X0 + (t / T) * (PLOT_X1 - PLOT_X0);
const abY = (ab: number): number => AB_BOTTOM - ab * (AB_BOTTOM - AB_TOP);
const snrY = (v: number): number =>
  SNR_BOTTOM - ((Math.min(SNR_MAX, Math.max(SNR_MIN, v)) - SNR_MIN) / (SNR_MAX - SNR_MIN)) * (SNR_BOTTOM - SNR_TOP);
const sx = (v: number): number => SCATTER_X + ((v + DOMAIN) / (2 * DOMAIN)) * SCATTER_SIZE;
const sy = (v: number): number => SCATTER_Y + ((DOMAIN - v) / (2 * DOMAIN)) * SCATTER_SIZE;

const curvePath = (values: number[], y: (v: number) => number, from: number): string => {
  const pts: string[] = [];
  for (let t = from; t <= T; t += t < T - 10 ? 5 : 1) pts.push(`${tx(t).toFixed(1)},${y(values[t]).toFixed(1)}`);
  return `M${pts.join('L')}`;
};

const PATHS: Record<Schedule, {ab: string; snr: string}> = {
  linear: {ab: curvePath(linearAlphaBar, abY, 0), snr: curvePath(linearAlphaBar.map(logSnr), snrY, 1)},
  cosine: {ab: curvePath(cosineAlphaBar, abY, 0), snr: curvePath(cosineAlphaBar.map(logSnr), snrY, 1)},
};

/** A two-arm spiral, roughly unit scale: the clean data x₀. */
const cleanPoints: Array<[number, number]> = Array.from({length: N_POINTS}, (_, i) => {
  const arm = i % 2;
  const u = Math.floor(i / 2) / (N_POINTS / 2 - 1);
  const r = 0.3 + 2.1 * u;
  const theta = 2.6 * Math.PI * u + arm * Math.PI;
  return [r * Math.cos(theta), r * Math.sin(theta)];
});

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

/** One fixed ε ~ N(0, I) per point (Box–Muller), so moving t only rescales signal and noise. */
const gaussianNoise = (seed: number): Array<[number, number]> => {
  const rng = mulberry32(seed);
  return Array.from({length: N_POINTS}, () => {
    const r = Math.sqrt(-2 * Math.log(1 - rng()));
    const phi = 2 * Math.PI * rng();
    return [r * Math.cos(phi), r * Math.sin(phi)];
  });
};

const fmt = (v: number): string => (v >= 0.001 ? v.toFixed(4) : v.toExponential(2));

/** Baseline for a value label at `y`: on the side away from the other schedule's marker, kept inside the plot. */
const labelY = (y: number, otherY: number, top: number, bottom: number): number =>
  Math.min(bottom - 3, Math.max(top + 9, otherY < y + 0.5 ? y + 13 : y - 6));

const DiffusionNoise: FC<WidgetProps> = memo(({params}) => {
  const [schedule, setSchedule] = useState<Schedule>(() => stringParam(params, 'schedule', SCHEDULES, 'linear'));
  const [t, setT] = useState(250);
  const [seed, setSeed] = useState(7);

  const onSchedule = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => setSchedule(e.currentTarget.value as Schedule),
    [],
  );
  const onT = useCallback((e: ChangeEvent<HTMLInputElement>) => setT(Number(e.target.value)), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const eps = useMemo(() => gaussianNoise(seed), [seed]);
  const ab = ALPHA_BAR[schedule][t];
  const signal = Math.sqrt(ab);
  const noise = Math.sqrt(1 - ab);
  const xt = useMemo(
    () =>
      cleanPoints.map(([x, y], i): [number, number] => [
        signal * x + noise * eps[i][0],
        signal * y + noise * eps[i][1],
      ]),
    [eps, noise, signal],
  );
  const other: Schedule = schedule === 'linear' ? 'cosine' : 'linear';
  const otherAb = ALPHA_BAR[other][t];

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          {SCHEDULES.map(s => (
            <button
              aria-pressed={s === schedule}
              className={tabClass(s === schedule)}
              key={s}
              onClick={onSchedule}
              type="button"
              value={s}>
              {s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">t</span>
          <input
            aria-label="diffusion timestep t"
            className={RANGE_CLASS}
            max={T}
            min={0}
            onChange={onT}
            step={1}
            type="range"
            value={t}
          />
          <span className="font-code text-ink-100 tabular-nums">{t}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample ε
        </button>
      </>
    ),
    [onResample, onSchedule, onT, schedule, t],
  );

  const readout = useMemo(() => {
    if (t === 0) {
      return (
        <>
          <b className="text-ink-100">t = 0</b>: ᾱ₀ = 1, so x₀ is the clean spiral (signal scale 1, noise scale 0, SNR
          infinite). Drag t to add noise.
        </>
      );
    }
    const snr = ab / (1 - ab);
    return (
      <>
        <b className="text-ink-100">
          t = {t} · {schedule}
        </b>
        : ᾱ_t = {fmt(ab)}, so x_t = {signal.toFixed(3)}·x₀ + {noise.toFixed(3)}·ε; SNR = ᾱ/(1 − ᾱ) ={' '}
        {snr >= 0.01 ? snr.toFixed(2) : snr.toExponential(2)} (log-SNR {logSnr(ab).toFixed(2)}). The {other} schedule at
        the same t has ᾱ_t = {fmt(otherAb)} (log-SNR {logSnr(otherAb).toFixed(2)}).
      </>
    );
  }, [ab, noise, other, otherAb, schedule, signal, t]);

  const marker = tx(t);

  return (
    <WidgetFrame controls={controls} readout={readout} title="forward diffusion">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>
          A spiral point cloud noised to timestep t, beside the ᾱ_t and log-SNR curves of the linear and cosine
          schedules
        </title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={SCATTER_X} y={12}>
          x_t = √ᾱ·x₀ + √(1 − ᾱ)·ε · t = {t}
        </text>
        <rect
          fill={ink[900]}
          height={SCATTER_SIZE}
          rx={4}
          stroke={ink[700]}
          width={SCATTER_SIZE}
          x={SCATTER_X}
          y={SCATTER_Y}
        />
        <line stroke={ink[700]} x1={sx(0)} x2={sx(0)} y1={SCATTER_Y} y2={SCATTER_Y + SCATTER_SIZE} />
        <line stroke={ink[700]} x1={SCATTER_X} x2={SCATTER_X + SCATTER_SIZE} y1={sy(0)} y2={sy(0)} />
        {cleanPoints.map(([x, y], i) => (
          <circle cx={sx(x)} cy={sy(y)} fill={ink[600]} key={`x0-${i}`} r={1.3} />
        ))}
        {xt.map(([x, y], i) =>
          Math.abs(x) > DOMAIN || Math.abs(y) > DOMAIN ? null : (
            <circle cx={sx(x)} cy={sy(y)} fill={COLOR[schedule]} fillOpacity={0.85} key={`xt-${i}`} r={2.2} />
          ),
        )}
        <text fill={ink[400]} fontFamily={MONO} fontSize={9} x={SCATTER_X + 6} y={SCATTER_Y + SCATTER_SIZE - 6}>
          grey: x₀ · {N_POINTS} points
        </text>

        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[200]} x={PLOT_X0} y={12}>
            ᾱ_t
          </text>
          {SCHEDULES.map((s, i) => (
            <g key={s}>
              <line
                stroke={COLOR[s]}
                strokeDasharray={s === schedule ? undefined : '4 3'}
                strokeWidth={2}
                x1={PLOT_X1 - 128 + i * 68}
                x2={PLOT_X1 - 114 + i * 68}
                y1={9}
                y2={9}
              />
              <text fill={ink[200]} x={PLOT_X1 - 110 + i * 68} y={12}>
                {s}
              </text>
            </g>
          ))}
          <text fill={ink[200]} x={PLOT_X0} y={SNR_TOP - 6}>
            log-SNR = ln(ᾱ / (1 − ᾱ))
          </text>
          {T_TICKS.map(v => (
            <g key={v}>
              <line stroke={ink[700]} x1={tx(v)} x2={tx(v)} y1={AB_TOP} y2={AB_BOTTOM} />
              <line stroke={ink[700]} x1={tx(v)} x2={tx(v)} y1={SNR_TOP} y2={SNR_BOTTOM} />
              <text fill={ink[300]} textAnchor="middle" x={tx(v)} y={SNR_BOTTOM + 12}>
                {v}
              </text>
            </g>
          ))}
          {[0, 0.5, 1].map(v => (
            <g key={v}>
              <line stroke={ink[700]} x1={PLOT_X0} x2={PLOT_X1} y1={abY(v)} y2={abY(v)} />
              <text fill={ink[300]} textAnchor="end" x={PLOT_X0 - 4} y={abY(v) + 3}>
                {v}
              </text>
            </g>
          ))}
          {SNR_TICKS.map(v => (
            <g key={v}>
              <line stroke={ink[700]} x1={PLOT_X0} x2={PLOT_X1} y1={snrY(v)} y2={snrY(v)} />
              <text fill={ink[300]} textAnchor="end" x={PLOT_X0 - 4} y={snrY(v) + 3}>
                {v}
              </text>
            </g>
          ))}
          <text fill={ink[300]} textAnchor="end" x={PLOT_X1} y={SNR_BOTTOM + 24}>
            timestep t
          </text>
        </g>

        {SCHEDULES.map(s => (
          <g
            fill="none"
            key={s}
            stroke={COLOR[s]}
            strokeDasharray={s === schedule ? undefined : '4 3'}
            strokeWidth={s === schedule ? 2 : 1.5}>
            <path d={PATHS[s].ab} />
            <path d={PATHS[s].snr} />
          </g>
        ))}

        <line stroke={ink[200]} strokeDasharray="2 2" x1={marker} x2={marker} y1={AB_TOP} y2={AB_BOTTOM} />
        <line stroke={ink[200]} strokeDasharray="2 2" x1={marker} x2={marker} y1={SNR_TOP} y2={SNR_BOTTOM} />
        {SCHEDULES.map(s => {
          const v = ALPHA_BAR[s][t];
          return (
            <g fill={COLOR[s]} key={s}>
              <circle cx={marker} cy={abY(v)} r={s === schedule ? 3.5 : 2.5} />
              {t > 0 ? <circle cx={marker} cy={snrY(logSnr(v))} r={s === schedule ? 3.5 : 2.5} /> : null}
            </g>
          );
        })}
        <text
          fill={ink[50]}
          fontFamily={MONO}
          fontSize={9}
          paintOrder="stroke"
          stroke={ink[850]}
          strokeWidth={3}
          textAnchor={t > T / 2 ? 'end' : 'start'}
          x={marker + (t > T / 2 ? -6 : 6)}
          y={labelY(abY(ab), abY(otherAb), AB_TOP, AB_BOTTOM)}>
          ᾱ = {ab >= 0.001 ? ab.toFixed(3) : ab.toExponential(1)}
        </text>
        {t > 0 ? (
          <text
            fill={ink[50]}
            fontFamily={MONO}
            fontSize={9}
            paintOrder="stroke"
            stroke={ink[850]}
            strokeWidth={3}
            textAnchor={t > T / 2 ? 'end' : 'start'}
            x={marker + (t > T / 2 ? -6 : 6)}
            y={labelY(snrY(logSnr(ab)), snrY(logSnr(otherAb)), SNR_TOP, SNR_BOTTOM)}>
            {logSnr(ab).toFixed(2)}
          </text>
        ) : null}
      </svg>
    </WidgetFrame>
  );
});
DiffusionNoise.displayName = 'DiffusionNoise';

export default DiffusionNoise;
