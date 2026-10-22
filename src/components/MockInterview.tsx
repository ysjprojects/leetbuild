import Link from 'next/link';
import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {type ResolvedMockScenario, resolvedMockScenarios} from '@/data/mock';
import {type Verdict, judge} from '@/lib/judge';
import {formatClock} from '@/lib/timer';
import {type Difficulty, type Language, fileName, LANGUAGE_LABEL, LANGUAGES} from '@/lib/types';

import {SearchIcon} from './ListControls';
import {BrandLockup} from './LoadingScreen';
import Markdown from './Markdown';
import ModeSwitch from './ModeSwitch';
import {CompanyChip, DifficultyChip, ghostButtonClass, selectClass} from './paneShared';
import StepEditor from './StepEditor';

type Phase = 'setup' | 'running' | 'report';

interface AssistantMessage {
  id: number;
  from: 'ai' | 'you';
  text: string;
  tone?: 'ok' | 'warn';
}

const startersFor = (scenario: ResolvedMockScenario): Record<Language, string> =>
  Object.fromEntries(LANGUAGES.map(language => [language, scenario.step.code[language].starter])) as Record<
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

/** A compact pass/fail list, used both while the clock runs and in the report. */
const CheckResults: FC<{verdict: Verdict; title: string}> = memo(({verdict, title}) => (
  <div className="border-ink-700 bg-ink-850 rounded-xl border p-4">
    <p className="text-ink-100 flex items-baseline justify-between gap-3 text-[13px] font-bold">
      <span>{title}</span>
      <span className="font-code text-ink-300 shrink-0">
        {verdict.passed}/{verdict.total} checks
      </span>
    </p>
    <ul className="mt-3 space-y-2">
      {verdict.results.map(result => (
        <li className="flex gap-2.5 text-[12px] leading-6" key={result.id}>
          <span className={result.passed ? 'text-success-300' : 'text-danger-300'}>{result.passed ? '✓' : '✗'}</span>
          <span className="min-w-0">
            <span className={result.passed ? 'text-ink-200' : 'text-ink-50 font-semibold'}>{result.title}</span>
            {!result.passed ? (
              <span className="text-ink-400 mt-1 block text-[11px] leading-5">{result.detail}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  </div>
));
CheckResults.displayName = 'CheckResults';

const SignalChip: FC<{signal: string}> = memo(({signal}) => (
  <span className="border-danger-400/30 bg-danger-400/[0.08] text-danger-200 rounded-full border px-2.5 py-1 text-[11px] font-semibold">
    {signal}
  </span>
));
SignalChip.displayName = 'SignalChip';

const MOCK_PRIMARY =
  'rounded-lg bg-danger-400 px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition hover:bg-danger-300 disabled:cursor-not-allowed disabled:opacity-30';

const ACTION_BUTTON = 'rounded-lg border px-3 py-2 text-[12px] font-semibold transition';

/** Each AI-pair action has its own colour, so the review loop is readable at a glance. */
const AI_ACTIONS = {
  draft: `${ACTION_BUTTON} border-danger-400/30 bg-danger-400/10 text-danger-200 hover:bg-danger-400/20`,
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

/** The six signals the scenarios are tagged with, in the order the AI-era track lists them. */
const SIGNALS = ['Specify', 'Delegate', 'Verify', 'Evaluate', 'Secure', 'Operate'] as const;

const signalChip = (on: boolean): string =>
  `rounded-full px-3 py-1 text-[12px] font-semibold transition ${
    on ? 'bg-danger-400 text-ink-950' : 'bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-50'
  }`;

const SignalToggle: FC<{signal: string; on: boolean; toggle: (signal: string) => void}> = memo(
  ({signal, on, toggle}) => {
    const onClick = useCallback(() => toggle(signal), [toggle, signal]);
    return (
      <button aria-pressed={on} className={signalChip(on)} onClick={onClick} type="button">
        {signal}
      </button>
    );
  },
);
SignalToggle.displayName = 'SignalToggle';

/** Words of the search, lower-cased, against title, brief, role, signals and the course the scenario comes from. */
const matchesScenario = (scenario: ResolvedMockScenario, q: string): boolean => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [scenario.title, scenario.blurb, scenario.role, scenario.problem.title, ...scenario.signals]
    .join('\n')
    .toLowerCase();
  return words.every(w => text.includes(w));
};

/** One scenario: the whole card starts it. The course it comes from sits above the title, so a wall of cards still reads. */
const ScenarioCard: FC<{scenario: ResolvedMockScenario; number: number; onStart: (s: ResolvedMockScenario) => void}> =
  memo(({scenario, number, onStart}) => {
    const accent = DIFFICULTY_ACCENT[scenario.problem.difficulty];
    const onClick = useCallback(() => onStart(scenario), [onStart, scenario]);
    return (
      <button
        className={`border-ink-700 bg-ink-850 group relative flex flex-col overflow-hidden rounded-2xl border p-4 text-left transition ${accent.hover}`}
        onClick={onClick}
        type="button">
        <span aria-hidden className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accent.rail}`} />
        <span className="flex w-full items-center gap-2">
          <span
            className={`font-code flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold ${accent.number}`}>
            {number}
          </span>
          <span className="text-ink-300 min-w-0 flex-1 truncate text-[11px] font-semibold">
            {scenario.problem.title}
          </span>
          <DifficultyChip difficulty={scenario.problem.difficulty} />
          {scenario.problem.company !== undefined ? <CompanyChip company={scenario.problem.company} /> : null}
        </span>
        <span className="text-ink-50 mt-3 block text-[14px] font-bold leading-snug">{scenario.title}</span>
        <span className="text-ink-200 mt-1.5 block flex-1 text-[12px] leading-5">{scenario.blurb}</span>
        <span className="mt-3 flex flex-wrap gap-1.5">
          {scenario.signals.map(signal => (
            <SignalChip key={signal} signal={signal} />
          ))}
        </span>
        <span className="border-ink-700/70 mt-3 flex w-full items-center justify-between border-t pt-2.5 text-[11px]">
          <span className="text-ink-400 truncate">{scenario.role}</span>
          <span className="text-danger-300 group-hover:text-danger-200 font-code shrink-0 font-semibold transition">
            {scenario.minutes}:00 · Start ›
          </span>
        </span>
      </button>
    );
  });
ScenarioCard.displayName = 'ScenarioCard';

/** The setup page's list: a search pill and the six signals to narrow by, then the cards in threes. */
const ScenarioPicker: FC<{scenarios: readonly ResolvedMockScenario[]; onStart: (s: ResolvedMockScenario) => void}> =
  memo(({scenarios, onStart}) => {
    const [q, setQ] = useState('');
    const [on, setOn] = useState<readonly string[]>([]);
    const onSearch = useCallback((e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value), []);
    const toggle = useCallback(
      (signal: string) =>
        setOn(current => (current.includes(signal) ? current.filter(s => s !== signal) : [...current, signal])),
      [],
    );
    const clear = useCallback(() => {
      setQ('');
      setOn([]);
    }, []);
    const numbers = useMemo(() => new Map(scenarios.map((s, i) => [s.id, i + 1])), [scenarios]);
    const visible = useMemo(
      () => scenarios.filter(s => matchesScenario(s, q) && on.every(signal => s.signals.includes(signal))),
      [scenarios, q, on],
    );
    const filtering = q.trim() !== '' || on.length > 0;
    return (
      <div className="mx-auto w-full max-w-5xl px-5 pb-10 pt-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="bg-ink-800 text-ink-400 focus-within:bg-ink-700 flex h-10 w-full items-center gap-2 rounded-full px-4 transition sm:w-64">
            <SearchIcon />
            <input
              aria-label="search scenarios"
              className="text-ink-50 placeholder:text-ink-400 w-full border-0 bg-transparent p-0 text-[13px] focus:outline-none focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
              onChange={onSearch}
              placeholder="Search scenarios"
              type="search"
              value={q}
            />
          </label>
          <div aria-label="signals" className="flex flex-wrap gap-1.5" role="group">
            {SIGNALS.map(signal => (
              <SignalToggle key={signal} on={on.includes(signal)} signal={signal} toggle={toggle} />
            ))}
          </div>
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
        {visible.length === 0 ? (
          <p className="border-ink-700 text-ink-300 rounded-xl border border-dashed px-4 py-6 text-center text-[12px]">
            No scenario matches.{' '}
            <button className="text-danger-300 hover:text-danger-200 transition" onClick={clear} type="button">
              Clear the search ›
            </button>
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map(s => (
              <ScenarioCard key={s.id} number={numbers.get(s.id) ?? 0} onStart={onStart} scenario={s} />
            ))}
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
 * The AI-assisted mock interview. It is deliberately offline: the "AI pair" is a deterministic
 * set of actions over the scenario's own draft, checks and notes, so the exercise works with no
 * key, network, login or server. The point is to practise the review loop — generate, inspect,
 * test, decide — under a clock, not to pretend a model is on the other end.
 */
const MockInterview: FC = memo(() => {
  const [phase, setPhase] = useState<Phase>('setup');
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>('python');
  const [codeByLanguage, setCodeByLanguage] = useState<Record<Language, string> | null>(null);
  const [editorReset, setEditorReset] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [hints, setHints] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [followUps, setFollowUps] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptText, setPromptText] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const nextMessage = useRef(1);

  const scenario = useMemo(
    () => resolvedMockScenarios.find(candidate => candidate.id === scenarioId) ?? null,
    [scenarioId],
  );
  const code = codeByLanguage?.[language] ?? '';

  const say = useCallback((text: string, from: AssistantMessage['from'] = 'ai', tone?: AssistantMessage['tone']) => {
    setMessages(current => [...current, {id: nextMessage.current++, text, from, tone}]);
  }, []);

  useEffect(() => {
    if (logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // A new phase starts at its top: the setup page may have been scrolled when the scenario started.
  useEffect(() => {
    mainRef.current?.scrollTo({top: 0});
  }, [phase]);

  // One countdown; when it reaches zero the mock ends and the report grades whatever is on screen.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    if (secondsLeft <= 0) {
      setPhase('report');
      return undefined;
    }
    const timer = window.setTimeout(() => setSecondsLeft(current => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, secondsLeft]);

  const start = useCallback((next: ResolvedMockScenario) => {
    const starters = startersFor(next);
    setScenarioId(next.id);
    setLanguage(next.defaultLanguage);
    setCodeByLanguage(starters);
    setEditorReset(value => value + 1);
    setSecondsLeft(next.minutes * 60);
    setAttempts(0);
    setHints(0);
    setVerdict(null);
    setFollowUps({});
    setCopied(false);
    setPromptCopied(false);
    setPromptText(null);
    nextMessage.current = 1;
    setMessages([
      {
        id: nextMessage.current++,
        from: 'ai',
        text: 'I drafted a first version. It passes the happy path. Review it before you trust it.',
      },
    ]);
    setPhase('running');
  }, []);

  const backToSetup = useCallback(() => {
    setPhase('setup');
    setScenarioId(null);
    setCodeByLanguage(null);
    setVerdict(null);
    setMessages([]);
  }, []);

  const changeLanguage = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setLanguage(event.target.value as Language);
  }, []);

  const changeCode = useCallback(
    (next: string) => {
      setCodeByLanguage(current => (current === null ? current : {...current, [language]: next}));
    },
    [language],
  );

  const onSubmit = useCallback(() => {
    if (scenario === null) return;
    const result = judge(scenario.step, language, code);
    setVerdict(result);
    setAttempts(value => value + 1);
    if (result.accepted) {
      setPhase('report');
      say('Accepted: every check passes. Read the debrief and answer the follow-ups.', 'ai', 'ok');
    } else {
      say(
        `Not yet — ${result.passed}/${result.total} checks pass. I put the failing ones under the editor; fix the code, not the check names.`,
        'ai',
        'warn',
      );
    }
  }, [code, language, say, scenario]);

  const onFinish = useCallback(() => {
    if (scenario === null) return;
    setVerdict(judge(scenario.step, language, code));
    setPhase('report');
  }, [code, language, scenario]);

  const onDraft = useCallback(() => {
    if (scenario === null) return;
    setCodeByLanguage(current =>
      current === null ? current : {...current, [language]: scenario.step.code[language].starter},
    );
    setEditorReset(value => value + 1);
    say('Regenerated the draft. It still passes the happy path — that is the problem. What does it miss?', 'ai');
  }, [language, say, scenario]);

  const onReview = useCallback(() => {
    if (scenario === null) return;
    const result = judge(scenario.step, language, code);
    if (result.accepted) {
      say(
        'All checks pass. Before you submit, explain why each check passes and which one would catch a regression.',
        'ai',
        'ok',
      );
      return;
    }
    const failed = result.results.filter(item => !item.passed);
    say(
      `Review: ${result.passed}/${result.total} pass.\n${failed
        .map(item => `• ${item.title}\n  ${item.detail}`)
        .join('\n')}`,
      'ai',
      'warn',
    );
  }, [code, language, say, scenario]);

  const onExplain = useCallback(() => {
    if (scenario === null) return;
    setHints(value => value + 1);
    say(`The subtle flaw: ${scenario.aiNote}`, 'ai', 'warn');
  }, [say, scenario]);

  const onTestIdea = useCallback(() => {
    if (scenario === null) return;
    setHints(value => value + 1);
    say(`Verification idea: ${scenario.testIdea}`, 'ai');
  }, [say, scenario]);

  const onCopyPrompt = useCallback(async () => {
    if (scenario === null) return;
    const prompt = [
      'You are my AI pair in a timed coding interview. Review the code against the task.',
      'List the failure modes first, then propose the smallest correct patch. Do not assume the draft is correct.',
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

  const onCopyNotes = useCallback(async () => {
    if (scenario === null) return;
    const result = verdict ?? judge(scenario.step, language, code);
    const notes = [
      `Mock interview: ${scenario.title}`,
      `${result.passed}/${result.total} checks · ${attempts} submission(s) · ${hints} AI hint(s)`,
      '',
      'What the AI got wrong:',
      scenario.aiNote,
      '',
      'Follow-ups:',
      ...scenario.followUps.map((question, index) => `Q: ${question}\nA: ${followUps[index] ?? ''}`),
    ].join('\n');
    if (!(await copyText(notes))) {
      say('Clipboard access was denied; select the notes and copy them manually.', 'ai', 'warn');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [attempts, code, followUps, hints, language, scenario, say, verdict]);

  if (phase === 'setup') {
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
              <div className="flex flex-wrap items-center justify-between gap-4">
                <BrandLockup size="lg" />
                <span className="border-danger-400/40 bg-danger-400/10 text-danger-200 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider">
                  Timed practice
                </span>
              </div>
              <h1 className="text-ink-50 mt-8 max-w-3xl text-3xl font-extrabold leading-[1.1] tracking-tight sm:text-4xl">
                Fix the AI draft. <span className="text-danger-300">Beat the clock.</span>
              </h1>
              <p className="text-ink-200 mt-4 max-w-2xl text-[14px] leading-7">
                {resolvedMockScenarios.length} scenarios for the AI-era interview loop: review a model-generated patch,
                use an AI pair, fix the flaw, and prove it before time runs out.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {[
                  `${resolvedMockScenarios.length} scenarios`,
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
          <ScenarioPicker onStart={start} scenarios={resolvedMockScenarios} />
        </main>
      </div>
    );
  }

  if (scenario === null) return null;
  const shownVerdict = verdict ?? judge(scenario.step, language, code);
  const timeUp = secondsLeft === 0;
  const outcome = shownVerdict.accepted ? 'Accepted' : timeUp ? 'Time’s up' : 'Not accepted';
  const used = scenario.minutes * 60 - secondsLeft;
  const step = scenario.step;

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
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ['Outcome', outcome],
                ['Checks', `${shownVerdict.passed}/${shownVerdict.total}`],
                ['Submissions', String(attempts)],
                ['AI hints', String(hints)],
              ].map(([label, value]) => (
                <div className="border-ink-700 bg-ink-850 rounded-xl border px-4 py-3" key={label}>
                  <p className="text-ink-400 text-[11px] font-bold uppercase tracking-wider">{label}</p>
                  <p className="text-ink-50 font-code mt-1 text-[15px] font-semibold">{value}</p>
                </div>
              ))}
            </div>
            <CheckResults title="What the checks found" verdict={shownVerdict} />
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-5">
              <p className="text-danger-200 text-[12px] font-bold uppercase tracking-wide">What the AI got wrong</p>
              <p className="text-ink-200 mt-2 text-[13px] leading-6">{scenario.aiNote}</p>
              {!shownVerdict.accepted ? (
                <p className="text-ink-400 mt-3 text-[12px] leading-6">
                  You used {formatClock(used)} of the {scenario.minutes}:00 budget. Retry and name the failure mode
                  before you run the review.
                </p>
              ) : null}
            </div>
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
            <div className="flex flex-wrap items-center gap-3">
              <button className={MOCK_PRIMARY} onClick={() => start(scenario)} type="button">
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
          <label className="text-ink-300 ml-auto flex items-center gap-1.5 text-[11px]">
            <span className="hidden sm:inline">language</span>
            <select className={selectClass} onChange={changeLanguage} value={language}>
              {LANGUAGES.map(item => (
                <option key={item} value={item}>
                  {LANGUAGE_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
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
          <button className={MOCK_PRIMARY} onClick={onSubmit} type="button">
            Submit ⌘⏎
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
        className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(19rem,0.9fr)_minmax(25rem,1.15fr)_minmax(19rem,0.85fr)] lg:overflow-hidden"
        ref={mainRef}>
        <section className="border-ink-700 bg-ink-950/40 min-h-0 border-b p-5 lg:h-full lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <p className="text-danger-300 text-[11px] font-bold uppercase tracking-wider">{scenario.role}</p>
          <p className="text-ink-200 mt-3 text-[13px] leading-6">{scenario.prompt}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {scenario.signals.map(signal => (
              <SignalChip key={signal} signal={signal} />
            ))}
          </div>
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
        </section>

        <section className="border-ink-700 flex min-h-0 flex-col border-b lg:h-full lg:border-b-0 lg:border-r">
          <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
            <span className="font-code text-ink-200 text-[12px]">{fileName(step.file, language)}</span>
            <span className="border-warning-400/40 bg-warning-400/10 text-warning-300 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold">
              AI draft
            </span>
            <span className="text-ink-400 ml-auto text-[11px]">edit, then submit</span>
          </div>
          <StepEditor
            className="min-h-0 flex-1"
            fileKey={`${scenario.id}:${language}`}
            language={language}
            onChange={changeCode}
            onSubmit={onSubmit}
            resetKey={editorReset}
            value={code}
          />
          {verdict !== null && !verdict.accepted ? (
            <div className="border-ink-700 max-h-[16rem] shrink-0 overflow-y-auto border-t p-2">
              <CheckResults title="Latest submission" verdict={verdict} />
            </div>
          ) : null}
        </section>

        <aside className="bg-ink-950/40 flex min-h-[28rem] flex-col lg:h-full lg:min-h-0">
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
            <button className={AI_ACTIONS.draft} onClick={onDraft} type="button">
              Draft
            </button>
            <button className={AI_ACTIONS.review} onClick={onReview} type="button">
              Review
            </button>
            <button className={AI_ACTIONS.missing} onClick={onExplain} type="button">
              What&apos;s missing?
            </button>
            <button className={AI_ACTIONS.test} onClick={onTestIdea} type="button">
              Test idea
            </button>
          </div>
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
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-[12px] leading-6 ${
                  message.from === 'ai'
                    ? message.tone === 'warn'
                      ? 'border-warning-400/30 bg-warning-400/[0.06] text-ink-200 border'
                      : message.tone === 'ok'
                      ? 'border-success-400/30 bg-success-400/[0.06] text-ink-200 border'
                      : 'border-ink-700 bg-ink-850 text-ink-200 border'
                    : 'bg-danger-400/10 text-ink-200 ml-6'
                }`}
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
    </div>
  );
});
MockInterview.displayName = 'MockInterview';

export default MockInterview;
