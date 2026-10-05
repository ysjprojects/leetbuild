import Link from 'next/link';
import {type FC, memo} from 'react';

import {type Badge, type Streak, BADGES} from '@/lib/gamify';
import {type Profile, type StepAttempt, problemScore, rankProgress} from '@/lib/scoring';
import {type Problem, CONCEPT_LABEL} from '@/lib/types';

import {CONCEPT_COLOR, ConceptChip, DifficultyChip} from './paneShared';

const DIFFICULTY_BAR: Record<'easy' | 'medium' | 'hard', string> = {
  easy: 'bg-success-400',
  medium: 'bg-warning-400',
  hard: 'bg-danger-400',
};

const BadgeChip: FC<{badge: Badge; earnedAt: number | undefined}> = memo(({badge, earnedAt}) => {
  const earned = earnedAt !== undefined;
  const when = earned ? new Date(earnedAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : null;
  return (
    <li
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
        earned ? 'border-iris-400/50 bg-iris-400/10' : 'border-ink-700 bg-ink-850 opacity-60'
      }`}
      title={`${badge.title} — ${badge.blurb}${when === null ? '' : ` · earned ${when}`}`}>
      <span
        className={`font-code flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          earned ? 'bg-iris-400 text-ink-950' : 'border-ink-600 text-ink-400 border'
        }`}>
        {badge.glyph}
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-[12px] font-semibold ${earned ? 'text-ink-50' : 'text-ink-300'}`}>
          {badge.title}
        </span>
        <span className="text-ink-400 block truncate text-[10px]">{badge.blurb}</span>
      </span>
    </li>
  );
});
BadgeChip.displayName = 'BadgeChip';

const ProfileCard: FC<{profile: Profile; streak: Streak; badges: Record<string, number>}> = memo(
  ({profile, streak, badges}) => {
    const rank = rankProgress(profile.score, profile.max);
    const span = Math.max(1, rank.nextAt - rank.from);
    const towardsNext = Math.min(1, Math.max(0, (profile.score - rank.from) / span));
    const earnedCount = BADGES.filter(b => badges[b.id] !== undefined).length;
    return (
      <section className="border-ink-700 bg-ink-850 rounded-xl border p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-iris-400 text-[11px] font-bold uppercase tracking-wider">Guild rank</p>
            <p className="from-iris-200 to-ink-50 bg-gradient-to-r bg-clip-text text-2xl font-extrabold leading-tight text-transparent">
              {profile.rank}
            </p>
            <div className="text-ink-300 mt-1.5 flex items-center gap-2 text-[11px]">
              <span className="bg-ink-700 h-1.5 w-40 overflow-hidden rounded-full">
                <span className="bg-iris-400 block h-full rounded-full" style={{width: `${towardsNext * 100}%`}} />
              </span>
              {rank.next === null ? (
                <span>top of the ladder</span>
              ) : (
                <span>
                  {rank.nextAt - profile.score} pts to {rank.next}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="font-code text-ink-50 text-[22px] font-semibold leading-none">
              {profile.score}
              <span className="text-ink-300 text-[13px]"> / {profile.max}</span>
            </p>
            <p className="text-ink-300 mt-1 text-[11px]">
              points · scored like a contest: hints and wrong submissions cost
            </p>
            <p className="text-ink-300 mt-1 text-[11px]">
              streak{' '}
              <b className={streak.current > 0 ? 'text-iris-200' : 'text-ink-100'}>
                {streak.current} day{streak.current === 1 ? '' : 's'}
              </b>
              {streak.best > streak.current ? <span> · best {streak.best}</span> : null}
              <span className="text-ink-400"> · accept a step each day to keep it</span>
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-ink-300 text-[11px] font-bold uppercase tracking-wider">Problems solved</p>
            <ul className="mt-1.5 space-y-1.5">
              {(['easy', 'medium', 'hard'] as const).map(d => {
                const total = profile.problems[d];
                const done = profile.solved[d];
                return (
                  <li className="flex items-center gap-2 text-[12px]" key={d}>
                    <span className="text-ink-200 w-14 capitalize">{d}</span>
                    <span className="bg-ink-700 h-1.5 flex-1 overflow-hidden rounded-full">
                      <span
                        className={`block h-full rounded-full ${DIFFICULTY_BAR[d]}`}
                        style={{width: total === 0 ? '0%' : `${(100 * done) / total}%`}}
                      />
                    </span>
                    <span className="font-code text-ink-200 w-10 text-right text-[11px]">
                      {done}/{total}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="text-ink-300 text-[11px] font-bold uppercase tracking-wider">Concept mastery</p>
            <ul className="mt-1.5 space-y-1.5">
              {profile.concepts.map(c => (
                <li className="flex items-center gap-2 text-[12px]" key={c.concept}>
                  <span className="text-ink-200 w-14">{CONCEPT_LABEL[c.concept]}</span>
                  <span className="bg-ink-700 h-1.5 flex-1 overflow-hidden rounded-full">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        background: CONCEPT_COLOR[c.concept],
                        width: c.total === 0 ? '0%' : `${(100 * c.accepted) / c.total}%`,
                      }}
                    />
                  </span>
                  <span className="font-code text-ink-200 w-10 text-right text-[11px]">
                    {c.accepted}/{c.total}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="text-ink-300 mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span>
            <b className="text-ink-100">{profile.stepsAccepted}</b> steps accepted
          </span>
          <span>
            <b className="text-ink-100">{profile.stepsRevealed}</b> revealed
          </span>
          <span>
            <b className="text-ink-100">{profile.submissions}</b> submissions
          </span>
          <span>
            acceptance <b className="text-ink-100">{Math.round(profile.acceptance * 100)}%</b>
          </span>
        </div>
        <div className="mt-4">
          <p className="text-ink-300 flex items-baseline justify-between text-[11px] font-bold uppercase tracking-wider">
            <span>Badges</span>
            <span className="font-code normal-case tracking-normal">
              {earnedCount} / {BADGES.length}
            </span>
          </p>
          <ul className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {BADGES.map(badge => (
              <BadgeChip badge={badge} earnedAt={badges[badge.id]} key={badge.id} />
            ))}
          </ul>
        </div>
      </section>
    );
  },
);
ProfileCard.displayName = 'ProfileCard';

const ProblemRow: FC<{
  problem: Problem;
  index: number;
  attempts: Record<string, StepAttempt>;
}> = memo(({problem, index, attempts}) => {
  const score = problemScore(problem, attempts);
  const solved = score.done === score.total;
  const started = score.done > 0;
  return (
    <li>
      <Link
        className="border-ink-700 bg-ink-850 hover:border-iris-400/60 hover:bg-ink-800 group flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition"
        href={`/${problem.id}`}>
        <span
          className={`font-code mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
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
          <span className="font-code text-ink-300 mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px]">
            <span>
              {score.done}/{score.total} steps
            </span>
            <span>
              {score.score}/{score.max} pts
            </span>
            <span>~{problem.minutes} min</span>
            {score.accepted < score.done ? (
              <span className="text-warning-300">{score.done - score.accepted} revealed</span>
            ) : null}
          </span>
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
}> = memo(({problems, attempts, profile, streak, badges}) => (
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
    <ProfileCard badges={badges} profile={profile} streak={streak} />
    <section>
      <p className="text-iris-400 mb-2 text-[11px] font-bold uppercase tracking-wider">Problems</p>
      <ul className="space-y-2">
        {problems.map((problem, i) => (
          <ProblemRow attempts={attempts} index={i} key={problem.id} problem={problem} />
        ))}
      </ul>
    </section>
  </div>
));
ProblemList.displayName = 'ProblemList';

export default ProblemList;
