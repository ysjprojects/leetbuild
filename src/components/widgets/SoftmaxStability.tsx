import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';

type Preset = 'small' | 'huge';

const PRESETS: readonly Preset[] = ['small', 'huge'];
const START: Record<Preset, number[]> = {small: [2, 1, 0.1, -1], huge: [10000, 9998, 9990, 9970]};
const RANGE: Record<Preset, {min: number; max: number; step: number}> = {
  small: {min: -10, max: 10, step: 0.1},
  huge: {min: 9900, max: 10100, step: 1},
};
const K = 4;
const F32_EXP_MAX = 88.72;

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const HEIGHT = 244;
const LEFT = 44;
const TOP = 30;
const PLOT_H = 130;
const GROUP_W = (WIDTH - LEFT) / K;
const BAR_W = 30;
const BAR_GAP = 8;
const NAIVE_FILL = alpha(danger[400], 0.75);
const TARGET_FILL = alpha(success[400], 0.25);
const BAD_FILL = alpha(danger[400], 0.15);

const f = Math.fround;

const fmt = (n: number, digits = 3): string => {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '−inf';
  if (n !== 0 && (Math.abs(n) >= 1e5 || Math.abs(n) < 10 ** -digits)) {
    return n.toExponential(1).replace('e+', 'e').replace(/-/g, '−');
  }
  return n.toFixed(digits).replace('-', '−');
};

interface Result {
  scaled: number[];
  naiveExp: number[];
  naiveSum: number;
  naive: number[];
  max: number;
  stableExp: number[];
  stableSum: number;
  stable: number[];
  /** Largest |stable − float64 softmax| over the classes. */
  stableErr: number;
  target: number[];
  /** −Σ target · log softmax, with log softmax = z − max − log Σ exp(z − max), all in float32. */
  loss: number;
  /** Entropy of the target, the lowest the loss can go. */
  floor: number;
}

const compute = (logits: number[], temperature: number, eps: number, cls: number): Result => {
  const T = f(temperature);
  const scaled = logits.map(z => f(f(z) / T));
  const naiveExp = scaled.map(z => f(Math.exp(z)));
  const naiveSum = naiveExp.reduce((s, e) => f(s + e), 0);
  const naive = naiveExp.map(e => f(e / naiveSum));
  const max = scaled.reduce((m, z) => Math.max(m, z), -Infinity);
  const stableExp = scaled.map(z => f(Math.exp(f(z - max))));
  const stableSum = stableExp.reduce((s, e) => f(s + e), 0);
  const stable = stableExp.map(e => f(e / stableSum));
  const max64 = Math.max(...logits) / temperature;
  const exact64 = logits.map(z => Math.exp(z / temperature - max64));
  const sum64 = exact64.reduce((s, e) => s + e, 0);
  const stableErr = stable.reduce((m, p, i) => Math.max(m, Math.abs(p - exact64[i] / sum64)), 0);
  const target = logits.map((_, i) => (1 - eps) * (i === cls ? 1 : 0) + eps / K);
  const lse = f(Math.log(stableSum));
  const loss = target.reduce((s, t, i) => f(s - f(f(t) * f(f(scaled[i] - max) - lse))), 0);
  const floor = target.reduce((s, t) => (t > 0 ? s - t * Math.log(t) : s), 0);
  return {
    scaled,
    naiveExp,
    naiveSum,
    naive,
    max,
    stableExp,
    stableSum,
    stable,
    stableErr,
    target,
    loss,
    floor,
  };
};

const barY = (p: number): number => TOP + PLOT_H * (1 - p);

const SoftmaxStability: FC<WidgetProps> = memo(({params}) => {
  const initial = stringParam(params, 'preset', PRESETS, 'small');
  const [preset, setPreset] = useState<Preset>(initial);
  const [logits, setLogits] = useState<number[]>(() => START[initial]);
  const [temperature, setTemperature] = useState(1);
  const [eps, setEps] = useState(0.1);
  const [cls, setCls] = useState(0);

  const onPreset = useCallback((p: Preset) => {
    setPreset(p);
    setLogits(START[p]);
  }, []);
  const onLogit = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const i = Number(e.target.dataset.index);
    const v = Number(e.target.value);
    setLogits(ls => ls.map((z, j) => (j === i ? v : z)));
  }, []);
  const onTemperature = useCallback((e: ChangeEvent<HTMLInputElement>) => setTemperature(Number(e.target.value)), []);
  const onEps = useCallback((e: ChangeEvent<HTMLInputElement>) => setEps(Number(e.target.value)), []);

  const r = useMemo(() => compute(logits, temperature, eps, cls), [cls, eps, logits, temperature]);
  const range = RANGE[preset];
  const overflowed = r.naiveExp.filter(e => e === Infinity).length;
  const nanCount = r.naive.filter(p => Number.isNaN(p)).length;
  const underflow = r.naiveSum === 0;

  const controls = useMemo(
    () => (
      <>
        {PRESETS.map(p => (
          <button
            aria-pressed={preset === p}
            className={tabClass(preset === p)}
            key={p}
            onClick={() => onPreset(p)}
            type="button">
            {p === 'small' ? 'small logits' : 'logits ≈ 1e4'}
          </button>
        ))}
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">T</span>
          <input
            aria-label="temperature"
            className={RANGE_CLASS}
            max={4}
            min={0.05}
            onChange={onTemperature}
            step={0.05}
            type="range"
            value={temperature}
          />
          <span className="font-code text-ink-100 tabular-nums">{temperature.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">ε</span>
          <input
            aria-label="label smoothing epsilon"
            className={RANGE_CLASS}
            max={0.5}
            min={0}
            onChange={onEps}
            step={0.01}
            type="range"
            value={eps}
          />
          <span className="font-code text-ink-100 tabular-nums">{eps.toFixed(2)}</span>
        </label>
      </>
    ),
    [eps, onEps, onPreset, onTemperature, preset, temperature],
  );

  const readout = useMemo(
    () => (
      <>
        {overflowed > 0 ? (
          <>
            <b className="text-ink-100">
              Naive: {overflowed} of {K} exps overflow
            </b>{' '}
            (z/T above {F32_EXP_MAX} is inf in float32), so the sum is inf and inf/inf gives NaN for {nanCount} class
            {nanCount === 1 ? '' : 'es'}.{' '}
          </>
        ) : underflow ? (
          <>
            <b className="text-ink-100">Naive: every exp underflows to 0</b>, so 0/0 gives NaN.{' '}
          </>
        ) : (
          <>
            <b className="text-ink-100">Naive is still finite</b> (largest z/T = {fmt(r.max, 2)}, overflow starts above{' '}
            {F32_EXP_MAX}).{' '}
          </>
        )}
        Subtracting the max ({fmt(r.max, 2)}) keeps every exp in (0, 1]: max |p − float64 softmax| ={' '}
        {r.stableErr.toExponential(1)}. Cross-entropy to class {cls} with ε = {eps.toFixed(2)}:{' '}
        <b className="text-ink-100">{fmt(r.loss, 4)} nats</b>
        {eps > 0
          ? `, floor ${r.floor.toFixed(4)} nats (the smoothed target's entropy), so the loss can never reach 0.`
          : ' (one-hot target, floor 0).'}
      </>
    ),
    [cls, eps, nanCount, overflowed, r.floor, r.loss, r.max, r.stableErr, underflow],
  );

  const bar = (key: string, x: number, p: number, fill: string, stroke: string) =>
    Number.isFinite(p) ? (
      <g key={key}>
        <rect
          fill={fill}
          height={Math.max(0.5, PLOT_H * p)}
          stroke={stroke}
          strokeWidth={0.75}
          width={BAR_W}
          x={x}
          y={barY(p)}
        />
        <text fill={ink[200]} fontSize={9} textAnchor="middle" x={x + BAR_W / 2} y={barY(p) - 3}>
          {p.toFixed(3)}
        </text>
      </g>
    ) : (
      <g key={key}>
        <rect
          fill={BAD_FILL}
          height={PLOT_H}
          stroke={danger[400]}
          strokeDasharray="3 2"
          strokeWidth={0.75}
          width={BAR_W}
          x={x}
          y={TOP}
        />
        <text
          fill={danger[300]}
          fontSize={9}
          fontWeight={600}
          textAnchor="middle"
          x={x + BAR_W / 2}
          y={TOP + PLOT_H / 2}>
          {fmt(p)}
        </text>
      </g>
    );

  return (
    <WidgetFrame controls={controls} readout={readout} title="softmax stability">
      <div className="text-ink-200 mb-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
        {logits.map((z, i) => (
          <label className="flex items-center gap-1.5" key={i}>
            <span className="font-code text-ink-300">z{i}</span>
            <input
              aria-label={`logit ${i}`}
              className="accent-iris-400 h-1 w-full min-w-0 cursor-pointer"
              data-index={i}
              max={range.max}
              min={range.min}
              onChange={onLogit}
              step={range.step}
              type="range"
              value={z}
            />
            <span className="font-code text-ink-100 w-10 shrink-0 text-right tabular-nums">
              {preset === 'small' ? z.toFixed(1) : z}
            </span>
          </label>
        ))}
      </div>
      <div className="text-ink-200 mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-ink-300">target class</span>
        {logits.map((_, i) => (
          <button
            aria-pressed={cls === i}
            className={tabClass(cls === i)}
            key={i}
            onClick={() => setCls(i)}
            type="button">
            {i}
          </button>
        ))}
      </div>
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Naive and max-subtracted softmax of four logits in float32, with the label-smoothed target</title>
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={NAIVE_FILL} height={8} width={8} x={LEFT} y={6} />
          <text fill={ink[200]} x={LEFT + 12} y={13}>
            naive exp(z)/Σ
          </text>
          <rect fill={iris[400]} height={8} width={8} x={LEFT + 120} y={6} />
          <text fill={ink[200]} x={LEFT + 132} y={13}>
            exp(z − max)/Σ
          </text>
          <rect fill={TARGET_FILL} height={8} stroke={success[400]} strokeWidth={0.75} width={8} x={LEFT + 240} y={6} />
          <text fill={ink[200]} x={LEFT + 252} y={13}>
            target (1−ε)·onehot + ε/{K}
          </text>
          {[0, 0.5, 1].map(v => (
            <g key={v}>
              <line stroke={ink[700]} strokeWidth={0.75} x1={LEFT - 4} x2={WIDTH - 4} y1={barY(v)} y2={barY(v)} />
              <text fill={ink[400]} textAnchor="end" x={LEFT - 8} y={barY(v) + 3}>
                {v}
              </text>
            </g>
          ))}
          {logits.map((_, i) => {
            const gx = LEFT + i * GROUP_W + (GROUP_W - (3 * BAR_W + 2 * BAR_GAP)) / 2;
            const cx = LEFT + i * GROUP_W + GROUP_W / 2;
            const y0 = TOP + PLOT_H + 14;
            const naiveExpBad = !Number.isFinite(r.naiveExp[i]) || r.naiveExp[i] === 0;
            return (
              <g key={i}>
                {bar('n', gx, r.naive[i], NAIVE_FILL, danger[400])}
                {bar('s', gx + BAR_W + BAR_GAP, r.stable[i], iris[400], iris[300])}
                {bar('t', gx + 2 * (BAR_W + BAR_GAP), r.target[i], TARGET_FILL, success[400])}
                <text fill={i === cls ? success[300] : ink[100]} fontWeight={600} textAnchor="middle" x={cx} y={y0}>
                  class {i}
                  {i === cls ? ' · target' : ''}
                </text>
                <text fill={ink[300]} textAnchor="middle" x={cx} y={y0 + 14}>
                  z/T = {fmt(r.scaled[i], 2)}
                </text>
                <text fill={naiveExpBad ? danger[300] : ink[300]} textAnchor="middle" x={cx} y={y0 + 28}>
                  exp(z/T) = {fmt(r.naiveExp[i])}
                </text>
                <text fill={ink[300]} textAnchor="middle" x={cx} y={y0 + 42}>
                  exp(z/T−max) = {fmt(r.stableExp[i])}
                </text>
              </g>
            );
          })}
          <text fill={ink[300]} x={LEFT} y={HEIGHT - 6}>
            float32 · naive Σ = {fmt(r.naiveSum)} · max = {fmt(r.max, 2)} · stable Σ = {fmt(r.stableSum, 4)} ·
            log-sum-exp = {fmt(r.max + Math.log(r.stableSum), 2)}
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
SoftmaxStability.displayName = 'SoftmaxStability';

export default SoftmaxStability;
