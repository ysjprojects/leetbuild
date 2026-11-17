import Link from 'next/link';
import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {GUIDES} from '@/data/guides/meta';
import {guidePath, learnPath} from '@/lib/export';
import {leetbuildHighlighter} from '@/lib/highlight';
import {mockScenarioFor, scenarioHref} from '@/lib/mockLinks';
import {scrollBehavior} from '@/lib/motion';
import {runtimeHarness} from '@/lib/runtime/client';
import {CPP_UNSUPPORTED} from '@/lib/runtime/cpp/support';
import {type ProblemScore, type StepAttempt, HINT_COST, potentialScore, problemScore, STEP_POINTS} from '@/lib/scoring';
import {
  type Company,
  type GuideId,
  type Language,
  type Problem,
  type ProblemFigure,
  type Source,
  type SourceKind,
  type Step,
  codeFor,
  CONCEPT_LABEL,
  figureIds,
  fileName,
  GUIDE_IDS,
  isArchitectureFigure,
  LANGUAGE_LABEL,
  LANGUAGE_STACK,
  runsAsProgram,
  sourceCredit,
  stepKey,
  stepPath,
} from '@/lib/types';
import {useMediaQuery} from '@/lib/useMediaQuery';

import ArchitectureDiagram from './ArchitectureDiagram';
import {useDialog} from './Dialog';
import GpuDiagram from './GpuDiagram';
import Markdown, {InlineMarkdown} from './Markdown';
import {
  type PaneTab,
  CompanyMark,
  ConceptChip,
  DifficultyChip,
  ghostButtonClass,
  linkClass,
  primaryButtonClass,
  TagChip,
  unlocked,
} from './paneShared';
import SequenceDiagram from './SequenceDiagram';
import {mod} from './Shortcuts';
import {LinkedInButton, POST_HINT} from './Social';
import StepEditor from './StepEditor';
import SystemDiagram from './SystemDiagram';
import {renderWidget} from './widgets';
import {tabClass} from './widgets/frame';

/**
 * One node of the step rail: the step's number, or its status once decided (✓ accepted, ◐ revealed,
 * 🔒 locked). The title lives in the tooltip; the open step's title is the heading below.
 */
const StepNode: FC<{
  step: Step;
  index: number;
  active: boolean;
  status: StepAttempt['status'];
  locked: boolean;
  onSelect: (id: string) => void;
}> = memo(({step, index, active, status, locked, onSelect}) => {
  const onClick = useCallback(() => onSelect(step.id), [onSelect, step.id]);
  return (
    <button
      aria-current={active ? 'step' : undefined}
      className={`font-code relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition disabled:cursor-not-allowed ${
        active ? 'ring-iris-400/30 ring-4' : ''
      } ${
        status === 'accepted'
          ? 'border-success-400 bg-success-400 text-ink-950'
          : status === 'revealed'
          ? 'border-warning-400 bg-warning-400 text-ink-950'
          : active
          ? 'border-iris-400 bg-iris-400 text-ink-950'
          : locked
          ? 'border-ink-700 text-ink-500 border-dashed'
          : 'border-ink-500 text-ink-200 hover:border-iris-400 hover:text-ink-50'
      }`}
      disabled={locked}
      onClick={onClick}
      title={`Step ${index + 1}: ${step.title}${locked ? ' — finish the previous step first' : ''}`}
      type="button">
      {status === 'accepted' ? '✓' : status === 'revealed' ? '◐' : locked ? '🔒' : index + 1}
    </button>
  );
});
StepNode.displayName = 'StepNode';

/** The steps as a rail: nodes joined by a line that fills as steps are done. */
const StepRail: FC<{
  problem: Problem;
  attempts: Record<string, StepAttempt>;
  activeId: string | null;
  onSelect: (id: string) => void;
}> = memo(({problem, attempts, activeId, onSelect}) => (
  <ol aria-label="steps" className="mt-3 flex items-center">
    {problem.steps.map((s, i) => {
      const status = attempts[stepKey(problem.id, s.id)]?.status ?? 'open';
      const previousDone =
        i > 0 && (attempts[stepKey(problem.id, problem.steps[i - 1].id)]?.status ?? 'open') !== 'open';
      return (
        <li className={`flex items-center ${i > 0 ? 'flex-1' : ''}`} key={s.id}>
          {i > 0 ? (
            <span
              aria-hidden
              className={`h-0.5 min-w-[12px] flex-1 ${previousDone ? 'bg-success-400/70' : 'bg-ink-700'}`}
            />
          ) : null}
          <StepNode
            active={s.id === activeId}
            index={i}
            locked={!unlocked(problem, i, attempts)}
            onSelect={onSelect}
            status={status}
            step={s}
          />
        </li>
      );
    })}
  </ol>
));
StepRail.displayName = 'StepRail';

const Hints: FC<{
  hints: readonly string[];
  attempt: StepAttempt;
  onReveal: (count: number) => void;
}> = memo(({hints, attempt, onReveal}) => {
  const [freeAll, setFreeAll] = useState(false);
  const closed = attempt.status === 'open';
  const visible = closed ? attempt.hints : freeAll ? hints.length : attempt.hints;
  const onNext = useCallback(() => onReveal(attempt.hints + 1), [attempt.hints, onReveal]);
  const onFree = useCallback(() => setFreeAll(true), []);
  return (
    <section className="border-ink-700 bg-ink-850 mt-5 rounded-xl border p-3">
      <p className="text-iris-400 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider">
        <span>Hints</span>
        <span className="font-code text-ink-300 normal-case tracking-normal">
          {attempt.hints}/{hints.length} used · each −{Math.round(HINT_COST * 100)}%
        </span>
      </p>
      <ol className="mt-2 space-y-2">
        {hints.slice(0, visible).map((hint, i) => (
          <li className="text-ink-200 flex gap-2 text-[13px]" key={i}>
            <span className="bg-ink-700 font-code text-iris-200 mt-0.5 shrink-0 rounded px-1.5 text-[10px]">
              {i + 1}
            </span>
            <span>{hint}</span>
          </li>
        ))}
      </ol>
      {visible < hints.length ? (
        closed ? (
          <button className={`mt-2 ${linkClass} text-[12px]`} onClick={onNext} type="button">
            Reveal hint {visible + 1} (−{Math.round(HINT_COST * 100)}% of this step's points)
          </button>
        ) : (
          <button className={`mt-2 ${linkClass} text-[12px]`} onClick={onFree} type="button">
            Show all hints (free now)
          </button>
        )
      ) : null}
    </section>
  );
});
Hints.displayName = 'Hints';

const Solution: FC<{
  step: Step;
  language: Language;
  attempt: StepAttempt;
  userCode: string;
  onReveal: () => void;
  onLoad: (code: string) => void;
}> = memo(({step, language, attempt, userCode, onReveal, onLoad}) => {
  const [shown, setShown] = useState(false);
  const [diff, setDiff] = useState(false);
  const solution = codeFor(step, language).solution;
  const onShow = useCallback(() => setShown(true), []);
  const onHide = useCallback(() => setShown(false), []);
  const toggleDiff = useCallback(() => setDiff(d => !d), []);
  const onLoadClick = useCallback(() => onLoad(solution), [onLoad, solution]);
  const [dialog, openDialog] = useDialog();
  const onRevealClick = useCallback(() => {
    void openDialog({
      title: 'Reveal the reference solution?',
      body: 'This step will count as done but score 0 points. You can still study the solution and load it into the editor.',
      confirm: 'Reveal',
    }).then(ok => {
      if (!ok) return;
      onReveal();
      setShown(true);
    });
  }, [openDialog, onReveal]);
  const open = attempt.status === 'open';
  return (
    <section className="border-ink-700 bg-ink-850 mt-4 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-iris-400 text-[11px] font-bold uppercase tracking-wider">Reference solution</p>
        {open ? (
          <button className={`${linkClass} text-[12px]`} onClick={onRevealClick} type="button">
            Reveal (this step scores 0)
          </button>
        ) : shown ? (
          <div className="flex items-center gap-2">
            <button className={`${linkClass} text-[12px]`} onClick={toggleDiff} type="button">
              {diff ? 'plain' : 'diff against my code'}
            </button>
            <button className={`${linkClass} text-[12px]`} onClick={onHide} type="button">
              hide
            </button>
          </div>
        ) : (
          <button className={`${linkClass} text-[12px]`} onClick={onShow} type="button">
            show
          </button>
        )}
      </div>
      {!open && shown ? (
        <>
          <StepEditor
            className="border-ink-700 mt-2 h-[46vh] overflow-hidden rounded-lg border"
            label={`${fileName(step.file, language)}, reference solution`}
            language={language}
            original={diff ? userCode : null}
            readOnly
            value={solution}
          />
          <div className="mt-2 flex items-center gap-3">
            <button className={primaryButtonClass} onClick={onLoadClick} type="button">
              Load solution into editor
            </button>
            <span className="text-ink-300 text-[11px]">{fileName(step.file, language)}</span>
          </div>
        </>
      ) : null}
      {dialog}
    </section>
  );
});
Solution.displayName = 'Solution';

/**
 * The address names a step that is not unlocked yet (a guide's "Practise it" link): its title, why it
 * waits, the way to the first open step, and a skip ahead that reveals the steps before it.
 */
const LockedStep: FC<{
  problem: Problem;
  locked: Step;
  /** The first open step: where the learner goes next. */
  open: Step;
  onGoTo: (id: string) => void;
  onRevealUpTo: (id: string) => void;
}> = memo(({problem, locked, open, onGoTo, onRevealUpTo}) => {
  const lockedNumber = problem.steps.indexOf(locked) + 1;
  const openNumber = problem.steps.indexOf(open) + 1;
  const previous = lockedNumber - 1;
  const one = openNumber === previous;
  const span = one ? `step ${openNumber}` : `steps ${openNumber} to ${previous}`;
  const [dialog, openDialog] = useDialog();
  const onGoClick = useCallback(() => onGoTo(open.id), [onGoTo, open.id]);
  const onRevealClick = useCallback(() => {
    void openDialog({
      title: `Reveal ${span}?`,
      body: `${
        one ? 'It counts as done but scores' : 'They count as done but score'
      } 0 points, and step ${lockedNumber} opens. You can still study each solution and load it into the editor.`,
      confirm: `Reveal and open step ${lockedNumber}`,
    }).then(ok => {
      if (ok) onRevealUpTo(locked.id);
    });
  }, [openDialog, onRevealUpTo, locked.id, lockedNumber, one, span]);
  return (
    <div className="mt-3">
      <p className="text-ink-300 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
        <span>step {lockedNumber} · locked</span>
        <ConceptChip concept={locked.concept} />
      </p>
      <h1 className="text-ink-50 mt-1 text-xl font-extrabold leading-tight">{locked.title}</h1>
      <section className="border-ink-700 bg-ink-850 mt-4 rounded-xl border p-3">
        <p className="text-ink-200 text-[13px]">
          {one
            ? `Step ${lockedNumber} unlocks when step ${previous} is accepted or its solution revealed.`
            : `Step ${lockedNumber} unlocks when steps ${openNumber} to ${previous} are each accepted or their solutions revealed.`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className={primaryButtonClass} onClick={onGoClick} title={open.title} type="button">
            Go to step {openNumber}
          </button>
          <button className={`${linkClass} text-[12px]`} onClick={onRevealClick} type="button">
            Reveal {span} and skip ahead
          </button>
        </div>
        <p className="text-ink-300 mt-2 text-[11px]">Revealed steps count as done and score 0 points.</p>
      </section>
      {dialog}
    </div>
  );
});
LockedStep.displayName = 'LockedStep';

const NO_FOCUS: readonly string[] = [];
const NO_GUIDES: readonly GuideId[] = [];

/** Below `lg` the pane sits above the editor (the playground's stacked layout) instead of beside it. */
const STACKED = '(max-width: 1023px)';

/** Below this the pane's header puts the course title on a row of its own. */
const NARROW_HEADER_PX = 520;

/** Where each step's pane was scrolled to, by `problem/step/tab`, for the visit. */
const scrollMemory = new Map<string, number>();

/** One figure, compact or full; `focus` holds only ids of this figure. */
const FigureView: FC<{figure: ProblemFigure; compact: boolean; focus?: readonly string[]; onExpand?: () => void}> =
  memo(({figure, compact, focus, onExpand}) =>
    isArchitectureFigure(figure) ? (
      <ArchitectureDiagram compact={compact} focus={focus} onExpand={onExpand} spec={figure.architecture} />
    ) : (
      <GpuDiagram compact={compact} focus={focus} onExpand={onExpand} spec={figure.gpu} />
    ),
  );
FigureView.displayName = 'FigureView';

const FigureTab: FC<{index: number; title: string; active: boolean; onSelect: (index: number) => void}> = memo(
  ({index, title, active, onSelect}) => {
    const select = useCallback(() => onSelect(index), [index, onSelect]);
    return (
      <button aria-selected={active} className={tabClass(active)} onClick={select} role="tab" type="button">
        {title}
      </button>
    );
  },
);
FigureTab.displayName = 'FigureTab';

/**
 * A deep-learning problem's figures in the pane's column: one at a time, titled tabs when there are
 * several, the figure holding the step's focus brought up when the step changes, and the full figure
 * a click away.
 */
const PaneFigures: FC<{figures: ProblemFigure[]; title: string; focus: readonly string[]}> = memo(
  ({figures, title, focus}) => {
    const [dialog, openDialog] = useDialog();
    const ids = useMemo(() => figures.map(figureIds), [figures]);
    const focusIndex = useMemo(() => ids.findIndex(set => focus.some(id => set.has(id))), [ids, focus]);
    const [active, setActive] = useState(Math.max(0, focusIndex));
    useEffect(() => {
      if (focusIndex >= 0) setActive(focusIndex);
    }, [focusIndex]);
    const index = Math.min(active, figures.length - 1);
    const figure = figures[index];
    const ownFocus = useMemo(() => focus.filter(id => ids[index]?.has(id) === true), [focus, ids, index]);
    const onExpand = useCallback(() => {
      void openDialog({
        title: figures.length > 1 ? `${title} · ${figure.title}` : title,
        body: <FigureView compact={false} figure={figure} />,
        figure: true,
      });
    }, [figure, figures.length, openDialog, title]);
    return (
      <>
        {figures.length > 1 ? (
          <div aria-label="Figures" className="mb-2 flex flex-wrap gap-1.5" role="tablist">
            {figures.map((f, i) => (
              <FigureTab active={i === index} index={i} key={f.title} onSelect={setActive} title={f.title} />
            ))}
          </div>
        ) : null}
        <FigureView compact figure={figure} focus={ownFocus} onExpand={onExpand} />
        {dialog}
      </>
    );
  },
);
PaneFigures.displayName = 'PaneFigures';

/** Company-tagged courses open with the company: whose writing this is, and where it appears. */
/** A page with lines on it: the learning guide's mark. */
const DocumentGlyph: FC = memo(() => (
  <svg
    aria-hidden
    className="h-3.5 w-3.5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    viewBox="0 0 16 16">
    <path d="M4 1.5h5.5L13 5v9.5H4z" strokeLinejoin="round" />
    <path d="M9.5 1.5V5H13" strokeLinejoin="round" />
    <path d="M6 8h5M6 10.5h5" strokeLinecap="round" />
  </svg>
));
DocumentGlyph.displayName = 'DocumentGlyph';

/** A link from the step to a guide: it carries the step's address, so the guide's back link returns to it. */
const fromStep = (href: string, from: string): string => {
  const [path, hash] = href.split('#');
  return `${path}?from=${encodeURIComponent(from)}${hash === undefined ? '' : `#${hash}`}`;
};

const CHIP_CLASS =
  'border-iris-400/40 bg-iris-400/10 text-iris-200 hover:border-iris-400/70 hover:text-ink-50 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition';

/** The course's learning guide, when it has one: the concepts walked through, on their own page. */
const GuideLink: FC<{problemId: string; from: string; className?: string}> = memo(({problemId, from, className}) => (
  <Link
    className={`${CHIP_CLASS} ${className ?? ''}`}
    href={fromStep(learnPath(problemId), from)}
    title="The concepts behind this course, walked through with demos and quizzes">
    <DocumentGlyph />
    Learning guide
  </Link>
));
GuideLink.displayName = 'GuideLink';

/** A failure-mode guide as a chip: its title, its summary on hover; it opens the guide's page. */
const GuideChip: FC<{id: GuideId; from: string}> = memo(({id, from}) => (
  <Link className={CHIP_CLASS} href={fromStep(guidePath(id), from)} title={GUIDES[id].tagline}>
    <DocumentGlyph />
    {GUIDES[id].title}
  </Link>
));
GuideChip.displayName = 'GuideChip';

/**
 * What there is to read behind a step, above its hints (reading costs no points): the failure-mode
 * guides behind its flaws, or the course's learning guide.
 */
const StepGuides: FC<{guides: readonly GuideId[]; problemId: string | null; from: string}> = memo(
  ({guides, problemId, from}) => (
    <section className="mt-4">
      <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">
        {guides.length + (problemId === null ? 0 : 1) === 1 ? 'Guide' : 'Guides'} · free to read
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {problemId === null ? null : <GuideLink from={from} problemId={problemId} />}
        {guides.map(id => (
          <GuideChip from={from} id={id} key={id} />
        ))}
      </div>
    </section>
  ),
);
StepGuides.displayName = 'StepGuides';

/** The timed mock scenario built on this step: the same failure, rehearsed against the clock. */
const MockLink: FC<{scenario: {id: string; title: string}}> = memo(({scenario}) => (
  <p className="text-ink-300 mt-3 text-[12px]">
    <Link className={linkClass} href={scenarioHref(scenario.id)} title={`Mock interview: ${scenario.title}`}>
      Practise it as a timed mock ›
    </Link>
  </p>
));
MockLink.displayName = 'MockLink';

/** A debugging course's guides, under its statement: every failure mode its steps hide, in reading order. */
const CourseGuides: FC<{problem: Problem; from: string}> = memo(({problem, from}) => {
  const ids = GUIDE_IDS.filter(id => problem.steps.some(step => step.guides?.includes(id) === true));
  return ids.length === 0 ? null : (
    <section className="border-ink-700 mt-4 border-t pt-3">
      <p className="text-ink-400 text-[10px] font-bold uppercase tracking-wider">The failure modes this course hides</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {ids.map(id => (
          <GuideChip from={from} id={id} key={id} />
        ))}
      </div>
    </section>
  );
});
CourseGuides.displayName = 'CourseGuides';

const CompanyHeader: FC<{company: Company}> = memo(({company}) => (
  <div className="border-ink-700 bg-ink-800/60 mb-3 flex items-center gap-3 rounded-xl border p-3">
    <CompanyMark company={company} size="lg" />
    <div className="min-w-0">
      <p className="text-iris-300 text-[10px] font-bold uppercase tracking-wider">Company tagged</p>
      <p className="text-ink-100 text-[12px] leading-snug">
        Derived from the{' '}
        <a className={linkClass} href={company.url} rel="noopener noreferrer" target="_blank">
          {company.publication}
        </a>
        : this course rebuilds the part of {company.name}&apos;s system described there, the way they described it.
      </p>
    </div>
  </div>
));
CompanyHeader.displayName = 'CompanyHeader';

const formatSourceDate = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return date;
  const when = new Date(Date.UTC(y, m - 1, Number.isFinite(d) ? d : 1));
  return when.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    ...(Number.isFinite(d) ? {day: 'numeric'} : {}),
    timeZone: 'UTC',
  });
};

/** Each kind of source in its own tint, so papers, code and posts scan apart. */
const SOURCE_KIND_TONE: Record<SourceKind, string> = {
  paper: 'border-iris-400/40 text-iris-300',
  code: 'border-success-400/40 text-success-300',
  post: 'border-warning-400/40 text-warning-300',
  docs: 'border-ink-500 text-ink-300',
};

/**
 * The pieces a problem is built on, each with what it takes from them: a company-tagged course's posts
 * beside the company's mark, a deep-learning problem's papers, code and posts tagged with their kind.
 */
const Sources: FC<{company: Company | undefined; sources: readonly Source[]}> = memo(({company, sources}) => (
  <section className="border-ink-700 mt-6 border-t pt-4">
    <h2 className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">Sources</h2>
    <ol className="mt-2 space-y-3">
      {sources.map(source => (
        <li className="flex gap-3" key={source.url}>
          {company !== undefined ? (
            <CompanyMark company={company} />
          ) : source.kind !== undefined ? (
            <span
              className={`font-code mt-0.5 flex h-4 w-11 shrink-0 items-center justify-center rounded border text-[9px] font-semibold uppercase tracking-wider ${
                SOURCE_KIND_TONE[source.kind]
              }`}>
              {source.kind}
            </span>
          ) : null}
          <div className="min-w-0">
            <a
              className="text-ink-50 hover:text-iris-200 decoration-ink-500 text-[13px] font-semibold underline underline-offset-2"
              href={source.url}
              rel="noopener noreferrer"
              target="_blank">
              {source.title}
            </a>
            <p className="text-ink-400 font-code mt-0.5 text-[10.5px]">
              {sourceCredit(source, company?.publication, formatSourceDate)}
            </p>
            <p className="text-ink-200 mt-1 text-[12px] leading-relaxed">
              <InlineMarkdown source={source.takes} />
            </p>
          </div>
        </li>
      ))}
    </ol>
  </section>
));
Sources.displayName = 'Sources';

/** Every step done: the certificate (when nothing was revealed), or why there is none. */
const CourseComplete: FC<{problem: Problem; score: ProblemScore; certified: boolean; onCertificate: () => void}> = memo(
  ({problem, score, certified, onCertificate}) => (
    <section
      className={`mb-4 rounded-xl border px-3 py-2.5 ${
        certified ? 'border-success-400/50 bg-success-400/10' : 'border-ink-700 bg-ink-850'
      }`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`text-[11px] font-bold uppercase tracking-wider ${
            certified ? 'text-success-300' : 'text-ink-300'
          }`}>
          Course complete
        </span>
        <span className="text-ink-200 text-[12px]">
          {certified
            ? `every step of ${problem.title} accepted · ${score.score}/${score.max} pts`
            : `${score.done - score.accepted} step${
                score.done - score.accepted === 1 ? '' : 's'
              } revealed — certificates go to courses completed with every check passing; start over to earn one`}
        </span>
        {certified ? (
          <button
            className="bg-success-400 text-ink-950 hover:bg-success-300 ml-auto rounded-lg px-3 py-1 text-[12px] font-bold transition"
            onClick={onCertificate}
            type="button">
            Certificate · LinkedIn
          </button>
        ) : null}
      </div>
    </section>
  ),
);
CourseComplete.displayName = 'CourseComplete';

const ProblemPane: FC<{
  problem: Problem;
  step: Step;
  stepIndex: number;
  attempts: Record<string, StepAttempt>;
  attempt: StepAttempt;
  language: Language;
  userCode: string;
  tab: PaneTab;
  onTab: (tab: PaneTab) => void;
  onSelectStep: (id: string) => void;
  onBack: () => void;
  onRevealHint: (count: number) => void;
  onRevealSolution: () => void;
  onLoadSolution: (code: string) => void;
  onNextStep: () => void;
  onPrevStep: () => void;
  onResetProblem: () => void;
  /** Download this problem's tutorial as Markdown in the current language. */
  onDownload: () => void;
  /** LinkedIn composer prefilled with this problem's result card. */
  shareUrl: string;
  /** Fold the pane into a strip beside the IDE (`lg` and up). */
  onCollapse: () => void;
  /** Every step accepted: a certificate can be issued. */
  certified: boolean;
  /** Open the certificate dialog (download, add to LinkedIn, share). */
  onCertificate: () => void;
  /** The step the address names when it is not unlocked yet: shown locked, `step` being the first open one. */
  lockedStep: Step | null;
  /** Reveal every open step before this one, which unlocks it. */
  onRevealUpTo: (id: string) => void;
  /** Bumped to bring the debrief into view (the verdict's link to it). */
  debriefRequest: number;
}> = memo(
  ({
    problem,
    step,
    stepIndex,
    attempts,
    attempt,
    language,
    userCode,
    tab,
    onTab,
    onSelectStep,
    onBack,
    onRevealHint,
    onRevealSolution,
    onLoadSolution,
    onNextStep,
    onPrevStep,
    onResetProblem,
    onDownload,
    shareUrl,
    onCollapse,
    certified,
    onCertificate,
    lockedStep,
    onRevealUpTo,
    debriefRequest,
  }) => {
    const score = problemScore(problem, attempts);
    const points = STEP_POINTS[problem.difficulty];
    const potential = potentialScore(problem.difficulty, attempt);
    const onProblemTab = useCallback(() => onTab('problem'), [onTab]);
    const onStepTab = useCallback(() => onTab('step'), [onTab]);
    const hasNext = stepIndex < problem.steps.length - 1;
    const done = attempt.status !== 'open';
    /** The step the pane shows: the locked one the address names, or the open step. */
    const shown = lockedStep ?? step;
    const shownIndex = lockedStep === null ? stepIndex : problem.steps.indexOf(lockedStep);
    const stack = LANGUAGE_STACK[language][step.concept];
    // A step (or tab) opens where it was left this visit, after a guide or another step and back, and
    // at the top the first time: the diagram's highlight, the rail, then the heading.
    const scroller = useRef<HTMLDivElement>(null);
    const scrollKey = `${problem.id}/${shown.id}/${tab}`;
    useEffect(() => {
      scroller.current?.scrollTo({top: scrollMemory.get(scrollKey) ?? 0});
    }, [scrollKey]);
    const onScroll = useCallback(() => {
      if (scroller.current !== null) scrollMemory.set(scrollKey, scroller.current.scrollTop);
    }, [scrollKey]);
    const debrief = useRef<HTMLElement>(null);
    useEffect(() => {
      if (debriefRequest > 0) debrief.current?.scrollIntoView({behavior: scrollBehavior(), block: 'start'});
    }, [debriefRequest]);
    // A narrow pane (phones, or beside an open explorer at 1024 px) gives the title its own row under
    // the actions, as phones always did, instead of squeezing it to a letter between them.
    const header = useRef<HTMLDivElement>(null);
    const [narrowHeader, setNarrowHeader] = useState(false);
    useEffect(() => {
      const el = header.current;
      if (el === null) return undefined;
      const observer = new ResizeObserver(([entry]) => setNarrowHeader(entry.contentRect.width < NARROW_HEADER_PX));
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    /** Steps that build each diagram node (1-based numbers), for tooltips and click-to-jump. */
    const stepsByNode = useMemo(() => {
      const map: Record<string, number[]> = {};
      problem.steps.forEach((s, i) => {
        for (const id of s.focus) (map[id] ??= []).push(i + 1);
      });
      return map;
    }, [problem.steps]);
    // Clicking a component jumps to the first step that builds it, if that step is reachable.
    const onSelectNode = useCallback(
      (id: string) => {
        const first = stepsByNode[id]?.[0];
        if (first !== undefined && unlocked(problem, first - 1, attempts)) onSelectStep(problem.steps[first - 1].id);
      },
      [stepsByNode, problem, attempts, onSelectStep],
    );
    const here = stepPath(problem, shown);
    const mock = useMemo(() => mockScenarioFor(problem.id, step.id), [problem.id, step.id]);
    // Stacked (phones, zoom), the brief flows in the page's scroll and the step's task comes before the
    // course's figure; beside the IDE the figure leads and the pane scrolls on its own.
    const stacked = useMediaQuery(STACKED);
    const figureAfterTask = stacked && tab === 'step' && lockedStep === null;
    const courseFigure =
      problem.figures !== undefined && problem.figures.length > 0 ? (
        <PaneFigures figures={problem.figures} focus={tab === 'step' ? shown.focus : NO_FOCUS} title={problem.title} />
      ) : problem.diagram !== undefined ? (
        <SystemDiagram
          compact
          diagram={problem.diagram}
          focus={tab === 'step' ? shown.focus : NO_FOCUS}
          onSelectNode={onSelectNode}
          stepsByNode={stepsByNode}
        />
      ) : null;
    return (
      <div className="flex min-h-0 flex-col lg:h-full">
        <div
          className="border-ink-700 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2"
          ref={header}>
          <button className={`${ghostButtonClass} -ml-2`} onClick={onBack} type="button">
            ← problems
          </button>
          <span
            className={`order-last flex min-w-0 basis-full flex-wrap items-center gap-x-2 gap-y-1 ${
              narrowHeader ? '' : 'sm:order-none sm:flex-1 sm:basis-0'
            }`}>
            <span className="text-ink-50 min-w-0 truncate text-[13px] font-bold">{problem.title}</span>
            <DifficultyChip difficulty={problem.difficulty} />
            {problem.tag !== undefined ? <TagChip tag={problem.tag} /> : null}
            <span className="font-code text-ink-300 shrink-0 text-[11px]">
              {score.score}/{score.max} pts
            </span>
          </span>
          <button
            aria-label="download this course as Markdown"
            className={`border-ink-600 bg-ink-800 text-ink-200 hover:border-iris-400/60 hover:text-ink-50 ml-auto flex h-6 w-6 items-center justify-center rounded-md border transition ${
              narrowHeader ? '' : 'sm:ml-0'
            }`}
            onClick={onDownload}
            title={`download this course as a Markdown file (${LANGUAGE_LABEL[language]}): statement, diagrams, every step with its starter, hints and solution`}
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
              <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
            </svg>
          </button>
          {score.done > 0 ? (
            <LinkedInButton label="share" title={`share your result card on LinkedIn: ${POST_HINT}`} url={shareUrl} />
          ) : null}
          {problem.steps.some(s => attempts[stepKey(problem.id, s.id)] !== undefined) ? (
            <button
              aria-label="start this problem over"
              className="border-ink-600 bg-ink-800 text-ink-200 hover:border-danger-400/60 hover:text-danger-200 flex h-6 w-6 items-center justify-center rounded-md border transition"
              onClick={onResetProblem}
              title="start over: clear this problem's results and code"
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
                <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" />
              </svg>
            </button>
          ) : null}
          <button
            aria-label="hide the problem pane"
            className="text-ink-400 hover:text-ink-50 hidden h-6 w-6 items-center justify-center rounded-md transition lg:flex"
            onClick={onCollapse}
            title={`hide the problem pane (${mod('\\')})`}
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
        <div className="px-4 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" onScroll={onScroll} ref={scroller}>
          {figureAfterTask ? null : courseFigure}
          <StepRail
            activeId={tab === 'step' ? shown.id : null}
            attempts={attempts}
            onSelect={onSelectStep}
            problem={problem}
          />
          <div className="border-ink-700 mt-3 flex items-center gap-1 border-b">
            <button
              className={`border-b-2 px-2.5 py-1.5 text-[12px] font-semibold transition ${
                tab === 'problem' ? 'border-iris-400 text-ink-50' : 'text-ink-200 hover:text-ink-50 border-transparent'
              }`}
              onClick={onProblemTab}
              type="button">
              Description
            </button>
            <button
              className={`border-b-2 px-2.5 py-1.5 text-[12px] font-semibold transition ${
                tab === 'step' ? 'border-iris-400 text-ink-50' : 'text-ink-200 hover:text-ink-50 border-transparent'
              }`}
              onClick={onStepTab}
              type="button">
              Step {shownIndex + 1} of {problem.steps.length}
            </button>
          </div>

          {tab === 'problem' ? (
            <div className="mt-3">
              {problem.company !== undefined ? <CompanyHeader company={problem.company} /> : null}
              <div className="text-ink-300 mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                {problem.concepts.map(c => (
                  <ConceptChip concept={c} key={c} />
                ))}
                <span>~{problem.minutes} min</span>
                <span>
                  {problem.steps.length} steps · {points} pts each
                </span>
                {problem.learn !== undefined ? (
                  <GuideLink className="ml-auto" from={here} problemId={problem.id} />
                ) : null}
              </div>
              {score.done === score.total ? (
                <CourseComplete certified={certified} onCertificate={onCertificate} problem={problem} score={score} />
              ) : null}
              <Markdown highlight={leetbuildHighlighter} renderWidget={renderWidget} source={problem.statement} />
              {problem.learn === undefined ? <CourseGuides from={here} problem={problem} /> : null}
              {problem.sources !== undefined && problem.sources.length > 0 ? (
                <Sources company={problem.company} sources={problem.sources} />
              ) : null}
            </div>
          ) : lockedStep !== null ? (
            <LockedStep
              locked={lockedStep}
              onGoTo={onSelectStep}
              onRevealUpTo={onRevealUpTo}
              open={step}
              problem={problem}
            />
          ) : (
            <div className="mt-3">
              <p className="text-iris-300 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
                <span>
                  step {stepIndex + 1} · {CONCEPT_LABEL[step.concept]}
                </span>
                <ConceptChip concept={step.concept} />
                <span
                  className={`font-code rounded-full border px-1.5 py-0.5 text-[10px] normal-case tracking-normal ${
                    attempt.status === 'accepted'
                      ? 'border-success-400/60 text-success-300'
                      : attempt.status === 'revealed'
                      ? 'border-warning-400/60 text-warning-300'
                      : 'border-ink-500 text-ink-300'
                  }`}>
                  {attempt.status === 'accepted'
                    ? `accepted · ${potential} pts`
                    : attempt.status === 'revealed'
                    ? 'revealed · 0 pts'
                    : `worth ${potential} of ${points} pts`}
                </span>
              </p>
              <h1 className="text-ink-50 mt-1 text-xl font-extrabold leading-tight">{step.title}</h1>
              <p className="text-ink-300 mt-1 text-[12px]">
                Edit <code className="font-code text-iris-200">{fileName(step.file, language)}</code> in the editor,
                then submit.{' '}
                {stack !== undefined ? (
                  <>
                    The reference uses <code className="font-code text-iris-200">{stack}</code>.{' '}
                  </>
                ) : null}
                {runtimeHarness(step, language) !== undefined
                  ? 'Your code runs in the browser: each check exercises it and reports what it observed.'
                  : step.harness?.[language] !== undefined
                  ? `The checks read the shape of your code. ${CPP_UNSUPPORTED}`
                  : runsAsProgram(problem, step, language)
                  ? 'The checks read the shape of your code. Run executes the file here in the browser, PyTorch on the CPU, and the console shows its self-test, which prints PASS when it holds.'
                  : problem.track === 'dllm'
                  ? `The checks read the shape of your code. Run the file on your own machine: the reference ends in a self-test that prints PASS${
                      step.localOnly === undefined ? '' : ` (it does not run here: ${step.localOnly})`
                    }.`
                  : 'The checks read the shape of your code; nothing is executed in this language.'}
              </p>
              <div className="mt-3">
                <Markdown
                  highlight={leetbuildHighlighter}
                  key={step.id}
                  renderWidget={renderWidget}
                  source={step.task}
                />
              </div>
              {step.sequence !== undefined ? (
                <div className="mt-3">
                  <SequenceDiagram sequence={step.sequence} />
                </div>
              ) : null}
              {figureAfterTask && courseFigure !== null ? <div className="mt-4">{courseFigure}</div> : null}
              {(step.guides !== undefined && step.guides.length > 0) || problem.learn !== undefined ? (
                <StepGuides
                  from={here}
                  guides={step.guides ?? NO_GUIDES}
                  problemId={problem.learn === undefined ? null : problem.id}
                />
              ) : null}
              {mock === null ? null : <MockLink scenario={mock} />}
              <Hints attempt={attempt} hints={step.hints} key={`hints:${step.id}`} onReveal={onRevealHint} />
              <Solution
                attempt={attempt}
                key={`solution:${step.id}`}
                language={language}
                onLoad={onLoadSolution}
                onReveal={onRevealSolution}
                step={step}
                userCode={userCode}
              />
              {done ? (
                <section
                  className="border-success-400/40 bg-success-400/5 mt-4 scroll-mt-3 rounded-xl border p-3"
                  ref={debrief}>
                  <p className="text-success-300 text-[11px] font-bold uppercase tracking-wider">Debrief</p>
                  <div className="mt-1">
                    <Markdown highlight={leetbuildHighlighter} source={step.debrief} />
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>
        <div className="border-ink-700 flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <button className={ghostButtonClass} disabled={stepIndex <= 0} onClick={onPrevStep} type="button">
            ← previous
          </button>
          <span className="text-ink-300 flex-1 text-center text-[11px]">
            {score.done}/{score.total} steps done
          </span>
          {tab === 'problem' ? (
            <button className={primaryButtonClass} onClick={onStepTab} title={shown.title} type="button">
              {score.done === 0 && lockedStep === null ? 'start step 1 →' : `step ${shownIndex + 1} →`}
            </button>
          ) : (
            <button
              className={primaryButtonClass}
              disabled={!done || !hasNext}
              onClick={onNextStep}
              title={
                !hasNext
                  ? 'this is the last step'
                  : done
                  ? `step ${stepIndex + 2}: ${problem.steps[stepIndex + 1].title}`
                  : 'accept or reveal this step to unlock the next'
              }
              type="button">
              {hasNext ? (done ? 'next step →' : 'next step 🔒') : 'last step'}
            </button>
          )}
        </div>
      </div>
    );
  },
);
ProblemPane.displayName = 'ProblemPane';

export default ProblemPane;
