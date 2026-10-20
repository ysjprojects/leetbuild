import Link from 'next/link';
import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {type ResolvedMockScenario, resolvedMockScenarios} from '@/data/mock';
import {type Verdict, judge} from '@/lib/judge';
import {formatClock} from '@/lib/timer';
import {type Language, fileName, LANGUAGE_LABEL, LANGUAGES} from '@/lib/types';

import Markdown from './Markdown';
import ModeSwitch from './ModeSwitch';
import {ghostButtonClass, primaryButtonClass, selectClass} from './paneShared';
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
  <div className="border-ink-700 bg-ink-850 rounded-xl border p-3">
    <p className="text-ink-100 flex items-baseline justify-between gap-2 text-[12px] font-bold">
      <span>{title}</span>
      <span className="font-code text-ink-300">
        {verdict.passed}/{verdict.total} checks
      </span>
    </p>
    <ul className="mt-2 space-y-1.5">
      {verdict.results.map(result => (
        <li className="flex gap-2 text-[11px] leading-snug" key={result.id}>
          <span className={result.passed ? 'text-success-300' : 'text-danger-300'}>{result.passed ? '✓' : '✗'}</span>
          <span className="min-w-0">
            <span className={result.passed ? 'text-ink-200' : 'text-ink-50 font-semibold'}>{result.title}</span>
            {!result.passed ? <span className="text-ink-400 mt-0.5 block">{result.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  </div>
));
CheckResults.displayName = 'CheckResults';

const SignalChip: FC<{signal: string}> = memo(({signal}) => (
  <span className="border-iris-400/30 bg-iris-400/[0.08] text-iris-200 rounded-full border px-2 py-0.5 text-[10px] font-semibold">
    {signal}
  </span>
));
SignalChip.displayName = 'SignalChip';

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
          <Link
            className="from-iris-300 to-ink-50 bg-gradient-to-r bg-clip-text text-lg font-extrabold tracking-tight text-transparent"
            href="/">
            LeetBuild
          </Link>
          <span className="text-ink-300 hidden text-[11px] sm:inline">
            practice the interview loop you will actually face
          </span>
          <ModeSwitch mode="mock" />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6">
            <div>
              <p className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">AI-assisted mock interview</p>
              <h1 className="text-ink-50 mt-1 text-2xl font-extrabold leading-tight">
                You get a flawed AI draft. Fix it under a clock.
              </h1>
              <p className="text-ink-200 mt-2 max-w-3xl text-[13px] leading-relaxed">
                This is practice for the interview loop where the question is not “write it from memory” but “use the
                model, then prove the result.” Every scenario starts from a plausible model-generated patch, gives you
                an offline AI pair, and asks for a fix the checks can verify. No hints are free, no solution is
                revealed, and the timer is the interview.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                [
                  '1 · Read the brief',
                  'A real interviewer brief plus the step’s requirements. Decide what the draft is missing before you type.',
                ],
                [
                  '2 · Work with the pair',
                  'Generate, review, ask what it missed, and ask for a test idea. The pair is offline and deterministic.',
                ],
                [
                  '3 · Submit and defend',
                  'Accepted or not, you get the checks, the flaw, follow-up questions and a copyable debrief.',
                ],
              ].map(([title, body]) => (
                <div className="border-ink-700 bg-ink-850 rounded-xl border p-3" key={title}>
                  <p className="text-iris-200 text-[11px] font-bold uppercase tracking-wide">{title}</p>
                  <p className="text-ink-300 mt-1 text-[11px] leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {resolvedMockScenarios.map(next => (
                <article className="border-ink-700 bg-ink-850 flex flex-col rounded-xl border p-4" key={next.id}>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-ink-50 text-[14px] font-bold leading-snug">{next.title}</h2>
                    <span className="font-code text-ink-300 shrink-0 text-[11px]">{next.minutes}:00</span>
                  </div>
                  <p className="text-ink-400 mt-0.5 text-[11px]">{next.role}</p>
                  <p className="text-ink-300 mt-2 flex-1 text-[12px] leading-relaxed">{next.prompt}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {next.signals.map(signal => (
                      <SignalChip key={signal} signal={signal} />
                    ))}
                  </div>
                  <button className={`${primaryButtonClass} mt-3 w-full`} onClick={() => start(next)} type="button">
                    Start mock interview →
                  </button>
                </article>
              ))}
            </div>
            <p className="text-ink-400 border-ink-700 border-t pt-3 text-[11px] leading-relaxed">
              The AI pair is simulated, not a hosted model: it drafts from the exercise’s starter, reviews with the same
              checks the judge uses, and reveals the scenario’s flaw on request. The point is to practise reviewing AI
              output without an API key or an account. Regular courses live under{' '}
              <Link className="text-iris-300 hover:text-iris-200 decoration-iris-400/50 underline" href="/">
                Practice
              </Link>
              .
            </p>
          </div>
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
          <Link
            className="from-iris-300 to-ink-50 bg-gradient-to-r bg-clip-text text-lg font-extrabold tracking-tight text-transparent"
            href="/">
            LeetBuild
          </Link>
          <span className="text-ink-300 hidden text-[11px] sm:inline">mock interview report</span>
          <ModeSwitch mode="mock" />
          <button className={`${ghostButtonClass} ml-auto`} onClick={backToSetup} type="button">
            ← all scenarios
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6">
            <div>
              <p className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">Mock interview report</p>
              <h1 className="text-ink-50 mt-1 text-2xl font-extrabold leading-tight">{scenario.title}</h1>
              <p className="text-ink-400 mt-1 text-[12px]">{scenario.role}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              {[
                ['Outcome', outcome],
                ['Checks', `${shownVerdict.passed}/${shownVerdict.total}`],
                ['Submissions', String(attempts)],
                ['AI hints', String(hints)],
              ].map(([label, value]) => (
                <div className="border-ink-700 bg-ink-850 rounded-xl border px-3 py-2" key={label}>
                  <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">{label}</p>
                  <p className="text-ink-50 font-code mt-0.5 text-[14px] font-semibold">{value}</p>
                </div>
              ))}
            </div>
            <CheckResults title="What the checks found" verdict={shownVerdict} />
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-4">
              <p className="text-iris-200 text-[11px] font-bold uppercase tracking-wide">What the AI got wrong</p>
              <p className="text-ink-200 mt-1 text-[12px] leading-relaxed">{scenario.aiNote}</p>
              {!shownVerdict.accepted ? (
                <p className="text-ink-400 mt-2 text-[11px] leading-relaxed">
                  You used {formatClock(used)} of the {scenario.minutes}:00 budget. Retry the scenario and aim to name
                  the failure mode before you run the review.
                </p>
              ) : null}
            </div>
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-4">
              <p className="text-iris-200 text-[11px] font-bold uppercase tracking-wide">Follow-up questions</p>
              <p className="text-ink-400 mt-1 text-[11px]">
                In a real interview you would answer these out loud. Write the shape of your answer, not an essay.
              </p>
              <div className="mt-3 space-y-3">
                {scenario.followUps.map((question, index) => (
                  <label className="block" key={question}>
                    <span className="text-ink-200 text-[12px]">
                      {index + 1}. {question}
                    </span>
                    <textarea
                      className="border-ink-600 bg-ink-900 text-ink-100 focus:border-iris-400 mt-1 min-h-16 w-full resize-y rounded-lg border p-2 text-[12px] outline-none"
                      onChange={event => setFollowUps(current => ({...current, [index]: event.target.value}))}
                      placeholder="Your answer…"
                      value={followUps[index] ?? ''}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="border-ink-700 bg-ink-850 rounded-xl border p-4">
              <p className="text-iris-200 text-[11px] font-bold uppercase tracking-wide">
                Signals this scenario practises
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {scenario.signals.map(signal => (
                  <SignalChip key={signal} signal={signal} />
                ))}
              </div>
            </div>
            <details className="border-ink-700 bg-ink-850 rounded-xl border p-4">
              <summary className="text-iris-200 cursor-pointer text-[11px] font-bold uppercase tracking-wide">
                Debrief · what a strong answer sounds like
              </summary>
              <div className="mt-2">
                <Markdown source={step.debrief} />
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <button className={primaryButtonClass} onClick={() => start(scenario)} type="button">
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
      <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <button className={ghostButtonClass} onClick={backToSetup} type="button">
          ← scenarios
        </button>
        <span className="text-ink-50 min-w-0 truncate text-[13px] font-bold">{scenario.title}</span>
        <span
          className={`font-code rounded-full border px-2.5 py-1 text-[12px] font-semibold ${
            secondsLeft <= 120 ? 'border-danger-400/60 bg-danger-400/10 text-danger-300' : 'border-ink-600 text-ink-100'
          }`}>
          {formatClock(secondsLeft)}
        </span>
        <ModeSwitch className="hidden lg:flex" mode="mock" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="text-ink-300 flex items-center gap-1.5 text-[11px]">
            <span className="hidden sm:inline">language</span>
            <select className={selectClass} onChange={changeLanguage} value={language}>
              {LANGUAGES.map(item => (
                <option key={item} value={item}>
                  {LANGUAGE_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <button className={ghostButtonClass} onClick={onFinish} type="button">
            Finish &amp; report
          </button>
          <button className={primaryButtonClass} onClick={onSubmit} type="button">
            Submit ⌘⏎
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(17rem,0.9fr)_minmax(24rem,1.15fr)_minmax(17rem,0.8fr)] lg:overflow-hidden">
        <section className="border-ink-700 min-h-0 border-b p-4 lg:h-full lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <p className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">{scenario.role}</p>
          <p className="text-ink-200 mt-2 text-[12px] leading-relaxed">{scenario.prompt}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {scenario.signals.map(signal => (
              <SignalChip key={signal} signal={signal} />
            ))}
          </div>
          <div className="border-ink-700 mt-4 border-t pt-3">
            <p className="text-ink-400 mb-1 text-[10px] font-bold uppercase tracking-wider">The brief</p>
            <Markdown source={step.task} />
          </div>
        </section>

        <section className="border-ink-700 flex min-h-0 flex-col border-b lg:h-full lg:border-b-0 lg:border-r">
          <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
            <span className="font-code text-ink-200 text-[11px]">{fileName(step.file, language)}</span>
            <span className="border-warning-400/40 bg-warning-400/10 text-warning-300 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold">
              AI draft
            </span>
            <span className="text-ink-400 ml-auto text-[10px]">edit, then submit</span>
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

        <aside className="flex min-h-[28rem] flex-col lg:h-full lg:min-h-0">
          <div className="border-ink-700 flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div>
              <p className="text-ink-50 text-[12px] font-bold">AI pair</p>
              <p className="text-ink-400 text-[10px]">offline · deterministic</p>
            </div>
            <span className="font-code text-ink-400 text-[10px]">{hints} hints</span>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-1.5 p-2 pb-1">
            <button className={ghostButtonClass} onClick={onDraft} type="button">
              Draft with AI
            </button>
            <button className={ghostButtonClass} onClick={onReview} type="button">
              Review my fix
            </button>
            <button className={ghostButtonClass} onClick={onExplain} type="button">
              What did it miss?
            </button>
            <button className={ghostButtonClass} onClick={onTestIdea} type="button">
              Test idea
            </button>
          </div>
          <div className="shrink-0 px-2 pb-2">
            <button className={`${ghostButtonClass} w-full`} onClick={() => void onCopyPrompt()} type="button">
              {promptCopied ? 'Prompt copied ✓' : 'Copy prompt for your own AI'}
            </button>
          </div>
          {promptText !== null ? (
            <div className="border-ink-700 shrink-0 border-t p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">Prompt for your AI</span>
                <button
                  className="text-ink-400 hover:text-ink-50 text-[10px]"
                  onClick={() => setPromptText(null)}
                  type="button">
                  hide
                </button>
              </div>
              <textarea
                className="border-ink-600 bg-ink-900 text-ink-200 focus:border-iris-400 mt-1 h-28 w-full resize-y rounded-lg border p-2 font-mono text-[10px] outline-none"
                onFocus={event => event.currentTarget.select()}
                readOnly
                value={promptText}
              />
            </div>
          ) : null}
          <div
            aria-live="polite"
            className="border-ink-700 min-h-0 flex-1 space-y-2 overflow-y-auto border-t p-2"
            ref={logRef}>
            {messages.map(message => (
              <div
                className={`whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                  message.from === 'ai'
                    ? message.tone === 'warn'
                      ? 'border-warning-400/30 bg-warning-400/[0.06] text-ink-200 border'
                      : message.tone === 'ok'
                      ? 'border-success-400/30 bg-success-400/[0.06] text-ink-200 border'
                      : 'border-ink-700 bg-ink-850 text-ink-200 border'
                    : 'bg-iris-400/10 text-ink-200 ml-6'
                }`}
                key={message.id}>
                <span className="text-ink-400 mb-0.5 block text-[9px] font-bold uppercase tracking-wider">
                  {message.from === 'ai' ? 'AI pair' : 'you'}
                </span>
                {message.text}
              </div>
            ))}
          </div>
          <p className="text-ink-400 border-ink-700 shrink-0 border-t px-3 py-2 text-[10px] leading-relaxed">
            The pair is simulated: it uses the exercise’s draft, checks and notes. It never sees a hosted model, and it
            does not grade you — the checks do.
          </p>
        </aside>
      </main>
    </div>
  );
});
MockInterview.displayName = 'MockInterview';

export default MockInterview;
