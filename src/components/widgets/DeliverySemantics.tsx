import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MODES = ['at-most-once', 'at-least-once', 'effectively-once'] as const;
type Mode = (typeof MODES)[number];

const MONO = 'var(--font-code), monospace';
const RECORDS = 4;
const CRASH_AT = 2;
const WIDTH = 640;
const LOG_X = 120;
const LOG_W = 56;
const EV_X = 30;
const EV_W = 47;

type Kind = 'commit' | 'process' | 'crash' | 'restart' | 'skip';
interface ConsumerEvent {
  kind: Kind;
  record: number;
}

const ORDER: Record<Mode, string> = {
  'at-most-once': 'commit the offset, then process',
  'at-least-once': 'process, then commit the offset',
  'effectively-once': 'process idempotently (dedupe on the record key), then commit',
};

const COLOR: Record<Kind, string> = {
  commit: '#a78bfa',
  process: '#34d399',
  crash: '#fb7185',
  restart: '#fbbf24',
  skip: '#d6c6f5',
};

const LABEL: Record<Kind, (r: number) => string> = {
  commit: r => `commit→${r + 1}`,
  process: r => `process ${r}`,
  crash: () => 'crash',
  restart: r => `restart@${r}`,
  skip: r => `skip ${r}`,
};

/** The consumer's event log for records 0..3; a crash lands between the two steps of record `CRASH_AT`. */
const eventsOf = (mode: Mode, crash: boolean): ConsumerEvent[] => {
  const first: Kind = mode === 'at-most-once' ? 'commit' : 'process';
  const second: Kind = mode === 'at-most-once' ? 'process' : 'commit';
  const out: ConsumerEvent[] = [];
  for (let r = 0; r < RECORDS; r++) {
    out.push({kind: first, record: r});
    if (crash && r === CRASH_AT) {
      out.push({kind: 'crash', record: r});
      if (mode === 'at-most-once') {
        out.push({kind: 'restart', record: r + 1});
        continue;
      }
      out.push({kind: 'restart', record: r});
      out.push({kind: mode === 'effectively-once' ? 'skip' : 'process', record: r});
    }
    out.push({kind: second, record: r});
  }
  return out;
};

const DeliverySemantics: FC<WidgetProps> = memo(() => {
  const [mode, setMode] = useState<Mode>('at-least-once');
  const [crash, setCrash] = useState(true);
  const events = useMemo(() => eventsOf(mode, crash), [crash, mode]);
  const playback = usePlayback(events.length, 650);
  const {reset} = playback;
  const step = Math.min(playback.step, events.length - 1);

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

  const state = useMemo(() => {
    const seen = events.slice(0, step + 1);
    const processed = new Array<number>(RECORDS).fill(0);
    let committed = 0;
    let crashed = false;
    let restartAt = -1;
    for (const ev of seen) {
      if (ev.kind === 'process') processed[ev.record] += 1;
      if (ev.kind === 'commit') committed = ev.record + 1;
      if (ev.kind === 'crash') crashed = true;
      if (ev.kind === 'restart') {
        crashed = false;
        restartAt = ev.record;
      }
    }
    return {committed, crashed, processed, restartAt, restarted: restartAt >= 0};
  }, [events, step]);

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
          crash after record {CRASH_AT}
        </button>
        <PlaybackControls label="event" playback={playback} />
      </>
    ),
    [crash, mode, onMode, playback, toggleCrash],
  );

  const readout = useMemo(() => {
    const guarantee = (
      <>
        <b className="text-cream">{mode}</b>: {ORDER[mode]}.{' '}
      </>
    );
    if (!crash)
      return (
        <>
          {guarantee}Without a failure all three process every record exactly once; the modes only differ in what a
          crash between the two steps costs.
        </>
      );
    if (state.crashed)
      return (
        <>
          {guarantee}Crashed between the two steps of record {CRASH_AT}. What the restart does depends on whether the
          offset was already committed.
        </>
      );
    if (!state.restarted)
      return (
        <>
          {guarantee}Play on: the consumer will crash between the two steps of record {CRASH_AT}.
        </>
      );
    const outcome: Record<Mode, string> = {
      'at-most-once': `Offset ${
        CRASH_AT + 1
      } was committed before the crash, so the restarted consumer starts at record ${
        CRASH_AT + 1
      } — record ${CRASH_AT} is lost, never processed.`,
      'at-least-once': `The crash hit after processing record ${CRASH_AT} but before committing, so the restarted consumer re-reads it — record ${CRASH_AT} is processed twice; downstream must tolerate duplicates.`,
      'effectively-once': `The restarted consumer re-reads record ${CRASH_AT}, but its key is already in the dedupe store, so the redo is skipped — delivered twice, its effect applied once.`,
    };
    return (
      <>
        {guarantee}
        {outcome[mode]}
      </>
    );
  }, [crash, mode, state.crashed, state.restarted]);

  const lost = (r: number): boolean => state.restarted && r < state.restartAt && state.processed[r] === 0;
  const cellFill = (r: number): string => {
    const n = state.processed[r];
    if (n >= 2) return '#fbbf24';
    if (n === 1) return '#34d399';
    if (lost(r)) return '#fb7185';
    return '#2b144d';
  };
  const cellNote = (r: number): string => {
    const n = state.processed[r];
    if (n >= 2) return `×${n} dup`;
    if (n === 1) return 'done';
    if (lost(r)) return 'lost';
    return '';
  };
  const effects = state.processed.flatMap((n, r) => Array.from({length: n}, () => r));

  return (
    <WidgetFrame
      controls={controls}
      readout={readout}
      title="Delivery semantics: where the commit sits relative to processing">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} 150`}>
        <title>{`${mode}: consumer events for records 0..${RECORDS - 1}${crash ? ' with a crash' : ''}`}</title>
        <g fill="#a78bfa" fontFamily={MONO} fontSize={9}>
          <text x={EV_X} y={24}>
            partition
          </text>
          <text x={EV_X} y={78}>
            consumer
          </text>
          <text x={EV_X} y={128}>
            side effects
          </text>
        </g>
        {state.processed.map((_, r) => {
          const x = LOG_X + r * (LOG_W + 8);
          return (
            <g key={r}>
              <rect fill={cellFill(r)} height={24} rx={4} width={LOG_W} x={x} y={10} />
              <text
                fill={cellFill(r) === '#2b144d' ? '#d6c6f5' : '#1a0b33'}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="middle"
                x={x + LOG_W / 2}
                y={21}>
                rec {r}
              </text>
              <text
                fill={cellFill(r) === '#2b144d' ? '#a78bfa' : '#1a0b33'}
                fontFamily={MONO}
                fontSize={7}
                textAnchor="middle"
                x={x + LOG_W / 2}
                y={30}>
                {cellNote(r)}
              </text>
            </g>
          );
        })}
        <path d={`M${LOG_X + state.committed * (LOG_W + 8) - 4} 44 l-4 -7 h8 z`} fill="#fbf6ff" />
        <text fill="#d6c6f5" fontFamily={MONO} fontSize={8} x={LOG_X + state.committed * (LOG_W + 8) + 4} y={44}>
          committed offset = {state.committed}
        </text>
        <text
          fill={state.crashed ? '#fb7185' : '#d6c6f5'}
          fontFamily={MONO}
          fontSize={8}
          textAnchor="end"
          x={WIDTH - 10}
          y={21}>
          {state.crashed
            ? 'consumer: CRASHED'
            : state.restarted
            ? 'consumer: restarted from committed offset'
            : 'consumer: running'}
        </text>
        {events.map((ev, i) => {
          const x = EV_X + 90 + i * EV_W;
          const isNow = i === step;
          return (
            <g key={i} opacity={i <= step ? 1 : 0.25}>
              <rect
                fill={COLOR[ev.kind]}
                fillOpacity={ev.kind === 'crash' ? 1 : 0.85}
                height={22}
                rx={3}
                stroke={isNow ? '#fbf6ff' : 'none'}
                strokeWidth={1.5}
                width={EV_W - 4}
                x={x}
                y={62}
              />
              <text
                fill="#1a0b33"
                fontFamily={MONO}
                fontSize={7.5}
                fontWeight={isNow ? 700 : 400}
                textAnchor="middle"
                x={x + (EV_W - 4) / 2}
                y={76}>
                {LABEL[ev.kind](ev.record)}
              </text>
            </g>
          );
        })}
        <text fill="#fbf6ff" fontFamily={MONO} fontSize={9} x={LOG_X} y={128}>
          applied: [{effects.join(', ')}]
          {mode === 'effectively-once'
            ? `   dedupe store: {${state.processed.flatMap((n, r) => (n > 0 ? [r] : [])).join(', ')}}`
            : ''}
        </text>
        <text fill="#a78bfa" fontFamily={MONO} fontSize={8} x={LOG_X} y={142}>
          {mode === 'at-most-once'
            ? 'a record is safe to drop: metrics, presence pings'
            : mode === 'at-least-once'
            ? 'a duplicate must be harmless or handled: idempotent upserts, dedupe by key'
            : 'the dedupe store must be updated in the same transaction as the effect'}
        </text>
      </svg>
    </WidgetFrame>
  );
});
DeliverySemantics.displayName = 'DeliverySemantics';

export default DeliverySemantics;
