import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, node, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const TOKENS = 10;
const MAX_EXPERTS = 8;
const MAX_K = 4;
const LOGIT_SCALE = 1.2;

const WIDTH = 600;
const HEIGHT = 244;
const ROW_TOP = 22;
const ROW_H = 20;
const PROB_X = 40;
const PROB_W = 180;
const CHIP_X = 228;
const CHIP_W = 160;
const BARS_X = 410;
const BARS_W = 184;
const BARS_TOP = 36;
const BARS_BOTTOM = 200;

const EXPERT_COLORS = [
  iris[400],
  concept.kafka,
  success[400],
  concept.http,
  concept.grpc,
  node.client,
  warning[300],
  concept.cuda,
];
const DROP_FILL = alpha(danger[400], 0.25);

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

/** Fixed router logits, TOKENS × MAX_EXPERTS standard normals (Box–Muller) scaled by LOGIT_SCALE. */
const routerLogits = (seed: number): number[][] => {
  const rng = mulberry32(seed);
  return Array.from({length: TOKENS}, () =>
    Array.from(
      {length: MAX_EXPERTS},
      () => LOGIT_SCALE * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()),
    ),
  );
};

const softmax = (z: number[]): number[] => {
  const m = Math.max(...z);
  const e = z.map(v => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
};

/** `.31`, or `1.0` once it rounds up, for tight labels. */
const short = (v: number): string => (v >= 0.995 ? '1.0' : v.toFixed(2).slice(1));

interface Choice {
  expert: number;
  /** Router probability renormalised over the token's top-k. */
  weight: number;
  dropped: boolean;
}

interface Routing {
  probs: number[][];
  choices: Choice[][];
  /** Assignments each expert received before the capacity cut. */
  counts: number[];
  capacity: number;
  dropped: Array<{token: number; expert: number}>;
  meanProb: number[];
  loss: number;
}

const route = (logits: number[][], experts: number, k: number, skew: number, factor: number): Routing => {
  const probs = logits.map(row => softmax(row.slice(0, experts).map((v, e) => (e === 0 ? v + skew : v))));
  const capacity = Math.ceil((factor * TOKENS * k) / experts);
  const counts = new Array<number>(experts).fill(0);
  const dropped: Array<{token: number; expert: number}> = [];
  // Token order: token 1 claims its slots first, so the late tokens are the ones that overflow.
  const choices = probs.map((p, token) => {
    const top = p
      .map((v, e) => ({e, v}))
      .sort((a, b) => b.v - a.v || a.e - b.e)
      .slice(0, k);
    const norm = top.reduce((s, c) => s + c.v, 0);
    return top.map(({e, v}) => {
      counts[e] += 1;
      const isDropped = counts[e] > capacity;
      if (isDropped) dropped.push({token, expert: e});
      return {expert: e, weight: v / norm, dropped: isDropped};
    });
  });
  const meanProb = Array.from({length: experts}, (_, e) => probs.reduce((s, p) => s + p[e], 0) / TOKENS);
  // Switch Transformer auxiliary loss: E · Σ f_i · P_i, f_i = share of the TOKENS·k assignments sent to expert i.
  const loss = experts * counts.reduce((s, c, e) => s + (c / (TOKENS * k)) * meanProb[e], 0);
  return {probs, choices, counts, capacity, dropped, meanProb, loss};
};

const MoeRouting: FC<WidgetProps> = memo(({params}) => {
  const experts = clamp(Math.round(numParam(params, 'experts', 4)), 2, MAX_EXPERTS);
  const k = clamp(Math.round(numParam(params, 'k', 2)), 1, Math.min(MAX_K, experts));
  const [skew, setSkew] = useState(0);
  const [factor, setFactor] = useState(1.25);
  const [seed, setSeed] = useState(3);

  const onSkew = useCallback((e: ChangeEvent<HTMLInputElement>) => setSkew(Number(e.target.value)), []);
  const onFactor = useCallback((e: ChangeEvent<HTMLInputElement>) => setFactor(Number(e.target.value)), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const logits = useMemo(() => routerLogits(seed), [seed]);
  const routing = useMemo(() => route(logits, experts, k, skew, factor), [experts, factor, k, logits, skew]);
  const {probs, choices, counts, capacity, dropped, meanProb, loss} = routing;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">skew → E1</span>
          <input
            aria-label="router logit bias toward expert 1"
            className={RANGE_CLASS}
            max={4}
            min={0}
            onChange={onSkew}
            step={0.25}
            type="range"
            value={skew}
          />
          <span className="font-code text-ink-100 tabular-nums">+{skew.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">capacity factor</span>
          <input
            aria-label="capacity factor"
            className={RANGE_CLASS}
            max={2.5}
            min={0.5}
            onChange={onFactor}
            step={0.25}
            type="range"
            value={factor}
          />
          <span className="font-code text-ink-100 tabular-nums">{factor.toFixed(2)}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample logits
        </button>
      </>
    ),
    [factor, onFactor, onResample, onSkew, skew],
  );

  const busiest = counts.reduce((best, c, e) => (c > counts[best] ? e : best), 0);
  const readout = useMemo(
    () => (
      <>
        Capacity = ceil({factor} · {TOKENS} tokens · k={k} / {experts} experts) ={' '}
        <b className="text-ink-100">{capacity} slots per expert</b>; the busiest, E{busiest + 1}, is sent{' '}
        {counts[busiest]} of {TOKENS * k} assignments.{' '}
        {dropped.length === 0
          ? 'Nothing overflows, so every token reaches all its chosen experts.'
          : `${dropped.length} assignment${dropped.length === 1 ? '' : 's'} dropped (${dropped
              .map(d => `tok ${d.token + 1} → E${d.expert + 1}`)
              .join(', ')}); a dropped slot contributes nothing and the token passes through the residual.`}{' '}
        Load-balancing loss E·Σ f_i·P_i = <b className="text-ink-100">{loss.toFixed(3)}</b> (1.000 when perfectly
        balanced).
      </>
    ),
    [busiest, capacity, counts, dropped, experts, factor, k, loss],
  );

  const slot = BARS_W / experts;
  const barW = Math.min(30, slot - 6);
  const scaleMax = Math.max(capacity, ...counts, 1);
  const barY = (v: number): number => BARS_BOTTOM - (v / scaleMax) * (BARS_BOTTOM - BARS_TOP);
  const chipGap = 4;
  const chipW = (CHIP_W - (k - 1) * chipGap) / k;

  return (
    <WidgetFrame controls={controls} readout={readout} title="mixture-of-experts routing">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>
          Router probabilities for {TOKENS} tokens over {experts} experts, the top-{k} chosen experts, and each
          expert&apos;s load against its capacity
        </title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={PROB_X} y={12}>
            router softmax p(expert)
          </text>
          <text fill={ink[300]} x={CHIP_X} y={12}>
            top-{k} · weight renormalised
          </text>
          <text fill={ink[300]} x={BARS_X} y={12}>
            load vs capacity
          </text>
          {probs.map((p, token) => {
            const y = ROW_TOP + token * ROW_H;
            let acc = 0;
            return (
              <g key={token}>
                <text fill={ink[200]} x={4} y={y + 10}>
                  tok {token + 1}
                </text>
                {p.map((v, e) => {
                  const x = PROB_X + acc * PROB_W;
                  acc += v;
                  const chosen = choices[token].some(c => c.expert === e);
                  return (
                    <rect
                      fill={EXPERT_COLORS[e]}
                      fillOpacity={chosen ? 0.95 : 0.3}
                      height={12}
                      key={e}
                      stroke={ink[850]}
                      strokeWidth={0.75}
                      width={v * PROB_W}
                      x={x}
                      y={y + 1}
                    />
                  );
                })}
                {choices[token].map((c, rank) => {
                  const x = CHIP_X + rank * (chipW + chipGap);
                  const label =
                    chipW >= 60 ? `E${c.expert + 1} · ${c.weight.toFixed(2)}` : `E${c.expert + 1} ${short(c.weight)}`;
                  return (
                    <g key={rank}>
                      <rect
                        fill={c.dropped ? DROP_FILL : alpha(EXPERT_COLORS[c.expert], 0.18)}
                        height={14}
                        rx={3}
                        stroke={c.dropped ? danger[400] : EXPERT_COLORS[c.expert]}
                        strokeDasharray={c.dropped ? '3 2' : undefined}
                        width={chipW}
                        x={x}
                        y={y}
                      />
                      <text
                        fill={c.dropped ? danger[200] : ink[50]}
                        textAnchor="middle"
                        textDecoration={c.dropped ? 'line-through' : undefined}
                        x={x + chipW / 2}
                        y={y + 10}>
                        {label}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {counts.map((c, e) => {
            const cx = BARS_X + slot * e + slot / 2;
            const kept = Math.min(c, capacity);
            return (
              <g key={e}>
                <rect
                  fill={ink[800]}
                  height={BARS_BOTTOM - barY(capacity)}
                  width={barW}
                  x={cx - barW / 2}
                  y={barY(capacity)}
                />
                <rect
                  fill={EXPERT_COLORS[e]}
                  height={BARS_BOTTOM - barY(kept)}
                  width={barW}
                  x={cx - barW / 2}
                  y={barY(kept)}
                />
                {c > capacity ? (
                  <rect
                    fill={DROP_FILL}
                    height={barY(capacity) - barY(c)}
                    stroke={danger[400]}
                    strokeDasharray="3 2"
                    width={barW}
                    x={cx - barW / 2}
                    y={barY(c)}
                  />
                ) : null}
                <text fill={c > capacity ? danger[300] : ink[100]} textAnchor="middle" x={cx} y={barY(c) - 4}>
                  {c}
                </text>
                <text fill={ink[200]} textAnchor="middle" x={cx} y={BARS_BOTTOM + 12}>
                  E{e + 1}
                </text>
                <text fill={ink[300]} textAnchor="middle" x={cx} y={BARS_BOTTOM + 24}>
                  {short(meanProb[e])}
                </text>
              </g>
            );
          })}
          <line
            stroke={ink[200]}
            strokeDasharray="4 3"
            x1={BARS_X}
            x2={BARS_X + BARS_W}
            y1={barY(capacity)}
            y2={barY(capacity)}
          />
          <text fill={ink[300]} x={BARS_X} y={BARS_BOTTOM + 36}>
            P_i (mean router prob) · cap {capacity}
          </text>
          <text fill={ink[300]} x={4} y={ROW_TOP + TOKENS * ROW_H + 12}>
            bright = chosen · dashed red = over capacity, dropped
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
MoeRouting.displayName = 'MoeRouting';

export default MoeRouting;
