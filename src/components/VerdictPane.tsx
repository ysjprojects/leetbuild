import {type FC, memo, useCallback, useMemo, useState} from 'react';

import {type Verdict, describeMatcher} from '@/lib/judge';
import {type RuntimeStatus, STATUS_TEXT} from '@/lib/runtime/client';
import type {StepAttempt, Submission} from '@/lib/scoring';
import {type Language, type Step, type StepCheck, LANGUAGE_LABEL} from '@/lib/types';

import {InlineMarkdown} from './Markdown';

/**
 * LeetCode-style result panel: before a submission it lists the checks as the step's test cases;
 * after one it shows Accepted or Wrong Answer with every check's outcome and, for failures, what
 * the check looks for. Steps that run in the browser runtime show each check's runtime message
 * (the assertion that failed, where an exception was raised), the static matcher's verdict as an
 * advisory shape chip, and the program's output. From the second wrong submission on, a failing
 * check also shows the exact shape the judge expects (the analogue of LeetCode showing the
 * expected output), and a Submissions list keeps the step's history.
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

const Output: FC<{stdout: string; stderr: string}> = memo(({stdout, stderr}) => {
  const text = [stdout, stderr].filter(s => s !== '').join('\n');
  if (text === '') return null;
  return (
    <details className="border-ink-700 bg-ink-850 mt-3 rounded-lg border px-3 py-2">
      <summary className="text-ink-300 cursor-pointer text-[11px] font-semibold uppercase tracking-wider">
        Output · {text.split('\n').length} line{text.split('\n').length === 1 ? '' : 's'}
      </summary>
      <pre className="font-code text-ink-200 mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{text}</pre>
    </details>
  );
});
Output.displayName = 'VerdictOutput';

const VerdictPane: FC<{
  step: Step;
  language: Language;
  verdict: Verdict | null;
  attempt: StepAttempt;
  /** Points the last accepted submission earned (null when not accepted). */
  earned: number | null;
  /** The editor changed since the verdict was computed. */
  stale: boolean;
  /** The step runs in the browser runtime for this language (a harness exists). */
  executes: boolean;
  /** A submission is being executed. */
  running: boolean;
  runtime: RuntimeStatus;
}> = memo(({step, language, verdict, attempt, earned, stale, executes, running, runtime}) => {
  const showShape = attempt.wrong >= SHAPE_AFTER_WRONG;
  const runError = verdict?.run?.error;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-ink-700 text-ink-300 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
        <span className="text-iris-400 font-bold uppercase tracking-wider">Checks</span>
        <span className="font-code">
          {step.checks.length} for this step · {attempt.wrong} wrong submission{attempt.wrong === 1 ? '' : 's'}
        </span>
        {executes ? (
          <span
            className="border-iris-400/40 bg-iris-400/10 text-iris-200 rounded-full border px-2 py-0.5 text-[10px]"
            title="your code runs in the browser: Python, Redis, Kafka, gRPC and Postgres in-page; these checks exercise it">
            runs in the browser
          </span>
        ) : null}
        {running ? (
          <span className="text-iris-200 ml-auto flex items-center gap-1.5">
            <span className="bg-iris-300 h-1.5 w-1.5 animate-pulse rounded-full" />
            {runtime.state === 'booting' ? STATUS_TEXT[runtime.phase] : 'running your code…'}
          </span>
        ) : stale && verdict !== null ? (
          <span className="text-warning-300 ml-auto">edited since the last submit</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {verdict === null ? (
          <p className="text-ink-300 mb-2 text-[12px]">
            {executes
              ? 'Submit (⌘/Ctrl + Enter) to run your code. Each check exercises your implementation and reports what it observed; the first run downloads the Python runtime (~10 MB).'
              : 'Submit (⌘/Ctrl + Enter) to run the checks. Each one is a property a correct implementation has; failures show what was expected.'}
          </p>
        ) : runError !== undefined ? (
          <div className="border-warning-400/60 bg-warning-400/10 mb-3 rounded-xl border p-3">
            <p className="text-warning-300 text-[11px] font-bold uppercase tracking-wider">Runtime</p>
            <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Could not run</p>
            <p className="text-warning-200 mt-0.5 text-[12px]">{runError}. This did not count as a submission.</p>
          </div>
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
              {verdict.run !== undefined ? ` in ${verdict.run.ms} ms` : ''}
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
              {verdict.run !== undefined
                ? 'Each failing check says what it observed.'
                : showShape
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
                  {result !== null && result.shape !== undefined ? (
                    <span
                      className={`font-code ml-auto rounded-full border px-1.5 text-[9.5px] ${
                        result.shape ? 'border-ink-600 text-ink-400' : 'border-warning-400/50 text-warning-300'
                      }`}
                      title={
                        result.shape
                          ? 'the static pattern check also passes (advisory)'
                          : 'the static pattern check does not match the reference shape (advisory: the runtime result decides)'
                      }>
                      shape {result.shape ? '✓' : '✗'}
                    </span>
                  ) : null}
                </p>
                {result !== null && !result.passed ? (
                  <>
                    {result.message !== undefined ? (
                      <p className="font-code text-danger-200 mt-1 pl-6 text-[11.5px]">{result.message}</p>
                    ) : null}
                    <p className="text-ink-200 mt-1 pl-6 text-[12px]">
                      <InlineMarkdown source={check.detail} />
                    </p>
                    {showShape && result.shape === undefined ? (
                      <ExpectedShape check={check} language={language} />
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        {verdict?.run !== undefined ? <Output stderr={verdict.run.stderr} stdout={verdict.run.stdout} /> : null}
        <Submissions history={attempt.history ?? EMPTY_HISTORY} />
      </div>
    </div>
  );
});
VerdictPane.displayName = 'VerdictPane';

export default VerdictPane;
