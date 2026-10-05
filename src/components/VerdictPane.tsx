import {type FC, memo, useCallback, useMemo, useState} from 'react';

import {type Verdict, describeMatcher} from '@/lib/judge';
import type {StepAttempt, Submission} from '@/lib/scoring';
import {type Language, type Step, type StepCheck, LANGUAGE_LABEL} from '@/lib/types';

import {InlineMarkdown} from './Markdown';

/**
 * LeetCode-style result panel: before a submission it lists the checks as the step's test cases;
 * after one it shows Accepted or Wrong Answer with every check's outcome and, for failures, what
 * the check looks for. From the second wrong submission on, a failing check also shows the exact
 * shape the judge expects (the analogue of LeetCode showing the expected output), and a
 * Submissions list keeps the step's history.
 */

/** Wrong submissions on the step before failing checks reveal their expected shape. */
export const SHAPE_AFTER_WRONG = 2;

const Fragment: FC<{text: string}> = memo(({text}) => (
  <code className="bg-ink-800 font-code text-iris-200 rounded px-1.5 py-0.5 text-[11px]">{text}</code>
));
Fragment.displayName = 'ShapeFragment';

const ExpectedShape: FC<{check: StepCheck; language: Language}> = memo(({check, language}) => {
  const shape = useMemo(() => describeMatcher(check.match[language]), [check, language]);
  return (
    <div className="text-ink-300 mt-1.5 space-y-1 pl-6 text-[11.5px]">
      <p className="text-ink-400 font-bold uppercase tracking-wider">
        What the judge looks for in {LANGUAGE_LABEL[language]}
      </p>
      {shape.contains.map((text, i) => (
        <p className="flex flex-wrap items-center gap-1.5" key={`c${i}`}>
          <span>contains</span>
          <Fragment text={text} />
        </p>
      ))}
      {shape.inOrder.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5">
          <span>in this order</span>
          {shape.inOrder.map((text, i) => (
            <span className="flex items-center gap-1.5" key={`o${i}`}>
              {i > 0 ? <span className="text-ink-400">→</span> : null}
              <Fragment text={text} />
            </span>
          ))}
        </p>
      ) : null}
      {shape.avoids.map((text, i) => (
        <p className="flex flex-wrap items-center gap-1.5" key={`n${i}`}>
          <span>must not contain</span>
          <Fragment text={text} />
        </p>
      ))}
      <p className="text-ink-400">
        Fragments are approximate: whitespace is flexible, <span className="font-code">…</span> stands for anything on
        the line, <span className="font-code">|</span> separates alternatives.
      </p>
    </div>
  );
});
ExpectedShape.displayName = 'ExpectedShape';

const formatTime = (at: number): string => {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
  return sameDay ? time : `${d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} ${time}`;
};

const Submissions: FC<{history: readonly Submission[]}> = memo(({history}) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  if (history.length === 0) return null;
  return (
    <div className="border-ink-700 bg-ink-850 mt-3 rounded-lg border">
      <button
        className="text-ink-300 hover:text-ink-50 flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider"
        onClick={toggle}
        type="button">
        <span>Submissions ({history.length})</span>
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
      </button>
      {open ? (
        <ul className="border-ink-700 font-code border-t px-3 py-1.5 text-[11px]">
          {[...history].reverse().map((s, i) => (
            <li className="flex items-center gap-3 py-0.5" key={`${s.at}-${i}`}>
              <span className={s.accepted ? 'text-success-300' : 'text-danger-300'}>
                {s.accepted ? 'Accepted' : 'Wrong Answer'}
              </span>
              <span className="text-ink-300">
                {s.passed}/{s.total}
              </span>
              <span className="text-ink-400">{LANGUAGE_LABEL[s.language]}</span>
              <span className="text-ink-400 ml-auto">{formatTime(s.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
Submissions.displayName = 'Submissions';

const EMPTY_HISTORY: Submission[] = [];

const VerdictPane: FC<{
  step: Step;
  language: Language;
  verdict: Verdict | null;
  attempt: StepAttempt;
  /** Points the last accepted submission earned (null when not accepted). */
  earned: number | null;
  /** The editor changed since the verdict was computed. */
  stale: boolean;
}> = memo(({step, language, verdict, attempt, earned, stale}) => {
  const showShape = attempt.wrong >= SHAPE_AFTER_WRONG;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-ink-700 text-ink-300 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
        <span className="text-iris-400 font-bold uppercase tracking-wider">Checks</span>
        <span className="font-code">
          {step.checks.length} for this step · {attempt.wrong} wrong submission{attempt.wrong === 1 ? '' : 's'}
        </span>
        {stale && verdict !== null ? (
          <span className="text-warning-300 ml-auto">edited since the last submit</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {verdict === null ? (
          <p className="text-ink-300 mb-2 text-[12px]">
            Submit (⌘/Ctrl + Enter) to run the checks. Each one is a property a correct implementation has; failures
            show what was expected.
          </p>
        ) : verdict.accepted ? (
          <div className="border-success-400/60 bg-success-400/10 mb-3 rounded-xl border p-3">
            <p className="text-success-300 text-[11px] font-bold uppercase tracking-wider">Result</p>
            <p className="text-ink-50 mt-0.5 text-lg font-extrabold">
              Accepted
              {earned !== null ? (
                <span className="font-code text-success-200 ml-2 text-[13px] font-semibold">+{earned} pts</span>
              ) : null}
            </p>
            <p className="text-success-200 mt-0.5 text-[12px]">
              {verdict.passed}/{verdict.total} checks passed
              {attempt.status === 'revealed' ? ' · this step was revealed, so it scores 0' : ''}. Read the debrief on
              the left, then move to the next step.
            </p>
          </div>
        ) : (
          <div className="border-danger-400/60 bg-danger-400/10 mb-3 rounded-xl border p-3">
            <p className="text-danger-300 text-[11px] font-bold uppercase tracking-wider">Result</p>
            <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Wrong Answer</p>
            <p className="text-danger-200 mt-0.5 text-[12px]">
              {verdict.passed}/{verdict.total} checks passed.{' '}
              {showShape
                ? 'Failing checks now show the shape the judge expects.'
                : `Fix the failing ones and submit again — after ${SHAPE_AFTER_WRONG} wrong submissions, failing checks show the exact shape the judge expects.`}
            </p>
          </div>
        )}
        <ul className="space-y-1.5">
          {step.checks.map((check, i) => {
            const result = verdict?.results[i] ?? null;
            const tone =
              result === null
                ? 'border-ink-700 bg-ink-850'
                : result.passed
                ? 'border-success-400/40 bg-success-400/5'
                : 'border-danger-400/50 bg-danger-400/5';
            return (
              <li className={`rounded-lg border px-3 py-2 ${tone}`} key={check.id}>
                <p className="text-ink-100 flex items-center gap-2 text-[12.5px]">
                  <span
                    className={`font-code flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                      result === null
                        ? 'border-ink-500 border text-transparent'
                        : result.passed
                        ? 'bg-success-400 text-ink-950'
                        : 'bg-danger-400 text-ink-950'
                    }`}>
                    {result === null ? '·' : result.passed ? '✓' : '✗'}
                  </span>
                  <span className="font-code text-ink-400 text-[10px]">{i + 1}</span>
                  <span className="font-semibold">{check.title}</span>
                </p>
                {result !== null && !result.passed ? (
                  <>
                    <p className="text-ink-200 mt-1 pl-6 text-[12px]">
                      <InlineMarkdown source={check.detail} />
                    </p>
                    {showShape ? <ExpectedShape check={check} language={language} /> : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        <Submissions history={attempt.history ?? EMPTY_HISTORY} />
      </div>
    </div>
  );
});
VerdictPane.displayName = 'VerdictPane';

export default VerdictPane;
