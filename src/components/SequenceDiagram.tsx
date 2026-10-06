import {type FC, memo, useMemo} from 'react';

import type {Sequence} from '@/lib/types';
import {concept, ink, iris} from '@/styles/palette';

/**
 * The runtime interaction a step implements: participants as lifelines, messages as arrows in
 * order. Labels wrap inside their column (a row grows by one line each) so a long Redis command
 * never spills over the neighbouring lifelines.
 */

const COLUMN = 170;
const TOP = 34;
const MONO = 'var(--font-code), monospace';
const FONT = 9.5;
/** Advance of one monospace glyph at FONT, and the line pitch of a wrapped label. */
const GLYPH = 5.8;
const LINE = 11;
/** Vertical room a message takes: the arrow plus its label lines. */
const ROW_BASE = 19;
/** Widest label that fits between two lifelines with a little air; a self-message label sits beside its loop. */
const MAX_CHARS = Math.floor((COLUMN - 16) / GLYPH);
const MAX_CHARS_SELF = Math.floor((COLUMN - 34 - 14) / GLYPH);

const KIND_STYLE = {
  sync: {dash: undefined, color: iris[300], marker: 'url(#lb-seq-filled)'},
  reply: {dash: '5 4', color: ink[300], marker: 'url(#lb-seq-open)'},
  async: {dash: '2 3', color: concept.kafka, marker: 'url(#lb-seq-open)'},
} as const;

/** Greedy word wrap to `max` glyphs per line; a single over-long token is cut rather than overflow. */
const wrap = (label: string, max: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of label.split(' ')) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > max) {
      lines.push(line.slice(0, max - 1) + '…');
      line = line.slice(max - 1);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
};

const SequenceDiagram: FC<{sequence: Sequence}> = memo(({sequence}) => {
  const columns = useMemo(() => {
    const map: Record<string, number> = {};
    sequence.participants.forEach((p, i) => {
      map[p] = COLUMN / 2 + i * COLUMN;
    });
    return map;
  }, [sequence.participants]);
  const width = sequence.participants.length * COLUMN;
  // Wrapped labels and the arrow baseline of every message, laid out top to bottom.
  const rows = useMemo(() => {
    let y = TOP + 12;
    return sequence.messages.map(m => {
      const lines = wrap(m.label, m.from === m.to ? MAX_CHARS_SELF : MAX_CHARS);
      y += ROW_BASE + LINE * lines.length;
      return {lines, y: y - 8};
    });
  }, [sequence.messages]);
  const height = (rows.length === 0 ? TOP + 12 : rows[rows.length - 1].y + 8) + 10;

  return (
    <div className="border-ink-700 bg-ink-850 rounded-xl border p-2">
      <svg className="w-full" role="img" style={{maxHeight: 340}} viewBox={`0 0 ${width} ${height}`}>
        <title>Sequence of calls for this step</title>
        <defs>
          <marker id="lb-seq-filled" markerHeight={7} markerWidth={8} orient="auto" refX={8} refY={3.5}>
            <path d="M0 0L8 3.5L0 7z" fill={iris[300]} />
          </marker>
          <marker id="lb-seq-open" markerHeight={7} markerWidth={8} orient="auto" refX={8} refY={3.5}>
            <path d="M0 0L8 3.5L0 7" fill="none" stroke={ink[200]} strokeWidth={1.4} />
          </marker>
        </defs>
        {sequence.participants.map(p => {
          const x = columns[p];
          return (
            <g key={p}>
              <line stroke={ink[700]} strokeDasharray="3 3" strokeWidth={1} x1={x} x2={x} y1={TOP} y2={height - 4} />
              <rect
                fill={ink[800]}
                height={22}
                rx={6}
                stroke={ink[600]}
                width={COLUMN - 40}
                x={x - (COLUMN - 40) / 2}
                y={4}
              />
              <text fill={ink[50]} fontSize={11.5} fontWeight={700} textAnchor="middle" x={x} y={19}>
                {p}
              </text>
            </g>
          );
        })}
        {sequence.messages.map((m, i) => {
          const {lines, y} = rows[i];
          const from = columns[m.from];
          const to = columns[m.to];
          const style = KIND_STYLE[m.kind ?? 'sync'];
          const labelW = Math.max(...lines.map(l => l.length)) * GLYPH + 8;
          const labelH = LINE * lines.length;
          if (from === to) {
            // Self message: a small loop beside the lifeline, the label on the side with room for it.
            const left = from + 34 + labelW > width;
            const s = left ? -1 : 1;
            const tx = left ? from - 34 : from + 34;
            return (
              <g key={i}>
                <path
                  d={`M${from} ${y - 8} h${28 * s} v14 h${-24 * s}`}
                  fill="none"
                  markerEnd={style.marker}
                  stroke={style.color}
                  strokeDasharray={style.dash}
                  strokeWidth={1.4}
                />
                <text
                  fill={ink[200]}
                  fontFamily={MONO}
                  fontSize={FONT}
                  textAnchor={left ? 'end' : 'start'}
                  x={tx}
                  y={y + 2 - (labelH - LINE) / 2}>
                  {lines.map((line, k) => (
                    <tspan dy={k === 0 ? 0 : LINE} key={k} x={tx}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          }
          const dir = to > from ? 1 : -1;
          const x1 = from;
          const x2 = to - dir * 2;
          const mid = (x1 + x2) / 2;
          return (
            <g key={i}>
              <line
                markerEnd={style.marker}
                stroke={style.color}
                strokeDasharray={style.dash}
                strokeWidth={1.4}
                x1={x1}
                x2={x2}
                y1={y}
                y2={y}
              />
              <rect fill={ink[850]} height={labelH + 2} rx={3} width={labelW} x={mid - labelW / 2} y={y - 4 - labelH} />
              <text
                fill={ink[200]}
                fontFamily={MONO}
                fontSize={FONT}
                textAnchor="middle"
                x={mid}
                y={y - 5 - (labelH - LINE)}>
                {lines.map((line, k) => (
                  <tspan dy={k === 0 ? 0 : LINE} key={k} x={mid}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="text-ink-300 mt-1 flex flex-wrap gap-x-3 px-1 text-[10px]">
        <span className="text-iris-300">— request</span>
        <span className="text-ink-300">- - reply</span>
        <span className="text-concept-kafka">· · fire-and-forget</span>
      </div>
    </div>
  );
});
SequenceDiagram.displayName = 'SequenceDiagram';

export default SequenceDiagram;
