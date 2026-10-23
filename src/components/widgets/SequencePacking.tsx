import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, node, success, warning} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const MODES = ['padded', 'packed'] as const;
type Mode = (typeof MODES)[number];

const MIN_LEN = 3;
const MAX_LEN = 30;
const MIN_SEQ = 32;
const MAX_SEQ = 64;

const WIDTH = 600;
const TOP = 22;
const ROW_X = 30;
const ROW_W = 300;
const ROW_H = 14;
const ROW_GAP = 3;
const PAD_X = ROW_X + ROW_W + 4;
const MASK_X = 384;
const MASK = 200;

const DOC_COLORS = [
  iris[400],
  concept.kafka,
  success[400],
  concept.http,
  concept.grpc,
  node.client,
  warning[300],
  concept.cuda,
];
const docFill = (color: string): string => alpha(color, 0.75);
const DOC_FILLS = DOC_COLORS.map(docFill);
const PAD_FILL = alpha(ink[500], 0.25);
const LEAK_FILL = alpha(danger[400], 0.22);

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

/** Document lengths in tokens, skewed short as SFT data is: MIN_LEN + u² · (MAX_LEN − MIN_LEN). */
const drawLengths = (count: number, seed: number): number[] => {
  const rand = mulberry32(seed);
  return Array.from({length: count}, () => MIN_LEN + Math.floor(rand() ** 2 * (MAX_LEN - MIN_LEN + 1)));
};

/** One row: the documents in it (indices into the lengths), in placement order. */
type Rows = number[][];

/** First-fit decreasing: longest first, each into the first row with room. */
const packRows = (lengths: number[], seqLen: number): Rows => {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[b] - lengths[a] || a - b);
  const rows: Rows = [];
  const room: number[] = [];
  for (const i of order) {
    const r = room.findIndex(free => free >= lengths[i]);
    if (r === -1) {
      rows.push([i]);
      room.push(seqLen - lengths[i]);
    } else {
      rows[r].push(i);
      room[r] -= lengths[i];
    }
  }
  return rows;
};

const padRows = (lengths: number[]): Rows => lengths.map((_, i) => [i]);

interface Segment {
  start: number;
  len: number;
  /** The document, or -1 for the padding tail. */
  doc: number;
}

const segments = (row: number[], lengths: number[], seqLen: number): Segment[] => {
  const out: Segment[] = [];
  let start = 0;
  for (const doc of row) {
    out.push({start, len: lengths[doc], doc});
    start += lengths[doc];
  }
  if (start < seqLen) out.push({start, len: seqLen - start, doc: -1});
  return out;
};

const pct = (part: number, whole: number): string => `${((100 * part) / whole).toFixed(1)} %`;

const SequencePacking: FC<WidgetProps> = memo(({params}) => {
  const docs = clamp(Math.round(numParam(params, 'docs', 10)), 4, 14);
  const initialSeq = clamp(Math.round(numParam(params, 'seqLen', 32) / 8) * 8, MIN_SEQ, MAX_SEQ);
  const [mode, setMode] = useState<Mode>('packed');
  const [seqLen, setSeqLen] = useState(initialSeq);
  const [seed, setSeed] = useState(21);
  /** The row whose mask is drawn; null until the reader picks one, then the row holding the most documents. */
  const [picked, setPicked] = useState<number | null>(null);

  const onMode = useCallback((e: MouseEvent<HTMLButtonElement>) => setMode(e.currentTarget.value as Mode), []);
  const onSeq = useCallback((e: ChangeEvent<HTMLInputElement>) => setSeqLen(Number(e.target.value)), []);
  const onRow = useCallback((e: ChangeEvent<HTMLInputElement>) => setPicked(Number(e.target.value) - 1), []);
  const onPick = useCallback((e: MouseEvent<SVGGElement>) => setPicked(Number(e.currentTarget.dataset.row)), []);
  const onResample = useCallback(() => {
    setSeed(s => s + 1);
    setPicked(null);
  }, []);

  const lengths = useMemo(() => drawLengths(docs, seed), [docs, seed]);
  const tokens = lengths.reduce((a, b) => a + b, 0);
  const packed = useMemo(() => packRows(lengths, seqLen), [lengths, seqLen]);
  const padded = useMemo(() => padRows(lengths), [lengths]);
  const rows = mode === 'packed' ? packed : padded;
  const busiest = rows.reduce((best, r, i) => (r.length > rows[best].length ? i : best), 0);
  const row = picked === null ? busiest : Math.min(picked, rows.length - 1);
  const segs = useMemo(() => segments(rows[row], lengths, seqLen), [lengths, row, rows, seqLen]);

  const slotsPacked = packed.length * seqLen;
  const slotsPadded = padded.length * seqLen;
  const padPacked = slotsPacked - tokens;
  const padPadded = slotsPadded - tokens;
  const allowed = segs.reduce((a, s) => a + (s.len * (s.len + 1)) / 2, 0);
  const causal = (seqLen * (seqLen + 1)) / 2;

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          {MODES.map(m => (
            <button
              aria-pressed={m === mode}
              className={tabClass(m === mode)}
              key={m}
              onClick={onMode}
              type="button"
              value={m}>
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">seq_len</span>
          <input
            aria-label="row length in tokens"
            className={RANGE_CLASS}
            max={MAX_SEQ}
            min={MIN_SEQ}
            onChange={onSeq}
            step={8}
            type="range"
            value={seqLen}
          />
          <span className="font-code text-ink-100 tabular-nums">{seqLen}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">mask of row</span>
          <input
            aria-label="row whose attention mask is drawn"
            className={RANGE_CLASS}
            max={rows.length}
            min={1}
            onChange={onRow}
            step={1}
            type="range"
            value={row + 1}
          />
          <span className="font-code text-ink-100 tabular-nums">{row + 1}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample lengths
        </button>
      </>
    ),
    [mode, onMode, onResample, onRow, onSeq, row, rows.length, seqLen],
  );

  const docCount = segs.filter(s => s.doc >= 0).length;
  const readout = useMemo(
    () => (
      <>
        {docs} documents, {tokens} tokens. Padded: {padded.length} rows × {seqLen} = {slotsPadded} slots,{' '}
        <b className="text-ink-100">
          {padPadded} pad ({pct(padPadded, slotsPadded)})
        </b>
        . Packed by first-fit decreasing: {packed.length} rows,{' '}
        <b className="text-ink-100">
          {padPacked} pad ({pct(padPacked, slotsPacked)})
        </b>
        . Row {row + 1} holds {docCount} document{docCount === 1 ? '' : 's'}: its mask allows {allowed} of the {causal}{' '}
        causal query-key pairs
        {causal - allowed > 0 ? `; the other ${causal - allowed} cross a segment boundary and are blocked` : ''}.
      </>
    ),
    [
      allowed,
      causal,
      docCount,
      docs,
      packed.length,
      padPacked,
      padPadded,
      padded.length,
      row,
      seqLen,
      slotsPacked,
      slotsPadded,
      tokens,
    ],
  );

  const cell = ROW_W / seqLen;
  const m = MASK / seqLen;
  const height = Math.max(TOP + docs * (ROW_H + ROW_GAP) + 16, TOP + MASK + 30);

  return (
    <WidgetFrame controls={controls} readout={readout} title="sequence packing">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>{`${docs} documents laid into rows of ${seqLen} tokens, ${mode}, and the block-diagonal causal attention mask of row ${
          row + 1
        }`}</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={ROW_X} y={12}>
            {mode} rows · {rows.length} × {seqLen} tokens
          </text>
          <text fill={ink[300]} x={PAD_X} y={12}>
            pad
          </text>
          {rows.map((r, i) => {
            const y = TOP + i * (ROW_H + ROW_GAP);
            const segsOf = segments(r, lengths, seqLen);
            const pad = segsOf.find(s => s.doc === -1)?.len ?? 0;
            return (
              <g className="cursor-pointer" data-row={i} key={i} onClick={onPick}>
                <text fill={i === row ? iris[300] : ink[300]} textAnchor="end" x={ROW_X - 4} y={y + 10}>
                  {i + 1}
                </text>
                {segsOf.map(s => (
                  <g key={s.start}>
                    <rect
                      fill={s.doc === -1 ? PAD_FILL : DOC_FILLS[s.doc % DOC_FILLS.length]}
                      height={ROW_H}
                      stroke={ink[850]}
                      strokeDasharray={s.doc === -1 ? '2 2' : undefined}
                      strokeWidth={1}
                      width={s.len * cell}
                      x={ROW_X + s.start * cell}
                      y={y}
                    />
                    {s.doc >= 0 && s.len * cell >= 16 ? (
                      <text fill={ink[900]} textAnchor="middle" x={ROW_X + (s.start + s.len / 2) * cell} y={y + 10}>
                        {s.len}
                      </text>
                    ) : null}
                  </g>
                ))}
                {i === row ? (
                  <rect
                    fill="none"
                    height={ROW_H + 2}
                    stroke={iris[300]}
                    strokeWidth={1.25}
                    width={ROW_W + 2}
                    x={ROW_X - 1}
                    y={y - 1}
                  />
                ) : null}
                <text fill={pad > 0 ? ink[200] : ink[400]} x={PAD_X} y={y + 10}>
                  {pad}
                </text>
              </g>
            );
          })}

          <text fill={ink[300]} x={MASK_X} y={12}>
            row {row + 1} mask · query ↓ key →
          </text>
          <rect fill={ink[800]} height={MASK} width={MASK} x={MASK_X} y={TOP} />
          {segs.map(s =>
            Array.from({length: s.len}, (_, k) => {
              const q = s.start + k;
              return (
                <g key={q}>
                  {s.start > 0 ? (
                    <rect fill={LEAK_FILL} height={m} width={s.start * m} x={MASK_X} y={TOP + q * m} />
                  ) : null}
                  <rect
                    fill={s.doc === -1 ? PAD_FILL : DOC_FILLS[s.doc % DOC_FILLS.length]}
                    height={m}
                    width={(k + 1) * m}
                    x={MASK_X + s.start * m}
                    y={TOP + q * m}
                  />
                </g>
              );
            }),
          )}
          {segs.slice(1).map(s => (
            <g key={s.start} stroke={ink[500]} strokeWidth={0.75}>
              <line x1={MASK_X + s.start * m} x2={MASK_X + s.start * m} y1={TOP} y2={TOP + MASK} />
              <line x1={MASK_X} x2={MASK_X + MASK} y1={TOP + s.start * m} y2={TOP + s.start * m} />
            </g>
          ))}
          <rect fill="none" height={MASK} stroke={ink[600]} width={MASK} x={MASK_X} y={TOP} />
          <rect fill={DOC_FILLS[0]} height={8} width={8} x={MASK_X} y={TOP + MASK + 8} />
          <text fill={ink[300]} x={MASK_X + 12} y={TOP + MASK + 15}>
            attends
          </text>
          <rect
            fill={LEAK_FILL}
            height={8}
            stroke={danger[400]}
            strokeWidth={0.5}
            width={8}
            x={MASK_X + 62}
            y={TOP + MASK + 8}
          />
          <text fill={ink[300]} x={MASK_X + 74} y={TOP + MASK + 15}>
            blocked (other segment)
          </text>
          <text fill={ink[400]} x={ROW_X} y={height - 4}>
            numbers = document length · dashed = padding · click a row
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
SequencePacking.displayName = 'SequencePacking';

export default SequencePacking;
