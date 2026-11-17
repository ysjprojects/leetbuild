import Link from 'next/link';
import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {checkGuideLinks} from '@/data/guides/checkSections';
import type {BottomTab, ConsoleRun} from '@/lib/console';
import {type CheckResult, type Verdict, commonMessage, describeMatcher, judge} from '@/lib/judge';
import {type MetricRow, comparedRows, metricByCheck, total} from '@/lib/metrics';
import {scrollBehavior} from '@/lib/motion';
import {type CompileFailure, type MessagePart, compileFailure, layoutMessage} from '@/lib/outcome';
import type {RuntimeStatus} from '@/lib/runtime/client';
import type {Phase} from '@/lib/runtime/types';
import type {StepAttempt, Submission} from '@/lib/scoring';
import {type Language, type Step, type StepCheck, fileName, LANGUAGE_LABEL} from '@/lib/types';

import {InlineMarkdown} from './Markdown';
import {ShapeNote} from './paneShared';
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

/** The languages the browser runtime executes: Scala is compiled offline, CUDA is judged by its shape. */
type Executing = Exclude<Language, 'scala' | 'cuda'>;

const isExecuting = (language: Language): language is Executing => language !== 'scala' && language !== 'cuda';

/** What the first run fetches, per executing language (the idle copy under the checks). */
const RUNTIME_DOWNLOAD: Record<Executing, string> = {
  python: 'the Python runtime (~10 MB)',
  typescript: 'the TypeScript compiler (~14 MB)',
  go: 'the Go interpreter (~9 MB)',
  cpp: 'the C++ compiler and its libraries (~30 MB)',
};

/** The boot phases each runtime reports, in order; a PyTorch program's run adds `torch`. */
const BOOT: Record<Executing, readonly Phase[]> = {
  python: ['pyodide', 'packages', 'runtime'],
  typescript: ['esbuild', 'runtime'],
  go: ['go', 'runtime'],
  cpp: ['clang'],
};

/** A stage of the wait for a verdict: as the headline while it happens, as a line of the list, in the header. */
interface Stage {
  doing: string;
  step: string;
  short: string;
}

const PHASE: Record<Phase, Stage> = {
  pyodide: {
    doing: 'Downloading the Python runtime',
    step: 'Download the Python runtime (~10 MB)',
    short: 'downloading Python…',
  },
  packages: {doing: 'Loading FastAPI, Redis and protobuf', step: 'Load FastAPI, Redis and protobuf', short: 'loading…'},
  esbuild: {
    doing: 'Downloading the TypeScript compiler',
    step: 'Download the TypeScript compiler (~14 MB)',
    short: 'downloading TypeScript…',
  },
  go: {doing: 'Downloading the Go interpreter', step: 'Download the Go interpreter (~9 MB)', short: 'downloading Go…'},
  runtime: {doing: 'Installing the LeetBuild runtime', step: 'Install the LeetBuild runtime', short: 'installing…'},
  torch: {doing: 'Loading PyTorch', step: 'Load PyTorch (~40 MB)', short: 'loading PyTorch…'},
  clang: {
    doing: 'Downloading the C++ compiler',
    step: 'Download the C++ compiler and its libraries (~30 MB)',
    short: 'downloading C++…',
  },
};

/** A Run or Submit in flight: which button, and when it was pressed. */
type Pending = {kind: 'run' | 'submit'; since: number};

/** Whether a C++ run has compiled on this page: the first compile is the slow one. */
let cppCompiled = false;

/** The stage after the boot: the run itself (a C++ run compiles first). */
const runStage = (
  pending: Pending | null,
  language: Language,
  program: boolean,
  checks: number,
  file: string,
): Stage => {
  if (pending === null) return {doing: 'Running your code', step: 'Run your code', short: 'running…'};
  if (program && pending.kind === 'run') return {doing: `Running ${file}`, step: `Run ${file}`, short: 'running…'};
  const what = pending.kind === 'run' ? 'the example check' : `${checks} checks`;
  return language === 'cpp'
    ? {doing: `Compiling, then running ${what}`, step: `Compile, then run ${what}`, short: 'compiling…'}
    : {doing: `Running ${what}`, step: `Run ${what}`, short: 'running…'};
};

interface Wait {
  /** What is happening now. */
  now: Stage;
  /** Every stage of this wait, in order, when the runtime is booting for it (else just the run). */
  stages: readonly Stage[];
  /** The index of `now` in `stages`. */
  at: number;
}

/** Where the wait stands: the runtime's boot phase while it boots (when it booted for this run), then the run. */
const waitFor = (runtime: RuntimeStatus, booted: boolean, language: Language, program: boolean, run: Stage): Wait => {
  const phase = runtime.state === 'booting' ? runtime.phase : null;
  if (!booted && phase === null) return {now: run, stages: [run], at: 0};
  const boot: Phase[] = isExecuting(language) ? [...BOOT[language]] : [];
  if (program) boot.push('torch');
  if (phase !== null && !boot.includes(phase)) boot.push(phase);
  const stages = [...boot.map(p => PHASE[p]), run];
  const at = phase === null ? boot.length : boot.indexOf(phase);
  return {now: stages[at], stages, at};
};

/**
 * A failure that comes before the check's own logic: the code does not compile, parse or import, or the
 * function is not implemented yet. Every check that reaches it fails the same way, whatever its shape.
 */
const UNREACHED =
  /^(?:your code does not compile|the harness does not compile|the harness failed to load|the course's \.proto files|(?:SyntaxError|IndentationError|TabError|ImportError|ModuleNotFoundError|NotImplementedError)\b|Error: Cannot find module)|\bnot implemented\b/;

const firstLine = (text: string): string => text.split('\n')[0];

/** The verdict as the status line says it: short, with no glyphs. */
const verdictSays = (verdict: Verdict, earned: number | null): string => {
  const failure = compileFailure(verdict.results, verdict.run?.error);
  const error = failure?.message ?? verdict.run?.error;
  if (error !== undefined)
    return `Could not run: ${firstLine(error)}. ${
      verdict.trial === true ? 'Nothing was recorded' : 'It did not count'
    }.`;
  if (verdict.trial === true) return verdict.accepted ? 'Example check passed' : 'Example check failed';
  if (verdict.accepted)
    return earned !== null && earned > 0 ? `Accepted, plus ${earned} point${earned === 1 ? '' : 's'}` : 'Accepted';
  return `Wrong answer: ${verdict.passed} of ${verdict.total} checks passed`;
};

/** The wait as the status line says it. */
const waitSays = (pending: Pending | null, program: boolean, checks: number, file: string): string =>
  pending === null
    ? 'Running your code'
    : pending.kind === 'submit'
    ? `Running ${checks} checks`
    : program
    ? `Running ${file}`
    : 'Running the example check';

/** A finished program run, as the status line says it. */
const programSays = (run: ConsoleRun, file: string): string | null =>
  run.error !== undefined
    ? `Could not run: ${firstLine(run.error)}`
    : run.exit !== undefined
    ? `${file} exited with status ${run.exit}`
    : null;

/**
 * The wait for a verdict, where the verdict will show: the button pressed, the seconds so far, what
 * the runtime is doing and what is left.
 */
const WaitPanel: FC<{label: string; since: number | null; wait: Wait; note: string | null}> = memo(
  ({label, since, wait, note}) => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      if (since === null) return undefined;
      setNow(Date.now());
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }, [since]);
    const seconds = since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
    return (
      <div className="border-iris-400/60 bg-iris-400/10 mb-3 rounded-xl border p-3">
        <p className="flex items-baseline justify-between gap-2">
          <span className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">{label}</span>
          {seconds !== null ? (
            <span className="font-code text-iris-200 text-[12px] tabular-nums">{seconds} s</span>
          ) : null}
        </p>
        <p className="text-ink-50 mt-0.5 flex items-center gap-2 text-lg font-extrabold">
          <span className="bg-iris-300 h-2 w-2 shrink-0 animate-pulse rounded-full" />
          {wait.now.doing}
        </p>
        {wait.stages.length > 1 ? (
          <ol className="mt-1.5 space-y-0.5 text-[12px]">
            {wait.stages.map((stage, i) => (
              <li
                className={`flex items-center gap-2 ${
                  i < wait.at ? 'text-ink-300' : i === wait.at ? 'text-iris-200 font-semibold' : 'text-ink-400'
                }`}
                key={stage.step}>
                <span aria-hidden className="font-code w-3 shrink-0 text-center">
                  {i < wait.at ? '✓' : i === wait.at ? '›' : '·'}
                </span>
                {stage.step}
              </li>
            ))}
          </ol>
        ) : null}
        {note !== null ? <p className="text-iris-200 mt-1.5 text-[12px]">{note}</p> : null}
      </div>
    );
  },
);
WaitPanel.displayName = 'WaitPanel';

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

/** A folded value's text to read: JSON indented, anything else (a Python repr, a Go map) as it came. */
const readable = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

/** One line of a check's message: its text, each long value a toggle that opens it under the line. */
const MessageLine: FC<{parts: readonly MessagePart[]; className: string; where?: string | null}> = memo(
  ({parts, className, where = null}) => {
    const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
    const toggle = useCallback(
      (k: number) =>
        setOpen(previous => {
          const next = new Set(previous);
          if (!next.delete(k)) next.add(k);
          return next;
        }),
      [],
    );
    return (
      <div className={className}>
        <p className="whitespace-pre-wrap break-words">
          {parts.map((part, k) =>
            'text' in part ? (
              <span key={k}>{part.text}</span>
            ) : (
              <button
                aria-expanded={open.has(k)}
                className="text-iris-300 hover:text-iris-200 font-sans text-[11px] font-semibold transition"
                key={k}
                onClick={() => toggle(k)}
                title={`${part.value.length} characters`}
                type="button">
                <span className="font-code">{part.value.startsWith('[') ? '[…]' : '{…}'}</span>{' '}
                {open.has(k) ? 'hide' : 'show'} {part.label} {open.has(k) ? '‹' : '›'}
              </button>
            ),
          )}
          {where !== null ? <span className="text-ink-400">{where}</span> : null}
        </p>
        {parts.map((part, k) =>
          'value' in part && open.has(k) ? (
            <pre
              className="border-ink-700 bg-ink-950 text-ink-100 my-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border px-2 py-1 text-[11px]"
              key={k}>
              {readable(part.value)}
            </pre>
          ) : null,
        )}
      </div>
    );
  },
);
MessageLine.displayName = 'MessageLine';

/**
 * A check's message, laid out to read: what it expected first, then what it observed with long
 * values (a response body, a stored record) folded, then where it was raised.
 */
const CheckMessage: FC<{message: string; className: string; tone?: string}> = memo(
  ({message, className, tone = 'text-danger-200'}) => {
    const layout = useMemo(() => layoutMessage(message), [message]);
    return (
      <div className={`font-code ${className}`}>
        {layout.expected !== null ? <MessageLine className={tone} parts={layout.expected} /> : null}
        <MessageLine
          className={layout.expected !== null ? 'text-ink-300' : tone}
          parts={layout.observed}
          where={layout.where}
        />
      </div>
    );
  },
);
CheckMessage.displayName = 'CheckMessage';

/** A compile failure's message with its `file:line` a button that shows that line in the editor. */
const FailureMessage: FC<{failure: CompileFailure; onRevealLine?: (file: string, line: number) => void}> = memo(
  ({failure, onRevealLine}) => {
    const {message, file, line} = failure;
    const place = file !== undefined && line !== undefined ? `${file}:${line}` : null;
    const at = place === null || onRevealLine === undefined ? -1 : message.indexOf(place);
    if (at < 0 || file === undefined || line === undefined || onRevealLine === undefined)
      return <p className="font-code text-ink-50 mt-1.5 whitespace-pre-wrap break-words text-[12px]">{message}</p>;
    return (
      <p className="font-code text-ink-50 mt-1.5 whitespace-pre-wrap break-words text-[12px]">
        {message.slice(0, at)}
        <button
          className="text-warning-200 hover:text-ink-50 font-semibold underline underline-offset-2 transition"
          onClick={() => onRevealLine(file, line)}
          title={`show line ${line} of ${file} in the editor`}
          type="button">
          {place}
        </button>
        {message.slice(at + (place?.length ?? 0))}
      </p>
    );
  },
);
FailureMessage.displayName = 'FailureMessage';

/** `?from=` on a guide link, before its `#section`: the guide's back link returns to this step. */
const withFrom = (href: string, from: string | undefined): string => {
  if (from === undefined) return href;
  const hash = href.indexOf('#');
  const [path, section] = hash < 0 ? [href, ''] : [href.slice(0, hash), href.slice(hash)];
  return `${path}?from=${encodeURIComponent(from).replace(/%2F/g, '/')}${section}`;
};

/** The guide sections that explain why a check fails, once the check is mapped to them. */
const WhyLinks: FC<{problemId: string; stepId: string; checkId: string; from?: string}> = memo(
  ({problemId, stepId, checkId, from}) => {
    const links = useMemo(() => checkGuideLinks(problemId, stepId, checkId), [problemId, stepId, checkId]);
    if (links.length === 0) return null;
    return (
      <ul className="mt-1 space-y-0.5 pl-6 text-[12px]">
        {links.map(link => (
          <li key={link.href}>
            <Link
              className="text-iris-300 hover:text-iris-200 transition"
              href={withFrom(link.href, from)}
              title="opens the guide at the section that explains this check">
              Why this fails: <span className="font-semibold">{link.label}</span> ›
            </Link>
          </li>
        ))}
      </ul>
    );
  },
);
WhyLinks.displayName = 'WhyLinks';

const formatTime = (at: number): string => {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
  return sameDay ? time : `${d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} ${time}`;
};

/**
 * One past submission; when it recorded its checks and some failed, it opens into them: each failing
 * check's number, title and what it observed.
 */
const SubmissionRow: FC<{
  submission: Submission;
  checks: readonly StepCheck[];
  onView?: (submission: Submission) => void;
}> = memo(({submission: s, checks, onView}) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  const failing = useMemo(() => (s.checks ?? []).filter(c => !c.passed), [s.checks]);
  const outcome = (
    <>
      <span className={s.accepted ? 'text-success-300' : 'text-danger-300'}>
        {s.accepted ? 'Accepted' : 'Wrong Answer'}
      </span>
      <span className="text-ink-300">
        {s.passed}/{s.total}
      </span>
    </>
  );
  return (
    <li className="py-0.5">
      <div className="flex items-center gap-3">
        {failing.length > 0 ? (
          <button
            aria-expanded={open}
            className="hover:bg-ink-800 -ml-1 flex items-center gap-3 rounded px-1 text-left transition"
            onClick={toggle}
            title={open ? 'hide the failing checks' : 'show the checks this submission failed'}
            type="button">
            <span aria-hidden className="text-ink-400 w-2 text-[9px]">
              {open ? '▼' : '▶'}
            </span>
            {outcome}
          </button>
        ) : (
          outcome
        )}
        <span className="text-ink-400">{LANGUAGE_LABEL[s.language]}</span>
        {s.code !== undefined && onView !== undefined ? <SubmissionLink onView={onView} submission={s} /> : null}
        <span className="text-ink-400 ml-auto">{formatTime(s.at)}</span>
      </div>
      {open ? (
        <ul className="border-ink-700 mb-1 ml-1 mt-1 space-y-1 border-l pl-3">
          {failing.map(c => {
            const index = checks.findIndex(check => check.id === c.id);
            return (
              <li key={c.id}>
                <p className="text-ink-100 flex items-baseline gap-2">
                  <span className="text-danger-300">✗</span>
                  {index >= 0 ? <span className="text-ink-400 text-[10px]">{index + 1}</span> : null}
                  <span className="font-sans font-semibold">{index >= 0 ? checks[index].title : c.id}</span>
                </p>
                {c.message !== undefined ? <CheckMessage className="pl-5" message={c.message} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
});
SubmissionRow.displayName = 'SubmissionRow';

const Submissions: FC<{
  history: readonly Submission[];
  checks: readonly StepCheck[];
  onView?: (submission: Submission) => void;
}> = memo(({history, checks, onView}) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  if (history.length === 0) return null;
  return (
    <div className="border-ink-700 bg-ink-850 mt-3 rounded-lg border">
      <button
        aria-expanded={open}
        className="text-ink-300 hover:text-ink-50 flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider"
        onClick={toggle}
        type="button">
        <span>Submissions ({history.length})</span>
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
      </button>
      {open ? (
        <ul className="border-ink-700 font-code border-t px-3 py-1.5 text-[11px]">
          {[...history].reverse().map((s, i) => (
            <SubmissionRow checks={checks} key={`${s.at}-${i}`} onView={onView} submission={s} />
          ))}
        </ul>
      ) : null}
    </div>
  );
});
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
export const SubmissionCode: FC<{code: string; current: string | null; language: Language; label?: string}> = memo(
  ({code, current, language, label}) => {
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
          label={label}
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
        active ? 'bg-ink-700 text-iris-200' : 'text-ink-400 hover:text-ink-100'
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

/**
 * The last run's output, line by line as it was printed (stderr in red), then, as a test runner
 * would print them, the checks it ran with why each failed, and how the run ended.
 */
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
  const checks = run.checks ?? [];
  const failed = checks.filter(check => !check.passed).length;
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
      {checks.map((check, i) => (
        <div className={`mt-1 ${check.passed ? 'text-success-300' : 'text-danger-300'}`} key={i}>
          <p>
            {check.passed ? '✓' : '✗'} {check.title}
          </p>
          {!check.passed && check.message !== undefined ? (
            <pre className="whitespace-pre-wrap break-words pl-3">{check.message}</pre>
          ) : null}
        </div>
      ))}
      {running ? (
        <p className="text-iris-300 animate-pulse">▍</p>
      ) : run.error !== undefined ? (
        <p className="text-warning-300 mt-1">✗ {run.error}</p>
      ) : run.exit !== undefined ? (
        <p className={`mt-1 ${run.exit === 0 ? 'text-success-300' : 'text-danger-300'}`}>
          {run.exit === 0 ? '✓' : '✗'} exited with status {run.exit}
          {seconds}
        </p>
      ) : checks.length > 0 ? (
        <p className={`mt-1 ${failed === 0 ? 'text-success-300' : 'text-danger-300'}`}>
          {failed === 0
            ? '✓ passed'
            : checks.length === 1
            ? '✗ failed'
            : `✗ ${failed} of ${checks.length} checks failed`}
          {seconds}
          {count === 0 ? ' · nothing printed' : ''}
        </p>
      ) : (
        <p className="text-ink-400 mt-1">
          done{seconds}
          {count === 0 ? ' · nothing printed' : ''}
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
  /** A Run or Submit is executing: which button was pressed and when (`Date.now()`). */
  pending?: Pending | null;
  /** Switch the problem pane to the step tab and scroll the debrief into view. */
  onShowDebrief?: () => void;
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
  /** Show a line of a file in the editor: a compile failure's `file:line`. */
  onRevealLine?: (file: string, line: number) => void;
  /** The course, to link each failing check to the guide sections that explain it. */
  problemId?: string;
  /** This step's address, so a guide opened from a check leads back here. */
  stepHref?: string;
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
    pending = null,
    onShowDebrief,
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
    onRevealLine,
    problemId,
    stepHref,
  }) => {
    const showShape = attempt.wrong >= SHAPE_AFTER_WRONG;
    const runError = verdict?.run?.error;
    /** The code never got to run (a compile, syntax or import error): one card, nothing counted. */
    const failure = useMemo(
      () => (verdict === null ? null : compileFailure(verdict.results, verdict.run?.error)),
      [verdict],
    );
    /** No check was decided: the rows stay unrun under the card that says why. */
    const undecided = failure !== null || runError !== undefined;
    /** Every failing check reported the same thing (typically one unimplemented function): say it once. */
    const common = useMemo(() => (verdict === null ? null : commonMessage(verdict)), [verdict]);
    /** Checks whose static pattern already matches the starter: their shape cannot tell the starter from a fix. */
    const starterShapes = useMemo(() => {
      const starter = step.code[language]?.starter;
      return new Set(
        starter === undefined
          ? []
          : judge(step, language, starter)
              .results.filter(r => r.passed)
              .map(r => r.id),
      );
    }, [step, language]);
    /** Every failing check, two or more, hit the same thing: a shared reason, not each check's logic. */
    const shared = runError !== undefined || (common !== null && (verdict?.total ?? 0) - (verdict?.passed ?? 0) > 1);
    /** "looks right, fails" says the logic is off: not when the code never reached the logic, nor when the starter looks right too. */
    const quietShape = (result: CheckResult): boolean =>
      !result.passed && (shared || UNREACHED.test(result.message ?? '') || starterShapes.has(result.id));
    const file = fileName(step.file, language);
    const checkCount = step.checks.length;
    const busy = running || pending !== null;
    /** The runtime booted during this wait: its phases are part of what the wait shows. */
    const [booted, setBooted] = useState(false);
    useEffect(() => {
      if (!busy) setBooted(false);
      else if (runtime.state === 'booting') setBooted(true);
    }, [busy, runtime.state]);
    const wait = busy
      ? waitFor(runtime, booted, language, program, runStage(pending, language, program, checkCount, file))
      : null;
    useEffect(() => {
      if (language === 'cpp' && verdict?.run !== undefined && verdict.run.error === undefined) cppCompiled = true;
    }, [language, verdict]);
    const waitNote =
      language === 'cpp' && !cppCompiled ? 'The first C++ compile takes 10 to 15 s; later ones are quicker.' : null;
    const waitLabel =
      pending === null
        ? 'Running'
        : pending.kind === 'submit'
        ? 'Submit · scored'
        : program
        ? 'Run'
        : 'Run · example only';
    /** The one line a screen reader hears: the wait, then the verdict, briefly. */
    const [said, setSaid] = useState('');
    const waiting = busy ? waitSays(pending, program, checkCount, file) : null;
    const waitKey = pending?.since ?? (running ? 0 : null);
    useEffect(() => {
      if (waiting !== null) setSaid(waiting);
    }, [waiting, waitKey]);
    useEffect(() => {
      if (verdict !== null) setSaid(verdictSays(verdict, earned));
    }, [verdict, earned]);
    useEffect(() => {
      const ended = program && consoleRun !== null && !consoleRun.running ? programSays(consoleRun, file) : null;
      if (ended !== null) setSaid(ended);
    }, [program, consoleRun, file]);
    /** Each new verdict, and each new wait, scrolls the pane to its card. */
    const scroller = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const pane = scroller.current;
      const target = card.current;
      if ((verdict === null && waitKey === null) || pane === null || target === null) return;
      const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTo({top: Math.max(0, top - 8), behavior: scrollBehavior()});
    }, [verdict, waitKey]);
    const waitPanel =
      wait !== null ? (
        <div ref={card}>
          <WaitPanel label={waitLabel} note={waitNote} since={pending?.since ?? null} wait={wait} />
        </div>
      ) : null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p className="sr-only" role="status">
          {said}
        </p>
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
          {wait !== null ? (
            <span className="text-iris-200 ml-auto flex items-center gap-1.5">
              <span className="bg-iris-300 h-1.5 w-1.5 animate-pulse rounded-full" />
              {wait.now.short}
            </span>
          ) : stale && verdict !== null ? (
            <span className="text-warning-300 ml-auto">
              edited since the last {verdict.trial === true ? 'run' : 'submit'}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" ref={scroller}>
          {tab === 'console' ? (
            <>
              {waitPanel}
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
            </>
          ) : (
            <>
              {waitPanel ??
                (verdict === null ? (
                  <p className="text-ink-300 mb-2 text-[12px]">
                    {executes
                      ? `Run (${RUN_KEYS}) tries the example check, the first one, without recording anything. Submit (${SUBMIT_KEYS}) runs all ${
                          step.checks.length
                        } checks and counts; each one exercises your implementation and reports what it observed.${
                          isExecuting(language) ? ` The first run downloads ${RUNTIME_DOWNLOAD[language]}.` : ''
                        }`
                      : program
                      ? `Submit (${SUBMIT_KEYS}) checks the shape of your code: each check is a property a correct implementation has. Run (${RUN_KEYS}) runs ${fileName(
                          step.file,
                          language,
                        )} here in the browser as a program — Python with PyTorch on the CPU — and shows its self-test in the console; nothing is recorded. The first run downloads PyTorch (~40 MB).`
                      : `Submit (${SUBMIT_KEYS}) to run the checks. Each one is a property a correct implementation has; failures show what was expected.`}
                  </p>
                ) : (
                  <div ref={card}>
                    {failure !== null ? (
                      <div className="border-warning-400/60 bg-warning-400/10 mb-3 rounded-xl border p-3">
                        <p className="text-warning-300 text-[11px] font-bold uppercase tracking-wider">
                          {verdict.trial === true ? 'Run' : 'Submit'}
                        </p>
                        <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Could not run</p>
                        <FailureMessage failure={failure} onRevealLine={onRevealLine} />
                        <p className="text-warning-200 mt-1.5 text-[12px]">
                          No check ran, so{' '}
                          {verdict.trial === true ? 'nothing was recorded' : 'this did not count as a submission'}.
                        </p>
                      </div>
                    ) : runError !== undefined ? (
                      <div className="border-warning-400/60 bg-warning-400/10 mb-3 rounded-xl border p-3">
                        <p className="text-warning-300 text-[11px] font-bold uppercase tracking-wider">Runtime</p>
                        <p className="text-ink-50 mt-0.5 text-lg font-extrabold">Could not run</p>
                        <p className="text-warning-200 mt-0.5 text-[12px]">
                          {runError}. This did not count as a submission.
                        </p>
                      </div>
                    ) : verdict.trial === true ? (
                      <div
                        className={`mb-3 rounded-xl border p-3 ${
                          verdict.accepted
                            ? 'border-iris-400/60 bg-iris-400/10'
                            : 'border-warning-400/60 bg-warning-400/10'
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
                              <span className="font-code text-success-200 ml-2 text-[13px] font-semibold">
                                +{earned} pts
                              </span>
                            ) : null}
                          </p>
                          <p className="text-success-200 mt-0.5 text-[12px]">
                            {verdict.passed}/{verdict.total} checks passed
                            {verdict.run !== undefined ? ` in ${verdict.run.ms} ms` : ''}
                            {attempt.status === 'revealed' ? ' · this step was revealed, so it scores 0' : ''}.
                            {onNext === undefined
                              ? onCertificate !== undefined
                                ? ' That was the last step: the course is complete and your certificate is ready.'
                                : ' That was the last step.'
                              : ''}
                            {onShowDebrief !== undefined ? (
                              <>
                                {' '}
                                <button
                                  className="text-success-300 hover:text-success-200 font-semibold underline underline-offset-2 transition"
                                  onClick={onShowDebrief}
                                  title="opens the step tab at the debrief"
                                  type="button">
                                  Read the debrief
                                </button>
                                : why the solution is shaped this way.
                              </>
                            ) : onNext !== undefined ? (
                              ' The debrief is in the step pane when you want it.'
                            ) : onCertificate === undefined ? (
                              ' Read the debrief in the step pane.'
                            ) : null}
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
                              <span className="block max-w-[14rem] truncate text-[11px] font-normal">{nextTitle}</span>
                            ) : null}
                          </button>
                        ) : onCertificate !== undefined ? (
                          <button
                            className="bg-success-400 text-ink-950 hover:bg-success-300 shrink-0 rounded-lg px-3 py-1.5 text-left text-[12px] font-bold transition"
                            onClick={onCertificate}
                            type="button">
                            Get your certificate
                            <span className="block text-[11px] font-normal">download · add to LinkedIn · share</span>
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
                        {common !== null ? (
                          <CheckMessage className="mt-1.5 text-[12px]" message={common} tone="text-ink-50" />
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
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
              <ul aria-busy={busy} className="space-y-1.5">
                {step.checks.map((check, i) => {
                  const result = undecided ? null : verdict?.results.find(r => r.id === check.id) ?? null;
                  /** This check is in the run under way: every check for a Submit, the example for a Run. */
                  const inFlight =
                    busy && executes && pending !== null && !program && (pending.kind === 'submit' || i === 0);
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
                            inFlight
                              ? 'border-iris-300 animate-pulse border text-transparent'
                              : result === null
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
                        {result !== null && !quietShape(result) ? <ShapeNote result={result} /> : null}
                      </p>
                      {result !== null && !result.passed ? (
                        <>
                          {result.message !== undefined && result.message !== common ? (
                            <CheckMessage className="mt-1 pl-6 text-[12px]" message={result.message} />
                          ) : null}
                          <p className="text-ink-200 mt-1 pl-6 text-[12px]">
                            <InlineMarkdown source={check.detail} />
                          </p>
                          {problemId !== undefined ? (
                            <WhyLinks checkId={check.id} from={stepHref} problemId={problemId} stepId={step.id} />
                          ) : null}
                          {showShape && result.shape === undefined ? (
                            <ExpectedShape check={check} language={language} />
                          ) : null}
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <Submissions checks={step.checks} history={attempt.history ?? EMPTY_HISTORY} onView={onViewSubmission} />
              {issueUrl !== undefined ? (
                <p className="text-ink-400 mt-3 text-[11px]">
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
