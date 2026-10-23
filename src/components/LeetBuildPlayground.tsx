import type {EditorView} from '@codemirror/view';
import Router from 'next/router';
import {type CSSProperties, type FC, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {problems} from '@/data/problems';
import {downloadCertificate} from '@/lib/certificate';
import {type BottomTab, type ConsoleRun, finished} from '@/lib/console';
import {downloadMarkdown, exportFileName, problemToMarkdown, problemUrl, siteUrl} from '@/lib/export';
import {type TreeNode, buildTree} from '@/lib/fileTree';
import {type Badge, badgeOf, dayKey, earnedBadges, streakOf} from '@/lib/gamify';
import {type Verdict, exampleCheck, judge, narrow, withRuntime} from '@/lib/judge';
import {type ProvidedFile, isProvidedId, providedFiles, providedId, providedPath} from '@/lib/provided';
import {stepIssueUrl} from '@/lib/report';
import {type RuntimeStatus, getRunner} from '@/lib/runtime/client';
import type {OutputLine, RunJob} from '@/lib/runtime/types';
import {
  type StepAttempt,
  type Submission,
  HISTORY_LENGTH,
  OPEN_ATTEMPT,
  profile as computeProfile,
  stepScore,
} from '@/lib/scoring';
import {type Scratchpad as ScratchpadRecord, type Shape} from '@/lib/scratchpad';
import {
  type CertificateDetails,
  badgeShareText,
  certificateDetails,
  certificateUrl,
  linkedInPostUrl,
  resultShareText,
  stepShareText,
} from '@/lib/social';
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
  codeFor,
  fileName,
  LANGUAGE_LABEL,
  LANGUAGE_STACK,
  LANGUAGES,
  runsAsProgram,
  stepKey,
  stepPath,
} from '@/lib/types';

import {BadgeGlyph} from './Badges';
import Confetti from './Confetti';
import {useDialog} from './Dialog';
import {EditorSettingsForm, GearIcon} from './EditorSettings';
import {BrandLockup, LoadingScreen} from './LoadingScreen';
import ModeSwitch from './ModeSwitch';
import {ghostButtonClass, LANGUAGE_OPTIONS} from './paneShared';
import ProblemList from './ProblemList';
import ProblemPane, {type PaneTab, unlocked} from './ProblemPane';
import Scratchpad, {ScratchpadIcon} from './Scratchpad';
import {Select} from './Select';
import {isEditable, KeyboardIcon, MAC, mod, ShortcutList} from './Shortcuts';
import {CertificateForm, LinkedInButton, POST_HINT} from './Social';
import SplitGutter from './SplitGutter';
import StepEditor from './StepEditor';
import ThemeToggle from './ThemeToggle';
import {BudgetPicker, SessionList, TimerIdlePill, TimerPill} from './Timer';
import VerdictPane, {SubmissionCode} from './VerdictPane';

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

/** The submit and run shortcuts as this platform writes them. */
const SUBMIT_KEYS = mod('⏎');
const SUBMIT_SHORTCUT = MAC ? '⌘ Enter' : 'Ctrl + Enter';
const RUN_KEYS = mod("'");
const RUN_SHORTCUT = MAC ? "⌘ '" : "Ctrl + '";

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
const EMPTY_SHAPES: readonly Shape[] = [];
/** The per-problem run history names no other problem, so the list needs none. */
const EMPTY_PROBLEMS: readonly Problem[] = [];

/** A fresh badge: dismisses itself after a while; the LinkedIn action keeps it open while in use. */
const BadgeToast: FC<{id: number; badge: Badge; onDismiss: (id: number) => void}> = memo(({id, badge, onDismiss}) => {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss]);
  const onClick = useCallback(() => onDismiss(id), [id, onDismiss]);
  return (
    <div className="border-iris-400/60 bg-ink-800 pointer-events-auto flex items-center gap-3 rounded-xl border p-3 shadow-2xl">
      <BadgeGlyph badge={badge} earned size="lg" />
      <span className="min-w-0 flex-1">
        <span className="text-iris-400 block text-[11px] font-bold uppercase tracking-wider">Badge earned</span>
        <span className="text-ink-50 block text-[13px] font-semibold">{badge.title}</span>
        <span className="text-ink-300 block text-[11px]">{badge.blurb}</span>
        <span className="mt-1 flex items-center gap-2">
          <LinkedInButton
            label="Share on LinkedIn"
            title={POST_HINT}
            url={linkedInPostUrl(badgeShareText(badge, siteUrl()))}
          />
          <button
            className="text-ink-400 hover:text-ink-50 rounded-md px-1.5 py-0.5 text-[11px] transition"
            onClick={onClick}
            type="button">
            dismiss
          </button>
        </span>
      </span>
    </div>
  );
});
BadgeToast.displayName = 'BadgeToast';

/** Marks the step's own file wherever it is listed: Submit judges that one. */
const TaskDot: FC = memo(() => (
  <span aria-label="this step's file" className="bg-iris-400 h-1.5 w-1.5 shrink-0 rounded-full" />
));
TaskDot.displayName = 'TaskDot';

/**
 * An open file as an editor tab, VS Code style: full height of the strip, the active one on the editor's
 * own surface under an accent line with the strip's rule broken beneath it, click to show, × to close
 * (always on the active tab, on hover elsewhere).
 */
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
      aria-selected={active}
      className={`border-ink-700 group relative flex shrink-0 items-stretch border-r text-[11px] transition-colors ${
        active ? 'bg-ink-850 text-ink-50' : 'text-ink-300 hover:bg-ink-800/50 hover:text-ink-100 border-b'
      }`}
      ref={ref}
      role="tab">
      {active ? <span aria-hidden className="bg-iris-400 absolute inset-x-0 top-0 h-0.5" /> : null}
      <button
        className="font-code flex items-center gap-2 pl-3 pr-1"
        onClick={onClick}
        title={task ? 'the file this step builds — Submit judges it' : `built in step ${index + 1}: ${step.title}`}
        type="button">
        {task ? <TaskDot /> : null}
        <span className="whitespace-nowrap">{name}</span>
      </button>
      <button
        aria-label={`close ${name}`}
        className={`hover:bg-ink-700 hover:text-ink-50 touch:h-6 touch:w-6 touch:opacity-100 mr-1.5 flex h-5 w-5 items-center justify-center self-center rounded transition ${
          active ? 'text-ink-300 opacity-80 hover:opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'
        }`}
        onClick={onCloseClick}
        title="close"
        type="button">
        <svg
          aria-hidden
          fill="none"
          height={9}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.5}
          viewBox="0 0 10 10"
          width={9}>
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  );
});
FileTab.displayName = 'FileTab';

/** A provided file's tab: view-only, so it carries an eye instead of the task dot. */
const ProvidedTab: FC<{path: string; active: boolean; onOpen: (id: string) => void; onClose: (id: string) => void}> =
  memo(({path, active, onOpen, onClose}) => {
    const id = providedId(path);
    const onClick = useCallback(() => onOpen(id), [onOpen, id]);
    const onCloseClick = useCallback(() => onClose(id), [onClose, id]);
    return (
      <div
        aria-selected={active}
        className={`border-ink-700 group relative flex shrink-0 items-stretch border-r text-[11px] transition-colors ${
          active ? 'bg-ink-850 text-ink-200' : 'text-ink-400 hover:bg-ink-800/50 hover:text-ink-200 border-b'
        }`}
        role="tab">
        {active ? <span aria-hidden className="bg-ink-500 absolute inset-x-0 top-0 h-0.5" /> : null}
        <button
          className="font-code flex items-center gap-1.5 pl-3 pr-1 italic"
          onClick={onClick}
          title={`${path} — provided by the course, read-only`}
          type="button">
          <EyeGlyph />
          <span className="whitespace-nowrap">{path.slice(path.lastIndexOf('/') + 1)}</span>
        </button>
        <button
          aria-label={`close ${path}`}
          className={`hover:bg-ink-700 hover:text-ink-50 touch:h-6 touch:w-6 touch:opacity-100 mr-1.5 flex h-5 w-5 items-center justify-center self-center rounded transition ${
            active ? 'text-ink-300 opacity-80 hover:opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'
          }`}
          onClick={onCloseClick}
          title="close"
          type="button">
          <svg
            aria-hidden
            fill="none"
            height={9}
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={1.5}
            viewBox="0 0 10 10"
            width={9}>
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      </div>
    );
  });
ProvidedTab.displayName = 'ProvidedTab';

/** The open files, in the order they were opened; the step's own file opens itself when the step does. */
const FileTabs: FC<{
  problem: Problem;
  language: Language;
  provided: readonly ProvidedFile[];
  openTabs: readonly string[];
  openFile: string | null;
  /** The step being played: its file is marked. */
  stepId: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}> = memo(({problem, language, provided, openTabs, openFile, stepId, onOpen, onClose}) => (
  <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" role="tablist">
    {openTabs.map(id => {
      if (isProvidedId(id)) {
        const path = providedPath(id);
        return provided.some(f => f.path === path) ? (
          <ProvidedTab active={id === openFile} key={id} onClose={onClose} onOpen={onOpen} path={path} />
        ) : null;
      }
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
    <div aria-hidden className="border-ink-700 min-w-2 flex-1 border-b" />
  </div>
));
FileTabs.displayName = 'FileTabs';

/** View-only: an eye, so a provided file never reads as a locked step (the padlock means "not yet"). */
const EyeGlyph: FC = memo(() => (
  <svg aria-hidden fill="none" height={10} stroke="currentColor" strokeWidth={1.3} viewBox="0 0 12 10" width={12}>
    <path d="M1 5c1.4-2.4 3.1-3.6 5-3.6S9.6 2.6 11 5c-1.4 2.4-3.1 3.6-5 3.6S2.4 7.4 1 5Z" strokeLinejoin="round" />
    <circle cx={6} cy={5} r={1.6} />
  </svg>
));
EyeGlyph.displayName = 'EyeGlyph';

/** Indent per nesting level, the same for files and folders so siblings align: a glyph or chevron, then the name. */
const indent = (depth: number): CSSProperties => ({paddingLeft: 8 + depth * 12});

/** A provided file in the tree: muted like a locked step, in italics, an eye for the glyph — readable, not editable. */
const ProvidedRow: FC<{
  file: ProvidedFile;
  name: string;
  depth: number;
  active: boolean;
  onOpen: (id: string) => void;
}> = memo(({file, name, depth, active, onOpen}) => {
  const onClick = useCallback(() => onOpen(providedId(file.path)), [onOpen, file.path]);
  const style = useMemo(() => indent(depth), [depth]);
  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[11px] transition ${
          active ? 'bg-ink-800 text-ink-300' : 'text-ink-500 hover:bg-ink-800/60 hover:text-ink-300'
        }`}
        onClick={onClick}
        style={style}
        title={`${file.path} — provided by the course, read-only`}
        type="button">
        <span aria-hidden className="flex w-3 shrink-0 justify-center">
          <EyeGlyph />
        </span>
        <span className="font-code min-w-0 truncate italic">{name}</span>
      </button>
    </li>
  );
});
ProvidedRow.displayName = 'ProvidedRow';

const STATUS_GLYPH: Record<StepAttempt['status'], {glyph: string; className: string; word: string}> = {
  accepted: {glyph: '✓', className: 'text-success-300', word: 'accepted'},
  revealed: {glyph: '◐', className: 'text-warning-300', word: 'solution revealed'},
  open: {glyph: '○', className: 'text-ink-400', word: 'open'},
};

const ExplorerRow: FC<{
  step: Step;
  index: number;
  name: string;
  depth: number;
  status: StepAttempt['status'];
  locked: boolean;
  active: boolean;
  task: boolean;
  onOpen: (id: string) => void;
}> = memo(({step, index, name, depth, status, locked, active, task, onOpen}) => {
  const onClick = useCallback(() => onOpen(step.id), [onOpen, step.id]);
  const style = useMemo(() => indent(depth), [depth]);
  const mark = STATUS_GLYPH[status];
  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[11px] transition disabled:cursor-not-allowed ${
          active
            ? 'bg-ink-800 text-ink-50'
            : locked
            ? 'text-ink-500'
            : 'text-ink-200 hover:bg-ink-800/60 hover:text-ink-50'
        }`}
        disabled={locked}
        onClick={onClick}
        style={style}
        title={
          locked
            ? `step ${index + 1}: ${step.title} — unlocks once step ${index} is done`
            : `step ${index + 1}: ${step.title} — ${mark.word}${task ? '; Submit judges this file' : ''}`
        }
        type="button">
        <span aria-hidden className={`font-code w-3 shrink-0 text-center text-[10px] ${locked ? '' : mark.className}`}>
          {locked ? '🔒' : mark.glyph}
        </span>
        <span className="font-code min-w-0 truncate">{name}</span>
        {task ? <TaskDot /> : null}
      </button>
    </li>
  );
});
ExplorerRow.displayName = 'ExplorerRow';

/** A folder in the tree: a chevron that folds it, VS Code style. `depth` 0 is the course root itself. */
const FolderRow: FC<{name: string; path: string; depth: number; open: boolean; onToggle: (path: string) => void}> =
  memo(({name, path, depth, open, onToggle}) => {
    const onClick = useCallback(() => onToggle(path), [onToggle, path]);
    const style = useMemo(() => indent(depth), [depth]);
    return (
      <li>
        <button
          aria-expanded={open}
          className={`hover:bg-ink-800/60 flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[11px] transition ${
            depth === 0 ? 'text-ink-100 font-semibold' : 'text-ink-200'
          }`}
          onClick={onClick}
          style={style}
          title={open ? `fold ${name}` : `unfold ${name}`}
          type="button">
          <span
            aria-hidden
            className={`text-ink-400 w-3 text-center text-[9px] transition ${open ? '' : '-rotate-90'}`}>
            ▼
          </span>
          <span className="min-w-0 truncate">{name}</span>
        </button>
      </li>
    );
  });
FolderRow.displayName = 'FolderRow';

/** What a file row in the tree stands for: a step's own file, or something the course provides. */
type Leaf = {kind: 'step'; step: Step; index: number} | {kind: 'provided'; file: ProvidedFile};

const TreeNodes: FC<{
  nodes: readonly TreeNode<Leaf>[];
  depth: number;
  folded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  problem: Problem;
  attempts: Record<string, StepAttempt>;
  stepId: string;
  openFile: string | null;
  onOpen: (id: string) => void;
}> = memo(({nodes, depth, folded, onToggle, problem, attempts, stepId, openFile, onOpen}) => (
  <>
    {nodes.map(node =>
      node.kind === 'folder' ? (
        <Fragment key={node.path}>
          <FolderRow
            depth={depth}
            name={node.name}
            onToggle={onToggle}
            open={!folded.has(node.path)}
            path={node.path}
          />
          {folded.has(node.path) ? null : (
            <TreeNodes
              attempts={attempts}
              depth={depth + 1}
              folded={folded}
              nodes={node.children}
              onOpen={onOpen}
              onToggle={onToggle}
              openFile={openFile}
              problem={problem}
              stepId={stepId}
            />
          )}
        </Fragment>
      ) : node.leaf.kind === 'step' ? (
        <ExplorerRow
          active={node.leaf.step.id === openFile}
          depth={depth}
          index={node.leaf.index}
          key={node.path}
          locked={!unlocked(problem, node.leaf.index, attempts)}
          name={node.name}
          onOpen={onOpen}
          status={attempts[stepKey(problem.id, node.leaf.step.id)]?.status ?? 'open'}
          step={node.leaf.step}
          task={node.leaf.step.id === stepId}
        />
      ) : (
        <ProvidedRow
          active={providedId(node.leaf.file.path) === openFile}
          depth={depth}
          file={node.leaf.file}
          key={node.path}
          name={node.name}
          onOpen={onOpen}
        />
      ),
    )}
  </>
));
TreeNodes.displayName = 'TreeNodes';

/**
 * The problem's virtual filesystem in the current language as a VS Code-style tree: the course
 * root, then folders (fold with their chevron) and files at the paths the step code refers to.
 * Every step file is listed so the shape of the system is visible from step 1; locked ones wait
 * for their step, every other one opens in a tab and is editable from any step. What the course
 * provides and no step builds — generated protobuf modules, helpers, the `.proto` behind a
 * generated package — is there too, readable in a tab, never editable.
 */
const Explorer: FC<{
  problem: Problem;
  language: Language;
  provided: readonly ProvidedFile[];
  attempts: Record<string, StepAttempt>;
  stepId: string;
  openFile: string | null;
  onOpen: (id: string) => void;
  /** Fold the explorer into a strip beside the editor (`lg` and up), as the problem pane folds. */
  onCollapse: () => void;
}> = memo(({problem, language, provided, attempts, stepId, openFile, onOpen, onCollapse}) => {
  // Where the language's build looks for sources: sbt under src/main/scala; the others at the root.
  const tree = useMemo(
    () =>
      buildTree<Leaf>([
        ...problem.steps.map((step, index) => ({
          path: `${language === 'scala' ? 'src/main/scala/' : ''}${fileName(step.file, language)}`,
          leaf: {kind: 'step' as const, step, index},
        })),
        ...provided.map(file => ({path: file.path, leaf: {kind: 'provided' as const, file}})),
      ]),
    [problem, language, provided],
  );
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((path: string) => {
    setFolded(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const rootOpen = !folded.has('');
  return (
    <nav aria-label="files" className="flex h-full min-h-0 flex-col">
      <div className="text-ink-400 flex h-9 shrink-0 items-center justify-between pl-3 pr-1.5 text-[10px] font-bold uppercase tracking-wider">
        Explorer
        <button
          aria-label="hide the file explorer"
          className="text-ink-400 hover:text-ink-50 hidden h-6 w-6 items-center justify-center rounded-md transition lg:flex"
          onClick={onCollapse}
          title={`hide the file explorer (${mod('B')})`}
          type="button">
          <svg
            aria-hidden
            fill="none"
            height={13}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            viewBox="0 0 16 16"
            width={13}>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <ul>
          <FolderRow depth={0} name={problem.id} onToggle={onToggle} open={rootOpen} path="" />
          {rootOpen ? (
            <TreeNodes
              attempts={attempts}
              depth={1}
              folded={folded}
              nodes={tree}
              onOpen={onOpen}
              onToggle={onToggle}
              openFile={openFile}
              problem={problem}
              stepId={stepId}
            />
          ) : null}
        </ul>
      </div>
    </nav>
  );
});
Explorer.displayName = 'Explorer';

/** The problem pane folded into a strip (`lg` and up): the step title on its side, click to expand. */
const CollapsedPane: FC<{title: string; onExpand: () => void}> = memo(({title, onExpand}) => (
  <button
    className="border-ink-700 text-ink-300 hover:bg-ink-800 hover:text-ink-50 hidden h-full w-full flex-col items-center gap-3 overflow-hidden border-r py-2 transition lg:flex"
    onClick={onExpand}
    title={`show the problem pane (${mod('\\')})`}
    type="button">
    <span aria-hidden className="text-[14px] leading-none">
      ›
    </span>
    <span className="min-h-0 text-[11px] font-semibold [writing-mode:vertical-rl]">{title}</span>
  </button>
));
CollapsedPane.displayName = 'CollapsedPane';

/** The explorer folded into a strip (`lg` and up): "Explorer" on its side, click to expand. */
const CollapsedExplorer: FC<{onExpand: () => void}> = memo(({onExpand}) => (
  <button
    className="border-ink-700 text-ink-300 hover:bg-ink-800 hover:text-ink-50 hidden h-full w-7 shrink-0 flex-col items-center gap-3 overflow-hidden border-r py-2 transition lg:flex"
    onClick={onExpand}
    title={`show the file explorer (${mod('B')})`}
    type="button">
    <span aria-hidden className="text-[14px] leading-none">
      ›
    </span>
    <span className="min-h-0 text-[10px] font-bold uppercase tracking-wider [writing-mode:vertical-rl]">Explorer</span>
  </button>
));
CollapsedExplorer.displayName = 'CollapsedExplorer';

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
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({state: 'idle'});
  /** A submission is executing in the runtime; its result is still to come. */
  const [running, setRunning] = useState(false);
  /** The reference solution's verdict for the accepted step, once compared; the run is in progress while `comparing`. */
  const [reference, setReference] = useState<Verdict | null>(null);
  const [comparing, setComparing] = useState(false);
  /** The last run's console (what it printed, how it ended) and which view the bottom panel shows. */
  const [consoleRun, setConsoleRun] = useState<ConsoleRun | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('checks');
  /** Bumped per submit and on every mount: a run that finishes after the step changed must not show its verdict. */
  const submitSeq = useRef(0);
  /** Below `lg` the problem pane is an accordion over the editor; this is its state (the `lg` sidebar is `layout.pane`). */
  const [paneOpen, setPaneOpen] = useState(true);
  /** What focus mode folded away, to bring back when it ends. */
  const focusRestore = useRef<{explorer: boolean; pane: boolean; paneOpen: boolean} | null>(null);
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
  const [scratchpads, setScratchpads] = useState<Record<string, ScratchpadRecord>>({});
  const [scratchOpen, setScratchOpen] = useState(false);
  filesRef.current = files;
  openTabsRef.current = openTabs;
  openFileRef.current = openFile;
  progressRef.current = progress;

  const problem = problemId === null ? null : problemById[problemId] ?? null;
  const step: Step | null =
    problem === null ? null : resolveStep(problem, progress.attempts, stepId ?? progress.lastStep[problem.id]);
  const stepIndex = problem === null || step === null ? -1 : problem.steps.indexOf(step);
  // A deep-learning problem is written in one language; everything else follows the learner's choice.
  const language = problem?.language ?? progress.language;
  const runner = useMemo(() => getRunner(language), [language]);
  /** A PyTorch problem's step runs as a program in the browser: Run executes the file's self-test; Submit stays static. */
  const program = problem !== null && step !== null && runsAsProgram(problem, step, language);
  const attemptKey = problem !== null && step !== null ? stepKey(problem.id, step.id) : null;
  const attempt: StepAttempt = attemptKey === null ? OPEN_ATTEMPT : progress.attempts[attemptKey] ?? OPEN_ATTEMPT;
  /** The step's own file — what Submit judges and the solution diffs against, whichever tab is open. */
  const stepCode = step === null ? '' : files[step.id] ?? codeFor(step, language).starter;
  const openCode = openFile === null ? '' : files[openFile] ?? '';
  /** What the course provides beside the learner's files in this language; read-only in the explorer. */
  const provided = useMemo(() => (problem === null ? [] : providedFiles(problem, language)), [problem, language]);
  const openProvided =
    openFile !== null && isProvidedId(openFile) ? provided.find(f => f.path === providedPath(openFile)) ?? null : null;
  const profile = useMemo(
    () => computeProfile(problems, progress.attempts, progress.submissions, progress.acceptedSubmissions),
    [progress.attempts, progress.submissions, progress.acceptedSubmissions],
  );
  const today = dayKey(new Date());
  const streak = useMemo(() => streakOf(progress.activeDays, today), [progress.activeDays, today]);

  // Badges are a function of the attempts and the timed runs; new ones are stored (never revoked) and announced.
  useEffect(() => {
    if (!loaded) return;
    const earnedNow = earnedBadges(
      problems,
      progress.attempts,
      progress.activeDays,
      dayKey(new Date()),
      progress.sessions,
    );
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
  }, [loaded, progress.attempts, progress.activeDays, progress.badges, progress.sessions]);

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
        next[s.id] = workspaces.current[workspaceKey(target.id, s.id, lang)]?.code ?? codeFor(s, lang).starter;
      }
      setFiles(next);
      // Tabs of the same problem stay open, except provided files this language does not have.
      const kept = new Set(providedFiles(target, lang).map(f => providedId(f.path)));
      setOpenTabs(t => (mounted.current === target.id ? t.filter(id => !isProvidedId(id) || kept.has(id)) : []));
      mounted.current = target.id;
      openTab(targetStep.id);
      setResetKey(k => k + 1);
      submitSeq.current += 1;
      setVerdict(null);
      setReference(null);
      setVerdictCode('');
      setEarned(null);
      setConsoleRun(null);
      setBottomTab('checks');
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
      setScratchpads(snapshot.scratchpads);
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
    mount(problem, step, problem.language ?? current.language);
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

  /** The open problem's timed runs, newest first, from the header pill. */
  const onTimerHistory = useCallback(() => {
    if (problem === null) return;
    void openDialog({
      title: `Timed runs · ${problem.title}`,
      body: <SessionList problems={EMPTY_PROBLEMS} sessions={problemSessions} showProblem={false} />,
      wide: true,
    });
  }, [problem, problemSessions, openDialog]);

  // Sharing and certificates ---------------------------------------------------------------------
  /** LinkedIn composer prefilled for the open step; shown once it is accepted. */
  const stepShareUrl = useMemo(
    () =>
      problem === null || step === null
        ? undefined
        : linkedInPostUrl(stepShareText(problem, step, language, `${siteUrl()}${stepPath(problem, step)}`)),
    [problem, step, language],
  );
  /** A GitHub issue prefilled with the step, the language, the browser and the last verdict. */
  const issueUrl = useMemo(
    () =>
      problem === null || step === null
        ? undefined
        : stepIssueUrl({
            problem,
            step,
            index: stepIndex,
            language,
            url: `${siteUrl()}${stepPath(problem, step)}`,
            verdict,
            userAgent: navigator.userAgent,
          }),
    [problem, step, stepIndex, language, verdict],
  );
  /** The course is complete with every step accepted: a certificate can be issued. */
  const certified = useMemo(() => {
    if (problem === null) return false;
    return problem.steps.every(
      s => (progress.attempts[stepKey(problem.id, s.id)] ?? OPEN_ATTEMPT).status === 'accepted',
    );
  }, [problem, progress.attempts]);
  const nameChoice = useRef('');
  const onNameChange = useCallback((name: string) => {
    nameChoice.current = name;
  }, []);
  const verifyUrl = useCallback((details: CertificateDetails) => certificateUrl(siteUrl(), details), []);
  const onCertificate = useCallback(() => {
    if (problem === null || !certified) return;
    const current = progressRef.current;
    const details = certificateDetails(problem, current, language);
    nameChoice.current = current.name;
    void openDialog({
      title: `Certificate · ${problem.title}`,
      body: <CertificateForm details={details} onName={onNameChange} verifyUrl={verifyUrl} />,
      confirm: '⤓ Download PNG',
      cancel: 'Close',
      wide: true,
    }).then(ok => {
      const name = nameChoice.current.trim();
      if (name !== '' && name !== current.name) setProgress(p => ({...p, name}));
      if (!ok || name === '') return;
      const final = {...details, name};
      void downloadCertificate(final, verifyUrl(final));
    });
  }, [problem, certified, language, openDialog, onNameChange, verifyUrl]);

  const onLanguage = useCallback(
    (value: string) => {
      const lang = value as Language;
      if (!LANGUAGES.includes(lang) || lang === language) return;
      setProgress(p => ({...p, language: lang}));
      if (problem !== null && step !== null) mount(problem, step, lang);
    },
    [language, problem, step, mount],
  );

  // Judging ----------------------------------------------------------------------------------------
  useEffect(() => {
    if (runner === null) {
      setRuntimeStatus({state: 'idle'});
      return undefined;
    }
    setRuntimeStatus(runner.status);
    return runner.onStatus(setRuntimeStatus);
  }, [runner]);

  // A step that runs in the browser boots the runtime as soon as it opens, so Submit does not wait for the download.
  useEffect(() => {
    if (loaded && (step?.harness?.[language] !== undefined || program)) runner?.prewarm();
  }, [loaded, step, language, runner, program]);

  /** Record a decided verdict: the attempt, the submission history (with the code judged), the score, the celebration. */
  const record = useCallback(
    (result: Verdict, code: string) => {
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
        code,
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

  /**
   * The step runs inside the course's real system. The step's own file is the learner's, and so is every
   * step they have passed in this language; every other step — not reached yet, revealed, or passed in
   * another language — runs its reference implementation, so the code under test talks to real neighbours
   * instead of TODO stubs. (`yarn verify` mounts the reference for every other step the same way.)
   */
  const assemble = useCallback(
    (harness: string, checks: readonly string[], own?: string): RunJob | null => {
      if (problem === null || step === null) return null;
      const attempts = progressRef.current.attempts;
      const files: Record<string, string> = {};
      for (const s of problem.steps) {
        const attempt = attempts[stepKey(problem.id, s.id)];
        const theirs = s.id === step.id || (attempt?.status === 'accepted' && attempt.language === language);
        files[fileName(s.file, language)] =
          s.id === step.id && own !== undefined
            ? own
            : theirs
            ? filesRef.current[s.id] ?? codeFor(s, language).starter
            : codeFor(s, language).solution;
      }
      return {
        files,
        support: problem.support?.[language] ?? {},
        harness,
        checks: [...checks],
        entry: fileName(step.file, language),
      };
    },
    [problem, step, language],
  );

  /** Start the console for a run; the returned sink drops lines once another run or step took over. */
  const capture = useCallback((label: string, token: number) => {
    setConsoleRun({label, lines: [], running: true});
    return (line: OutputLine): void => {
      if (submitSeq.current === token) setConsoleRun(c => (c === null ? c : {...c, lines: [...c.lines, line]}));
    };
  }, []);

  const submit = useCallback(() => {
    if (problem === null || step === null || attemptKey === null || running) return;
    const src = filesRef.current[step.id] ?? codeFor(step, language).starter;
    const result = judge(step, language, src);
    setVerdictCode(src);
    const token = ++submitSeq.current;
    const harness = step.harness?.[language];
    if (harness === undefined) {
      setVerdict(result);
      setReference(null);
      record(result, src);
      showVerdict();
      return;
    }
    const job = assemble(
      harness,
      step.checks.map(c => c.id),
    );
    if (job === null || runner === null) return;
    setVerdict(null);
    setReference(null);
    setRunning(true);
    const onOutput = capture(`submit · ${step.checks.length} checks`, token);
    void runner.run(job, onOutput).then(run => {
      setRunning(false);
      const decided = withRuntime(result, run);
      // A runtime that could not run the code is not a wrong submission; a decided run is recorded even if the
      // learner moved on, but its verdict is only shown for the step it belongs to.
      if (run.error === undefined) record(decided, src);
      if (submitSeq.current !== token) return;
      setConsoleRun(c => (c === null ? c : finished(c, run, step.checks)));
      setVerdict(decided);
      showVerdict();
    });
  }, [problem, step, attemptKey, language, running, runner, assemble, record, showVerdict, capture]);

  /** Run: execute the example check only and show what happened; no attempt, history or score is touched. */
  const trial = useCallback(() => {
    if (problem === null || step === null || running) return;
    const harness = step.harness?.[language];
    if (harness === undefined || runner === null) return;
    const src = filesRef.current[step.id] ?? codeFor(step, language).starter;
    const example = exampleCheck(step);
    const result = narrow(judge(step, language, src), [example.id]);
    const job = assemble(harness, [example.id]);
    if (job === null) return;
    setVerdictCode(src);
    const token = ++submitSeq.current;
    setVerdict(null);
    setReference(null);
    setEarned(null);
    setRunning(true);
    const onOutput = capture('run · example check', token);
    void runner.run(job, onOutput).then(run => {
      setRunning(false);
      if (submitSeq.current !== token) return;
      setConsoleRun(c => (c === null ? c : finished(c, run, step.checks)));
      setVerdict({...withRuntime(result, run), trial: true});
      showVerdict();
    });
  }, [problem, step, language, running, runner, assemble, showVerdict, capture]);

  /**
   * Run a PyTorch step's file as a program — `python file.py`, its self-test included — in the browser,
   * beside the course's other files (as `assemble` mounts them). The console shows it; nothing is recorded.
   */
  const runProgram = useCallback(() => {
    if (step === null || running || runner === null) return;
    const job = assemble('', []);
    if (job === null) return;
    const token = ++submitSeq.current;
    const onOutput = capture(`python ${fileName(step.file, language)}`, token);
    setBottomTab('console');
    setRunning(true);
    void runner.run({...job, program: true}, onOutput).then(run => {
      setRunning(false);
      if (submitSeq.current !== token) return;
      setConsoleRun(c => (c === null ? c : finished(c, run)));
    });
  }, [step, running, runner, assemble, capture, language]);

  /** What Run does: the example check where a harness exists, the program for a PyTorch step. */
  const runStep = program ? runProgram : trial;

  /**
   * Against the reference: the reference solution in place of the step's file, the same checks, the
   * same neighbours — for what it did, read off the resources, beside what the learner's code did.
   */
  const compare = useCallback(() => {
    if (problem === null || step === null || running || comparing) return;
    const harness = step.harness?.[language];
    if (harness === undefined || runner === null) return;
    const solution = codeFor(step, language).solution;
    const job = assemble(
      harness,
      step.checks.map(c => c.id),
      solution,
    );
    if (job === null) return;
    const token = submitSeq.current;
    setComparing(true);
    void runner.run(job).then(run => {
      setComparing(false);
      if (submitSeq.current !== token) return;
      setReference(withRuntime(judge(step, language, solution), run));
    });
  }, [problem, step, language, running, comparing, runner, assemble]);

  /** A past submission's code, read-only, with the edits since it and a way to put it back in the editor. */
  const onViewSubmission = useCallback(
    (submission: Submission) => {
      if (step === null || submission.code === undefined) return;
      const code = submission.code;
      const sameLanguage = submission.language === language;
      void openDialog({
        title: `${submission.accepted ? 'Accepted' : 'Wrong Answer'} · ${submission.passed}/${submission.total} · ${
          LANGUAGE_LABEL[submission.language]
        } · ${new Date(submission.at).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        body: (
          <SubmissionCode
            code={code}
            current={sameLanguage ? filesRef.current[step.id] ?? codeFor(step, language).starter : null}
            language={submission.language}
          />
        ),
        confirm: sameLanguage ? 'Restore to editor' : undefined,
        wide: true,
      }).then(ok => {
        if (!ok || !sameLanguage) return;
        writeFile(step.id, code);
        openTab(step.id);
        setResetKey(k => k + 1);
      });
    },
    [step, language, openDialog, writeFile, openTab],
  );

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
    const starter = codeFor(owner, language).starter;
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
  const shareUrl = useMemo(
    () =>
      problem === null
        ? ''
        : linkedInPostUrl(resultShareText(problem, progress.attempts, language, problemUrl(problem))),
    [problem, progress.attempts, language],
  );

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
  /**
   * Focus: the explorer and the problem pane fold together and come back together, to how they
   * were. In the stacked layout the pane is the accordion over the editor, so that is what folds.
   */
  const toggleFocus = useCallback(() => {
    const stacked = window.matchMedia(STACKED).matches;
    const focused = !layout.explorer && (stacked ? !paneOpen : !layout.pane);
    if (focused) {
      const saved = focusRestore.current ?? {explorer: true, pane: true, paneOpen: true};
      focusRestore.current = null;
      setLayout(l => ({...l, explorer: saved.explorer, pane: saved.pane}));
      setPaneOpen(saved.paneOpen);
      return;
    }
    focusRestore.current = {explorer: layout.explorer, pane: layout.pane, paneOpen};
    setLayout(l => ({...l, explorer: false, pane: false}));
    if (stacked) setPaneOpen(false);
  }, [layout.explorer, layout.pane, paneOpen]);
  const onShortcuts = useCallback(() => {
    void openDialog({title: 'Keyboard shortcuts', body: <ShortcutList />});
  }, [openDialog]);
  const onEditorSettings = useCallback(() => {
    void openDialog({title: 'Editor', body: <EditorSettingsForm />});
  }, [openDialog]);

  // Scratchpad: one sketch per course (and one for the landing page), persisted like the workspaces.
  const scratchKey = problem?.id ?? 'general';
  const toggleScratchpad = useCallback(() => setScratchOpen(v => !v), []);
  const closeScratchpad = useCallback(() => setScratchOpen(false), []);
  const onScratchChange = useCallback(
    (shapes: Shape[]) => {
      const pad: ScratchpadRecord = {shapes, updatedAt: Date.now()};
      setScratchpads(p => ({...p, [scratchKey]: pad}));
      store.saveScratchpad(scratchKey, pad);
    },
    [scratchKey, store],
  );

  // Shortcuts work from anywhere on the page (the editor binds Mod-Enter itself too); none while a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') !== null) return;
      const modKey = e.metaKey || e.ctrlKey;
      if (modKey && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (modKey && !e.shiftKey && !e.altKey && e.code === 'Quote') {
        e.preventDefault();
        runStep();
      } else if (modKey && e.shiftKey && !e.altKey && e.code === 'KeyF' && problem !== null) {
        e.preventDefault();
        toggleFocus();
      } else if (modKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && problem !== null) {
        e.preventDefault();
        toggleExplorer();
      } else if (modKey && !e.shiftKey && !e.altKey && e.code === 'Backslash' && problem !== null) {
        e.preventDefault();
        if (window.matchMedia(STACKED).matches) setPaneOpen(v => !v);
        else togglePaneSidebar();
      } else if (e.altKey && !modKey && e.code === 'BracketRight') {
        e.preventDefault();
        onNextStep();
      } else if (e.altKey && !modKey && e.code === 'BracketLeft') {
        e.preventDefault();
        onPrevStep();
      } else if (modKey && !e.shiftKey && !e.altKey && e.code === 'Semicolon') {
        e.preventDefault();
        toggleScratchpad();
      } else if (e.key === '?' && !modKey && !e.altKey && !isEditable(e.target)) {
        e.preventDefault();
        onShortcuts();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    submit,
    runStep,
    problem,
    toggleExplorer,
    togglePaneSidebar,
    toggleFocus,
    onNextStep,
    onPrevStep,
    onShortcuts,
    toggleScratchpad,
  ]);

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

  if (!loaded) return <LoadingScreen phase="progress" problemId={problemId} />;

  return (
    <div className="leetbuild-playground bg-ink-900 text-ink-100 flex h-dvh flex-col overflow-hidden">
      <header className="border-ink-700 bg-ink-950/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <button onClick={onBack} title="all problems" type="button">
            <BrandLockup />
          </button>
        </div>
        <ModeSwitch mode="practice" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-ink-300 flex items-center gap-1.5 text-[11px]">
            <span className="hidden sm:inline">language</span>
            {problem?.language === undefined ? (
              <Select
                align="right"
                label="language"
                onChange={onLanguage}
                options={LANGUAGE_OPTIONS}
                value={language}
              />
            ) : (
              <span
                className="border-ink-600 bg-ink-850 font-code text-ink-100 rounded-full border px-2.5 py-1 text-[11px]"
                title="This problem is written in one language">
                {LANGUAGE_LABEL[language]}
              </span>
            )}
          </span>
          <span
            className="border-ink-600 font-code text-ink-200 rounded-full border px-2.5 py-1 text-[11px]"
            title={profile.rank}>
            {profile.score}
            <span className="text-ink-400">/{profile.max}</span> pts
          </span>
          {timer !== null ? (
            <TimerPill onClick={onTimerClick} onExpire={onTimerExpired} problem={timedProblem} timer={timer} />
          ) : problem !== null ? (
            <TimerIdlePill
              onHistory={onTimerHistory}
              onStart={onStartTimer}
              problem={problem}
              sessions={problemSessions}
            />
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
          <button
            aria-label="scratchpad"
            aria-pressed={scratchOpen}
            className={`border-ink-600 hover:border-iris-400/60 hover:text-ink-50 flex h-7 w-7 items-center justify-center rounded-full border transition ${
              scratchOpen ? 'bg-iris-400/20 text-iris-200' : 'bg-ink-800 text-ink-300'
            }`}
            onClick={toggleScratchpad}
            title={`scratchpad: sketch the system while you build it (${mod(';')})`}
            type="button">
            <ScratchpadIcon />
          </button>
          <button
            aria-label="keyboard shortcuts"
            className="border-ink-600 bg-ink-800 text-ink-300 hover:border-iris-400/60 hover:text-ink-50 hidden h-7 w-7 items-center justify-center rounded-full border transition sm:flex"
            onClick={onShortcuts}
            title="keyboard shortcuts (?)"
            type="button">
            <KeyboardIcon />
          </button>
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
                certified={certified}
                language={language}
                onBack={onBack}
                onCertificate={onCertificate}
                onCollapse={togglePaneSidebar}
                onDownload={onDownloadProblem}
                onLoadSolution={onLoadSolution}
                onNextStep={onNextStep}
                onPrevStep={onPrevStep}
                onResetProblem={onResetProblem}
                onRevealHint={onRevealHint}
                onRevealSolution={onRevealSolution}
                onSelectStep={onSelectStep}
                onTab={setTab}
                problem={problem}
                shareUrl={shareUrl}
                step={step}
                stepIndex={stepIndex}
                tab={tab}
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
                  onCollapse={toggleExplorer}
                  onOpen={openTab}
                  openFile={openFile}
                  problem={problem}
                  provided={provided}
                  stepId={step.id}
                />
              </aside>
            ) : (
              <CollapsedExplorer onExpand={toggleExplorer} />
            )}
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col lg:grid lg:h-full lg:grid-rows-[var(--lb-rows)]"
              ref={ideRef}
              style={ideStyle}>
              <div className="flex h-[56vh] min-h-0 min-w-0 flex-col lg:h-auto">
                {/* The tab bar: the rule along its bottom is drawn by the inactive tabs and the filler, never under the active tab, which shares the editor's surface. */}
                <div className="bg-ink-900 flex h-9 shrink-0 items-stretch">
                  <div className="border-ink-700 flex shrink-0 items-center border-b px-1.5">
                    <button
                      aria-pressed={layout.explorer}
                      className={`hover:text-ink-50 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition ${
                        layout.explorer ? 'bg-ink-800 text-ink-100' : 'text-ink-400'
                      }`}
                      onClick={toggleExplorer}
                      title={`${layout.explorer ? 'hide' : 'show'} the file explorer (${mod('B')})`}
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
                  </div>
                  <FileTabs
                    language={language}
                    onClose={closeTab}
                    onOpen={openTab}
                    openFile={openFile}
                    openTabs={openTabs}
                    problem={problem}
                    provided={provided}
                    stepId={step.id}
                  />
                  <div className="border-ink-700 flex shrink-0 items-center gap-2 border-b pl-2 pr-2">
                    <span
                      className="font-code text-ink-400 hidden shrink-0 text-[10px] md:inline"
                      title="library the reference solution uses">
                      {LANGUAGE_STACK[language][step.concept] ?? ''}
                    </span>
                    <button
                      aria-label="editor settings"
                      className="text-ink-300 hover:text-ink-50 flex h-6 w-6 items-center justify-center rounded-md transition"
                      onClick={onEditorSettings}
                      title="editor settings: font size, long lines, Vim"
                      type="button">
                      <GearIcon />
                    </button>
                    <button
                      className="text-ink-300 hover:text-ink-50 rounded-md px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-30"
                      disabled={openFile === null || openProvided !== null}
                      onClick={onResetCode}
                      title="restore this file's starting code"
                      type="button">
                      reset
                    </button>
                    {step.harness?.[language] !== undefined || program ? (
                      <button
                        className="border-ink-600 text-ink-200 hover:border-iris-400/60 hover:text-ink-50 rounded-lg border px-2.5 py-[3px] text-[12px] font-semibold transition disabled:cursor-wait disabled:opacity-60"
                        disabled={running || comparing}
                        onClick={runStep}
                        title={`${RUN_SHORTCUT} · ${
                          program
                            ? `runs ${fileName(
                                step.file,
                                language,
                              )} as a program in the browser, its self-test included`
                            : `runs ${fileName(step.file, language)} against the example check`
                        }; nothing is recorded`}
                        type="button">
                        Run {RUN_KEYS}
                      </button>
                    ) : null}
                    <button
                      className="bg-iris-400 text-ink-950 hover:bg-iris-300 rounded-lg px-3 py-1 text-[12px] font-bold transition disabled:cursor-wait disabled:opacity-60"
                      disabled={running || comparing}
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
                ) : openProvided !== null ? (
                  <>
                    <div className="border-ink-700 bg-ink-850/60 text-ink-300 flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11px] leading-5">
                      <span aria-hidden className="mt-1 shrink-0">
                        <EyeGlyph />
                      </span>
                      <span>{openProvided.note}</span>
                    </div>
                    <StepEditor
                      className="min-h-0 min-w-0 flex-1"
                      fileKey={`${problem.id}/${openFile}/${language}`}
                      language={openProvided.syntax}
                      readOnly
                      value={openProvided.text}
                    />
                  </>
                ) : (
                  <StepEditor
                    className="min-h-0 min-w-0 flex-1"
                    fileKey={`${problem.id}/${openFile}/${language}`}
                    language={language}
                    onChange={onCodeChange}
                    onRun={runStep}
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
                  comparing={comparing}
                  consoleRun={consoleRun}
                  earned={earned}
                  executes={step.harness?.[language] !== undefined}
                  issueUrl={issueUrl}
                  language={language}
                  nextTitle={problem.steps[stepIndex + 1]?.title}
                  onCertificate={certified ? onCertificate : undefined}
                  onCompare={compare}
                  onNext={stepIndex + 1 < problem.steps.length ? onNextStep : undefined}
                  onTab={setBottomTab}
                  onViewSubmission={onViewSubmission}
                  program={program}
                  reference={reference}
                  running={running}
                  runtime={runtimeStatus}
                  shareUrl={stepShareUrl}
                  stale={verdict !== null && verdictCode !== stepCode}
                  step={step}
                  tab={bottomTab}
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
      {scratchOpen ? (
        <Scratchpad
          key={scratchKey}
          onChange={onScratchChange}
          onClose={closeScratchpad}
          problem={problem}
          shapes={scratchpads[scratchKey]?.shapes ?? EMPTY_SHAPES}
        />
      ) : null}
    </div>
  );
});
LeetBuildPlayground.displayName = 'LeetBuildPlayground';

export default LeetBuildPlayground;
