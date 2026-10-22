import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const PROMPT = 'the cat sat on the';
/** Fixed next-token logits, highest first. */
const VOCAB: ReadonlyArray<{token: string; logit: number}> = [
  {token: 'mat', logit: 3.2},
  {token: 'floor', logit: 2.6},
  {token: 'sofa', logit: 2.3},
  {token: 'bed', logit: 2.0},
  {token: 'rug', logit: 1.7},
  {token: 'chair', logit: 1.3},
  {token: 'roof', logit: 0.9},
  {token: 'table', logit: 0.6},
  {token: 'keyboard', logit: 0.2},
  {token: 'moon', logit: -0.8},
];
const V = VOCAB.length;
const SEED = 0x5eed;

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const TOP = 34;
const ROW = 17;
const HEIGHT = TOP + V * ROW + 26;
const LABEL_X = 84;
const BAR_X = 92;
const BAR_W = 300;
const COL_T = 448;
const COL_FINAL = 506;
const COL_OBS = 564;
const RAW_FILL = alpha(ink[400], 0.35);
const OBS_FILL = alpha(warning[400], 0.85);

/** mulberry32: one 32-bit state step → uniform in [0, 1). */
const next = (s: number): [number, number] => {
  const state = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [state, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
};

type Cut = 'top-k' | 'top-p' | null;

interface Dist {
  /** softmax(logits / T) over the whole vocabulary. */
  tempered: number[];
  cut: Cut[];
  /** Renormalised over the survivors, 0 for cut tokens. */
  final: number[];
  survivors: number;
  /** Tempered mass of the survivors before renormalising. */
  mass: number;
  entropy: number;
  temperedEntropy: number;
}

const entropyOf = (ps: number[]): number => ps.reduce((h, p) => (p > 0 ? h - p * Math.log(p) : h), 0);

/** Temperature, then top-k, then top-p on the top-k-renormalised distribution (the Hugging Face order). */
const filter = (temperature: number, k: number, topP: number): Dist => {
  const scaled = VOCAB.map(v => v.logit / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map(z => Math.exp(z - max));
  const sum = exps.reduce((s, e) => s + e, 0);
  const tempered = exps.map(e => e / sum);
  const cut: Cut[] = VOCAB.map((_, i) => (i < k ? null : 'top-k'));
  const kMass = tempered.slice(0, k).reduce((s, p) => s + p, 0);
  let cumulative = 0;
  for (let i = 0; i < k; i += 1) {
    if (cumulative >= topP - 1e-12) cut[i] = 'top-p';
    cumulative += tempered[i] / kMass;
  }
  const mass = tempered.reduce((s, p, i) => (cut[i] === null ? s + p : s), 0);
  const final = tempered.map((p, i) => (cut[i] === null ? p / mass : 0));
  return {
    tempered,
    cut,
    final,
    survivors: cut.filter(c => c === null).length,
    mass,
    entropy: entropyOf(final),
    temperedEntropy: entropyOf(tempered),
  };
};

interface Draws {
  key: string;
  counts: number[];
  n: number;
  last: number | null;
}

const EMPTY: Draws = {key: '', counts: Array.from({length: V}, () => 0), n: 0, last: null};

const Sampling: FC<WidgetProps> = memo(() => {
  const [temperature, setTemperature] = useState(1);
  const [k, setK] = useState(V);
  const [topP, setTopP] = useState(1);
  const [rng, setRng] = useState(SEED);
  const [draws, setDraws] = useState<Draws>(EMPTY);

  const onTemperature = useCallback((e: ChangeEvent<HTMLInputElement>) => setTemperature(Number(e.target.value)), []);
  const onK = useCallback((e: ChangeEvent<HTMLInputElement>) => setK(Number(e.target.value)), []);
  const onTopP = useCallback((e: ChangeEvent<HTMLInputElement>) => setTopP(Number(e.target.value)), []);

  const dist = useMemo(() => filter(temperature, k, topP), [k, temperature, topP]);
  const key = `${temperature}|${k}|${topP}`;
  const current = useMemo(() => (draws.key === key ? draws : {...EMPTY, key}), [draws, key]);

  const sample = useCallback(
    (count: number) => {
      let state = rng;
      const counts = [...current.counts];
      let last = current.last;
      for (let d = 0; d < count; d += 1) {
        const [s, u] = next(state);
        state = s;
        let acc = 0;
        let pick = dist.final.findIndex(p => {
          acc += p;
          return p > 0 && u < acc;
        });
        if (pick < 0) pick = dist.final.reduce((best, p, i) => (p > 0 ? i : best), 0);
        counts[pick] += 1;
        last = pick;
      }
      setRng(state);
      setDraws({key, counts, n: current.n + count, last});
    },
    [current, dist.final, key, rng],
  );
  const onOne = useCallback(() => sample(1), [sample]);
  const onHundred = useCallback(() => sample(100), [sample]);
  const onReset = useCallback(() => setDraws(EMPTY), []);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">T</span>
          <input
            aria-label="temperature"
            className={RANGE_CLASS}
            max={2}
            min={0.1}
            onChange={onTemperature}
            step={0.05}
            type="range"
            value={temperature}
          />
          <span className="font-code text-ink-100 tabular-nums">{temperature.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">top-k</span>
          <input
            aria-label="top-k"
            className={RANGE_CLASS}
            max={V}
            min={1}
            onChange={onK}
            step={1}
            type="range"
            value={k}
          />
          <span className="font-code text-ink-100 tabular-nums">{k === V ? 'off' : k}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">top-p</span>
          <input
            aria-label="top-p"
            className={RANGE_CLASS}
            max={1}
            min={0.05}
            onChange={onTopP}
            step={0.01}
            type="range"
            value={topP}
          />
          <span className="font-code text-ink-100 tabular-nums">{topP === 1 ? 'off' : topP.toFixed(2)}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onOne} type="button">
          Sample ×1
        </button>
        <button className={BUTTON_CLASS} onClick={onHundred} type="button">
          Sample ×100
        </button>
        <button aria-label="clear samples" className={BUTTON_CLASS} onClick={onReset} type="button">
          ↺
        </button>
      </>
    ),
    [k, onHundred, onK, onOne, onReset, onTemperature, onTopP, temperature, topP],
  );

  const gap = current.n === 0 ? 0 : Math.max(...dist.final.map((p, i) => Math.abs(current.counts[i] / current.n - p)));
  const readout = useMemo(
    () => (
      <>
        <b className="text-ink-100">
          {dist.survivors} of {V} tokens survive
        </b>
        , holding {(dist.mass * 100).toFixed(1)}% of the T = {temperature.toFixed(2)} mass before renormalising; entropy{' '}
        {dist.entropy.toFixed(3)} nats ({(dist.entropy / Math.LN2).toFixed(2)} bits) vs{' '}
        {dist.temperedEntropy.toFixed(3)} nats unfiltered.{' '}
        {current.n === 0
          ? 'Sample to fill in the observed frequencies.'
          : `${current.n} sample${current.n === 1 ? '' : 's'}, last “${
              current.last === null ? '' : VOCAB[current.last].token
            }”; the largest gap between observed and expected frequency is ${(gap * 100).toFixed(1)} points.`}
      </>
    ),
    [current.last, current.n, dist.entropy, dist.mass, dist.survivors, dist.temperedEntropy, gap, temperature],
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="next-token sampling">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Next-token probabilities after temperature, top-k and top-p, with observed sample frequencies</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[100]} fontSize={10} x={8} y={13}>
            “{PROMPT} <tspan fill={iris[300]}>{current.last === null ? '___' : VOCAB[current.last].token}</tspan>”
          </text>
          <text fill={ink[300]} textAnchor="end" x={COL_T} y={13}>
            softmax(z/T)
          </text>
          <text fill={ink[300]} textAnchor="end" x={COL_FINAL} y={13}>
            kept
          </text>
          <text fill={ink[300]} textAnchor="end" x={COL_OBS} y={13}>
            observed
          </text>
          {[0, 0.25, 0.5, 0.75, 1].map(v => (
            <g key={v}>
              <line
                stroke={ink[700]}
                strokeWidth={0.75}
                x1={BAR_X + v * BAR_W}
                x2={BAR_X + v * BAR_W}
                y1={TOP - 6}
                y2={TOP + V * ROW - 2}
              />
              <text fill={ink[400]} textAnchor="middle" x={BAR_X + v * BAR_W} y={TOP + V * ROW + 9}>
                {v}
              </text>
            </g>
          ))}
          {VOCAB.map((v, i) => {
            const y = TOP + i * ROW;
            const kept = dist.cut[i] === null;
            const obs = current.n === 0 ? null : current.counts[i] / current.n;
            return (
              <g key={v.token}>
                <text fill={kept ? ink[100] : ink[500]} textAnchor="end" x={LABEL_X} y={y + 6}>
                  {v.token}
                </text>
                <rect fill={RAW_FILL} height={4} width={Math.max(0.5, BAR_W * dist.tempered[i])} x={BAR_X} y={y + 4} />
                {kept ? (
                  <rect
                    fill={iris[400]}
                    height={7}
                    rx={1}
                    width={Math.max(0.5, BAR_W * dist.final[i])}
                    x={BAR_X}
                    y={y - 4}
                  />
                ) : null}
                {obs === null || obs === 0 ? null : (
                  <rect fill={OBS_FILL} height={13} rx={1} width={2} x={BAR_X + BAR_W * obs - 1} y={y - 5} />
                )}
                <text fill={kept ? ink[200] : ink[500]} textAnchor="end" x={COL_T} y={y + 6}>
                  {dist.tempered[i].toFixed(3)}
                </text>
                <text fill={kept ? ink[50] : ink[500]} textAnchor="end" x={COL_FINAL} y={y + 6}>
                  {kept ? dist.final[i].toFixed(3) : dist.cut[i]}
                </text>
                <text fill={obs === null ? ink[500] : warning[300]} textAnchor="end" x={COL_OBS} y={y + 6}>
                  {obs === null ? '·' : obs.toFixed(2)}
                </text>
              </g>
            );
          })}
          <rect fill={iris[400]} height={7} width={10} x={BAR_X} y={HEIGHT - 11} />
          <text fill={ink[300]} x={BAR_X + 14} y={HEIGHT - 4}>
            renormalised
          </text>
          <rect fill={RAW_FILL} height={4} width={10} x={BAR_X + 100} y={HEIGHT - 9} />
          <text fill={ink[300]} x={BAR_X + 114} y={HEIGHT - 4}>
            before filters
          </text>
          <rect fill={OBS_FILL} height={10} width={2} x={BAR_X + 210} y={HEIGHT - 12} />
          <text fill={ink[300]} x={BAR_X + 216} y={HEIGHT - 4}>
            observed frequency
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
Sampling.displayName = 'Sampling';

export default Sampling;
