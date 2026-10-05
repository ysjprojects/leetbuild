import {type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {clamp, numParam} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const TICK_MS = 100;
const LOG_LEN = 12;

interface Outcome {
  code: 200 | 429;
  /** Seconds until one token is back, sent as `Retry-After` on a 429. */
  retryAfter: number;
}

interface State {
  tokens: number;
  /** Elapsed refill time in ticks of TICK_MS, so the clock is integer and deterministic. */
  ticks: number;
  log: Outcome[];
}

const admit = (s: State, rate: number, count: number): State => {
  let {tokens} = s;
  const log = [...s.log];
  for (let i = 0; i < count; i += 1) {
    if (tokens >= 1) {
      tokens -= 1;
      log.push({code: 200, retryAfter: 0});
    } else {
      log.push({code: 429, retryAfter: Math.ceil((1 - tokens) / rate)});
    }
  }
  return {...s, tokens, log: log.slice(-LOG_LEN)};
};

const MONO = 'var(--font-code), monospace';
const WIDTH = 520;
const HEIGHT = 200;
const BUCKET_X = 40;
const BUCKET_W = 90;
const BUCKET_TOP = 22;
const BUCKET_H = 150;
const LOG_X = 190;
const CELL = 22;

const TokenBucket: FC<WidgetProps> = memo(({params}) => {
  const rate = clamp(numParam(params, 'rate', 5), 0.1, 100);
  const burst = Math.round(clamp(numParam(params, 'burst', 10), 1, 60));
  const [state, setState] = useState<State>(() => ({tokens: burst, ticks: 0, log: []}));
  const [playing, setPlaying] = useState(true);
  const {tokens, ticks, log} = state;

  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(
      () => setState(s => ({...s, ticks: s.ticks + 1, tokens: Math.min(burst, s.tokens + (rate * TICK_MS) / 1000)})),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [burst, playing, rate]);

  const onSend = useCallback(() => setState(s => admit(s, rate, 1)), [rate]);
  const onBurst = useCallback(() => setState(s => admit(s, rate, 5)), [rate]);
  const onToggle = useCallback(() => setPlaying(p => !p), []);
  const onReset = useCallback(() => {
    setState({tokens: burst, ticks: 0, log: []});
    setPlaying(true);
  }, [burst]);

  const controls = useMemo(
    () => (
      <>
        <button className={BUTTON_CLASS} onClick={onSend} type="button">
          Send request
        </button>
        <button className={BUTTON_CLASS} onClick={onBurst} type="button">
          Burst ×5
        </button>
        <button
          aria-label={playing ? 'pause refill' : 'resume refill'}
          className={BUTTON_CLASS}
          onClick={onToggle}
          type="button">
          {playing ? '❚❚' : '▶'}
        </button>
        <button aria-label="reset" className={BUTTON_CLASS} onClick={onReset} type="button">
          ↺
        </button>
      </>
    ),
    [onBurst, onReset, onSend, onToggle, playing],
  );

  const lastOutcome = log[log.length - 1];
  const rejected = log.filter(o => o.code === 429).length;
  const readout = useMemo(
    () => (
      <>
        <b className="text-ink-100">
          {tokens.toFixed(1)}/{burst} tokens
        </b>
        , refilling {rate}/s (one token every {Math.round(1000 / rate)} ms) up to a burst of {burst}.{' '}
        {lastOutcome === undefined
          ? 'Each request takes one token; an empty bucket means 429.'
          : lastOutcome.code === 200
          ? 'Last request admitted with 200; the bucket only refills at the steady rate, so a burst empties it faster than it recovers.'
          : `Last request refused: 429 Too Many Requests with Retry-After: ${lastOutcome.retryAfter} (the deficit divided by the rate, rounded up), plus RateLimit-Limit/Remaining so a well-behaved client waits instead of retrying blind.`}
        {rejected > 0 ? ` ${rejected} of the last ${log.length} were refused.` : ''}
      </>
    ),
    [burst, lastOutcome, log.length, rate, rejected, tokens],
  );

  const cellH = BUCKET_H / burst;
  const whole = Math.floor(tokens);
  const fraction = tokens - whole;
  const seconds = (ticks * TICK_MS) / 1000;

  return (
    <WidgetFrame controls={controls} readout={readout} title="token bucket rate limiter">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>A token bucket refilling at a fixed rate, with recent requests admitted or refused</title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={BUCKET_X} y={13}>
          bucket · burst {burst}
        </text>
        <rect
          fill={ink[800]}
          height={BUCKET_H + 4}
          rx={6}
          stroke={iris[300]}
          strokeWidth={0.75}
          width={BUCKET_W + 8}
          x={BUCKET_X - 4}
          y={BUCKET_TOP - 2}
        />
        {Array.from({length: burst}, (_, i) => {
          const y = BUCKET_TOP + BUCKET_H - (i + 1) * cellH;
          const full = i < whole;
          const partial = i === whole && fraction > 0;
          return (
            <g key={i}>
              <rect fill={ink[700]} height={Math.max(1, cellH - 2)} rx={2} width={BUCKET_W} x={BUCKET_X} y={y + 1} />
              {full ? (
                <rect fill={iris[400]} height={Math.max(1, cellH - 2)} rx={2} width={BUCKET_W} x={BUCKET_X} y={y + 1} />
              ) : null}
              {partial ? (
                <rect
                  fill={iris[300]}
                  fillOpacity={0.7}
                  height={Math.max(0.5, (cellH - 2) * fraction)}
                  rx={2}
                  width={BUCKET_W}
                  x={BUCKET_X}
                  y={y + 1 + (cellH - 2) * (1 - fraction)}
                />
              ) : null}
            </g>
          );
        })}
        <text
          fill={ink[50]}
          fontFamily={MONO}
          fontSize={10}
          textAnchor="middle"
          x={BUCKET_X + BUCKET_W / 2}
          y={BUCKET_TOP + BUCKET_H + 16}>
          {tokens.toFixed(1)} tokens
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} textAnchor="end" x={BUCKET_X - 8} y={BUCKET_TOP + 8}>
          {burst}
        </text>
        <text
          fill={ink[300]}
          fontFamily={MONO}
          fontSize={9}
          textAnchor="end"
          x={BUCKET_X - 8}
          y={BUCKET_TOP + BUCKET_H}>
          0
        </text>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={LOG_X} y={13}>
            refill +{rate}/s · t={seconds.toFixed(1)}s · {playing ? 'running' : 'paused'}
          </text>
          <text fill={ink[300]} x={LOG_X} y={BUCKET_TOP + 26}>
            last {LOG_LEN} requests →
          </text>
          {Array.from({length: LOG_LEN}, (_, i) => {
            const o = log[i];
            const x = LOG_X + i * (CELL + 4);
            const y = BUCKET_TOP + 34;
            return (
              <g key={i}>
                <rect
                  fill={o === undefined ? ink[800] : o.code === 200 ? success[400] : danger[400]}
                  height={CELL}
                  rx={4}
                  stroke={o !== undefined && i === log.length - 1 ? ink[50] : 'none'}
                  strokeWidth={1}
                  width={CELL}
                  x={x}
                  y={y}
                />
                {o === undefined ? null : (
                  <text fill={ink[200]} fontSize={8} textAnchor="middle" x={x + CELL / 2} y={y + CELL + 11}>
                    {o.code}
                  </text>
                )}
              </g>
            );
          })}
          <text fill={ink[200]} x={LOG_X} y={BUCKET_TOP + 96}>
            200 → one token consumed
          </text>
          <text fill={ink[200]} x={LOG_X} y={BUCKET_TOP + 110}>
            429 → Retry-After: ceil((1 − tokens) / rate) s
          </text>
          <text fill={ink[200]} x={LOG_X} y={BUCKET_TOP + 124}>
            RateLimit-Limit: {burst} · RateLimit-Remaining: {Math.floor(tokens)}
          </text>
          <text fill={ink[300]} x={LOG_X} y={BUCKET_TOP + 144}>
            steady state ≤ {rate} req/s; a burst may spend {burst} at once
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
TokenBucket.displayName = 'TokenBucket';

export default TokenBucket;
