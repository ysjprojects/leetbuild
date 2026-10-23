import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {BottomTab, ConsoleRun} from '@/lib/console';
import {type CheckResult, type Verdict, describeMatcher} from '@/lib/judge';
import {type MetricRow, comparedRows, metricByCheck, total} from '@/lib/metrics';
import {type RuntimeStatus, STATUS_TEXT} from '@/lib/runtime/client';
import type {StepAttempt, Submission} from '@/lib/scoring';
import {type Language, type Step, type StepCheck, fileName, LANGUAGE_LABEL} from '@/lib/types';

import {InlineMarkdown} from './Markdown';
import {mod} from './Shortcuts';
import {LinkedInButton, POST_HINT} from './Social';
import StepEditor from './StepEditor';

const SUBMIT_KEYS = mod('⏎');
const RUN_KEYS = mod("'");

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

/** What the first run fetches, per executing language (the idle copy under the checks). */
const RUNTIME_DOWNLOAD: Partial<Record<Language, string>> = {
  python: 'the Python runtime (~10 MB)',
  typescript: 'the TypeScript compiler (~14 MB)',
  go: 'the Go interpreter (~9 MB)',
};

const Fragment: FC<{text: string}> = memo(({text}) => (
  <code className="bg-ink-800 font-code text-iris-200 rounded px-1.5 py-0.5 text-[11px]">{text}</code>
));
Fragment.displayName = 'ShapeFragment';

const ExpectedShape: FC<{check: StepCheck; language: Language}> = memo(({check, language}) => {
  const shape = useMemo(() => describeMatcher(check.match[language] ?? {}), [check, language]);
  return (
    <div className="text-ink-300 mt-1.5 space-y-1 pl-6 text-[12px]">
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

const Submissions: FC<{history: readonly Submission[]; onView?: (submission: Submission) => void}> = memo(
  ({history, onView}) => {
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
                {s.code !== undefined && onView !== undefined ? (
                  <SubmissionLink onView={onView} submission={s} />
                ) : null}
                <span className="text-ink-400 ml-auto">{formatTime(s.at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
);
Submissions.displayName = 'Submissions';

const SubmissionLink: FC<{submission: Submission; onView: (submission: Submission) => void}> = memo(
  ({submission, onView}) => {
    const onClick = useCallback(() => onView(submission), [onView, submission]);
    return (
      <button
        className="text-iris-300 hover:text-iris-200 transition"
        onClick={onClick}
        title="the code this submission judged — view it, see what changed since, put it back in the editor"
        type="button">
        code ›
      </button>
    );
  },
);
SubmissionLink.displayName = 'SubmissionLink';

/**
 * A past submission's code in a read-only editor; `current` (the step's file now, when it is in the
 * same language) adds a second view: the current file with its edits since the submission marked.
 */
export const SubmissionCode: FC<{code: string; current: string | null; language: Language}> = memo(
  ({code, current, language}) => {
    const [changes, setChanges] = useState(false);
    const showCode = useCallback(() => setChanges(false), []);
    const showChanges = useCallback(() => setChanges(true), []);
    const unchanged = current === code;
    return (
      <div>
        {current !== null ? (
          <div className="mb-2 flex items-center gap-1 text-[11px]">
            <button
              aria-pressed={!changes}
              className={`rounded-md px-2 py-0.5 transition ${
                changes ? 'text-ink-300 hover:text-ink-50' : 'bg-ink-700 text-ink-50'
              }`}
              onClick={showCode}
              type="button">
              as submitted
            </button>
            <button
              aria-pressed={changes}
              className={`rounded-md px-2 py-0.5 transition disabled:cursor-default disabled:opacity-50 ${
                changes ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-50'
              }`}
              disabled={unchanged}
              onClick={showChanges}
              title={
                unchanged
                  ? 'the file has not changed since this submission'
                  : 'your file now, with the edits since this submission marked'
              }
              type="button">
              changes since
            </button>
            {unchanged ? <span className="text-ink-400 ml-1">identical to the editor</span> : null}
          </div>
        ) : null}
        <StepEditor
          className="border-ink-700 h-[55vh] overflow-hidden rounded-lg border"
          language={language}
          original={changes && current !== null ? code : null}
          readOnly
          value={changes && current !== null ? current : code}
        />
      </div>
    );
  },
);
SubmissionCode.displayName = 'SubmissionCode';

const EMPTY_HISTORY: Submission[] = [];

/** The bottom panel's switch: the step's objectives (its checks) or the console of the last run. */
const PanelTabs: FC<{tab: BottomTab; onTab: (tab: BottomTab) => void; consoleRun: ConsoleRun | null}> = memo(
  ({tab, onTab, consoleRun}) => {
    const showChecks = useCallback(() => onTab('checks'), [onTab]);
    const showConsole = useCallback(() => onTab('console'), [onTab]);
    const tabClass = (active: boolean): string =>
      `rounded-md px-2 py-0.5 font-bold uppercase tracking-wider transition ${
        active ? 'bg-ink-700 text-iris-300' : 'text-ink-400 hover:text-ink-100'
      }`;
    return (
      <div className="flex items-center gap-1" role="tablist">
        <button
          aria-selected={tab === 'checks'}
          className={tabClass(tab === 'checks')}
          onClick={showChecks}
          role="tab"
          type="button">
          Checks
        </button>
        <button
          aria-selected={tab === 'console'}
          className={tabClass(tab === 'console')}
          onClick={showConsole}
          role="tab"
          title="what the last run printed, as it printed it"
          type="button">
          Console
          {consoleRun?.running === true ? (
            <span className="bg-iris-300 ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle" />
          ) : consoleRun !== null && tab !== 'console' && consoleRun.lines.length > 0 ? (
            <span className="font-code text-ink-400 ml-1.5 normal-case tracking-normal">{consoleRun.lines.length}</span>
          ) : null}
        </button>
      </div>
    );
  },
);
PanelTabs.displayName = 'PanelTabs';

/** The last run's output, line by line as it was printed (stderr in red), and how the run ended. */
const ConsoleView: FC<{run: ConsoleRun | null; idle: string}> = memo(({run, idle}) => {
  const end = useRef<HTMLDivElement>(null);
  const count = run?.lines.length ?? 0;
  const running = run?.running === true;
  // Follow the output while it comes in, as a terminal does.
  useEffect(() => {
    if (running) end.current?.scrollIntoView({block: 'nearest'});
  }, [count, running]);
  if (run === null) return <p className="text-ink-300 text-[12px]">{idle}</p>;
  const seconds = run.ms === undefined ? '' : ` · ${(run.ms / 1000).toFixed(1)} s`;
  return (
    <div className="border-ink-700 bg-ink-950 font-code rounded-lg border px-3 py-2 text-[11px] leading-relaxed">
      <p className="text-ink-400">$ {run.label}</p>
      {count > 0 ? (
        <pre className="whitespace-pre-wrap break-words">
          {run.lines.map((line, i) => (
            <span className={line.stream === 'stderr' ? 'text-danger-300' : 'text-ink-100'} key={i}>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : null}
      {running ? (
        <p className="text-iris-300 animate-pulse">▍</p>
      ) : run.error !== undefined ? (
        <p className="text-warning-300 mt-1">✗ {run.error}</p>
      ) : run.exit === undefined ? (
        <p className="text-ink-400 mt-1">
          done{seconds}
          {count === 0 ? ' · nothing printed' : ''}
        </p>
      ) : (
        <p className={`mt-1 ${run.exit === 0 ? 'text-success-300' : 'text-danger-300'}`}>
          {run.exit === 0 ? '✓' : '✗'} exited with status {run.exit}
          {seconds}
        </p>
      )}
      <div ref={end} />
    </div>
  );
});
ConsoleView.displayName = 'ConsoleView';

/** One metric row: your total, the reference's, the difference; per-check values in the tooltips. */
const MetricLine: FC<{row: MetricRow; step: Step; yours: readonly CheckResult[]; reference: readonly CheckResult[]}> =
  memo(({row, step, yours, reference}) => {
    const mine = metricByCheck(yours, row.key);
    const theirs = metricByCheck(reference, row.key);
    const a = total(mine);
    const b = total(theirs);
    const perCheck = (values: number[]): string =>
      step.checks.map((c, i) => `${i + 1}. ${c.title}: ${row.format(values[i] ?? 0)}`).join('\n');
    return (
      <tr className="border-ink-700/70 border-t">
        <th className="text-ink-200 py-1 pr-3 text-left font-semibold" scope="row" title={row.blurb}>
          {row.label}
        </th>
        <td className="font-code text-ink-50 py-1 pr-3 text-right" title={perCheck(mine)}>
          {row.format(a)}
        </td>
        <td className="font-code text-ink-300 py-1 pr-3 text-right" title={perCheck(theirs)}>
          {row.format(b)}
        </td>
        <td
          className={`font-code py-1 text-right text-[11px] ${
            a === b ? 'text-ink-500' : a > b ? 'text-warning-300' : 'text-iris-300'
          }`}>
          {a === b ? 'same' : a > b ? `+${row.format(a - b)}` : `−${row.format(b - a)}`}
        </td>
      </tr>
    );
  });
MetricLine.displayName = 'MetricLine';

/**
 * Against the reference: a button until it has run, then the table — what your code and the
 * reference solution each did under the same checks, totalled over the checks (per-check figures
 * in the tooltips). More is amber, less is iris, neither is a verdict.
 */
const Comparison: FC<{
  step: Step;
  file: string;
  yours: readonly CheckResult[];
  reference: Verdict | null;
  comparing: boolean;
  onCompare: () => void;
}> = memo(({step, file, yours, reference, comparing, onCompare}) => {
  const rows = useMemo(() => (reference === null ? [] : comparedRows(yours, reference.results)), [yours, reference]);
  return (
    <section className="border-ink-700 bg-ink-850 mb-3 rounded-lg border px-3 py-2">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-ink-300 text-[11px] font-bold uppercase tracking-wider">Against the reference</span>
        {reference === null && !comparing ? (
          <button
            className="border-ink-600 text-ink-200 hover:border-iris-400/60 hover:text-ink-50 rounded-lg border px-2.5 py-0.5 text-[11px] font-semibold transition"
            onClick={onCompare}
            title={`runs the reference solution in place of ${file}, through the same checks, and counts what it did`}
            type="button">
            compare
          </button>
        ) : null}
      </p>
      {comparing ? (
        <p className="text-iris-200 mt-1 flex items-center gap-1.5 text-[12px]">
          <span className="bg-iris-300 h-1.5 w-1.5 animate-pulse rounded-full" />
          running the reference solution through the same checks…
        </p>
      ) : reference === null ? (
        <p className="text-ink-400 mt-1 text-[12px]">
          Run the reference solution through the same {step.checks.length} checks and set what each did side by side:
          Redis round trips, records, RPCs, statements, waits — counted by the runtime, so the difference is in the
          code.
        </p>
      ) : reference.run?.error !== undefined || !reference.accepted ? (
        <p className="text-warning-200 mt-1 text-[12px]">
          The reference did not pass every check in this world
          {reference.run?.error !== undefined ? ` (${reference.run.error})` : ''}: nothing to compare.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-ink-400 mt-1 text-[12px]">Neither run touched a counted resource: nothing to compare.</p>
      ) : (
        <>
          <table className="mt-1.5 w-full text-[12px]">
            <thead>
              <tr className="text-ink-400 text-[10px] uppercase tracking-wider">
                <th className="pb-1 text-left font-semibold" scope="col">
                  over {step.checks.length} checks
                </th>
                <th className="pb-1 pr-3 text-right font-semibold" scope="col">
                  you
                </th>
                <th className="pb-1 pr-3 text-right font-semibold" scope="col">
                  reference
                </th>
                <th className="pb-1 text-right font-semibold" scope="col">
                  Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <MetricLine key={row.key} reference={reference.results} row={row} step={step} yours={yours} />
              ))}
            </tbody>
          </table>
          <p className="text-ink-400 mt-1.5 text-[11px]">
            Counted by the runtime's Redis, broker, gRPC, Postgres and clock while each check ran; the harness's own
            calls are not included, and hovering a figure lists it per check. Fewer is not always better — the debrief
            says why the reference is shaped the way it is.
          </p>
        </>
      )}
    </section>
  );
});
Comparison.displayName = 'ReferenceComparison';

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
  /** The step's file runs in the browser as a program (a PyTorch step): Run executes its self-test. */
  program: boolean;
  /** A submission is being executed. */
  running: boolean;
  runtime: RuntimeStatus;
  /** Title of the step after this one; absent on the last step. */
  nextTitle?: string;
  /** Go to the next step (shown on an accepted verdict). */
  onNext?: () => void;
  /** LinkedIn composer prefilled for this step; offered once accepted. */
  shareUrl?: string;
  /** Every step of the course is accepted: open the certificate. */
  onCertificate?: () => void;
  /** Open a past submission's code (only submissions that kept their code offer it). */
  onViewSubmission?: (submission: Submission) => void;
  /** Run the reference solution through the same checks and compare what each did. */
  onCompare?: () => void;
  /** The reference's verdict for this step, once compared. */
  reference?: Verdict | null;
  /** The reference is running. */
  comparing?: boolean;
  /** A GitHub issue prefilled for this step and the last verdict. */
  issueUrl?: string;
  /** The last run's console. */
  consoleRun: ConsoleRun | null;
  /** Which view the panel shows: the checks or the console. */
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
}> = memo(
  ({
    step,
    language,
    verdict,
    attempt,
    earned,
    stale,
    executes,
    program,
    running,
    runtime,
    nextTitle,
    onNext,
    shareUrl,
    onCertificate,
    onViewSubmission,
    onCompare,
    reference = null,
    comparing = false,
    issueUrl,
    consoleRun,
    tab,
    onTab,
  }) => {
    const showShape = attempt.wrong >= SHAPE_AFTER_WRONG;
    const runError = verdict?.run?.error;
    /** Every failing check reported the same thing (typically one unimplemented function): say it once. */
    const common = useMemo(() => {
      if (verdict === null || verdict.accepted || verdict.trial === true) return null;
      const failing = verdict.results.filter(r => !r.passed);
      const first = failing[0]?.message;
      return first !== undefined && failing.every(r => r.message === first) ? first : null;
    }, [verdict]);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-ink-700 text-ink-300 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
          {executes || program ? (
            <PanelTabs consoleRun={consoleRun} onTab={onTab} tab={tab} />
          ) : (
            <span className="text-iris-400 font-bold uppercase tracking-wider">Checks</span>
          )}
          <span className="font-code">
            {step.checks.length} for this step · {attempt.wrong} wrong submission{attempt.wrong === 1 ? '' : 's'}
          </span>
          {executes || program ? (
            <span
              className="border-iris-400/40 bg-iris-400/10 text-iris-200 rounded-full border px-2 py-0.5 text-[10px]"
              title={
                program
                  ? 'your file runs in the browser as a program: Python with PyTorch on the CPU, single-threaded; the checks read its shape'
                  : `your code runs in the browser: ${LANGUAGE_LABEL[language]}, Redis, Kafka, gRPC and Postgres in-page; these checks exercise it`
              }>
              runs in the browser
            </span>
          ) : null}
          {running ? (
            <span className="text-iris-200 ml-auto flex items-center gap-1.5">
              <span className="bg-iris-300 h-1.5 w-1.5 animate-pulse rounded-full" />
              {runtime.state === 'booting'
                ? STATUS_TEXT[runtime.phase]
                : program
                ? 'running your program…'
                : 'running your code…'}
            </span>
          ) : stale && verdict !== null ? (
            <span className="text-warning-300 ml-auto">
              edited since the last {verdict.trial === true ? 'run' : 'submit'}
            </span>
          ) : null}
        </div>
        <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {tab === 'console' ? (
            <ConsoleView
              idle={
                program
                  ? `Run (${RUN_KEYS}) runs ${fileName(
                      step.file,
                      language,
                    )} as a program here in the browser — Python with PyTorch on the CPU — and shows what it prints.`
                  : `What your code prints when you Run (${RUN_KEYS}) or Submit (${SUBMIT_KEYS}) shows here.`
              }
              run={consoleRun}
            />
          ) : (
            <>
              {verdict === null ? (
                <p className="text-ink-300 mb-2 text-[12px]">
                  {executes
                    ? `Run (${RUN_KEYS}) tries the example check — the first one — without recording anything. Submit (${SUBMIT_KEYS}) runs all ${step.checks.length} checks and counts; each one exercises your implementation and reports what it observed. The first run downloads ${RUNTIME_DOWNLOAD[language]}.`
                    : program
                    ? `Submit (${SUBMIT_KEYS}) checks the shape of your code: each check is a property a correct implementation has. Run (${RUN_KEYS}) runs ${fileName(
                        step.file,
                        language,
                      )} here in the browser as a program — Python with PyTorch on the CPU — and shows its self-test in the console; nothing is recorded. The first run downloads PyTorch (~40 MB).`
                    : `Submit (${SUBMIT_KEYS}) to run the checks. Each one is a property a correct implementation has; failures show what was expected.`}
                </p>
              ) : runError !== undefined ? (
                <div className="border-warning-400/60 bg-warning-400/10 mb-3 rounded-xl border p-3">
                  <p className="text-warning-300 text-[11px] font-bold uppercase tracking-wider">Runtime</p>
                  <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Could not run</p>
                  <p className="text-warning-200 mt-0.5 text-[12px]">{runError}. This did not count as a submission.</p>
                </div>
              ) : verdict.trial === true ? (
                <div
                  className={`mb-3 rounded-xl border p-3 ${
                    verdict.accepted ? 'border-iris-400/60 bg-iris-400/10' : 'border-warning-400/60 bg-warning-400/10'
                  }`}>
                  <p
                    className={`text-[11px] font-bold uppercase tracking-wider ${
                      verdict.accepted ? 'text-iris-300' : 'text-warning-300'
                    }`}>
                    Run · example only
                  </p>
                  <p className="text-ink-50 mt-0.5 text-lg font-extrabold">
                    {verdict.accepted ? 'Example passed' : 'Example failed'}
                  </p>
                  <p className={`mt-0.5 text-[12px] ${verdict.accepted ? 'text-iris-200' : 'text-warning-200'}`}>
                    {verdict.accepted
                      ? `Check 1 passed${
                          verdict.run !== undefined ? ` in ${verdict.run.ms} ms` : ''
                        }; nothing was recorded. Submit (${SUBMIT_KEYS}) runs all ${
                          step.checks.length
                        } checks and scores the step.`
                      : `Check 1 failed; nothing was recorded. The message under it says what the harness observed.`}
                  </p>
                </div>
              ) : verdict.accepted ? (
                <div className="border-success-400/60 bg-success-400/10 mb-3 flex flex-wrap items-center gap-3 rounded-xl border p-3">
                  <div className="min-w-0 flex-1">
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
                      {attempt.status === 'revealed' ? ' · this step was revealed, so it scores 0' : ''}.
                      {onNext === undefined
                        ? onCertificate !== undefined
                          ? ' That was the last step: the course is complete and your certificate is ready.'
                          : ' That was the last step — read the debrief in the step pane.'
                        : ' The debrief is in the step pane when you want it.'}
                    </p>
                    {shareUrl !== undefined && attempt.status === 'accepted' ? (
                      <div className="-ml-1.5 mt-1.5">
                        <LinkedInButton label="Share this step on LinkedIn" title={POST_HINT} url={shareUrl} />
                      </div>
                    ) : null}
                  </div>
                  {onNext !== undefined ? (
                    <button
                      className="bg-success-400 text-ink-950 hover:bg-success-300 shrink-0 rounded-lg px-3 py-1.5 text-left text-[12px] font-bold transition"
                      onClick={onNext}
                      title={nextTitle}
                      type="button">
                      next step →
                      {nextTitle !== undefined ? (
                        <span className="block max-w-[14rem] truncate text-[11px] font-normal opacity-80">
                          {nextTitle}
                        </span>
                      ) : null}
                    </button>
                  ) : onCertificate !== undefined ? (
                    <button
                      className="bg-success-400 text-ink-950 hover:bg-success-300 shrink-0 rounded-lg px-3 py-1.5 text-left text-[12px] font-bold transition"
                      onClick={onCertificate}
                      type="button">
                      Get your certificate
                      <span className="block text-[11px] font-normal opacity-80">
                        download · add to LinkedIn · share
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="border-danger-400/60 bg-danger-400/10 mb-3 rounded-xl border p-3">
                  <p className="text-danger-300 text-[11px] font-bold uppercase tracking-wider">Result</p>
                  <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Wrong Answer</p>
                  <p className="text-danger-200 mt-0.5 text-[12px]">
                    {verdict.passed}/{verdict.total} checks passed.{' '}
                    {common !== null
                      ? 'Every failing check hit the same thing:'
                      : verdict.run !== undefined
                      ? 'Each failing check says what it observed.'
                      : showShape
                      ? 'Failing checks now show the shape the judge expects.'
                      : `Fix the failing ones and submit again — after ${SHAPE_AFTER_WRONG} wrong submissions, failing checks show the exact shape the judge expects.`}
                  </p>
                  {common !== null ? <p className="font-code text-ink-50 mt-1.5 text-[12px]">{common}</p> : null}
                </div>
              )}
              {verdict !== null &&
              verdict.accepted &&
              verdict.trial !== true &&
              verdict.run !== undefined &&
              onCompare !== undefined ? (
                <Comparison
                  comparing={comparing}
                  file={fileName(step.file, language)}
                  onCompare={onCompare}
                  reference={reference}
                  step={step}
                  yours={verdict.results}
                />
              ) : null}
              <ul className="space-y-1.5">
                {step.checks.map((check, i) => {
                  const result = verdict?.results.find(r => r.id === check.id) ?? null;
                  const tone =
                    result === null
                      ? 'border-ink-700 bg-ink-850'
                      : result.passed
                      ? 'border-success-400/40 bg-success-400/5'
                      : 'border-danger-400/50 bg-danger-400/5';
                  return (
                    <li className={`rounded-lg border px-3 py-2 ${tone}`} key={check.id}>
                      <p className="text-ink-100 flex items-center gap-2 text-[13px]">
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
                        {executes && i === 0 ? (
                          <span
                            className="border-ink-600 text-ink-400 shrink-0 rounded-full border px-1.5 text-[10px]"
                            title={`the check Run (${RUN_KEYS}) exercises without recording anything`}>
                            example
                          </span>
                        ) : null}
                        {result !== null && result.shape !== undefined && result.shape !== result.passed ? (
                          <span
                            className={`ml-auto shrink-0 rounded-full border px-1.5 text-[10px] ${
                              result.passed ? 'border-ink-600 text-ink-400' : 'border-warning-400/50 text-warning-300'
                            }`}
                            title={
                              result.passed
                                ? 'Your code passes this check but is shaped differently from the reference solution — that is fine; the runtime result decides.'
                                : 'Your code is shaped like the reference solution but does not pass when run: the logic, not the spelling, is off.'
                            }>
                            {result.passed ? 'unlike the reference' : 'looks right, fails'}
                          </span>
                        ) : null}
                      </p>
                      {result !== null && !result.passed ? (
                        <>
                          {result.message !== undefined && result.message !== common ? (
                            <p className="font-code text-danger-200 mt-1 pl-6 text-[12px]">{result.message}</p>
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
              <Submissions history={attempt.history ?? EMPTY_HISTORY} onView={onViewSubmission} />
              {issueUrl !== undefined ? (
                <p className="text-ink-500 mt-3 text-[11px]">
                  Something wrong with this step — the task, a hint, a check, the verdict?{' '}
                  <a
                    className="text-iris-300 hover:text-iris-200 transition"
                    href={issueUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="opens a GitHub issue prefilled with the step, the language, your browser and the last verdict">
                    report it ›
                  </a>
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  },
);
VerdictPane.displayName = 'VerdictPane';

export default VerdictPane;
