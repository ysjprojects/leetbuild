import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {leetbuildHighlighter} from '@/lib/highlight';
import {type ProblemScore, type StepAttempt, HINT_COST, potentialScore, problemScore, STEP_POINTS} from '@/lib/scoring';
import {
  type Company,
  type Language,
  type Problem,
  type Source,
  type Step,
  CONCEPT_LABEL,
  fileName,
  LANGUAGE_LABEL,
  stepKey,
} from '@/lib/types';

import {useDialog} from './Dialog';
import Markdown from './Markdown';
import {CompanyMark, ConceptChip, DifficultyChip, ghostButtonClass, linkClass, primaryButtonClass} from './paneShared';
import SequenceDiagram from './SequenceDiagram';
import {mod} from './Shortcuts';
import {LinkedInButton, POST_HINT} from './Social';
import StepEditor from './StepEditor';
import SystemDiagram from './SystemDiagram';
import {renderWidget} from './widgets';

export type PaneTab = 'problem' | 'step';

/** A step is playable once the previous one is accepted or revealed. */
export function unlocked(problem: Problem, index: number, attempts: Record<string, StepAttempt>): boolean {
  if (index === 0) return true;
  const previous = attempts[stepKey(problem.id, problem.steps[index - 1].id)];
  return previous !== undefined && previous.status !== 'open';
}

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
  const solution = step.code[language].solution;
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

/** Company-tagged courses open with the company: whose writing this is, and where it appears. */
const CompanyHeader: FC<{company: Company}> = memo(({company}) => (
  <div className="border-ink-700 bg-ink-800/60 mb-3 flex items-center gap-3 rounded-xl border p-3">
    <CompanyMark company={company} size="lg" />
    <div className="min-w-0">
      <p className="text-iris-400 text-[10px] font-bold uppercase tracking-wider">Company tagged</p>
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

/** The pieces a company-tagged course is derived from, each with what the course takes from it. */
const Sources: FC<{company: Company | undefined; sources: readonly Source[]}> = memo(({company, sources}) => (
  <section className="border-ink-700 mt-6 border-t pt-4">
    <h2 className="text-iris-400 text-[11px] font-bold uppercase tracking-wider">Sources</h2>
    <ol className="mt-2 space-y-3">
      {sources.map(source => (
        <li className="flex gap-3" key={source.url}>
          {company !== undefined ? <CompanyMark company={company} /> : null}
          <div className="min-w-0">
            <a
              className="text-ink-50 hover:text-iris-200 decoration-ink-500 text-[13px] font-semibold underline underline-offset-2"
              href={source.url}
              rel="noopener noreferrer"
              target="_blank">
              {source.title}
            </a>
            <p className="text-ink-400 font-code mt-0.5 text-[10.5px]">
              {company?.publication ?? ''}
              {source.by !== undefined ? ` · ${source.by}` : ''} · {formatSourceDate(source.date)}
            </p>
            <p className="text-ink-200 mt-1 text-[12px] leading-relaxed">{source.takes}</p>
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
  }) => {
    const score = problemScore(problem, attempts);
    const points = STEP_POINTS[problem.difficulty];
    const potential = potentialScore(problem.difficulty, attempt);
    const onProblemTab = useCallback(() => onTab('problem'), [onTab]);
    const onStepTab = useCallback(() => onTab('step'), [onTab]);
    const hasNext = stepIndex < problem.steps.length - 1;
    const done = attempt.status !== 'open';
    // A new step (or tab) starts at the top: the diagram's highlight, the rail, then the heading — not
    // wherever the previous step's content had been scrolled to.
    const scroller = useRef<HTMLDivElement>(null);
    useEffect(() => {
      scroller.current?.scrollTo({top: 0});
    }, [step.id, tab]);
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
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-ink-700 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2">
          <button className={`${ghostButtonClass} -ml-2`} onClick={onBack} type="button">
            ← problems
          </button>
          {/* On phones the actions crowd the title out of the first row, so it takes the second. */}
          <span className="order-last flex min-w-0 basis-full items-center gap-2 sm:order-none sm:flex-1 sm:basis-0">
            <span className="text-ink-50 min-w-0 truncate text-[13px] font-bold">{problem.title}</span>
            <DifficultyChip difficulty={problem.difficulty} />
            <span className="font-code text-ink-300 shrink-0 text-[11px]">
              {score.score}/{score.max} pts
            </span>
          </span>
          <button
            aria-label="download this course as Markdown"
            className="border-ink-600 bg-ink-800 text-ink-200 hover:border-iris-400/60 hover:text-ink-50 ml-auto flex h-6 w-6 items-center justify-center rounded-md border transition sm:ml-0"
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
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={scroller}>
          <SystemDiagram
            compact
            diagram={problem.diagram}
            focus={tab === 'step' ? step.focus : []}
            onSelectNode={onSelectNode}
            stepsByNode={stepsByNode}
          />
          <StepRail
            activeId={tab === 'step' ? step.id : null}
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
              Step {stepIndex + 1} of {problem.steps.length}
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
              </div>
              {score.done === score.total ? (
                <CourseComplete certified={certified} onCertificate={onCertificate} problem={problem} score={score} />
              ) : null}
              <Markdown highlight={leetbuildHighlighter} renderWidget={renderWidget} source={problem.statement} />
              {problem.sources !== undefined && problem.sources.length > 0 ? (
                <Sources company={problem.company} sources={problem.sources} />
              ) : null}
            </div>
          ) : (
            <div className="mt-3">
              <p className="text-iris-400 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
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
                {step.harness?.[language] !== undefined
                  ? 'Your code runs in the browser: each check exercises it and reports what it observed.'
                  : 'The checks read the shape of your code; nothing is executed in this language.'}
              </p>
              {step.sequence !== undefined ? (
                <div className="mt-3">
                  <SequenceDiagram sequence={step.sequence} />
                </div>
              ) : null}
              <div className="mt-3">
                <Markdown
                  highlight={leetbuildHighlighter}
                  key={step.id}
                  renderWidget={renderWidget}
                  source={step.task}
                />
              </div>
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
                <section className="border-success-400/40 bg-success-400/5 mt-4 rounded-xl border p-3">
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
            <button className={primaryButtonClass} onClick={onStepTab} title={step.title} type="button">
              {score.done === 0 ? 'start step 1 →' : `step ${stepIndex + 1} →`}
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
