import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {boolParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

type Group = 'TCP' | 'TLS' | 'HTTP' | 'keep-alive';

interface Phase {
  group: Group;
  /** `note` phases stay on the server lifeline (routing, handler); the rest are wire messages. */
  dir: 'to-server' | 'to-browser' | 'note';
  label: string;
  /** Second line under the label, e.g. headers. */
  sub?: string;
  readout: string;
}

const TCP: Phase[] = [
  {
    group: 'TCP',
    dir: 'to-server',
    label: 'SYN',
    readout: 'TCP first: the browser asks for a connection. Nothing HTTP has happened yet.',
  },
  {
    group: 'TCP',
    dir: 'to-browser',
    label: 'SYN-ACK',
    readout: 'The server accepts. One round trip is spent before a single byte of application data moves.',
  },
  {
    group: 'TCP',
    dir: 'to-server',
    label: 'ACK',
    readout: 'The connection is open. Over plain HTTP the request could ride along right here.',
  },
];

const TLS: Phase[] = [
  {
    group: 'TLS',
    dir: 'to-server',
    label: 'ClientHello',
    sub: 'SNI, cipher suites, key share',
    readout:
      'TLS begins: the browser lists what it supports and which hostname it wants (SNI), so one IP can serve many certificates.',
  },
  {
    group: 'TLS',
    dir: 'to-browser',
    label: 'ServerHello + certificate',
    readout:
      'The server picks a cipher suite and proves who it is with a certificate chain the browser validates against its trust store.',
  },
  {
    group: 'TLS',
    dir: 'to-server',
    label: 'key exchange',
    sub: 'ECDHE → session keys',
    readout:
      'Both sides derive the same session keys from ephemeral Diffie-Hellman; the private key never crosses the wire.',
  },
  {
    group: 'TLS',
    dir: 'to-browser',
    label: 'Finished',
    readout: 'Handshake done. The TLS handshake costs 1–2 round trips; everything after this line is encrypted.',
  },
];

const HTTP: Phase[] = [
  {
    group: 'HTTP',
    dir: 'to-server',
    label: 'GET /img/cat?w=256 HTTP/1.1',
    sub: 'Host · Accept · If-None-Match: —',
    readout: 'The request: a method, a path with a query string, and headers. The body is empty for GET.',
  },
  {
    group: 'HTTP',
    dir: 'note',
    label: 'router: GET /img/{name} → handler',
    readout: 'The framework matches the method and path template, parses `w=256` from the query, and picks a handler.',
  },
  {
    group: 'HTTP',
    dir: 'note',
    label: 'handler: resize, hash → ETag',
    readout: 'The handler does the work and computes an ETag, a fingerprint of the exact bytes it is about to send.',
  },
  {
    group: 'HTTP',
    dir: 'to-browser',
    label: '200 OK',
    sub: 'Cache-Control: max-age=3600 · ETag: "a1b2"',
    readout:
      'The response tells the browser how long the bytes stay fresh and how to ask cheaply whether they changed.',
  },
];

const REUSE: Phase[] = [
  {
    group: 'keep-alive',
    dir: 'to-server',
    label: 'GET /img/cat?w=256',
    sub: 'If-None-Match: "a1b2"',
    readout:
      'Keep-alive reuses the connection: the second request skips TCP and TLS entirely and sends the ETag it already has.',
  },
  {
    group: 'keep-alive',
    dir: 'to-browser',
    label: '304 Not Modified',
    readout:
      'Same ETag, so the server answers with no body: a few hundred bytes instead of the image, and the cache stays warm.',
  },
];

const MONO = 'var(--font-code), monospace';
const BROWSER_X = 96;
const SERVER_X = 470;
const TOP = 38;
const ROW = 30;
const WIDTH = 560;

const GROUP_COLOR: Record<Group, string> = {TCP: '#a78bfa', TLS: '#fbbf24', HTTP: '#ff7ac8', 'keep-alive': '#34d399'};

const HttpLifecycle: FC<WidgetProps> = memo(({params}) => {
  const [tls, setTls] = useState(() => boolParam(params, 'tls', true));
  const phases = useMemo(() => (tls ? [...TCP, ...TLS, ...HTTP, ...REUSE] : [...TCP, ...HTTP, ...REUSE]), [tls]);
  const playback = usePlayback(phases.length, 1100);
  const current = Math.min(playback.step, phases.length - 1);
  const phase = phases[current];
  const roundTrips = phases.slice(0, current + 1).filter(p => p.dir === 'to-browser').length;

  const onScheme = useCallback((e: MouseEvent<HTMLButtonElement>) => setTls(e.currentTarget.value === 'https'), []);

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          <button className={tabClass(tls)} onClick={onScheme} type="button" value="https">
            https
          </button>
          <button className={tabClass(!tls)} onClick={onScheme} type="button" value="http">
            http
          </button>
        </div>
        <PlaybackControls label="phase" playback={playback} />
      </>
    ),
    [onScheme, playback, tls],
  );

  const readout = useMemo(
    () => (
      <>
        <b className="text-cream">{phase.group}</b> · {phase.readout}{' '}
        <span className="text-plum-300">
          ({roundTrips} round trip{roundTrips === 1 ? '' : 's'} so far)
        </span>
      </>
    ),
    [phase, roundTrips],
  );

  const height = TOP + phases.length * ROW + 10;
  return (
    <WidgetFrame controls={controls} readout={readout} title="one HTTPS request, on the wire">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>
          Sequence of TCP, TLS, request, routing, response and keep-alive reuse between a browser and a server
        </title>
        <g fontFamily={MONO} fontSize={11} textAnchor="middle">
          <rect fill="#2b144d" height={20} rx={5} width={84} x={BROWSER_X - 42} y={6} />
          <text fill="#fbf6ff" x={BROWSER_X} y={20}>
            browser
          </text>
          <rect fill="#2b144d" height={20} rx={5} width={84} x={SERVER_X - 42} y={6} />
          <text fill="#fbf6ff" x={SERVER_X} y={20}>
            server
          </text>
        </g>
        <line
          stroke="rgba(58,29,104,0.9)"
          strokeDasharray="3 3"
          x1={BROWSER_X}
          x2={BROWSER_X}
          y1={28}
          y2={height - 4}
        />
        <line stroke="rgba(58,29,104,0.9)" strokeDasharray="3 3" x1={SERVER_X} x2={SERVER_X} y1={28} y2={height - 4} />
        {phases.map((p, i) => {
          const y = TOP + i * ROW + 14;
          const isNow = i === current;
          const shown = i <= current;
          const color = isNow ? '#ff3fa6' : '#a78bfa';
          const textColor = isNow ? '#fbf6ff' : '#d6c6f5';
          const groupStart = i === 0 || phases[i - 1].group !== p.group;
          return (
            <g key={`${p.group}-${p.label}`} opacity={shown ? (isNow ? 1 : 0.5) : 0}>
              {groupStart ? (
                <text fill={GROUP_COLOR[p.group]} fontFamily={MONO} fontSize={9} x={4} y={y - 4}>
                  {p.group}
                </text>
              ) : null}
              {p.dir === 'note' ? (
                <>
                  <rect
                    fill={isNow ? 'rgba(255,63,166,0.18)' : '#2b144d'}
                    height={18}
                    rx={4}
                    stroke={color}
                    strokeWidth={0.75}
                    width={210}
                    x={SERVER_X - 220}
                    y={y - 13}
                  />
                  <text fill={textColor} fontFamily={MONO} fontSize={9} textAnchor="end" x={SERVER_X - 16} y={y}>
                    {p.label}
                  </text>
                </>
              ) : (
                <>
                  <line
                    stroke={color}
                    strokeWidth={isNow ? 1.5 : 1}
                    x1={p.dir === 'to-server' ? BROWSER_X : SERVER_X}
                    x2={p.dir === 'to-server' ? SERVER_X - 8 : BROWSER_X + 8}
                    y1={y}
                    y2={y}
                  />
                  <polygon
                    fill={color}
                    points={
                      p.dir === 'to-server'
                        ? `${SERVER_X - 8},${y - 4} ${SERVER_X},${y} ${SERVER_X - 8},${y + 4}`
                        : `${BROWSER_X + 8},${y - 4} ${BROWSER_X},${y} ${BROWSER_X + 8},${y + 4}`
                    }
                  />
                  <text
                    fill={textColor}
                    fontFamily={MONO}
                    fontSize={10}
                    textAnchor="middle"
                    x={(BROWSER_X + SERVER_X) / 2}
                    y={y - 4}>
                    {p.label}
                  </text>
                  {p.sub === undefined ? null : (
                    <text
                      fill={isNow ? '#ffb0dc' : '#a78bfa'}
                      fontFamily={MONO}
                      fontSize={8}
                      textAnchor="middle"
                      x={(BROWSER_X + SERVER_X) / 2}
                      y={y + 10}>
                      {p.sub}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
HttpLifecycle.displayName = 'HttpLifecycle';

export default HttpLifecycle;
