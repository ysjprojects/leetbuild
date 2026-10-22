import {type FC, type ReactElement, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {boolParam, numParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';

/** Three requests sharing an 8-token system prompt: arrival step, prompt length, final length. */
const SEQS = [
  {name: 'A', arrive: 0, prompt: 11, final: 20},
  {name: 'B', arrive: 2, prompt: 13, final: 18},
  {name: 'C', arrive: 4, prompt: 10, final: 22},
] as const;
const PREFIX = 8;
/** The contiguous baseline reserves max_len slots per sequence up front. */
const MAX_LEN = 32;
/** The pool holds 96 token slots, cut into 96 / block_size blocks. */
const POOL_SLOTS = 96;
const SLOTS_PER_ROW = 16;
const STEPS = Math.max(...SEQS.map(s => s.arrive + s.final - s.prompt)) + 1;
const BLOCK_SIZES = [2, 4, 8] as const;

const WIDTH = 600;
const HEIGHT = 286;
const ROW_Y = 30;
const ROW_H = 58;
const LOGICAL_X = 60;
const SLOT_L = 7;
const POOL_X = 318;
const POOL_Y = 26;
const SLOT_P = 15;
const BLOCK_GAP = 3;
const POOL_ROW_H = 31;
const BAR_X = 168;
const BAR_W = 300;
const BAR_Y = 230;

const SEQ_COLORS = [concept.http, concept.kafka, success[400]];
const SHARED_COLOR = iris[400];
const WASTE_FILL = alpha(danger[400], 0.3);
const USED_FILL = alpha(iris[400], 0.55);
const SHARED_FILL = alpha(SHARED_COLOR, 0.75);
const SEQ_FILLS = [alpha(concept.http, 0.75), alpha(concept.kafka, 0.75), alpha(success[400], 0.75)];
const SHARED_TINT = alpha(SHARED_COLOR, 0.08);
const SEQ_TINTS = [alpha(concept.http, 0.08), alpha(concept.kafka, 0.08), alpha(success[400], 0.08)];

type Status = 'waiting' | 'running' | 'done';

interface Frame {
  lens: number[];
  status: Status[];
  tables: number[][];
  /** Per physical block: references, written slots, the sequence that first wrote it, whether it is a shared prefix block. */
  refs: number[];
  fill: number[];
  owner: number[];
  prefix: boolean[];
  events: string[];
}

/** Steps the three sequences through a block allocator (FIFO free list, last block freed first), as step 1 builds it. */
const simulate = (bs: number, shared: boolean): Frame[] => {
  const n = POOL_SLOTS / bs;
  const free = Array.from({length: n}, (_, i) => i);
  const refs = new Array<number>(n).fill(0);
  const fill = new Array<number>(n).fill(0);
  const owner = new Array<number>(n).fill(-1);
  const prefix = new Array<boolean>(n).fill(false);
  const lens = SEQS.map(() => 0);
  const status: Status[] = SEQS.map(() => 'waiting');
  const tables: number[][] = SEQS.map(() => []);
  let prefixBlocks: number[] = [];
  const frames: Frame[] = [];

  const allocate = (s: number): number => {
    const b = free.shift();
    if (b === undefined) throw new Error('pool exhausted');
    refs[b] = 1;
    fill[b] = 0;
    owner[b] = s;
    prefix[b] = false;
    return b;
  };
  const append = (s: number, count: number): number => {
    let fresh = 0;
    for (let i = 0; i < count; i += 1) {
      if (lens[s] % bs === 0) {
        tables[s].push(allocate(s));
        fresh += 1;
      }
      fill[tables[s][tables[s].length - 1]] += 1;
      lens[s] += 1;
    }
    return fresh;
  };

  for (let t = 0; t < STEPS; t += 1) {
    const events: string[] = [];
    SEQS.forEach((spec, s) => {
      if (status[s] !== 'running') return;
      const fresh = append(s, 1);
      if (fresh > 0)
        events.push(`${spec.name} fills its last block and takes block ${tables[s][tables[s].length - 1]}`);
    });
    SEQS.forEach((spec, s) => {
      if (spec.arrive !== t) return;
      status[s] = 'running';
      const reuse = shared && prefixBlocks.length > 0;
      if (reuse) {
        prefixBlocks.forEach(b => {
          refs[b] += 1;
        });
        tables[s] = [...prefixBlocks];
        lens[s] = PREFIX;
      }
      const fresh = append(s, spec.prompt - lens[s]);
      if (shared && !reuse) {
        prefixBlocks = tables[s].slice(0, PREFIX / bs);
        prefixBlocks.forEach(b => {
          prefix[b] = true;
        });
      }
      events.push(
        reuse
          ? `${spec.name} shares ${prefixBlocks.length} prefix blocks and prefills ${
              spec.prompt - PREFIX
            } tokens into ${fresh} new`
          : `${spec.name} prefills ${spec.prompt} tokens into ${fresh} blocks`,
      );
    });
    SEQS.forEach((spec, s) => {
      if (status[s] !== 'running' || lens[s] < spec.final) return;
      let released = 0;
      [...tables[s]].reverse().forEach(b => {
        refs[b] -= 1;
        if (refs[b] === 0) {
          free.push(b);
          fill[b] = 0;
          prefix[b] = false;
          released += 1;
        }
      });
      prefixBlocks = prefixBlocks.filter(b => refs[b] > 0);
      tables[s] = [];
      status[s] = 'done';
      events.push(`${spec.name} finishes at ${spec.final} tokens and returns ${released} blocks`);
    });
    frames.push({
      lens: [...lens],
      status: [...status],
      tables: tables.map(tb => [...tb]),
      refs: [...refs],
      fill: [...fill],
      owner: [...owner],
      prefix: [...prefix],
      events,
    });
  }
  return frames;
};

const PagedKv: FC<WidgetProps> = memo(({params}) => {
  const initialBs = numParam(params, 'blockSize', 4);
  const [bs, setBs] = useState<number>(BLOCK_SIZES.find(b => b === initialBs) ?? 4);
  const [shared, setShared] = useState(boolParam(params, 'shared', false));
  const playback = usePlayback(STEPS, 1100);

  const frames = useMemo(() => simulate(bs, shared), [bs, shared]);
  const frame = frames[Math.min(playback.step, STEPS - 1)];
  const onShared = useCallback(() => setShared(v => !v), []);
  const onBs = useCallback((b: number) => () => setBs(b), []);

  const live = frame.status.filter(s => s === 'running').length;
  const logical = frame.lens.reduce((sum, len, s) => sum + (frame.status[s] === 'running' ? len : 0), 0);
  const usedBlocks = frame.refs.filter(r => r > 0).length;
  const reserved = usedBlocks * bs;
  const stored = frame.fill.reduce((sum, f, b) => sum + (frame.refs[b] > 0 ? f : 0), 0);
  const pagedWaste = reserved - stored;
  const contiguous = live * MAX_LEN;
  const contiguousWaste = contiguous - logical;
  const saved = logical - stored;

  const controls = useMemo(
    () => (
      <>
        <PlaybackControls label="step" playback={playback} />
        <span className="text-ink-300">block size</span>
        {BLOCK_SIZES.map(b => (
          <button aria-pressed={bs === b} className={tabClass(bs === b)} key={b} onClick={onBs(b)} type="button">
            {b}
          </button>
        ))}
        <button aria-pressed={shared} className={tabClass(shared)} onClick={onShared} type="button">
          shared prefix
        </button>
      </>
    ),
    [bs, onBs, onShared, playback, shared],
  );

  const pct = (part: number, whole: number): string => (whole === 0 ? '0%' : `${Math.round((100 * part) / whole)}%`);
  const readout = useMemo(
    () =>
      `Step ${playback.step + 1}: ${
        frame.events.length > 0 ? `${frame.events.join('; ')}.` : 'every running sequence decodes one token.'
      } ${
        live === 0
          ? 'Nothing is running, so the whole pool is free.'
          : `${logical} tokens in ${usedBlocks} blocks of ${bs} (${reserved} slots, ${pagedWaste} wasted, ${pct(
              pagedWaste,
              reserved,
            )}); contiguous max_len ${MAX_LEN} reserves ${contiguous} slots and wastes ${contiguousWaste} (${pct(
              contiguousWaste,
              contiguous,
            )}).${shared && saved > 0 ? ` Sharing the ${PREFIX}-token prefix saves ${saved} slots.` : ''}`
      }`,
    [
      bs,
      contiguous,
      contiguousWaste,
      frame.events,
      live,
      logical,
      pagedWaste,
      playback.step,
      reserved,
      saved,
      shared,
      usedBlocks,
    ],
  );

  const colorOf = (b: number): string => (frame.prefix[b] ? SHARED_COLOR : SEQ_COLORS[frame.owner[b]]);
  const fillOf = (b: number): string => (frame.prefix[b] ? SHARED_FILL : SEQ_FILLS[frame.owner[b]]);
  const tintOf = (b: number): string => (frame.prefix[b] ? SHARED_TINT : SEQ_TINTS[frame.owner[b]]);

  const sequenceRow = (s: number): ReactElement => {
    const spec = SEQS[s];
    const y = ROW_Y + s * ROW_H;
    const st = frame.status[s];
    const table = frame.tables[s];
    const blockW = bs * SLOT_L;
    return (
      <g key={spec.name}>
        <text fill={SEQ_COLORS[s]} fontFamily={MONO} fontSize={11} fontWeight={700} x={4} y={y + 11}>
          {spec.name}
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={18} y={y + 11}>
          {st === 'running' ? `${frame.lens[s]} tok` : ''}
        </text>
        {st === 'running' ? (
          <>
            {table.map((b, i) => {
              const x = LOGICAL_X + i * (blockW + BLOCK_GAP);
              const used = Math.min(bs, frame.lens[s] - i * bs);
              return (
                <g key={i}>
                  <rect fill="none" height={14} rx={2} stroke={colorOf(b)} width={blockW} x={x} y={y} />
                  {Array.from({length: bs}, (_, k) => (
                    <rect
                      fill={k < used ? fillOf(b) : 'transparent'}
                      height={10}
                      key={k}
                      width={SLOT_L - 2}
                      x={x + k * SLOT_L + 1}
                      y={y + 2}
                    />
                  ))}
                  <text
                    fill={frame.prefix[b] ? iris[300] : ink[200]}
                    fontFamily={MONO}
                    fontSize={8}
                    textAnchor="middle"
                    x={x + blockW / 2}
                    y={y + 25}>
                    {b}
                  </text>
                </g>
              );
            })}
            <text fill={ink[400]} fontFamily={MONO} fontSize={8} x={4} y={y + 25}>
              table
            </text>
          </>
        ) : (
          <text fill={ink[400]} fontFamily={MONO} fontSize={9} x={LOGICAL_X} y={y + 11}>
            {st === 'waiting' ? `arrives at step ${spec.arrive + 1}` : 'finished · blocks freed'}
          </text>
        )}
      </g>
    );
  };

  const perRow = SLOTS_PER_ROW / bs;
  const blockPW = bs * SLOT_P;
  const poolBlock = (b: number): ReactElement => {
    const row = Math.floor(b / perRow);
    const col = b % perRow;
    const x = POOL_X + col * (blockPW + BLOCK_GAP);
    const y = POOL_Y + row * POOL_ROW_H;
    const busy = frame.refs[b] > 0;
    return (
      <g key={b}>
        <rect
          fill={busy ? tintOf(b) : 'transparent'}
          height={POOL_ROW_H - 4}
          rx={3}
          stroke={busy ? colorOf(b) : ink[600]}
          strokeDasharray={busy ? undefined : '2 2'}
          width={blockPW}
          x={x}
          y={y}
        />
        <text fill={busy ? ink[100] : ink[500]} fontFamily={MONO} fontSize={8} x={x + 3} y={y + 9}>
          {b}
        </text>
        {frame.refs[b] > 1 ? (
          <text fill={iris[300]} fontFamily={MONO} fontSize={8} textAnchor="end" x={x + blockPW - 3} y={y + 9}>
            ×{frame.refs[b]}
          </text>
        ) : null}
        {Array.from({length: bs}, (_, k) => (
          <rect
            fill={busy && k < frame.fill[b] ? fillOf(b) : busy ? WASTE_FILL : ink[800]}
            height={11}
            key={k}
            rx={1}
            width={SLOT_P - 3}
            x={x + k * SLOT_P + 1.5}
            y={y + 13}
          />
        ))}
      </g>
    );
  };

  const bar = (y: number, label: string, total: number, used: number): ReactElement => {
    const scale = BAR_W / POOL_SLOTS;
    return (
      <g fontFamily={MONO} fontSize={9}>
        <text fill={ink[200]} textAnchor="end" x={BAR_X - 8} y={y + 9}>
          {label}
        </text>
        <rect fill={ink[800]} height={12} rx={2} width={BAR_W} x={BAR_X} y={y} />
        <rect fill={USED_FILL} height={12} width={used * scale} x={BAR_X} y={y} />
        <rect
          fill={WASTE_FILL}
          height={12}
          stroke={total > used ? danger[400] : 'none'}
          strokeWidth={0.75}
          width={(total - used) * scale}
          x={BAR_X + used * scale}
          y={y}
        />
        <text fill={ink[100]} x={BAR_X + BAR_W + 8} y={y + 9}>
          {total} slots · {total - used} waste
        </text>
      </g>
    );
  };

  return (
    <WidgetFrame controls={controls} readout={readout} title="paged kv cache · block tables">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Step ${playback.step + 1} of ${STEPS}: logical KV blocks of three sequences mapped to ${
          POOL_SLOTS / bs
        } physical blocks of ${bs} slots`}</title>
        <g fill={ink[300]} fontFamily={MONO} fontSize={9}>
          <text x={4} y={14}>
            logical blocks · block table below
          </text>
          <text x={POOL_X} y={14}>
            physical pool · {POOL_SLOTS / bs} blocks of {bs} slots
          </text>
        </g>
        {SEQS.map((_, s) => sequenceRow(s))}
        {Array.from({length: POOL_SLOTS / bs}, (_, b) => poolBlock(b))}
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={USED_FILL} height={9} rx={2} width={12} x={4} y={BAR_Y - 22} />
          <text fill={ink[300]} x={20} y={BAR_Y - 14}>
            slots holding K/V
          </text>
          <rect
            fill={WASTE_FILL}
            height={9}
            rx={2}
            stroke={danger[400]}
            strokeWidth={0.75}
            width={12}
            x={130}
            y={BAR_Y - 22}
          />
          <text fill={ink[300]} x={146} y={BAR_Y - 14}>
            reserved, empty
          </text>
          {shared ? (
            <>
              <rect fill={SHARED_FILL} height={9} rx={2} width={12} x={250} y={BAR_Y - 22} />
              <text fill={ink[300]} x={266} y={BAR_Y - 14}>
                shared prefix block (×refs)
              </text>
            </>
          ) : null}
        </g>
        {bar(BAR_Y, 'paged', reserved, stored)}
        {bar(BAR_Y + 20, `contiguous · max_len ${MAX_LEN}`, contiguous, logical)}
        <text fill={ink[400]} fontFamily={MONO} fontSize={9} x={BAR_X} y={BAR_Y + 48}>
          bars to scale: the pool is {POOL_SLOTS} slots
        </text>
      </svg>
    </WidgetFrame>
  );
});
PagedKv.displayName = 'PagedKv';

export default PagedKv;
