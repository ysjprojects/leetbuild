import {type FC, memo, useMemo} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const VALUES = [
  3, 1, 4, 1, 5, 2, 6, 2, 3, 5, 1, 4, 2, 3, 1, 2, 4, 1, 3, 2, 5, 1, 2, 4, 1, 3, 2, 1, 4, 2, 3, 1,
] as const;
const WARP = VALUES.length;
let sum = 0;
for (const v of VALUES) sum += v;
const SUM = sum;
const OFFSETS = [16, 8, 4, 2, 1] as const;

const LEFT = 48;
const WIDTH = 600;
const LANE = (WIDTH - LEFT - 8) / WARP;
const CELL_H = 16;
const GAP = 20;
/** Top of the warp panel's "before" row and of the shared-memory panel's. */
const WARP_Y = 28;
const TREE_Y = 118;
const HEIGHT = TREE_Y + 2 * CELL_H + GAP + 4;

const LIVE_FILL = alpha(iris[400], 0.3);
const TREE_FILL = alpha(success[400], 0.3);
const LIVE_LINK = alpha(iris[400], 0.8);
const DEAD_LINK = alpha(ink[500], 0.5);
const TREE_LINK = alpha(success[400], 0.8);

interface Frame {
  /** `null` for the initial load. */
  offset: number | null;
  warpBefore: number[];
  warpAfter: number[];
  treeBefore: number[];
  treeAfter: number[];
}

/**
 * Shuffle: lane i adds lane i + offset; past the warp's end `__shfl_down_sync` returns the caller's own
 * value, so those lanes double (their sums are never read). Tree: only tid < offset adds.
 */
const buildFrames = (): Frame[] => {
  const out: Frame[] = [
    {offset: null, warpBefore: [...VALUES], warpAfter: [...VALUES], treeBefore: [...VALUES], treeAfter: [...VALUES]},
  ];
  for (const o of OFFSETS) {
    const prev = out[out.length - 1];
    const w = prev.warpAfter;
    const s = prev.treeAfter;
    out.push({
      offset: o,
      warpBefore: w,
      warpAfter: w.map((v, i) => (i + o < WARP ? v + w[i + o] : v + v)),
      treeBefore: s,
      treeAfter: s.map((v, i) => (i < o ? v + s[i + o] : v)),
    });
  }
  return out;
};

const FRAMES = buildFrames();

const x = (i: number): number => LEFT + i * LANE;

const WarpReduce: FC<WidgetProps> = memo(() => {
  const playback = usePlayback(FRAMES.length, 1300);
  const step = Math.min(playback.step, FRAMES.length - 1);
  const frame = FRAMES[step];
  const done = step === FRAMES.length - 1;
  /** Lanes whose value still feeds lane 0's total, before and after this step. */
  const liveBefore = step <= 1 ? WARP : (frame.offset ?? WARP) * 2;
  const liveAfter = frame.offset ?? WARP;
  const syncs = step + 1;

  const controls = useMemo(() => <PlaybackControls label="shuffle" playback={playback} />, [playback]);

  const readout = useMemo(() => {
    const o = frame.offset;
    if (o === null) {
      return `32 lanes each hold one value in a register (sum ${SUM}). The shared-memory version first stores them to s[] and calls __syncthreads (1 so far).`;
    }
    if (done) {
      return (
        <>
          Step {step}/5, offset 1: <b className="text-ink-100">lane 0 holds {frame.warpAfter[0]}</b>, the sum of all 32
          values ({SUM}), after 5 shuffles with no shared memory and no __syncthreads. The tree reaches s[0] ={' '}
          {frame.treeAfter[0]} too, but needs 128 B of s[], {syncs} __syncthreads, and leaves 31 of 32 threads idle at
          its last level.
        </>
      );
    }
    return (
      <>
        Step {step}/5, offset {o}: all 32 lanes execute the shuffle; lanes 0 to {o - 1} ({o} active) now hold live
        partial sums; lanes {WARP - o} to 31 had no source lane, so the shuffle returned their own value and they
        doubled; the rest are don&apos;t-cares. The tree: {o} threads add, {WARP - o} idle, {syncs} __syncthreads so
        far.
      </>
    );
  }, [done, frame, step, syncs]);

  const o = frame.offset;
  const row = (
    key: string,
    y: number,
    values: number[],
    style: (i: number) => {fill: string; stroke: string; text: string; dash?: string},
  ) => (
    <g key={key}>
      {values.map((v, i) => {
        const s = style(i);
        return (
          <g key={i}>
            <rect
              fill={s.fill}
              height={CELL_H}
              rx={2}
              stroke={s.stroke}
              strokeDasharray={s.dash}
              strokeWidth={0.75}
              width={LANE - 2}
              x={x(i) + 1}
              y={y}
            />
            <text fill={s.text} fontFamily={MONO} fontSize={9} textAnchor="middle" x={x(i) + LANE / 2} y={y + 11.5}>
              {v}
            </text>
          </g>
        );
      })}
    </g>
  );

  const dim = {fill: ink[800], stroke: ink[700], text: ink[500]};
  const warpStyle = (live: number, after: boolean) => (i: number) => {
    if (after && done && i === 0) return {fill: alpha(warning[400], 0.35), stroke: warning[400], text: ink[50]};
    const base = i < live ? {fill: LIVE_FILL, stroke: iris[400], text: ink[50]} : dim;
    return after && o !== null && i + o >= WARP ? {...base, stroke: ink[400], dash: '2 2'} : base;
  };
  const treeStyle = (live: number, after: boolean) => (i: number) => {
    if (after && done && i === 0) return {fill: alpha(warning[400], 0.35), stroke: warning[400], text: ink[50]};
    return i < live ? {fill: TREE_FILL, stroke: success[400], text: ink[50]} : dim;
  };

  const links = (y: number, live: number, tree: boolean) =>
    o === null
      ? null
      : Array.from({length: WARP - o}, (_, i) => {
          if (tree && i >= o) return null;
          const color = i < live ? (tree ? TREE_LINK : LIVE_LINK) : DEAD_LINK;
          return (
            <line
              key={i}
              stroke={color}
              strokeWidth={i < live ? 1 : 0.7}
              x1={x(i + o) + LANE / 2}
              x2={x(i) + LANE / 2}
              y1={y + CELL_H}
              y2={y + CELL_H + GAP}
            />
          );
        });

  const label = (text: string, y: number) => (
    <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={y + 11.5}>
      {text}
    </text>
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="warp reduction: shuffles vs shared-memory tree">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Warp reduction of 32 values, ${o === null ? 'initial values' : `offset ${o}`}`}</title>
        <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={4} y={11}>
          {o === null
            ? 'float v = x[lane];  // one value per lane, in registers'
            : `v += __shfl_down_sync(0xffffffff, v, ${o});`}
        </text>
        <g fill={ink[400]} fontFamily={MONO} fontSize={9} textAnchor="middle">
          {VALUES.map((_, i) =>
            i % 4 === 0 || i === WARP - 1 ? (
              <text key={i} x={x(i) + LANE / 2} y={WARP_Y - 4}>
                {i}
              </text>
            ) : null,
          )}
        </g>
        {label('before', WARP_Y)}
        {label('after', WARP_Y + CELL_H + GAP)}
        {links(WARP_Y, liveAfter, false)}
        {row('wb', WARP_Y, frame.warpBefore, warpStyle(liveBefore, false))}
        {row('wa', WARP_Y + CELL_H + GAP, frame.warpAfter, warpStyle(liveAfter, true))}

        <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={4} y={TREE_Y - 8}>
          {o === null
            ? 's[tid] = v; __syncthreads();  // shared-memory tree, sync 1'
            : `if (tid < ${o}) s[tid] += s[tid + ${o}]; __syncthreads();  // sync ${syncs}`}
        </text>
        {label('s[]', TREE_Y)}
        {label('after', TREE_Y + CELL_H + GAP)}
        {links(TREE_Y, liveAfter, true)}
        {row('tb', TREE_Y, frame.treeBefore, treeStyle(liveBefore, false))}
        {row('ta', TREE_Y + CELL_H + GAP, frame.treeAfter, treeStyle(liveAfter, true))}
      </svg>
    </WidgetFrame>
  );
});
WarpReduce.displayName = 'WarpReduce';

export default WarpReduce;
