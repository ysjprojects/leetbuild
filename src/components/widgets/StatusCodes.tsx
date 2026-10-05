import {type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';

type Retry = 'never' | 'backoff' | 'retry-after' | 'n/a';

interface Status {
  code: number;
  name: string;
  when: string;
  example: string;
  retry: Retry;
}

interface Family {
  label: string;
  color: string;
  codes: Status[];
}

const FAMILIES: Family[] = [
  {
    label: '2xx · success',
    color: success[400],
    codes: [
      {
        code: 200,
        name: 'OK',
        when: 'the request did what it said and the body is the result',
        example: 'GET /orders/42 returns the order',
        retry: 'n/a',
      },
      {
        code: 201,
        name: 'Created',
        when: 'a new resource exists now; send its URL in Location',
        example: 'POST /orders → Location: /orders/43',
        retry: 'n/a',
      },
      {
        code: 202,
        name: 'Accepted',
        when: 'the work was queued, not finished; give the client a status URL',
        example: 'POST /exports enqueues a job and returns /jobs/9',
        retry: 'n/a',
      },
      {
        code: 204,
        name: 'No Content',
        when: 'success with nothing to say back',
        example: 'DELETE /sessions/me logs out',
        retry: 'n/a',
      },
      {
        code: 304,
        name: 'Not Modified',
        when: 'the client\u2019s cached copy is still valid (ETag or Last-Modified matched)',
        example: 'GET /img/cat with If-None-Match: "a1b2"',
        retry: 'n/a',
      },
    ],
  },
  {
    label: '4xx · the client is wrong',
    color: warning[400],
    codes: [
      {
        code: 400,
        name: 'Bad Request',
        when: 'the request cannot be parsed: malformed JSON, missing required field',
        example: 'body is not valid JSON',
        retry: 'never',
      },
      {
        code: 401,
        name: 'Unauthorized',
        when: 'no or invalid credentials; the client must authenticate',
        example: 'expired bearer token',
        retry: 'never',
      },
      {
        code: 403,
        name: 'Forbidden',
        when: 'authenticated, but not allowed to do this',
        example: 'a viewer calls DELETE /projects/7',
        retry: 'never',
      },
      {
        code: 404,
        name: 'Not Found',
        when: 'nothing lives at that path (or you refuse to admit it does)',
        example: 'GET /orders/999999',
        retry: 'never',
      },
      {
        code: 409,
        name: 'Conflict',
        when: 'the request conflicts with current state: an idempotency key still in flight, a version mismatch, a duplicate name',
        example: 'POST /orders with an Idempotency-Key that is still processing',
        retry: 'never',
      },
      {
        code: 422,
        name: 'Unprocessable',
        when: 'well-formed but semantically invalid: fails validation rules',
        example: 'quantity: -3, or end_date before start_date',
        retry: 'never',
      },
      {
        code: 429,
        name: 'Too Many Requests',
        when: 'the client exceeded its rate limit; say when to come back',
        example: 'token bucket empty → Retry-After: 2',
        retry: 'retry-after',
      },
    ],
  },
  {
    label: '5xx · the server is wrong',
    color: danger[400],
    codes: [
      {
        code: 500,
        name: 'Internal Server Error',
        when: 'an unhandled exception; the bug is yours, log it with a request id',
        example: 'NullPointerException in the handler',
        retry: 'backoff',
      },
      {
        code: 502,
        name: 'Bad Gateway',
        when: 'a proxy got an invalid response from the upstream it forwarded to',
        example: 'the load balancer reached a pod that crashed mid-response',
        retry: 'backoff',
      },
      {
        code: 503,
        name: 'Service Unavailable',
        when: 'temporarily overloaded or in maintenance; prefer this over 500 when shedding load',
        example: 'connection pool exhausted, Retry-After: 5',
        retry: 'retry-after',
      },
      {
        code: 504,
        name: 'Gateway Timeout',
        when: 'a proxy waited on the upstream past its deadline',
        example: 'the gateway\u2019s 10 s timeout fired before the order service replied',
        retry: 'backoff',
      },
    ],
  },
];

const RETRY_TEXT: Record<Retry, string> = {
  'n/a': 'Nothing to retry.',
  never: 'Do not retry: the same request will fail the same way; fix the request first.',
  backoff:
    'Retry with exponential backoff and jitter, and only if the request is idempotent (or carries an idempotency key).',
  'retry-after': 'Retry, but wait at least Retry-After seconds; hammering a limiter only makes it worse.',
};

const RETRY_SHORT: Record<Retry, string> = {
  'n/a': '',
  never: 'no retry',
  backoff: 'backoff',
  'retry-after': 'Retry-After',
};

const MONO = 'var(--font-code), monospace';
const SELECTED_FILL = alpha(iris[400], 0.18);
const COL_W = 216;
const COL_GAP = 12;
const CELL_H = 24;
const CELL_GAP = 4;
const TOP = 22;
const ROWS = Math.max(...FAMILIES.map(f => f.codes.length));
const WIDTH = FAMILIES.length * COL_W + (FAMILIES.length - 1) * COL_GAP + 8;
const HEIGHT = TOP + ROWS * (CELL_H + CELL_GAP) + 4;

const findStatus = (code: string | null): Status | null => {
  if (code === null) return null;
  const n = Number(code);
  for (const f of FAMILIES) {
    const hit = f.codes.find(s => s.code === n);
    if (hit !== undefined) return hit;
  }
  return null;
};

const StatusCodes: FC<WidgetProps> = memo(() => {
  const [hovered, setHovered] = useState<Status | null>(null);
  const [pinned, setPinned] = useState<Status | null>(null);

  const onOver = useCallback((e: MouseEvent<SVGSVGElement>) => {
    setHovered(findStatus((e.target as SVGElement).getAttribute('data-code')));
  }, []);
  const onLeave = useCallback(() => setHovered(null), []);
  const onClick = useCallback((e: MouseEvent<SVGRectElement>) => {
    const hit = findStatus(e.currentTarget.getAttribute('data-code'));
    setPinned(prev => (hit === null || prev === hit ? null : hit));
  }, []);

  const active = hovered ?? pinned;
  const readout = useMemo(
    () =>
      active === null ? (
        'Pick the family first (success, client error, server error), then the most specific code in it: clients branch on the family, humans and logs branch on the code. Hover or click a code.'
      ) : (
        <>
          <b className="text-ink-100">
            {active.code} {active.name}
          </b>{' '}
          — {active.when}. Example: <code className="font-code text-iris-200">{active.example}</code>.{' '}
          {RETRY_TEXT[active.retry]}
        </>
      ),
    [active],
  );

  return (
    <WidgetFrame readout={readout} title="which status code">
      <svg className="w-full" onMouseLeave={onLeave} onMouseOver={onOver} role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>HTTP status codes a service uses, grouped by family, with retry guidance</title>
        {FAMILIES.map((family, fi) => {
          const x = 4 + fi * (COL_W + COL_GAP);
          return (
            <g key={family.label}>
              <text fill={family.color} fontFamily={MONO} fontSize={10} x={x} y={13}>
                {family.label}
              </text>
              {family.codes.map((s, i) => {
                const y = TOP + i * (CELL_H + CELL_GAP);
                const on = active !== null && active.code === s.code;
                const isPinned = pinned !== null && pinned.code === s.code;
                return (
                  <g key={s.code}>
                    <rect
                      aria-label={`${s.code} ${s.name}`}
                      className="cursor-pointer"
                      data-code={s.code}
                      fill={on ? SELECTED_FILL : ink[700]}
                      height={CELL_H}
                      onClick={onClick}
                      role="button"
                      rx={5}
                      stroke={on ? iris[400] : isPinned ? iris[200] : 'none'}
                      strokeWidth={0.75}
                      width={COL_W}
                      x={x}
                      y={y}>
                      <title>{`${s.code} ${s.name}`}</title>
                    </rect>
                    <rect
                      fill={family.color}
                      height={CELL_H - 8}
                      pointerEvents="none"
                      rx={1.5}
                      width={3}
                      x={x + 5}
                      y={y + 4}
                    />
                    <text
                      fill={on ? ink[50] : ink[200]}
                      fontFamily={MONO}
                      fontSize={11}
                      pointerEvents="none"
                      x={x + 14}
                      y={y + 16}>
                      {s.code}
                    </text>
                    <text
                      fill={on ? iris[200] : ink[300]}
                      fontFamily={MONO}
                      fontSize={9}
                      pointerEvents="none"
                      x={x + 46}
                      y={y + 16}>
                      {s.name}
                    </text>
                    {s.retry === 'n/a' ? null : (
                      <text
                        fill={s.retry === 'never' ? danger[400] : success[400]}
                        fontFamily={MONO}
                        fontSize={8}
                        pointerEvents="none"
                        textAnchor="end"
                        x={x + COL_W - 6}
                        y={y + 16}>
                        {RETRY_SHORT[s.retry]}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
StatusCodes.displayName = 'StatusCodes';

export default StatusCodes;
