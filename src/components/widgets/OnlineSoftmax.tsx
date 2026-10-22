import {type FC, memo, useMemo} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
/** Scores rise tile after tile (with tile 4 the max goes 2.1 → 3.5 → 4.1), so every tile rescales the past. */
const SCORES = [1.2, -0.4, 2.1, 0.3, 3.5, 1.0, -1.2, 2.8, 0.6, 4.1, -0.3, 1.7] as const;
const VALUES = [0.5, -1.0, 2.0, 1.5, -0.5, 3.0, 1.0, -2.0, 0.8, 1.2, 2.5, -1.5] as const;
const N = SCORES.length;

const WIDTH = 600;
const LEFT = 52;
const CELL = 45;
const CELL_TOP = 18;
const BAR_TOP = 62;
const BAR_H = 34;
const BRACKET_Y = BAR_TOP + BAR_H + 8;
const PANEL_Y = BRACKET_Y + 40;
const LINE = 17;
const HEIGHT = PANEL_Y + 4 * LINE + 4;

const PENDING_FILL = alpha(warning[400], 0.15);
const DONE_FILL = alpha(iris[400], 0.12);

type Phase = 'init' | 'rescale' | 'add' | 'done';

interface Frame {
  phase: Phase;
  tile: number;
  /** Scores in [0, seen) are already in l and acc. */
  seen: number;
  tileMax: number;
  mOld: number;
  m: number;
  alpha: number;
  lOld: number;
  accOld: number;
  /** After the rescale only. */
  lScaled: number;
  accScaled: number;
  /** Σ exp(s − m) and Σ exp(s − m)·v over the tile. */
  addL: number;
  addAcc: number;
  l: number;
  acc: number;
}

/** The FlashAttention recurrence over a 1-row score vector: two frames per tile (rescale, then add), plus init and done. */
const buildFrames = (tile: number): Frame[] => {
  const zero = {tile: -1, seen: 0, tileMax: -Infinity, mOld: -Infinity, m: -Infinity, alpha: 0, addL: 0, addAcc: 0};
  const frames: Frame[] = [{...zero, phase: 'init', lOld: 0, accOld: 0, lScaled: 0, accScaled: 0, l: 0, acc: 0}];
  let m = -Infinity;
  let l = 0;
  let acc = 0;
  for (let t = 0, start = 0; start < N; t++, start += tile) {
    const end = Math.min(N, start + tile);
    const tileMax = Math.max(...SCORES.slice(start, end));
    const mNew = Math.max(m, tileMax);
    const a = Math.exp(m - mNew);
    let addL = 0;
    let addAcc = 0;
    for (let j = start; j < end; j++) {
      const e = Math.exp(SCORES[j] - mNew);
      addL += e;
      addAcc += e * VALUES[j];
    }
    const base = {
      tile: t,
      tileMax,
      mOld: m,
      m: mNew,
      alpha: a,
      lOld: l,
      accOld: acc,
      lScaled: a * l,
      accScaled: a * acc,
    };
    frames.push({...base, phase: 'rescale', seen: start, addL, addAcc, l: a * l, acc: a * acc});
    m = mNew;
    l = a * l + addL;
    acc = a * acc + addAcc;
    frames.push({...base, phase: 'add', seen: end, addL, addAcc, l, acc});
  }
  const last = frames[frames.length - 1];
  frames.push({...last, phase: 'done'});
  return frames;
};

/** Two-pass reference: exact max, then the normalised weighted sum. */
const fullSoftmax = (): {max: number; sum: number; out: number} => {
  const max = Math.max(...SCORES);
  const e = SCORES.map(s => Math.exp(s - max));
  const sum = e.reduce((acc, x) => acc + x, 0);
  return {max, sum, out: e.reduce((acc, x, j) => acc + (x / sum) * VALUES[j], 0)};
};
const FULL = fullSoftmax();

const num = (x: number, digits = 3): string => (x === -Infinity ? '−∞' : x.toFixed(digits).replace('-', '−'));

const OnlineSoftmax: FC<WidgetProps> = memo(({params}) => {
  const tile = clamp(Math.floor(numParam(params, 'tile', 4)), 1, N);
  const frames = useMemo(() => buildFrames(tile), [tile]);
  const playback = usePlayback(frames.length, 1500);
  const step = Math.min(playback.step, frames.length - 1);
  const f = frames[step];
  const tiles = Math.ceil(N / tile);
  const pendingEnd = f.phase === 'rescale' ? Math.min(N, f.seen + tile) : f.seen;

  const controls = useMemo(() => <PlaybackControls label="step" playback={playback} />, [playback]);

  const lines = useMemo((): {text: string; tone: string}[] => {
    switch (f.phase) {
      case 'init':
        return [
          {
            text: `start: m = −∞, l = 0, acc = 0 · ${N} scores in ${tiles} tile${tiles > 1 ? 's' : ''} of ${tile}`,
            tone: ink[200],
          },
          {text: 'each tile: new max → rescale the past by α = exp(m_old − m_new) → add the tile', tone: ink[300]},
        ];
      case 'rescale':
        return [
          {
            text: `tile ${f.tile}: tile max = ${num(f.tileMax, 2)} · m = max(${num(f.mOld, 2)}, ${num(
              f.tileMax,
              2,
            )}) = ${num(f.m, 2)}`,
            tone: ink[100],
          },
          {text: `α = exp(${num(f.mOld, 2)} − ${num(f.m, 2)}) = ${num(f.alpha)}`, tone: warning[300]},
          {text: `l   = α · ${num(f.lOld)} = ${num(f.lScaled)}`, tone: ink[200]},
          {text: `acc = α · ${num(f.accOld)} = ${num(f.accScaled)}`, tone: ink[200]},
        ];
      case 'add':
        return [
          {text: `tile ${f.tile}: add Σ exp(s_j − ${num(f.m, 2)}) and Σ exp(s_j − ${num(f.m, 2)})·v_j`, tone: ink[100]},
          {text: `l   = ${num(f.lScaled)} + ${num(f.addL)} = ${num(f.l)}`, tone: ink[200]},
          {text: `acc = ${num(f.accScaled)} + ${num(f.addAcc)} = ${num(f.acc)}`, tone: ink[200]},
          {text: `running output acc / l = ${num(f.acc / f.l, 4)}`, tone: iris[300]},
        ];
      case 'done':
        return [
          {text: `online:  acc / l = ${num(f.acc)} / ${num(f.l)} = ${num(f.acc / f.l, 6)}`, tone: iris[300]},
          {
            text: `full softmax: Σ softmax(s)_j · v_j = ${num(FULL.out, 6)} (max ${num(FULL.max, 2)}, Σ = ${num(
              FULL.sum,
            )})`,
            tone: success[300],
          },
          {
            text: `|difference| = ${Math.abs(f.acc / f.l - FULL.out).toExponential(
              1,
            )} · one pass, never all ${N} scores at once`,
            tone: ink[200],
          },
        ];
    }
  }, [f, tile, tiles]);

  const readout = useMemo(() => {
    switch (f.phase) {
      case 'init':
        return `Online softmax keeps three numbers per row (running max m, running sum l, accumulated output acc) and reads the ${N} scores ${tile} at a time.`;
      case 'rescale':
        if (f.mOld === -Infinity)
          return `Tile 0 sets the running max m = ${num(
            f.m,
            2,
          )}; α = exp(−∞) = 0 multiplies the still-empty l and acc.`;
        if (f.alpha === 1)
          return `Tile ${f.tile}'s max ${num(f.tileMax, 2)} does not beat m = ${num(
            f.m,
            2,
          )}, so α = exp(0) = 1 and l, acc carry over unchanged.`;
        return `Tile ${f.tile} raises the max from ${num(f.mOld, 2)} to ${num(
          f.m,
          2,
        )}, so everything already summed was exponentiated against the wrong max: multiplying l and acc by α = ${num(
          f.alpha,
        )} fixes them.`;
      case 'add':
        return `Tile ${f.tile} adds ${num(f.addL)} to l and ${num(f.addAcc)} to acc; ${
          f.seen
        } of ${N} scores seen, running output acc / l = ${num(f.acc / f.l, 4)}.`;
      case 'done':
        return `After ${tiles} tile${tiles > 1 ? 's' : ''}: acc / l = ${num(
          f.acc / f.l,
          6,
        )} and the two-pass softmax gives ${num(
          FULL.out,
          6,
        )}; the rescale makes the tiled result exact, not an approximation.`;
    }
  }, [f, tile, tiles]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="online softmax · running max and rescale">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Online softmax over ${N} scores in tiles of ${tile}, step ${step + 1} of ${frames.length}`}</title>
        <g fill={ink[300]} fontFamily={MONO} fontSize={9} textAnchor="end">
          <text x={LEFT - 6} y={CELL_TOP + 13}>
            s_j
          </text>
          <text x={LEFT - 6} y={CELL_TOP + 33}>
            v_j
          </text>
          <text x={LEFT - 6} y={BAR_TOP + BAR_H - 2}>
            e^(s−m)
          </text>
        </g>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={LEFT} y={10}>
          scores of one query row · bars = exp(s_j − m) with the current running max m = {num(f.m, 2)}
        </text>
        {SCORES.map((s, j) => {
          const x = LEFT + j * CELL;
          const done = j < f.seen;
          const pending = j >= f.seen && j < pendingEnd;
          const isMax = f.phase !== 'init' && s === f.m && (done || pending);
          const bar = done ? Math.exp(s - f.m) : 0;
          return (
            <g key={j}>
              <rect
                fill={pending ? PENDING_FILL : done ? DONE_FILL : ink[800]}
                height={38}
                rx={3}
                stroke={pending ? warning[400] : isMax ? iris[400] : ink[700]}
                strokeWidth={pending || isMax ? 1.5 : 1}
                width={CELL - 4}
                x={x + 2}
                y={CELL_TOP}
              />
              <text
                fill={done || pending ? ink[50] : ink[400]}
                fontFamily={MONO}
                fontSize={10}
                textAnchor="middle"
                x={x + CELL / 2}
                y={CELL_TOP + 14}>
                {num(s, 1)}
              </text>
              <text
                fill={done || pending ? ink[300] : ink[500]}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="middle"
                x={x + CELL / 2}
                y={CELL_TOP + 32}>
                {num(VALUES[j], 1)}
              </text>
              <rect fill={ink[800]} height={BAR_H} rx={2} width={CELL - 14} x={x + 7} y={BAR_TOP} />
              <rect
                className="transition-all duration-500"
                fill={iris[400]}
                height={bar * BAR_H}
                rx={2}
                width={CELL - 14}
                x={x + 7}
                y={BAR_TOP + BAR_H - bar * BAR_H}
              />
            </g>
          );
        })}
        {Array.from({length: tiles}, (_, t) => {
          const x0 = LEFT + t * tile * CELL + 3;
          const x1 = LEFT + Math.min(N, (t + 1) * tile) * CELL - 3;
          const active = f.phase !== 'init' && f.phase !== 'done' && t === f.tile;
          const color = active ? warning[400] : t <= f.tile ? ink[400] : ink[600];
          return (
            <g key={t}>
              <path d={`M${x0} ${BRACKET_Y} v4 H${x1} v-4`} fill="none" stroke={color} strokeWidth={1.2} />
              <text
                fill={active ? warning[300] : ink[300]}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="middle"
                x={(x0 + x1) / 2}
                y={BRACKET_Y + 16}>
                {tile * CELL >= 135
                  ? `tile ${t} · max ${num(Math.max(...SCORES.slice(t * tile, (t + 1) * tile)), 1)}`
                  : tile * CELL >= 90
                  ? `max ${num(Math.max(...SCORES.slice(t * tile, (t + 1) * tile)), 1)}`
                  : `t${t}`}
              </text>
            </g>
          );
        })}
        <rect fill={ink[900]} height={HEIGHT - PANEL_Y + 12} rx={6} width={WIDTH - 4} x={2} y={PANEL_Y - 14} />
        <g fontFamily={MONO} fontSize={10}>
          {lines.map((line, i) => (
            <text fill={line.tone} key={i} x={14} y={PANEL_Y + i * LINE + 2}>
              {line.text}
            </text>
          ))}
        </g>
      </svg>
    </WidgetFrame>
  );
});
OnlineSoftmax.displayName = 'OnlineSoftmax';

export default OnlineSoftmax;
