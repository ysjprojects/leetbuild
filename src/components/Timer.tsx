import {type FC, memo, useCallback, useEffect, useRef, useState} from 'react';

import {
  type ActiveTimer,
  type TimedSession,
  BUDGETS,
  budgetSeconds,
  describeSession,
  formatClock,
  remainingSeconds,
} from '@/lib/timer';
import {type Problem, LANGUAGE_LABEL} from '@/lib/types';

/**
 * Timer mode as the learner sees it: the countdown pill in the header (green → amber under five
 * minutes → red in the last minute, `+m:ss` once the budget has run out and the learner kept
 * going), the budget picker of the start dialog, and the history of timed runs.
 */

/** Seconds left at which the countdown turns amber, then red. */
const WARN_AT = 5 * 60;
const URGENT_AT = 60;

export const Clock: FC = memo(() => (
  <svg
    aria-hidden
    fill="none"
    height={12}
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth={1.8}
    viewBox="0 0 16 16"
    width={12}>
    <circle cx={8} cy={8.5} r={5.5} />
    <path d="M8 5.5v3l2 1.5M6 1.5h4" />
  </svg>
));
Clock.displayName = 'Clock';

/** Ticks once a second while mounted; reports the moment the budget runs out exactly once. */
export const TimerPill: FC<{
  timer: ActiveTimer;
  problem: Problem | undefined;
  onExpire: () => void;
  onClick: () => void;
}> = memo(({timer, problem, onExpire, onClick}) => {
  const [now, setNow] = useState(() => Date.now());
  const expired = useRef(false);
  useEffect(() => {
    expired.current = false;
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [timer.startedAt, timer.problemId]);
  const remaining = remainingSeconds(timer, now);
  useEffect(() => {
    if (remaining <= 0 && !timer.overtime && !expired.current) {
      expired.current = true;
      onExpire();
    }
  }, [remaining, timer.overtime, onExpire]);
  const over = remaining <= 0;
  const tone = over
    ? 'border-danger-400/60 bg-danger-400/10 text-danger-200'
    : remaining <= URGENT_AT
    ? 'border-danger-400/60 bg-danger-400/10 text-danger-200 animate-pulse'
    : remaining <= WARN_AT
    ? 'border-warning-400/60 bg-warning-400/10 text-warning-200'
    : 'border-success-400/50 bg-success-400/10 text-success-200';
  const title = `${problem?.title ?? timer.problemId} · timed run${
    over
      ? ` · ${formatClock(-remaining)} over the ${formatClock(timer.budget)} budget (not counted)`
      : ` · ${formatClock(timer.budget)} budget`
  } · click to end it`;
  return (
    <button
      className={`font-code flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition hover:brightness-110 ${tone}`}
      onClick={onClick}
      title={title}
      type="button">
      <Clock />
      <span aria-live="off">{over ? `+${formatClock(-remaining)}` : formatClock(remaining)}</span>
      {over ? <span className="hidden text-[10px] opacity-80 sm:inline">over</span> : null}
    </button>
  );
});
TimerPill.displayName = 'TimerPill';

const BudgetOption: FC<{
  problem: Problem;
  factor: number;
  label: string;
  blurb: string;
  checked: boolean;
  onPick: (factor: number) => void;
}> = memo(({problem, factor, label, blurb, checked, onPick}) => {
  const onClick = useCallback(() => onPick(factor), [onPick, factor]);
  return (
    <button
      aria-checked={checked}
      className={`rounded-lg border px-2 py-2 text-left transition ${
        checked ? 'border-iris-400 bg-iris-400/10' : 'border-ink-600 hover:border-ink-500'
      }`}
      onClick={onClick}
      role="radio"
      type="button">
      <span className="text-ink-50 block text-[12px] font-semibold">{label}</span>
      <span className="font-code text-iris-200 block text-[15px] font-semibold">
        {formatClock(budgetSeconds(problem, factor))}
      </span>
      <span className="text-ink-400 block text-[10.5px]">{blurb}</span>
    </button>
  );
});
BudgetOption.displayName = 'BudgetOption';

/** The start dialog's body: pick a budget; `onChange` receives the factor. */
export const BudgetPicker: FC<{problem: Problem; initial: number; onChange: (factor: number) => void}> = memo(
  ({problem, initial, onChange}) => {
    const [factor, setFactor] = useState(initial);
    const pick = useCallback(
      (f: number) => {
        setFactor(f);
        onChange(f);
      },
      [onChange],
    );
    return (
      <div className="space-y-3">
        <p>
          The run starts from step 1 with a clean slate:{' '}
          <b className="text-ink-100">this problem’s results and code are cleared</b>. Finish every step before the
          clock runs out and the time goes on your board; revealing a solution or running over means the run is recorded
          but not counted.
        </p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {BUDGETS.map(b => (
            <BudgetOption
              blurb={b.blurb}
              checked={factor === b.factor}
              factor={b.factor}
              key={b.factor}
              label={b.label}
              onPick={pick}
              problem={problem}
            />
          ))}
        </div>
      </div>
    );
  },
);

const formatWhen = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) +
  ' ' +
  new Date(at).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});

/** Runs newest first; `showProblem` names the problem on each row (the all-problems history). */
export const SessionList: FC<{sessions: readonly TimedSession[]; problems: readonly Problem[]; showProblem: boolean}> =
  memo(({sessions, problems, showProblem}) => {
    if (sessions.length === 0) return null;
    const titles: Record<string, string> = {};
    for (const p of problems) titles[p.id] = p.title;
    return (
      <ul className="divide-ink-700/70 divide-y">
        {[...sessions].reverse().map(s => (
          <li className="flex items-start gap-3 py-1.5 text-[12px]" key={`${s.problemId}/${s.startedAt}`}>
            <span
              className={`font-code mt-0.5 w-16 shrink-0 text-right text-[12.5px] font-semibold ${
                s.counted ? 'text-success-300' : s.outcome === 'completed' ? 'text-ink-200' : 'text-ink-400'
              }`}
              title={s.counted ? 'completed within the budget: counted' : 'not counted'}>
              {s.counted ? '✓ ' : ''}
              {formatClock(s.elapsed)}
            </span>
            <span className="min-w-0 flex-1">
              {showProblem ? (
                <span className="text-ink-50 block font-semibold">{titles[s.problemId] ?? s.problemId}</span>
              ) : null}
              <span className="text-ink-300 block">{describeSession(s)}</span>
              <span className="text-ink-400 font-code block text-[10.5px]">
                {formatWhen(s.startedAt)} · budget {formatClock(s.budget)} · {LANGUAGE_LABEL[s.language]}
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  });
SessionList.displayName = 'SessionList';
