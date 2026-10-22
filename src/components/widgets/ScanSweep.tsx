import {type FC, memo, useMemo} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const VALUES = [3, 1, 7, 0, 4, 1, 6, 3, 5, 2, 0, 4, 8, 1, 2, 6] as const;
const N = VALUES.length;
const LEVELS = Math.log2(N);
const LEFT = 86;
const PITCH = 33;
const CELL_W = 29;
const CELL_H = 16;
const ROW = 25;
const TOP = 20;
const WIDTH = LEFT + N * PITCH + 4;

const READ_FILL = alpha(iris[400], 0.22);
const ADD_FILL = alpha(success[400], 0.28);
const SWAP_FILL = alpha(warning[400], 0.28);

type Phase = 'input' | 'up' | 'clear' | 'down';

interface Frame {
  phase: Phase;
  stride: number;
  /** `[left, right]` = `[k + stride − 1, k + 2·stride − 1]` for every active thread. */
  pairs: [number, number][];
  values: number[];
}

const pairsAt = (stride: number): [number, number][] =>
  Array.from({length: N / (2 * stride)}, (_, t): [number, number] => [
    2 * stride * t + stride - 1,
    2 * stride * t + 2 * stride - 1,
  ]);

/** Blelloch: up-sweep `a[r] += a[l]` for strides 1…n/2, clear `a[n−1]`, down-sweep `t = a[l]; a[l] = a[r]; a[r] += t` for strides n/2…1. */
const buildFrames = (): Frame[] => {
  const a = [...VALUES];
  const frames: Frame[] = [{phase: 'input', stride: 0, pairs: [], values: [...a]}];
  for (let d = 0; d < LEVELS; d++) {
    const stride = 2 ** d;
    const pairs = pairsAt(stride);
    for (const [l, r] of pairs) a[r] += a[l];
    frames.push({phase: 'up', stride, pairs, values: [...a]});
  }
  a[N - 1] = 0;
  frames.push({phase: 'clear', stride: 0, pairs: [], values: [...a]});
  for (let d = LEVELS - 1; d >= 0; d--) {
    const stride = 2 ** d;
    const pairs = pairsAt(stride);
    for (const [l, r] of pairs) {
      const t = a[l];
      a[l] = a[r];
      a[r] += t;
    }
    frames.push({phase: 'down', stride, pairs, values: [...a]});
  }
  return frames;
};

/** The sequential reference: `out[i] = a[0] + … + a[i − 1]`. */
const exclusiveScan = (a: readonly number[]): number[] => {
  const out: number[] = [];
  let acc = 0;
  for (const v of a) {
    out.push(acc);
    acc += v;
  }
  return out;
};

const countAdds = (frames: Frame[]): number => {
  let n = 0;
  for (const f of frames) if (f.phase === 'up' || f.phase === 'down') n += f.pairs.length;
  return n;
};

const FRAMES = buildFrames();
const SEQUENTIAL = exclusiveScan(VALUES);
const TOTAL = SEQUENTIAL[N - 1] + VALUES[N - 1];
const RESULT = FRAMES[FRAMES.length - 1].values;
const MATCHES = RESULT.join() === SEQUENTIAL.join();
const ADDS = countAdds(FRAMES);
const TREE_STEPS = FRAMES.filter(f => f.phase === 'up' || f.phase === 'down').length;
const SEQ_Y = TOP + FRAMES.length * ROW + 4;
const HEIGHT = SEQ_Y + CELL_H + 22;

const cx = (i: number): number => LEFT + i * PITCH + CELL_W / 2;

const labelOf = (f: Frame): string => {
  switch (f.phase) {
    case 'input':
      return 'input';
    case 'clear':
      return 'clear root';
    case 'up':
      return `up s=${f.stride}`;
    case 'down':
      return `down s=${f.stride}`;
  }
};

const ScanSweep: FC<WidgetProps> = memo(() => {
  const playback = usePlayback(FRAMES.length, 1300);
  const step = Math.min(playback.step, FRAMES.length - 1);
  const frame = FRAMES[step];
  const done = step === FRAMES.length - 1;

  const controls = useMemo(() => <PlaybackControls label="level" playback={playback} />, [playback]);

  const readout = useMemo(() => {
    const prev = FRAMES[Math.max(0, step - 1)].values;
    const threads = `${frame.pairs.length} thread${frame.pairs.length === 1 ? '' : 's'}`;
    const level = (d: number): string => `level ${d} (stride ${frame.stride}, ${threads})`;
    const ks = frame.pairs.length === 1 ? 'k = 0' : `k = 0, ${2 * frame.stride}, …`;
    switch (frame.phase) {
      case 'input':
        return (
          <>
            16 inputs summing to {TOTAL}. The scan takes 2·log₂16 = {TREE_STEPS} parallel steps ({LEVELS} up, {LEVELS}{' '}
            down) plus one clear, and only O(n) work: {ADDS} adds in total, the same order as the {N - 1} of a
            sequential loop.
          </>
        );
      case 'up': {
        const d = Math.log2(frame.stride);
        const last = d === LEVELS - 1;
        return (
          <>
            <b className="text-ink-100">Up-sweep {level(d)}</b>: each thread reads a[k+{frame.stride - 1}] and adds it
            into a[k+{2 * frame.stride - 1}] ({ks}).{' '}
            {last
              ? `The root a[${N - 1}] now holds the total, ${frame.values[N - 1]}.`
              : `Every highlighted right cell now holds the sum of its ${2 * frame.stride} inputs.`}
          </>
        );
      }
      case 'clear':
        return (
          <>
            <b className="text-ink-100">Clear the root</b> (1 thread): a[{N - 1}] = 0, setting aside the total{' '}
            {prev[N - 1]}. Zero is the identity the down-sweep pushes to index 0, which is what makes the result
            exclusive.
          </>
        );
      case 'down': {
        const d = Math.log2(frame.stride);
        return done ? (
          <>
            <b className="text-ink-100">Down-sweep {level(d)}</b> done: the array is the exclusive prefix sum [
            {RESULT.join(', ')}], {MATCHES ? 'identical to' : 'different from'} the sequential scan, after {ADDS} adds
            in {TREE_STEPS} steps (work O(n), depth 2·log₂n).
          </>
        ) : (
          <>
            <b className="text-ink-100">Down-sweep {level(d)}</b> ({ks}): each thread swaps and adds, the left cell a[k+
            {frame.stride - 1}] takes the right cell&apos;s value (the sum of everything left of this subtree) and the
            right cell a[k+{2 * frame.stride - 1}] becomes left + right.
          </>
        );
      }
    }
  }, [done, frame, step]);

  const cellStyle = (r: number, i: number): {fill: string; stroke: string} => {
    const f = FRAMES[r];
    if (r !== step) return {fill: ink[800], stroke: ink[600]};
    if (f.phase === 'clear' && i === N - 1) return {fill: SWAP_FILL, stroke: warning[400]};
    for (const [l, rt] of f.pairs) {
      if (i === rt) return {fill: ADD_FILL, stroke: success[400]};
      if (i === l)
        return f.phase === 'up' ? {fill: READ_FILL, stroke: iris[400]} : {fill: SWAP_FILL, stroke: warning[400]};
    }
    return {fill: ink[800], stroke: ink[600]};
  };

  return (
    <WidgetFrame controls={controls} readout={readout} title="blelloch scan: up-sweep, clear root, down-sweep">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Blelloch exclusive scan of 16 values, ${labelOf(frame)}`}</title>
        <g fill={ink[400]} fontFamily={MONO} fontSize={8} textAnchor="middle">
          {VALUES.map((_, i) => (
            <text key={i} x={cx(i)} y={12}>
              {i}
            </text>
          ))}
        </g>
        <text fill={ink[400]} fontFamily={MONO} fontSize={8} x={4} y={12}>
          index
        </text>
        {FRAMES.map((f, r) => {
          if (r === 0 || r > step) return null;
          const top = TOP + r * ROW;
          const bottom = top - ROW + CELL_H;
          const now = r === step;
          const edges: [number, number, string][] = [];
          for (const [l, rt] of f.pairs) {
            if (f.phase === 'up') {
              edges.push([l, rt, iris[400]], [rt, rt, success[400]]);
            } else {
              edges.push([rt, l, warning[400]], [l, rt, success[400]], [rt, rt, success[400]]);
            }
          }
          if (f.phase === 'clear') edges.push([N - 1, N - 1, warning[400]]);
          return (
            <g key={r} opacity={now ? 1 : 0.5}>
              {edges.map(([from, to, color], e) => (
                <line
                  key={e}
                  stroke={now ? color : ink[600]}
                  strokeDasharray={f.phase === 'clear' ? '2 2' : undefined}
                  strokeWidth={now ? 1.4 : 0.8}
                  x1={cx(from)}
                  x2={cx(to)}
                  y1={bottom}
                  y2={top}
                />
              ))}
            </g>
          );
        })}
        {FRAMES.map((f, r) => {
          const y = TOP + r * ROW;
          const visible = r <= step;
          const now = r === step;
          return (
            <g key={r} opacity={visible ? 1 : 0.3}>
              <text fill={now ? ink[50] : ink[300]} fontFamily={MONO} fontSize={9} x={4} y={y + 11.5}>
                {labelOf(f)}
              </text>
              {r > 0 ? (
                <text
                  fill={now ? ink[200] : ink[400]}
                  fontFamily={MONO}
                  fontSize={8}
                  textAnchor="end"
                  x={LEFT - 6}
                  y={y + 11.5}>
                  {f.phase === 'clear' ? 1 : f.pairs.length}t
                </text>
              ) : null}
              {f.values.map((v, i) => {
                const {fill, stroke} = cellStyle(r, i);
                return (
                  <g key={i}>
                    <rect
                      fill={fill}
                      height={CELL_H}
                      rx={3}
                      stroke={stroke}
                      strokeWidth={0.75}
                      width={CELL_W}
                      x={LEFT + i * PITCH}
                      y={y}
                    />
                    {visible ? (
                      <text
                        fill={now ? ink[50] : ink[200]}
                        fontFamily={MONO}
                        fontSize={9}
                        fontWeight={now && stroke !== ink[600] ? 700 : 400}
                        textAnchor="middle"
                        x={cx(i)}
                        y={y + 11.5}>
                        {v}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
        <g opacity={done ? 1 : 0.45}>
          <text fill={done ? ink[50] : ink[300]} fontFamily={MONO} fontSize={9} x={4} y={SEQ_Y + 11.5}>
            sequential
          </text>
          {SEQUENTIAL.map((v, i) => {
            const ok = done && RESULT[i] === v;
            return (
              <g key={i}>
                <rect
                  fill={ok ? ADD_FILL : 'none'}
                  height={CELL_H}
                  rx={3}
                  stroke={ok ? success[400] : ink[600]}
                  strokeDasharray="3 2"
                  strokeWidth={0.75}
                  width={CELL_W}
                  x={LEFT + i * PITCH}
                  y={SEQ_Y}
                />
                <text
                  fill={done ? ink[50] : ink[300]}
                  fontFamily={MONO}
                  fontSize={9}
                  textAnchor="middle"
                  x={cx(i)}
                  y={SEQ_Y + 11.5}>
                  {v}
                </text>
              </g>
            );
          })}
        </g>
        <g fontFamily={MONO} fontSize={9}>
          {(
            [
              [READ_FILL, iris[400], 'read'],
              [ADD_FILL, success[400], 'write left + right'],
              [SWAP_FILL, warning[400], 'write swap / clear'],
            ] as const
          ).map(([fill, stroke, label], k) => (
            <g key={label}>
              <rect
                fill={fill}
                height={9}
                rx={2}
                stroke={stroke}
                strokeWidth={0.75}
                width={14}
                x={LEFT + k * 140}
                y={HEIGHT - 13}
              />
              <text fill={ink[300]} x={LEFT + k * 140 + 19} y={HEIGHT - 5.5}>
                {label}
              </text>
            </g>
          ))}
          <text fill={ink[400]} textAnchor="end" x={WIDTH - 4} y={HEIGHT - 5.5}>
            t = threads
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
ScanSweep.displayName = 'ScanSweep';

export default ScanSweep;
