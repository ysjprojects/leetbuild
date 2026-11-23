import Link from 'next/link';
import Router, {useRouter} from 'next/router';
import {
  type ChangeEvent,
  type CSSProperties,
  type FC,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {GUIDES} from '@/data/guides/meta';
import {
  type ListedMockScenario,
  type ResolvedMockScenario,
  listedMockScenarios,
  resolveMockScenario,
} from '@/data/mock';
import {type CheckResult, type Verdict, commonMessage, judge, withRuntime} from '@/lib/judge';
import {
  type MockAttempt,
  type MockLayout,
  type MockMessage,
  type MockSession,
  bestAttempt,
  clearMockSession,
  DEFAULT_MOCK_LAYOUT,
  loadMockHistory,
  loadMockLayout,
  loadMockSession,
  MOCK_LAYOUT_BOUNDS,
  recordMockAttempt,
  saveMockLayout,
  saveMockSession,
  secondsLeftAt,
} from '@/lib/mockSession';
import {scrollBehavior} from '@/lib/motion';
import {checkTimeout} from '@/lib/outcome';
import {type RuntimeStatus, getRunner, runtimeHarness, STATUS_TEXT} from '@/lib/runtime/client';
import {stepJob} from '@/lib/runtime/job';
import {formatClock} from '@/lib/timer';
import {
  type Difficulty,
  type Language,
  type Step,
  codeFor,
  CONCEPT_LABEL,
  DIFFICULTIES,
  fileName,
  LANGUAGE_LABEL,
  LANGUAGES,
  stepPath,
} from '@/lib/types';

import {useDialog} from './Dialog';
import {EditorSettingsForm, GearIcon} from './EditorSettings';
import {SearchIcon} from './ListControls';
import {BrandLockup} from './LoadingScreen';
import Markdown from './Markdown';
import ModeSwitch from './ModeSwitch';
import {DifficultyChip, ghostButtonClass, ShapeNote} from './paneShared';
import {type SelectOption, Select} from './Select';
import SplitGutter from './SplitGutter';
import StepEditor from './StepEditor';

/** `ready` is the scenario page with the clock not yet running, behind the start dialog. */
type Phase = 'setup' | 'ready' | 'running' | 'report';

const startersFor = (scenario: ResolvedMockScenario): Record<Language, string> =>
  Object.fromEntries(LANGUAGES.map(language => [language, codeFor(scenario.step, language).starter])) as Record<
    Language,
    string
  >;

/** Clipboard writes can be denied even on a user gesture; the textarea fallback keeps the action useful. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  }
};

/**
 * Grade `code` the way the course does: where the step has a harness for the language and the
 * language runs in this browser, the harness exercises the code inside the course's system and
 * decides every check, the static matchers staying as each check's shape note; elsewhere (C++
 * without WebAssembly stack switching, a step without a harness) the static checks decide.
 */
const grade = async (scenario: ResolvedMockScenario, language: Language, code: string): Promise<Verdict> => {
  const verdict = judge(scenario.step, language, code);
  const runner = getRunner(language);
  if (runtimeHarness(scenario.step, language) === undefined || runner === null) return verdict;
  return withRuntime(verdict, await runner.run(stepJob(scenario.problem, scenario.step, language, code)));
};

/** `1 hint`, `2 hints`: the report's counts, as the notes and the history say them. */
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The editor's narrowest width on wide screens, in pixels: past it a gutter stops. */
const EDITOR_MIN_PX = 380;

/** A side pane's share of the workspace `width`, within its bounds and leaving the editor its minimum beside `other`. */
const clampShare = (share: number, other: number, width: number): number => {
  const max = Math.min(MOCK_LAYOUT_BOUNDS.max, 1 - other - EDITOR_MIN_PX / width);
  return Math.min(Math.max(share, MOCK_LAYOUT_BOUNDS.min), Math.max(MOCK_LAYOUT_BOUNDS.min, max));
};

/**
 * The language picker's options for `step`: a language Submit cannot run here (C++ without
 * WebAssembly stack switching, a step without a harness) is graded by reading the code, and its
 * label says so.
 */
const languageOptions = (step: Step): SelectOption[] =>
  LANGUAGES.map(language => ({
    value: language,
    label:
      runtimeHarness(step, language) === undefined
        ? `${LANGUAGE_LABEL[language]} (read, not run)`
        : LANGUAGE_LABEL[language],
  }));

/**
 * The flaws "What's missing?" names, one per click: the checks the patch fails in the scenario's
 * own language (a course's starter "hides N flaws", N its failing checks), every check if the
 * matchers miss them all.
 */
const flawsOf = (scenario: ResolvedMockScenario): CheckResult[] => {
  const {results} = judge(
    scenario.step,
    scenario.defaultLanguage,
    codeFor(scenario.step, scenario.defaultLanguage).starter,
  );
  const failing = results.filter(result => !result.passed);
  return failing.length > 0 ? failing : results;
};

/** What each signal on a card means: the picker's legend and every chip's tooltip. */
const SIGNAL_MEANING: Record<string, string> = {
  Specify: 'Turn the brief into exact requirements: limits, status codes, what done means.',
  Delegate: 'Split the work: what runs in parallel, what each part owns, what comes back.',
  Verify: 'Prove the fix with a test that fails on the patch and passes after it.',
  Evaluate: 'Judge model or ranking output against a measure, not by eye.',
  Secure: 'Keep tenants, secrets and untrusted input where they belong.',
  Operate: 'Keep it running under load and failure: deadlines, retries, expiry, cost.',
};

/** A grading under way: the language's runtime booting (a download the first time), then the checks running. */
const GradingStatus: FC<{runtime: RuntimeStatus; className: string}> = memo(({runtime, className}) => (
  <p className={`text-ink-200 flex items-center gap-2 ${className}`} role="status">
    <span
      aria-hidden
      className="bg-danger-300 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
    />
    {runtime.state === 'booting' ? STATUS_TEXT[runtime.phase] : 'running your code against the checks…'}
  </p>
));
GradingStatus.displayName = 'GradingStatus';

/** The status of `language`'s runtime, live; idle where the language is graded by reading the code. */
const useRuntimeStatus = (language: Language): RuntimeStatus => {
  const runner = useMemo(() => getRunner(language), [language]);
  const [status, setStatus] = useState<RuntimeStatus>(runner?.status ?? {state: 'idle'});
  useEffect(() => {
    if (runner === null) {
      setStatus({state: 'idle'});
      return undefined;
    }
    setStatus(runner.status);
    return runner.onStatus(setStatus);
  }, [runner]);
  return status;
};

/** Where the runtime is, beside the clock and in the start dialog: it boots while the dialog is open. */
const RuntimeBadge: FC<{language: Language; runtime: RuntimeStatus}> = memo(({language, runtime}) => {
  if (runtime.state === 'idle') return null;
  const booting = runtime.state === 'booting';
  const failed = runtime.state === 'failed';
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
        failed
          ? 'border-danger-400/60 text-danger-300'
          : booting
          ? 'border-ink-600 text-ink-300'
          : 'border-success-400/40 text-success-300'
      }`}
      role="status"
      title={booting ? STATUS_TEXT[runtime.phase] : failed ? runtime.message : undefined}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          failed
            ? 'bg-danger-400'
            : booting
            ? 'bg-warning-400 animate-pulse motion-reduce:animate-none'
            : 'bg-success-400'
        }`}
      />
      {booting
        ? `loading the ${LANGUAGE_LABEL[language]} runtime…`
        : failed
        ? 'runtime failed to start'
        : 'runtime ready'}
    </span>
  );
});
RuntimeBadge.displayName = 'RuntimeBadge';

/**
 * A compact pass/fail list, used both while the clock runs and in the report: for a failed check,
 * what the run observed, then what the check is for. A verdict with no run read the code instead,
 * and says so: there, passing means the code has the expected shape, not that it works.
 */
const CheckResults: FC<{verdict: Verdict; title: string; language: Language}> = memo(({verdict, title, language}) => {
  const common = commonMessage(verdict);
  return (
    <div className="border-ink-700 bg-ink-850 rounded-xl border p-4">
      <p className="text-ink-100 flex items-baseline justify-between gap-3 text-[13px] font-bold">
        <span>{title}</span>
        <span className="font-code text-ink-300 shrink-0">
          {verdict.passed}/{verdict.total} checks
        </span>
      </p>
      {verdict.run === undefined ? (
        <p className="border-warning-400/40 bg-warning-400/10 text-warning-300 mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] leading-5">
          Checked by reading the code, not by running it: {LANGUAGE_LABEL[language]} does not run in this browser. A
          pass means the code has the expected shape, not that it works.
        </p>
      ) : null}
      {common !== null ? (
        <p className="font-code text-danger-200 mt-2 text-[11px] leading-5">
          {verdict.run?.error !== undefined ? `Could not run: ${common}` : common}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {verdict.results.map(result => (
          <li className="flex gap-2.5 text-[12px] leading-6" key={result.id}>
            <span className={result.passed ? 'text-success-300' : 'text-danger-300'}>{result.passed ? '✓' : '✗'}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={result.passed ? 'text-ink-200' : 'text-ink-50 font-semibold'}>{result.title}</span>
                <ShapeNote result={result} />
              </span>
              {!result.passed ? (
                <>
                  {result.message !== undefined && result.message !== common ? (
                    <span className="font-code text-danger-200 mt-1 block text-[11px] leading-5">{result.message}</span>
                  ) : null}
                  <span className="text-ink-400 mt-1 block text-[11px] leading-5">{result.detail}</span>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
CheckResults.displayName = 'CheckResults';

const SignalChip: FC<{signal: string}> = memo(({signal}) => (
  <span
    className="border-danger-400/30 bg-danger-400/[0.08] text-danger-200 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
    title={SIGNAL_MEANING[signal]}>
    {signal}
  </span>
));
SignalChip.displayName = 'SignalChip';

/** What a sealed pane shows before the clock starts: a note and the silhouette of what will be there. */
const Sealed: FC<{note: string; lines: number}> = memo(({note, lines}) => (
  <div aria-hidden className="mt-3">
    <p className="text-ink-400 text-[12px]">{note}</p>
    <div className="mt-4 space-y-2.5">
      {Array.from({length: lines}, (_, i) => (
        <div
          className={`bg-ink-800 h-2.5 rounded ${i % 3 === 2 ? 'w-1/2' : i % 2 === 0 ? 'w-11/12' : 'w-4/5'}`}
          key={i}
        />
      ))}
    </div>
  </div>
));
Sealed.displayName = 'Sealed';

const MOCK_LINK = 'text-danger-300 underline decoration-danger-400/40 underline-offset-2 hover:text-danger-200';

/** Marks an AI pair action that counts as a hint in the report. */
const HintTag: FC = memo(() => (
  <span className="rounded border border-current px-1 text-[9px] font-bold uppercase leading-[14px] tracking-wider opacity-80">
    hint
  </span>
));
HintTag.displayName = 'HintTag';

const MOCK_PRIMARY =
  'rounded-lg bg-danger-400 px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition hover:bg-danger-300 disabled:cursor-not-allowed disabled:opacity-30';

const ACTION_BUTTON = 'rounded-lg border px-3 py-2 text-[12px] font-semibold transition';

/** Each AI-pair action has its own colour, so the loop is readable at a glance. */
const AI_ACTIONS = {
  reset: `${ACTION_BUTTON} border-danger-400/30 bg-danger-400/10 text-danger-200 hover:bg-danger-400/20`,
  review: `${ACTION_BUTTON} border-success-400/30 bg-success-400/10 text-success-300 hover:bg-success-400/20`,
  missing: `${ACTION_BUTTON} border-warning-400/30 bg-warning-400/10 text-warning-300 hover:bg-warning-400/20`,
  test: `${ACTION_BUTTON} border-ink-600 bg-ink-850 text-ink-200 hover:bg-ink-800`,
} as const;

/** The card's rail and number take the course's difficulty colour, as the catalogue rows do. */
const DIFFICULTY_ACCENT: Record<Difficulty, {rail: string; number: string; hover: string}> = {
  easy: {
    rail: 'from-success-400 to-success-300',
    number: 'border-success-400/40 bg-success-400/10 text-success-300',
    hover: 'hover:border-success-400/50 hover:bg-ink-800/80',
  },
  medium: {
    rail: 'from-warning-400 to-warning-300',
    number: 'border-warning-400/40 bg-warning-400/10 text-warning-300',
    hover: 'hover:border-warning-400/50 hover:bg-ink-800/80',
  },
  hard: {
    rail: 'from-danger-400 to-danger-300',
    number: 'border-danger-400/40 bg-danger-400/10 text-danger-200',
    hover: 'hover:border-danger-400/60 hover:bg-ink-800/80',
  },
};

/** The six signals the scenarios are tagged with, in the order the picker lists them. */
const SIGNALS = ['Specify', 'Delegate', 'Verify', 'Evaluate', 'Secure', 'Operate'] as const;

const DIFFICULTY_LABEL: Record<Difficulty, string> = {easy: 'Easy', medium: 'Medium', hard: 'Hard'};

const filterChip = (on: boolean): string =>
  `rounded-full px-3 py-1 text-[12px] font-semibold transition ${
    on ? 'bg-danger-400 text-ink-950' : 'bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-50'
  }`;

/** A filter chip with how many scenarios carry its value; `title` says what the value means. */
const FilterToggle: FC<{
  value: string;
  label: string;
  count: number;
  on: boolean;
  title?: string;
  toggle: (value: string) => void;
}> = memo(({value, label, count, on, title, toggle}) => {
  const onClick = useCallback(() => toggle(value), [toggle, value]);
  return (
    <button aria-pressed={on} className={filterChip(on)} onClick={onClick} title={title} type="button">
      {label} <span className={`font-code ${on ? '' : 'text-ink-400'}`}>{count}</span>
    </button>
  );
});
FilterToggle.displayName = 'FilterToggle';

/** Search words the scenarios never use, and the word they use for the same thing. */
const SEARCH_ALIASES: Record<string, string> = {postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql'};

/**
 * What the search reads, lower-cased. `own`: the scenario and the step it practises (brief, flaws,
 * test idea, follow-ups, the step's title and technology, the course's name). `course`: the course
 * around it (its one-liner and the technologies all its steps use).
 */
interface SearchEntry {
  own: string;
  course: string;
}

const searchEntry = (scenario: ListedMockScenario): SearchEntry => {
  const step = scenario.problem.steps.find(s => s.id === scenario.stepId);
  return {
    own: [
      scenario.title,
      scenario.blurb,
      scenario.role,
      scenario.prompt,
      scenario.aiNote,
      scenario.testIdea,
      ...scenario.followUps,
      ...scenario.signals,
      scenario.problem.title,
      step?.title ?? '',
      step === undefined ? '' : `${step.concept} ${CONCEPT_LABEL[step.concept]}`,
    ]
      .join('\n')
      .toLowerCase(),
    course: [scenario.problem.tagline, ...scenario.problem.concepts.map(c => `${c} ${CONCEPT_LABEL[c]}`)]
      .join('\n')
      .toLowerCase(),
  };
};

/** A search word (or its alias) at the start of a word, so `lua` finds Lua and not "evaluate". */
const wordPattern = (word: string): RegExp => {
  const alias = SEARCH_ALIASES[word];
  const terms = (alias === undefined ? [word] : [word, alias]).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^|[^a-z0-9])(?:${terms.join('|')})`);
};

/**
 * How well a scenario matches the search: -1 when a word is in neither its own text nor its
 * course's, else how many words its own text holds, so the scenarios about a technology come
 * before those whose course merely uses it.
 */
const searchRank = (entry: SearchEntry, patterns: readonly RegExp[]): number => {
  let own = 0;
  for (const pattern of patterns) {
    if (pattern.test(entry.own)) own += 1;
    else if (!pattern.test(entry.course)) return -1;
  }
  return own;
};

/**
 * One scenario: the whole card starts it. The course it comes from sits above the title, so a wall
 * of cards still reads. `busy` while the course is on its way; `best`, the best attempt kept here.
 */
const ScenarioCard: FC<{
  scenario: ListedMockScenario;
  number: number;
  busy: boolean;
  best: MockAttempt | null;
  tries: number;
  onStart: (s: ListedMockScenario) => void;
}> = memo(({scenario, number, busy, best, tries, onStart}) => {
  const accent = DIFFICULTY_ACCENT[scenario.problem.difficulty];
  const onClick = useCallback(() => onStart(scenario), [onStart, scenario]);
  return (
    <button
      aria-busy={busy}
      className={`border-ink-700 bg-ink-850 group relative flex flex-col overflow-hidden rounded-2xl border p-4 text-left transition ${accent.hover}`}
      onClick={onClick}
      type="button">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accent.rail}`} />
      <span className="flex w-full items-center gap-2">
        <span
          className={`font-code flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold ${accent.number}`}>
          {number}
        </span>
        <span className="text-ink-300 min-w-0 flex-1 truncate text-[11px] font-semibold">{scenario.problem.title}</span>
        <DifficultyChip difficulty={scenario.problem.difficulty} />
      </span>
      <span className="text-ink-50 mt-3 block text-[14px] font-bold leading-snug">{scenario.title}</span>
      <span className="text-ink-200 mt-1.5 block flex-1 text-[12px] leading-5">{scenario.blurb}</span>
      <span className="mt-3 flex flex-wrap gap-1.5">
        {scenario.signals.map(signal => (
          <SignalChip key={signal} signal={signal} />
        ))}
      </span>
      {best !== null ? (
        <span className="font-code mt-3 block text-[11px]">
          <span className={best.accepted ? 'text-success-300' : 'text-ink-300'}>
            Best {best.passed}/{best.total} in {formatClock(best.seconds)}
            {best.read === true ? ' (read, not run)' : ''}
          </span>
          <span className="text-ink-400">
            {' '}
            · {tries} {tries === 1 ? 'attempt' : 'attempts'}
          </span>
        </span>
      ) : null}
      <span className="border-ink-700/70 mt-3 flex w-full items-center justify-between border-t pt-2.5 text-[11px]">
        <span className="text-ink-400 truncate">{scenario.role}</span>
        <span className="text-danger-300 group-hover:text-danger-200 font-code shrink-0 font-semibold transition">
          {scenario.minutes}:00 · {busy ? 'Opening…' : 'Start ›'}
        </span>
      </span>
    </button>
  );
});
ScenarioCard.displayName = 'ScenarioCard';

/**
 * The start dialog's body: what the interviewer will say, where the step comes from, how long the
 * clock runs, and the language to start in — chosen here so no seconds go to a dropdown later. The
 * chosen language's runtime boots while it is open. `replaces`: the running session starting ends.
 */
const ScenarioBrief: FC<{
  scenario: ResolvedMockScenario;
  initial: Language;
  onLanguage: (l: Language) => void;
  replaces: string | null;
}> = memo(({scenario, initial, onLanguage, replaces}) => {
  const [chosen, setChosen] = useState<Language>(initial);
  const runtime = useRuntimeStatus(chosen);
  const onChange = useCallback(
    (value: string) => {
      const next = value as Language;
      setChosen(next);
      onLanguage(next);
    },
    [onLanguage],
  );
  const options = useMemo(() => languageOptions(scenario.step), [scenario.step]);
  const read = runtimeHarness(scenario.step, chosen) === undefined;
  return (
    <div className="space-y-3">
      <p className="text-ink-50 text-[14px] font-bold leading-snug">{scenario.title}</p>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-ink-100 font-semibold">{scenario.problem.title}</span>
        <DifficultyChip difficulty={scenario.problem.difficulty} />
        <span className="text-ink-400">· {scenario.role}</span>
      </div>
      <p className="text-ink-300 text-[12px] leading-5">
        The interviewer's brief, the requirements and the patch open when the clock starts. Only the signals it probes
        are known in advance:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {scenario.signals.map(signal => (
          <SignalChip key={signal} signal={signal} />
        ))}
      </div>
      <div className="border-ink-700 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-[12px]">
        <span className="text-ink-300 flex items-center gap-2">
          language
          <Select label="language" onChange={onChange} options={options} value={chosen} />
          {read ? null : <RuntimeBadge language={chosen} runtime={runtime} />}
        </span>
        <span className="text-ink-400">
          <span className="font-code text-ink-100">{scenario.minutes}:00</span> from the moment you start · the patch
          loads in the editor · saved in this browser only
        </span>
      </div>
      {read ? (
        <p className="border-warning-400/40 bg-warning-400/10 text-warning-300 rounded-lg border px-3 py-2 text-[12px] leading-5">
          {LANGUAGE_LABEL[chosen]} does not run in this browser: Submit checks it by reading the code. An accepted
          verdict means the code has the expected shape, not that it works. Pick another language to have it run.
        </p>
      ) : null}
      <p className="text-ink-400 text-[12px] leading-5">
        The report counts your submissions and the hints you reveal (buttons marked <HintTag />
        ). Review and Copy prompt are free.
      </p>
      {replaces !== null ? (
        <p className="border-warning-400/40 bg-warning-400/10 text-warning-300 rounded-lg border px-3 py-2 text-[12px] leading-5">
          {replaces}
        </p>
      ) : null}
    </div>
  );
});
ScenarioBrief.displayName = 'ScenarioBrief';

/** The saved session, on the picker: resume it (or open its report), or let it go. Its clock keeps running. */
const ResumeBanner: FC<{session: MockSession; title: string; onResume: () => void; onDiscard: () => void}> = memo(
  ({session, title, onResume, onDiscard}) => {
    const [now, setNow] = useState(Date.now);
    const running = session.phase === 'running';
    useEffect(() => {
      if (!running) return undefined;
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }, [running]);
    const left = secondsLeftAt(session.deadline, session.endedAt, now);
    const live = running && left > 0;
    return (
      <section
        aria-label="saved session"
        className="border-danger-400/40 bg-danger-400/10 mb-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
        <p className="text-ink-100 min-w-0 flex-1 text-[13px] leading-6">
          {live ? 'Resume ' : running ? 'Time ran out on ' : 'Your report on '}
          <span className="text-ink-50 font-bold">{title}</span>
          {live ? (
            <>
              ? <span className="font-code text-danger-200">{formatClock(left)}</span> left.
            </>
          ) : running ? (
            '.'
          ) : (
            ' is saved.'
          )}
        </p>
        <button className={MOCK_PRIMARY} onClick={onResume} type="button">
          {live ? 'Resume' : 'Open report'}
        </button>
        <button className={ghostButtonClass} onClick={onDiscard} type="button">
          {live ? 'Discard' : 'Dismiss'}
        </button>
      </section>
    );
  },
);
ResumeBanner.displayName = 'ResumeBanner';

/**
 * The setup page's list: a search pill and the six signals to narrow by, then the cards in threes.
 * `opening`: the scenario whose course is on its way; `failed`: the last one did not arrive.
 */
const ScenarioPicker: FC<{
  scenarios: readonly ListedMockScenario[];
  opening: string | null;
  failed: boolean;
  onStart: (s: ListedMockScenario) => void;
}> = memo(({scenarios, opening, failed, onStart}) => {
  const [q, setQ] = useState('');
  const [on, setOn] = useState<readonly string[]>([]);
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all');
  const [history] = useState(loadMockHistory);
  const onSearch = useCallback((e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value), []);
  const toggle = useCallback(
    (signal: string) =>
      setOn(current => (current.includes(signal) ? current.filter(s => s !== signal) : [...current, signal])),
    [],
  );
  const pickDifficulty = useCallback(
    (value: string) => setDifficulty(current => (current === value ? 'all' : (value as Difficulty | 'all'))),
    [],
  );
  const clear = useCallback(() => {
    setQ('');
    setOn([]);
    setDifficulty('all');
  }, []);
  const numbers = useMemo(() => new Map(scenarios.map((s, i) => [s.id, i + 1])), [scenarios]);
  const entries = useMemo(() => new Map(scenarios.map(s => [s.id, searchEntry(s)])), [scenarios]);
  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const s of scenarios) {
      for (const key of [s.problem.difficulty, ...s.signals]) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return tally;
  }, [scenarios]);
  /** The scenarios shown, best match first; `aboutIt`, whether any matched by its own text rather than its course's. */
  const {visible, aboutIt} = useMemo(() => {
    const patterns = q.toLowerCase().split(/\s+/).filter(Boolean).map(wordPattern);
    const ranked = scenarios
      .filter(
        s => (difficulty === 'all' || s.problem.difficulty === difficulty) && on.every(x => s.signals.includes(x)),
      )
      .map(s => ({s, rank: patterns.length === 0 ? 0 : searchRank(entries.get(s.id) as SearchEntry, patterns)}))
      .filter(({rank}) => rank >= 0)
      .sort((a, b) => b.rank - a.rank);
    return {visible: ranked.map(({s}) => s), aboutIt: patterns.length === 0 || ranked.some(({rank}) => rank > 0)};
  }, [scenarios, entries, q, on, difficulty]);
  const filtering = q.trim() !== '' || on.length > 0 || difficulty !== 'all';
  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-10 pt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="bg-ink-800 text-ink-400 focus-within:bg-ink-700 flex h-10 w-full items-center gap-2 rounded-full px-4 transition sm:w-72">
          <SearchIcon />
          <input
            aria-label="search scenarios"
            className="text-ink-50 placeholder:text-ink-400 w-full border-0 bg-transparent p-0 text-[13px] focus:outline-none focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
            onChange={onSearch}
            placeholder="Search: title, Redis, Kafka, retries…"
            type="search"
            value={q}
          />
        </label>
        <span className="text-ink-300 ml-auto flex items-center gap-2 text-[13px]">
          {filtering ? (
            <>
              <span>
                <span className="font-code text-ink-100">{visible.length}</span> of {scenarios.length}
              </span>
              <button
                className="text-danger-300 hover:text-danger-200 text-[12px] transition"
                onClick={clear}
                type="button">
                clear
              </button>
            </>
          ) : (
            <span>
              <span className="font-code text-ink-100">{scenarios.length}</span> scenarios
            </span>
          )}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-ink-400 w-20 shrink-0 text-[11px] font-bold uppercase tracking-wider">Difficulty</span>
        <div aria-label="difficulty" className="flex flex-wrap gap-1.5" role="group">
          <FilterToggle
            count={scenarios.length}
            label="All"
            on={difficulty === 'all'}
            toggle={pickDifficulty}
            value="all"
          />
          {DIFFICULTIES.map(d => (
            <FilterToggle
              count={counts.get(d) ?? 0}
              key={d}
              label={DIFFICULTY_LABEL[d]}
              on={difficulty === d}
              toggle={pickDifficulty}
              value={d}
            />
          ))}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-start gap-1.5">
        <span className="text-ink-400 w-20 shrink-0 pt-1.5 text-[11px] font-bold uppercase tracking-wider">
          Signals
        </span>
        <div className="min-w-0 flex-1">
          <div aria-label="signals" className="flex flex-wrap gap-1.5" role="group">
            {SIGNALS.map(signal => (
              <FilterToggle
                count={counts.get(signal) ?? 0}
                key={signal}
                label={signal}
                on={on.includes(signal)}
                title={SIGNAL_MEANING[signal]}
                toggle={toggle}
                value={signal}
              />
            ))}
          </div>
          <details className="group mt-2">
            <summary className="text-ink-300 hover:text-ink-50 cursor-pointer text-[12px] transition">
              What the signals mean
            </summary>
            <dl className="border-ink-700 bg-ink-850 mt-2 grid gap-x-4 gap-y-1.5 rounded-xl border p-3 text-[12px] leading-5 sm:grid-cols-[auto_1fr]">
              {SIGNALS.map(signal => (
                <div className="contents" key={signal}>
                  <dt className="text-danger-200 font-semibold">{signal}</dt>
                  <dd className="text-ink-200 mb-1 sm:mb-0">{SIGNAL_MEANING[signal]}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </div>
      {failed ? (
        <p
          className="border-danger-400/40 bg-danger-400/10 text-danger-200 mb-4 rounded-xl border px-4 py-3 text-[12px]"
          role="alert">
          The scenario's course did not load. Check the connection and start it again.
        </p>
      ) : null}
      {visible.length > 0 && !aboutIt ? (
        <p className="text-ink-300 mb-4 text-[12px] leading-5">
          No scenario is about “{q.trim()}” itself; these come from courses that use it in another step.
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="border-ink-700 text-ink-300 rounded-xl border border-dashed px-4 py-6 text-center text-[12px]">
          No scenario matches.{' '}
          <button className="text-danger-300 hover:text-danger-200 transition" onClick={clear} type="button">
            Clear the search ›
          </button>
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(s => {
            const tries = history[s.id] ?? [];
            return (
              <ScenarioCard
                best={bestAttempt(tries)}
                busy={opening === s.id}
                key={s.id}
                number={numbers.get(s.id) ?? 0}
                onStart={onStart}
                scenario={s}
                tries={tries.length}
              />
            );
          })}
        </div>
      )}
      <p className="text-ink-400 border-ink-700 mt-6 border-t pt-4 text-[11px]">
        Offline AI pair · no login · no model API · no solution reveal.
      </p>
    </div>
  );
});
ScenarioPicker.displayName = 'ScenarioPicker';

/**
 * The mock interview with an offline AI pair. It is deliberately offline: the "AI pair" is a
 * deterministic set of actions over the scenario's own patch, checks and notes, so the exercise
 * works with no key, network, login or server. The point is to practise the loop — read, debug,
 * test, decide — under a clock, not to pretend a model is on the other end.
 */
const MockInterview: FC = memo(() => {
  const router = useRouter();
  /** The scenario the address names (`?scenario=<id>`); null on the picker. */
  const urlScenario = router.isReady && typeof router.query.scenario === 'string' ? router.query.scenario : null;
  const [phase, setPhase] = useState<Phase>('setup');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [scenario, setScenario] = useState<ResolvedMockScenario | null>(null);
  /** The scenario whose course is being fetched; `openFailed` when the last fetch failed. */
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  /** Bumped per open: a course that arrives after another card was picked opens nothing. */
  const openRequest = useRef(0);
  /** The scenario open or opening, as the address last named it. */
  const shownId = useRef<string | null>(null);
  /** Set by a card: open its scenario fresh even when its report is saved (a running session still resumes). */
  const freshOpen = useRef<string | null>(null);
  /** The picker pushed this scenario's address, so leaving it is a step back in history. */
  const pushedFromPicker = useRef(false);
  /** The saved session, as the picker offers it. */
  const [saved, setSaved] = useState<MockSession | null>(loadMockSession);
  const [language, setLanguage] = useState<Language>('python');
  const [codeByLanguage, setCodeByLanguage] = useState<Record<Language, string> | null>(null);
  const [editorReset, setEditorReset] = useState(0);
  /** When the clock runs out, in `Date.now()` milliseconds; null before it starts. */
  const [deadline, setDeadline] = useState<number | null>(null);
  /** When the session ended (Finish, acceptance or time-up): the clock stops there. */
  const [endedAt, setEndedAt] = useState<number | null>(null);
  /** `Date.now()` as the clock last read it. */
  const [now, setNow] = useState(Date.now);
  const [attempts, setAttempts] = useState(0);
  /** Each hint revealed and the AI pair message carrying it; the ref is read by clicks before a render lands. */
  const [revealed, setRevealedState] = useState<Record<string, number>>({});
  const revealedRef = useRef(revealed);
  const setRevealed = useCallback((next: Record<string, number>) => {
    revealedRef.current = next;
    setRevealedState(next);
  }, []);
  const hints = Object.keys(revealed).length;
  /** The AI pair message a re-clicked hint scrolls back to, outlined for a moment. */
  const [flash, setFlash] = useState<number | null>(null);
  /** This scenario's finished attempts, newest first, once its report has graded. */
  const [history, setHistory] = useState<MockAttempt[]>([]);
  /** The report's final code opens on demand, so its editor only mounts when shown. */
  const [codeOpen, setCodeOpen] = useState(false);
  const [layout, setLayout] = useState<MockLayout>(loadMockLayout);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  /** The code `verdict` graded: the report grades again only when the code on screen is different. */
  const [verdictCode, setVerdictCode] = useState<string | null>(null);
  /** A submission, or the report's final grading, is running. */
  const [grading, setGrading] = useState(false);
  /** Bumped per grading and whenever the scenario restarts: a result that arrives for anything else is dropped. */
  const gradeSeq = useRef(0);
  const runtimeStatus = useRuntimeStatus(language);
  const [messages, setMessages] = useState<MockMessage[]>([]);
  const [followUps, setFollowUps] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState(false);
  /** The notes, shown to copy by hand when the clipboard refused them. */
  const [notesText, setNotesText] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptText, setPromptText] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const nextMessage = useRef(1);

  const code = codeByLanguage?.[language] ?? '';
  const secondsLeft = deadline === null ? (scenario?.minutes ?? 0) * 60 : secondsLeftAt(deadline, endedAt, now);

  /** Post a message to the AI pair log; returns its id. */
  const say = useCallback((text: string, from: MockMessage['from'] = 'ai', tone?: MockMessage['tone']): number => {
    const id = nextMessage.current++;
    setMessages(current => [...current, {id, text, from, tone}]);
    return id;
  }, []);

  useEffect(() => {
    if (logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (flash === null) return undefined;
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    saveMockLayout(layout);
  }, [layout]);

  // A new phase starts at its top: the setup page may have been scrolled when the scenario started.
  useEffect(() => {
    mainRef.current?.scrollTo({top: 0});
  }, [phase]);

  // The clock reads the stored deadline against Date.now(), so a frozen page or a throttled
  // background tab cannot stretch it. It wakes just after each whole second, and on returning to the tab.
  useEffect(() => {
    if (phase !== 'running' || deadline === null) return undefined;
    let timer = 0;
    const tick = (): void => {
      window.clearTimeout(timer);
      const at = Date.now();
      setNow(at);
      if (at < deadline) timer = window.setTimeout(tick, ((deadline - at) % 1000) + 20);
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [phase, deadline]);

  // Time is up: the mock ends and the report grades whatever is on screen.
  useEffect(() => {
    if (phase === 'running' && deadline !== null && now >= deadline) {
      setEndedAt(deadline);
      setPhase('report');
    }
  }, [phase, deadline, now]);

  // Boot the language's runtime while the start dialog is open, so the first Submit does not wait for it.
  useEffect(() => {
    if (
      (phase === 'ready' || phase === 'running') &&
      scenario !== null &&
      runtimeHarness(scenario.step, language) !== undefined
    ) {
      getRunner(language)?.prewarm();
    }
  }, [phase, scenario, language]);

  // The report grades the code on screen: a submission's verdict when it graded this code, a fresh run otherwise.
  useEffect(() => {
    if (phase !== 'report' || scenario === null || verdictCode === code) return;
    const token = ++gradeSeq.current;
    setGrading(true);
    void grade(scenario, language, code).then(result => {
      if (gradeSeq.current !== token) return;
      setGrading(false);
      setVerdict(result);
      setVerdictCode(code);
    });
  }, [phase, scenario, language, code, verdictCode]);

  // A graded report is an attempt: kept per scenario (updated, not duplicated, when the report is reopened).
  useEffect(() => {
    if (phase !== 'report' || scenario === null || deadline === null || endedAt === null) return;
    if (verdict === null || verdictCode !== code) return;
    setHistory(
      recordMockAttempt(scenario.id, {
        startedAt: deadline - scenario.minutes * 60_000,
        language,
        accepted: verdict.accepted,
        passed: verdict.passed,
        total: verdict.total,
        seconds: scenario.minutes * 60 - secondsLeftAt(deadline, endedAt, endedAt),
        submissions: attempts,
        hints,
        read: verdict.run === undefined,
      }),
    );
  }, [phase, scenario, deadline, endedAt, verdict, verdictCode, code, language, attempts, hints]);

  // The session is saved as it changes, so Back, a reload, the logo or the mode switch never lose it.
  useEffect(() => {
    if ((phase !== 'running' && phase !== 'report') || scenario === null || deadline === null) return;
    if (codeByLanguage === null) return;
    saveMockSession({
      scenarioId: scenario.id,
      phase,
      language,
      code: codeByLanguage,
      deadline,
      endedAt,
      attempts,
      hints,
      revealed,
      messages,
      followUps,
      verdict,
      verdictCode,
    });
  }, [
    phase,
    scenario,
    language,
    codeByLanguage,
    deadline,
    endedAt,
    attempts,
    hints,
    revealed,
    messages,
    followUps,
    verdict,
    verdictCode,
  ]);

  // While the clock runs, a reload or closing the tab asks first; the session is saved either way.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase]);

  /** Open a scenario on its own page with the clock not yet running: the patch loads, the brief shows, nothing counts. */
  const prepare = useCallback(
    (next: ResolvedMockScenario, chosen: Language) => {
      const starters = startersFor(next);
      setScenario(next);
      setLanguage(chosen);
      setCodeByLanguage(starters);
      setEditorReset(value => value + 1);
      setDeadline(null);
      setEndedAt(null);
      setAttempts(0);
      setRevealed({});
      setFlash(null);
      setCodeOpen(false);
      setHistory([]);
      setVerdict(null);
      setVerdictCode(null);
      setGrading(false);
      gradeSeq.current += 1;
      setFollowUps({});
      setCopied(false);
      setNotesText(null);
      setPromptCopied(false);
      setPromptText(null);
      nextMessage.current = 1;
      setMessages([]);
      setPhase('ready');
    },
    [setRevealed],
  );

  /** Reopen a saved session where it was left; a clock that ran out while away goes straight to the report. */
  const resume = useCallback(
    (next: ResolvedMockScenario, session: MockSession) => {
      setScenario(next);
      setLanguage(session.language);
      setCodeByLanguage({...startersFor(next), ...session.code});
      setEditorReset(value => value + 1);
      setDeadline(session.deadline);
      setEndedAt(session.endedAt);
      setNow(Date.now());
      setAttempts(session.attempts);
      setRevealed(session.revealed ?? {});
      setFlash(null);
      setCodeOpen(false);
      setHistory([]);
      setVerdict(session.verdict ?? null);
      setVerdictCode(session.verdictCode ?? null);
      setGrading(false);
      gradeSeq.current += 1;
      setFollowUps(session.followUps);
      setCopied(false);
      setNotesText(null);
      setPromptCopied(false);
      setPromptText(null);
      nextMessage.current = session.messages.reduce((max, message) => Math.max(max, message.id), 0) + 1;
      setMessages(session.messages);
      setPhase(session.phase);
    },
    [setRevealed],
  );

  // A dialog belongs to the phase that opened it: one left open when the page moved on is not shown again.
  const [dialog, openDialog] = useDialog();
  const [dialogPhase, setDialogPhase] = useState<Phase | null>(null);
  const [pickerDialog, openPickerDialog] = useDialog();

  /** The picker, without touching the address: the saved session stays and the picker offers it. */
  const leave = useCallback(() => {
    openRequest.current += 1;
    setOpening(null);
    setDialogPhase(null);
    setPhase('setup');
    setScenario(null);
    setCodeByLanguage(null);
    setDeadline(null);
    setEndedAt(null);
    setVerdict(null);
    setVerdictCode(null);
    setGrading(false);
    gradeSeq.current += 1;
    setMessages([]);
    setSaved(loadMockSession());
  }, []);

  /**
   * Back to the picker from the page's own buttons: a step back in history when the picker pushed
   * this address. A running session stays saved; a report left this way is done with.
   */
  const backToSetup = useCallback(() => {
    if (phaseRef.current === 'report') clearMockSession();
    if (pushedFromPicker.current) {
      pushedFromPicker.current = false;
      Router.back();
    } else {
      void Router.replace('/mock-interview', undefined, {shallow: true, scroll: false});
    }
  }, []);

  const show = useCallback(
    (listed: ListedMockScenario, session: MockSession | null) => {
      const request = ++openRequest.current;
      setOpening(listed.id);
      setOpenFailed(false);
      resolveMockScenario(listed).then(
        resolved => {
          if (request !== openRequest.current) return;
          setOpening(null);
          if (session === null) prepare(resolved, resolved.defaultLanguage);
          else resume(resolved, session);
        },
        () => {
          if (request !== openRequest.current) return;
          setOpening(null);
          setOpenFailed(true);
          shownId.current = null;
          void Router.replace('/mock-interview', undefined, {shallow: true, scroll: false});
        },
      );
    },
    [prepare, resume],
  );

  // The address names the scenario: a card, Resume, Back/Forward and a reload all open it from
  // there, resuming its saved session when there is one.
  useEffect(() => {
    if (!router.isReady || urlScenario === shownId.current) return;
    shownId.current = urlScenario;
    if (urlScenario === null) {
      leave();
      return;
    }
    const listed = listedMockScenarios.find(s => s.id === urlScenario);
    if (listed === undefined) {
      shownId.current = null;
      void Router.replace('/mock-interview', undefined, {shallow: true, scroll: false});
      return;
    }
    const fresh = freshOpen.current === urlScenario;
    freshOpen.current = null;
    const session = loadMockSession();
    const finished = session !== null && (session.phase === 'report' || session.deadline <= Date.now());
    show(listed, session !== null && session.scenarioId === urlScenario && !(fresh && finished) ? session : null);
  }, [router.isReady, urlScenario, leave, show]);

  const openCard = useCallback((next: ListedMockScenario) => {
    freshOpen.current = next.id;
    pushedFromPicker.current = true;
    void Router.push({pathname: '/mock-interview', query: {scenario: next.id}}, undefined, {
      shallow: true,
      scroll: false,
    });
  }, []);

  const resumeSaved = useCallback(() => {
    if (saved === null) return;
    pushedFromPicker.current = true;
    void Router.push({pathname: '/mock-interview', query: {scenario: saved.scenarioId}}, undefined, {
      shallow: true,
      scroll: false,
    });
  }, [saved]);

  const discardSaved = useCallback(() => {
    if (saved === null) return;
    const left = secondsLeftAt(saved.deadline, saved.endedAt, Date.now());
    const drop = (): void => {
      clearMockSession();
      setSaved(null);
    };
    if (saved.phase === 'report' || left === 0) {
      drop();
      return;
    }
    void openPickerDialog({
      title: 'Discard the session?',
      body: `${formatClock(left)} left. Your code and the AI pair log are deleted.`,
      confirm: 'Discard',
      cancel: 'Keep it',
      danger: true,
    }).then(ok => {
      if (ok) drop();
    });
  }, [saved, openPickerDialog]);

  // The ready page sits behind a blurred backdrop until the brief is confirmed: Start runs the clock,
  // anything else returns to the picker. A layout effect, so a dialog from before never flashes.
  useLayoutEffect(() => {
    if (phase !== 'ready' || scenario === null) return;
    const current = loadMockSession();
    const left = current === null ? 0 : secondsLeftAt(current.deadline, current.endedAt, Date.now());
    const other =
      current !== null && current.phase === 'running' && left > 0
        ? listedMockScenarios.find(s => s.id === current.scenarioId)
        : undefined;
    setDialogPhase('ready');
    void openDialog({
      title: 'Start the timed assessment?',
      body: (
        <ScenarioBrief
          initial={scenario.defaultLanguage}
          onLanguage={setLanguage}
          replaces={
            other === undefined
              ? null
              : `Starting ends your running session on ${other.title} (${formatClock(left)} left).`
          }
          scenario={scenario}
        />
      ),
      confirm: `Start the clock · ${scenario.minutes}:00`,
      cancel: 'Back to scenarios',
      conceal: true,
    }).then(ok => {
      if (!ok) {
        backToSetup();
        return;
      }
      const at = Date.now();
      setNow(at);
      setEndedAt(null);
      setDeadline(at + scenario.minutes * 60_000);
      setPhase('running');
      say('Here is the patch as it shipped. It passes the happy path. Debug it before you trust it.');
    });
  }, [phase, scenario, openDialog, backToSetup, say]);
  const sealed = phase === 'ready';

  const retry = useCallback(() => {
    if (scenario !== null) prepare(scenario, language);
  }, [prepare, scenario, language]);

  const changeLanguage = useCallback((value: string) => {
    setLanguage(value as Language);
  }, []);

  const changeCode = useCallback(
    (next: string) => {
      setCodeByLanguage(current => (current === null ? current : {...current, [language]: next}));
    },
    [language],
  );

  const onSubmit = useCallback(() => {
    if (scenario === null || grading) return;
    const token = ++gradeSeq.current;
    const submitted = code;
    setGrading(true);
    void grade(scenario, language, submitted).then(result => {
      if (gradeSeq.current !== token) return;
      setGrading(false);
      setVerdict(result);
      setVerdictCode(submitted);
      // A runtime that could not run the code is not a wrong submission, as in the course.
      if (result.run?.error !== undefined) {
        say(`The checks could not run: ${result.run.error}. That does not count as a submission.`, 'ai', 'warn');
        return;
      }
      // Nor is a run whose only failures are checks out of real time: a busy machine, or code that never answers.
      const timeout = checkTimeout(result.results);
      if (timeout !== null) {
        say(
          `${timeout.timedOut} of ${result.total} checks did not finish within ${timeout.seconds} s. Usually the machine was busy, or the code never answers: a loop that never ends, an awaited promise that never resolves, a response never sent. That does not count as a submission; submit again.`,
          'ai',
          'warn',
        );
        return;
      }
      setAttempts(value => value + 1);
      const read = result.run === undefined;
      if (result.accepted) {
        if (phaseRef.current === 'running') {
          setEndedAt(Date.now());
          setPhase('report');
        }
        say(
          read
            ? `Accepted by reading the code: every check looks satisfied. ${LANGUAGE_LABEL[language]} does not run here, so the shape is right; run it yourself before you trust it.`
            : 'Accepted: every check passes. Read the debrief and answer the follow-ups.',
          'ai',
          'ok',
        );
      } else {
        say(
          read
            ? `Not yet: ${result.passed}/${result.total} checks look satisfied, by reading the code (${LANGUAGE_LABEL[language]} does not run here). The failing ones are under the editor.`
            : `Not yet: ${result.passed}/${result.total} checks pass. I put the failing ones under the editor; fix the code, not the check names.`,
          'ai',
          'warn',
        );
      }
    });
  }, [code, grading, language, say, scenario]);

  /** Finish asks first: it ends the session and cannot be undone. */
  const onFinish = useCallback(() => {
    if (deadline === null) return;
    setDialogPhase('running');
    void openDialog({
      title: 'End the session now?',
      body: `${formatClock(secondsLeftAt(deadline, null, Date.now()))} left. The report grades the code on screen.`,
      confirm: 'End and see report',
      cancel: 'Keep working',
      danger: true,
    }).then(ok => {
      if (!ok || phaseRef.current !== 'running') return;
      setEndedAt(Date.now());
      setPhase('report');
    });
  }, [deadline, openDialog]);

  const onReset = useCallback(() => {
    if (scenario === null) return;
    setCodeByLanguage(current =>
      current === null ? current : {...current, [language]: codeFor(scenario.step, language).starter},
    );
    setEditorReset(value => value + 1);
    say(
      'Reset to the patch as it came in. It still passes the happy path; that is the problem. What does it miss?',
      'ai',
    );
  }, [language, say, scenario]);

  /** Bring an earlier AI pair message into view and outline it for a moment. */
  const showMessage = useCallback((id: number) => {
    logRef.current
      ?.querySelector(`[data-message="${id}"]`)
      ?.scrollIntoView({block: 'nearest', behavior: scrollBehavior()});
    setFlash(id);
  }, []);

  /** A hint counts once: the first click posts it, another brings its message back into view. */
  const reveal = useCallback(
    (key: string, text: string) => {
      const shown = revealedRef.current[key];
      if (shown !== undefined) {
        showMessage(shown);
        return;
      }
      setRevealed({...revealedRef.current, [key]: say(text, 'ai', 'warn')});
    },
    [say, setRevealed, showMessage],
  );

  const flaws = useMemo(() => (scenario === null ? [] : flawsOf(scenario)), [scenario]);
  const flawsShown = flaws.filter(flaw => revealed[`flaw:${flaw.id}`] !== undefined).length;

  /**
   * A free read of the code against the static checks. It never names a flaw the hints have not:
   * it counts what looks unmet and names only the flaws already revealed.
   */
  const onReview = useCallback(() => {
    if (scenario === null) return;
    const result = judge(scenario.step, language, code);
    const read =
      runtimeHarness(scenario.step, language) !== undefined
        ? 'Review (reading the code, not running it)'
        : `Review (reading the code: ${LANGUAGE_LABEL[language]} does not run here)`;
    if (result.accepted) {
      say(
        `${read}: every check looks satisfied. Before you submit, say which check would catch a regression.`,
        'ai',
        'ok',
      );
      return;
    }
    const failed = result.results.filter(item => !item.passed);
    const named = failed.filter(item => revealedRef.current[`flaw:${item.id}`] !== undefined);
    const unnamed = failed.length - named.length;
    say(
      [
        `${read}: ${result.passed}/${result.total} checks look satisfied.`,
        ...named.map(item => `• Still unmet: ${item.title}`),
        unnamed > 0
          ? `${unnamed} more ${
              unnamed === 1 ? 'looks' : 'look'
            } unmet. What's missing? names them one at a time, as hints.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      'ai',
      'warn',
    );
  }, [code, language, say, scenario]);

  /** One flaw per click, each counted once; once all are out, a click brings the first back into view. */
  const onExplain = useCallback(() => {
    const index = flaws.findIndex(flaw => revealedRef.current[`flaw:${flaw.id}`] === undefined);
    if (index === -1) {
      const first = flaws.length === 0 ? undefined : revealedRef.current[`flaw:${flaws[0].id}`];
      if (first !== undefined) showMessage(first);
      return;
    }
    const flaw = flaws[index];
    reveal(`flaw:${flaw.id}`, `A flaw in the patch (${index + 1} of ${flaws.length}): ${flaw.title}.\n${flaw.detail}`);
  }, [flaws, reveal, showMessage]);

  const onTestIdea = useCallback(() => {
    if (scenario !== null) reveal('test', `Verification idea: ${scenario.testIdea}`);
  }, [reveal, scenario]);

  const onCopyPrompt = useCallback(async () => {
    if (scenario === null) return;
    const prompt = [
      'You are my AI pair in a timed coding interview. Review the code against the task.',
      'List the failure modes first, then propose the smallest correct fix. Do not assume the code is correct.',
      '',
      '## Task',
      scenario.step.task,
      '',
      `## Current code (${LANGUAGE_LABEL[language]})`,
      '```',
      code,
      '```',
      '',
      '## What I want back',
      '1. The specific requirement the code violates (or “I cannot find one”, if none).',
      '2. The smallest patch.',
      '3. A test that fails before the patch and passes after it.',
    ].join('\n');
    setPromptText(prompt);
    const copied = await copyText(prompt);
    setPromptCopied(copied);
    if (copied) window.setTimeout(() => setPromptCopied(false), 2500);
    say(
      copied
        ? 'Copied a review prompt with the task and your current code. If the clipboard is empty, copy it from the prompt panel.'
        : 'The clipboard was blocked. The prompt is in the panel below; select it and copy it into your own assistant.',
      'ai',
      copied ? undefined : 'warn',
    );
  }, [code, language, say, scenario]);

  /** The report as text: the outcome line, what the patch got wrong, the failing checks, the follow-ups and the debrief. */
  const onCopyNotes = useCallback(async () => {
    if (scenario === null || deadline === null) return;
    const result = verdict !== null && verdictCode === code ? verdict : judge(scenario.step, language, code);
    const left = secondsLeftAt(deadline, endedAt, Date.now());
    const origin = window.location.origin;
    const failing = result.results.filter(item => !item.passed);
    const notes = [
      `Mock interview: ${scenario.title}`,
      `Course step: ${scenario.problem.title}, step ${scenario.problem.steps.indexOf(scenario.step) + 1}: ${
        scenario.step.title
      } (${origin}${stepPath(scenario.problem, scenario.step)})`,
      [
        `Outcome: ${result.accepted ? 'Accepted' : left === 0 ? 'Time’s up' : 'Not accepted'}`,
        `${result.passed}/${result.total} checks`,
        `${formatClock(scenario.minutes * 60 - left)} of ${scenario.minutes}:00`,
        LANGUAGE_LABEL[language],
        plural(attempts, 'submission'),
        plural(hints, 'hint'),
      ].join(' · '),
      ...(result.run === undefined
        ? [`Checked by reading the code: ${LANGUAGE_LABEL[language]} does not run in the browser.`]
        : []),
      '',
      'What the patch got wrong:',
      scenario.aiNote,
      '',
      failing.length === 0 ? 'Failing checks: none' : 'Failing checks:',
      ...failing.map(item => `- ${item.title}: ${item.message ?? item.detail}`),
      ...((scenario.step.guides ?? []).length > 0
        ? ['', 'Study:', ...(scenario.step.guides ?? []).map(id => `- ${GUIDES[id].title}: ${origin}/guides/${id}`)]
        : []),
      '',
      'Follow-ups:',
      ...scenario.followUps.map((question, index) => `Q: ${question}\nA: ${followUps[index] ?? ''}`),
      '',
      'Debrief:',
      scenario.step.debrief.trim(),
    ].join('\n');
    if (await copyText(notes)) {
      setNotesText(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      setNotesText(notes);
    }
  }, [attempts, code, deadline, endedAt, followUps, hints, language, scenario, verdict, verdictCode]);

  // The gutters report pixel deltas; the panes keep shares of the workspace's width, and the editor
  // between them never gets narrower than EDITOR_MIN_PX.
  const dragBrief = useCallback((delta: number) => {
    const width = mainRef.current?.clientWidth ?? 0;
    if (width > 0) setLayout(l => ({...l, brief: clampShare(l.brief + delta / width, l.pair, width)}));
  }, []);
  const dragPair = useCallback((delta: number) => {
    const width = mainRef.current?.clientWidth ?? 0;
    if (width > 0) setLayout(l => ({...l, pair: clampShare(l.pair - delta / width, l.brief, width)}));
  }, []);
  const resetBrief = useCallback(() => setLayout(l => ({...l, brief: DEFAULT_MOCK_LAYOUT.brief})), []);
  const resetPair = useCallback(() => setLayout(l => ({...l, pair: DEFAULT_MOCK_LAYOUT.pair})), []);

  const onEditorSettings = useCallback(() => {
    setDialogPhase('running');
    void openDialog({title: 'Editor', body: <EditorSettingsForm />});
  }, [openDialog]);

  if (phase === 'setup') {
    const savedTitle = saved === null ? undefined : listedMockScenarios.find(s => s.id === saved.scenarioId)?.title;
    return (
      <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
        <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
          <Link className="shrink-0" href="/">
            <BrandLockup />
          </Link>
          <ModeSwitch mode="mock" />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" ref={mainRef}>
          <div className="border-ink-700 relative overflow-hidden border-b">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_120%_at_0%_0%,rgba(244,114,129,0.24),transparent_58%),radial-gradient(70%_90%_at_100%_0%,rgba(227,174,40,0.10),transparent_55%)]"
            />
            <div className="relative mx-auto w-full max-w-5xl px-5 pb-8 pt-8">
              {saved !== null && savedTitle !== undefined ? (
                <ResumeBanner onDiscard={discardSaved} onResume={resumeSaved} session={saved} title={savedTitle} />
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <BrandLockup size="lg" />
                <span className="border-danger-400/40 bg-danger-400/10 text-danger-200 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider">
                  Timed practice
                </span>
              </div>
              <h1 className="text-ink-50 mt-8 max-w-3xl text-3xl font-extrabold leading-[1.1] tracking-tight sm:text-4xl">
                Fix the code. <span className="text-danger-300">Beat the clock.</span>
              </h1>
              <p className="text-ink-200 mt-4 max-w-2xl text-[14px] leading-7">
                {listedMockScenarios.length} scenarios: debug a flawed patch against an interviewer's brief, with an
                offline AI pair, fix the flaw, and prove it before time runs out.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {[
                  `${listedMockScenarios.length} scenarios`,
                  '20–25 min',
                  `${LANGUAGES.length} languages`,
                  'Offline AI pair',
                ].map(chip => (
                  <span
                    className="border-ink-600 bg-ink-850/80 text-ink-200 rounded-full border px-3 py-1 text-[11px] font-semibold"
                    key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <ScenarioPicker failed={openFailed} onStart={openCard} opening={opening} scenarios={listedMockScenarios} />
        </main>
        {pickerDialog}
      </div>
    );
  }

  if (scenario === null) return null;
  /** The verdict of the code on screen, once graded: a submission's, or the report's final run. */
  const graded = verdict !== null && verdictCode === code ? verdict : null;
  const timeUp = secondsLeft === 0;
  const outcome = graded === null ? 'Grading…' : graded.accepted ? 'Accepted' : timeUp ? 'Time’s up' : 'Not accepted';
  const used = scenario.minutes * 60 - secondsLeft;
  const step = scenario.step;
  const starter = codeFor(step, language).starter;
  const options = languageOptions(step);
  const coursePath = stepPath(scenario.problem, step);
  const stepNumber = scenario.problem.steps.indexOf(step) + 1;
  /** Guides open with a link back here: the scenario's address resumes its session or report. */
  const from = encodeURIComponent(`/mock-interview?scenario=${scenario.id}`);
  const best = bestAttempt(history);

  if (phase === 'report') {
    return (
      <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
        <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
          <Link className="shrink-0" href="/">
            <BrandLockup />
          </Link>
          <span className="text-ink-300 hidden text-[12px] sm:inline">mock interview report</span>
          <ModeSwitch mode="mock" />
          <button className={`${ghostButtonClass} ml-auto`} onClick={backToSetup} type="button">
            ← all scenarios
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" ref={mainRef}>
          <div className="mx-auto w-full max-w-4xl space-y-5 px-5 py-8">
            <div>
              <p className="text-danger-300 text-[11px] font-bold uppercase tracking-wider">Mock interview report</p>
              <h1 className="text-ink-50 mt-1 text-2xl font-extrabold leading-tight">{scenario.title}</h1>
              <p className="text-ink-400 mt-2 text-[13px]">{scenario.role}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ['Outcome', outcome],
                ['Checks', graded === null ? '…' : `${graded.passed}/${graded.total}`],
                ['Time', `${formatClock(used)} of ${scenario.minutes}:00`],
                ['Submissions', String(attempts)],
                ['AI hints', String(hints)],
              ].map(([label, value]) => (
                <div className="border-ink-700 bg-ink-850 rounded-xl border px-4 py-3" key={label}>
                  <p className="text-ink-400 text-[11px] font-bold uppercase tracking-wider">{label}</p>
                  <p className="text-ink-50 font-code mt-1 text-[15px] font-semibold">{value}</p>
                  {label === 'Outcome' && graded !== null && graded.run === undefined ? (
                    <p className="text-warning-300 mt-0.5 text-[11px]">read, not run</p>
                  ) : null}
                </div>
              ))}
            </div>
            {graded === null ? (
              <GradingStatus
                className="border-ink-700 bg-ink-850 rounded-xl border p-4 text-[12px]"
                runtime={runtimeStatus}
              />
            ) : (
              <CheckResults language={language} title="What the checks found" verdict={graded} />
            )}
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-5">
              <p className="text-danger-200 text-[12px] font-bold uppercase tracking-wide">What the patch got wrong</p>
              <p className="text-ink-200 mt-2 text-[13px] leading-6">{scenario.aiNote}</p>
              {graded !== null && !graded.accepted ? (
                <p className="text-ink-400 mt-3 text-[12px] leading-6">
                  Retry and name the failure mode before you run the checks.
                </p>
              ) : null}
              <div className="border-ink-700 mt-4 space-y-2 border-t pt-4 text-[13px]">
                {(step.guides ?? []).length > 0 ? (
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-ink-300 text-[12px] font-semibold">Study this failure mode</span>
                    {(step.guides ?? []).map(id => (
                      <Link className={MOCK_LINK} href={`/guides/${id}?from=${from}`} key={id}>
                        {GUIDES[id].title} ›
                      </Link>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-ink-300 text-[12px] font-semibold">Practise it without the clock</span>
                  <Link className={MOCK_LINK} href={coursePath}>
                    {scenario.problem.title}, step {stepNumber}: {step.title} ›
                  </Link>
                </div>
              </div>
            </div>
            <details
              className="border-ink-700 bg-ink-850 rounded-xl border"
              onToggle={event => setCodeOpen(event.currentTarget.open)}
              open={codeOpen}>
              <summary className="text-danger-200 flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-5 py-4 text-[12px] font-bold uppercase tracking-wide">
                <span>Your final code</span>
                <span className="text-ink-400 font-code text-[11px] font-normal normal-case tracking-normal">
                  {fileName(step.file, language)} ·{' '}
                  {code === starter ? 'unchanged from the patch' : 'your changes against the patch'}
                </span>
              </summary>
              {codeOpen ? (
                <div className="border-ink-700 flex h-[28rem] flex-col border-t">
                  <StepEditor
                    className="min-h-0 flex-1"
                    label={`${fileName(step.file, language)}, your final code`}
                    language={language}
                    original={code === starter ? null : starter}
                    readOnly
                    value={code}
                  />
                </div>
              ) : null}
            </details>
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-5">
              <p className="text-danger-200 text-[12px] font-bold uppercase tracking-wide">Follow-up questions</p>
              <p className="text-ink-400 mt-2 text-[12px] leading-6">Write the shape of your answer, not an essay.</p>
              <div className="mt-3 space-y-3">
                {scenario.followUps.map((question, index) => (
                  <label className="block" key={question}>
                    <span className="text-ink-200 text-[13px] leading-6">
                      {index + 1}. {question}
                    </span>
                    <textarea
                      className="border-ink-600 bg-ink-900 text-ink-100 focus:border-danger-400 mt-2 min-h-20 w-full resize-y rounded-lg border p-2.5 text-[13px] leading-6 outline-none"
                      onChange={event => setFollowUps(current => ({...current, [index]: event.target.value}))}
                      placeholder="Your answer…"
                      value={followUps[index] ?? ''}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-5">
              <p className="text-danger-200 text-[12px] font-bold uppercase tracking-wide">
                Signals this scenario practises
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {scenario.signals.map(signal => (
                  <SignalChip key={signal} signal={signal} />
                ))}
              </div>
            </div>
            <details className="border-ink-700 bg-ink-850 rounded-xl border p-5">
              <summary className="text-danger-200 cursor-pointer text-[12px] font-bold uppercase tracking-wide">
                Debrief · what a strong answer sounds like
              </summary>
              <div className="mt-2">
                <Markdown source={step.debrief} />
              </div>
            </details>
            {history.length > 0 ? (
              <div className="border-ink-700 bg-ink-850 rounded-xl border p-5">
                <p className="text-danger-200 text-[12px] font-bold uppercase tracking-wide">
                  Your attempts at this scenario
                </p>
                <p className="text-ink-400 mt-1 text-[12px]">Kept in this browser only.</p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-left text-[12px]">
                    <thead className="text-ink-400 text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="py-1.5 pr-3 font-bold">When</th>
                        <th className="py-1.5 pr-3 font-bold">Language</th>
                        <th className="py-1.5 pr-3 font-bold">Outcome</th>
                        <th className="py-1.5 pr-3 font-bold">Checks</th>
                        <th className="py-1.5 pr-3 font-bold">Time</th>
                        <th className="py-1.5 pr-3 font-bold">Submissions</th>
                        <th className="py-1.5 font-bold">Hints</th>
                      </tr>
                    </thead>
                    <tbody className="font-code">
                      {history.map(attempt => {
                        const current = deadline !== null && attempt.startedAt === deadline - scenario.minutes * 60_000;
                        return (
                          <tr
                            className={`border-ink-700 border-t ${current ? 'text-ink-50' : 'text-ink-200'}`}
                            key={attempt.startedAt}>
                            <td className="py-1.5 pr-3">
                              {new Date(attempt.startedAt).toLocaleString(undefined, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}
                              {current ? <span className="text-danger-300 ml-2 font-sans">this one</span> : null}
                              {attempt === best && history.length > 1 ? (
                                <span className="text-success-300 ml-2 font-sans">best</span>
                              ) : null}
                            </td>
                            <td className="py-1.5 pr-3">
                              {attempt.language !== null ? LANGUAGE_LABEL[attempt.language] : null}
                            </td>
                            <td className={`py-1.5 pr-3 ${attempt.accepted ? 'text-success-300' : ''}`}>
                              {attempt.accepted ? 'Accepted' : 'Not accepted'}
                              {attempt.read === true ? (
                                <span className="text-warning-300 ml-1.5 font-sans">read, not run</span>
                              ) : null}
                            </td>
                            <td className="py-1.5 pr-3">
                              {attempt.passed}/{attempt.total}
                            </td>
                            <td className="py-1.5 pr-3">{formatClock(attempt.seconds)}</td>
                            <td className="py-1.5 pr-3">{attempt.submissions}</td>
                            <td className="py-1.5">{attempt.hints}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button className={MOCK_PRIMARY} onClick={retry} type="button">
                Retry this scenario
              </button>
              <button className={ghostButtonClass} onClick={backToSetup} type="button">
                Try another scenario
              </button>
              <Link className={`${ghostButtonClass} no-underline`} href="/">
                Back to practice
              </Link>
              <button className={`${ghostButtonClass} ml-auto`} onClick={() => void onCopyNotes()} type="button">
                {copied ? 'Copied ✓' : 'Copy debrief notes'}
              </button>
            </div>
            {notesText !== null ? (
              <label className="block">
                <span className="text-warning-300 text-[12px]">
                  The clipboard was blocked. Select the notes and copy them.
                </span>
                <textarea
                  className="border-ink-600 bg-ink-900 text-ink-200 focus:border-danger-400 mt-2 h-48 w-full resize-y rounded-lg border p-2.5 font-mono text-[11px] leading-5 outline-none"
                  onFocus={event => event.currentTarget.select()}
                  readOnly
                  value={notesText}
                />
              </label>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
      <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-col border-b">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <Link className="shrink-0" href="/">
            <BrandLockup />
          </Link>
          <ModeSwitch mode="mock" />
          <span className="text-ink-300 ml-auto flex items-center gap-1.5 text-[11px]">
            <span className="hidden sm:inline">language</span>
            <Select align="right" label="language" onChange={changeLanguage} options={options} value={language} />
          </span>
        </div>
        <div className="border-ink-700 flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2">
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
            <button className={ghostButtonClass} onClick={backToSetup} type="button">
              ← scenarios
            </button>
            <h1 className="text-ink-50 min-w-0 flex-1 whitespace-normal text-[13px] font-bold leading-snug sm:truncate">
              {scenario.title}
            </h1>
          </div>
          {runtimeHarness(step, language) !== undefined ? (
            <RuntimeBadge language={language} runtime={runtimeStatus} />
          ) : null}
          <span
            className={`font-code rounded-full border px-2.5 py-1 text-[12px] font-semibold ${
              secondsLeft <= 120
                ? 'border-danger-400/60 bg-danger-400/10 text-danger-300'
                : 'border-ink-600 text-ink-100'
            }`}>
            {formatClock(secondsLeft)}
          </span>
          <button className={ghostButtonClass} onClick={onFinish} type="button">
            <span className="sm:hidden">Finish</span>
            <span className="hidden sm:inline">Finish &amp; report</span>
          </button>
          <button className={MOCK_PRIMARY} disabled={grading} onClick={onSubmit} type="button">
            {grading ? 'Running…' : 'Submit ⌘⏎'}
          </button>
        </div>
        <div aria-hidden className="bg-ink-800 h-0.5 w-full">
          <div
            className={`h-full transition-[width] duration-1000 ${
              secondsLeft <= 120 ? 'bg-danger-400' : secondsLeft <= 300 ? 'bg-warning-400' : 'bg-danger-300'
            }`}
            style={{width: `${(secondsLeft / (scenario.minutes * 60)) * 100}%`}}
          />
        </div>
      </header>

      <main
        className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden"
        ref={mainRef}
        style={{'--mock-brief': `${layout.brief * 100}%`, '--mock-pair': `${layout.pair * 100}%`} as CSSProperties}>
        <section className="border-ink-700 bg-ink-950/40 min-h-0 border-b p-5 lg:h-full lg:w-[var(--mock-brief)] lg:shrink-0 lg:overflow-y-auto lg:border-b-0">
          <p className="text-danger-300 text-[11px] font-bold uppercase tracking-wider">{scenario.role}</p>
          {sealed ? (
            <Sealed lines={5} note="The interviewer's brief and the requirements open when the clock starts." />
          ) : (
            <>
              <p className="text-ink-200 mt-3 text-[13px] leading-6">{scenario.prompt}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {scenario.signals.map(signal => (
                  <SignalChip key={signal} signal={signal} />
                ))}
              </div>
              <p className="text-ink-400 mt-3 text-[12px] leading-5">
                From the course:{' '}
                <a className={MOCK_LINK} href={coursePath} rel="noopener" target="_blank">
                  {scenario.problem.title}, step {stepNumber}: {step.title}
                </a>{' '}
                <span className="text-ink-400">(new tab; the clock keeps running)</span>
              </p>
              <details className="border-ink-700 bg-ink-850/60 group mt-5 rounded-xl border">
                <summary className="text-danger-200 flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-[12px] font-bold">
                  <span>Requirements &amp; failure mode</span>
                  <span className="text-ink-400 text-[10px] font-normal uppercase tracking-wider group-open:hidden">
                    open
                  </span>
                  <span className="text-ink-400 hidden text-[10px] font-normal uppercase tracking-wider group-open:inline">
                    close
                  </span>
                </summary>
                <div className="border-ink-700 border-t px-4 py-3">
                  <Markdown source={step.task} />
                </div>
              </details>
            </>
          )}
        </section>

        <SplitGutter axis="x" className="hidden lg:flex" onDrag={dragBrief} onReset={resetBrief} />

        <section className="border-ink-700 flex min-h-0 flex-col border-b lg:h-full lg:min-w-0 lg:flex-1 lg:border-b-0">
          <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
            <span className="font-code text-ink-200 truncate text-[12px]">{fileName(step.file, language)}</span>
            <span className="border-warning-400/40 bg-warning-400/10 text-warning-300 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold">
              Patch
            </span>
            <span className="text-ink-400 ml-auto hidden text-[11px] sm:inline">edit, then submit</span>
            <button
              aria-label="editor settings"
              className="text-ink-300 hover:text-ink-50 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition sm:ml-0"
              onClick={onEditorSettings}
              title="editor settings: font size, long lines, Vim"
              type="button">
              <GearIcon />
            </button>
          </div>
          {sealed ? (
            <div className="min-h-0 flex-1 p-4">
              <Sealed lines={12} note="The patch loads when the clock starts." />
            </div>
          ) : (
            <StepEditor
              baseline={codeFor(scenario.step, language).starter}
              className="min-h-0 flex-1"
              fileKey={`${scenario.id}:${language}`}
              label={fileName(step.file, language)}
              language={language}
              onChange={changeCode}
              onSubmit={onSubmit}
              resetKey={editorReset}
              value={code}
            />
          )}
          {grading ? (
            <GradingStatus className="border-ink-700 shrink-0 border-t px-3 py-2 text-[11px]" runtime={runtimeStatus} />
          ) : verdict !== null && !verdict.accepted ? (
            <div className="border-ink-700 max-h-[16rem] shrink-0 overflow-y-auto border-t p-2">
              <CheckResults language={language} title="Latest submission" verdict={verdict} />
            </div>
          ) : null}
        </section>

        <SplitGutter axis="x" className="hidden lg:flex" onDrag={dragPair} onReset={resetPair} />

        <aside className="bg-ink-950/40 flex min-h-[28rem] flex-col lg:h-full lg:min-h-0 lg:w-[var(--mock-pair)] lg:shrink-0">
          <div className="border-ink-700 from-danger-400/[0.08] flex shrink-0 items-center justify-between gap-2 border-b bg-gradient-to-r to-transparent px-4 py-3">
            <div>
              <p className="text-ink-50 text-[13px] font-bold">AI pair</p>
              <p className="text-success-300 flex items-center gap-1.5 text-[11px]">
                <span className="bg-success-400 h-1.5 w-1.5 rounded-full" />
                offline pair
              </p>
            </div>
            <span className="font-code text-ink-400 text-[11px]">{hints} hints used</span>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 p-3 pb-2">
            <button
              className={AI_ACTIONS.reset}
              onClick={onReset}
              title="Back to the patch as it came in (⌘Z undoes it). Free."
              type="button">
              Reset
            </button>
            <button
              className={AI_ACTIONS.review}
              onClick={onReview}
              title="Reads your code against the checks and counts what looks unmet. Free."
              type="button">
              Review
            </button>
            <button
              className={`${AI_ACTIONS.missing} flex items-center justify-center gap-1.5`}
              onClick={onExplain}
              title={
                flawsShown === flaws.length
                  ? 'Every flaw is shown; click to bring them back into view.'
                  : 'Names the next flaw in the patch. Each flaw counts as one hint in the report.'
              }
              type="button">
              What&apos;s missing?
              <span className="font-code text-[11px] font-normal">
                {flawsShown}/{flaws.length}
              </span>
              <HintTag />
            </button>
            <button
              className={`${AI_ACTIONS.test} flex items-center justify-center gap-1.5`}
              onClick={onTestIdea}
              title="A test that would prove the fix. Counts as one hint in the report, once."
              type="button">
              Test idea
              <HintTag />
            </button>
          </div>
          <p className="text-ink-400 shrink-0 px-3 pb-2 text-[11px] leading-5">
            Buttons marked <HintTag /> count in the report, once each. Review and Copy prompt are free.
          </p>
          <div className="shrink-0 px-3 pb-3">
            <button className={`${ghostButtonClass} w-full`} onClick={() => void onCopyPrompt()} type="button">
              {promptCopied ? 'Copied ✓' : 'Copy prompt'}
            </button>
          </div>
          {promptText !== null ? (
            <div className="border-ink-700 shrink-0 border-t p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-400 text-[11px] font-bold uppercase tracking-wider">Prompt for your AI</span>
                <button
                  className="text-ink-400 hover:text-ink-50 text-[11px]"
                  onClick={() => setPromptText(null)}
                  type="button">
                  hide
                </button>
              </div>
              <textarea
                className="border-ink-600 bg-ink-900 text-ink-200 focus:border-danger-400 mt-2 h-36 w-full resize-y rounded-lg border p-2.5 font-mono text-[11px] leading-5 outline-none"
                onFocus={event => event.currentTarget.select()}
                readOnly
                value={promptText}
              />
            </div>
          ) : null}
          <div
            aria-live="polite"
            className="border-ink-700 min-h-0 flex-1 space-y-2.5 overflow-y-auto border-t p-3"
            ref={logRef}>
            {messages.map(message => (
              <div
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-[12px] leading-6 transition-shadow ${
                  message.from === 'ai'
                    ? message.tone === 'warn'
                      ? 'border-warning-400/30 bg-warning-400/[0.06] text-ink-200 border'
                      : message.tone === 'ok'
                      ? 'border-success-400/30 bg-success-400/[0.06] text-ink-200 border'
                      : 'border-ink-700 bg-ink-850 text-ink-200 border'
                    : 'bg-danger-400/10 text-ink-200 ml-6'
                } ${flash === message.id ? 'ring-warning-400 ring-2' : ''}`}
                data-message={message.id}
                key={message.id}>
                <span className="text-ink-400 mb-1 block text-[10px] font-bold uppercase tracking-wider">
                  {message.from === 'ai' ? 'AI pair' : 'you'}
                </span>
                {message.text}
              </div>
            ))}
          </div>
          <p className="text-ink-400 border-ink-700 shrink-0 border-t px-4 py-3 text-[11px]">
            Simulated pair · no hosted model · the checks grade you.
          </p>
        </aside>
      </main>
      {dialogPhase === phase ? dialog : null}
    </div>
  );
});
MockInterview.displayName = 'MockInterview';

export default MockInterview;
