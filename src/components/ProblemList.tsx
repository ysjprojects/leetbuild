import Link from 'next/link';
import {type FC, memo, useCallback, useMemo, useState} from 'react';

import {type Streak, badgeProgress, BADGES} from '@/lib/gamify';
import {type Profile, type StepAttempt, OPEN_ATTEMPT, problemScore, rankProgress} from '@/lib/scoring';
import {type TimedSession, bestSession, formatClock} from '@/lib/timer';
import {type Problem, CONCEPT_LABEL, stepKey} from '@/lib/types';

import {BadgeCatalog, BadgeGlyph} from './Badges';
import {useDialog} from './Dialog';
import {CONCEPT_COLOR, ConceptChip, DifficultyChip} from './paneShared';
import {Clock, SessionList} from './Timer';

/**
 * The landing page: a short profile strip — where you stand (points inside a rank ring, the next
 * rank), the streak, the badges you have — one row of concept mastery, and then the problems,
 * which are the point of the page. Everything secondary (difficulty breakdown, acceptance rate,
 * the full badge catalog with progress) is one click away, not on the page.
 */

const DIFFICULTY_BAR: Record<'easy' | 'medium' | 'hard', string> = {
  easy: 'bg-success-400',
  medium: 'bg-warning-400',
  hard: 'bg-danger-400',
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
    () => badgeProgress(problems, attempts, activeDays, today),
    [problems, attempts, activeDays, today],
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
    <section className="border-ink-700 bg-ink-850 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Where you stand */}
        <div className="flex min-w-0 items-center gap-3">
          <RankRing score={profile.score} share={share} top={rank.next === null} />
          <div className="min-w-0">
            <p className="from-iris-200 to-ink-50 bg-gradient-to-r bg-clip-text text-[17px] font-extrabold leading-tight text-transparent">
              {rank.rank}
            </p>
            <p className="text-ink-300 text-[11.5px]">
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

        {/* Streak */}
        <div className="flex items-center gap-2" title="accept a step on consecutive days">
          <Flame lit={streak.current > 0} />
          <div>
            <p className={`text-[13px] font-bold leading-tight ${streak.current > 0 ? 'text-ink-50' : 'text-ink-200'}`}>
              {streak.current > 0 ? `${streak.current}-day streak` : 'No streak yet'}
            </p>
            <p className="text-ink-400 text-[11px]">
              {streak.today
                ? `safe for today${streak.best > streak.current ? ` · best ${streak.best}` : ''}`
                : streak.current > 0
                ? 'accept a step today to keep it'
                : 'accept a step today to start one'}
            </p>
          </div>
        </div>

        {/* Timed runs */}
        <button
          className="hover:bg-ink-800 group flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition"
          onClick={onRuns}
          title="every timed run, newest first"
          type="button">
          <span className={sessions.length > 0 ? 'text-iris-300' : 'text-ink-500'}>
            <Clock />
          </span>
          <span>
            <span className="text-ink-50 block text-[13px] font-bold leading-tight">
              {sessions.length === 0 ? 'No timed runs' : `${counted} counted`}
              {sessions.length > 0 ? <span className="text-ink-400 font-normal"> / {sessions.length} runs</span> : null}
            </span>
            <span className="text-iris-300 group-hover:text-iris-200 block text-[11px]">
              {sessions.length === 0 ? 'race a problem’s estimate ›' : 'history ›'}
            </span>
          </span>
        </button>

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
            <span className="text-ink-50 block text-[13px] font-bold leading-tight">
              {earned.length}
              <span className="text-ink-400 font-normal"> / {BADGES.length} badges</span>
            </span>
            <span className="text-iris-300 group-hover:text-iris-200 block text-[11px]">
              {earned.length === 0 ? 'see what to aim for ›' : 'all badges ›'}
            </span>
          </span>
        </button>
      </div>

      {/* Mastery: one row, four concepts */}
      <div className="border-ink-700/70 mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-2.5">
        {profile.concepts.map(c => (
          <div
            className="flex min-w-[9rem] flex-1 items-center gap-2 text-[11px]"
            key={c.concept}
            title={`${CONCEPT_LABEL[c.concept]} steps accepted`}>
            <span className="text-ink-200 w-10 font-semibold">{CONCEPT_LABEL[c.concept]}</span>
            <span className="bg-ink-700 h-1.5 flex-1 overflow-hidden rounded-full">
              <span
                className="block h-full rounded-full"
                style={{
                  background: CONCEPT_COLOR[c.concept],
                  width: c.total === 0 ? '0%' : `${(100 * c.accepted) / c.total}%`,
                }}
              />
            </span>
            <span className="font-code text-ink-300 w-9 text-right text-[10.5px]">
              {c.accepted}/{c.total}
            </span>
          </div>
        ))}
        <button
          aria-expanded={statsOpen}
          className="text-ink-400 hover:text-ink-50 ml-auto rounded-md px-1.5 py-0.5 text-[11px] transition"
          onClick={toggleStats}
          type="button">
          stats {statsOpen ? '▴' : '▾'}
        </button>
      </div>

      {statsOpen ? (
        <div className="border-ink-700/70 mt-2.5 grid gap-x-6 gap-y-3 border-t pt-3 sm:grid-cols-2">
          <ul className="space-y-1.5">
            {(['easy', 'medium', 'hard'] as const).map(d => (
              <li className="flex items-center gap-2 text-[11.5px]" key={d}>
                <span className="text-ink-200 w-14 capitalize">{d}</span>
                <span className="bg-ink-700 h-1.5 flex-1 overflow-hidden rounded-full">
                  <span
                    className={`block h-full rounded-full ${DIFFICULTY_BAR[d]}`}
                    style={{
                      width: profile.problems[d] === 0 ? '0%' : `${(100 * profile.solved[d]) / profile.problems[d]}%`,
                    }}
                  />
                </span>
                <span className="font-code text-ink-300 w-16 text-right text-[10.5px]">
                  {profile.solved[d]}/{profile.problems[d]} solved
                </span>
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
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
            <p className="text-ink-400 col-span-2 text-[10.5px]">
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

const ProblemRow: FC<{
  problem: Problem;
  index: number;
  attempts: Record<string, StepAttempt>;
  best: TimedSession | null;
}> = memo(({problem, index, attempts, best}) => {
  const score = problemScore(problem, attempts);
  const solved = score.done === score.total;
  const started = score.done > 0;
  return (
    <li>
      <Link
        className="border-ink-700 bg-ink-850 hover:border-iris-400/60 hover:bg-ink-800 group flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition"
        href={`/${problem.id}`}>
        <span
          className={`font-code flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
            solved
              ? 'border-iris-400 bg-iris-400 text-ink-950'
              : started
              ? 'border-iris-400/70 text-iris-300'
              : 'border-ink-600 text-ink-300'
          }`}>
          {solved ? '✓' : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ink-50 group-hover:text-iris-200 text-[14px] font-bold">{problem.title}</span>
            <DifficultyChip difficulty={problem.difficulty} />
            {problem.concepts.map(c => (
              <ConceptChip concept={c} key={c} />
            ))}
          </span>
          <span className="text-ink-300 mt-0.5 block text-[12px]">{problem.tagline}</span>
          <span className="text-ink-300 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
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
        <span
          className={`shrink-0 text-[12px] font-semibold ${
            solved ? 'text-iris-300' : 'text-ink-400 group-hover:text-iris-200'
          }`}>
          {solved ? 'solved' : started ? 'continue ›' : 'start ›'}
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
}> = memo(({problems, attempts, profile, streak, badges, activeDays, today, sessions}) => (
  <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-5">
    <div>
      <h1 className="text-ink-50 text-2xl font-extrabold leading-tight">Build systems, step by step</h1>
      <p className="text-ink-200 mt-1 max-w-2xl text-[13px] leading-relaxed">
        Every problem is a real system cut down to the parts that matter: an HTTPS API, a gRPC call, a Kafka topic, a
        Redis key. You implement it one file at a time in Python, Go, Scala or C++; the judge checks each step, hints
        cost points, and revealing the answer costs all of them. Each problem's tutorial can be downloaded as Markdown
        from its page.
      </p>
    </div>
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
    <section>
      <p className="text-iris-400 mb-2 text-[11px] font-bold uppercase tracking-wider">Problems</p>
      <ul className="space-y-2">
        {problems.map((problem, i) => (
          <ProblemRow
            attempts={attempts}
            best={bestSession(sessions, problem.id)}
            index={i}
            key={problem.id}
            problem={problem}
          />
        ))}
      </ul>
    </section>
  </div>
));
ProblemList.displayName = 'ProblemList';

export default ProblemList;
