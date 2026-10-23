import {type ChangeEvent, type FC, type ReactElement, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, node, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';

/** GPT-3 175B, the model Megatron's 8-way tensor parallelism was sized for: d = 12,288, 96 heads of 128, bf16. */
const D = 12288;
const HEADS = 96;
const BYTES = 2;
const MAX_RANKS = 8;

const LAYERS = ['mlp', 'attention'] as const;
type Layer = (typeof LAYERS)[number];
type Order = 'col-row' | 'row-col';

const RANK_COLORS = [
  iris[400],
  concept.kafka,
  success[400],
  concept.http,
  concept.grpc,
  node.client,
  warning[300],
  concept.cuda,
];
const rankFills = RANK_COLORS.map(color => alpha(color, 0.35));
const REPLICATED_FILL = alpha(ink[400], 0.18);
const BAD_FILL = alpha(danger[400], 0.12);
const CHIP_FILL = alpha(iris[400], 0.14);
const BAD_CHIP_FILL = alpha(danger[400], 0.16);
const ROW_FILL = alpha(iris[400], 0.1);

const WIDTH = 600;
const HEIGHT = 244;
const MARGIN = 16;
const CY = 84;
const UNIT = 36;
const TABLE_Y = 184;
const TABLE_X = [MARGIN, 136, 306, 466];

/** The two matrices of one sublayer, as the paper writes them: Y = act(X·A), Z = Y·B. */
interface Shape {
  a: string;
  b: string;
  act: string;
  /** Width of X·A in units of d (4 for the MLP's fc, 3 for the fused q, k, v). */
  hA: number;
  /** Width of the activation B reads (4 for the MLP, 1 for the merged heads). */
  hY: number;
}

const SHAPES: Record<Layer, Shape> = {
  mlp: {a: 'A = fc', b: 'B = proj', act: 'GELU', hA: 4, hY: 4},
  attention: {a: 'A = W_qkv', b: 'B = W_o', act: 'attention', hA: 3, hY: 1},
};

/** Bytes one rank sends per token: ring all-reduce 2(p − 1)/p · n, ring all-gather (p − 1)/p · n. */
const allReduce = (n: number, p: number): number => (2 * (p - 1) * n * BYTES) / p;
const allGather = (n: number, p: number): number => ((p - 1) * n * BYTES) / p;

interface Cost {
  fwd: string;
  bwd: string;
  calls: number;
  sent: number;
}

const costOf = (order: Order, shape: Shape, p: number): Cost => {
  if (p === 1) return {fwd: 'none', bwd: 'none', calls: 0, sent: 0};
  if (order === 'col-row') return {fwd: 'AR d (g)', bwd: 'AR d (f)', calls: 2, sent: 2 * allReduce(D, p)};
  return {
    fwd: `AR ${shape.hA}d + AG d`,
    bwd: `AR ${shape.hY === 1 ? '' : shape.hY}d + AG d`,
    calls: 4,
    sent: allReduce(shape.hA * D, p) + allReduce(shape.hY * D, p) + 2 * allGather(D, p),
  };
};

const kib = (bytes: number): string => `${(bytes / 1024).toLocaleString('en-US', {maximumFractionDigits: 1})} KiB`;

/** A matrix drawn whole (replicated), split into p column stripes (repeated per group: q | k | v), or into p row stripes. */
const matrix = (
  key: string,
  x: number,
  w: number,
  h: number,
  split: 'none' | 'cols' | 'rows',
  p: number,
  bad = false,
  groups = 1,
): ReactElement => {
  const y = CY - h / 2;
  const n = split === 'cols' ? groups * p : p;
  const stripes =
    split === 'none'
      ? []
      : Array.from({length: n}, (_, s) =>
          split === 'cols'
            ? {s, r: s % p, x: x + (s * w) / n, y, w: w / n, h}
            : {s, r: s, x, y: y + (s * h) / n, w, h: h / n},
        );
  return (
    <g key={key}>
      <rect
        fill={bad ? BAD_FILL : split === 'none' ? REPLICATED_FILL : 'transparent'}
        height={h}
        stroke={bad ? danger[400] : ink[400]}
        strokeDasharray={bad ? '3 2' : undefined}
        width={w}
        x={x}
        y={y}
      />
      {stripes.map(s => (
        <g key={s.s}>
          <rect
            fill={rankFills[s.r]}
            height={s.h}
            stroke={RANK_COLORS[s.r]}
            strokeWidth={0.75}
            width={s.w}
            x={s.x}
            y={s.y}
          />
          {s.w >= 14 && s.h >= 14 ? (
            <text
              fill={ink[50]}
              fontFamily={MONO}
              fontSize={9}
              textAnchor="middle"
              x={s.x + s.w / 2}
              y={s.y + s.h / 2 + 3}>
              r{s.r}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
};

interface Chip {
  name: string;
  when: string;
  bad?: boolean;
}

const TensorParallel: FC<WidgetProps> = memo(({params}) => {
  const [layer, setLayer] = useState<Layer>(stringParam(params, 'layer', LAYERS, 'mlp'));
  const [p, setP] = useState(clamp(Math.round(numParam(params, 'ranks', 2)), 1, MAX_RANKS));
  const [order, setOrder] = useState<Order>('col-row');

  const onMlp = useCallback(() => setLayer('mlp'), []);
  const onAttention = useCallback(() => setLayer('attention'), []);
  const onRanks = useCallback((e: ChangeEvent<HTMLInputElement>) => setP(Number(e.target.value)), []);
  const onColRow = useCallback(() => setOrder('col-row'), []);
  const onRowCol = useCallback(() => setOrder('row-col'), []);

  const shape = SHAPES[layer];
  const divides = HEADS % p === 0 && D % p === 0;
  const costs = useMemo(
    () => ({'col-row': costOf('col-row', shape, p), 'row-col': costOf('row-col', shape, p)}),
    [p, shape],
  );
  const cost = costs[order];

  const controls = useMemo(
    () => (
      <>
        <button aria-pressed={layer === 'mlp'} className={tabClass(layer === 'mlp')} onClick={onMlp} type="button">
          MLP
        </button>
        <button
          aria-pressed={layer === 'attention'}
          className={tabClass(layer === 'attention')}
          onClick={onAttention}
          type="button">
          attention
        </button>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">ranks</span>
          <input
            aria-label="tensor-parallel ranks"
            className={RANGE_CLASS}
            max={MAX_RANKS}
            min={1}
            onChange={onRanks}
            step={1}
            type="range"
            value={p}
          />
          <span className="font-code text-ink-100 tabular-nums">p = {p}</span>
        </label>
        <button
          aria-pressed={order === 'col-row'}
          className={tabClass(order === 'col-row')}
          onClick={onColRow}
          type="button">
          column → row
        </button>
        <button
          aria-pressed={order === 'row-col'}
          className={tabClass(order === 'row-col')}
          onClick={onRowCol}
          type="button">
          row → column
        </button>
      </>
    ),
    [layer, onAttention, onColRow, onMlp, onRanks, onRowCol, order, p],
  );

  const readout = useMemo(() => {
    if (!divides)
      return (
        <>
          p = {p} does not divide {HEADS} heads and d = {D.toLocaleString('en-US')}:{' '}
          <b className="text-ink-100">Megatron asserts the split is exact</b>, so with these dimensions p is 1, 2, 3, 4,
          6 or 8.
        </>
      );
    if (p === 1) return <>One rank holds both matrices whole: nothing is split and nothing is communicated.</>;
    const other = costs[order === 'col-row' ? 'row-col' : 'col-row'];
    return order === 'col-row' ? (
      <>
        {layer === 'mlp'
          ? 'Splitting fc by columns keeps GELU local (GELU(X·A_r) is rank r’s own slice of hidden units)'
          : 'Splitting W_qkv by heads keeps attention local (a head’s softmax reads only its own q and k)'}
        , and splitting B by rows leaves partial sums that g adds:{' '}
        <b className="text-ink-100">one all-reduce of d = 12,288 bf16 values</b> (24 KiB) forward and one (f) backward,{' '}
        {kib(cost.sent)} sent per rank per token. Row then column costs {other.calls} collectives and {kib(other.sent)}.
      </>
    ) : (
      <>
        Splitting A by rows makes every rank hold a partial X·A, and {shape.act}(Σ partials) ≠ Σ {shape.act}(partials),
        so it must be all-reduced first ({shape.hA}d wide), then B&apos;s column split needs an all-gather:{' '}
        <b className="text-ink-100">
          {cost.calls} collectives, {kib(cost.sent)}
        </b>{' '}
        per rank per token against {kib(other.sent)}, and {shape.act} runs {p}× redundantly on every rank.
      </>
    );
  }, [cost, costs, divides, layer, order, p, shape]);

  // Glyph widths: d is one UNIT; X and Z are T × d, drawn UNIT tall; 3d and 4d are drawn compressed.
  const aW = (UNIT * (shape.hA + 1)) / 2;
  const yW = shape.hY === 1 ? UNIT : aW;
  const bH = shape.hY === 1 ? UNIT : aW;
  const widths = [UNIT, aW, yW, UNIT, UNIT];
  const gap = (WIDTH - 2 * MARGIN - widths.reduce((s, w) => s + w, 0)) / 4;
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((s, w) => s + w + gap, 0));
  const split = (colRow: 'none' | 'cols' | 'rows', rowCol: 'none' | 'cols' | 'rows'): 'none' | 'cols' | 'rows' =>
    !divides || p === 1 ? 'none' : order === 'col-row' ? colRow : rowCol;
  const redundant = divides && p > 1 && order === 'row-col';

  const chips: (Chip | null)[] =
    !divides || p === 1
      ? [null, null, null, null]
      : order === 'col-row'
      ? [{name: 'f', when: 'AR in bwd'}, {name: shape.act, when: 'no comm'}, null, {name: 'g', when: 'AR in fwd'}]
      : [
          {name: 'split X', when: 'AG in bwd'},
          {name: 'all-reduce', when: `${shape.hA}d, in fwd`, bad: true},
          {name: 'f', when: 'AR in bwd', bad: true},
          {name: 'all-gather', when: 'in fwd', bad: true},
        ];

  const hY = shape.hY === 1 ? '' : `${shape.hY}`;
  const glyphs = [
    {label: 'X', sub: 'T × d', el: matrix('x', xs[0], UNIT, UNIT, split('none', 'cols'), p)},
    {
      label: shape.a,
      sub: layer === 'mlp' ? `d × ${shape.hA}d` : 'd × 3d · q | k | v',
      el: matrix('a', xs[1], aW, UNIT, split('cols', 'rows'), p, false, layer === 'mlp' ? 1 : 3),
    },
    {
      label: layer === 'mlp' ? 'Y = GELU(XA)' : 'heads, merged',
      sub: `T × ${hY}d`,
      el: matrix('y', xs[2], yW, UNIT, split('cols', 'none'), p, redundant),
    },
    {label: shape.b, sub: `${hY}d × d`, el: matrix('b', xs[3], UNIT, bH, split('rows', 'cols'), p)},
    {label: 'Z', sub: 'T × d', el: matrix('z', xs[4], UNIT, UNIT, 'none', p)},
  ];

  return (
    <WidgetFrame controls={controls} readout={readout} title="megatron tensor parallelism">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`The ${layer === 'mlp' ? 'MLP' : 'attention'} sublayer split over ${p} rank${p === 1 ? '' : 's'}, ${
          order === 'col-row' ? 'column then row parallel' : 'row then column parallel'
        }, with the collectives it needs and the bytes each rank sends per token`}</title>
        <g fontFamily={MONO} fontSize={9}>
          {Array.from({length: p}, (_, r) => (
            <g key={r}>
              <rect fill={rankFills[r]} height={9} stroke={RANK_COLORS[r]} width={9} x={MARGIN + r * 30} y={6} />
              <text fill={ink[200]} x={MARGIN + r * 30 + 12} y={14}>
                r{r}
              </text>
            </g>
          ))}
          <text fill={ink[300]} textAnchor="end" x={WIDTH - MARGIN} y={14}>
            d = 12,288 · {HEADS} heads · bf16 · grey = replicated
          </text>

          {glyphs.map((g, i) => (
            <g key={g.label}>
              {g.el}
              <text fill={ink[100]} textAnchor="middle" x={xs[i] + widths[i] / 2} y={CY + Math.max(UNIT, bH) / 2 + 14}>
                {g.label}
              </text>
              <text fill={ink[300]} textAnchor="middle" x={xs[i] + widths[i] / 2} y={CY + Math.max(UNIT, bH) / 2 + 25}>
                {g.sub}
              </text>
            </g>
          ))}

          {chips.map((chip, i) => {
            const x1 = xs[i] + widths[i] + 4;
            const x2 = xs[i + 1] - 4;
            const cx = (x1 + x2) / 2;
            return (
              <g key={i}>
                <line stroke={ink[400]} x1={x1} x2={x2 - 4} y1={CY} y2={CY} />
                <path d={`M ${x2 - 5} ${CY - 3} L ${x2} ${CY} L ${x2 - 5} ${CY + 3} Z`} fill={ink[400]} />
                {chip === null ? null : (
                  <g>
                    <rect
                      fill={chip.bad ? BAD_CHIP_FILL : CHIP_FILL}
                      height={14}
                      rx={3}
                      stroke={chip.bad ? danger[400] : iris[400]}
                      width={chip.name.length * 5.6 + 10}
                      x={cx - (chip.name.length * 5.6 + 10) / 2}
                      y={CY - 24}
                    />
                    <text fill={chip.bad ? danger[200] : ink[50]} textAnchor="middle" x={cx} y={CY - 14}>
                      {chip.name}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          <text fill={ink[300]} x={TABLE_X[0]} y={TABLE_Y}>
            order
          </text>
          <text fill={ink[300]} x={TABLE_X[1]} y={TABLE_Y}>
            forward
          </text>
          <text fill={ink[300]} x={TABLE_X[2]} y={TABLE_Y}>
            backward
          </text>
          <text fill={ink[300]} x={TABLE_X[3]} y={TABLE_Y}>
            sent / rank / token
          </text>
          {(['col-row', 'row-col'] as const).map((o, i) => {
            const c = costs[o];
            const y = TABLE_Y + 18 + i * 18;
            const tone = !divides ? ink[400] : o === 'row-col' && p > 1 ? danger[300] : ink[100];
            return (
              <g key={o}>
                {o === order ? (
                  <rect fill={ROW_FILL} height={16} rx={3} width={WIDTH - 2 * MARGIN + 8} x={MARGIN - 4} y={y - 12} />
                ) : null}
                <text fill={ink[100]} x={TABLE_X[0]} y={y}>
                  {o === 'col-row' ? 'column → row' : 'row → column'}
                </text>
                <text fill={tone} x={TABLE_X[1]} y={y}>
                  {divides ? c.fwd : 'not divisible'}
                </text>
                <text fill={tone} x={TABLE_X[2]} y={y}>
                  {divides ? c.bwd : 'not divisible'}
                </text>
                <text fill={tone} x={TABLE_X[3]} y={y}>
                  {divides ? kib(c.sent) : '·'}
                </text>
              </g>
            );
          })}
          <text fill={ink[400]} x={TABLE_X[0]} y={HEIGHT - 4}>
            AR all-reduce · AG all-gather · ring: AR sends 2(p−1)/p · n · 2 B, AG (p−1)/p · n · 2 B
          </text>
        </g>
        <g fontSize={9}>
          {chips.map((chip, i) =>
            chip === null ? null : (
              <text fill={ink[300]} key={i} textAnchor="middle" x={(xs[i] + widths[i] + xs[i + 1]) / 2} y={CY + 18}>
                {chip.when}
              </text>
            ),
          )}
        </g>
      </svg>
    </WidgetFrame>
  );
});
TensorParallel.displayName = 'TensorParallel';

export default TensorParallel;
