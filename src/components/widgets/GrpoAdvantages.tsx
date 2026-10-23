import {type ChangeEvent, type FC, type ReactNode, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const ANSWER = 4;
const STD_EPS = 1e-4;

const WIDTH = 600;
const HEAD_Y = 14;
const ROW_TOP = 24;
const ROW_H = 17;
const TEXT_X = 4;
const REWARD_X = 92;
const BAR_W = 92;
const SCALED_X = 124;
const PLAIN_X = 230;
const PLOT_X = 370;
const PLOT_W = 222;
const PLOT_TOP = 24;
const PLOT_H = 150;
const RHO_MAX = 2;

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

interface Completion {
  tokens: string[];
  reward: number;
}

/** A digit other than the answer, uniform over the other nine. */
const wrongDigit = (u: number): number => {
  const d = Math.floor(u * 9);
  return d >= ANSWER ? d + 1 : d;
};

/**
 * G completions of "3 + 1 =" (at most 3 tokens) from a simulated policy of skill p: the first token is the
 * answer with probability p, else a wrong digit; then, independently, EOS with probability p, else more
 * digits. Reward = accuracy + 0.5 · format, as
 * compute_rewards scores it: accuracy when the first token is 4, format when it is one digit then EOS.
 */
const sampleGroup = (seed: number, G: number, p: number): Completion[] => {
  const rng = mulberry32(seed);
  return Array.from({length: G}, () => {
    const first = rng() < p ? ANSWER : wrongDigit(rng());
    const tokens = [String(first)];
    const stops = rng() < p;
    if (stops) tokens.push('eos');
    else {
      tokens.push(String(Math.floor(rng() * 10)));
      tokens.push(rng() < 0.5 ? 'eos' : String(Math.floor(rng() * 10)));
    }
    const reward = (first === ANSWER ? 1 : 0) + (stops ? 0.5 : 0);
    return {tokens, reward};
  });
};

interface Stats {
  mean: number;
  std: number;
  scaled: number[];
  plain: number[];
}

/** group_advantages: (r − mean) / (unbiased std + 1e-4), and r − mean (Dr. GRPO). */
const advantages = (rewards: number[]): Stats => {
  const G = rewards.length;
  const mean = rewards.reduce((s, r) => s + r, 0) / G;
  const std = Math.sqrt(rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / (G - 1));
  const plain = rewards.map(r => r - mean);
  return {mean, std, plain, scaled: plain.map(a => a / (std + STD_EPS))};
};

/** The clipped surrogate GRPO maximises for one token: min(ρA, clip(ρ, 1 − ε, 1 + ε)A). */
const surrogate = (rho: number, A: number, eps: number): number => Math.min(rho * A, clamp(rho, 1 - eps, 1 + eps) * A);

const fmt = (v: number): string => (Math.abs(v) < 0.005 ? '0' : v.toFixed(2).replace('-', '−'));

const GrpoAdvantages: FC<WidgetProps> = memo(({params}) => {
  const G = clamp(Math.round(numParam(params, 'G', 8)), 2, 12);
  const [p, setP] = useState(() => clamp(numParam(params, 'p', 0.3), 0, 1));
  const [eps, setEps] = useState(() => clamp(numParam(params, 'clip', 0.2), 0.05, 0.4));
  const [seed, setSeed] = useState(7);

  const onP = useCallback((e: ChangeEvent<HTMLInputElement>) => setP(Number(e.target.value)), []);
  const onEps = useCallback((e: ChangeEvent<HTMLInputElement>) => setEps(Number(e.target.value)), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const group = useMemo(() => sampleGroup(seed, G, p), [G, p, seed]);
  const stats = useMemo(() => advantages(group.map(c => c.reward)), [group]);
  const flat = stats.std === 0;
  const correct = group.filter(c => c.tokens[0] === String(ANSWER)).length;

  // The curves use the group's own best and worst advantages; a flat group falls back to ±1.
  const aPos = flat ? 1 : Math.max(...stats.scaled);
  const aNeg = flat ? -1 : Math.min(...stats.scaled);
  const curves = useMemo(
    () =>
      [aPos, aNeg].map(A => {
        const knee = A > 0 ? 1 + eps : 1 - eps;
        // A > 0: live up to 1 + ε, then flat; A < 0: flat up to 1 − ε, then live.
        const live: Array<[number, number]> = A > 0 ? [[0, knee]] : [[knee, RHO_MAX]];
        const dead: Array<[number, number]> = A > 0 ? [[knee, RHO_MAX]] : [[0, knee]];
        return {A, knee, live, dead};
      }),
    [aNeg, aPos, eps],
  );
  const ys = [aPos, aNeg].flatMap(A => [0, 1 - eps, 1 + eps, RHO_MAX].map(r => surrogate(r, A, eps)));
  const yMax = Math.max(...ys, 0.5);
  const yMin = Math.min(...ys, -0.5);
  const px = (rho: number): number => PLOT_X + (rho / RHO_MAX) * PLOT_W;
  const py = (v: number): number => PLOT_TOP + ((yMax - v) / (yMax - yMin)) * PLOT_H;

  const maxAbs = Math.max(1, ...stats.scaled.map(Math.abs), ...stats.plain.map(Math.abs));
  const barLen = (v: number): number => (v / maxAbs) * (BAR_W / 2 - 4);
  const height = Math.max(ROW_TOP + G * ROW_H + 26, PLOT_TOP + PLOT_H + 34);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">skill p</span>
          <input
            aria-label="probability of a right answer and of a well-formed one"
            className={RANGE_CLASS}
            max={1}
            min={0}
            onChange={onP}
            step={0.05}
            type="range"
            value={p}
          />
          <span className="font-code text-ink-100 tabular-nums">{p.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">clip ε</span>
          <input
            aria-label="clip epsilon"
            className={RANGE_CLASS}
            max={0.4}
            min={0.05}
            onChange={onEps}
            step={0.05}
            type="range"
            value={eps}
          />
          <span className="font-code text-ink-100 tabular-nums">{eps.toFixed(2)}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample group
        </button>
      </>
    ),
    [eps, onEps, onP, onResample, p],
  );

  const readout = useMemo(
    () => (
      <>
        {correct} of {G} completions answer 4; rewards have mean {stats.mean.toFixed(2)} and std {stats.std.toFixed(2)}.{' '}
        {flat ? (
          <>
            Every completion scored {group[0].reward}, so <b className="text-ink-100">every advantage is 0</b> and this
            prompt adds nothing to the gradient.
          </>
        ) : (
          <>
            Scaled, the best completion gets <b className="text-ink-100">A = {fmt(aPos)}</b> and the worst{' '}
            <b className="text-ink-100">{fmt(aNeg)}</b>; mean-only (Dr. GRPO) gives {fmt(Math.max(...stats.plain))} and{' '}
            {fmt(Math.min(...stats.plain))}.
          </>
        )}{' '}
        With ε = {eps.toFixed(2)}, a positive advantage stops pushing once ρ &gt; {(1 + eps).toFixed(2)} and a negative
        one once ρ &lt; {(1 - eps).toFixed(2)}.
      </>
    ),
    [G, aNeg, aPos, correct, eps, flat, group, stats],
  );

  const drawBar = (x: number, y: number, v: number): ReactNode => {
    const cx = x + BAR_W / 2;
    const len = barLen(v);
    return (
      <>
        <rect
          fill={v >= 0 ? success[400] : danger[400]}
          fillOpacity={0.85}
          height={9}
          width={Math.abs(len)}
          x={len >= 0 ? cx : cx + len}
          y={y + 3}
        />
        <text fill={ink[100]} textAnchor={v >= 0 ? 'end' : 'start'} x={v >= 0 ? cx - 3 : cx + 3} y={y + 11}>
          {fmt(v)}
        </text>
      </>
    );
  };

  return (
    <WidgetFrame controls={controls} readout={readout} title="grpo group advantages">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>{`${G} sampled completions of 3 + 1 = with their rewards and advantages, scaled by the group std and mean-only, and the clipped objective as a function of the ratio for a positive and a negative advantage`}</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={TEXT_X} y={HEAD_Y}>
            3 + 1 = …
          </text>
          <text fill={ink[300]} x={REWARD_X} y={HEAD_Y}>
            r
          </text>
          <text fill={ink[300]} textAnchor="middle" x={SCALED_X + BAR_W / 2} y={HEAD_Y}>
            (r − r̄) / std
          </text>
          <text fill={ink[300]} textAnchor="middle" x={PLAIN_X + BAR_W / 2} y={HEAD_Y}>
            r − r̄ (Dr. GRPO)
          </text>
          {[SCALED_X, PLAIN_X].map(x => (
            <line
              key={x}
              stroke={ink[600]}
              x1={x + BAR_W / 2}
              x2={x + BAR_W / 2}
              y1={ROW_TOP - 2}
              y2={ROW_TOP + G * ROW_H}
            />
          ))}
          {group.map((c, i) => {
            const y = ROW_TOP + i * ROW_H;
            return (
              <g key={i}>
                <text fontSize={10} x={TEXT_X} y={y + 11}>
                  {c.tokens.map((t, j) => (
                    <tspan
                      fill={t === 'eos' ? ink[300] : j === 0 && t === String(ANSWER) ? success[300] : ink[100]}
                      key={j}>
                      {j === 0 ? t : ` ${t}`}
                    </tspan>
                  ))}
                </text>
                <text fill={c.reward === 0 ? ink[300] : ink[50]} fontSize={10} x={REWARD_X} y={y + 11}>
                  {c.reward.toFixed(1)}
                </text>
                {drawBar(SCALED_X, y, stats.scaled[i])}
                {drawBar(PLAIN_X, y, stats.plain[i])}
              </g>
            );
          })}
          <text fill={ink[300]} x={TEXT_X} y={ROW_TOP + G * ROW_H + 14}>
            r = 1 if first token is 4, + 0.5 if digit then eos
          </text>

          <text fill={ink[300]} x={PLOT_X} y={HEAD_Y}>
            min(ρA, clip(ρ, 1 ± ε)A) vs ρ
          </text>
          <rect
            fill={alpha(iris[400], 0.12)}
            height={PLOT_H}
            width={px(1 + eps) - px(1 - eps)}
            x={px(1 - eps)}
            y={PLOT_TOP}
          />
          <line stroke={ink[600]} x1={PLOT_X} x2={PLOT_X + PLOT_W} y1={py(0)} y2={py(0)} />
          <line stroke={ink[500]} strokeDasharray="2 3" x1={px(1)} x2={px(1)} y1={PLOT_TOP} y2={PLOT_TOP + PLOT_H} />
          {curves.map(({A, knee, live, dead}) => {
            const color = A > 0 ? success[400] : danger[400];
            return (
              <g key={A > 0 ? 'pos' : 'neg'}>
                {live.map(([a, b]) => (
                  <line
                    key={`l${a}`}
                    stroke={color}
                    strokeWidth={2}
                    x1={px(a)}
                    x2={px(b)}
                    y1={py(surrogate(a, A, eps))}
                    y2={py(surrogate(b, A, eps))}
                  />
                ))}
                {dead.map(([a, b]) => (
                  <line
                    key={`d${a}`}
                    stroke={color}
                    strokeDasharray="4 3"
                    strokeWidth={2}
                    x1={px(a)}
                    x2={px(b)}
                    y1={py(surrogate(a, A, eps))}
                    y2={py(surrogate(b, A, eps))}
                  />
                ))}
                <circle cx={px(knee)} cy={py(surrogate(knee, A, eps))} fill={color} r={2.5} />
                <text
                  fill={color}
                  textAnchor={A > 0 ? 'end' : 'start'}
                  x={A > 0 ? PLOT_X + PLOT_W : PLOT_X + 4}
                  y={A > 0 ? py(surrogate(RHO_MAX, A, eps)) - 5 : py(surrogate(0, A, eps)) - 5}>
                  A = {fmt(A)}
                </text>
              </g>
            );
          })}
          {[
            {r: 0, anchor: 'middle' as const, label: '0'},
            {r: 1 - eps, anchor: 'end' as const, label: (1 - eps).toFixed(2)},
            {r: 1 + eps, anchor: 'start' as const, label: (1 + eps).toFixed(2)},
            {r: RHO_MAX, anchor: 'end' as const, label: String(RHO_MAX)},
          ].map(({r, anchor, label}) => (
            <text
              fill={r === 0 || r === RHO_MAX ? ink[300] : iris[300]}
              key={label}
              textAnchor={anchor}
              x={px(r)}
              y={PLOT_TOP + PLOT_H + 12}>
              {label}
            </text>
          ))}
          <text fill={ink[300]} x={PLOT_X} y={PLOT_TOP + PLOT_H + 26}>
            ρ = π_θ / π_old · dashed = no gradient
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
GrpoAdvantages.displayName = 'GrpoAdvantages';

export default GrpoAdvantages;
