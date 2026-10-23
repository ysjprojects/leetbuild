import {type ChangeEvent, type FC, type ReactElement, memo, useCallback, useId, useMemo, useState} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const HEIGHT = 232;
const PT = 24;
const PB = 34;
const PH = HEIGHT - PT - PB;
const PW = 238;
const LEFT_X = 50;
const RIGHT_X = 348;
const H_MAX = 30;
const SAMPLES = 241;
const H_TICKS = [-30, -15, 0, 15, 30];

/** β on the slider (index): DPO papers use 0.1 to 0.5; TRL's default is 0.1. */
const BETAS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1];

/** −log σ(x) without overflow: log(1 + e^(−x)) written as softplus(−x). */
const softplus = (x: number): number => (x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** cDPO's loss: −(1 − ε) log σ(βh) − ε log σ(−βh); ε = 0 is DPO. */
const dpoLoss = (h: number, beta: number, eps: number): number =>
  (1 - eps) * softplus(-beta * h) + eps * softplus(beta * h);
/** −(d loss / d h) / β = (1 − ε) σ(−βh) − ε σ(βh) = σ(−βh) − ε. */
const gradWeight = (h: number, beta: number, eps: number): number => sigmoid(-beta * h) - eps;
const ipoLoss = (h: number, beta: number): number => (h - 1 / (2 * beta)) ** 2;

const fmt = (v: number, digits = 3): string => (Math.abs(v) >= 1000 ? v.toExponential(2) : v.toFixed(digits));

const DpoLoss: FC<WidgetProps> = memo(({params}) => {
  const clipId = useId();
  const [betaIdx, setBetaIdx] = useState(() => {
    // The slider's β nearest to the param, on a log scale.
    const want = clamp(numParam(params, 'beta', 0.1), 0.01, 1);
    const dist = (v: number): number => Math.abs(Math.log(v / want));
    return BETAS.reduce((best, v, i) => (dist(v) < dist(BETAS[best]) ? i : best), 0);
  });
  const [h, setH] = useState(() => clamp(numParam(params, 'h', 5), -H_MAX, H_MAX));
  const [eps, setEps] = useState(() => clamp(numParam(params, 'smoothing', 0), 0, 0.4));
  const beta = BETAS[betaIdx];

  const onBeta = useCallback((e: ChangeEvent<HTMLInputElement>) => setBetaIdx(Number(e.target.value)), []);
  const onH = useCallback((e: ChangeEvent<HTMLInputElement>) => setH(Number(e.target.value)), []);
  const onEps = useCallback((e: ChangeEvent<HTMLInputElement>) => setEps(Number(e.target.value)), []);

  const hs = useMemo(() => Array.from({length: SAMPLES}, (_, i) => -H_MAX + (2 * H_MAX * i) / (SAMPLES - 1)), []);
  const lossMax = useMemo(() => Math.max(1, ...hs.map(v => dpoLoss(v, beta, eps))) * 1.08, [beta, eps, hs]);
  const gradLo = eps > 0 ? -0.4 : 0;

  const sx = useCallback((ox: number, v: number) => ox + ((v + H_MAX) / (2 * H_MAX)) * PW, []);
  const syLoss = useCallback((v: number) => PT + PH - (v / lossMax) * PH, [lossMax]);
  const syGrad = useCallback((v: number) => PT + PH - ((v - gradLo) / (1 - gradLo)) * PH, [gradLo]);

  const curves = useMemo(() => {
    const line = (ox: number, f: (v: number) => number, sy: (v: number) => number): string =>
      hs.map(v => `${sx(ox, v).toFixed(1)},${clamp(sy(f(v)), PT - 40, PT + PH + 40).toFixed(1)}`).join(' ');
    return {
      dpo: line(LEFT_X, v => dpoLoss(v, beta, eps), syLoss),
      ipo: line(LEFT_X, v => ipoLoss(v, beta), syLoss),
      grad: line(RIGHT_X, v => gradWeight(v, beta, eps), syGrad),
    };
  }, [beta, eps, hs, sx, syGrad, syLoss]);

  const loss = dpoLoss(h, beta, eps);
  const weight = gradWeight(h, beta, eps);
  const ipo = ipoLoss(h, beta);
  const target = 1 / (2 * beta);
  const optimum = eps > 0 ? Math.log((1 - eps) / eps) / beta : undefined;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">β</span>
          <input
            aria-label="beta, the strength of the KL anchor"
            className={RANGE_CLASS}
            max={BETAS.length - 1}
            min={0}
            onChange={onBeta}
            step={1}
            type="range"
            value={betaIdx}
          />
          <span className="font-code text-ink-100 tabular-nums">{beta}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">margin h</span>
          <input
            aria-label="policy log-ratio margin h"
            className={RANGE_CLASS}
            max={H_MAX}
            min={-H_MAX}
            onChange={onH}
            step={0.5}
            type="range"
            value={h}
          />
          <span className="font-code text-ink-100 tabular-nums">{h.toFixed(1)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">label smoothing ε</span>
          <input
            aria-label="label smoothing epsilon (conservative DPO)"
            className={RANGE_CLASS}
            max={0.4}
            min={0}
            onChange={onEps}
            step={0.05}
            type="range"
            value={eps}
          />
          <span className="font-code text-ink-100 tabular-nums">{eps.toFixed(2)}</span>
        </label>
      </>
    ),
    [beta, betaIdx, eps, h, onBeta, onEps, onH],
  );

  const readout = useMemo(
    () => (
      <>
        β·h = {fmt(beta * h, 2)}: {eps > 0 ? 'cDPO' : 'DPO'} loss <b className="text-ink-100">{fmt(loss)}</b>, gradient
        weight <b className="text-ink-100">{eps > 0 ? `σ(−βh) − ε = ${fmt(weight)}` : `σ(−βh) = ${fmt(weight)}`}</b> (d
        loss/d h = {fmt(-beta * weight, 4)}).{' '}
        {eps > 0
          ? `With ε = ${eps.toFixed(2)} the push reverses past h = ln((1 − ε)/ε)/β = ${fmt(optimum ?? 0, 1)}. `
          : 'The push shrinks as h grows but never reaches 0. '}
        IPO: (h − 1/(2β))² = {fmt(ipo, 2)}, aiming for h = {fmt(target, 1)}
        {Math.abs(target) > H_MAX ? ' (off the chart: a small β asks for a large margin)' : ''}.
      </>
    ),
    [beta, eps, h, ipo, loss, optimum, target, weight],
  );

  const panel = (ox: number, label: string): ReactElement => (
    <>
      <rect fill={ink[900]} height={PH} rx={3} stroke={ink[700]} strokeWidth={0.75} width={PW} x={ox} y={PT} />
      <line stroke={ink[700]} strokeDasharray="3 3" x1={sx(ox, 0)} x2={sx(ox, 0)} y1={PT} y2={PT + PH} />
      <text fill={ink[200]} x={ox} y={PT - 8}>
        {label}
      </text>
      {H_TICKS.map(t => (
        <text fill={ink[300]} key={t} textAnchor="middle" x={sx(ox, t)} y={PT + PH + 13}>
          {t}
        </text>
      ))}
      <text fill={ink[400]} textAnchor="middle" x={ox + PW / 2} y={HEIGHT - 6}>
        margin h
      </text>
    </>
  );

  const mxL = sx(LEFT_X, h);
  const mxR = sx(RIGHT_X, h);
  const targetIn = Math.abs(target) <= H_MAX;

  return (
    <WidgetFrame controls={controls} readout={readout} title="dpo loss and its gradient weight">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`The DPO loss −log σ(β·h) and IPO's squared loss against the margin h, and the DPO gradient weight σ(−β·h), at β = ${beta}`}</title>
        <defs>
          <clipPath id={`${clipId}-loss`}>
            <rect height={PH} width={PW} x={LEFT_X} y={PT} />
          </clipPath>
          <clipPath id={`${clipId}-grad`}>
            <rect height={PH} width={PW} x={RIGHT_X} y={PT} />
          </clipPath>
        </defs>
        <g fontFamily={MONO} fontSize={10}>
          {panel(LEFT_X, 'loss')}
          {panel(RIGHT_X, 'gradient weight')}
          <text fill={ink[300]} textAnchor="end" x={LEFT_X - 5} y={PT + 4}>
            {lossMax.toFixed(1)}
          </text>
          <text fill={ink[300]} textAnchor="end" x={LEFT_X - 5} y={PT + PH + 3}>
            0
          </text>
          {[1, 0.5, 0, ...(gradLo < 0 ? [gradLo] : [])].map(v => (
            <text fill={ink[300]} key={v} textAnchor="end" x={RIGHT_X - 5} y={syGrad(v) + 3}>
              {v}
            </text>
          ))}
          {gradLo < 0 ? <line stroke={ink[600]} x1={RIGHT_X} x2={RIGHT_X + PW} y1={syGrad(0)} y2={syGrad(0)} /> : null}
          <g clipPath={`url(#${clipId}-loss)`}>
            {targetIn ? (
              <line
                stroke={alpha(warning[400], 0.5)}
                strokeDasharray="2 3"
                x1={sx(LEFT_X, target)}
                x2={sx(LEFT_X, target)}
                y1={PT}
                y2={PT + PH}
              />
            ) : null}
            <polyline
              fill="none"
              points={curves.ipo}
              stroke={warning[400]}
              strokeDasharray="5 3"
              strokeLinejoin="round"
              strokeWidth={1.5}
            />
            <polyline fill="none" points={curves.dpo} stroke={iris[400]} strokeLinejoin="round" strokeWidth={2} />
          </g>
          <g clipPath={`url(#${clipId}-grad)`}>
            <polyline fill="none" points={curves.grad} stroke={success[400]} strokeLinejoin="round" strokeWidth={2} />
          </g>
          <text textAnchor="end" x={LEFT_X + PW} y={PT - 8}>
            <tspan fill={iris[300]}>{eps > 0 ? `cDPO ε=${eps.toFixed(2)}` : 'DPO'}</tspan>
            <tspan fill={ink[400]}> · </tspan>
            <tspan fill={warning[400]}>IPO (dashed)</tspan>
          </text>
          <text fill={success[400]} textAnchor="end" x={RIGHT_X + PW} y={PT - 8}>
            {eps > 0 ? 'σ(−βh) − ε' : 'σ(−βh)'}
          </text>
        </g>
        <line stroke={ink[300]} strokeWidth={1} x1={mxL} x2={mxL} y1={PT} y2={PT + PH} />
        <line stroke={ink[300]} strokeWidth={1} x1={mxR} x2={mxR} y1={PT} y2={PT + PH} />
        {ipo <= lossMax ? (
          <circle cx={mxL} cy={syLoss(ipo)} fill={warning[400]} r={3.5} stroke={ink[900]} strokeWidth={1} />
        ) : null}
        <circle cx={mxL} cy={syLoss(loss)} fill={iris[400]} r={4} stroke={ink[900]} strokeWidth={1} />
        <circle cx={mxR} cy={syGrad(weight)} fill={success[400]} r={4} stroke={ink[900]} strokeWidth={1} />
      </svg>
    </WidgetFrame>
  );
});
DpoLoss.displayName = 'DpoLoss';

export default DpoLoss;
