import {type FC, type FocusEvent, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris} from '@/styles/palette';

import WidgetFrame, {boolParam, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const TOKENS = ['the', 'cat', 'sat', 'on', 'the', 'mat', '.'] as const;
const T = TOKENS.length;
/** Word id per position: both "the" share an id, which is what the same-word head keys on. */
const WORD = [0, 1, 2, 3, 0, 4, 5] as const;
const D = 16;
const SQRT_D = Math.sqrt(D);
const HEADS = [
  {name: 'previous token', short: 'prev'},
  {name: 'first-token sink', short: 'sink'},
  {name: 'same word', short: 'same word'},
] as const;
/** Size of the planted q component per head: the sink needs a stronger pull to win against every other key. */
const SIGNAL = [12, 16, 12] as const;

const WIDTH = 600;
const LEFT = 62;
const TOP = 34;
const CELL = 34;
const GRID = T * CELL;
const BAR_X = LEFT + GRID + 92;
const BAR_W = WIDTH - BAR_X - 50;
const HEIGHT = TOP + GRID + 8;

const NOISE_FILL = alpha(iris[400], 0.08);
const ROW_FILL = alpha(iris[400], 0.12);

/** mulberry32: a fixed seed gives the same vectors on the server and in the browser. */
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

/** Standard normal from two uniforms (Box-Muller). */
const gaussian = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/**
 * Hand-made q and k per head in ℝ¹⁶ (dims 0-7 one-hot position, 8-15 one-hot word) plus seeded noise:
 * prev puts q_i on position i-1, sink puts every q on position 0, same word puts q_i on its own word.
 */
const buildHeads = (): {q: number[][]; k: number[][]}[] => {
  const rand = mulberry32(20240607);
  const noisy = (): number[] => Array.from({length: D}, () => 0.9 * gaussian(rand));
  return HEADS.map((_, h) => {
    const q = Array.from({length: T}, (_, i) => {
      const v = noisy();
      if (h === 0) v[Math.max(0, i - 1)] += SIGNAL[h];
      else if (h === 1) v[0] += SIGNAL[h];
      else v[8 + WORD[i]] += SIGNAL[h];
      return v;
    });
    const k = Array.from({length: T}, (_, j) => {
      const v = noisy().map(x => x * 0.35);
      v[j] += 1;
      v[8 + WORD[j]] += 1;
      return v;
    });
    return {q, k};
  });
};

const VECTORS = buildHeads();

/** softmax(q kᵀ / √d) row by row; masked logits are -∞, so they get exactly 0 and the rest still sums to 1. */
const attention = (head: number, causal: boolean, scaled: boolean): number[][] => {
  const {q, k} = VECTORS[head];
  return q.map((qi, i) => {
    const logits = k.map((kj, j) =>
      causal && j > i ? -Infinity : qi.reduce((s, x, d) => s + x * kj[d], 0) / (scaled ? SQRT_D : 1),
    );
    const m = Math.max(...logits);
    const e = logits.map(x => Math.exp(x - m));
    const sum = e.reduce((s, x) => s + x, 0);
    return e.map(x => x / sum);
  });
};

const AttentionHeatmap: FC<WidgetProps> = memo(({params}) => {
  const [causal, setCausal] = useState(() => boolParam(params, 'causal', true));
  const [scaled, setScaled] = useState(true);
  const [head, setHead] = useState(0);
  const [row, setRow] = useState(4);

  const toggleCausal = useCallback(() => setCausal(c => !c), []);
  const toggleScaled = useCallback(() => setScaled(s => !s), []);
  const onHead = useCallback((e: MouseEvent<HTMLButtonElement>) => setHead(Number(e.currentTarget.value)), []);
  const onRowPointer = useCallback((e: MouseEvent<SVGGElement>) => setRow(Number(e.currentTarget.dataset.row)), []);
  const onRowFocus = useCallback((e: FocusEvent<SVGGElement>) => setRow(Number(e.currentTarget.dataset.row)), []);

  const weights = useMemo(() => attention(head, causal, scaled), [causal, head, scaled]);
  const other = useMemo(() => attention(head, causal, !scaled), [causal, head, scaled]);
  const selected = weights[row];
  const argmax = selected.indexOf(Math.max(...selected));
  const otherMax = Math.max(...other[row]);
  const rowSum = selected.reduce((s, w) => s + w, 0);

  const controls = useMemo(
    () => (
      <>
        <div className="flex flex-wrap items-center gap-1">
          {HEADS.map((h, i) => (
            <button
              aria-pressed={head === i}
              className={tabClass(head === i)}
              key={h.short}
              onClick={onHead}
              type="button"
              value={i}>
              h{i} {h.short}
            </button>
          ))}
        </div>
        <button aria-pressed={causal} className={tabClass(causal)} onClick={toggleCausal} type="button">
          causal mask
        </button>
        <button aria-pressed={scaled} className={tabClass(scaled)} onClick={toggleScaled} type="button">
          ÷ √d
        </button>
      </>
    ),
    [causal, head, onHead, scaled, toggleCausal, toggleScaled],
  );

  const readout = useMemo(() => {
    const scaledMax = scaled ? selected[argmax] : otherMax;
    const rawMax = scaled ? otherMax : selected[argmax];
    const masked = causal ? T - 1 - row : 0;
    return `h${head} (${HEADS[head].name}) · query “${TOKENS[row]}” (row ${row}) puts ${selected[argmax].toFixed(
      2,
    )} on “${TOKENS[argmax]}” (key ${argmax}); its max weight is ${scaledMax.toFixed(
      3,
    )} with ÷√${D} and ${rawMax.toFixed(3)} without, since unscaled logits are ${SQRT_D}× larger. ${
      masked > 0 ? `${masked} future key${masked > 1 ? 's' : ''} masked to −∞, ` : 'No keys masked, '
    }row sum ${rowSum.toFixed(3)}.`;
  }, [argmax, causal, head, otherMax, row, rowSum, scaled, selected]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="attention weights per head">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Head ${head} attention over "${TOKENS.join(' ')}", causal mask ${causal ? 'on' : 'off'}, ${
          scaled ? 'scaled' : 'unscaled'
        }; query row ${row} selected`}</title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={LEFT} y={10}>
          softmax(q·kᵀ/√d) · d = {D} · {scaled ? `÷ ${SQRT_D}` : 'unscaled'}
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} textAnchor="end" x={LEFT - 6} y={10}>
          query i
        </text>
        {TOKENS.map((tok, j) => (
          <text
            fill={j === argmax ? iris[300] : ink[200]}
            fontFamily={MONO}
            fontSize={10}
            key={j}
            textAnchor="middle"
            x={LEFT + j * CELL + CELL / 2}
            y={TOP - 8}>
            {tok}
          </text>
        ))}
        {weights.map((r, i) => (
          <g
            aria-label={`query ${i} ${TOKENS[i]}`}
            className="cursor-pointer outline-none"
            data-row={i}
            key={i}
            onClick={onRowPointer}
            onFocus={onRowFocus}
            onMouseEnter={onRowPointer}
            role="button"
            tabIndex={0}>
            <rect
              fill={i === row ? ROW_FILL : 'transparent'}
              height={CELL}
              width={LEFT + GRID}
              x={0}
              y={TOP + i * CELL}
            />
            <text
              fill={i === row ? iris[300] : ink[200]}
              fontFamily={MONO}
              fontSize={10}
              fontWeight={i === row ? 700 : 400}
              textAnchor="end"
              x={LEFT - 6}
              y={TOP + i * CELL + CELL / 2 + 3.5}>
              {TOKENS[i]} {i}
            </text>
            {r.map((w, j) => {
              const x = LEFT + j * CELL;
              const y = TOP + i * CELL;
              const masked = causal && j > i;
              if (masked) {
                return (
                  <g key={j}>
                    <rect fill={ink[900]} height={CELL - 2} rx={2} width={CELL - 2} x={x + 1} y={y + 1} />
                    <text
                      fill={ink[500]}
                      fontFamily={MONO}
                      fontSize={9}
                      textAnchor="middle"
                      x={x + CELL / 2}
                      y={y + CELL / 2 + 3}>
                      −∞
                    </text>
                  </g>
                );
              }
              return (
                <g key={j}>
                  <rect fill={NOISE_FILL} height={CELL - 2} rx={2} width={CELL - 2} x={x + 1} y={y + 1} />
                  <rect
                    fill={iris[400]}
                    fillOpacity={Math.sqrt(w)}
                    height={CELL - 2}
                    rx={2}
                    width={CELL - 2}
                    x={x + 1}
                    y={y + 1}
                  />
                  <text
                    fill={w > 0.3 ? ink[950] : ink[200]}
                    fontFamily={MONO}
                    fontSize={9}
                    textAnchor="middle"
                    x={x + CELL / 2}
                    y={y + CELL / 2 + 3}>
                    {w >= 0.995 ? '1.0' : w.toFixed(2).replace(/^0/, '')}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
        <rect
          fill="none"
          height={CELL}
          pointerEvents="none"
          rx={3}
          stroke={iris[300]}
          strokeWidth={1.5}
          width={GRID}
          x={LEFT}
          y={TOP + row * CELL}
        />
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={BAR_X - 62} y={10}>
          row {row} “{TOKENS[row]}” → keys
        </text>
        {selected.map((w, j) => {
          const y = TOP + j * CELL;
          const masked = causal && j > row;
          return (
            <g key={j}>
              <text
                fill={masked ? ink[500] : j === argmax ? iris[300] : ink[200]}
                fontFamily={MONO}
                fontSize={10}
                textAnchor="end"
                x={BAR_X - 8}
                y={y + CELL / 2 + 3.5}>
                {TOKENS[j]} {j}
              </text>
              <rect fill={ink[800]} height={14} rx={3} width={BAR_W} x={BAR_X} y={y + CELL / 2 - 7} />
              {masked ? null : (
                <rect
                  className="transition-all duration-300"
                  fill={j === argmax ? iris[400] : alpha(iris[400], 0.55)}
                  height={14}
                  rx={3}
                  width={Math.max(1, w * BAR_W)}
                  x={BAR_X}
                  y={y + CELL / 2 - 7}
                />
              )}
              <text
                fill={masked ? ink[500] : ink[100]}
                fontFamily={MONO}
                fontSize={10}
                x={BAR_X + BAR_W + 6}
                y={y + CELL / 2 + 3.5}>
                {masked ? 'masked' : w.toFixed(3)}
              </text>
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
AttentionHeatmap.displayName = 'AttentionHeatmap';

export default AttentionHeatmap;
