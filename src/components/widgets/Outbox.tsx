import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MODES = ['dual write', 'transactional outbox'] as const;
type Mode = (typeof MODES)[number];
type Col = 'service' | 'db' | 'kafka';

const MONO = 'var(--font-code), monospace';
const UNCOMMITTED_TINT = alpha(iris[400], 0.25);
const CRASHED_TINT = alpha(danger[400], 0.2);
const WIDTH = 640;
const HEIGHT = 186;
const BOX_Y = 30;
const BOX_H = 110;
const COLS: Record<Col, {x: number; w: number; title: string}> = {
  service: {x: 30, w: 140, title: 'service'},
  db: {x: 240, w: 160, title: 'database'},
  kafka: {x: 470, w: 140, title: 'kafka'},
};

interface Frame {
  actor: 'order service' | 'outbox relay';
  arrow: {from: Col; to: Col; label: string} | null;
  crashed: boolean;
  /** Bracket drawn around the order and outbox rows: they are one uncommitted transaction. */
  txOpen: boolean;
  order: boolean;
  outbox: 'none' | 'unsent' | 'sent';
  events: number;
  note: string;
}

const frame = (partial: Partial<Frame> & {note: string}): Frame => ({
  actor: 'order service',
  arrow: null,
  crashed: false,
  txOpen: false,
  order: false,
  outbox: 'none',
  events: 0,
  ...partial,
});

const dualWrite = (crash: boolean, produceFirst: boolean): Frame[] => {
  if (produceFirst) {
    const sent = {events: 1};
    return [
      frame({
        arrow: {from: 'service', to: 'kafka', label: 'produce(OrderCreated #17)'},
        ...sent,
        note: 'The service publishes first: the event is in Kafka before any row exists.',
      }),
      frame({
        arrow: {from: 'kafka', to: 'service', label: 'ack'},
        ...sent,
        note: 'Kafka has the event; the database still has nothing. Consumers may already be acting on it.',
      }),
      crash
        ? frame({
            crashed: true,
            ...sent,
            note: 'Crash before the INSERT. OrderCreated #17 exists for an order that does not — a phantom event that nobody can take back.',
          })
        : frame({
            arrow: {from: 'service', to: 'db', label: 'INSERT order #17; COMMIT'},
            order: true,
            ...sent,
            note: 'Now the order is written too. It worked — but only because nothing failed in the gap.',
          }),
    ];
  }
  const stored = {order: true};
  return [
    frame({
      arrow: {from: 'service', to: 'db', label: 'BEGIN; INSERT order #17'},
      txOpen: true,
      note: 'The service opens a transaction and inserts the order.',
    }),
    frame({
      arrow: {from: 'service', to: 'db', label: 'COMMIT'},
      ...stored,
      note: 'The order is durable. The event has not been produced yet: this gap is the whole problem.',
    }),
    crash
      ? frame({
          crashed: true,
          ...stored,
          note: 'Crash in the gap. The order exists, no event was produced, and nothing will ever retry — downstream never learns about #17.',
        })
      : frame({
          arrow: {from: 'service', to: 'kafka', label: 'produce(OrderCreated #17)'},
          ...stored,
          events: 1,
          note: 'A second, independent write to a second system.',
        }),
    ...(crash
      ? []
      : [
          frame({
            arrow: {from: 'kafka', to: 'service', label: 'ack'},
            ...stored,
            events: 1,
            note: 'Both writes landed — this time. Two systems, no shared transaction: they only agree when nothing fails between them.',
          }),
        ]),
  ];
};

const outbox = (crash: boolean): Frame[] => {
  const relay = {actor: 'outbox relay' as const, order: true};
  const retry: Frame[] = crash
    ? [
        frame({
          ...relay,
          crashed: true,
          outbox: 'unsent',
          events: 1,
          note: 'Crash after the produce, before the row is marked sent. Nothing is lost: the row is still unsent in the database.',
        }),
        frame({
          ...relay,
          arrow: {from: 'db', to: 'service', label: 'SELECT … WHERE sent = false'},
          outbox: 'unsent',
          events: 1,
          note: 'The relay restarts and simply finds the row again.',
        }),
        frame({
          ...relay,
          arrow: {from: 'service', to: 'kafka', label: 'produce(OrderCreated #17)'},
          outbox: 'unsent',
          events: 2,
          note: 'Delivered twice — the outbox is at-least-once. Consumers dedupe on the event id (or the order id).',
        }),
      ]
    : [];
  return [
    frame({arrow: {from: 'service', to: 'db', label: 'BEGIN'}, txOpen: true, note: 'One transaction is opened.'}),
    frame({
      arrow: {from: 'service', to: 'db', label: 'INSERT order #17'},
      txOpen: true,
      order: true,
      note: 'The order row is written inside it.',
    }),
    frame({
      arrow: {from: 'service', to: 'db', label: 'INSERT outbox (OrderCreated #17)'},
      txOpen: true,
      order: true,
      outbox: 'unsent',
      note: 'The event is written as a row in the same database, inside the same transaction. No Kafka call here.',
    }),
    frame({
      arrow: {from: 'service', to: 'db', label: 'COMMIT'},
      order: true,
      outbox: 'unsent',
      note: 'One commit: order and outbox row are durable together or not at all. The service is done.',
    }),
    frame({
      ...relay,
      arrow: {from: 'db', to: 'service', label: 'SELECT … WHERE sent = false'},
      outbox: 'unsent',
      note: 'A relay (poller or CDC on the outbox table) reads unsent rows.',
    }),
    frame({
      ...relay,
      arrow: {from: 'service', to: 'kafka', label: 'produce(OrderCreated #17)'},
      outbox: 'unsent',
      events: 1,
      note: 'The relay produces the event.',
    }),
    ...retry,
    frame({
      ...relay,
      arrow: {from: 'kafka', to: 'service', label: 'ack'},
      outbox: 'unsent',
      events: crash ? 2 : 1,
      note: 'Only after the broker acknowledges…',
    }),
    frame({
      ...relay,
      arrow: {from: 'service', to: 'db', label: 'UPDATE outbox SET sent = true'},
      outbox: 'sent',
      events: crash ? 2 : 1,
      note: '…is the row marked sent. Every committed order eventually produces its event; a crash anywhere only delays it.',
    }),
  ];
};

/** Adjacent columns get a straight arrow above the boxes; service ↔ kafka arcs underneath the database. */
const arrowOf = (from: Col, to: Col): {d: string; lx: number; ly: number} => {
  const a = COLS[from];
  const b = COLS[to];
  const crossing = from !== 'db' && to !== 'db';
  if (crossing) {
    const x1 = from === 'service' ? a.x + a.w : a.x;
    const x2 = to === 'kafka' ? b.x : b.x + b.w;
    const y = BOX_Y + BOX_H - 10;
    return {d: `M${x1} ${y} C ${x1 + 80} ${HEIGHT}, ${x2 - 80} ${HEIGHT}, ${x2} ${y}`, lx: WIDTH / 2, ly: HEIGHT - 6};
  }
  const x1 = a.x < b.x ? a.x + a.w : a.x;
  const x2 = a.x < b.x ? b.x : b.x + b.w;
  const y = BOX_Y - 12;
  return {d: `M${x1} ${y} L${x2} ${y}`, lx: (x1 + x2) / 2, ly: y - 6};
};

const Outbox: FC<WidgetProps> = memo(() => {
  const [mode, setMode] = useState<Mode>('dual write');
  const [crash, setCrash] = useState(true);
  const [produceFirst, setProduceFirst] = useState(false);
  const frames = useMemo(
    () => (mode === 'dual write' ? dualWrite(crash, produceFirst) : outbox(crash)),
    [crash, mode, produceFirst],
  );
  const playback = usePlayback(frames.length, 1100);
  const {reset} = playback;
  const f = frames[Math.min(playback.step, frames.length - 1)];

  const onMode = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      setMode(e.currentTarget.value as Mode);
      reset();
    },
    [reset],
  );
  const toggleCrash = useCallback(() => {
    setCrash(c => !c);
    reset();
  }, [reset]);
  const toggleProduceFirst = useCallback(() => {
    setProduceFirst(p => !p);
    reset();
  }, [reset]);

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          {MODES.map(m => (
            <button className={tabClass(m === mode)} key={m} onClick={onMode} type="button" value={m}>
              {m}
            </button>
          ))}
        </div>
        <button className={tabClass(crash)} onClick={toggleCrash} type="button">
          crash between the two
        </button>
        {mode === 'dual write' ? (
          <button className={tabClass(produceFirst)} onClick={toggleProduceFirst} type="button">
            produce first
          </button>
        ) : null}
        <PlaybackControls label="frame" playback={playback} />
      </>
    ),
    [crash, mode, onMode, playback, produceFirst, toggleCrash, toggleProduceFirst],
  );

  const arrow = f.arrow === null ? null : arrowOf(f.arrow.from, f.arrow.to);
  const rowFill = (present: boolean): string => (present ? (f.txOpen ? UNCOMMITTED_TINT : iris[400]) : ink[700]);
  return (
    <WidgetFrame controls={controls} readout={f.note} title={`${mode}: service, database, kafka`}>
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`${mode}${crash ? ' with a crash' : ''}: the service, its database and the Kafka topic`}</title>
        <defs>
          <marker id="outbox-arrow" markerHeight={5} markerWidth={5} orient="auto" refX={4} refY={2.5}>
            <path d="M0,0 L5,2.5 L0,5 Z" fill={iris[300]} />
          </marker>
        </defs>
        {(Object.keys(COLS) as Col[]).map(c => {
          const col = COLS[c];
          return (
            <g key={c}>
              <rect fill={ink[800]} height={BOX_H} rx={6} stroke={ink[600]} width={col.w} x={col.x} y={BOX_Y} />
              <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={col.x + 8} y={BOX_Y + 14}>
                {col.title}
              </text>
            </g>
          );
        })}
        <rect
          fill={f.crashed ? CRASHED_TINT : ink[700]}
          height={40}
          rx={4}
          stroke={f.crashed ? danger[400] : iris[300]}
          width={COLS.service.w - 16}
          x={COLS.service.x + 8}
          y={BOX_Y + 24}
        />
        <text fill={ink[50]} fontFamily={MONO} fontSize={9} x={COLS.service.x + 16} y={BOX_Y + 40}>
          {f.actor}
        </text>
        <text
          fill={f.crashed ? danger[400] : success[400]}
          fontFamily={MONO}
          fontSize={8}
          x={COLS.service.x + 16}
          y={BOX_Y + 54}>
          {f.crashed ? 'CRASHED' : 'running'}
        </text>
        {f.txOpen ? (
          <g>
            <rect
              fill="none"
              height={mode === 'dual write' ? 30 : 58}
              rx={5}
              stroke={iris[200]}
              strokeDasharray="4 3"
              width={COLS.db.w - 12}
              x={COLS.db.x + 6}
              y={BOX_Y + 22}
            />
            <text fill={iris[200]} fontFamily={MONO} fontSize={7} x={COLS.db.x + 10} y={BOX_Y + 92}>
              one transaction, uncommitted
            </text>
          </g>
        ) : null}
        <rect fill={rowFill(f.order)} height={20} rx={3} width={COLS.db.w - 24} x={COLS.db.x + 12} y={BOX_Y + 28} />
        <text fill={f.order ? ink[50] : ink[300]} fontFamily={MONO} fontSize={8} x={COLS.db.x + 18} y={BOX_Y + 41}>
          {f.order ? 'orders: #17 (alice, 3 items)' : 'orders: —'}
        </text>
        {mode === 'transactional outbox' ? (
          <>
            <rect
              fill={rowFill(f.outbox !== 'none')}
              height={20}
              rx={3}
              width={COLS.db.w - 24}
              x={COLS.db.x + 12}
              y={BOX_Y + 54}
            />
            <text
              fill={f.outbox === 'none' ? ink[300] : ink[50]}
              fontFamily={MONO}
              fontSize={8}
              x={COLS.db.x + 18}
              y={BOX_Y + 67}>
              {f.outbox === 'none' ? 'outbox: —' : `outbox: OrderCreated #17 sent=${f.outbox === 'sent'}`}
            </text>
          </>
        ) : null}
        <text fill={ink[300]} fontFamily={MONO} fontSize={8} x={COLS.kafka.x + 8} y={BOX_Y + 34}>
          topic orders.events
        </text>
        {Array.from({length: f.events}, (_, i) => (
          <g key={i}>
            <rect
              fill={i === 0 ? iris[400] : warning[400]}
              height={20}
              rx={3}
              width={COLS.kafka.w - 24}
              x={COLS.kafka.x + 12}
              y={BOX_Y + 42 + i * 26}
            />
            <text fill={ink[950]} fontFamily={MONO} fontSize={8} x={COLS.kafka.x + 18} y={BOX_Y + 55 + i * 26}>
              @{i} OrderCreated #17{i > 0 ? ' (dup)' : ''}
            </text>
          </g>
        ))}
        {f.arrow !== null && arrow !== null ? (
          <g>
            <path d={arrow.d} fill="none" markerEnd="url(#outbox-arrow)" stroke={iris[300]} strokeWidth={1.5} />
            <text fill={ink[50]} fontFamily={MONO} fontSize={8} textAnchor="middle" x={arrow.lx} y={arrow.ly}>
              {f.arrow.label}
            </text>
          </g>
        ) : null}
        {f.crashed ? (
          <text fill={danger[400]} fontFamily={MONO} fontSize={9} textAnchor="middle" x={WIDTH / 2} y={HEIGHT - 6}>
            ✕ process died here
          </text>
        ) : null}
      </svg>
    </WidgetFrame>
  );
});
Outbox.displayName = 'Outbox';

export default Outbox;
