import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const PALETTE = ['#ff3fa6', '#a78bfa', '#34d399', '#fbbf24', '#60a5fa', '#fb7185', '#f472b6', '#2dd4bf'];
const MAX_CONSUMERS = 8;
const WIDTH = 640;
const TOP = 22;
const ROW = 30;
const TRACK_X = 30;
const TRACK_W = 200;
const CONS_X = 430;
const CONS_W = 180;
const MAX_OFFSET = 32;
/** Head of each partition, and where the two groups have committed. Fixed so the picture is reproducible. */
const LATEST = [23, 17, 31, 12, 26, 9, 19, 14];
const COMMITTED_A = [19, 17, 25, 4, 22, 9, 11, 14];
const COMMITTED_B = [7, 3, 30, 12, 10, 2, 19, 5];

const offsetX = (offset: number): number => TRACK_X + (offset / MAX_OFFSET) * TRACK_W;

/** Fisher–Yates driven by an LCG: the same generation always yields the same membership order. */
const permutation = (n: number, seed: number): number[] => {
  const out = Array.from({length: n}, (_, i) => i);
  let s = (Math.imul(seed, 2654435761) + 1) >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** Range assignor: members sorted by id, each gets a contiguous chunk; the first `P % C` members get one extra. */
const rangeAssign = (partitions: number, members: number[]): number[] => {
  const per = Math.floor(partitions / members.length);
  const extra = partitions % members.length;
  const owner = new Array<number>(partitions).fill(-1);
  members.forEach((consumer, rank) => {
    const start = rank * per + Math.min(rank, extra);
    const count = per + (rank < extra ? 1 : 0);
    for (let p = start; p < start + count; p++) owner[p] = consumer;
  });
  return owner;
};

const ConsumerGroups: FC<WidgetProps> = memo(({params}) => {
  const partitions = clamp(Math.floor(numParam(params, 'partitions', 4)), 1, 8);
  const [consumers, setConsumers] = useState(Math.min(3, partitions + 1));
  const [generation, setGeneration] = useState(1);
  const [rebalancing, setRebalancing] = useState(false);

  const onConsumers = useCallback((e: ChangeEvent<HTMLInputElement>) => setConsumers(Number(e.target.value)), []);
  const onRebalance = useCallback(() => setRebalancing(true), []);
  useEffect(() => {
    if (!rebalancing) return undefined;
    const id = setTimeout(() => {
      setGeneration(g => g + 1);
      setRebalancing(false);
    }, 450);
    return () => clearTimeout(id);
  }, [rebalancing]);

  /** `members[rank]` is the consumer index holding that rank once member ids are sorted. */
  const members = useMemo(() => permutation(consumers, generation), [consumers, generation]);
  const memberId = useMemo(() => {
    const ids = new Array<string>(consumers).fill('');
    members.forEach((consumer, rank) => {
      ids[consumer] = `m-${String.fromCharCode(97 + rank)}`;
    });
    return ids;
  }, [consumers, members]);
  const owner = useMemo(() => rangeAssign(partitions, members), [members, partitions]);
  const owned = useMemo(
    () => Array.from({length: consumers}, (_, c) => owner.filter(o => o === c).length),
    [consumers, owner],
  );
  const idle = useMemo(() => owned.flatMap((n, c) => (n === 0 ? [c + 1] : [])), [owned]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">consumers</span>
          <input
            aria-label="consumers in group A"
            className={RANGE_CLASS}
            max={MAX_CONSUMERS}
            min={1}
            onChange={onConsumers}
            step={1}
            type="range"
            value={consumers}
          />
          <span className="font-code tabular-nums text-cream">{consumers}</span>
        </label>
        <button className={BUTTON_CLASS} disabled={rebalancing} onClick={onRebalance} type="button">
          rebalance
        </button>
      </>
    ),
    [consumers, onConsumers, onRebalance, rebalancing],
  );

  const readout = useMemo(() => {
    if (rebalancing) {
      return `Rebalance: every partition is revoked, generation ${
        generation + 1
      } recomputes the assignment from the new membership order, then consumers resume from the group's committed offsets.`;
    }
    const idleText =
      idle.length === 0
        ? ''
        : `; consumer${idle.length > 1 ? 's' : ''} ${idle.join(', ')} ${idle.length > 1 ? 'are' : 'is'} idle`;
    return `${partitions} partition${partitions > 1 ? 's' : ''} cap parallelism at ${partitions} consumer${
      partitions > 1 ? 's' : ''
    }${idleText}. Range assignor: members sorted by id (${members
      .map(c => memberId[c])
      .join(' < ')}) take contiguous chunks. Offsets are per group: group A committed p0@${
      COMMITTED_A[0]
    }, group B p0@${COMMITTED_B[0]}, latest ${LATEST[0]} — the same records, read independently.`;
  }, [generation, idle, memberId, members, partitions, rebalancing]);

  const mainRows = Math.max(partitions, consumers);
  const groupBY = TOP + mainRows * ROW + 14;
  const miniW = (WIDTH - 40) / partitions;
  return (
    <WidgetFrame controls={controls} readout={readout} title="Consumer groups: partitions → members, offsets per group">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${groupBY + 44}`}>
        <title>{`${partitions} partitions assigned to ${consumers} consumers in group A; group B reads the same topic`}</title>
        <g fill="#a78bfa" fontFamily={MONO} fontSize={9}>
          <text x={TRACK_X} y={12}>
            topic: {partitions} partitions · ▲ committed · │ latest
          </text>
          <text x={CONS_X} y={12}>
            group A · generation {generation}
          </text>
        </g>
        {owner.map((c, p) => {
          const y = TOP + p * ROW;
          const color = c < 0 ? '#5b3a8c' : PALETTE[c % PALETTE.length];
          return (
            <g key={p}>
              <text fill="#d6c6f5" fontFamily={MONO} fontSize={10} x={4} y={y + 19}>
                p{p}
              </text>
              <rect fill="rgba(58,29,104,0.5)" height={12} rx={3} width={TRACK_W} x={TRACK_X} y={y + 9} />
              <rect
                fill={color}
                fillOpacity={0.55}
                height={12}
                rx={3}
                width={offsetX(COMMITTED_A[p]) - TRACK_X}
                x={TRACK_X}
                y={y + 9}
              />
              <path d={`M${offsetX(COMMITTED_A[p])} ${y + 22} l-4 6 h8 z`} fill="#fbf6ff" />
              <text
                fill="#d6c6f5"
                fontFamily={MONO}
                fontSize={7}
                textAnchor="end"
                x={offsetX(COMMITTED_A[p]) - 2}
                y={y + 7}>
                {COMMITTED_A[p]}
              </text>
              <line
                stroke="#ffb0dc"
                strokeWidth={1.5}
                x1={offsetX(LATEST[p])}
                x2={offsetX(LATEST[p])}
                y1={y + 6}
                y2={y + 24}
              />
              <text fill="#ffb0dc" fontFamily={MONO} fontSize={7} x={offsetX(LATEST[p]) + 3} y={y + 7}>
                {LATEST[p]}
              </text>
              {c >= 0 ? (
                <path
                  className="transition-opacity duration-300"
                  d={`M${TRACK_X + TRACK_W + 6} ${y + 15} C 330 ${y + 15}, 380 ${TOP + c * ROW + 15}, ${CONS_X - 6} ${
                    TOP + c * ROW + 15
                  }`}
                  fill="none"
                  opacity={rebalancing ? 0 : 1}
                  stroke={color}
                  strokeWidth={1.5}
                />
              ) : null}
            </g>
          );
        })}
        {owned.map((n, c) => {
          const y = TOP + c * ROW;
          const isIdle = n === 0;
          const color = PALETTE[c % PALETTE.length];
          return (
            <g className="transition-opacity duration-300" key={c} opacity={rebalancing ? 0.35 : isIdle ? 0.45 : 1}>
              <rect
                fill={isIdle ? '#2b144d' : color}
                fillOpacity={isIdle ? 1 : 0.25}
                height={22}
                rx={5}
                stroke={isIdle ? '#5b3a8c' : color}
                strokeDasharray={isIdle ? '3 2' : undefined}
                strokeWidth={1}
                width={CONS_W}
                x={CONS_X}
                y={y + 4}
              />
              <text fill={isIdle ? '#a78bfa' : '#fbf6ff'} fontFamily={MONO} fontSize={9} x={CONS_X + 8} y={y + 18}>
                consumer {c + 1} · {memberId[c]}
              </text>
              <text
                fill={isIdle ? '#a78bfa' : color}
                fontFamily={MONO}
                fontSize={8}
                textAnchor="end"
                x={CONS_X + CONS_W - 8}
                y={y + 18}>
                {isIdle ? 'idle' : `${n} partition${n > 1 ? 's' : ''}`}
              </text>
            </g>
          );
        })}
        <text fill="#a78bfa" fontFamily={MONO} fontSize={9} x={TRACK_X} y={groupBY}>
          group B · 2 consumers · same topic, its own committed offsets
        </text>
        {LATEST.slice(0, partitions).map((latest, p) => {
          const x0 = 30 + p * miniW;
          const w = miniW - 8;
          const committed = x0 + (COMMITTED_B[p] / MAX_OFFSET) * w;
          const head = x0 + (latest / MAX_OFFSET) * w;
          return (
            <g key={p}>
              <text fill="#d6c6f5" fontFamily={MONO} fontSize={8} x={x0} y={groupBY + 14}>
                p{p} @{COMMITTED_B[p]}
              </text>
              <rect fill="rgba(58,29,104,0.5)" height={8} rx={2} width={w} x={x0} y={groupBY + 19} />
              <rect
                fill="#ff3fa6"
                fillOpacity={0.55}
                height={8}
                rx={2}
                width={committed - x0}
                x={x0}
                y={groupBY + 19}
              />
              <path d={`M${committed} ${groupBY + 28} l-3 5 h6 z`} fill="#fbf6ff" />
              <line stroke="#ffb0dc" strokeWidth={1.5} x1={head} x2={head} y1={groupBY + 17} y2={groupBY + 29} />
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
ConsumerGroups.displayName = 'ConsumerGroups';

export default ConsumerGroups;
