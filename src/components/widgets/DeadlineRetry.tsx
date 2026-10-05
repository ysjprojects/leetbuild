import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {clamp, numParam, RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 640;
const LEFT = 72;
const RIGHT = WIDTH - 16;
const TOP = 26;
const ROW = 28;

/** Fixed ±25% jitter multipliers so the picture is stable across renders and reloads. */
const JITTER = [0.87, 1.18, 0.94, 1.22, 0.79, 1.09, 0.91, 1.15, 0.83, 1.2];

type Outcome = 'failed' | 'success' | 'cut' | 'skipped';

interface Attempt {
  n: number;
  start: number;
  end: number;
  wait: number;
  outcome: Outcome;
}

const FILL: Record<Outcome, string> = {failed: '#fb7185', success: '#34d399', cut: '#fbbf24', skipped: '#a78bfa'};
const TONE_CLASS: Record<Outcome, string> = {
  failed: 'text-rose-400',
  success: 'text-emerald-400',
  cut: 'text-amber-400',
  skipped: 'text-violet-300',
};

/** Attempt 1 fires immediately; retry r waits `base·2^(r-1)·jitter` after the previous failure. */
const schedule = (base: number, deadline: number, attempts: number, duration: number): Attempt[] => {
  const out: Attempt[] = [];
  let t = 0;
  for (let k = 1; k <= attempts; k += 1) {
    const wait = k === 1 ? 0 : base * 2 ** (k - 2) * JITTER[(k - 2) % JITTER.length];
    const start = t + wait;
    const end = start + duration;
    const outcome: Outcome = start >= deadline ? 'skipped' : end > deadline ? 'cut' : 'failed';
    out.push({n: k, start, end, wait, outcome});
    t = end;
  }
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].outcome === 'failed') {
      out[i].outcome = 'success';
      break;
    }
  }
  return out;
};

const STATUSES: Array<{code: string; retry: string; tone: Outcome; why: string}> = [
  {code: 'UNAVAILABLE', retry: 'yes', tone: 'success', why: 'transient: a replica is down or a connection reset'},
  {code: 'RESOURCE_EXHAUSTED', retry: 'with backoff', tone: 'cut', why: 'rate limited — retrying fast makes it worse'},
  {code: 'DEADLINE_EXCEEDED', retry: 'no', tone: 'failed', why: 'the budget is spent; there is no time left to retry'},
  {code: 'INVALID_ARGUMENT', retry: 'no', tone: 'failed', why: 'the same request will fail the same way'},
  {code: 'NOT_FOUND', retry: 'no', tone: 'failed', why: 'a correct answer, not a failure'},
];

const tick = (span: number): number => {
  const raw = span / 6;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * pow;
};

const DeadlineRetry: FC<WidgetProps> = memo(({params}) => {
  const attempts = clamp(Math.round(numParam(params, 'attempts', 5)), 1, 10);
  const [base, setBase] = useState(() => clamp(numParam(params, 'base', 100), 10, 1000));
  const [deadline, setDeadline] = useState(() => clamp(numParam(params, 'deadline', 2000), 200, 10000));
  const [duration, setDuration] = useState(150);

  const onBase = useCallback((e: ChangeEvent<HTMLInputElement>) => setBase(Number(e.target.value)), []);
  const onDeadline = useCallback((e: ChangeEvent<HTMLInputElement>) => setDeadline(Number(e.target.value)), []);
  const onDuration = useCallback((e: ChangeEvent<HTMLInputElement>) => setDuration(Number(e.target.value)), []);

  const plan = useMemo(() => schedule(base, deadline, attempts, duration), [attempts, base, deadline, duration]);
  const span = deadline * 1.2;
  const x = useCallback((t: number) => LEFT + (Math.min(t, span) / span) * (RIGHT - LEFT), [span]);

  const fit = plan.filter(a => a.outcome === 'failed' || a.outcome === 'success').length;
  const success = plan.find(a => a.outcome === 'success');
  const skipped = plan.filter(a => a.outcome === 'skipped').length;
  const spent = success === undefined ? deadline : success.end;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">base</span>
          <input
            aria-label="base delay in ms"
            className={RANGE_CLASS}
            max={1000}
            min={10}
            onChange={onBase}
            step={10}
            type="range"
            value={base}
          />
          <span className="font-code tabular-nums text-cream">{base} ms</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">deadline</span>
          <input
            aria-label="caller deadline in ms"
            className={RANGE_CLASS}
            max={10000}
            min={200}
            onChange={onDeadline}
            step={100}
            type="range"
            value={deadline}
          />
          <span className="font-code tabular-nums text-cream">{deadline} ms</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">attempt</span>
          <input
            aria-label="attempt duration in ms"
            className={RANGE_CLASS}
            max={1000}
            min={20}
            onChange={onDuration}
            step={10}
            type="range"
            value={duration}
          />
          <span className="font-code tabular-nums text-cream">{duration} ms</span>
        </label>
      </>
    ),
    [base, deadline, duration, onBase, onDeadline, onDuration],
  );

  const readout = useMemo(
    () => (
      <>
        <b className="text-cream">
          {fit} of {attempts} attempts
        </b>{' '}
        fit in the {deadline} ms budget
        {success === undefined ? (
          <>
            {' '}
            and <b className="text-rose-300">none can succeed</b>: the caller gets DEADLINE_EXCEEDED after {deadline} ms
          </>
        ) : (
          <>
            ; attempt {success.n} succeeds at {Math.round(spent)} ms (
            {Math.round(plan.slice(0, success.n).reduce((s, a) => s + a.wait, 0))} ms of that was waiting)
          </>
        )}
        .{' '}
        {skipped > 0
          ? `${skipped} attempt${
              skipped === 1 ? '' : 's'
            } would start after the deadline and must not be sent — a retry outside the budget just adds load.`
          : 'Every attempt is inside the budget; each retry doubles the wait so a struggling server is not hammered.'}
      </>
    ),
    [attempts, deadline, fit, plan, skipped, spent, success],
  );

  const step = tick(span);
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);
  const height = TOP + plan.length * ROW + 18;

  return (
    <WidgetFrame controls={controls} readout={readout} title="retries with exponential backoff under a deadline">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>Retry attempts on a timeline against the caller deadline</title>
        {ticks.map(t => (
          <g key={t}>
            <line stroke="rgba(58,29,104,0.5)" x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - 18} />
            <text fill="#a78bfa" fontFamily={MONO} fontSize={8} textAnchor="middle" x={x(t)} y={height - 6}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        <text fill="#a78bfa" fontFamily={MONO} fontSize={8} x={RIGHT - 14} y={height - 6}>
          ms
        </text>
        <line
          stroke="#fb7185"
          strokeDasharray="4 3"
          strokeWidth={1.5}
          x1={x(deadline)}
          x2={x(deadline)}
          y1={TOP - 12}
          y2={height - 18}
        />
        <text fill="#fb7185" fontFamily={MONO} fontSize={9} textAnchor="middle" x={x(deadline)} y={TOP - 15}>
          deadline {deadline} ms
        </text>
        {plan.map((a, i) => {
          const y = TOP + i * ROW;
          const fill = FILL[a.outcome];
          const x0 = a.outcome === 'skipped' ? Math.min(x(a.start), RIGHT - 60) : x(a.start);
          const x1 = a.outcome === 'skipped' ? x0 + 60 : x(Math.min(a.end, deadline));
          const anchorEnd = x0 + 130 > RIGHT;
          const label =
            a.outcome === 'skipped'
              ? 'never sent — deadline exceeded'
              : a.outcome === 'cut'
              ? `${Math.round(a.start)} ms → cut off: DEADLINE_EXCEEDED`
              : `${Math.round(a.start)}–${Math.round(a.end)} ms ${a.outcome === 'success' ? 'OK' : 'UNAVAILABLE'}`;
          return (
            <g key={a.n}>
              <text fill="#d6c6f5" fontFamily={MONO} fontSize={9} x={4} y={y + 10}>
                attempt {a.n}
              </text>
              {a.wait > 0 && a.outcome !== 'skipped' ? (
                <rect
                  fill="rgba(58,29,104,0.5)"
                  height={4}
                  width={x(a.start) - x(a.start - a.wait)}
                  x={x(a.start - a.wait)}
                  y={y + 4}
                />
              ) : null}
              <rect
                fill={a.outcome === 'skipped' ? 'none' : fill}
                height={12}
                rx={2}
                stroke={fill}
                strokeDasharray={a.outcome === 'skipped' ? '3 2' : undefined}
                width={Math.max(2, x1 - x0)}
                x={x0}
                y={y}
              />
              <text
                fill={fill}
                fontFamily={MONO}
                fontSize={8}
                textAnchor={anchorEnd ? 'end' : 'start'}
                x={anchorEnd ? x1 : x0}
                y={y + 21}>
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="mt-2 w-full border-collapse font-code text-[10px] text-plum-200">
        <thead>
          <tr className="text-left text-plum-300">
            <th className="py-0.5 pr-2 font-normal">status</th>
            <th className="py-0.5 pr-2 font-normal">retry?</th>
            <th className="py-0.5 font-normal">why</th>
          </tr>
        </thead>
        <tbody>
          {STATUSES.map(st => (
            <tr className="border-t border-plum-800" key={st.code}>
              <td className="py-0.5 pr-2 text-cream">{st.code}</td>
              <td className={`py-0.5 pr-2 font-semibold ${TONE_CLASS[st.tone]}`}>{st.retry}</td>
              <td className="py-0.5">{st.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </WidgetFrame>
  );
});
DeadlineRetry.displayName = 'DeadlineRetry';

export default DeadlineRetry;
