import {type FC, memo, useMemo} from 'react';

import type {Sequence} from '@/lib/types';

/** The runtime interaction a step implements: participants as lifelines, messages as arrows in order. */

const COLUMN = 170;
const TOP = 34;
const ROW = 34;
const MONO = 'var(--font-code), monospace';

const KIND_STYLE = {
  sync: {dash: undefined, color: '#ffb0dc', marker: 'url(#lb-seq-filled)'},
  reply: {dash: '5 4', color: '#a78bfa', marker: 'url(#lb-seq-open)'},
  async: {dash: '2 3', color: '#fbbf24', marker: 'url(#lb-seq-open)'},
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
    <div className="rounded-xl border border-plum-600/70 bg-plum-950/40 p-2">
      <svg className="w-full" role="img" style={{maxHeight: 260}} viewBox={`0 0 ${width} ${height}`}>
        <title>Sequence of calls for this step</title>
        <defs>
          <marker id="lb-seq-filled" markerHeight={7} markerWidth={8} orient="auto" refX={8} refY={3.5}>
            <path d="M0 0L8 3.5L0 7z" fill="#ffb0dc" />
          </marker>
          <marker id="lb-seq-open" markerHeight={7} markerWidth={8} orient="auto" refX={8} refY={3.5}>
            <path d="M0 0L8 3.5L0 7" fill="none" stroke="#d6c6f5" strokeWidth={1.4} />
          </marker>
        </defs>
        {sequence.participants.map(p => {
          const x = columns[p];
          return (
            <g key={p}>
              <line stroke="#3a1d68" strokeDasharray="3 3" strokeWidth={1} x1={x} x2={x} y1={TOP} y2={height - 4} />
              <rect
                fill="#2b144d"
                height={22}
                rx={6}
                stroke="#4f2a8c"
                width={COLUMN - 40}
                x={x - (COLUMN - 40) / 2}
                y={4}
              />
              <text fill="#fbf6ff" fontSize={11.5} fontWeight={700} textAnchor="middle" x={x} y={19}>
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
                  fill="#d6c6f5"
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
              <rect fill="#150826" height={13} rx={3} width={labelW} x={mid - labelW / 2} y={y - 15} />
              <text fill="#d6c6f5" fontFamily={MONO} fontSize={9.5} textAnchor="middle" x={mid} y={y - 5}>
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 px-1 text-[10px] text-plum-300">
        <span className="text-candy-200">— request</span>
        <span className="text-plum-300">- - reply</span>
        <span className="text-amber-300">· · fire-and-forget</span>
      </div>
    </div>
  );
});
SequenceDiagram.displayName = 'SequenceDiagram';

export default SequenceDiagram;
