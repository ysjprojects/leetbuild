import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {concept, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MODES = ['unary', 'server', 'client', 'bidi'] as const;
type Mode = (typeof MODES)[number];

type FrameKind = 'HEADERS' | 'DATA' | 'TRAILERS';

interface Frame {
  from: 'client' | 'server';
  kind: FrameKind;
  label: string;
}

const MONO = 'var(--font-code), monospace';
const CLIENT_X = 120;
const SERVER_X = 460;
const WIDTH = 580;
const TOP = 34;
const ROW = 22;

const KIND_FILL: Record<FrameKind, string> = {HEADERS: concept.grpc, DATA: iris[400], TRAILERS: success[400]};

const c = (kind: FrameKind, label: string): Frame => ({from: 'client', kind, label});
const s = (kind: FrameKind, label: string): Frame => ({from: 'server', kind, label});
const REQ_HEADERS = c('HEADERS', 'POST /orders.Orders/Get');
const RESP_HEADERS = s('HEADERS', '200 · application/grpc');
const TRAILERS = s('TRAILERS', 'grpc-status: 0 (OK)');

const FRAMES: Record<Mode, Frame[]> = {
  unary: [REQ_HEADERS, c('DATA', 'GetOrderRequest  END_STREAM'), RESP_HEADERS, s('DATA', 'Order'), TRAILERS],
  server: [
    REQ_HEADERS,
    c('DATA', 'WatchOrderRequest  END_STREAM'),
    RESP_HEADERS,
    s('DATA', 'OrderEvent #1'),
    s('DATA', 'OrderEvent #2'),
    s('DATA', 'OrderEvent #3'),
    TRAILERS,
  ],
  client: [
    REQ_HEADERS,
    c('DATA', 'OrderLine #1'),
    c('DATA', 'OrderLine #2'),
    c('DATA', 'OrderLine #3  END_STREAM'),
    RESP_HEADERS,
    s('DATA', 'OrderSummary'),
    TRAILERS,
  ],
  bidi: [
    REQ_HEADERS,
    c('DATA', 'Quote #1'),
    RESP_HEADERS,
    s('DATA', 'Ack #1'),
    c('DATA', 'Quote #2'),
    s('DATA', 'Ack #2'),
    c('DATA', 'Quote #3  END_STREAM'),
    s('DATA', 'Ack #3'),
    TRAILERS,
  ],
};

const TITLE: Record<Mode, string> = {
  unary: 'unary — one request, one response',
  server: 'server streaming — one request, N responses',
  client: 'client streaming — N requests, one response',
  bidi: 'bidirectional — both sides stream independently',
};

const USE: Record<Mode, string> = {
  unary: 'the default: anything that looks like a function call (fetch, create, update).',
  server: 'feeds and watches: the client asks once and the server pushes events until it closes the stream.',
  client: 'uploads and batches: the client pushes many messages and gets one summary back.',
  bidi: 'chat, subscriptions with live filters, anything where both sides talk whenever they want; messages are only ordered within one direction.',
};

const GrpcStreams: FC<WidgetProps> = memo(({params}) => {
  const [mode, setMode] = useState<Mode>(() => stringParam(params, 'mode', MODES, 'unary'));
  const frames = FRAMES[mode];
  const playback = usePlayback(frames.length, 800);
  const current = Math.min(playback.step, frames.length - 1);
  const {reset} = playback;
  const onMode = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      setMode(e.currentTarget.value as Mode);
      reset();
    },
    [reset],
  );

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
        <PlaybackControls label="frame" playback={playback} />
      </>
    ),
    [mode, onMode, playback],
  );

  const readout = useMemo(() => {
    const frame = frames[current];
    const dataSent = frames.slice(0, current).filter(f => f.kind === 'DATA' && f.from === 'server').length;
    return (
      <>
        <b className="text-ink-100">{TITLE[mode]}</b> — use it for {USE[mode]}{' '}
        {frame.kind === 'TRAILERS' ? (
          <>
            The status only arrives now, in the <b className="text-ink-100">trailers</b>: the server already sent{' '}
            {dataSent} DATA frame{dataSent === 1 ? '' : 's'}, so a stream can still end in UNAVAILABLE after you
            consumed messages — client code must handle an error after data.
          </>
        ) : (
          <>
            Frame {current + 1}/{frames.length}: {frame.kind} from the {frame.from}. No status yet — that comes in the
            trailers at the end of the same HTTP/2 stream.
          </>
        )}
      </>
    );
  }, [current, frames, mode]);

  const height = TOP + frames.length * ROW + 16;
  return (
    <WidgetFrame controls={controls} readout={readout} title="gRPC call types: frames on one HTTP/2 stream">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>Frames exchanged between client and server for one gRPC call</title>
        <g fontFamily={MONO} fontSize={11} textAnchor="middle">
          <text fill={ink[50]} fontWeight={600} x={CLIENT_X} y={14}>
            Client
          </text>
          <text fill={ink[50]} fontWeight={600} x={SERVER_X} y={14}>
            Server
          </text>
        </g>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} textAnchor="middle" x={(CLIENT_X + SERVER_X) / 2} y={14}>
          HTTP/2 stream id 1
        </text>
        <line stroke={ink[700]} strokeWidth={2} x1={CLIENT_X} x2={CLIENT_X} y1={20} y2={height - 8} />
        <line stroke={ink[700]} strokeWidth={2} x1={SERVER_X} x2={SERVER_X} y1={20} y2={height - 8} />
        {frames.map((frame, i) => {
          const y = TOP + i * ROW;
          const shown = i <= current;
          const isNow = i === current;
          const fill = KIND_FILL[frame.kind];
          const toRight = frame.from === 'client';
          const x1 = toRight ? CLIENT_X : SERVER_X;
          const x2 = toRight ? SERVER_X : CLIENT_X;
          const head = toRight ? x2 - 6 : x2 + 6;
          const badgeX = toRight ? x1 + 8 : x1 - 62;
          return (
            <g key={`${frame.from}-${i}`} opacity={shown ? 1 : 0.15}>
              <line stroke={fill} strokeWidth={isNow ? 2 : 1.25} x1={x1} x2={x2} y1={y} y2={y} />
              <polygon fill={fill} points={`${x2},${y} ${head},${y - 3.5} ${head},${y + 3.5}`} />
              <rect fill={fill} height={11} rx={2} width={54} x={badgeX} y={y - 14.5} />
              <text
                fill={ink[950]}
                fontFamily={MONO}
                fontSize={8}
                fontWeight={700}
                textAnchor="middle"
                x={badgeX + 27}
                y={y - 6}>
                {frame.kind}
              </text>
              <text
                fill={isNow ? ink[50] : ink[200]}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="middle"
                x={(CLIENT_X + SERVER_X) / 2}
                y={y - 5}>
                {frame.label}
              </text>
              <text fill={ink[300]} fontFamily={MONO} fontSize={8} textAnchor="end" x={CLIENT_X - 10} y={y + 3}>
                {i + 1}
              </text>
            </g>
          );
        })}
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={KIND_FILL.HEADERS} height={8} rx={1.5} width={8} x={SERVER_X + 16} y={TOP - 4} />
          <text fill={ink[200]} x={SERVER_X + 28} y={TOP + 3}>
            headers
          </text>
          <rect fill={KIND_FILL.DATA} height={8} rx={1.5} width={8} x={SERVER_X + 16} y={TOP + 10} />
          <text fill={ink[200]} x={SERVER_X + 28} y={TOP + 17}>
            message
          </text>
          <rect fill={KIND_FILL.TRAILERS} height={8} rx={1.5} width={8} x={SERVER_X + 16} y={TOP + 24} />
          <text fill={ink[200]} x={SERVER_X + 28} y={TOP + 31}>
            status
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
GrpcStreams.displayName = 'GrpcStreams';

export default GrpcStreams;
