import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {BUTTON_CLASS, usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const MAX_GAMMA = 10;
/** The strip holds this many emitted tokens; the simulation runs every round that fits. */
const STRIP = 40;

const WIDTH = 600;
const CHART_TOP = 22;
const CHART_BOTTOM = 104;
const CHART_LEFT = 30;
const CHART_W = 300;
const PANEL_X = 352;
const ROUND_Y = 136;
const DRAFT_X = 84;
const DRAFT_W = 34;
const OUT_Y = 186;
const OUT_X = 84;
const OUT_CELL = (WIDTH - 4 - OUT_X) / STRIP;
const HEIGHT = 236;

const ACCEPT = success[400];
const REJECT = danger[400];
const RESAMPLE = warning[400];
const BONUS = iris[400];

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

/** Leviathan et al., eq. 1: expected tokens per target call when each draft is accepted with probability α. */
const tokensPerCall = (a: number, g: number): number => (a >= 1 ? g + 1 : (1 - a ** (g + 1)) / (1 - a));
/** Their walltime improvement: tokens per call over the cost of a call, γ draft forwards at c each plus one target forward. */
const speedupOf = (a: number, g: number, c: number): number => tokensPerCall(a, g) / (g * c + 1);

interface Round {
  /** One uniform per draft position; position i is checked only if every earlier one was accepted. */
  u: number[];
  /** Accepted drafts: the run of u < α before the first rejection. */
  n: number;
  /** Index of this round's first token in the output strip. */
  start: number;
}

/** Rounds of the i.i.d. model: draft i is accepted iff u_i < α, the first rejection ends the round. */
const simulate = (a: number, g: number, seed: number): Round[] => {
  const rng = mulberry32(seed);
  const rounds: Round[] = [];
  let emitted = 0;
  while (emitted + g + 1 <= STRIP) {
    const u = Array.from({length: g}, () => rng());
    const reject = u.findIndex(v => v >= a);
    const n = reject === -1 ? g : reject;
    rounds.push({u, n, start: emitted});
    emitted += n + 1;
  }
  return rounds;
};

const fmt2 = (v: number): string => v.toFixed(2);
/** `.42` for a uniform in a narrow cell. */
const short = (v: number): string => v.toFixed(2).slice(1);

const SpeculativeDecoding: FC<WidgetProps> = memo(({params}) => {
  const [a, setA] = useState(() => clamp(numParam(params, 'alpha', 0.8), 0, 0.99));
  const [g, setG] = useState(() => clamp(Math.round(numParam(params, 'gamma', 4)), 1, MAX_GAMMA));
  const [c, setC] = useState(() => clamp(numParam(params, 'cost', 0.1), 0, 1));
  const [seed, setSeed] = useState(7);

  const onAlpha = useCallback((e: ChangeEvent<HTMLInputElement>) => setA(Number(e.target.value)), []);
  const onGamma = useCallback((e: ChangeEvent<HTMLInputElement>) => setG(Number(e.target.value)), []);
  const onCost = useCallback((e: ChangeEvent<HTMLInputElement>) => setC(Number(e.target.value)), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const rounds = useMemo(() => simulate(a, g, seed), [a, g, seed]);
  const playback = usePlayback(rounds.length, 1100);
  const k = Math.min(playback.step, rounds.length - 1);
  const round = rounds[k];
  const emitted = round.start + round.n + 1;
  const calls = k + 1;

  const expected = tokensPerCall(a, g);
  const speedup = speedupOf(a, g, c);
  const curve = useMemo(() => Array.from({length: MAX_GAMMA}, (_, i) => speedupOf(a, i + 1, c)), [a, c]);
  const best = curve.reduce((b, v, i) => (v > curve[b] ? i : b), 0) + 1;
  const yMax = Math.max(1.5, ...curve) * 1.15;
  const barY = (v: number): number => CHART_BOTTOM - (v / yMax) * (CHART_BOTTOM - CHART_TOP);
  const slot = CHART_W / MAX_GAMMA;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">α</span>
          <input
            aria-label="acceptance rate alpha"
            className={RANGE_CLASS}
            max={0.99}
            min={0}
            onChange={onAlpha}
            step={0.01}
            type="range"
            value={a}
          />
          <span className="font-code text-ink-100 tabular-nums">{fmt2(a)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">γ</span>
          <input
            aria-label="draft length gamma"
            className={RANGE_CLASS}
            max={MAX_GAMMA}
            min={1}
            onChange={onGamma}
            step={1}
            type="range"
            value={g}
          />
          <span className="font-code text-ink-100 tabular-nums">{g}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">c</span>
          <input
            aria-label="draft cost ratio c"
            className={RANGE_CLASS}
            max={1}
            min={0}
            onChange={onCost}
            step={0.01}
            type="range"
            value={c}
          />
          <span className="font-code text-ink-100 tabular-nums">{fmt2(c)}</span>
        </label>
        <PlaybackControls label="round" playback={playback} />
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample
        </button>
      </>
    ),
    [a, c, g, onAlpha, onCost, onGamma, onResample, playback],
  );

  const readout = useMemo(() => {
    const passed =
      round.n === 0 ? '' : `${round.n === 1 ? 'draft 1 passes' : `drafts 1 to ${round.n} pass`} u < α = ${fmt2(a)}; `;
    const what =
      round.n < g
        ? `draft ${round.n + 1} is rejected (u = ${short(
            round.u[round.n],
          )} ≥ α), so the target's residual max(0, p − q) supplies token ${round.n + 1}`
        : `all ${g} drafts pass, so the target adds a bonus token from p_γ`;
    const cost = calls * (g * c + 1);
    return (
      <>
        Round {calls}: {passed}
        {what}. So far{' '}
        <b className="text-ink-100">
          {emitted} tokens from {calls} target call{calls === 1 ? '' : 's'}
        </b>{' '}
        ({fmt2(emitted / calls)} per call, expected {fmt2(expected)}), costing {fmt2(cost)} target-forward times against{' '}
        {emitted} without a draft: {fmt2(emitted / cost)}× here, {fmt2(speedup)}× expected.
      </>
    );
  }, [a, c, calls, emitted, expected, g, round, speedup]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="speculative decoding · accept, reject, resample">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Expected speedup for γ from 1 to ${MAX_GAMMA} at α = ${fmt2(a)} and c = ${fmt2(
          c,
        )}, and round ${calls} of a simulated run on a token strip`}</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={4} y={12}>
            expected speedup by γ · (1 − α^(γ+1)) / ((1 − α)(γc + 1))
          </text>
          <line
            stroke={ink[500]}
            strokeDasharray="3 3"
            x1={CHART_LEFT}
            x2={CHART_LEFT + CHART_W}
            y1={barY(1)}
            y2={barY(1)}
          />
          <text fill={ink[400]} textAnchor="end" x={CHART_LEFT - 4} y={barY(1) + 3}>
            1×
          </text>
          {curve.map((v, i) => {
            const x = CHART_LEFT + i * slot + 3;
            const current = i + 1 === g;
            return (
              <g key={i}>
                <rect
                  className="transition-all duration-300"
                  fill={current ? iris[400] : alpha(iris[400], 0.3)}
                  height={CHART_BOTTOM - barY(v)}
                  rx={2}
                  width={slot - 6}
                  x={x}
                  y={barY(v)}
                />
                <text fill={current ? ink[50] : ink[300]} textAnchor="middle" x={x + (slot - 6) / 2} y={barY(v) - 3}>
                  {v.toFixed(1)}
                </text>
                <text
                  fill={i + 1 === best ? iris[300] : ink[400]}
                  fontWeight={i + 1 === best ? 700 : 400}
                  textAnchor="middle"
                  x={x + (slot - 6) / 2}
                  y={CHART_BOTTOM + 11}>
                  {i + 1}
                </text>
              </g>
            );
          })}
          <text fill={ink[400]} x={CHART_LEFT} y={CHART_BOTTOM + 22}>
            γ (bold: best, {best})
          </text>

          <text fill={ink[300]} x={PANEL_X} y={30}>
            tokens per target call
          </text>
          <text fill={ink[100]} fontSize={11} x={PANEL_X} y={44}>
            (1 − {fmt2(a)}^{g + 1}) / (1 − {fmt2(a)}) = {fmt2(expected)}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={62}>
            cost of a call, in target forwards
          </text>
          <text fill={ink[100]} fontSize={11} x={PANEL_X} y={76}>
            γc + 1 = {g}·{fmt2(c)} + 1 = {fmt2(g * c + 1)}
          </text>
          <text fill={ink[300]} x={PANEL_X} y={94}>
            expected speedup
          </text>
          <text fill={speedup >= 1 ? success[300] : danger[300]} fontSize={11} fontWeight={700} x={PANEL_X} y={108}>
            {fmt2(expected)} / {fmt2(g * c + 1)} = {fmt2(speedup)}×
          </text>

          <text fill={ink[200]} x={4} y={ROUND_Y + 14}>
            round {calls}
          </text>
          <text fill={ink[400]} x={4} y={ROUND_Y + 26}>
            u vs α={fmt2(a)}
          </text>
          {round.u.map((u, i) => {
            const x = DRAFT_X + i * DRAFT_W;
            const state = i < round.n ? 'accept' : i === round.n ? 'reject' : 'skip';
            const color = state === 'accept' ? ACCEPT : state === 'reject' ? REJECT : ink[600];
            return (
              <g key={i}>
                <rect
                  fill={state === 'skip' ? 'transparent' : alpha(color, 0.2)}
                  height={22}
                  rx={3}
                  stroke={color}
                  strokeDasharray={state === 'skip' ? '2 2' : undefined}
                  width={DRAFT_W - 4}
                  x={x}
                  y={ROUND_Y}
                />
                <text
                  fill={state === 'skip' ? ink[500] : ink[50]}
                  textAnchor="middle"
                  textDecoration={state === 'reject' ? 'line-through' : undefined}
                  x={x + (DRAFT_W - 4) / 2}
                  y={ROUND_Y + 10}>
                  x̃{i + 1}
                </text>
                <text
                  fill={state === 'skip' ? ink[500] : color}
                  textAnchor="middle"
                  x={x + (DRAFT_W - 4) / 2}
                  y={ROUND_Y + 19}>
                  {state === 'skip' ? 'skip' : short(u)}
                </text>
              </g>
            );
          })}
          {(() => {
            const x = DRAFT_X + g * DRAFT_W + 6;
            const bonus = round.n === g;
            const color = bonus ? BONUS : RESAMPLE;
            return (
              <g>
                <rect
                  fill={alpha(color, 0.25)}
                  height={22}
                  rx={3}
                  stroke={color}
                  width={DRAFT_W + 16}
                  x={x}
                  y={ROUND_Y}
                />
                <text fill={ink[50]} textAnchor="middle" x={x + (DRAFT_W + 16) / 2} y={ROUND_Y + 10}>
                  {bonus ? 'bonus' : 'resample'}
                </text>
                <text fill={color} textAnchor="middle" x={x + (DRAFT_W + 16) / 2} y={ROUND_Y + 19}>
                  {bonus ? '~ p_γ' : '~ p − q'}
                </text>
              </g>
            );
          })()}

          <text fill={ink[200]} x={4} y={OUT_Y + 10}>
            output
          </text>
          <text fill={ink[400]} x={4} y={OUT_Y + 22}>
            {emitted}/{STRIP} tokens
          </text>
          {Array.from({length: STRIP}, (_, t) => {
            const x = OUT_X + t * OUT_CELL;
            const r = rounds.findIndex(rd => t >= rd.start && t <= rd.start + rd.n);
            const shown = r !== -1 && r <= k;
            if (!shown)
              return (
                <rect
                  fill="transparent"
                  height={14}
                  key={t}
                  rx={2}
                  stroke={ink[700]}
                  strokeDasharray="2 2"
                  width={OUT_CELL - 2}
                  x={x + 1}
                  y={OUT_Y}
                />
              );
            const rd = rounds[r];
            const fromTarget = t === rd.start + rd.n;
            const color = !fromTarget ? ACCEPT : rd.n === g ? BONUS : RESAMPLE;
            return (
              <g key={t}>
                <rect
                  fill={alpha(color, r === k ? 0.55 : 0.3)}
                  height={14}
                  rx={2}
                  stroke={color}
                  strokeWidth={r === k ? 1.5 : 0.75}
                  width={OUT_CELL - 2}
                  x={x + 1}
                  y={OUT_Y}
                />
                {t === rd.start ? <line stroke={ink[300]} x1={x} x2={x} y1={OUT_Y - 4} y2={OUT_Y + 18} /> : null}
              </g>
            );
          })}
          <rect fill={alpha(ACCEPT, 0.4)} height={8} stroke={ACCEPT} width={12} x={OUT_X} y={HEIGHT - 16} />
          <text fill={ink[300]} x={OUT_X + 16} y={HEIGHT - 9}>
            accepted draft
          </text>
          <rect fill={alpha(RESAMPLE, 0.4)} height={8} stroke={RESAMPLE} width={12} x={OUT_X + 120} y={HEIGHT - 16} />
          <text fill={ink[300]} x={OUT_X + 136} y={HEIGHT - 9}>
            residual resample
          </text>
          <text fill={ink[300]} x={OUT_X + 256} y={HEIGHT - 9}>
            bonus from p_γ
          </text>
          <rect fill={alpha(BONUS, 0.4)} height={8} stroke={BONUS} width={12} x={OUT_X + 240} y={HEIGHT - 16} />
          <text fill={ink[400]} textAnchor="end" x={WIDTH - 4} y={HEIGHT - 9}>
            | marks a target call
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
SpeculativeDecoding.displayName = 'SpeculativeDecoding';

export default SpeculativeDecoding;
