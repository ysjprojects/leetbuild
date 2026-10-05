import {type FC, memo, useMemo} from 'react';

import type {Sequence} from '@/lib/types';
import {concept, ink, iris} from '@/styles/palette';

/** The runtime interaction a step implements: participants as lifelines, messages as arrows in order. */

const COLUMN = 170;
const TOP = 34;
const ROW = 34;
const MONO = 'var(--font-code), monospace';

const KIND_STYLE = {
  sync: {dash: undefined, color: iris[300], marker: 'url(#lb-seq-filled)'},
  reply: {dash: '5 4', color: ink[300], marker: 'url(#lb-seq-open)'},
  async: {dash: '2 3', color: concept.kafka, marker: 'url(#lb-seq-open)'},
} as const;

const SequenceDiagram: FC<{sequence: Sequence}> = memo(({sequence}) => {
  const columns = useMemo(() => {
    const map: Record<string, number> = {};
    sequence.participants.forEach((p, i) => {
      map[p] = COLUMN / 2 + i * COLUMN;
    });
    return map;
  }, [sequence.participants]);
  const width = sequence.participants.length * COLUMN;
  const height = TOP + 12 + sequence.messages.length * ROW + 10;

  return (
    <div className="border-ink-700 bg-ink-850 rounded-xl border p-2">
      <svg className="w-full" role="img" style={{maxHeight: 260}} viewBox={`0 0 ${width} ${height}`}>
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
          const y = TOP + 22 + i * ROW;
          const from = columns[m.from];
          const to = columns[m.to];
          const style = KIND_STYLE[m.kind ?? 'sync'];
          const labelW = m.label.length * 5.8 + 8;
          if (from === to) {
            // Self message: a small loop beside the lifeline, on the side with room for the label.
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
                  fontSize={9.5}
                  textAnchor={left ? 'end' : 'start'}
                  x={tx}
                  y={y + 2}>
                  {m.label}
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
              <rect fill={ink[850]} height={13} rx={3} width={labelW} x={mid - labelW / 2} y={y - 15} />
              <text fill={ink[200]} fontFamily={MONO} fontSize={9.5} textAnchor="middle" x={mid} y={y - 5}>
                {m.label}
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
