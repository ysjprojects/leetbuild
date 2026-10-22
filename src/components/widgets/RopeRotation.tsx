import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {alpha, concept, ink, iris} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const HEIGHT = 308;

const D = 8;
const BASE = 10000;
const PAIRS = D / 2;
/** θ_i = base^(−2i/d): 1, 0.1, 0.01, 0.001 rad per position. */
const thetas = Array.from({length: PAIRS}, (_, i) => BASE ** ((-2 * i) / D));

/** Fixed query and key vectors, read as pairs (x₂ᵢ, x₂ᵢ₊₁). */
const Q = [1.0, 0.3, 0.8, -0.5, 0.6, 0.9, -0.4, 0.7];
const K = [0.9, -0.2, 0.5, 0.7, 0.8, 0.3, 0.6, -0.5];

const MAX_POS = 128;
const SPAN = 64;
const OFFSET_A = 64;
const OFFSET_B = 1000;
const TICK_MS = 120;

/** Rotates each pair (x₂ᵢ, x₂ᵢ₊₁) of `v` by pos·θᵢ, as RoPE does to q at position m and k at position n. */
const rope = (v: number[], pos: number): number[] => {
  const out = [...v];
  for (let i = 0; i < PAIRS; i += 1) {
    const a = pos * thetas[i];
    const c = Math.cos(a);
    const s = Math.sin(a);
    out[2 * i] = v[2 * i] * c - v[2 * i + 1] * s;
    out[2 * i + 1] = v[2 * i] * s + v[2 * i + 1] * c;
  }
  return out;
};

const score = (m: number, n: number): number => {
  const q = rope(Q, m);
  const k = rope(K, n);
  return q.reduce((sum, x, i) => sum + x * k[i], 0);
};

const deltas = Array.from({length: 2 * SPAN + 1}, (_, i) => i - SPAN);
const curveA = deltas.map(dl => score(OFFSET_A + dl, OFFSET_A));
const curveB = deltas.map(dl => score(OFFSET_B + dl, OFFSET_B));
const Y_MAX = Math.ceil(Math.max(...curveA.map(Math.abs), ...curveB.map(Math.abs)) * 2) / 2;

const PAIR_NORM = Math.max(...thetas.map((_, i) => Math.hypot(Q[2 * i], Q[2 * i + 1])));
const CIRCLE_R = 34;
const CIRCLE_Y = 64;
const CIRCLE_DX = WIDTH / PAIRS;

const PLOT_L = 52;
const PLOT_R = WIDTH - 16;
const PLOT_T = 160;
const PLOT_B = 284;
const px = (dl: number): number => PLOT_L + ((dl + SPAN) / (2 * SPAN)) * (PLOT_R - PLOT_L);
const py = (v: number): number => PLOT_T + ((Y_MAX - v) / (2 * Y_MAX)) * (PLOT_B - PLOT_T);
const PATH_A = curveA.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(deltas[i]).toFixed(1)},${py(v).toFixed(1)}`).join('');
const PATH_B = curveB.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(deltas[i]).toFixed(1)},${py(v).toFixed(1)}`).join('');

const ARC_FILL = alpha(iris[400], 0.18);
const TWO_PI = 2 * Math.PI;

const RopeRotation: FC<WidgetProps> = memo(() => {
  const [pos, setPos] = useState(12);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setPos(p => (p + 1) % (MAX_POS + 1)), TICK_MS);
    return () => clearInterval(id);
  }, [playing]);

  const onPos = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPlaying(false);
    setPos(Number(e.target.value));
  }, []);
  const onToggle = useCallback(() => setPlaying(p => !p), []);

  const rotated = useMemo(() => rope(Q, pos), [pos]);
  const delta = pos - OFFSET_A;
  const scoreA = score(pos, OFFSET_A);
  const scoreB = score(OFFSET_B + delta, OFFSET_B);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">position m</span>
          <input
            aria-label="query position m"
            className={RANGE_CLASS}
            max={MAX_POS}
            min={0}
            onChange={onPos}
            type="range"
            value={pos}
          />
          <span className="font-code text-ink-100 w-8 tabular-nums">{pos}</span>
        </label>
        <button
          aria-label={playing ? 'pause rotation' : 'play rotation'}
          className={BUTTON_CLASS}
          onClick={onToggle}
          type="button">
          {playing ? '❚❚' : '▶'}
        </button>
      </>
    ),
    [onPos, onToggle, playing, pos],
  );

  const readout = useMemo(
    () => (
      <>
        At m = {pos}, pair 0 has turned {(pos * thetas[0]).toFixed(1)} rad and pair 3 only{' '}
        {(pos * thetas[3]).toFixed(3)} rad. With k at n = {OFFSET_A},{' '}
        <b className="text-ink-100">q·k = {scoreA.toFixed(3)}</b>; move both to m = {OFFSET_B + delta}, n = {OFFSET_B}{' '}
        and it is <b className="text-ink-100">{scoreB.toFixed(3)}</b>: same distance m − n = {delta}, same score.
      </>
    ),
    [delta, pos, scoreA, scoreB],
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="rotary position embeddings">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Four dimension pairs of a query rotating at different speeds, and q·k against relative distance</title>
        {thetas.map((theta, i) => {
          const cx = CIRCLE_DX * (i + 0.5);
          const angle = pos * theta;
          const x0 = (Q[2 * i] / PAIR_NORM) * CIRCLE_R;
          const y0 = (Q[2 * i + 1] / PAIR_NORM) * CIRCLE_R;
          const x1 = (rotated[2 * i] / PAIR_NORM) * CIRCLE_R;
          const y1 = (rotated[2 * i + 1] / PAIR_NORM) * CIRCLE_R;
          const len = Math.hypot(x0, y0);
          const swept = angle % TWO_PI;
          const start = Math.atan2(y0, x0);
          const arcR = len * 0.45;
          const largeArc = swept > Math.PI ? 1 : 0;
          const arcEnd = start + swept;
          return (
            <g key={i}>
              <text fill={ink[200]} fontFamily={MONO} fontSize={10} textAnchor="middle" x={cx} y={14}>
                pair {i} · dims {2 * i},{2 * i + 1}
              </text>
              <circle cx={cx} cy={CIRCLE_Y} fill={ink[800]} r={CIRCLE_R + 4} stroke={ink[600]} strokeWidth={0.75} />
              <line
                stroke={ink[700]}
                strokeWidth={0.75}
                x1={cx - CIRCLE_R}
                x2={cx + CIRCLE_R}
                y1={CIRCLE_Y}
                y2={CIRCLE_Y}
              />
              <line
                stroke={ink[700]}
                strokeWidth={0.75}
                x1={cx}
                x2={cx}
                y1={CIRCLE_Y - CIRCLE_R}
                y2={CIRCLE_Y + CIRCLE_R}
              />
              {swept > 1e-3 ? (
                <path
                  d={`M${cx},${CIRCLE_Y} L${cx + arcR * Math.cos(start)},${
                    CIRCLE_Y - arcR * Math.sin(start)
                  } A${arcR},${arcR} 0 ${largeArc} 0 ${cx + arcR * Math.cos(arcEnd)},${
                    CIRCLE_Y - arcR * Math.sin(arcEnd)
                  } Z`}
                  fill={ARC_FILL}
                />
              ) : null}
              <line
                stroke={ink[400]}
                strokeDasharray="3 2"
                strokeWidth={1}
                x1={cx}
                x2={cx + x0}
                y1={CIRCLE_Y}
                y2={CIRCLE_Y - y0}
              />
              <line
                stroke={iris[400]}
                strokeLinecap="round"
                strokeWidth={2.5}
                x1={cx}
                x2={cx + x1}
                y1={CIRCLE_Y}
                y2={CIRCLE_Y - y1}
              />
              <circle cx={cx + x1} cy={CIRCLE_Y - y1} fill={iris[400]} r={3} />
              <text fill={ink[300]} fontSize={10.5} textAnchor="middle" x={cx} y={CIRCLE_Y + CIRCLE_R + 18}>
                θ{i} = {Number(theta.toPrecision(3))} rad/pos
              </text>
              <text fill={ink[100]} fontSize={10.5} textAnchor="middle" x={cx} y={CIRCLE_Y + CIRCLE_R + 32}>
                m·θ{i} = {angle >= 10 ? angle.toFixed(1) : angle.toFixed(3)} rad
              </text>
            </g>
          );
        })}
        <g fontFamily={MONO} fontSize={9.5}>
          <text fill={ink[200]} x={PLOT_L} y={PLOT_T - 10}>
            q·k after rotation vs m − n
          </text>
          <line
            stroke={iris[400]}
            strokeWidth={2.5}
            x1={PLOT_R - 214}
            x2={PLOT_R - 198}
            y1={PLOT_T - 13}
            y2={PLOT_T - 13}
          />
          <text fill={ink[200]} x={PLOT_R - 194} y={PLOT_T - 10}>
            n = {OFFSET_A}
          </text>
          <line
            stroke={concept.pytorch}
            strokeDasharray="4 3"
            strokeWidth={1.5}
            x1={PLOT_R - 136}
            x2={PLOT_R - 120}
            y1={PLOT_T - 13}
            y2={PLOT_T - 13}
          />
          <text fill={ink[200]} x={PLOT_R - 116} y={PLOT_T - 10}>
            n = {OFFSET_B} (overlaps)
          </text>
          <rect fill={ink[800]} height={PLOT_B - PLOT_T} width={PLOT_R - PLOT_L} x={PLOT_L} y={PLOT_T} />
          <line stroke={ink[600]} strokeWidth={0.75} x1={PLOT_L} x2={PLOT_R} y1={py(0)} y2={py(0)} />
          {[-SPAN, -SPAN / 2, 0, SPAN / 2, SPAN].map(t => (
            <g key={t}>
              <line stroke={ink[700]} strokeWidth={0.75} x1={px(t)} x2={px(t)} y1={PLOT_T} y2={PLOT_B} />
              <text fill={ink[300]} textAnchor="middle" x={px(t)} y={PLOT_B + 13}>
                {t}
              </text>
            </g>
          ))}
          {[Y_MAX, 0, -Y_MAX].map(v => (
            <text fill={ink[300]} key={v} textAnchor="end" x={PLOT_L - 6} y={py(v) + 3.5}>
              {v.toFixed(1)}
            </text>
          ))}
          <path d={PATH_A} fill="none" stroke={iris[400]} strokeLinejoin="round" strokeWidth={2.5} />
          <path d={PATH_B} fill="none" stroke={concept.pytorch} strokeDasharray="4 3" strokeWidth={1.5} />
          <line
            stroke={ink[100]}
            strokeDasharray="2 2"
            strokeWidth={1}
            x1={px(delta)}
            x2={px(delta)}
            y1={PLOT_T}
            y2={PLOT_B}
          />
          <circle cx={px(delta)} cy={py(scoreA)} fill={iris[400]} r={4} stroke={ink[50]} strokeWidth={1} />
          <circle cx={px(delta)} cy={py(scoreB)} fill="none" r={6.5} stroke={concept.pytorch} strokeWidth={1.5} />
        </g>
      </svg>
    </WidgetFrame>
  );
});
RopeRotation.displayName = 'RopeRotation';

export default RopeRotation;
