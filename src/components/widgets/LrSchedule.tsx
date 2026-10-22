import {type ChangeEvent, type FC, type PointerEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const HEIGHT = 210;
const PL = 58;
const PR = 14;
const PT = 22;
const PB = 34;
const PW = WIDTH - PL - PR;
const PH = HEIGHT - PT - PB;
const SAMPLES = 240;

/** Peak learning rates on the slider (index), the usual AdamW range for transformers. */
const PEAKS = [1e-4, 2e-4, 3e-4, 5e-4, 1e-3, 2e-3, 3e-3, 6e-3, 1e-2];

/** Linear warmup 0 → peak over `warmup` steps, then floor + ½ (peak − floor)(1 + cos(π (t − warmup)/(total − warmup))). */
const lrAt = (t: number, warmup: number, total: number, peak: number, floor: number): number => {
  if (t < warmup) return (peak * t) / warmup;
  const span = total - warmup;
  const progress = span <= 0 ? 1 : Math.min(1, (t - warmup) / span);
  return floor + 0.5 * (peak - floor) * (1 + Math.cos(Math.PI * progress));
};

const fmtLr = (v: number): string => (v === 0 ? '0' : v.toExponential(2));

const LrSchedule: FC<WidgetProps> = memo(({params}) => {
  const totalParam = Math.round(clamp(numParam(params, 'total', 1000), 20, 100000));
  const totalMax = Math.max(5000, totalParam);
  const [total, setTotal] = useState(totalParam);
  const [warmupRaw, setWarmup] = useState(() => Math.round(clamp(numParam(params, 'warmup', 100), 0, totalParam - 1)));
  const [peakIdx, setPeakIdx] = useState(2);
  const [floorPct, setFloorPct] = useState(10);
  const [tRaw, setT] = useState(() => Math.round(totalParam * 0.4));

  const warmup = Math.min(warmupRaw, total - 1);
  const t = Math.min(tRaw, total);
  const peak = PEAKS[peakIdx];
  const floor = (peak * floorPct) / 100;
  const lr = lrAt(t, warmup, total, peak, floor);
  const warmupMax = Math.max(warmup, Math.floor(total / 2), 1);

  const onTotal = useCallback((e: ChangeEvent<HTMLInputElement>) => setTotal(Number(e.target.value)), []);
  const onWarmup = useCallback((e: ChangeEvent<HTMLInputElement>) => setWarmup(Number(e.target.value)), []);
  const onPeak = useCallback((e: ChangeEvent<HTMLInputElement>) => setPeakIdx(Number(e.target.value)), []);
  const onFloor = useCallback((e: ChangeEvent<HTMLInputElement>) => setFloorPct(Number(e.target.value)), []);
  const onT = useCallback((e: ChangeEvent<HTMLInputElement>) => setT(Number(e.target.value)), []);

  const sx = useCallback((s: number) => PL + (s / total) * PW, [total]);
  const sy = useCallback((v: number) => PT + PH - (v / peak) * PH, [peak]);

  const dragTo = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const vx = ((e.clientX - rect.left) / rect.width) * WIDTH;
      setT(Math.round(clamp((vx - PL) / PW, 0, 1) * total));
    },
    [total],
  );
  const onPointerDown = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragTo(e);
    },
    [dragTo],
  );
  const onPointerMove = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(e);
    },
    [dragTo],
  );

  const curve = useMemo(() => {
    const steps = Array.from({length: SAMPLES + 1}, (_, i) => (i / SAMPLES) * total);
    // The warmup corner falls between samples; include it exactly.
    if (warmup > 0) steps.push(warmup);
    return steps
      .sort((a, b) => a - b)
      .map(s => `${sx(s).toFixed(1)},${sy(lrAt(s, warmup, total, peak, floor)).toFixed(1)}`)
      .join(' ');
  }, [floor, peak, sx, sy, total, warmup]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">warmup</span>
          <input
            aria-label="warmup steps"
            className={RANGE_CLASS}
            max={warmupMax}
            min={0}
            onChange={onWarmup}
            step={1}
            type="range"
            value={Math.min(warmup, warmupMax)}
          />
          <span className="font-code text-ink-100 tabular-nums">{warmup}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">total</span>
          <input
            aria-label="total steps"
            className={RANGE_CLASS}
            max={totalMax}
            min={20}
            onChange={onTotal}
            step={10}
            type="range"
            value={total}
          />
          <span className="font-code text-ink-100 tabular-nums">{total}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">peak</span>
          <input
            aria-label="peak learning rate"
            className={RANGE_CLASS}
            max={PEAKS.length - 1}
            min={0}
            onChange={onPeak}
            step={1}
            type="range"
            value={peakIdx}
          />
          <span className="font-code text-ink-100 tabular-nums">{fmtLr(peak)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">floor</span>
          <input
            aria-label="floor as a percentage of peak"
            className={RANGE_CLASS}
            max={50}
            min={0}
            onChange={onFloor}
            step={1}
            type="range"
            value={floorPct}
          />
          <span className="font-code text-ink-100 tabular-nums">{floorPct}%</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">step</span>
          <input
            aria-label="step marker"
            className={RANGE_CLASS}
            max={total}
            min={0}
            onChange={onT}
            step={1}
            type="range"
            value={t}
          />
          <span className="font-code text-ink-100 tabular-nums">{t}</span>
        </label>
      </>
    ),
    [floorPct, onFloor, onPeak, onT, onTotal, onWarmup, peak, peakIdx, t, total, totalMax, warmup, warmupMax],
  );

  const inWarmup = t < warmup;
  const progress = total - warmup <= 0 ? 1 : Math.min(1, (t - warmup) / (total - warmup));
  const readout = useMemo(
    () => (
      <>
        <b className="text-ink-100">
          step {t}: lr = {fmtLr(lr)}
        </b>{' '}
        ({((lr / peak) * 100).toFixed(1)}% of peak).{' '}
        {inWarmup
          ? `Linear warmup, ${t} of ${warmup} steps: lr = peak·t/warmup = ${fmtLr(
              peak,
            )}·${t}/${warmup}, which keeps the first updates small while Adam's second-moment estimate is still noisy.`
          : t >= total
          ? `End of training: the cosine has reached the floor ${fmtLr(floor)} (${floorPct}% of peak).`
          : `Cosine decay, ${(progress * 100).toFixed(1)}% of the ${
              total - warmup
            } steps after warmup: lr = floor + ½(peak − floor)(1 + cos(π·${progress.toFixed(
              3,
            )})), heading for the floor ${fmtLr(floor)}.`}
      </>
    ),
    [floor, floorPct, inWarmup, lr, peak, progress, t, total, warmup],
  );

  const mx = sx(t);
  const my = sy(lr);
  const labelRight = mx < PL + PW * 0.62;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * total));

  return (
    <WidgetFrame controls={controls} readout={readout} title="learning-rate schedule">
      <svg
        className="w-full cursor-ew-resize touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Learning rate over training: linear warmup then cosine decay to a floor</title>
        <rect fill={ink[900]} height={PH} rx={3} stroke={ink[700]} strokeWidth={0.75} width={PW} x={PL} y={PT} />
        {warmup > 0 ? (
          <rect fill={alpha(warning[400], 0.12)} height={PH} width={sx(warmup) - PL} x={PL} y={PT} />
        ) : null}
        <line stroke={ink[600]} strokeDasharray="3 3" x1={PL} x2={PL + PW} y1={sy(peak)} y2={sy(peak)} />
        <line stroke={ink[600]} strokeDasharray="3 3" x1={PL} x2={PL + PW} y1={sy(floor)} y2={sy(floor)} />
        <polyline fill="none" points={curve} stroke={iris[400]} strokeLinejoin="round" strokeWidth={2} />
        <g fontFamily={MONO} fontSize={10}>
          <text fill={ink[300]} textAnchor="end" x={PL - 6} y={sy(peak) + 3}>
            {fmtLr(peak)}
          </text>
          {floor > 0 ? (
            <text fill={ink[300]} textAnchor="end" x={PL - 6} y={Math.min(sy(floor) + 3, PT + PH - 10)}>
              {fmtLr(floor)}
            </text>
          ) : null}
          <text fill={ink[300]} textAnchor="end" x={PL - 6} y={PT + PH + 3}>
            0
          </text>
          {ticks.map(s => (
            <text fill={ink[300]} key={s} textAnchor="middle" x={sx(s)} y={PT + PH + 13}>
              {s}
            </text>
          ))}
          <text fill={ink[400]} textAnchor="middle" x={PL + PW / 2} y={HEIGHT - 4}>
            training step (drag on the chart to move the marker)
          </text>
          {warmup > 0 ? (
            <text fill={warning[400]} x={PL + 4} y={PT + 12}>
              warmup
            </text>
          ) : null}
          <text fill={iris[300]} textAnchor="end" x={PL + PW - 6} y={PT + 12}>
            cosine decay → floor
          </text>
        </g>
        <line stroke={success[400]} strokeWidth={1} x1={mx} x2={mx} y1={PT} y2={PT + PH} />
        <circle cx={mx} cy={my} fill={success[400]} r={4} stroke={ink[900]} strokeWidth={1} />
        <text
          fill={ink[50]}
          fontFamily={MONO}
          fontSize={10}
          textAnchor={labelRight ? 'start' : 'end'}
          x={labelRight ? mx + 7 : mx - 7}
          y={clamp(my - 8, PT + 26, PT + PH - 6)}>
          t={t} · {fmtLr(lr)}
        </text>
      </svg>
    </WidgetFrame>
  );
});
LrSchedule.displayName = 'LrSchedule';

export default LrSchedule;
