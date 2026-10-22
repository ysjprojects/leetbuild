import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, categorical, ink, iris} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
/** K and V stored in bf16. */
const BYTES = 2;
/** Context lengths the slider steps through: 512 … 131,072 tokens. */
const CONTEXTS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072] as const;

const WIDTH = 600;
const LEFT = 8;
const SPAN = WIDTH - 2 * LEFT;
const Q_Y = 20;
const CELL_H = 18;
const KV_Y = 92;
const KV_H = 22;
const BARS_Y = 170;
const BAR_H = 14;
const BAR_GAP = 8;
const BAR_X = 128;
const BAR_W = 360;
const HEIGHT = BARS_Y + 3 * (BAR_H + BAR_GAP) + 24;

const groupFills = categorical.map(c => alpha(c, 0.3));
const groupLines = categorical.map(c => alpha(c, 0.55));
const BAR_TRACK = ink[800];
const BAR_FILL = alpha(iris[400], 0.75);

type Mode = 'MHA' | 'GQA' | 'MQA';

const divisorsOf = (n: number): number[] => Array.from({length: n}, (_, i) => i + 1).filter(d => n % d === 0);

/** The largest divisor of `heads` that is at most `want`, so every KV head serves the same number of query heads. */
const snapKv = (heads: number, want: number): number =>
  divisorsOf(heads)
    .filter(d => d <= want)
    .pop() ?? 1;

const modeOf = (heads: number, kv: number): Mode => (kv === heads ? 'MHA' : kv === 1 ? 'MQA' : 'GQA');

const bytes = (b: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2)} ${units[u]}`;
};

const tokens = (n: number): string => n.toLocaleString('en-US');

const GqaHeads: FC<WidgetProps> = memo(({params}) => {
  const heads = clamp(Math.round(numParam(params, 'heads', 32)), 1, 64);
  const layers = clamp(Math.round(numParam(params, 'layers', 32)), 1, 200);
  const headDim = clamp(Math.round(numParam(params, 'headDim', 128)), 1, 1024);
  const divisors = useMemo(() => divisorsOf(heads), [heads]);
  const defaultKv = snapKv(heads, clamp(Math.round(numParam(params, 'kvHeads', 8)), 1, heads));
  const wantContext = numParam(params, 'context', 8192);
  const firstAtLeast = CONTEXTS.findIndex(c => c >= wantContext);
  const defaultContext = firstAtLeast === -1 ? CONTEXTS.length - 1 : firstAtLeast;

  const [kv, setKv] = useState(defaultKv);
  const [contextIndex, setContextIndex] = useState(defaultContext);
  const context = CONTEXTS[contextIndex];
  const rep = heads / kv;
  const mode = modeOf(heads, kv);
  /** What GQA means for this config when the pill is pressed: the given kvHeads if it is a real group, else the middle divisor. */
  const gqaKv = useMemo(() => {
    const inner = divisors.filter(d => d > 1 && d < heads);
    if (inner.length === 0) return null;
    return inner.includes(defaultKv) ? defaultKv : inner[Math.floor(inner.length / 2)];
  }, [defaultKv, divisors, heads]);

  const onMode = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const m = e.currentTarget.value as Mode;
      setKv(m === 'MHA' ? heads : m === 'MQA' ? 1 : gqaKv ?? defaultKv);
    },
    [defaultKv, gqaKv, heads],
  );
  const onKv = useCallback((e: ChangeEvent<HTMLInputElement>) => setKv(divisors[Number(e.target.value)]), [divisors]);
  const onContext = useCallback((e: ChangeEvent<HTMLInputElement>) => setContextIndex(Number(e.target.value)), []);

  const perToken = (n: number): number => 2 * layers * n * headDim * BYTES;
  const rows = useMemo(
    () => [
      {label: `MHA · ${heads} kv`, kv: heads},
      {label: `this · ${kv} kv`, kv},
      {label: 'MQA · 1 kv', kv: 1},
    ],
    [heads, kv],
  );

  const controls = useMemo(
    () => (
      <>
        <div className="flex flex-wrap items-center gap-1">
          {(['MHA', 'GQA', 'MQA'] as const).map(m => (
            <button
              aria-pressed={mode === m}
              className={tabClass(mode === m)}
              disabled={m === 'GQA' && gqaKv === null}
              key={m}
              onClick={onMode}
              type="button"
              value={m}>
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">n_kv_heads</span>
          <input
            aria-label="number of key/value heads"
            className={RANGE_CLASS}
            max={divisors.length - 1}
            min={0}
            onChange={onKv}
            step={1}
            type="range"
            value={divisors.indexOf(kv)}
          />
          <span className="font-code text-ink-100 tabular-nums">{kv}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">context</span>
          <input
            aria-label="context length in tokens"
            className={RANGE_CLASS}
            max={CONTEXTS.length - 1}
            min={0}
            onChange={onContext}
            step={1}
            type="range"
            value={contextIndex}
          />
          <span className="font-code text-ink-100 tabular-nums">{tokens(context)}</span>
        </label>
      </>
    ),
    [context, contextIndex, divisors, gqaKv, kv, mode, onContext, onKv, onMode],
  );

  const ours = perToken(kv);
  const mha = perToken(heads);
  const readout = useMemo(
    () => (
      <>
        {heads} query heads read {kv} KV head{kv === 1 ? '' : 's'}, {rep} per group ({mode}). One token of context costs
        2 · {layers} layers · {kv} · {headDim} · {BYTES} B = <b className="text-ink-100">{bytes(ours)}</b>;{' '}
        {tokens(context)} tokens take <b className="text-ink-100">{bytes(ours * context)}</b> per sequence
        {kv === heads ? ', the multi-head baseline.' : `, ${rep}× less than MHA's ${bytes(mha * context)}.`}
      </>
    ),
    [context, headDim, heads, kv, layers, mha, mode, ours, rep],
  );

  const cellW = SPAN / heads;
  const groupW = cellW * rep;
  const kvW = Math.min(groupW - 4, 72);
  const showIndex = cellW >= 15;

  return (
    <WidgetFrame controls={controls} readout={readout} title="grouped-query attention · heads and kv cache">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`${heads} query heads mapped onto ${kv} key/value heads; KV cache ${bytes(ours)} per token`}</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={LEFT} y={Q_Y - 6}>
            query heads · wq · {heads} × {headDim}
          </text>
          <text fill={ink[300]} x={LEFT} y={KV_Y + KV_H + 14}>
            key/value heads · wk, wv · {kv} × {headDim} · cached
          </text>
          <text fill={ink[300]} textAnchor="end" x={WIDTH - LEFT} y={KV_Y + KV_H + 14}>
            repeat_kv × {rep}
          </text>
          {Array.from({length: heads}, (_, h) => {
            const g = Math.floor(h / rep);
            const x = LEFT + h * cellW;
            const kx = LEFT + g * groupW + groupW / 2;
            return (
              <g key={h}>
                <line
                  stroke={groupLines[g % groupLines.length]}
                  strokeWidth={1}
                  x1={x + cellW / 2}
                  x2={kx}
                  y1={Q_Y + CELL_H}
                  y2={KV_Y}
                />
                <rect
                  fill={groupFills[g % groupFills.length]}
                  height={CELL_H}
                  rx={2}
                  stroke={categorical[g % categorical.length]}
                  strokeWidth={0.75}
                  width={Math.max(cellW - 2, 1)}
                  x={x + 1}
                  y={Q_Y}
                />
                {showIndex ? (
                  <text fill={ink[100]} textAnchor="middle" x={x + cellW / 2} y={Q_Y + 12}>
                    {h}
                  </text>
                ) : null}
              </g>
            );
          })}
          {Array.from({length: kv}, (_, g) => {
            const cx = LEFT + g * groupW + groupW / 2;
            return (
              <g key={g}>
                <rect
                  fill={groupFills[g % groupFills.length]}
                  height={KV_H}
                  rx={3}
                  stroke={categorical[g % categorical.length]}
                  strokeWidth={1.25}
                  width={Math.max(kvW, 1)}
                  x={cx - kvW / 2}
                  y={KV_Y}
                />
                {kvW >= 22 ? (
                  <text fill={ink[50]} textAnchor="middle" x={cx} y={KV_Y + 14}>
                    {kvW >= 44 ? `k,v ${g}` : g}
                  </text>
                ) : null}
              </g>
            );
          })}

          <text fill={ink[300]} x={LEFT} y={BARS_Y - 8}>
            KV cache per token · {layers} layers · bf16
          </text>
          {rows.map((r, i) => {
            const y = BARS_Y + i * (BAR_H + BAR_GAP);
            const v = perToken(r.kv);
            const active = i === 1;
            return (
              <g key={r.label}>
                <text fill={active ? ink[50] : ink[200]} fontWeight={active ? 700 : 400} x={LEFT} y={y + 11}>
                  {r.label}
                </text>
                <rect fill={BAR_TRACK} height={BAR_H} rx={3} width={BAR_W} x={BAR_X} y={y} />
                <rect
                  className="transition-all duration-300"
                  fill={active ? BAR_FILL : alpha(iris[400], 0.3)}
                  height={BAR_H}
                  rx={3}
                  width={Math.max((v / mha) * BAR_W, 2)}
                  x={BAR_X}
                  y={y}
                />
                <text fill={active ? ink[50] : ink[200]} x={BAR_X + BAR_W + 8} y={y + 11}>
                  {bytes(v)}
                </text>
              </g>
            );
          })}
          <text fill={ink[200]} x={LEFT} y={HEIGHT - 6}>
            × {tokens(context)} tokens = {bytes(ours * context)} per sequence (MHA {bytes(mha * context)})
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
GqaHeads.displayName = 'GqaHeads';

export default GqaHeads;
