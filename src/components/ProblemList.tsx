import Link from 'next/link';
import {type FC, memo, useCallback, useMemo, useState} from 'react';

import {applyListQuery, problemStatus} from '@/lib/catalog';
import {type Streak, activityByDay, badgeProgress, BADGES, stepOfTheDay} from '@/lib/gamify';
import {useListQuery} from '@/lib/listQuery';
import {type Profile, type StepAttempt, OPEN_ATTEMPT, problemScore, rankProgress} from '@/lib/scoring';
import {type TimedSession, bestSession, formatClock} from '@/lib/timer';
import {type Difficulty, type Problem, CONCEPT_LABEL, LANGUAGES, stepKey, stepPath} from '@/lib/types';

import {BadgeCatalog, BadgeGlyph} from './Badges';
import {useDialog} from './Dialog';
import {ActivityHeatmap} from './Heatmap';
import {ListControls} from './ListControls';
import {LandingIntro} from './LoadingScreen';
import {CompanyChip, CONCEPT_COLOR, ConceptChip, DifficultyChip} from './paneShared';
import {Clock, SessionList} from './Timer';

/**
 * The landing page: a short profile strip — where you stand (points inside a rank ring, the next
 * rank), the streak, the badges you have — one row of concept mastery, and then the problems,
 * which are the point of the page. Everything secondary (difficulty breakdown, acceptance rate,
 * the full badge catalog with progress) is one click away, not on the page.
 */

const DIFFICULTY_BAR: Record<Difficulty, string> = {
  easy: 'bg-success-400',
  medium: 'bg-warning-400',
  hard: 'bg-danger-400',
};

/** The row number carries the difficulty colour, the way the mock scenario cards carry their accent. */
const DIFFICULTY_RING: Record<Difficulty, string> = {
  easy: 'border-success-400/50 text-success-300',
  medium: 'border-warning-400/50 text-warning-300',
  hard: 'border-danger-400/50 text-danger-300',
};

const RING = {size: 60, stroke: 5};

/** Points inside a ring that fills as the learner approaches the next rank. */
const RankRing: FC<{score: number; share: number; top: boolean}> = memo(({score, share, top}) => {
  const r = (RING.size - RING.stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0" style={{width: RING.size, height: RING.size}}>
      <svg aria-hidden className="-rotate-90" height={RING.size} width={RING.size}>
        <circle
          className="stroke-ink-700"
          cx={RING.size / 2}
          cy={RING.size / 2}
          fill="none"
          r={r}
          strokeWidth={RING.stroke}
        />
        <circle
          className="stroke-iris-400 transition-[stroke-dashoffset] duration-500"
          cx={RING.size / 2}
          cy={RING.size / 2}
          fill="none"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (top ? 1 : share))}
          strokeLinecap="round"
          strokeWidth={RING.stroke}
        />
      </svg>
      <span className="font-code text-ink-50 absolute inset-0 flex items-center justify-center text-[15px] font-semibold">
        {score}
      </span>
    </span>
  );
});
RankRing.displayName = 'RankRing';

const Flame: FC<{lit: boolean}> = memo(({lit}) => (
  <svg
    aria-hidden
    className={lit ? 'text-warning-400' : 'text-ink-500'}
    fill="currentColor"
    height={18}
    viewBox="0 0 16 16"
    width={18}>
    <path d="M8.6 1.2c.3 2.3 2.9 3.4 3.4 6.2.6 3.2-1.7 5.9-4.3 5.9S3.3 11 3.9 8.3c.3-1.3 1.1-2.2 1.6-2.9.2 1 .7 1.6 1.4 1.9-.4-2.3.3-4.5 1.7-6.1Zm-.7 5.9c-.9 1.1-1.6 2-1.5 3.1.1 1.3 1 2 1.9 2s1.8-.8 1.7-2.1c0-1.1-.9-1.8-2.1-3Z" />
  </svg>
));
Flame.displayName = 'Flame';

const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easy: 'text-success-300',
  medium: 'text-warning-300',
  hard: 'text-danger-300',
};

const DIFFICULTY_SHORT: Record<Difficulty, string> = {easy: 'Easy', medium: 'Med.', hard: 'Hard'};

/** Problems solved by difficulty, the way LeetCode counts them: a problem is solved when every step is accepted. */
const SolvedByDifficulty: FC<{profile: Profile}> = memo(({profile}) => {
  const solved = profile.solved.easy + profile.solved.medium + profile.solved.hard;
  const total = profile.problems.easy + profile.problems.medium + profile.problems.hard;
  return (
    <div className="min-w-[13rem]" title="a problem counts as solved when every step is accepted">
      <p className="flex items-baseline justify-between text-[12px]">
        <span className="text-ink-300 font-bold uppercase tracking-wider">Solved</span>
        <span className="font-code text-ink-100">
          {solved}
          <span className="text-ink-400">/{total}</span>
        </span>
      </p>
      <ul className="mt-1 space-y-1">
        {(['easy', 'medium', 'hard'] as const).map(d => (
          <li className="flex items-center gap-2 text-[12px]" key={d}>
            <span className={`w-9 font-semibold ${DIFFICULTY_TEXT[d]}`}>{DIFFICULTY_SHORT[d]}</span>
            <span className="bg-ink-700 h-2 flex-1 overflow-hidden rounded-full">
              <span
                className={`block h-full rounded-full ${DIFFICULTY_BAR[d]}`}
                style={{
                  width: profile.problems[d] === 0 ? '0%' : `${(100 * profile.solved[d]) / profile.problems[d]}%`,
                }}
              />
            </span>
            <span className="font-code text-ink-100 w-9 text-right">
              {profile.solved[d]}
              <span className="text-ink-400">/{profile.problems[d]}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
SolvedByDifficulty.displayName = 'SolvedByDifficulty';

const ProfileStrip: FC<{
  profile: Profile;
  streak: Streak;
  badges: Record<string, number>;
  problems: readonly Problem[];
  attempts: Record<string, StepAttempt>;
  activeDays: readonly string[];
  today: string;
  sessions: readonly TimedSession[];
}> = memo(({profile, streak, badges, problems, attempts, activeDays, today, sessions}) => {
  const rank = rankProgress(profile.score, profile.max);
  const share = Math.min(1, Math.max(0, (profile.score - rank.from) / Math.max(1, rank.nextAt - rank.from)));
  const earned = useMemo(() => BADGES.filter(b => badges[b.id] !== undefined), [badges]);
  const progress = useMemo(
    () => badgeProgress(problems, attempts, activeDays, today, sessions),
    [problems, attempts, activeDays, today, sessions],
  );
  const [statsOpen, setStatsOpen] = useState(false);
  const toggleStats = useCallback(() => setStatsOpen(v => !v), []);
  const [dialog, openDialog] = useDialog();
  const onAllBadges = useCallback(() => {
    void openDialog({
      title: `Badges · ${earned.length} of ${BADGES.length}`,
      body: <BadgeCatalog earned={badges} progress={progress} />,
      wide: true,
    });
  }, [openDialog, earned.length, badges, progress]);
  const counted = useMemo(() => sessions.filter(s => s.counted).length, [sessions]);
  const pick = useMemo(() => stepOfTheDay(problems, attempts, today), [problems, attempts, today]);
  const activity = useMemo(() => activityByDay(attempts, activeDays), [attempts, activeDays]);
  const onRuns = useCallback(() => {
    void openDialog({
      title: `Timed runs · ${sessions.length}`,
      body:
        sessions.length === 0 ? (
          <p>No timed runs yet. Open a problem and press Start under “Timed run” to race its estimate from step 1.</p>
        ) : (
          <SessionList problems={problems} sessions={sessions} showProblem />
        ),
      wide: sessions.length > 0,
    });
  }, [openDialog, sessions, problems]);
  const shown = earned.slice(-5);
  return (
    <section className="border-iris-400/20 from-iris-400/[0.06] bg-ink-850 rounded-2xl border bg-gradient-to-br to-transparent px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        {/* Where you stand */}
        <div className="flex min-w-0 items-center gap-3">
          <RankRing score={profile.score} share={share} top={rank.next === null} />
          <div className="min-w-0">
            <p className="from-iris-200 to-ink-50 bg-gradient-to-r bg-clip-text text-[17px] font-extrabold leading-tight text-transparent">
              {rank.rank}
            </p>
            <p className="text-ink-300 text-[12px]">
              <span className="font-code text-ink-100">{profile.score}</span>
              <span className="text-ink-400"> / {profile.max} pts</span>
              {rank.next === null ? (
                <span> · top of the ladder</span>
              ) : (
                <span>
                  {' '}
                  · <span className="font-code text-ink-100">{rank.nextAt - profile.score}</span> to {rank.next}
                </span>
              )}
            </p>
          </div>
        </div>

        <SolvedByDifficulty profile={profile} />

        {/* Streak, with what to do about it: the step whose turn it is today */}
        <div
          className="flex min-w-0 items-center gap-2"
          title="accept a step on consecutive days; the step of the day is one you can open right now">
          <Flame lit={streak.current > 0} />
          <div className="min-w-0">
            <p className={`text-[14px] font-bold leading-tight ${streak.current > 0 ? 'text-ink-50' : 'text-ink-200'}`}>
              {streak.current > 0 ? `${streak.current}-day streak` : 'No streak yet'}
            </p>
            {streak.today ? (
              <p className="text-ink-400 text-[12px]">
                safe for today{streak.best > streak.current ? ` · best ${streak.best}` : ''}
              </p>
            ) : pick !== null ? (
              <Link
                className="text-iris-300 hover:text-iris-200 block max-w-[20rem] text-[12px] leading-tight"
                href={stepPath(pick.problem, pick.step)}
                title={`today's step: ${pick.step.title} (${pick.problem.title}, step ${pick.index + 1})`}>
                {streak.current > 0 ? 'keep it' : 'start one'} today: {pick.problem.title} · step {pick.index + 1} ›
              </Link>
            ) : (
              <p className="text-ink-400 text-[12px]">every step is done — start a course over to keep it</p>
            )}
          </div>
        </div>

        {/* Badges */}
        <button
          className="hover:bg-ink-800 group ml-auto flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition"
          onClick={onAllBadges}
          title="every badge, with how far along you are"
          type="button">
          <span className="flex items-center gap-1">
            {shown.length === 0 ? (
              <BadgeGlyph badge={BADGES[0]} earned={false} size="sm" />
            ) : (
              shown.map(b => (
                <span key={b.id} title={b.title}>
                  <BadgeGlyph badge={b} earned size="sm" />
                </span>
              ))
            )}
            {earned.length > shown.length ? (
              <span className="font-code text-ink-400 text-[10px]">+{earned.length - shown.length}</span>
            ) : null}
          </span>
          <span>
            <span className="text-ink-50 block text-[14px] font-bold leading-tight">
              {earned.length}
              <span className="text-ink-400 font-normal"> / {BADGES.length} badges</span>
            </span>
            <span className="text-iris-300 group-hover:text-iris-200 block text-[12px]">
              {earned.length === 0 ? 'see what to aim for ›' : 'all badges ›'}
            </span>
          </span>
        </button>
      </div>

      {/* Mastery: one row, four concepts */}
      <div className="border-ink-700/70 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-2.5">
        {profile.concepts.map(c => (
          <div
            className="flex min-w-[10rem] flex-1 items-center gap-2 text-[12px]"
            key={c.concept}
            title={`${CONCEPT_LABEL[c.concept]} steps accepted`}>
            <span className="text-ink-200 w-10 font-semibold">{CONCEPT_LABEL[c.concept]}</span>
            <span className="bg-ink-700 h-2 flex-1 overflow-hidden rounded-full">
              <span
                className="block h-full rounded-full"
                style={{
                  background: CONCEPT_COLOR[c.concept],
                  width: c.total === 0 ? '0%' : `${(100 * c.accepted) / c.total}%`,
                }}
              />
            </span>
            <span className="font-code text-ink-300 w-9 text-right text-[11px]">
              {c.accepted}/{c.total}
            </span>
          </div>
        ))}
        <button
          aria-expanded={statsOpen}
          className="text-ink-400 hover:text-ink-50 ml-auto rounded-md px-1.5 py-0.5 text-[12px] transition"
          onClick={toggleStats}
          type="button">
          stats {statsOpen ? '▴' : '▾'}
        </button>
      </div>

      {statsOpen ? (
        <div className="border-ink-700/70 mt-2.5 space-y-3 border-t pt-3">
          <ActivityHeatmap days={activity} streak={streak} today={today} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-300">steps accepted</dt>
              <dd className="font-code text-ink-100">{profile.stepsAccepted}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-300">revealed</dt>
              <dd className="font-code text-ink-100">{profile.stepsRevealed}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-300">submissions</dt>
              <dd className="font-code text-ink-100">{profile.submissions}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-300">acceptance</dt>
              <dd className="font-code text-ink-100">{Math.round(profile.acceptance * 100)}%</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-300">timed runs</dt>
              <dd className="text-ink-100 flex items-baseline gap-2">
                <span className="font-code">
                  {sessions.length === 0 ? (
                    '0'
                  ) : (
                    <>
                      {counted} counted <span className="text-ink-400">/ {sessions.length}</span>
                    </>
                  )}
                </span>
                <button
                  className="text-iris-300 hover:text-iris-200 text-[12px] transition"
                  onClick={onRuns}
                  title={sessions.length === 0 ? 'how timed runs work' : 'every timed run, newest first'}
                  type="button">
                  {sessions.length === 0 ? 'race a problem’s estimate ›' : 'history ›'}
                </button>
              </dd>
            </div>
            <p className="text-ink-400 col-span-2 text-[11px]">
              Scored like a contest: each hint −20%, each wrong submission −5% (floor 25%), a revealed step 0.
            </p>
          </dl>
        </div>
      ) : null}
      {dialog}
    </section>
  );
});
ProfileStrip.displayName = 'ProfileStrip';

/** One square per step, as on the share card: solid = first try, tinted = with help, outlined = revealed, dim = open. */
const StepSquares: FC<{problem: Problem; attempts: Record<string, StepAttempt>}> = memo(({problem, attempts}) => (
  <span aria-hidden className="flex items-center gap-[3px]">
    {problem.steps.map(step => {
      const attempt = attempts[stepKey(problem.id, step.id)] ?? OPEN_ATTEMPT;
      const tone =
        attempt.status === 'accepted'
          ? attempt.hints === 0 && attempt.wrong === 0
            ? 'bg-iris-400'
            : 'bg-iris-400/45'
          : attempt.status === 'revealed'
          ? 'border-warning-400/70 border'
          : 'bg-ink-700';
      return <span className={`h-2.5 w-2.5 rounded-[3px] ${tone}`} key={step.id} />;
    })}
  </span>
));
StepSquares.displayName = 'StepSquares';

/**
 * What the AI-era track asks an interviewer to see. These are the behaviours the new courses are
 * built to expose: not "can you prompt", but can you specify, delegate, verify, evaluate, secure
 * and operate a system whose core is a model.
 */
const AI_SKILLS: readonly {title: string; body: string}[] = [
  {title: 'Specify', body: 'Turn an ambiguous ask into interfaces, budgets and acceptance criteria.'},
  {title: 'Delegate', body: 'Use models where they help; make prompts, versions and fallbacks explicit.'},
  {title: 'Verify', body: 'Review the generated draft, test the edge cases, and reject what you cannot prove.'},
  {title: 'Evaluate', body: 'Golden sets, calibrated judges, regression gates and online metrics.'},
  {
    title: 'Secure',
    body: 'Treat retrieved text and tool output as untrusted; scope tenants, allowlists and approvals.',
  },
  {title: 'Operate', body: 'Token and cost budgets, latency SLOs, retries, idempotency and traces.'},
];

const ProblemRow: FC<{
  problem: Problem;
  index: number;
  attempts: Record<string, StepAttempt>;
  best: TimedSession | null;
}> = memo(({problem, index, attempts, best}) => {
  const score = problemScore(problem, attempts);
  const solved = score.done === score.total;
  const started = score.done > 0;
  /** Where a started problem picks up: its first step not yet done. */
  const resume =
    started && !solved
      ? problem.steps.find(s => (attempts[stepKey(problem.id, s.id)] ?? OPEN_ATTEMPT).status === 'open')
      : undefined;
  return (
    <li>
      <Link
        className="border-ink-700 bg-ink-850 hover:border-iris-400/60 hover:bg-ink-800 group flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition"
        href={`/${problem.id}`}>
        <span
          className={`font-code flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
            solved
              ? 'border-iris-400 bg-iris-400 text-ink-950'
              : `${DIFFICULTY_RING[problem.difficulty]} ${started ? 'bg-ink-800' : ''}`
          }`}>
          {solved ? '✓' : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ink-50 group-hover:text-iris-200 text-[14px] font-bold">{problem.title}</span>
            <DifficultyChip difficulty={problem.difficulty} />
            {problem.track === 'ai' ? (
              <span className="border-iris-400/40 bg-iris-400/10 text-iris-300 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                AI-era
              </span>
            ) : null}
            {problem.company !== undefined ? <CompanyChip company={problem.company} /> : null}
            {problem.concepts.map(c => (
              <ConceptChip concept={c} key={c} />
            ))}
          </span>
          <span className="text-ink-300 mt-1 block text-[13px] leading-5">{problem.tagline}</span>
          <span className="text-ink-300 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <StepSquares attempts={attempts} problem={problem} />
            <span className="font-code">
              {score.done}/{score.total} steps
            </span>
            <span className="font-code">
              {score.score}/{score.max} pts
            </span>
            <span className="font-code">~{problem.minutes} min</span>
            {best !== null ? (
              <span
                className="font-code text-success-300 flex items-center gap-1"
                title="your fastest timed run within the budget">
                <Clock />
                {formatClock(best.elapsed)}
              </span>
            ) : null}
            {score.accepted < score.done ? (
              <span className="font-code text-warning-300">{score.done - score.accepted} revealed</span>
            ) : null}
          </span>
        </span>
        <span className="hidden shrink-0 text-right sm:block">
          <span
            className={`block text-[12px] font-semibold ${
              solved ? 'text-iris-300' : 'text-ink-400 group-hover:text-iris-200'
            }`}>
            {solved ? 'solved' : started ? 'continue ›' : 'start ›'}
          </span>
          {resume !== undefined ? (
            <span className="text-ink-400 block max-w-[12rem] truncate text-[11px]">
              step {problem.steps.indexOf(resume) + 1} · {resume.title}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
});
ProblemRow.displayName = 'ProblemRow';

const ProblemList: FC<{
  problems: readonly Problem[];
  attempts: Record<string, StepAttempt>;
  profile: Profile;
  streak: Streak;
  badges: Record<string, number>;
  activeDays: readonly string[];
  today: string;
  sessions: readonly TimedSession[];
}> = memo(({problems, attempts, profile, streak, badges, activeDays, today, sessions}) => {
  const [query, update, reset] = useListQuery();
  const shown = useMemo(() => applyListQuery(problems, attempts, query), [problems, attempts, query]);
  const numbers = useMemo(() => new Map(problems.map((p, i) => [p.id, i])), [problems]);
  const solvedCount = useMemo(
    () => problems.filter(p => problemStatus(p, attempts) === 'solved').length,
    [problems, attempts],
  );
  const ai = useMemo(() => shown.filter(p => p.track === 'ai'), [shown]);
  const systems = useMemo(() => shown.filter(p => p.track !== 'ai'), [shown]);
  const stats = useMemo(
    () => [
      `${problems.length} courses`,
      `${problems.reduce((n, p) => n + p.steps.length, 0)} steps`,
      `${LANGUAGES.length} languages`,
      `${profile.max} points`,
    ],
    [problems, profile.max],
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-6">
      <LandingIntro stats={stats} />
      <ProfileStrip
        activeDays={activeDays}
        attempts={attempts}
        badges={badges}
        problems={problems}
        profile={profile}
        sessions={sessions}
        streak={streak}
        today={today}
      />
      <section id="problems">
        <div className="mb-3">
          <ListControls
            query={query}
            reset={reset}
            shown={shown.length}
            solved={solvedCount}
            total={problems.length}
            update={update}
          />
        </div>
        {shown.length === 0 ? (
          <p className="border-ink-700 text-ink-300 rounded-xl border border-dashed px-4 py-6 text-center text-[12px]">
            No course matches{query.q.trim() !== '' ? ` “${query.q.trim()}”` : ''} with these filters.{' '}
            <button className="text-iris-300 hover:text-iris-200 transition" onClick={reset} type="button">
              Clear them ›
            </button>
          </p>
        ) : (
          <>
            {ai.length > 0 ? (
              <section className="border-iris-400/30 from-iris-400/[0.10] mb-5 rounded-2xl border bg-gradient-to-br via-transparent to-transparent p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-iris-300 text-[11px] font-bold uppercase tracking-wider">
                      AI-era interview track
                    </p>
                    <h2 className="text-ink-50 mt-2 text-[20px] font-extrabold leading-tight">
                      Use AI. Then prove it.
                    </h2>
                  </div>
                  <span className="border-iris-400/40 bg-iris-400/10 text-iris-300 rounded-full border px-2.5 py-1 text-[11px] font-semibold">
                    {ai.length} courses · {ai.reduce((n, p) => n + p.steps.length, 0)} steps
                  </span>
                </div>
                <p className="text-ink-200 mt-3 max-w-3xl text-[13px] leading-6">
                  Two courses, ten review-first steps, and the six signals AI-era interviews probe.
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {AI_SKILLS.map(skill => (
                    <span
                      className="border-iris-400/30 bg-iris-400/[0.08] text-iris-200 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
                      key={skill.title}
                      title={skill.body}>
                      {skill.title}
                    </span>
                  ))}
                </div>
                <p className="text-ink-400 mt-3 text-[12px]">
                  <Link
                    className="text-iris-300 hover:text-iris-200 decoration-iris-400/40 font-semibold underline"
                    href="/mock-interview">
                    Start the timed mock
                  </Link>{' '}
                  or take a course below.
                </p>
                <ul className="mt-4 space-y-2.5">
                  {ai.map(problem => (
                    <ProblemRow
                      attempts={attempts}
                      best={bestSession(sessions, problem.id)}
                      index={numbers.get(problem.id) ?? 0}
                      key={problem.id}
                      problem={problem}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
            {systems.length > 0 ? (
              <section>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-ink-50 text-lg font-extrabold">{ai.length > 0 ? 'Systems track' : 'Problems'}</h2>
                  <span className="text-ink-400 text-[12px]">{systems.length} courses</span>
                </div>
                <ul className="space-y-2.5">
                  {systems.map(problem => (
                    <ProblemRow
                      attempts={attempts}
                      best={bestSession(sessions, problem.id)}
                      index={numbers.get(problem.id) ?? 0}
                      key={problem.id}
                      problem={problem}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
});
ProblemList.displayName = 'ProblemList';

export default ProblemList;
