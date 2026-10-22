import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
const TILES = [8, 16, 32] as const;
type Tile = (typeof TILES)[number];
/** Output tiles per side and K slabs: every matrix is GRID·TILE on a side. */
const GRID = 4;
const CELL = 24;
const SIDE = GRID * CELL;
const AX = 34;
const CX = AX + SIDE + 22;
const BY = 22;
const CY = BY + SIDE + 26;
const PX = CX + SIDE + 48;
const SM = 70;
const WIDTH = 620;
const HEIGHT = CY + SIDE + 8;

const A_FILL = alpha(iris[400], 0.55);
const A_USED = alpha(iris[400], 0.2);
const B_FILL = alpha(warning[400], 0.55);
const B_USED = alpha(warning[400], 0.2);
const BAND = alpha(ink[400], 0.08);
const SUB_LINE = alpha(ink[50], 0.2);
const NAIVE_BAR = alpha(ink[400], 0.45);
/** Accumulator tint after 1…GRID slabs: the partial sum darkens as K is covered. */
const ACC_FILLS = [
  alpha(success[400], 0.24),
  alpha(success[400], 0.36),
  alpha(success[400], 0.48),
  alpha(success[400], 0.6),
];
const KERNEL_LINES = [
  'one thread per C element',
  'per slab:',
  '  load As, Bs (global)',
  '  __syncthreads()',
  '  TILE FMAs (shared)',
  '  __syncthreads()',
];

const fmt = (n: number): string => n.toLocaleString('en-US');

const TiledMatmul: FC<WidgetProps> = memo(() => {
  const [tile, setTile] = useState<Tile>(16);
  const [pick, setPick] = useState<[number, number]>([1, 2]);
  const playback = usePlayback(GRID + 1, 1200);
  const {reset} = playback;
  const step = Math.min(playback.step, GRID);
  const [row, col] = pick;
  const storing = step === GRID;
  const slabsDone = storing ? GRID : step + 1;

  const onTile = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      setTile(Number(e.currentTarget.value) as Tile);
      reset();
    },
    [reset],
  );
  const onPick = useCallback(
    (e: MouseEvent<SVGRectElement>) => {
      setPick([Number(e.currentTarget.dataset.r), Number(e.currentTarget.dataset.c)]);
      reset();
    },
    [reset],
  );

  const n = GRID * tile;
  const k = GRID * tile;
  const stats = useMemo(() => {
    const naivePerOut = 2 * k;
    const naiveTotal = n * n * naivePerOut;
    const perTile = 2 * tile * k;
    const perOut = perTile / (tile * tile);
    const tiledTotal = GRID * GRID * perTile;
    return {naivePerOut, naiveTotal, perTile, perOut, tiledTotal, reuse: naiveTotal / tiledTotal};
  }, [k, n, tile]);

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          <span className="text-ink-300">TILE</span>
          {TILES.map(t => (
            <button
              aria-pressed={t === tile}
              className={tabClass(t === tile)}
              key={t}
              onClick={onTile}
              type="button"
              value={t}>
              {t}
            </button>
          ))}
        </div>
        <PlaybackControls label="K slab" playback={playback} />
      </>
    ),
    [onTile, playback, tile],
  );

  const readout = useMemo(() => {
    const k0 = step * tile;
    const action = storing ? (
      <>
        <b className="text-ink-100">
          C tile ({row}, {col}) done
        </b>
        : all {GRID} slabs accumulated in registers, {fmt(tile * tile)} outputs written once; the block loaded{' '}
        {fmt(stats.perTile)} values ({stats.perOut} per output).{' '}
      </>
    ) : (
      <>
        <b className="text-ink-100">
          Slab {step + 1}/{GRID}
        </b>
        : load A[{row}, {step}] and B[{step}, {col}] ({fmt(2 * tile * tile)} values, k = {k0}…{k0 + tile - 1}) into
        shared memory; each value is then read by {tile} threads.{' '}
      </>
    );
    return (
      <>
        {action}
        Global loads for C ({n}×{n}, K = {k}): naive {fmt(stats.naivePerOut)} per output = {fmt(stats.naiveTotal)};
        tiled {fmt(stats.perTile)} per tile = {fmt(stats.tiledTotal)},{' '}
        <b className="text-ink-100">{stats.reuse}× fewer</b> (the reuse factor is TILE).
      </>
    );
  }, [col, n, k, row, stats, step, storing, tile]);

  const aFill = (r: number, c: number): string => {
    if (r !== row) return 'none';
    if (!storing && c === step) return A_FILL;
    return c < slabsDone ? A_USED : 'none';
  };
  const bFill = (r: number, c: number): string => {
    if (c !== col) return 'none';
    if (!storing && r === step) return B_FILL;
    return r < slabsDone ? B_USED : 'none';
  };
  const accFill = ACC_FILLS[slabsDone - 1];
  const sub = Math.min(tile, 16);
  const cells = Array.from({length: GRID * GRID}, (_, i) => [Math.floor(i / GRID), i % GRID] as const);

  const drawGrid = (x: number, y: number, fill: (r: number, c: number) => string, stroke: string): JSX.Element => (
    <g>
      {cells.map(([r, c]) => (
        <rect
          fill={fill(r, c)}
          height={CELL}
          key={`${r}-${c}`}
          stroke={stroke}
          strokeWidth={0.6}
          width={CELL}
          x={x + c * CELL}
          y={y + r * CELL}
        />
      ))}
    </g>
  );

  const drawShared = (x: number, y: number, fill: string, stroke: string, label: string): JSX.Element => (
    <g>
      <rect fill={storing ? 'none' : fill} height={SM} rx={2} stroke={stroke} strokeWidth={1} width={SM} x={x} y={y} />
      {Array.from({length: sub - 1}, (_, i) => (
        <g key={i} stroke={SUB_LINE} strokeWidth={0.4}>
          <line x1={x + ((i + 1) * SM) / sub} x2={x + ((i + 1) * SM) / sub} y1={y} y2={y + SM} />
          <line x1={x} x2={x + SM} y1={y + ((i + 1) * SM) / sub} y2={y + ((i + 1) * SM) / sub} />
        </g>
      ))}
      <text fill={ink[200]} fontFamily={MONO} fontSize={9} textAnchor="middle" x={x + SM / 2} y={y + SM + 12}>
        {label}
      </text>
    </g>
  );

  const barW = WIDTH - PX - 10;
  return (
    <WidgetFrame controls={controls} readout={readout} title="tiled matmul: shared-memory tiles over the K slabs">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`C = A·B with ${tile}×${tile} tiles, output tile (${row}, ${col}), ${
          storing ? 'stored' : `slab ${step + 1} of ${GRID}`
        }`}</title>
        <g fill={ink[300]} fontFamily={MONO} fontSize={9}>
          <text x={CX} y={BY - 7}>
            B ({k}×{n})
          </text>
          <text x={AX} y={CY - 7}>
            A ({n}×{k})
          </text>
          <text x={CX} y={CY - 7}>
            C ({n}×{n}) · click a tile
          </text>
        </g>
        <g fill={ink[400]} fontFamily={MONO} fontSize={9}>
          {KERNEL_LINES.map((line, i) => (
            <text key={line + i} x={4} xmlSpace="preserve" y={BY + 6 + i * 13}>
              {line}
            </text>
          ))}
        </g>
        <rect fill={BAND} height={SIDE} width={CELL} x={CX + col * CELL} y={BY} />
        <rect fill={BAND} height={CELL} width={SIDE} x={AX} y={CY + row * CELL} />
        {drawGrid(CX, BY, bFill, ink[600])}
        {drawGrid(AX, CY, aFill, ink[600])}
        {cells.map(([r, c]) => {
          const on = r === row && c === col;
          return (
            <rect
              aria-label={`output tile row ${r} column ${c}`}
              className="cursor-pointer"
              data-c={c}
              data-r={r}
              fill={on ? accFill : ink[800]}
              height={CELL}
              key={`${r}-${c}`}
              onClick={onPick}
              role="button"
              stroke={on ? success[400] : ink[600]}
              strokeWidth={on ? 1.5 : 0.6}
              width={CELL}
              x={CX + c * CELL}
              y={CY + r * CELL}>
              <title>{`output tile (${r}, ${c})`}</title>
            </rect>
          );
        })}
        <rect
          fill="none"
          height={SIDE}
          pointerEvents="none"
          stroke={warning[400]}
          strokeDasharray="3 2"
          strokeWidth={0.8}
          width={CELL}
          x={CX + col * CELL}
          y={BY}
        />
        <rect
          fill="none"
          height={CELL}
          pointerEvents="none"
          stroke={iris[400]}
          strokeDasharray="3 2"
          strokeWidth={0.8}
          width={SIDE}
          x={AX}
          y={CY + row * CELL}
        />
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={PX} y={BY - 7}>
          {storing ? 'shared memory released' : `shared memory, slab ${step + 1}/${GRID}`}
          <tspan fill={ink[400]}>{` · ${fmt(2 * tile * tile * 4)} B fp32 · ${fmt(tile * tile)} threads`}</tspan>
        </text>
        {drawShared(PX, BY + 4, A_FILL, iris[400], `As = A[${row}, ${storing ? '·' : step}]`)}
        <text
          fill={ink[300]}
          fontFamily={MONO}
          fontSize={12}
          textAnchor="middle"
          x={PX + SM + 16}
          y={BY + 4 + SM / 2 + 4}>
          ·
        </text>
        {drawShared(PX + SM + 32, BY + 4, B_FILL, warning[400], `Bs = B[${storing ? '·' : step}, ${col}]`)}
        <text
          fill={ink[300]}
          fontFamily={MONO}
          fontSize={12}
          textAnchor="middle"
          x={PX + 2 * SM + 48}
          y={BY + 4 + SM / 2 + 4}>
          +=
        </text>
        <rect
          fill={accFill}
          height={SM}
          rx={2}
          stroke={success[400]}
          strokeWidth={1}
          width={SM}
          x={PX + 2 * SM + 64}
          y={BY + 4}
        />
        <text
          fill={ink[50]}
          fontFamily={MONO}
          fontSize={9}
          textAnchor="middle"
          x={PX + 2 * SM + 64 + SM / 2}
          y={BY + 4 + SM / 2 + 3}>
          k &lt; {slabsDone * tile}
        </text>
        <text
          fill={ink[200]}
          fontFamily={MONO}
          fontSize={9}
          textAnchor="middle"
          x={PX + 2 * SM + 64 + SM / 2}
          y={BY + 4 + SM + 12}>
          acc C({row}, {col})
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={PX} y={CY + 4}>
          partial sum over K = {k}: {slabsDone * tile}/{k}
        </text>
        {Array.from({length: GRID}, (_, s) => (
          <rect
            fill={s < slabsDone ? accFill : 'none'}
            height={12}
            key={s}
            rx={2}
            stroke={!storing && s === step ? success[400] : ink[600]}
            strokeWidth={!storing && s === step ? 1.4 : 0.6}
            width={barW / GRID - 4}
            x={PX + (s * barW) / GRID}
            y={CY + 10}
          />
        ))}
        <g fill={ink[300]} fontFamily={MONO} fontSize={9}>
          <text x={PX} y={CY + 44}>
            global loads, naive: 2K = {fmt(stats.naivePerOut)} per output
          </text>
          <rect fill={NAIVE_BAR} height={8} rx={2} width={barW} x={PX} y={CY + 49} />
          <text x={PX} y={CY + 72}>
            tiled: 2·TILE·K / TILE² = 2K / TILE = {stats.perOut} per output
          </text>
          <rect fill={success[400]} height={8} rx={2} width={Math.max(2, barW / stats.reuse)} x={PX} y={CY + 77} />
          <text fill={ink[200]} x={PX} y={CY + 99}>
            this block so far: {fmt(slabsDone * 2 * tile * tile)} of {fmt(stats.perTile)} loads
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
TiledMatmul.displayName = 'TiledMatmul';

export default TiledMatmul;
