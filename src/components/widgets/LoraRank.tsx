import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, ink, iris, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 560;
const HEIGHT = 312;
/** The larger of d_in and d_out is drawn this many units long; everything else is to scale. */
const BOX = 170;
/** A rank-1 factor would be a hairline; never draw thinner than this. */
const MIN_W = 4;
const TOP = 40;
const W_X = 16;
const DW_X = 270;
const SLIDER_CLASS = `${RANGE_CLASS} min-w-0 flex-1`;
const GAP = 6;
/** Coarse grid of representative rows and columns used to shade A, B and their product. */
const GRID = 24;

const RANKS = [1, 2, 4, 8, 16, 32, 64, 128];
const D_MIN = 768;
const D_MAX = 8192;

const POS = iris[400];
const NEG = concept.pytorch;

const mulberry32 = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A: r×GRID with random entries (as Kaiming-uniform init draws it); B: GRID×r, what training would have learned. */
const rand = mulberry32(7);
const aVals = Array.from({length: RANKS[RANKS.length - 1]}, () => Array.from({length: GRID}, () => 2 * rand() - 1));
const bVals = Array.from({length: GRID}, () => Array.from({length: RANKS[RANKS.length - 1]}, () => 2 * rand() - 1));
const B_MAX = Math.max(...bVals.flat().map(Math.abs));

const group = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const shade = (v: number, max: number): string =>
  alpha(v >= 0 ? POS : NEG, 0.15 + 0.8 * Math.min(1, Math.abs(v) / max));

type Phase = 'init' | 'trained';

const LoraRank: FC<WidgetProps> = memo(() => {
  const [rankIdx, setRankIdx] = useState(3);
  const [dIn, setDIn] = useState(4096);
  const [dOut, setDOut] = useState(4096);
  const [scale, setScale] = useState(16);
  const [phase, setPhase] = useState<Phase>('init');
  const r = RANKS[rankIdx];

  const onRank = useCallback((e: ChangeEvent<HTMLInputElement>) => setRankIdx(Number(e.target.value)), []);
  const onDIn = useCallback((e: ChangeEvent<HTMLInputElement>) => setDIn(Number(e.target.value)), []);
  const onDOut = useCallback((e: ChangeEvent<HTMLInputElement>) => setDOut(Number(e.target.value)), []);
  const onAlpha = useCallback((e: ChangeEvent<HTMLInputElement>) => setScale(Number(e.target.value)), []);
  const onInit = useCallback(() => setPhase('init'), []);
  const onTrained = useCallback(() => setPhase('trained'), []);

  const trainable = r * (dIn + dOut);
  const frozen = dIn * dOut;
  const pct = (100 * trainable) / frozen;
  const atInit = phase === 'init';

  /** ΔW on the coarse grid: Σₖ B[i][k]·A[k][j] over the first r components, so its rank is at most r. */
  const delta = useMemo(() => {
    const cells = Array.from({length: GRID}, (_, i) =>
      Array.from({length: GRID}, (_, j) => {
        let sum = 0;
        for (let k = 0; k < r; k += 1) sum += bVals[i][k] * aVals[k][j];
        return sum;
      }),
    );
    const max = Math.max(...cells.flat().map(Math.abs));
    return {cells, max};
  }, [r]);

  const controls = useMemo(
    () => (
      <>
        <button aria-pressed={atInit} className={tabClass(atInit)} onClick={onInit} type="button">
          at init
        </button>
        <button aria-pressed={!atInit} className={tabClass(!atInit)} onClick={onTrained} type="button">
          after training
        </button>
      </>
    ),
    [atInit, onInit, onTrained],
  );

  const sliders = useMemo(
    () => (
      <div className="text-ink-200 mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300 w-12 shrink-0">rank r</span>
          <input
            aria-label="LoRA rank r"
            className={SLIDER_CLASS}
            max={RANKS.length - 1}
            min={0}
            onChange={onRank}
            type="range"
            value={rankIdx}
          />
          <span className="font-code text-ink-100 whitespace-nowrap tabular-nums">{r}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300 w-12 shrink-0">α</span>
          <input
            aria-label="LoRA alpha"
            className={SLIDER_CLASS}
            max={64}
            min={1}
            onChange={onAlpha}
            type="range"
            value={scale}
          />
          <span className="font-code text-ink-100 whitespace-nowrap tabular-nums">{scale}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300 w-12 shrink-0">d_in</span>
          <input
            aria-label="input dimension d_in"
            className={SLIDER_CLASS}
            max={D_MAX}
            min={D_MIN}
            onChange={onDIn}
            step={256}
            type="range"
            value={dIn}
          />
          <span className="font-code text-ink-100 whitespace-nowrap tabular-nums">{group(dIn)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300 w-12 shrink-0">d_out</span>
          <input
            aria-label="output dimension d_out"
            className={SLIDER_CLASS}
            max={D_MAX}
            min={D_MIN}
            onChange={onDOut}
            step={256}
            type="range"
            value={dOut}
          />
          <span className="font-code text-ink-100 whitespace-nowrap tabular-nums">{group(dOut)}</span>
        </label>
      </div>
    ),
    [dIn, dOut, onAlpha, onDIn, onDOut, onRank, r, rankIdx, scale],
  );

  const readout = useMemo(
    () => (
      <>
        Trainable r·(d_in + d_out) = {r}·({group(dIn)} + {group(dOut)}) ={' '}
        <b className="text-ink-100">{group(trainable)}</b> against the frozen d_in·d_out ={' '}
        <b className="text-ink-100">{group(frozen)}</b>, {pct < 0.1 ? pct.toFixed(3) : pct.toFixed(2)}% of the layer;{' '}
        {atInit
          ? 'at init B = 0, so the layer computes exactly W·x.'
          : `the update is scaled by α/r = ${scale}/${r} = ${Number(
              (scale / r).toPrecision(3),
            )} and has rank at most ${r}.`}
      </>
    ),
    [atInit, dIn, dOut, frozen, pct, r, scale, trainable],
  );

  const s = BOX / Math.max(dIn, dOut);
  const wW = dIn * s;
  const wH = dOut * s;
  const rw = Math.max(MIN_W, r * s);
  const aY = TOP;
  const mY = TOP + rw + GAP;
  const bX = DW_X;
  const mX = DW_X + rw + GAP;
  const cellW = wW / GRID;
  const cellH = wH / GRID;
  /** Rows of A (columns of B) shown: one band per component while they fit, otherwise the first that do. */
  const bands = Math.max(1, Math.min(r, Math.floor(rw / 2)));
  const bandW = rw / bands;
  const labelY = mY + wH + 15;

  return (
    <WidgetFrame controls={controls} readout={readout} title="lora rank">
      {sliders}
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>A frozen weight W beside its low-rank update ΔW = B·A, drawn to scale</title>
        <text fill={ink[200]} fontFamily={MONO} fontSize={10.5} x={W_X} y={16}>
          h = W·x + (α/r)·B·A·x
        </text>
        <rect fill={ink[700]} height={wH} rx={2} stroke={ink[500]} strokeWidth={0.75} width={wW} x={W_X} y={mY} />
        <text fill={ink[100]} fontFamily={MONO} fontSize={11} textAnchor="middle" x={W_X + wW / 2} y={mY + wH / 2 + 4}>
          W
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9.5} x={W_X} y={labelY}>
          frozen · {group(dOut)} × {group(dIn)}
        </text>
        <text
          fill={ink[200]}
          fontFamily={MONO}
          fontSize={14}
          textAnchor="middle"
          x={(W_X + wW + bX) / 2}
          y={mY + wH / 2 + 5}>
          +
        </text>
        <text
          fill={ink[300]}
          fontFamily={MONO}
          fontSize={9.5}
          textAnchor="middle"
          x={(W_X + wW + bX) / 2}
          y={mY + wH / 2 + 20}>
          α/r = {Number((scale / r).toPrecision(3))}
        </text>

        {/* A: r × d_in, random from the start. */}
        <rect fill={ink[800]} height={rw} width={wW} x={mX} y={aY} />
        {Array.from({length: bands}, (_, k) =>
          Array.from({length: GRID}, (_, j) => (
            <rect
              fill={shade(aVals[k][j], 1)}
              height={bandW}
              key={`a${k}-${j}`}
              width={cellW}
              x={mX + j * cellW}
              y={aY + k * bandW}
            />
          )),
        )}
        <rect fill="none" height={rw} stroke={POS} strokeWidth={1} width={wW} x={mX} y={aY} />
        <text fill={ink[200]} fontFamily={MONO} fontSize={9.5} x={mX} y={aY - 6}>
          A · {r} × {group(dIn)}
        </text>

        {/* B: d_out × r, zero at init. */}
        <rect fill={ink[800]} height={wH} width={rw} x={bX} y={mY} />
        {atInit
          ? null
          : Array.from({length: GRID}, (_, i) =>
              Array.from({length: bands}, (_, k) => (
                <rect
                  fill={shade(bVals[i][k], B_MAX)}
                  height={cellH}
                  key={`b${i}-${k}`}
                  width={bandW}
                  x={bX + k * bandW}
                  y={mY + i * cellH}
                />
              )),
            )}
        <rect fill="none" height={wH} stroke={atInit ? warning[300] : POS} strokeWidth={1} width={rw} x={bX} y={mY} />
        <text fill={ink[300]} fontFamily={MONO} fontSize={9.5} textAnchor="end" x={bX - 4} y={mY - 4}>
          B
        </text>

        {/* ΔW = B·A on the coarse grid. */}
        <rect
          fill={ink[800]}
          height={wH}
          stroke={ink[500]}
          strokeDasharray="4 3"
          strokeWidth={0.75}
          width={wW}
          x={mX}
          y={mY}
        />
        {atInit
          ? null
          : delta.cells.map((row, i) =>
              row.map((v, j) => (
                <rect
                  fill={shade(v, delta.max)}
                  height={cellH}
                  key={`d${i}-${j}`}
                  width={cellW}
                  x={mX + j * cellW}
                  y={mY + i * cellH}
                />
              )),
            )}
        {atInit ? (
          <text
            fill={ink[100]}
            fontFamily={MONO}
            fontSize={11}
            textAnchor={wW < 60 ? 'start' : 'middle'}
            x={wW < 60 ? mX + wW + 6 : mX + wW / 2}
            y={mY + wH / 2 + 4}>
            ΔW = 0
          </text>
        ) : null}
        <text fill={ink[300]} fontFamily={MONO} fontSize={9.5} x={mX} y={labelY}>
          ΔW = B·A · rank ≤ {r}
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9.5} x={bX} y={labelY + 13}>
          B · {group(dOut)} × {r}
        </text>

        <g fontFamily={MONO} fontSize={9.5}>
          <text fill={atInit ? warning[300] : ink[300]} x={W_X} y={HEIGHT - 22}>
            at init: B = 0, so ΔW = 0 and the model starts exactly at the pretrained W;
          </text>
          <text fill={atInit ? warning[300] : ink[300]} x={W_X} y={HEIGHT - 8}>
            A is random, so the gradient reaching B is not zero and training can move it.
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
LoraRank.displayName = 'LoraRank';

export default LoraRank;
