import type {EditorView} from '@codemirror/view';
import {useRouter} from 'next/router';
import {
  type ChangeEvent,
  type CSSProperties,
  type FC,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {problems} from '@/data/problems';
import {downloadMarkdown, exportFileName, problemToMarkdown, siteUrl} from '@/lib/export';
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
} from '@/lib/types';

import Confetti from './Confetti';
import {selectClass} from './paneShared';
import ProblemList from './ProblemList';
import ProblemPane, {type PaneTab, unlocked} from './ProblemPane';
import SplitGutter from './SplitGutter';
import StepEditor from './StepEditor';
import VerdictPane from './VerdictPane';

const problemById: Record<string, Problem> = {};
for (const problem of problems) problemById[problem.id] = problem;

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

const InfoPopover: FC = memo(() => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = useCallback(() => setOpen(o => !o), []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="about LeetBuild"
        className="flex h-7 w-7 items-center justify-center rounded-full border border-plum-600 text-[12px] text-plum-200 transition hover:border-candy-500 hover:text-white"
        onClick={toggle}
        type="button">
        ⓘ
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-[320px] rounded-xl border border-plum-500/70 bg-plum-950 p-3 text-[12px] leading-relaxed text-plum-200 shadow-2xl">
          <p className="text-[11px] font-bold uppercase tracking-wider text-candy-400">How it works</p>
          <p className="mt-1">
            Each problem is a small system built one file at a time. Pick a language, implement the step, submit. The
            judge runs static checks: it reads your code for the properties a correct implementation has (the route, the
            TTL, the commit after the side effect) — nothing is compiled or executed, no broker is contacted.
          </p>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-candy-400">Scoring</p>
          <p className="mt-1">
            Steps are worth 11 / 21 / 30 points (easy / medium / hard); the ten courses add up to exactly 1337. Every
            hint costs 20%, every wrong submission 5% (floor 25%). Revealing the solution finishes the step for 0
            points. Progress stays in this browser.
          </p>
        </div>
      ) : null}
    </div>
  );
});
InfoPopover.displayName = 'InfoPopover';

const TOAST_MS = 6000;

const BadgeToast: FC<{id: number; badge: Badge; onDismiss: (id: number) => void}> = memo(({id, badge, onDismiss}) => {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss]);
  const onClick = useCallback(() => onDismiss(id), [id, onDismiss]);
  return (
    <button
      className="pointer-events-auto flex items-center gap-3 rounded-xl border border-candy-400/70 bg-plum-950 p-3 text-left shadow-[0_0_28px_rgba(255,63,166,0.35)] transition hover:border-candy-300"
      onClick={onClick}
      type="button">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-candy-500 font-code text-[11px] font-bold text-white">
        {badge.glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-candy-400">Badge earned</span>
        <span className="block text-[13px] font-semibold text-white">{badge.title}</span>
        <span className="block text-[11px] text-plum-300">{badge.blurb}</span>
      </span>
    </button>
  );
});
BadgeToast.displayName = 'BadgeToast';

const Skeleton: FC = memo(() => (
  <div className="leetbuild-playground flex h-dvh flex-col overflow-hidden bg-plum-900 text-cream">
    <header className="flex shrink-0 items-center gap-3 border-b border-plum-600/60 bg-plum-950/60 px-3 py-2">
      <span className="bg-gradient-to-r from-candy-400 to-white bg-clip-text text-lg font-extrabold tracking-tight text-transparent">
        LeetBuild
      </span>
      <span className="animate-pulse text-[11px] text-plum-300">restoring your progress…</span>
    </header>
    <div className="mx-auto w-full max-w-4xl animate-pulse space-y-3 p-5">
      <div className="h-6 w-1/3 rounded bg-plum-800" />
      <div className="h-3 w-2/3 rounded bg-plum-800/70" />
      <div className="h-32 rounded-xl bg-plum-800/50" />
      <div className="h-16 rounded-xl bg-plum-800/40" />
      <div className="h-16 rounded-xl bg-plum-800/40" />
    </div>
  </div>
));
Skeleton.displayName = 'LeetBuildSkeleton';

const LeetBuildPlayground: FC = memo(() => {
  const router = useRouter();
  const store = useMemo(() => getProgressStore(), []);
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [loaded, setLoaded] = useState(false);
  const [problemId, setProblemId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [tab, setTab] = useState<PaneTab>('step');
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
  const codeRef = useRef(code);
  /** Saved code per `problem/step/language`, restored from the store and updated on every edit. */
  const workspaces = useRef<Record<string, Workspace>>({});
  codeRef.current = code;

  const problem = problemId === null ? null : problemById[problemId] ?? null;
  const stepIndex = problem === null ? -1 : problem.steps.findIndex(s => s.id === stepId);
  const step: Step | null = problem !== null && stepIndex >= 0 ? problem.steps[stepIndex] : null;
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

  const openProblem = useCallback(
    (id: string, current: Progress, wantedStep?: string) => {
      const target = problemById[id];
      if (target === undefined) return;
      const wanted = wantedStep ?? current.lastStep[id];
      let index = wanted === undefined ? 0 : target.steps.findIndex(s => s.id === wanted);
      if (index < 0 || !unlocked(target, index, current.attempts)) index = 0;
      const targetStep = target.steps[index];
      // A problem never touched opens on its description, like LeetCode; afterwards straight to the step.
      const fresh =
        current.lastStep[id] === undefined &&
        target.steps.every(s => current.attempts[stepKey(id, s.id)] === undefined);
      setProblemId(id);
      setStepId(targetStep.id);
      setTab(fresh ? 'problem' : 'step');
      setPaneOpen(true);
      openWorkspace(target, targetStep, current.language);
      setProgress(p =>
        p.lastProblem === id && p.lastStep[id] === targetStep.id
          ? p
          : {...p, lastProblem: id, lastStep: {...p.lastStep, [id]: targetStep.id}},
      );
    },
    [openWorkspace],
  );

  // Restore progress and workspaces on first mount; `?p=<problem>&s=<step>` wins over the saved position.
  useEffect(() => {
    let cancelled = false;
    void store.load().then(snapshot => {
      if (cancelled) return;
      workspaces.current = snapshot.workspaces;
      setProgress(snapshot.progress);
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('p');
      if (fromUrl !== null && problemById[fromUrl] !== undefined) {
        openProblem(fromUrl, snapshot.progress, params.get('s') ?? undefined);
      } else if (snapshot.progress.lastProblem !== null) {
        openProblem(snapshot.progress.lastProblem, snapshot.progress);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      void store.flush();
    };
  }, [store, openProblem]);

  // Keep the address bar shareable: /leetbuild?p=<problem>&s=<step> (replace, so Back leaves the page).
  useEffect(() => {
    if (!loaded) return;
    const query = problemId === null || stepId === null ? {} : {p: problemId, s: stepId};
    void router.replace({pathname: router.pathname, query}, undefined, {shallow: true});
    // `router` is stable for the page's lifetime; listing it would re-run this on every shallow change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, problemId, stepId]);

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

  // Navigation -------------------------------------------------------------------------------------
  const onOpenProblem = useCallback((id: string) => openProblem(id, progress), [openProblem, progress]);

  const onBack = useCallback(() => {
    setProblemId(null);
    setStepId(null);
    setVerdict(null);
    setProgress(p => (p.lastProblem === null ? p : {...p, lastProblem: null}));
  }, []);

  const onSelectStep = useCallback(
    (id: string) => {
      if (problem === null) return;
      const index = problem.steps.findIndex(s => s.id === id);
      if (index < 0 || !unlocked(problem, index, progress.attempts)) return;
      const target = problem.steps[index];
      setStepId(target.id);
      setTab('step');
      setPaneOpen(true);
      openWorkspace(problem, target, language);
      setProgress(p => ({...p, lastStep: {...p.lastStep, [problem.id]: target.id}}));
    },
    [problem, progress.attempts, language, openWorkspace],
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
    if (
      !window.confirm(
        `Start "${problem.title}" over? Step results, hints used and your code for this problem in every language will be cleared.`,
      )
    )
      return;
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
    setStepId(first.id);
    setTab('step');
    openWorkspace(problem, first, language);
  }, [problem, language, openWorkspace, store]);

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
    editorRef.current?.focus();
  }, [problem, step, attemptKey, language, progress.attempts]);

  // Cmd/Ctrl+Enter submits from anywhere on the page (the editor has its own binding too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
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
    if (!window.confirm("Restore this step's starting code? Your edits to this file will be lost.")) return;
    setCode(starter);
    setResetKey(k => k + 1);
  }, [step, language]);
  const togglePane = useCallback(() => setPaneOpen(v => !v), []);

  // Export & share ---------------------------------------------------------------------------------
  const onDownloadProblem = useCallback(() => {
    if (problem === null) return;
    downloadMarkdown(exportFileName(problem.id, language), problemToMarkdown(problem, language));
  }, [problem, language]);
  const onShare = useCallback(async (): Promise<boolean> => {
    if (problem === null) return false;
    const text = shareText(problem, progress.attempts, language, `${siteUrl()}?p=${problem.id}`);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      window.prompt('Copy your result card:', text);
      return false;
    }
  }, [problem, progress.attempts, language]);

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
    <div className="leetbuild-playground flex h-dvh flex-col overflow-hidden bg-plum-900 text-cream">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-plum-600/60 bg-plum-950/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            className="bg-gradient-to-r from-candy-400 to-white bg-clip-text text-lg font-extrabold tracking-tight text-transparent"
            onClick={onBack}
            title="all problems"
            type="button">
            LeetBuild
          </button>
          <span className="hidden text-[11px] text-plum-300 sm:inline">build systems, not just algorithms</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-plum-300">
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
            className="rounded-full border border-plum-500/70 px-2.5 py-1 font-code text-[11px] text-plum-200"
            title={profile.rank}>
            {profile.score}
            <span className="text-plum-400">/{profile.max}</span> pts
          </span>
          {streak.current > 0 ? (
            <span
              className="hidden rounded-full border border-candy-500/50 bg-candy-500/10 px-2.5 py-1 font-code text-[11px] text-candy-200 sm:inline"
              title={`you accepted a step on ${streak.current} consecutive day${
                streak.current === 1 ? '' : 's'
              } (best ${streak.best})`}>
              {streak.current}d streak
            </span>
          ) : null}
          <InfoPopover />
        </div>
      </header>

      {problem === null || step === null ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ProblemList
            attempts={progress.attempts}
            badges={progress.badges}
            onOpen={onOpenProblem}
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
          <section className="min-h-0 min-w-0 border-b border-plum-600/60 lg:h-full lg:border-b-0">
            <button
              className="flex w-full items-center justify-between px-4 py-2 text-left text-[12px] font-semibold text-candy-300 lg:hidden"
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
              <div className="flex flex-wrap items-center gap-2 border-b border-plum-600/60 px-2 py-1.5">
                <span className="rounded-t-md border border-b-0 border-plum-500 bg-plum-800 px-2 py-0.5 font-code text-[11px] text-white">
                  {fileName(step.file, language)}
                </span>
                <span
                  className="hidden font-code text-[10px] text-plum-400 md:inline"
                  title="library the reference solution uses">
                  {LANGUAGE_STACK[language][step.concept]}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className="rounded-md px-2 py-1 text-[11px] text-plum-300 transition hover:text-white"
                    onClick={onResetCode}
                    title="restore the step's starting code"
                    type="button">
                    reset
                  </button>
                  <button
                    className="rounded-lg bg-candy-500 px-3 py-1 text-[12px] font-bold text-white shadow-[0_0_18px_rgba(255,63,166,0.35)] transition hover:bg-candy-400"
                    onClick={submit}
                    title="Cmd/Ctrl + Enter"
                    type="button">
                    Submit ⌘⏎
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
            <div className="flex h-[40vh] min-h-0 min-w-0 flex-col border-t border-plum-600/60 lg:h-auto lg:border-t-0">
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
