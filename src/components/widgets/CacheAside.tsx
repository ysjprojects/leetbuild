import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {boolParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

type Col = 'app' | 'redis' | 'origin';
type Tone = 'ok' | 'bad' | 'warn' | 'plain';

interface Arrow {
  from: Col;
  to: Col;
  label: string;
  tone: Tone;
  /** Drawn as `×N` next to the arrow when several identical requests fly together. */
  count?: number;
}

interface Frame {
  title: string;
  arrows: Arrow[];
  /** Remaining TTL in seconds; `null` = key absent. */
  ttl: number | null;
  /** Fill of the 8 request chips in the app column (stampede scenarios only). */
  chips?: string[];
  note: string;
}

const MONO = 'var(--font-code), monospace';
const WIDTH = 600;
const COL_X: Record<Col, number> = {app: 90, redis: 300, origin: 510};
const TTL_MAX = 30;
const CELL_Y = 36;
const ARROW_Y = 112;
const ARROW_GAP = 26;
const CHIPS = 8;

const TONE_FILL: Record<Tone, string> = {ok: '#34d399', bad: '#fb7185', warn: '#fbbf24', plain: '#ff7ac8'};
const CHIP_IDLE = '#2b144d';
const CHIP_WAIT = '#fbbf24';
const CHIP_LEAD = '#ff3fa6';
const CHIP_HIT = '#34d399';
const CHIP_BAD = '#fb7185';

const same = (fill: string): string[] => Array.from({length: CHIPS}, () => fill);
const leader = (rest: string): string[] => Array.from({length: CHIPS}, (_, i) => (i === 0 ? CHIP_LEAD : rest));

const a = (from: Col, to: Col, label: string, tone: Tone = 'plain', count?: number): Arrow => ({
  from,
  to,
  label,
  tone,
  count,
});
const f = (title: string, ttl: number | null, arrows: Arrow[], note: string, chips?: string[]): Frame => ({
  title,
  ttl,
  arrows,
  note,
  chips,
});

const VALUE = '{name:"Ada", plan:"pro"}';
const GET = a('app', 'redis', 'GET user:42');
const NIL = a('redis', 'app', '(nil)', 'bad');
const HIT = a('redis', 'app', VALUE, 'ok');
const QUERY = a('app', 'origin', 'SELECT … WHERE id = 42', 'warn');
const ROW = a('origin', 'app', VALUE);
const EXPIRE = a('redis', 'redis', 'expire user:42', 'bad');

const NORMAL: Frame[] = [
  f(
    'cold key',
    null,
    [GET, NIL],
    'First request: the key is not in Redis, so GET returns nil — a cache miss. The app must go to the origin.',
  ),
  f(
    'read-through to origin',
    null,
    [QUERY, ROW],
    'The origin (database or upstream service) is slow and expensive; every miss costs one of these round trips.',
  ),
  f(
    'populate with a TTL',
    30,
    [a('app', 'redis', 'SET user:42 {…} EX 30', 'ok'), a('redis', 'app', 'OK', 'ok')],
    'The app writes the value with EX 30: Redis will delete it itself after 30 s. No TTL means stale data forever.',
  ),
  f('hit', 24, [GET, HIT], 'Hit: Redis answers in well under a millisecond and the origin is not touched at all.'),
  f(
    'hit',
    12,
    [GET, HIT],
    'Still a hit. The TTL keeps counting down in the background; the app never has to invalidate anything.',
  ),
  f(
    'hit, TTL nearly out',
    3,
    [GET, HIT],
    'Last hit before expiry. Anything written to the origin in the last 27 s is invisible here — that is the staleness you bought.',
  ),
  f(
    'TTL expired',
    null,
    [EXPIRE],
    'Redis removes the key. The next reader pays for a miss and refreshes the value — cache-aside heals itself.',
  ),
  f(
    'miss again',
    null,
    [GET, NIL, a('app', 'origin', 'SELECT …', 'warn')],
    'Back to step one: miss, origin, SET EX. One origin call every 30 s per hot key is the steady state.',
  ),
];

const HERD: Frame[] = [
  f(
    'key expires under load',
    null,
    [EXPIRE],
    'A hot key expires while eight requests are in flight. Every one of them is about to miss at the same instant.',
    same(CHIP_IDLE),
  ),
  f(
    '8 concurrent misses',
    null,
    [a('app', 'redis', 'GET user:42', 'plain', 8), a('redis', 'app', '(nil)', 'bad', 8)],
    'All eight GETs return nil. None of them knows the others exist, so each concludes it must fetch from the origin.',
    same(CHIP_BAD),
  ),
  f(
    'thundering herd',
    null,
    [a('app', 'origin', 'SELECT … WHERE id = 42', 'bad', 8)],
    'Eight identical origin queries for one key. Multiply by every hot key expiring in the same second and the database falls over — exactly when the cache was supposed to protect it.',
    same(CHIP_BAD),
  ),
  f(
    '8 redundant SETs',
    30,
    [a('app', 'redis', 'SET user:42 {…} EX 30', 'warn', 8)],
    'Each request writes the same value back. Harmless in Redis, but the seven extra origin calls were pure waste.',
    same(CHIP_HIT),
  ),
];

const SINGLE_FLIGHT: Frame[] = [
  HERD[0],
  HERD[1],
  f(
    'race for the lock',
    null,
    [a('app', 'redis', 'SET lock:user:42 1 NX EX 5', 'plain', 8), a('redis', 'app', 'OK ×1, (nil) ×7', 'ok')],
    'SET NX succeeds for exactly one caller: it becomes the leader. The other seven back off and poll the key instead of hitting the origin.',
    leader(CHIP_WAIT),
  ),
  f(
    'one origin call',
    null,
    [a('app', 'origin', 'SELECT … WHERE id = 42', 'ok', 1), ROW],
    'Only the leader queries the origin. Eight misses collapsed into one fetch — that is single flight.',
    leader(CHIP_WAIT),
  ),
  f(
    'fill, release',
    30,
    [a('app', 'redis', 'SET user:42 {…} EX 30', 'ok', 1), a('app', 'redis', 'DEL lock:user:42', 'ok', 1)],
    'The leader populates the key and drops the lock. The lock has its own short TTL (EX 5) so a crashed leader cannot wedge the key forever.',
    leader(CHIP_WAIT),
  ),
  f(
    'waiters hit',
    29,
    [a('app', 'redis', 'GET user:42', 'plain', 7), a('redis', 'app', VALUE, 'ok', 7)],
    'The seven waiters retry GET and hit. Total cost of the expiry: one origin call instead of eight.',
    same(CHIP_HIT),
  ),
];

const CacheAside: FC<WidgetProps> = memo(({params}) => {
  const [stampede, setStampede] = useState(() => boolParam(params, 'stampede', false));
  const [singleFlight, setSingleFlight] = useState(false);
  const frames = stampede ? (singleFlight ? SINGLE_FLIGHT : HERD) : NORMAL;
  const playback = usePlayback(frames.length, 1400);
  const {reset} = playback;
  const frame = frames[Math.min(playback.step, frames.length - 1)];

  const onScenario = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      setStampede(e.currentTarget.value === 'stampede');
      reset();
    },
    [reset],
  );
  const onSingleFlight = useCallback(() => {
    setSingleFlight(v => !v);
    reset();
  }, [reset]);

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          <button className={tabClass(!stampede)} onClick={onScenario} type="button" value="normal">
            normal
          </button>
          <button className={tabClass(stampede)} onClick={onScenario} type="button" value="stampede">
            stampede
          </button>
          {stampede ? (
            <button
              aria-pressed={singleFlight}
              className={tabClass(singleFlight)}
              onClick={onSingleFlight}
              type="button">
              single flight
            </button>
          ) : null}
        </div>
        <PlaybackControls label="frame" playback={playback} />
      </>
    ),
    [onScenario, onSingleFlight, playback, singleFlight, stampede],
  );

  const readout = useMemo(
    () => (
      <>
        <b className="text-cream">{frame.title}.</b> {frame.note}
      </>
    ),
    [frame],
  );

  const height = ARROW_Y + Math.max(frame.arrows.length, 2) * ARROW_GAP + 8;
  const ttlW = frame.ttl === null ? 0 : (frame.ttl / TTL_MAX) * 150;
  return (
    <WidgetFrame controls={controls} readout={readout} title="cache-aside: miss, fill with TTL, hit until expiry">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>Requests between the application, Redis and the origin store</title>
        <g fontFamily={MONO} fontSize={11} fontWeight={600} textAnchor="middle">
          <text fill="#fbf6ff" x={COL_X.app} y={14}>
            App
          </text>
          <text fill="#fbf6ff" x={COL_X.redis} y={14}>
            Redis
          </text>
          <text fill="#fbf6ff" x={COL_X.origin} y={14}>
            Origin
          </text>
        </g>
        {(['app', 'redis', 'origin'] as const).map(col => (
          <line
            key={col}
            stroke="rgba(58,29,104,0.9)"
            strokeWidth={2}
            x1={COL_X[col]}
            x2={COL_X[col]}
            y1={20}
            y2={height - 4}
          />
        ))}
        <rect
          fill={frame.ttl === null ? 'rgba(58,29,104,0.5)' : '#2b144d'}
          height={40}
          rx={4}
          stroke={frame.ttl === null ? '#fb7185' : '#a78bfa'}
          strokeDasharray={frame.ttl === null ? '3 2' : undefined}
          width={160}
          x={COL_X.redis - 80}
          y={CELL_Y}
        />
        <text fill="#a78bfa" fontFamily={MONO} fontSize={9} x={COL_X.redis - 74} y={CELL_Y + 12}>
          user:42
        </text>
        <text
          fill={frame.ttl === null ? '#fb7185' : '#fbf6ff'}
          fontFamily={MONO}
          fontSize={9}
          textAnchor="end"
          x={COL_X.redis + 74}
          y={CELL_Y + 12}>
          {frame.ttl === null ? 'absent' : VALUE}
        </text>
        <rect fill="rgba(58,29,104,0.8)" height={6} rx={2} width={150} x={COL_X.redis - 75} y={CELL_Y + 20} />
        {frame.ttl === null ? null : (
          <rect
            fill={frame.ttl <= 3 ? '#fbbf24' : '#34d399'}
            height={6}
            rx={2}
            width={Math.max(2, ttlW)}
            x={COL_X.redis - 75}
            y={CELL_Y + 20}
          />
        )}
        <text fill="#d6c6f5" fontFamily={MONO} fontSize={8} x={COL_X.redis - 74} y={CELL_Y + 35}>
          {frame.ttl === null ? 'TTL —' : `TTL ${frame.ttl}s / ${TTL_MAX}s`}
        </text>
        {frame.chips === undefined ? null : (
          <g>
            {frame.chips.map((fill, i) => (
              <rect
                fill={fill}
                height={10}
                key={i}
                rx={2}
                stroke="#a78bfa"
                strokeWidth={fill === CHIP_IDLE ? 0.75 : 0}
                width={14}
                x={COL_X.app - 34 + (i % 4) * 17}
                y={CELL_Y + Math.floor(i / 4) * 14}
              />
            ))}
            <text fill="#a78bfa" fontFamily={MONO} fontSize={8} textAnchor="middle" x={COL_X.app} y={CELL_Y + 40}>
              8 requests
            </text>
          </g>
        )}
        {frame.arrows.map((arrow, i) => {
          const y = ARROW_Y + i * ARROW_GAP;
          const fill = TONE_FILL[arrow.tone];
          const x1 = COL_X[arrow.from];
          const x2 = COL_X[arrow.to];
          const label = arrow.count === undefined ? arrow.label : `${arrow.label}  ×${arrow.count}`;
          if (arrow.from === arrow.to) {
            return (
              <g key={i}>
                <path d={`M ${x1} ${y - 8} h 26 v 12 h -22`} fill="none" stroke={fill} strokeWidth={1.5} />
                <polygon fill={fill} points={`${x1},${y + 4} ${x1 + 6},${y} ${x1 + 6},${y + 8}`} />
                <text fill={fill} fontFamily={MONO} fontSize={9} x={x1 + 32} y={y + 2}>
                  {label}
                </text>
              </g>
            );
          }
          const dir = x2 > x1 ? 1 : -1;
          return (
            <g key={i}>
              <line
                stroke={fill}
                strokeWidth={arrow.count !== undefined && arrow.count > 1 ? 3 : 1.5}
                x1={x1}
                x2={x2 - dir * 4}
                y1={y}
                y2={y}
              />
              <polygon fill={fill} points={`${x2},${y} ${x2 - dir * 7},${y - 4} ${x2 - dir * 7},${y + 4}`} />
              <text fill={fill} fontFamily={MONO} fontSize={9} textAnchor="middle" x={(x1 + x2) / 2} y={y - 5}>
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
CacheAside.displayName = 'CacheAside';

export default CacheAside;
