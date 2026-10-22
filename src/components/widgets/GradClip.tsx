import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {ink, iris, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';

type Vec = [number, number];
type Mode = 'global norm' | 'per tensor' | 'per value';

const MODES: Mode[] = ['global norm', 'per tensor', 'per value'];

/** Three parameter tensors (two components each); the head's gradient dominates the total norm. */
const TENSORS: Array<{name: string; g: Vec}> = [
  {name: 'fc1', g: [0.8, 0.4]},
  {name: 'fc2', g: [-0.3, 0.7]},
  {name: 'head', g: [3, -2]},
];

const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/**
 * global norm: torch.nn.utils.clip_grad_norm_, every tensor × min(1, max_norm / total_norm).
 * per tensor: each tensor × min(1, max_norm / ‖g_i‖). per value: clip_grad_value_, each component clamped to ±max.
 */
const clip = (mode: Mode, maxNorm: number): Vec[] => {
  const gs = TENSORS.map(t => t.g);
  switch (mode) {
    case 'global norm': {
      const total = norm(gs.flat());
      const k = Math.min(1, maxNorm / (total + 1e-6));
      return gs.map(([x, y]) => [x * k, y * k]);
    }
    case 'per tensor':
      return gs.map(g => {
        const k = Math.min(1, maxNorm / (norm(g) + 1e-6));
        return [g[0] * k, g[1] * k];
      });
    case 'per value':
      return gs.map(([x, y]) => [Math.max(-maxNorm, Math.min(maxNorm, x)), Math.max(-maxNorm, Math.min(maxNorm, y))]);
  }
};

const angleDeg = (a: number[], b: number[]): number => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const c = dot / (norm(a) * norm(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

const arrowHead = (x1: number, y1: number, x2: number, y2: number): string => {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return '';
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const s = Math.min(6, len * 0.6);
  const bx = x2 - ux * s;
  const by = y2 - uy * s;
  return `${x2},${y2} ${bx - uy * s * 0.5},${by + ux * s * 0.5} ${bx + uy * s * 0.5},${by - ux * s * 0.5}`;
};

const WIDTH = 620;
const HEIGHT = 184;
const PANEL = 124;
const GAP = 10;
const TOP = 24;
const HALF = PANEL / 2;
const SCALE = (HALF - 6) / 3;
const BARS_X = 3 * (PANEL + GAP) + 6;
const BARS_W = WIDTH - BARS_X - 4;
const BAR_SLOT = BARS_W / 6;

const GradClip: FC<WidgetProps> = memo(() => {
  const [mode, setMode] = useState<Mode>('global norm');
  const [maxNorm, setMaxNorm] = useState(1);

  const onMode = useCallback((e: MouseEvent<HTMLButtonElement>) => setMode(e.currentTarget.value as Mode), []);
  const onMax = useCallback((e: ChangeEvent<HTMLInputElement>) => setMaxNorm(Number(e.target.value)), []);

  const clipped = useMemo(() => clip(mode, maxNorm), [maxNorm, mode]);
  const before = useMemo(() => TENSORS.flatMap(t => t.g), []);
  const after = useMemo(() => clipped.flat(), [clipped]);
  const totalBefore = norm(before);
  const totalAfter = norm(after);
  const angle = angleDeg(before, after);

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          {MODES.map(m => (
            <button
              aria-pressed={m === mode}
              className={tabClass(m === mode)}
              key={m}
              onClick={onMode}
              type="button"
              value={m}>
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">{mode === 'per value' ? 'clip value' : 'max norm'}</span>
          <input
            aria-label={mode === 'per value' ? 'clip value' : 'max norm'}
            className={RANGE_CLASS}
            max={5}
            min={0.1}
            onChange={onMax}
            step={0.1}
            type="range"
            value={maxNorm}
          />
          <span className="font-code text-ink-100 tabular-nums">{maxNorm.toFixed(1)}</span>
        </label>
      </>
    ),
    [maxNorm, mode, onMax, onMode],
  );

  const readout = useMemo(() => {
    const perTensor = TENSORS.map((t, i) => `${t.name} ${norm(t.g).toFixed(2)} → ${norm(clipped[i]).toFixed(2)}`).join(
      ' · ',
    );
    const k = totalAfter / totalBefore;
    return (
      <>
        <b className="text-ink-100">
          total norm {totalBefore.toFixed(2)} → {totalAfter.toFixed(2)}, direction turned {angle.toFixed(1)}°
        </b>{' '}
        (angle between the concatenated 6-number gradients).{' '}
        {mode === 'global norm'
          ? k >= 1
            ? `The total norm is under ${maxNorm.toFixed(1)}, so nothing is scaled.`
            : `Every tensor is multiplied by the same ${k.toFixed(3)} = ${maxNorm.toFixed(1)}/${totalBefore.toFixed(
                2,
              )}, so the update keeps its direction and only gets shorter.`
          : angle < 0.05
          ? `Nothing exceeds ${maxNorm.toFixed(1)} (${perTensor}), so the gradients pass unchanged.`
          : mode === 'per tensor'
          ? `Each tensor is capped at ${maxNorm.toFixed(
              1,
            )} on its own (${perTensor}): any tensor above the limit is cut to exactly that norm, so the head shrinks more than fc1 and fc2 and the update bends toward the small tensors.`
          : `Each component is clamped to ±${maxNorm.toFixed(
              1,
            )} (${perTensor}): components above the limit are cut to it and the rest pass, so the direction drifts toward sign(g) and the small components gain weight.`}
      </>
    );
  }, [angle, clipped, maxNorm, mode, totalAfter, totalBefore]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="gradient clipping">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Per-tensor gradients before and after clipping, and the direction of the whole update</title>
        <g fontFamily={MONO} fontSize={10}>
          <text fill={ink[300]} x={0} y={12}>
            per tensor · dashed: before · solid: after · amber: limit
          </text>
          {TENSORS.map((t, i) => {
            const ox = i * (PANEL + GAP);
            const cx = ox + HALF;
            const cy = TOP + HALF;
            const [ax, ay] = clipped[i];
            const bx = cx + t.g[0] * SCALE;
            const by = cy - t.g[1] * SCALE;
            const px = cx + ax * SCALE;
            const py = cy - ay * SCALE;
            const r = maxNorm * SCALE;
            return (
              <g key={t.name}>
                <rect
                  fill={ink[900]}
                  height={PANEL}
                  rx={4}
                  stroke={ink[700]}
                  strokeWidth={0.75}
                  width={PANEL}
                  x={ox}
                  y={TOP}
                />
                <clipPath id={`grad-clip-panel-${i}`}>
                  <rect height={PANEL} width={PANEL} x={ox} y={TOP} />
                </clipPath>
                <g clipPath={`url(#grad-clip-panel-${i})`}>
                  <line stroke={ink[700]} x1={ox} x2={ox + PANEL} y1={cy} y2={cy} />
                  <line stroke={ink[700]} x1={cx} x2={cx} y1={TOP} y2={TOP + PANEL} />
                  {mode === 'per value' ? (
                    <rect
                      fill="none"
                      height={2 * r}
                      stroke={warning[400]}
                      strokeDasharray="3 2"
                      width={2 * r}
                      x={cx - r}
                      y={cy - r}
                    />
                  ) : mode === 'per tensor' ? (
                    <circle cx={cx} cy={cy} fill="none" r={r} stroke={warning[400]} strokeDasharray="3 2" />
                  ) : null}
                  <line stroke={ink[400]} strokeDasharray="3 2" strokeWidth={1.2} x1={cx} x2={bx} y1={cy} y2={by} />
                  <polygon fill={ink[400]} points={arrowHead(cx, cy, bx, by)} />
                  <line stroke={iris[400]} strokeWidth={2} x1={cx} x2={px} y1={cy} y2={py} />
                  <polygon fill={iris[400]} points={arrowHead(cx, cy, px, py)} />
                </g>
                <text fill={ink[100]} x={ox + 5} y={TOP + 12}>
                  {t.name}
                </text>
                <text fill={ink[200]} textAnchor="middle" x={cx} y={TOP + PANEL + 13}>
                  ‖g‖ {norm(t.g).toFixed(2)} → {norm(clipped[i]).toFixed(2)}
                </text>
              </g>
            );
          })}
          <text fill={ink[300]} textAnchor="end" x={3 * (PANEL + GAP) - GAP} y={TOP + PANEL + 30}>
            {mode === 'global norm'
              ? `every tensor × min(1, ${maxNorm.toFixed(1)}/${totalBefore.toFixed(2)}) = ${Math.min(
                  1,
                  maxNorm / totalBefore,
                ).toFixed(3)}`
              : mode === 'per tensor'
              ? `each ‖g_i‖ capped at ${maxNorm.toFixed(1)} (amber circle)`
              : `each component clamped to ±${maxNorm.toFixed(1)} (amber box)`}
          </text>
        </g>
        <g fontFamily={MONO} fontSize={10}>
          <rect
            fill={ink[900]}
            height={PANEL}
            rx={4}
            stroke={ink[700]}
            strokeWidth={0.75}
            width={BARS_W}
            x={BARS_X}
            y={TOP}
          />
          <line stroke={ink[600]} x1={BARS_X} x2={BARS_X + BARS_W} y1={TOP + HALF} y2={TOP + HALF} />
          {before.map((b, j) => {
            const a = after[j] / totalAfter;
            const u = b / totalBefore;
            const slot = BARS_X + j * BAR_SLOT;
            const h = HALF - 8;
            return (
              <g key={j}>
                <rect
                  fill="none"
                  height={Math.abs(u) * h}
                  stroke={ink[400]}
                  strokeDasharray="2 2"
                  width={BAR_SLOT * 0.34}
                  x={slot + BAR_SLOT * 0.12}
                  y={u >= 0 ? TOP + HALF - u * h : TOP + HALF}
                />
                <rect
                  fill={iris[400]}
                  height={Math.abs(a) * h}
                  width={BAR_SLOT * 0.34}
                  x={slot + BAR_SLOT * 0.52}
                  y={a >= 0 ? TOP + HALF - a * h : TOP + HALF}
                />
                <text fill={ink[300]} textAnchor="middle" x={slot + BAR_SLOT / 2} y={TOP + PANEL + 12}>
                  {j % 2 === 0 ? 'x' : 'y'}
                </text>
                {j % 2 === 0 ? (
                  <text fill={ink[200]} textAnchor="middle" x={slot + BAR_SLOT} y={TOP + PANEL + 25}>
                    {TENSORS[j / 2].name}
                  </text>
                ) : null}
              </g>
            );
          })}
          <text fill={ink[300]} x={BARS_X} y={12}>
            direction g/‖g‖
          </text>
          <text fill={angle < 0.05 ? ink[100] : warning[400]} textAnchor="end" x={BARS_X + BARS_W} y={12}>
            turned {angle.toFixed(1)}°
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
GradClip.displayName = 'GradClip';

export default GradClip;
