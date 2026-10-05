import type {EditorView} from '@codemirror/view';
import Router from 'next/router';
import {
  type ChangeEvent,
  type CSSProperties,
  type FC,
  type FocusEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {problems} from '@/data/problems';
import {downloadMarkdown, exportFileName, problemToMarkdown, problemUrl} from '@/lib/export';
import {type Badge, badgeOf, dayKey, earnedBadges, shareText, streakOf} from '@/lib/gamify';
import {type Verdict, judge} from '@/lib/judge';
import {
  type StepAttempt,
  type Submission,
  HISTORY_LENGTH,
  OPEN_ATTEMPT,
  profile as computeProfile,
  stepScore,
} from '@/lib/scoring';
import {type Progress, type Workspace, EMPTY_PROGRESS, getProgressStore, workspaceKey} from '@/lib/storage';
import {
  type Language,
  type Problem,
  type Step,
  fileName,
  LANGUAGE_LABEL,
  LANGUAGE_STACK,
  LANGUAGES,
  stepKey,
  stepPath,
} from '@/lib/types';

import Confetti from './Confetti';
import {useDialog} from './Dialog';
import {selectClass} from './paneShared';
import ProblemList from './ProblemList';
import ProblemPane, {type PaneTab, unlocked} from './ProblemPane';
import SplitGutter from './SplitGutter';
import StepEditor from './StepEditor';
import ThemeToggle from './ThemeToggle';
import VerdictPane from './VerdictPane';

const problemById: Record<string, Problem> = {};
for (const problem of problems) problemById[problem.id] = problem;

/**
 * The step an address opens: the named one when it exists and is reachable, otherwise the first.
 * `/<problem>` passes the step last visited (or nothing, for a never-opened problem).
 */
const resolveStep = (problem: Problem, attempts: Record<string, StepAttempt>, wanted: string | undefined): Step => {
  const index = wanted === undefined ? 0 : problem.steps.findIndex(s => s.id === wanted);
  return problem.steps[index >= 0 && unlocked(problem, index, attempts) ? index : 0];
};

const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);
/** The submit shortcut as this platform writes it (the playground never renders on the server). */
const SUBMIT_KEYS = MAC ? '⌘⏎' : 'Ctrl+⏎';
const SUBMIT_SHORTCUT = MAC ? '⌘ Enter' : 'Ctrl + Enter';

/** Below `lg` the checks sit under the editor instead of beside it. */
const STACKED = '(max-width: 1023px)';

// ---- resizable layout ----------------------------------------------------------------------------

/** Panel shares at `lg` and up: problem pane vs IDE (x), editor vs checks inside the IDE (y). */
interface Split {
  x: number;
  y: number;
}

const DEFAULT_SPLIT: Split = {x: 0.44, y: 0.6};
const SPLIT_BOUNDS = {x: {min: 0.22, max: 0.7}, y: {min: 0.25, max: 0.85}};
const SPLIT_KEY = 'leetbuild:layout';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const loadSplit = (): Split => {
  try {
    const raw = window.localStorage.getItem(SPLIT_KEY);
    if (raw === null) return DEFAULT_SPLIT;
    const parsed = JSON.parse(raw) as Partial<Split>;
    return {
      x: typeof parsed.x === 'number' ? clamp(parsed.x, SPLIT_BOUNDS.x.min, SPLIT_BOUNDS.x.max) : DEFAULT_SPLIT.x,
      y: typeof parsed.y === 'number' ? clamp(parsed.y, SPLIT_BOUNDS.y.min, SPLIT_BOUNDS.y.max) : DEFAULT_SPLIT.y,
    };
  } catch {
    return DEFAULT_SPLIT;
  }
};

const TOAST_MS = 6000;

/** Body of the share fallback when the clipboard is unavailable: the card, selected for a manual copy. */
const ShareCard: FC<{text: string}> = memo(({text}) => {
  const selectAll = useCallback((e: FocusEvent<HTMLTextAreaElement>) => e.currentTarget.select(), []);
  return (
    <>
      <p>The clipboard is not available here; copy the card by hand.</p>
      <textarea
        className="border-ink-600 bg-ink-900 font-code text-ink-100 focus:border-iris-400 mt-2 w-full resize-none rounded-lg border p-2 text-[11px] leading-relaxed focus:outline-none focus:ring-0"
        onFocus={selectAll}
        readOnly
        rows={8}
        value={text}
      />
    </>
  );
});
ShareCard.displayName = 'ShareCard';

const BadgeToast: FC<{id: number; badge: Badge; onDismiss: (id: number) => void}> = memo(({id, badge, onDismiss}) => {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss]);
  const onClick = useCallback(() => onDismiss(id), [id, onDismiss]);
  return (
    <button
      className="border-iris-400/60 bg-ink-800 hover:border-iris-300 pointer-events-auto flex items-center gap-3 rounded-xl border p-3 text-left shadow-2xl transition"
      onClick={onClick}
      type="button">
      <span className="bg-iris-400 font-code text-ink-950 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
        {badge.glyph}
      </span>
      <span className="min-w-0">
        <span className="text-iris-400 block text-[11px] font-bold uppercase tracking-wider">Badge earned</span>
        <span className="text-ink-50 block text-[13px] font-semibold">{badge.title}</span>
        <span className="text-ink-300 block text-[11px]">{badge.blurb}</span>
      </span>
    </button>
  );
});
BadgeToast.displayName = 'BadgeToast';

const Skeleton: FC = memo(() => (
  <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
    <header className="border-ink-700 bg-ink-950/60 flex shrink-0 items-center gap-3 border-b px-3 py-2">
      <span className="from-iris-300 to-ink-50 bg-gradient-to-r bg-clip-text text-lg font-extrabold tracking-tight text-transparent">
        LeetBuild
      </span>
      <span className="text-ink-300 animate-pulse text-[11px]">restoring your progress…</span>
    </header>
    <div className="mx-auto w-full max-w-4xl animate-pulse space-y-3 p-5">
      <div className="bg-ink-800 h-6 w-1/3 rounded" />
      <div className="bg-ink-800/70 h-3 w-2/3 rounded" />
      <div className="bg-ink-800/50 h-32 rounded-xl" />
      <div className="bg-ink-800/40 h-16 rounded-xl" />
      <div className="bg-ink-800/40 h-16 rounded-xl" />
    </div>
  </div>
));
Skeleton.displayName = 'LeetBuildSkeleton';

/** `problemId`/`stepId` come from the address (`/`, `/<problem>`, `/<problem>/<step>`); the URL is the source of truth. */
const LeetBuildPlayground: FC<{problemId: string | null; stepId: string | null}> = memo(({problemId, stepId}) => {
  const store = useMemo(() => getProgressStore(), []);
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<PaneTab>('step');
  const [dialog, openDialog] = useDialog();
  const [code, setCode] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [verdictCode, setVerdictCode] = useState('');
  const [earned, setEarned] = useState<number | null>(null);
  const [paneOpen, setPaneOpen] = useState(true);
  /** Bumped on every fresh accept; each value mounts one confetti burst. */
  const [celebration, setCelebration] = useState(0);
  const [toasts, setToasts] = useState<{id: number; badge: Badge}[]>([]);
  const toastId = useRef(0);
  /** Badges found on the first reconciliation after load are recorded silently, not announced. */
  const announceBadges = useRef(false);
  const [split, setSplit] = useState<Split>(loadSplit);
  const mainRef = useRef<HTMLElement>(null);
  const ideRef = useRef<HTMLElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef(code);
  const progressRef = useRef(progress);
  /** Saved code per `problem/step/language`, restored from the store and updated on every edit. */
  const workspaces = useRef<Record<string, Workspace>>({});
  codeRef.current = code;
  progressRef.current = progress;

  const problem = problemId === null ? null : problemById[problemId] ?? null;
  const step: Step | null =
    problem === null ? null : resolveStep(problem, progress.attempts, stepId ?? progress.lastStep[problem.id]);
  const stepIndex = problem === null || step === null ? -1 : problem.steps.indexOf(step);
  const language = progress.language;
  const attemptKey = problem !== null && step !== null ? stepKey(problem.id, step.id) : null;
  const attempt: StepAttempt = attemptKey === null ? OPEN_ATTEMPT : progress.attempts[attemptKey] ?? OPEN_ATTEMPT;
  const profile = useMemo(
    () => computeProfile(problems, progress.attempts, progress.submissions, progress.acceptedSubmissions),
    [progress.attempts, progress.submissions, progress.acceptedSubmissions],
  );
  const streak = useMemo(() => streakOf(progress.activeDays, dayKey(new Date())), [progress.activeDays]);

  // Badges are a function of the attempts; new ones are stored (never revoked) and announced.
  useEffect(() => {
    if (!loaded) return;
    const earnedNow = earnedBadges(problems, progress.attempts, progress.activeDays, dayKey(new Date()));
    const fresh = earnedNow.filter(id => progress.badges[id] === undefined);
    if (fresh.length === 0) {
      announceBadges.current = true;
      return;
    }
    const now = Date.now();
    if (announceBadges.current) {
      setToasts(t => [
        ...t,
        ...fresh
          .map(id => ({id: ++toastId.current, badge: badgeOf(id)}))
          .filter((x): x is {id: number; badge: Badge} => x.badge !== undefined),
      ]);
    }
    announceBadges.current = true;
    setProgress(p => {
      const badges = {...p.badges};
      for (const id of fresh) badges[id] = now;
      return {...p, badges};
    });
  }, [loaded, progress.attempts, progress.activeDays, progress.badges]);

  const dismissToast = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const onCelebrated = useCallback(() => setCelebration(0), []);

  const openWorkspace = useCallback((target: Problem, targetStep: Step, lang: Language) => {
    const saved = workspaces.current[workspaceKey(target.id, targetStep.id, lang)];
    setCode(saved === undefined ? targetStep.code[lang].starter : saved.code);
    setResetKey(k => k + 1);
    setVerdict(null);
    setVerdictCode('');
    setEarned(null);
  }, []);

  // Restore progress and workspaces on first mount.
  useEffect(() => {
    let cancelled = false;
    void store.load().then(snapshot => {
      if (cancelled) return;
      workspaces.current = snapshot.workspaces;
      setProgress(snapshot.progress);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      void store.flush();
    };
  }, [store]);

  // Canonical address: `/<problem>`, a locked step and an unknown step all resolve to a real step; show it.
  useEffect(() => {
    if (loaded && problem !== null && step !== null && step.id !== stepId) {
      void Router.replace(stepPath(problem, step));
    }
  }, [loaded, problem, step, stepId]);

  // Arriving at a step (by link, chip, Back or Forward): load its saved code and remember the position.
  // A problem never touched opens on its description, like LeetCode; afterwards straight to the step.
  useEffect(() => {
    if (!loaded || problem === null || step === null) return;
    const current = progressRef.current;
    const fresh =
      current.lastStep[problem.id] === undefined &&
      problem.steps.every(s => current.attempts[stepKey(problem.id, s.id)] === undefined);
    setTab(fresh ? 'problem' : 'step');
    setPaneOpen(true);
    openWorkspace(problem, step, current.language);
    setProgress(p =>
      p.lastStep[problem.id] === step.id ? p : {...p, lastStep: {...p.lastStep, [problem.id]: step.id}},
    );
  }, [loaded, problem, step, openWorkspace]);

  // Persist the current workspace and progress (debounced by the store) ----------------------------
  useEffect(() => {
    if (!loaded || problem === null || step === null) return;
    const key = workspaceKey(problem.id, step.id, language);
    const state: Workspace = {code, updatedAt: Date.now()};
    workspaces.current[key] = state;
    store.saveWorkspace(key, state);
  }, [code, language, loaded, problem, step, store]);

  useEffect(() => {
    if (!loaded) return;
    store.saveProgress(progress);
  }, [progress, loaded, store]);

  // Navigation: every move is a route change, so Back and Forward retrace the learner's path ---------
  const onBack = useCallback(() => {
    void Router.push('/');
  }, []);

  const onSelectStep = useCallback(
    (id: string) => {
      if (problem === null || step === null) return;
      if (id === step.id) {
        // The open step's own chip, clicked from the description tab: nothing to navigate to.
        setTab('step');
        setPaneOpen(true);
        return;
      }
      const index = problem.steps.findIndex(s => s.id === id);
      if (index < 0 || !unlocked(problem, index, progress.attempts)) return;
      void Router.push(stepPath(problem, problem.steps[index]));
    },
    [problem, step, progress.attempts],
  );

  const onNextStep = useCallback(() => {
    if (problem === null || stepIndex < 0 || stepIndex + 1 >= problem.steps.length) return;
    onSelectStep(problem.steps[stepIndex + 1].id);
  }, [problem, stepIndex, onSelectStep]);

  const onPrevStep = useCallback(() => {
    if (problem === null || stepIndex <= 0) return;
    onSelectStep(problem.steps[stepIndex - 1].id);
  }, [problem, stepIndex, onSelectStep]);

  /** Clear every attempt and saved workspace of the problem and start it over from step 1. */
  const onResetProblem = useCallback(() => {
    if (problem === null) return;
    void openDialog({
      title: `Start "${problem.title}" over?`,
      body: 'Step results, hints used and your code for this problem in every language will be cleared.',
      confirm: 'Start over',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      for (const s of problem.steps) {
        for (const lang of LANGUAGES) {
          const key = workspaceKey(problem.id, s.id, lang);
          delete workspaces.current[key];
          store.deleteWorkspace(key);
        }
      }
      const first = problem.steps[0];
      setProgress(p => {
        const attempts = {...p.attempts};
        for (const s of problem.steps) delete attempts[stepKey(problem.id, s.id)];
        return {...p, attempts, lastStep: {...p.lastStep, [problem.id]: first.id}};
      });
      setTab('step');
      // Clearing the attempts locks every later step, so the address re-resolves to step 1 and opens it;
      // only when step 1 is already open does nothing change and the starter has to be loaded here.
      if (stepIndex === 0) openWorkspace(problem, first, language);
    });
  }, [problem, stepIndex, language, openWorkspace, openDialog, store]);

  const onLanguage = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const lang = e.target.value as Language;
      if (!LANGUAGES.includes(lang) || lang === language) return;
      setProgress(p => ({...p, language: lang}));
      if (problem !== null && step !== null) openWorkspace(problem, step, lang);
    },
    [language, problem, step, openWorkspace],
  );

  // Judging ----------------------------------------------------------------------------------------
  const submit = useCallback(() => {
    if (problem === null || step === null || attemptKey === null) return;
    const src = codeRef.current;
    const result = judge(step, language, src);
    setVerdict(result);
    setVerdictCode(src);
    const now = Date.now();
    const previous = progress.attempts[attemptKey] ?? OPEN_ATTEMPT;
    let next: StepAttempt = previous;
    if (previous.status === 'open') {
      next = result.accepted
        ? {...previous, status: 'accepted', language, solvedAt: now}
        : {...previous, wrong: previous.wrong + 1, language};
    }
    const submission: Submission = {
      at: now,
      language,
      passed: result.passed,
      total: result.total,
      accepted: result.accepted,
    };
    next = {...next, history: [...(previous.history ?? []), submission].slice(-HISTORY_LENGTH)};
    setEarned(result.accepted ? stepScore(problem.difficulty, next) : null);
    const freshlyAccepted = previous.status === 'open' && result.accepted;
    const today = dayKey(new Date(now));
    setProgress(p => ({
      ...p,
      attempts: {...p.attempts, [attemptKey]: next},
      submissions: p.submissions + 1,
      acceptedSubmissions: p.acceptedSubmissions + (result.accepted ? 1 : 0),
      activeDays: freshlyAccepted && !p.activeDays.includes(today) ? [...p.activeDays, today] : p.activeDays,
    }));
    if (freshlyAccepted) setCelebration(c => c + 1);
    // Stacked layout: the verdict is off-screen under the editor, so bring it up instead of raising the keyboard.
    if (window.matchMedia(STACKED).matches) verdictRef.current?.scrollIntoView({behavior: 'smooth', block: 'start'});
    else editorRef.current?.focus();
  }, [problem, step, attemptKey, language, progress.attempts]);

  // Cmd/Ctrl+Enter submits from anywhere on the page (the editor has its own binding too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && document.querySelector('dialog[open]') === null) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  const onRevealHint = useCallback(
    (count: number) => {
      if (step === null || attemptKey === null) return;
      const capped = Math.min(count, step.hints.length);
      setProgress(p => {
        const current = p.attempts[attemptKey] ?? OPEN_ATTEMPT;
        if (current.status !== 'open' || current.hints >= capped) return p;
        return {...p, attempts: {...p.attempts, [attemptKey]: {...current, hints: capped}}};
      });
    },
    [step, attemptKey],
  );

  const onRevealSolution = useCallback(() => {
    if (attemptKey === null) return;
    setProgress(p => {
      const current = p.attempts[attemptKey] ?? OPEN_ATTEMPT;
      if (current.status !== 'open') return p;
      return {
        ...p,
        attempts: {...p.attempts, [attemptKey]: {...current, status: 'revealed', language, solvedAt: Date.now()}},
      };
    });
  }, [attemptKey, language]);

  // Editor actions ---------------------------------------------------------------------------------
  const onCodeChange = useCallback((value: string) => setCode(value), []);
  const onLoadSolution = useCallback((solution: string) => {
    setCode(solution);
    setResetKey(k => k + 1);
    setPaneOpen(false);
  }, []);
  const onResetCode = useCallback(() => {
    if (step === null) return;
    const starter = step.code[language].starter;
    if (codeRef.current === starter) return;
    void openDialog({
      title: "Restore this step's starting code?",
      body: 'Your edits to this file will be lost.',
      confirm: 'Restore',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      setCode(starter);
      setResetKey(k => k + 1);
    });
  }, [step, language, openDialog]);
  const togglePane = useCallback(() => setPaneOpen(v => !v), []);

  // Export & share ---------------------------------------------------------------------------------
  const onDownloadProblem = useCallback(() => {
    if (problem === null) return;
    downloadMarkdown(exportFileName(problem.id, language), problemToMarkdown(problem, language));
  }, [problem, language]);
  const onShare = useCallback(async (): Promise<boolean> => {
    if (problem === null) return false;
    const text = shareText(problem, progress.attempts, language, problemUrl(problem));
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      await openDialog({title: 'Copy your result card', body: <ShareCard text={text} />});
      return false;
    }
  }, [problem, progress.attempts, language, openDialog]);

  // Layout: the gutters report pixel deltas; convert them to shares of the container being split.
  const dragX = useCallback((delta: number) => {
    const width = mainRef.current?.clientWidth ?? 0;
    if (width === 0) return;
    setSplit(s => ({...s, x: clamp(s.x + delta / width, SPLIT_BOUNDS.x.min, SPLIT_BOUNDS.x.max)}));
  }, []);
  const dragY = useCallback((delta: number) => {
    const height = ideRef.current?.clientHeight ?? 0;
    if (height === 0) return;
    setSplit(s => ({...s, y: clamp(s.y + delta / height, SPLIT_BOUNDS.y.min, SPLIT_BOUNDS.y.max)}));
  }, []);
  const resetX = useCallback(() => setSplit(s => ({...s, x: DEFAULT_SPLIT.x})), []);
  const resetY = useCallback(() => setSplit(s => ({...s, y: DEFAULT_SPLIT.y})), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_KEY, JSON.stringify(split));
    } catch {
      // storage disabled: the layout just does not persist
    }
  }, [split]);
  // Grid templates in `fr` so the shares need no definite container size; the 8px track is the gutter.
  const mainStyle = useMemo(() => ({'--lb-cols': `${split.x}fr 8px ${1 - split.x}fr`} as CSSProperties), [split.x]);
  const ideStyle = useMemo(() => ({'--lb-rows': `${split.y}fr 8px ${1 - split.y}fr`} as CSSProperties), [split.y]);

  if (!loaded) return <Skeleton />;

  return (
    <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
      <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            className="from-iris-300 to-ink-50 bg-gradient-to-r bg-clip-text text-lg font-extrabold tracking-tight text-transparent"
            onClick={onBack}
            title="all problems"
            type="button">
            LeetBuild
          </button>
          <span className="text-ink-300 hidden text-[11px] sm:inline">build systems, not just algorithms</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-ink-300 flex items-center gap-1.5 text-[11px]">
            <span className="hidden sm:inline">language</span>
            <select className={selectClass} onChange={onLanguage} value={language}>
              {LANGUAGES.map(lang => (
                <option key={lang} value={lang}>
                  {LANGUAGE_LABEL[lang]}
                </option>
              ))}
            </select>
          </label>
          <span
            className="border-ink-600 font-code text-ink-200 rounded-full border px-2.5 py-1 text-[11px]"
            title={profile.rank}>
            {profile.score}
            <span className="text-ink-400">/{profile.max}</span> pts
          </span>
          {streak.current > 0 ? (
            <span
              className="border-iris-400/40 bg-iris-400/10 font-code text-iris-200 hidden rounded-full border px-2.5 py-1 text-[11px] sm:inline"
              title={`you accepted a step on ${streak.current} consecutive day${
                streak.current === 1 ? '' : 's'
              } (best ${streak.best})`}>
              {streak.current}d streak
            </span>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      {problem === null || step === null ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ProblemList
            attempts={progress.attempts}
            badges={progress.badges}
            problems={problems}
            profile={profile}
            streak={streak}
          />
        </main>
      ) : (
        <main
          className="min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[var(--lb-cols)] lg:overflow-hidden"
          ref={mainRef}
          style={mainStyle}>
          <section className="border-ink-700 min-h-0 min-w-0 border-b lg:h-full lg:border-b-0">
            <button
              className="text-iris-300 flex w-full items-center justify-between px-4 py-2 text-left text-[12px] font-semibold lg:hidden"
              onClick={togglePane}
              type="button">
              Step {stepIndex + 1}: {step.title}
              <span>{paneOpen ? '▾' : '▸'}</span>
            </button>
            <div className={`${paneOpen ? 'block' : 'hidden'} h-[62vh] overflow-hidden lg:block lg:h-full`}>
              <ProblemPane
                attempt={attempt}
                attempts={progress.attempts}
                language={language}
                onBack={onBack}
                onDownload={onDownloadProblem}
                onLoadSolution={onLoadSolution}
                onNextStep={onNextStep}
                onPrevStep={onPrevStep}
                onResetProblem={onResetProblem}
                onRevealHint={onRevealHint}
                onRevealSolution={onRevealSolution}
                onSelectStep={onSelectStep}
                onShare={onShare}
                onTab={setTab}
                problem={problem}
                step={step}
                stepIndex={stepIndex}
                tab={tab}
                userCode={code}
              />
            </div>
          </section>

          <SplitGutter axis="x" className="hidden lg:flex" onDrag={dragX} onReset={resetX} />

          <section
            className="flex min-h-0 min-w-0 flex-col lg:grid lg:h-full lg:grid-rows-[var(--lb-rows)]"
            ref={ideRef}
            style={ideStyle}>
            <div className="flex h-[56vh] min-h-0 min-w-0 flex-col lg:h-auto">
              <div className="border-ink-700 flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
                <span className="border-ink-600 bg-ink-800 font-code text-ink-50 rounded-t-md border border-b-0 px-2 py-0.5 text-[11px]">
                  {fileName(step.file, language)}
                </span>
                <span
                  className="font-code text-ink-400 hidden text-[10px] md:inline"
                  title="library the reference solution uses">
                  {LANGUAGE_STACK[language][step.concept]}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className="text-ink-300 hover:text-ink-50 rounded-md px-2 py-1 text-[11px] transition"
                    onClick={onResetCode}
                    title="restore the step's starting code"
                    type="button">
                    reset
                  </button>
                  <button
                    className="bg-iris-400 text-ink-950 hover:bg-iris-300 rounded-lg px-3 py-1 text-[12px] font-bold transition"
                    onClick={submit}
                    title={SUBMIT_SHORTCUT}
                    type="button">
                    Submit {SUBMIT_KEYS}
                  </button>
                </div>
              </div>
              <StepEditor
                className="min-h-0 min-w-0 flex-1"
                language={language}
                onChange={onCodeChange}
                onSubmit={submit}
                resetKey={`${problem.id}/${step.id}/${language}/${resetKey}`}
                value={code}
                viewRef={editorRef}
              />
            </div>
            <SplitGutter axis="y" className="hidden lg:flex" onDrag={dragY} onReset={resetY} />
            <div
              className="border-ink-700 flex h-[40vh] min-h-0 min-w-0 flex-col border-t lg:h-auto lg:border-t-0"
              ref={verdictRef}>
              <VerdictPane
                attempt={attempt}
                earned={earned}
                language={language}
                stale={verdict !== null && verdictCode !== code}
                step={step}
                verdict={verdict}
              />
            </div>
          </section>
        </main>
      )}
      {celebration > 0 ? <Confetti key={celebration} onDone={onCelebrated} /> : null}
      {dialog}
      {toasts.length > 0 ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[300px] flex-col gap-2">
          {toasts.map(t => (
            <BadgeToast badge={t.badge} id={t.id} key={t.id} onDismiss={dismissToast} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
LeetBuildPlayground.displayName = 'LeetBuildPlayground';

export default LeetBuildPlayground;
