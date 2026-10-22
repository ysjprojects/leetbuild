import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const STEPS = 100;
const TICK_MS = 120;

/** Loss f(θ) = ½ (θ − c)ᵀ H (θ − c); H has eigenvalues 0.5 and 10 (condition number 20), soft axis tilted 15°. */
const SOFT = 0.5;
const STIFF = 10;
const TILT = (15 * Math.PI) / 180;
const COS = Math.cos(TILT);
const SIN = Math.sin(TILT);
const H11 = SOFT * COS * COS + STIFF * SIN * SIN;
const H22 = SOFT * SIN * SIN + STIFF * COS * COS;
const H12 = (SOFT - STIFF) * COS * SIN;
const CENTER: Point = [3, 1];
const START: Point = [-5, 2];
const BETA2 = 0.999;
const EPS = 1e-8;
const LIMIT = 1e4;
const LEVELS = [0.1, 0.5, 2, 6, 15, 35, 70];

type Point = [number, number];
type Opt = 'sgd' | 'momentum' | 'nesterov' | 'adam' | 'adamw';

const OPTS: Opt[] = ['sgd', 'momentum', 'nesterov', 'adam', 'adamw'];
const LABEL: Record<Opt, string> = {
  sgd: 'SGD',
  momentum: 'momentum',
  nesterov: 'Nesterov',
  adam: 'Adam',
  adamw: 'AdamW',
};
const COLOR: Record<Opt, string> = {
  sgd: ink[300],
  momentum: warning[400],
  nesterov: success[400],
  adam: danger[400],
  adamw: iris[400],
};

const loss = ([x, y]: Point): number => {
  const dx = x - CENTER[0];
  const dy = y - CENTER[1];
  return 0.5 * (H11 * dx * dx + 2 * H12 * dx * dy + H22 * dy * dy);
};

const grad = ([x, y]: Point): Point => {
  const dx = x - CENTER[0];
  const dy = y - CENTER[1];
  return [H11 * dx + H12 * dy, H12 * dx + H22 * dy];
};

/** Minimum of f(θ) + ½ λ ‖θ‖²: solve (H + λI) θ = H c. */
const l2Minimum = (wd: number): Point => {
  const hc0 = H11 * CENTER[0] + H12 * CENTER[1];
  const hc1 = H12 * CENTER[0] + H22 * CENTER[1];
  const a = H11 + wd;
  const d = H22 + wd;
  const det = a * d - H12 * H12;
  return [(d * hc0 - H12 * hc1) / det, (a * hc1 - H12 * hc0) / det];
};

/**
 * PyTorch's update rules. SGD-family and Adam take weight decay as L2 (λθ added to the gradient);
 * AdamW shrinks θ by lr·λ·θ before the Adam step. Stops early (shorter array) on divergence.
 */
const simulate = (opt: Opt, lr: number, beta: number, wd: number): Point[] => {
  let x = START[0];
  let y = START[1];
  let b0 = 0;
  let b1 = 0;
  let m0 = 0;
  let m1 = 0;
  let v0 = 0;
  let v1 = 0;
  const path: Point[] = [[x, y]];
  for (let t = 1; t <= STEPS; t += 1) {
    let [g0, g1] = grad([x, y]);
    if (opt !== 'adamw') {
      g0 += wd * x;
      g1 += wd * y;
    }
    switch (opt) {
      case 'sgd':
        x -= lr * g0;
        y -= lr * g1;
        break;
      case 'momentum':
      case 'nesterov': {
        b0 = t === 1 ? g0 : beta * b0 + g0;
        b1 = t === 1 ? g1 : beta * b1 + g1;
        const d0 = opt === 'nesterov' ? g0 + beta * b0 : b0;
        const d1 = opt === 'nesterov' ? g1 + beta * b1 : b1;
        x -= lr * d0;
        y -= lr * d1;
        break;
      }
      case 'adam':
      case 'adamw': {
        if (opt === 'adamw') {
          x *= 1 - lr * wd;
          y *= 1 - lr * wd;
        }
        m0 = beta * m0 + (1 - beta) * g0;
        m1 = beta * m1 + (1 - beta) * g1;
        v0 = BETA2 * v0 + (1 - BETA2) * g0 * g0;
        v1 = BETA2 * v1 + (1 - BETA2) * g1 * g1;
        const c1 = 1 - beta ** t;
        const c2 = 1 - BETA2 ** t;
        x -= (lr * (m0 / c1)) / (Math.sqrt(v0 / c2) + EPS);
        y -= (lr * (m1 / c1)) / (Math.sqrt(v1 / c2) + EPS);
        break;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > LIMIT || Math.abs(y) > LIMIT) break;
    path.push([x, y]);
  }
  return path;
};

const fmtLoss = (v: number): string => (v >= 10 ? v.toFixed(1) : v >= 0.01 ? v.toFixed(3) : v.toExponential(1));

const WIDTH = 600;
const SCALE = 46;
const X_MIN = -6;
const X_MAX = 6.5;
const Y_MIN = -2.6;
const Y_MAX = 2.6;
const PL = 12;
const PT = 26;
const PW = (X_MAX - X_MIN) * SCALE;
const PH = (Y_MAX - Y_MIN) * SCALE;
const HEIGHT = PT + PH + 8;
const sx = (x: number): number => PL + (x - X_MIN) * SCALE;
const sy = (y: number): number => PT + (Y_MAX - y) * SCALE;
const TILT_DEG = (TILT * 180) / Math.PI;

const OptimizerPaths: FC<WidgetProps> = memo(() => {
  const [lrSgd, setLrSgd] = useState(0.05);
  const [lrAdam, setLrAdam] = useState(0.3);
  const [beta, setBeta] = useState(0.9);
  const [wd, setWd] = useState(0.1);
  const [enabled, setEnabled] = useState<Record<Opt, boolean>>({
    sgd: true,
    momentum: true,
    nesterov: true,
    adam: true,
    adamw: true,
  });
  const playback = usePlayback(STEPS + 1, TICK_MS);
  const {step} = playback;

  const onLrSgd = useCallback((e: ChangeEvent<HTMLInputElement>) => setLrSgd(Number(e.target.value)), []);
  const onLrAdam = useCallback((e: ChangeEvent<HTMLInputElement>) => setLrAdam(Number(e.target.value)), []);
  const onBeta = useCallback((e: ChangeEvent<HTMLInputElement>) => setBeta(Number(e.target.value)), []);
  const onWd = useCallback((e: ChangeEvent<HTMLInputElement>) => setWd(Number(e.target.value)), []);
  const onToggle = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    const opt = e.currentTarget.value as Opt;
    setEnabled(s => ({...s, [opt]: !s[opt]}));
  }, []);

  const paths = useMemo(
    () =>
      Object.fromEntries(
        OPTS.map(o => [o, simulate(o, o === 'adam' || o === 'adamw' ? lrAdam : lrSgd, beta, wd)]),
      ) as Record<Opt, Point[]>,
    [beta, lrAdam, lrSgd, wd],
  );
  const l2Min = useMemo(() => l2Minimum(wd), [wd]);
  const shown = OPTS.filter(o => enabled[o]);
  const at = useCallback((o: Opt): Point | null => (step < paths[o].length ? paths[o][step] : null), [paths, step]);

  const controls = useMemo(
    () => (
      <>
        <div className="flex flex-wrap items-center gap-1">
          {OPTS.map(o => (
            <button
              aria-pressed={enabled[o]}
              className={tabClass(enabled[o])}
              key={o}
              onClick={onToggle}
              type="button"
              value={o}>
              <span
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{backgroundColor: COLOR[o]}}
              />
              {LABEL[o]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">SGD lr</span>
          <input
            aria-label="learning rate for SGD, momentum and Nesterov"
            className={RANGE_CLASS}
            max={0.25}
            min={0.005}
            onChange={onLrSgd}
            step={0.005}
            type="range"
            value={lrSgd}
          />
          <span className="font-code text-ink-100 tabular-nums">{lrSgd.toFixed(3)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">Adam lr</span>
          <input
            aria-label="learning rate for Adam and AdamW"
            className={RANGE_CLASS}
            max={1}
            min={0.01}
            onChange={onLrAdam}
            step={0.01}
            type="range"
            value={lrAdam}
          />
          <span className="font-code text-ink-100 tabular-nums">{lrAdam.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">β</span>
          <input
            aria-label="momentum or Adam beta1"
            className={RANGE_CLASS}
            max={0.99}
            min={0}
            onChange={onBeta}
            step={0.01}
            type="range"
            value={beta}
          />
          <span className="font-code text-ink-100 tabular-nums">{beta.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">weight decay</span>
          <input
            aria-label="weight decay lambda"
            className={RANGE_CLASS}
            max={0.5}
            min={0}
            onChange={onWd}
            step={0.01}
            type="range"
            value={wd}
          />
          <span className="font-code text-ink-100 tabular-nums">{wd.toFixed(2)}</span>
        </label>
        <PlaybackControls label="step" playback={playback} />
      </>
    ),
    [beta, enabled, lrAdam, lrSgd, onBeta, onLrAdam, onLrSgd, onToggle, onWd, playback, wd],
  );

  const readout = useMemo(() => {
    const adamPos = at('adam');
    const adamwPos = at('adamw');
    const sgdDiverges = paths.sgd.length <= STEPS;
    return (
      <>
        <b className="text-ink-100">step {step}</b>, loss f(θ) without the decay term:{' '}
        {shown.length === 0
          ? 'no optimizer selected.'
          : `${shown
              .map(o => {
                const p = at(o);
                return `${LABEL[o]} ${p === null ? 'diverged' : fmtLoss(loss(p))}`;
              })
              .join(' · ')}.`}{' '}
        {wd > 0
          ? `Adam adds λθ = ${wd.toFixed(2)}·θ to the gradient, so it heads for the L2-shrunk minimum (loss ${fmtLoss(
              loss(l2Min),
            )} there); AdamW shrinks θ by lr·λ·θ outside the moment estimates, so the decay is not rescaled by 1/√v${
              adamPos !== null && adamwPos !== null && enabled.adam && enabled.adamw
                ? ` (now ${fmtLoss(loss(adamPos))} vs ${fmtLoss(loss(adamwPos))})`
                : ''
            }.`
          : 'With no weight decay Adam and AdamW take identical steps.'}
        {sgdDiverges
          ? ` lr·(10 + λ) = ${(lrSgd * (STIFF + wd)).toFixed(2)} > 2 on the stiff axis, so plain SGD diverges.`
          : ''}
      </>
    );
  }, [at, enabled.adam, enabled.adamw, l2Min, lrSgd, paths.sgd.length, shown, step, wd]);

  const legendW = PW / OPTS.length;

  return (
    <WidgetFrame controls={controls} readout={readout} title="optimizer paths">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Optimizer trajectories on an ill-conditioned quadratic loss</title>
        <defs>
          <clipPath id="optimizer-paths-plot">
            <rect height={PH} width={PW} x={PL} y={PT} />
          </clipPath>
        </defs>
        <g fontFamily={MONO} fontSize={10}>
          {OPTS.map((o, i) => {
            const p = at(o);
            const x = PL + i * legendW;
            return (
              <g key={o} opacity={enabled[o] ? 1 : 0.35}>
                <rect fill={COLOR[o]} height={8} rx={2} width={8} x={x} y={8} />
                <text fill={ink[200]} x={x + 12} y={15.5}>
                  {LABEL[o]} {enabled[o] ? (p === null ? 'diverged' : fmtLoss(loss(p))) : 'off'}
                </text>
              </g>
            );
          })}
        </g>
        <rect fill={ink[900]} height={PH} rx={4} stroke={ink[700]} strokeWidth={0.75} width={PW} x={PL} y={PT} />
        <g clipPath="url(#optimizer-paths-plot)">
          {LEVELS.map(k => (
            <ellipse
              cx={sx(CENTER[0])}
              cy={sy(CENTER[1])}
              fill="none"
              key={k}
              rx={Math.sqrt((2 * k) / SOFT) * SCALE}
              ry={Math.sqrt((2 * k) / STIFF) * SCALE}
              stroke={ink[600]}
              strokeWidth={0.75}
              transform={`rotate(${-TILT_DEG} ${sx(CENTER[0])} ${sy(CENTER[1])})`}
            />
          ))}
          <line stroke={ink[700]} strokeDasharray="2 3" x1={sx(0)} x2={sx(0)} y1={PT} y2={PT + PH} />
          <line stroke={ink[700]} strokeDasharray="2 3" x1={PL} x2={PL + PW} y1={sy(0)} y2={sy(0)} />
          {shown.map(o => {
            const path = paths[o].slice(0, step + 1);
            return (
              <polyline
                fill="none"
                key={o}
                points={path.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')}
                stroke={COLOR[o]}
                strokeLinejoin="round"
                strokeOpacity={0.9}
                strokeWidth={1.4}
              />
            );
          })}
          {shown.map(o => {
            const p = at(o);
            return p === null ? null : (
              <circle
                cx={sx(p[0])}
                cy={sy(p[1])}
                fill={COLOR[o]}
                key={o}
                r={3.2}
                stroke={ink[900]}
                strokeWidth={0.75}
              />
            );
          })}
        </g>
        <g fontFamily={MONO} fontSize={10}>
          <text fill={ink[400]} x={sx(0) + 4} y={sy(0) + 11}>
            θ = 0
          </text>
          <circle cx={sx(START[0])} cy={sy(START[1])} fill="none" r={4} stroke={ink[100]} strokeWidth={1} />
          <text fill={ink[200]} x={sx(START[0]) - 12} y={sy(START[1]) - 8}>
            start
          </text>
          <path d={`M${sx(CENTER[0]) - 4},${sy(CENTER[1]) - 4}l8,8m0,-8l-8,8`} stroke={ink[50]} strokeWidth={1.5} />
          <text fill={ink[100]} x={sx(CENTER[0]) + 7} y={sy(CENTER[1]) - 6}>
            min
          </text>
          {wd > 0 ? (
            <>
              <path
                d={`M${sx(l2Min[0])},${sy(l2Min[1]) - 4.5}l4.5,4.5l-4.5,4.5l-4.5,-4.5z`}
                fill="none"
                stroke={ink[50]}
                strokeWidth={1.2}
              />
              <text fill={ink[200]} textAnchor="end" x={sx(l2Min[0]) - 7} y={sy(l2Min[1]) + 12}>
                min with L2
              </text>
            </>
          ) : null}
          <text fill={ink[400]} textAnchor="end" x={PL + PW - 6} y={PT + PH - 6}>
            Hessian eigenvalues 0.5, 10 · Adam β₂ {BETA2} · ε 1e-8
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
OptimizerPaths.displayName = 'OptimizerPaths';

export default OptimizerPaths;
