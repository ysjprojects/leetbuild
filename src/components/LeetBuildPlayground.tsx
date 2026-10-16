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
import {type Verdict, judge, withRuntime} from '@/lib/judge';
import {type RuntimeStatus, getPythonRunner} from '@/lib/runtime/client';
import type {RunJob} from '@/lib/runtime/python';
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
  type SessionOutcome,
  elapsedSeconds,
  finishSession,
  formatClock,
  isComplete,
  SESSION_HISTORY,
  startTimer,
  stepsDone,
} from '@/lib/timer';
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

import {BadgeGlyph} from './Badges';
import Confetti from './Confetti';
import {useDialog} from './Dialog';
import {ghostButtonClass, selectClass} from './paneShared';
import ProblemList from './ProblemList';
import ProblemPane, {type PaneTab, unlocked} from './ProblemPane';
import SplitGutter from './SplitGutter';
import StepEditor from './StepEditor';
import ThemeToggle from './ThemeToggle';
import {BudgetPicker, TimerPill} from './Timer';
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

/**
 * Panel layout at `lg` and up: problem pane vs IDE share (x), editor vs checks share inside the IDE
 * (y), and whether the problem pane and the file explorer are shown. Saved in localStorage.
 */
interface Layout {
  x: number;
  y: number;
  pane: boolean;
  explorer: boolean;
}

const SPLIT_BOUNDS = {x: {min: 0.22, max: 0.7}, y: {min: 0.25, max: 0.85}};
const DEFAULT_SPLIT = {x: 0.44, y: 0.6};
const LAYOUT_KEY = 'leetbuild:layout';
/** Width of the problem pane while collapsed: a strip with the step title and the expand control. */
const COLLAPSED_PANE = '2.25rem';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The explorer starts open beside the editor and closed where it would sit above a stacked editor. */
const loadLayout = (): Layout => {
  const fallback: Layout = {...DEFAULT_SPLIT, pane: true, explorer: !window.matchMedia(STACKED).matches};
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      x: typeof parsed.x === 'number' ? clamp(parsed.x, SPLIT_BOUNDS.x.min, SPLIT_BOUNDS.x.max) : fallback.x,
      y: typeof parsed.y === 'number' ? clamp(parsed.y, SPLIT_BOUNDS.y.min, SPLIT_BOUNDS.y.max) : fallback.y,
      pane: typeof parsed.pane === 'boolean' ? parsed.pane : fallback.pane,
      explorer: typeof parsed.explorer === 'boolean' ? parsed.explorer : fallback.explorer,
    };
  } catch {
    return fallback;
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
      <BadgeGlyph badge={badge} earned size="lg" />
      <span className="min-w-0">
        <span className="text-iris-400 block text-[11px] font-bold uppercase tracking-wider">Badge earned</span>
        <span className="text-ink-50 block text-[13px] font-semibold">{badge.title}</span>
        <span className="text-ink-300 block text-[11px]">{badge.blurb}</span>
      </span>
    </button>
  );
});
BadgeToast.displayName = 'BadgeToast';

/** Marks the step's own file wherever it is listed: Submit judges that one. */
const TaskDot: FC = memo(() => (
  <span aria-label="this step's file" className="bg-iris-400 h-1.5 w-1.5 shrink-0 rounded-full" />
));
TaskDot.displayName = 'TaskDot';

/** An open file as an editor tab, VS Code style: click to show, × to close (shown on hover and while active). */
const FileTab: FC<{
  step: Step;
  index: number;
  language: Language;
  active: boolean;
  task: boolean;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}> = memo(({step, index, language, active, task, onOpen, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  const onClick = useCallback(() => onOpen(step.id), [onOpen, step.id]);
  const onCloseClick = useCallback(() => onClose(step.id), [onClose, step.id]);
  // The strip scrolls sideways; bring the active tab into view without touching the page's vertical scroll.
  useEffect(() => {
    const el = ref.current;
    const strip = el?.parentElement;
    if (!active || !el || !strip) return;
    const tab = el.getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left;
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right;
  }, [active]);
  const name = fileName(step.file, language);
  return (
    <div
      className={`group flex shrink-0 items-center rounded-t-md border pl-2 pr-1 text-[11px] transition ${
        active
          ? 'border-ink-600 bg-ink-800 text-ink-50 border-b-0'
          : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50 border-transparent'
      }`}
      ref={ref}>
      <button
        className="font-code flex items-center gap-1.5 py-0.5"
        onClick={onClick}
        title={task ? 'the file this step builds — Submit judges it' : `built in step ${index + 1}: ${step.title}`}
        type="button">
        {task ? <TaskDot /> : null}
        {name}
      </button>
      <button
        aria-label={`close ${name}`}
        className={`hover:bg-ink-700 touch:h-6 touch:w-6 touch:opacity-100 ml-1 flex h-4 w-4 items-center justify-center rounded text-[12px] leading-none transition ${
          active ? '' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'
        }`}
        onClick={onCloseClick}
        title="close"
        type="button">
        ×
      </button>
    </div>
  );
});
FileTab.displayName = 'FileTab';

/** The open files, in the order they were opened; the step's own file opens itself when the step does. */
const FileTabs: FC<{
  problem: Problem;
  language: Language;
  openTabs: readonly string[];
  openFile: string | null;
  /** The step being played: its file is marked. */
  stepId: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}> = memo(({problem, language, openTabs, openFile, stepId, onOpen, onClose}) => (
  <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
    {openTabs.map(id => {
      const index = problem.steps.findIndex(s => s.id === id);
      return index < 0 ? null : (
        <FileTab
          active={id === openFile}
          index={index}
          key={id}
          language={language}
          onClose={onClose}
          onOpen={onOpen}
          step={problem.steps[index]}
          task={id === stepId}
        />
      );
    })}
  </div>
));
FileTabs.displayName = 'FileTabs';

const STATUS_GLYPH: Record<StepAttempt['status'], {glyph: string; className: string; word: string}> = {
  accepted: {glyph: '✓', className: 'text-success-300', word: 'accepted'},
  revealed: {glyph: '◐', className: 'text-warning-300', word: 'solution revealed'},
  open: {glyph: '○', className: 'text-ink-400', word: 'open'},
};

const ExplorerRow: FC<{
  step: Step;
  index: number;
  language: Language;
  status: StepAttempt['status'];
  locked: boolean;
  active: boolean;
  task: boolean;
  onOpen: (id: string) => void;
}> = memo(({step, index, language, status, locked, active, task, onOpen}) => {
  const onClick = useCallback(() => onOpen(step.id), [onOpen, step.id]);
  const mark = STATUS_GLYPH[status];
  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pl-5 pr-2 text-left text-[11px] transition disabled:cursor-not-allowed ${
          active
            ? 'bg-ink-800 text-ink-50'
            : locked
            ? 'text-ink-500'
            : 'text-ink-200 hover:bg-ink-800/60 hover:text-ink-50'
        }`}
        disabled={locked}
        onClick={onClick}
        title={
          locked
            ? `step ${index + 1}: ${step.title} — unlocks once step ${index} is done`
            : `step ${index + 1}: ${step.title} — ${mark.word}${task ? '; Submit judges this file' : ''}`
        }
        type="button">
        <span aria-hidden className={`font-code w-3 shrink-0 text-center text-[10px] ${locked ? '' : mark.className}`}>
          {locked ? '🔒' : mark.glyph}
        </span>
        <span className="font-code min-w-0 truncate">{fileName(step.file, language)}</span>
        {task ? <TaskDot /> : null}
      </button>
    </li>
  );
});
ExplorerRow.displayName = 'ExplorerRow';

/**
 * The problem's virtual filesystem — one file per step, in the current language — as a file tree.
 * Every file is listed so the shape of the system is visible from step 1; locked ones wait for
 * their step, every other one opens in a tab and is editable from any step.
 */
const Explorer: FC<{
  problem: Problem;
  language: Language;
  attempts: Record<string, StepAttempt>;
  stepId: string;
  openFile: string | null;
  onOpen: (id: string) => void;
}> = memo(({problem, language, attempts, stepId, openFile, onOpen}) => (
  <nav aria-label="files" className="flex h-full min-h-0 flex-col">
    <div className="text-ink-400 shrink-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider">Explorer</div>
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      <div className="text-ink-100 flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold">
        <span aria-hidden className="text-ink-400 w-3 text-center text-[9px]">
          ▼
        </span>
        {problem.id}
      </div>
      <ul>
        {problem.steps.map((s, i) => (
          <ExplorerRow
            active={s.id === openFile}
            index={i}
            key={s.id}
            language={language}
            locked={!unlocked(problem, i, attempts)}
            onOpen={onOpen}
            status={attempts[stepKey(problem.id, s.id)]?.status ?? 'open'}
            step={s}
            task={s.id === stepId}
          />
        ))}
      </ul>
    </div>
  </nav>
));
Explorer.displayName = 'Explorer';

/** The problem pane folded into a strip (`lg` and up): the step title on its side, click to expand. */
const CollapsedPane: FC<{title: string; onExpand: () => void}> = memo(({title, onExpand}) => (
  <button
    className="border-ink-700 text-ink-300 hover:bg-ink-800 hover:text-ink-50 hidden h-full w-full flex-col items-center gap-3 overflow-hidden border-r py-2 transition lg:flex"
    onClick={onExpand}
    title="show the problem pane"
    type="button">
    <span aria-hidden className="text-[14px] leading-none">
      ›
    </span>
    <span className="min-h-0 text-[11px] font-semibold [writing-mode:vertical-rl]">{title}</span>
  </button>
));
CollapsedPane.displayName = 'CollapsedPane';

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
  /**
   * The open problem's filesystem in the current language: every step's file by step id, with the
   * learner's saved code or the starter. Edits to any file persist to that step's workspace, so
   * what step 1 wrote is there, as written, when step 2 opens.
   */
  const [files, setFiles] = useState<Record<string, string>>({});
  /** Files open as editor tabs (step ids, in opening order); the step's own file joins when the step opens. */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  /** Step id of the file in the editor (the active tab), or null when every tab was closed. */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [verdictCode, setVerdictCode] = useState('');
  const [earned, setEarned] = useState<number | null>(null);
  const runner = useMemo(() => getPythonRunner(), []);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(runner.status);
  /** A submission is executing in the runtime; its result is still to come. */
  const [running, setRunning] = useState(false);
  /** Bumped per submit and on every mount: a run that finishes after the step changed must not show its verdict. */
  const submitSeq = useRef(0);
  /** Below `lg` the problem pane is an accordion over the editor; this is its state (the `lg` sidebar is `layout.pane`). */
  const [paneOpen, setPaneOpen] = useState(true);
  /** Bumped on every fresh accept; each value mounts one confetti burst. */
  const [celebration, setCelebration] = useState(0);
  const [toasts, setToasts] = useState<{id: number; badge: Badge}[]>([]);
  const toastId = useRef(0);
  /** Badges found on the first reconciliation after load are recorded silently, not announced. */
  const announceBadges = useRef(false);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const mainRef = useRef<HTMLElement>(null);
  const ideRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef(files);
  const openTabsRef = useRef(openTabs);
  const openFileRef = useRef(openFile);
  const progressRef = useRef(progress);
  /** Problem whose filesystem is mounted; tabs survive step and language changes within it, not across problems. */
  const mounted = useRef<string | null>(null);
  /** Saved code per `problem/step/language`, restored from the store and written through on every edit. */
  const workspaces = useRef<Record<string, Workspace>>({});
  filesRef.current = files;
  openTabsRef.current = openTabs;
  openFileRef.current = openFile;
  progressRef.current = progress;

  const problem = problemId === null ? null : problemById[problemId] ?? null;
  const step: Step | null =
    problem === null ? null : resolveStep(problem, progress.attempts, stepId ?? progress.lastStep[problem.id]);
  const stepIndex = problem === null || step === null ? -1 : problem.steps.indexOf(step);
  const language = progress.language;
  const attemptKey = problem !== null && step !== null ? stepKey(problem.id, step.id) : null;
  const attempt: StepAttempt = attemptKey === null ? OPEN_ATTEMPT : progress.attempts[attemptKey] ?? OPEN_ATTEMPT;
  /** The step's own file — what Submit judges and the solution diffs against, whichever tab is open. */
  const stepCode = step === null ? '' : files[step.id] ?? step.code[language].starter;
  const openCode = openFile === null ? '' : files[openFile] ?? '';
  const profile = useMemo(
    () => computeProfile(problems, progress.attempts, progress.submissions, progress.acceptedSubmissions),
    [progress.attempts, progress.submissions, progress.acceptedSubmissions],
  );
  const today = dayKey(new Date());
  const streak = useMemo(() => streakOf(progress.activeDays, today), [progress.activeDays, today]);

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

  /** Show a file in the editor, opening a tab for it if it has none. */
  const openTab = useCallback((id: string) => {
    setOpenTabs(t => (t.includes(id) ? t : [...t, id]));
    setOpenFile(id);
  }, []);

  /** Close a tab; closing the active one shows its right-hand neighbour, else the left one, else nothing. */
  const closeTab = useCallback((id: string) => {
    const tabs = openTabsRef.current;
    const i = tabs.indexOf(id);
    if (i < 0) return;
    const next = tabs.filter(t => t !== id);
    setOpenTabs(next);
    if (openFileRef.current === id) setOpenFile(next[i] ?? next[i - 1] ?? null);
  }, []);

  /**
   * Mount the problem's filesystem in `lang` — every step's saved code or starter — and open
   * `targetStep`'s file. Tabs of the same problem stay open; another problem starts with one tab.
   */
  const mount = useCallback(
    (target: Problem, targetStep: Step, lang: Language) => {
      const next: Record<string, string> = {};
      for (const s of target.steps) {
        next[s.id] = workspaces.current[workspaceKey(target.id, s.id, lang)]?.code ?? s.code[lang].starter;
      }
      setFiles(next);
      if (mounted.current !== target.id) setOpenTabs([]);
      mounted.current = target.id;
      openTab(targetStep.id);
      setResetKey(k => k + 1);
      submitSeq.current += 1;
      setVerdict(null);
      setVerdictCode('');
      setEarned(null);
    },
    [openTab],
  );

  /** Rewrite one file of the mounted filesystem: state, the in-memory snapshot and the store. */
  const writeFile = useCallback(
    (id: string, value: string) => {
      if (problem === null) return;
      setFiles(f => ({...f, [id]: value}));
      const key = workspaceKey(problem.id, id, language);
      const state: Workspace = {code: value, updatedAt: Date.now()};
      workspaces.current[key] = state;
      store.saveWorkspace(key, state);
    },
    [problem, language, store],
  );

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
    mount(problem, step, current.language);
    setProgress(p =>
      p.lastStep[problem.id] === step.id ? p : {...p, lastStep: {...p.lastStep, [problem.id]: step.id}},
    );
  }, [loaded, problem, step, mount]);

  // Persist progress (debounced by the store); files are written through by `writeFile` as they change.
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

  /** Clear every attempt and saved workspace of the problem and reopen it on step 1. */
  const resetProblem = useCallback(
    (target: Problem) => {
      for (const s of target.steps) {
        for (const lang of LANGUAGES) {
          const key = workspaceKey(target.id, s.id, lang);
          delete workspaces.current[key];
          store.deleteWorkspace(key);
        }
      }
      const first = target.steps[0];
      setProgress(p => {
        const attempts = {...p.attempts};
        for (const s of target.steps) delete attempts[stepKey(target.id, s.id)];
        return {...p, attempts, lastStep: {...p.lastStep, [target.id]: first.id}};
      });
      setTab('step');
      setOpenTabs([first.id]);
      // Clearing the attempts locks every later step, so the address re-resolves to step 1 and opens it;
      // only when step 1 is already open does nothing change and the starter has to be loaded here.
      if (stepIndex === 0) mount(target, first, language);
    },
    [stepIndex, language, mount, store],
  );

  const onResetProblem = useCallback(() => {
    if (problem === null) return;
    void openDialog({
      title: `Start "${problem.title}" over?`,
      body: 'Step results, hints used and your code for this problem in every language will be cleared.',
      confirm: 'Start over',
      danger: true,
    }).then(ok => {
      if (ok) resetProblem(problem);
    });
  }, [problem, resetProblem, openDialog]);

  // Timer mode -------------------------------------------------------------------------------------
  const timer = progress.timer;
  const timedProblem = timer === null ? undefined : problemById[timer.problemId];

  /** Close the run as `outcome` and file it in the history. */
  const endTimer = useCallback((outcome: SessionOutcome) => {
    setProgress(p => {
      if (p.timer === null) return p;
      const target = problemById[p.timer.problemId];
      if (target === undefined) return {...p, timer: null};
      const session = finishSession(p.timer, target, p.attempts, outcome, Date.now());
      return {...p, timer: null, sessions: [...p.sessions, session].slice(-SESSION_HISTORY)};
    });
  }, []);

  // Every step done: the run is over, counted or not.
  useEffect(() => {
    if (timer === null || timedProblem === undefined) return;
    if (isComplete(timedProblem, progress.attempts)) endTimer('completed');
  }, [timer, timedProblem, progress.attempts, endTimer]);

  const budgetChoice = useRef(1);
  const onBudgetChange = useCallback((factor: number) => {
    budgetChoice.current = factor;
  }, []);

  /** Start a timed run of the open problem: pick a budget, then reset the problem and start the clock. */
  const onStartTimer = useCallback(() => {
    if (problem === null) return;
    budgetChoice.current = 1;
    void openDialog({
      title: `Timed run · ${problem.title}`,
      body: <BudgetPicker initial={1} onChange={onBudgetChange} problem={problem} />,
      confirm: timer === null ? 'Start the clock' : 'End the current run and start',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      if (timer !== null) endTimer('ended');
      resetProblem(problem);
      const started = startTimer(problem, budgetChoice.current, language, Date.now());
      setProgress(p => ({...p, timer: started}));
    });
  }, [problem, timer, language, openDialog, onBudgetChange, endTimer, resetProblem]);

  /** The budget ran out: stop here, or keep going knowing the run will not be counted. */
  const onTimerExpired = useCallback(() => {
    if (timer === null || timedProblem === undefined) return;
    const done = stepsDone(timedProblem, progressRef.current.attempts);
    void openDialog({
      title: `Time’s up · ${timedProblem.title}`,
      body: `The ${formatClock(timer.budget)} budget has run out with ${done.accepted} of ${
        timedProblem.steps.length
      } steps accepted. End the run and record it, or keep going — the clock keeps counting, and the run will not be counted.`,
      confirm: 'End the run',
      cancel: 'Keep going (not counted)',
    }).then(ok => {
      if (ok) endTimer('expired');
      else setProgress(p => (p.timer === null ? p : {...p, timer: {...p.timer, overtime: true}}));
    });
  }, [timer, timedProblem, openDialog, endTimer]);

  const onTimerClick = useCallback(() => {
    if (timer === null || timedProblem === undefined) return;
    const done = stepsDone(timedProblem, progressRef.current.attempts);
    const elapsed = formatClock(elapsedSeconds(timer, Date.now()));
    void openDialog({
      title: `End this timed run?`,
      body: `${timedProblem.title} · ${elapsed} on the clock · ${done.accepted} of ${timedProblem.steps.length} steps accepted. The run is recorded as ended early; your progress on the problem stays.`,
      confirm: 'End the run',
      cancel: 'Keep going',
    }).then(ok => {
      if (ok) endTimer('ended');
    });
  }, [timer, timedProblem, openDialog, endTimer]);

  const problemSessions = useMemo(
    () => (problem === null ? [] : progress.sessions.filter(s => s.problemId === problem.id)),
    [problem, progress.sessions],
  );

  const onLanguage = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const lang = e.target.value as Language;
      if (!LANGUAGES.includes(lang) || lang === language) return;
      setProgress(p => ({...p, language: lang}));
      if (problem !== null && step !== null) mount(problem, step, lang);
    },
    [language, problem, step, mount],
  );

  // Judging ----------------------------------------------------------------------------------------
  useEffect(() => runner.onStatus(setRuntimeStatus), [runner]);

  // A step that runs in the browser boots the runtime as soon as it opens, so Submit does not wait for the download.
  useEffect(() => {
    if (loaded && step?.harness?.[language] !== undefined) runner.prewarm();
  }, [loaded, step, language, runner]);

  /** Record a decided verdict: the attempt, the submission history, the score, the celebration. */
  const record = useCallback(
    (result: Verdict) => {
      if (problem === null || attemptKey === null) return;
      const now = Date.now();
      const previous = progressRef.current.attempts[attemptKey] ?? OPEN_ATTEMPT;
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
    },
    [problem, attemptKey, language],
  );

  const showVerdict = useCallback(() => {
    // Stacked layout: the verdict is off-screen under the editor, so bring it up instead of raising the keyboard.
    if (window.matchMedia(STACKED).matches) verdictRef.current?.scrollIntoView({behavior: 'smooth', block: 'start'});
    else editorRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    if (problem === null || step === null || attemptKey === null || running) return;
    const src = filesRef.current[step.id] ?? step.code[language].starter;
    const result = judge(step, language, src);
    setVerdictCode(src);
    const token = ++submitSeq.current;
    const harness = step.harness?.[language];
    if (harness === undefined) {
      setVerdict(result);
      record(result);
      showVerdict();
      return;
    }
    // The step executes: every file of the course is in the runtime's filesystem so cross-file imports resolve.
    const files: Record<string, string> = {};
    for (const s of problem.steps)
      files[fileName(s.file, language)] = filesRef.current[s.id] ?? s.code[language].starter;
    const job: RunJob = {
      files,
      support: problem.support?.[language] ?? {},
      harness,
      checks: step.checks.map(c => c.id),
    };
    setVerdict(null);
    setRunning(true);
    void runner.run(job).then(run => {
      setRunning(false);
      const decided = withRuntime(result, run);
      // A runtime that could not run the code is not a wrong submission; a decided run is recorded even if the
      // learner moved on, but its verdict is only shown for the step it belongs to.
      if (run.error === undefined) record(decided);
      if (submitSeq.current !== token) return;
      setVerdict(decided);
      showVerdict();
    });
  }, [problem, step, attemptKey, language, running, runner, record, showVerdict]);

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
  const onCodeChange = useCallback(
    (value: string) => {
      // An in-place replacement (reset, load solution) echoes the document it was handed: not an edit.
      if (openFile !== null && filesRef.current[openFile] !== value) writeFile(openFile, value);
    },
    [openFile, writeFile],
  );
  const onLoadSolution = useCallback(
    (solution: string) => {
      if (step === null) return;
      writeFile(step.id, solution);
      openTab(step.id);
      setResetKey(k => k + 1);
      setPaneOpen(false);
    },
    [step, writeFile, openTab],
  );
  /** From the empty editor: reopen the step's own file. */
  const onOpenTask = useCallback(() => {
    if (step !== null) openTab(step.id);
  }, [step, openTab]);
  const onResetCode = useCallback(() => {
    if (problem === null || openFile === null) return;
    const owner = problem.steps.find(s => s.id === openFile);
    if (owner === undefined) return;
    const starter = owner.code[language].starter;
    if (filesRef.current[openFile] === starter) return;
    void openDialog({
      title: `Restore the starting code of ${fileName(owner.file, language)}?`,
      body: 'Your edits to this file will be lost.',
      confirm: 'Restore',
      danger: true,
    }).then(ok => {
      if (!ok) return;
      writeFile(openFile, starter);
      setResetKey(k => k + 1);
    });
  }, [problem, openFile, language, openDialog, writeFile]);
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
    setLayout(l => ({...l, x: clamp(l.x + delta / width, SPLIT_BOUNDS.x.min, SPLIT_BOUNDS.x.max)}));
  }, []);
  const dragY = useCallback((delta: number) => {
    const height = ideRef.current?.clientHeight ?? 0;
    if (height === 0) return;
    setLayout(l => ({...l, y: clamp(l.y + delta / height, SPLIT_BOUNDS.y.min, SPLIT_BOUNDS.y.max)}));
  }, []);
  const resetX = useCallback(() => setLayout(l => ({...l, x: DEFAULT_SPLIT.x})), []);
  const resetY = useCallback(() => setLayout(l => ({...l, y: DEFAULT_SPLIT.y})), []);
  const togglePaneSidebar = useCallback(() => setLayout(l => ({...l, pane: !l.pane})), []);
  const toggleExplorer = useCallback(() => setLayout(l => ({...l, explorer: !l.explorer})), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // storage disabled: the layout just does not persist
    }
  }, [layout]);
  // Grid templates in `fr` so the shares need no definite container size; the 8px track is the gutter.
  // A collapsed problem pane is a fixed strip with no gutter.
  const mainStyle = useMemo(
    () =>
      ({
        '--lb-cols': layout.pane ? `${layout.x}fr 8px ${1 - layout.x}fr` : `${COLLAPSED_PANE} 1fr`,
      } as CSSProperties),
    [layout.x, layout.pane],
  );
  const ideStyle = useMemo(() => ({'--lb-rows': `${layout.y}fr 8px ${1 - layout.y}fr`} as CSSProperties), [layout.y]);

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
          {timer !== null ? (
            <TimerPill onClick={onTimerClick} onExpire={onTimerExpired} problem={timedProblem} timer={timer} />
          ) : null}
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
            activeDays={progress.activeDays}
            attempts={progress.attempts}
            badges={progress.badges}
            problems={problems}
            profile={profile}
            sessions={progress.sessions}
            streak={streak}
            today={today}
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
            <div
              className={`${paneOpen ? 'block' : 'hidden'} h-[62vh] overflow-hidden lg:h-full ${
                layout.pane ? 'lg:block' : 'lg:hidden'
              }`}>
              <ProblemPane
                attempt={attempt}
                attempts={progress.attempts}
                language={language}
                onBack={onBack}
                onCollapse={togglePaneSidebar}
                onDownload={onDownloadProblem}
                onLoadSolution={onLoadSolution}
                onNextStep={onNextStep}
                onPrevStep={onPrevStep}
                onResetProblem={onResetProblem}
                onRevealHint={onRevealHint}
                onRevealSolution={onRevealSolution}
                onSelectStep={onSelectStep}
                onShare={onShare}
                onStartTimer={onStartTimer}
                onTab={setTab}
                problem={problem}
                sessions={problemSessions}
                step={step}
                stepIndex={stepIndex}
                tab={tab}
                timerActive={timer !== null && timer.problemId === problem.id}
                userCode={stepCode}
              />
            </div>
            {layout.pane ? null : (
              <CollapsedPane onExpand={togglePaneSidebar} title={`Step ${stepIndex + 1}: ${step.title}`} />
            )}
          </section>

          {layout.pane ? <SplitGutter axis="x" className="hidden lg:flex" onDrag={dragX} onReset={resetX} /> : null}

          <section className="flex min-h-0 min-w-0 flex-col lg:h-full lg:flex-row">
            {layout.explorer ? (
              <aside className="border-ink-700 max-h-56 shrink-0 overflow-hidden border-b lg:h-full lg:max-h-none lg:w-52 lg:border-b-0 lg:border-r">
                <Explorer
                  attempts={progress.attempts}
                  language={language}
                  onOpen={openTab}
                  openFile={openFile}
                  problem={problem}
                  stepId={step.id}
                />
              </aside>
            ) : null}
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col lg:grid lg:h-full lg:grid-rows-[var(--lb-rows)]"
              ref={ideRef}
              style={ideStyle}>
              <div className="flex h-[56vh] min-h-0 min-w-0 flex-col lg:h-auto">
                <div className="border-ink-700 flex items-center gap-2 border-b px-2 py-1.5">
                  <button
                    aria-pressed={layout.explorer}
                    className={`hover:text-ink-50 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition ${
                      layout.explorer ? 'bg-ink-800 text-ink-100' : 'text-ink-400'
                    }`}
                    onClick={toggleExplorer}
                    title={layout.explorer ? 'hide the file explorer' : 'show the file explorer'}
                    type="button">
                    <svg
                      aria-hidden
                      fill="none"
                      height={13}
                      stroke="currentColor"
                      strokeWidth={1.6}
                      viewBox="0 0 16 16"
                      width={13}>
                      <rect height={11} rx={1.5} width={13} x={1.5} y={2.5} />
                      <path d="M6 2.5v11" />
                    </svg>
                  </button>
                  <FileTabs
                    language={language}
                    onClose={closeTab}
                    onOpen={openTab}
                    openFile={openFile}
                    openTabs={openTabs}
                    problem={problem}
                    stepId={step.id}
                  />
                  <span
                    className="font-code text-ink-400 hidden shrink-0 text-[10px] md:inline"
                    title="library the reference solution uses">
                    {LANGUAGE_STACK[language][step.concept]}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      className="text-ink-300 hover:text-ink-50 rounded-md px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-30"
                      disabled={openFile === null}
                      onClick={onResetCode}
                      title="restore this file's starting code"
                      type="button">
                      reset
                    </button>
                    <button
                      className="bg-iris-400 text-ink-950 hover:bg-iris-300 rounded-lg px-3 py-1 text-[12px] font-bold transition disabled:cursor-wait disabled:opacity-60"
                      disabled={running}
                      onClick={submit}
                      title={`${SUBMIT_SHORTCUT} · judges ${fileName(step.file, language)}`}
                      type="button">
                      {running ? 'Running…' : `Submit ${SUBMIT_KEYS}`}
                    </button>
                  </div>
                </div>
                {openFile === null ? (
                  <div className="text-ink-400 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-[12px]">
                    <span>No file open — pick one in the explorer.</span>
                    <button className={ghostButtonClass} onClick={onOpenTask} type="button">
                      open {fileName(step.file, language)}
                    </button>
                  </div>
                ) : (
                  <StepEditor
                    className="min-h-0 min-w-0 flex-1"
                    fileKey={`${problem.id}/${openFile}/${language}`}
                    language={language}
                    onChange={onCodeChange}
                    onSubmit={submit}
                    resetKey={resetKey}
                    value={openCode}
                    viewRef={editorRef}
                  />
                )}
              </div>
              <SplitGutter axis="y" className="hidden lg:flex" onDrag={dragY} onReset={resetY} />
              <div
                className="border-ink-700 flex h-[40vh] min-h-0 min-w-0 flex-col border-t lg:h-auto lg:border-t-0"
                ref={verdictRef}>
                <VerdictPane
                  attempt={attempt}
                  earned={earned}
                  executes={step.harness?.[language] !== undefined}
                  language={language}
                  nextTitle={problem.steps[stepIndex + 1]?.title}
                  onNext={stepIndex + 1 < problem.steps.length ? onNextStep : undefined}
                  running={running}
                  runtime={runtimeStatus}
                  stale={verdict !== null && verdictCode !== stepCode}
                  step={step}
                  verdict={verdict}
                />
              </div>
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
