import {type FC, memo, useCallback, useMemo, useState} from 'react';

import {danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

/** Ticks a request spends in `processing` before its response is stored; the clock is the button counter, not wall time. */
const PROCESS_TICKS = 2;
const MAX_KEYS = 4;

interface Entry {
  key: string;
  orderId: string;
  startedAt: number;
}

type Outcome = 'created' | 'in-flight' | 'replayed';

interface LogEntry {
  tick: number;
  key: string;
  outcome: Outcome;
}

interface State {
  tick: number;
  entries: Entry[];
  log: LogEntry[];
  /** Last thing that happened, for the readout: a request outcome or a bare clock advance. */
  last: Outcome | 'tick' | null;
}

const INITIAL: State = {tick: 0, entries: [], log: [], last: null};

const isDone = (e: Entry, tick: number): boolean => tick - e.startedAt >= PROCESS_TICKS;

const send = (s: State, key: string): State => {
  const tick = s.tick + 1;
  const entry = s.entries.find(e => e.key === key);
  if (entry === undefined) {
    const created: Entry = {key, orderId: `ord_${101 + s.entries.length}`, startedAt: tick};
    return {tick, entries: [...s.entries, created], log: [...s.log, {tick, key, outcome: 'created'}], last: 'created'};
  }
  const outcome: Outcome = isDone(entry, tick) ? 'replayed' : 'in-flight';
  return {...s, tick, log: [...s.log, {tick, key, outcome}], last: outcome};
};

const CODE: Record<Outcome, string> = {
  created: '201 Created',
  'in-flight': '409 Conflict',
  replayed: '201 Created (replay)',
};
const COLOR: Record<Outcome, string> = {created: success[400], 'in-flight': danger[400], replayed: iris[300]};

const MONO = 'var(--font-code), monospace';
const WIDTH = 620;
const TABLE_X = 4;
const TABLE_W = 300;
const TL_X = 322;
const TL_W = 290;
const ROW_H = 20;
const TOP = 30;
const LOG_ROWS = 5;
const LOG_Y = TOP + MAX_KEYS * ROW_H + 26;
const HEIGHT = LOG_Y + LOG_ROWS * 14 + 6;

const Idempotency: FC<WidgetProps> = memo(() => {
  const [state, setState] = useState<State>(INITIAL);
  const {tick, entries, log, last} = state;
  const hasK1 = entries.some(e => e.key === 'K1');
  const nextKey = `K${entries.length + 1}`;

  const onSendK1 = useCallback(() => setState(s => send(s, 'K1')), []);
  const onSendNew = useCallback(() => setState(s => send(s, `K${s.entries.length + 1}`)), []);
  const onTick = useCallback(() => setState(s => ({...s, tick: s.tick + 1, last: 'tick'})), []);
  const onReset = useCallback(() => setState(INITIAL), []);

  const controls = useMemo(
    () => (
      <>
        <button className={BUTTON_CLASS} onClick={onSendK1} type="button">
          {hasK1 ? 'Send again with K1' : 'Send with key K1'}
        </button>
        <button
          className={`${BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-40`}
          disabled={!hasK1 || entries.length >= MAX_KEYS}
          onClick={onSendNew}
          type="button">
          Send with new key {hasK1 && entries.length < MAX_KEYS ? nextKey : ''}
        </button>
        <button className={BUTTON_CLASS} onClick={onTick} type="button">
          Advance clock
        </button>
        <button className={BUTTON_CLASS} onClick={onReset} type="button">
          ↺
        </button>
      </>
    ),
    [entries.length, hasK1, nextKey, onReset, onSendK1, onSendNew, onTick],
  );

  const readout = useMemo(() => {
    const lastLog = log[log.length - 1];
    if (last === null || lastLog === undefined) {
      return 'Every POST /orders carries an Idempotency-Key. Send one with K1, then send the exact same request again and watch what the key store makes the server answer.';
    }
    const entry = entries.find(e => e.key === lastLog.key);
    const done = entry !== undefined && isDone(entry, tick);
    switch (last) {
      case 'created':
        return `t=${tick}: ${lastLog.key} is new, so the server reserved it (SET NX status=processing), ran the handler and created ${entry?.orderId}. The 201 body is stored under the key once processing finishes (${PROCESS_TICKS} ticks).`;
      case 'in-flight':
        return `t=${tick}: ${lastLog.key} is still processing, so the server answers 409 Conflict without touching the handler: running it twice would create two orders. The client should wait and retry with the same key.`;
      case 'replayed':
        return `t=${tick}: ${lastLog.key} is complete, so the stored 201 body for ${entry?.orderId} is replayed byte-for-byte and no handler runs. A retry after a lost response is now safe.`;
      default:
        return `t=${tick}: clock advanced. ${lastLog.key} is ${
          done ? 'done: its next duplicate will be replayed.' : 'still processing: its next duplicate still gets 409.'
        }`;
    }
  }, [entries, last, log, tick]);

  const span = Math.max(8, tick + 1);
  const tickX = (t: number): number => TL_X + 40 + (t / span) * (TL_W - 48);
  const recent = log.slice(-LOG_ROWS);

  return (
    <WidgetFrame controls={controls} readout={readout} title="idempotency keys">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>Idempotency key store, processing timeline and the responses each duplicate request receives</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={TABLE_X} y={12}>
            key store · idem:&#123;key&#125;
          </text>
          <text fill={ink[300]} x={TABLE_X + 4} y={TOP - 6}>
            key
          </text>
          <text fill={ink[300]} x={TABLE_X + 60} y={TOP - 6}>
            status
          </text>
          <text fill={ink[300]} x={TABLE_X + 150} y={TOP - 6}>
            stored response
          </text>
          <text fill={ink[300]} x={TL_X} y={12}>
            processing window · t={tick}
          </text>
        </g>
        {Array.from({length: MAX_KEYS}, (_, i) => {
          const y = TOP + i * ROW_H;
          const e = entries[i];
          const done = e !== undefined && isDone(e, tick);
          return (
            <g fontFamily={MONO} fontSize={10} key={i}>
              <rect
                fill={e === undefined ? ink[800] : ink[700]}
                height={ROW_H - 3}
                rx={4}
                width={TABLE_W}
                x={TABLE_X}
                y={y}
              />
              {e === undefined ? null : (
                <>
                  <text fill={ink[50]} x={TABLE_X + 4} y={y + 12}>
                    {e.key}
                  </text>
                  <text fill={done ? success[400] : warning[400]} x={TABLE_X + 60} y={y + 12}>
                    {done ? 'done' : 'processing'}
                  </text>
                  <text fill={done ? ink[200] : ink[300]} x={TABLE_X + 150} y={y + 12}>
                    {done ? `201 {"id":"${e.orderId}"}` : '—'}
                  </text>
                </>
              )}
            </g>
          );
        })}
        <g fontFamily={MONO} fontSize={8}>
          {Array.from({length: span + 1}, (_, t) => (
            <text fill={t === tick ? ink[50] : ink[300]} key={t} textAnchor="middle" x={tickX(t)} y={TOP - 6}>
              {t}
            </text>
          ))}
          <line
            stroke={iris[400]}
            strokeDasharray="2 2"
            x1={tickX(tick)}
            x2={tickX(tick)}
            y1={TOP - 2}
            y2={TOP + MAX_KEYS * ROW_H - 4}
          />
          {Array.from({length: MAX_KEYS}, (_, i) => {
            const y = TOP + i * ROW_H;
            const e = entries[i];
            return (
              <g key={i}>
                <line stroke={ink[700]} x1={TL_X + 40} x2={TL_X + TL_W - 8} y1={y + 9} y2={y + 9} />
                {e === undefined ? null : (
                  <>
                    <text fill={ink[200]} x={TL_X + 8} y={y + 12}>
                      {e.key}
                    </text>
                    <rect
                      fill={warning[400]}
                      fillOpacity={0.8}
                      height={6}
                      rx={2}
                      width={tickX(Math.min(tick, e.startedAt + PROCESS_TICKS)) - tickX(e.startedAt)}
                      x={tickX(e.startedAt)}
                      y={y + 6}
                    />
                    {tick > e.startedAt + PROCESS_TICKS ? (
                      <rect
                        fill={success[400]}
                        fillOpacity={0.6}
                        height={6}
                        rx={2}
                        width={tickX(tick) - tickX(e.startedAt + PROCESS_TICKS)}
                        x={tickX(e.startedAt + PROCESS_TICKS)}
                        y={y + 6}
                      />
                    ) : null}
                  </>
                )}
              </g>
            );
          })}
          {log.map(l => {
            const lane = entries.findIndex(e => e.key === l.key);
            return (
              <circle
                cx={tickX(l.tick)}
                cy={TOP + lane * ROW_H + 9}
                fill={COLOR[l.outcome]}
                key={`${l.tick}-${l.key}`}
                r={3.5}
                stroke={ink[700]}
                strokeWidth={1}
              />
            );
          })}
        </g>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={TABLE_X} y={LOG_Y - 6}>
            responses (last {LOG_ROWS})
          </text>
          {recent.map((l, i) => (
            <text
              fill={i === recent.length - 1 ? ink[50] : ink[200]}
              key={`${l.tick}-${l.key}`}
              x={TABLE_X}
              y={LOG_Y + 8 + i * 14}>
              <tspan fill={ink[300]}>t={l.tick}</tspan>
              {'  POST /orders  Idempotency-Key: '}
              {l.key}
              {'  → '}
              <tspan fill={COLOR[l.outcome]}>{CODE[l.outcome]}</tspan>
            </text>
          ))}
        </g>
      </svg>
    </WidgetFrame>
  );
});
Idempotency.displayName = 'Idempotency';

export default Idempotency;
