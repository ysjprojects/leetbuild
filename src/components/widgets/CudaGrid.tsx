import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {categorical, ink} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const MAX_N = 96;
const MAX_BLOCK = 32;
/** Cap on gridDim·blockDim so every thread slot stays drawable (at most 6 rows of 32). */
const MAX_THREADS = 96;
const COLS = 32;
const LEFT = 36;
const CELL = 18;
const CELL_H = 20;
const ROW_H = 40;
const TOP = 34;
const WIDTH = LEFT + COLS * CELL + 4;

interface Segment {
  row: number;
  pass: number;
  from: number;
  to: number;
}

const CudaGrid: FC<WidgetProps> = memo(({params}) => {
  const [n, setN] = useState(() => clamp(Math.floor(numParam(params, 'n', 50)), 1, MAX_N));
  const [block, setBlock] = useState(() => clamp(Math.floor(numParam(params, 'block', 8)), 1, MAX_BLOCK));
  const [gridRaw, setGrid] = useState(() => Math.max(1, Math.ceil(Math.ceil(n / block) / 2)));
  const gridMax = Math.max(1, Math.floor(MAX_THREADS / block));
  const grid = Math.min(gridRaw, gridMax);

  const onN = useCallback((e: ChangeEvent<HTMLInputElement>) => setN(Number(e.target.value)), []);
  const onBlock = useCallback((e: ChangeEvent<HTMLInputElement>) => setBlock(Number(e.target.value)), []);
  const onGrid = useCallback((e: ChangeEvent<HTMLInputElement>) => setGrid(Number(e.target.value)), []);

  const threads = grid * block;
  const passes = Math.ceil(n / threads);
  const slots = passes * threads;
  const lastActive = n - (passes - 1) * threads;
  const idle = threads - lastActive;
  const blocksNeeded = Math.ceil(n / block);
  const rows = Math.ceil(slots / COLS);

  /** Each pass's stretch of thread slots, split at row wraps. */
  const segments = useMemo(() => {
    const out: Segment[] = [];
    for (let p = 0; p < passes; p++) {
      let start = p * threads;
      const end = (p + 1) * threads;
      while (start < end) {
        const row = Math.floor(start / COLS);
        const stop = Math.min(end, (row + 1) * COLS);
        out.push({row, pass: p, from: start % COLS, to: stop - row * COLS});
        start = stop;
      }
    }
    return out;
  }, [passes, threads]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">n</span>
          <input
            aria-label="array length n"
            className={RANGE_CLASS}
            max={MAX_N}
            min={1}
            onChange={onN}
            step={1}
            type="range"
            value={n}
          />
          <span className="font-code text-ink-100 tabular-nums">{n}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">block</span>
          <input
            aria-label="threads per block"
            className={RANGE_CLASS}
            max={MAX_BLOCK}
            min={1}
            onChange={onBlock}
            step={1}
            type="range"
            value={block}
          />
          <span className="font-code text-ink-100 tabular-nums">{block}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">grid</span>
          <input
            aria-label="blocks in the grid"
            className={RANGE_CLASS}
            max={gridMax}
            min={1}
            onChange={onGrid}
            step={1}
            type="range"
            value={grid}
          />
          <span className="font-code text-ink-100 tabular-nums">{grid}</span>
        </label>
      </>
    ),
    [block, grid, gridMax, n, onBlock, onGrid, onN],
  );

  const readout = useMemo(() => {
    const coverage =
      grid < blocksNeeded
        ? `${blocksNeeded} blocks would cover n = ${n} in one pass.`
        : grid > blocksNeeded
        ? `${grid - blocksNeeded} whole block${grid - blocksNeeded === 1 ? ' has' : 's have'} nothing to do.`
        : `${blocksNeeded} = ⌈${n}/${block}⌉ blocks: exactly one pass.`;
    return (
      <>
        <code className="font-code text-iris-200">
          kernel&lt;&lt;&lt;{grid}, {block}&gt;&gt;&gt;(x, {n})
        </code>{' '}
        launches {threads} threads; the grid-stride loop runs{' '}
        <b className="text-ink-100">
          {passes} pass{passes === 1 ? '' : 'es'}
        </b>{' '}
        (pass p covers idx + p·{threads}). In the last pass {lastActive} thread{lastActive === 1 ? '' : 's'} work and{' '}
        <b className="text-ink-100">{idle} idle</b> (they fail <code className="font-code">i &lt; n</code>). {coverage}
      </>
    );
  }, [block, blocksNeeded, grid, idle, lastActive, n, passes, threads]);

  const height = TOP + rows * ROW_H;
  return (
    <WidgetFrame controls={controls} readout={readout} title="cuda grid: threads → elements, grid-stride loop">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>{`${grid} blocks of ${block} threads over ${n} elements: ${passes} grid-stride passes, ${idle} idle threads in the last`}</title>
        <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={4} y={11}>
          for (int i = blockIdx.x*blockDim.x + threadIdx.x; i &lt; n; i += gridDim.x*blockDim.x)
        </text>
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={categorical[0]} height={9} rx={2} width={9} x={4} y={18} />
          <rect fill={categorical[1]} height={9} rx={2} width={9} x={15} y={18} />
          <text fill={ink[300]} x={29} y={26}>
            colour = blockIdx · label = global thread idx
          </text>
          <rect
            fill="none"
            height={9}
            rx={2}
            stroke={ink[400]}
            strokeDasharray="2 2"
            width={9}
            x={WIDTH - 136}
            y={18}
          />
          <text fill={ink[300]} x={WIDTH - 122} y={26}>
            idle thread (i ≥ n)
          </text>
        </g>
        {Array.from({length: rows}, (_, r) => (
          <text fill={ink[400]} fontFamily={MONO} fontSize={9} key={r} x={4} y={TOP + r * ROW_H + 14}>
            i={r * COLS}
          </text>
        ))}
        {Array.from({length: slots}, (_, s) => {
          const x = LEFT + (s % COLS) * CELL;
          const y = TOP + Math.floor(s / COLS) * ROW_H;
          const t = s % threads;
          const active = s < n;
          return (
            <g key={s}>
              {active ? (
                <rect
                  fill={categorical[Math.floor(t / block) % categorical.length]}
                  height={CELL_H}
                  rx={2}
                  width={CELL - 2}
                  x={x + 1}
                  y={y}
                />
              ) : (
                <rect
                  fill="none"
                  height={CELL_H - 1}
                  rx={2}
                  stroke={ink[500]}
                  strokeDasharray="2 2"
                  width={CELL - 3}
                  x={x + 1.5}
                  y={y + 0.5}
                />
              )}
              <text
                fill={active ? ink[950] : ink[400]}
                fontFamily={MONO}
                fontSize={9}
                fontWeight={active ? 600 : 400}
                textAnchor="middle"
                x={x + CELL / 2}
                y={y + 14}>
                {t}
              </text>
            </g>
          );
        })}
        {segments.map(seg => {
          const x0 = LEFT + seg.from * CELL + 1;
          const w = (seg.to - seg.from) * CELL - 2;
          const y = TOP + seg.row * ROW_H + CELL_H + 4;
          const label = w >= 44 ? `pass ${seg.pass}` : w >= 16 ? `p${seg.pass}` : '';
          const startsPass = seg.from + seg.row * COLS === seg.pass * threads;
          return (
            <g key={`${seg.row}-${seg.pass}`}>
              <rect fill={seg.pass % 2 === 0 ? ink[400] : ink[600]} height={3} rx={1} width={w} x={x0} y={y} />
              {startsPass && seg.pass > 0 ? (
                <line stroke={ink[200]} strokeWidth={1.5} x1={x0 - 1} x2={x0 - 1} y1={y - CELL_H - 6} y2={y + 4} />
              ) : null}
              {label === '' ? null : (
                <text fill={ink[300]} fontFamily={MONO} fontSize={9} textAnchor="middle" x={x0 + w / 2} y={y + 13}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
CudaGrid.displayName = 'CudaGrid';

export default CudaGrid;
