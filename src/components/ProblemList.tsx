import {type FC, memo, useCallback} from 'react';

import {type Badge, type Streak, BADGES} from '@/lib/gamify';
import {type Profile, type StepAttempt, problemScore, rankProgress} from '@/lib/scoring';
import {type Problem, CONCEPT_LABEL} from '@/lib/types';

import {CONCEPT_COLOR, ConceptChip, DifficultyChip} from './paneShared';

const DIFFICULTY_BAR: Record<'easy' | 'medium' | 'hard', string> = {
  easy: 'bg-emerald-400',
  medium: 'bg-amber-400',
  hard: 'bg-rose-400',
};

const BadgeChip: FC<{badge: Badge; earnedAt: number | undefined}> = memo(({badge, earnedAt}) => {
  const earned = earnedAt !== undefined;
  const when = earned ? new Date(earnedAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : null;
  return (
    <li
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
        earned ? 'border-candy-400/60 bg-candy-500/10' : 'border-plum-700/60 bg-plum-900/40 opacity-60'
      }`}
      title={`${badge.title} — ${badge.blurb}${when === null ? '' : ` · earned ${when}`}`}>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-code text-[10px] font-bold ${
          earned
            ? 'bg-candy-500 text-white shadow-[0_0_12px_rgba(255,63,166,0.45)]'
            : 'border border-plum-500 text-plum-400'
        }`}>
        {badge.glyph}
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-[12px] font-semibold ${earned ? 'text-white' : 'text-plum-300'}`}>
          {badge.title}
        </span>
        <span className="block truncate text-[10px] text-plum-400">{badge.blurb}</span>
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
      <section className="rounded-xl border border-plum-600/70 bg-plum-950/40 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-candy-400">Guild rank</p>
            <p className="bg-gradient-to-r from-candy-300 to-white bg-clip-text text-2xl font-extrabold leading-tight text-transparent">
              {profile.rank}
            </p>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-plum-300">
              <span className="h-1.5 w-40 overflow-hidden rounded-full bg-plum-800">
                <span className="block h-full rounded-full bg-candy-500" style={{width: `${towardsNext * 100}%`}} />
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
            <p className="font-code text-[22px] font-semibold leading-none text-white">
              {profile.score}
              <span className="text-[13px] text-plum-300"> / {profile.max}</span>
            </p>
            <p className="mt-1 text-[11px] text-plum-300">
              points · scored like a contest: hints and wrong submissions cost
            </p>
            <p className="mt-1 text-[11px] text-plum-300">
              streak{' '}
              <b className={streak.current > 0 ? 'text-candy-200' : 'text-cream'}>
                {streak.current} day{streak.current === 1 ? '' : 's'}
              </b>
              {streak.best > streak.current ? <span> · best {streak.best}</span> : null}
              <span className="text-plum-400"> · accept a step each day to keep it</span>
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-plum-300">Problems solved</p>
            <ul className="mt-1.5 space-y-1.5">
              {(['easy', 'medium', 'hard'] as const).map(d => {
                const total = profile.problems[d];
                const done = profile.solved[d];
                return (
                  <li className="flex items-center gap-2 text-[12px]" key={d}>
                    <span className="w-14 capitalize text-plum-200">{d}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-plum-800">
                      <span
                        className={`block h-full rounded-full ${DIFFICULTY_BAR[d]}`}
                        style={{width: total === 0 ? '0%' : `${(100 * done) / total}%`}}
                      />
                    </span>
                    <span className="w-10 text-right font-code text-[11px] text-plum-200">
                      {done}/{total}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-plum-300">Concept mastery</p>
            <ul className="mt-1.5 space-y-1.5">
              {profile.concepts.map(c => (
                <li className="flex items-center gap-2 text-[12px]" key={c.concept}>
                  <span className="w-14 text-plum-200">{CONCEPT_LABEL[c.concept]}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-plum-800">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        background: CONCEPT_COLOR[c.concept],
                        width: c.total === 0 ? '0%' : `${(100 * c.accepted) / c.total}%`,
                      }}
                    />
                  </span>
                  <span className="w-10 text-right font-code text-[11px] text-plum-200">
                    {c.accepted}/{c.total}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-plum-300">
          <span>
            <b className="text-cream">{profile.stepsAccepted}</b> steps accepted
          </span>
          <span>
            <b className="text-cream">{profile.stepsRevealed}</b> revealed
          </span>
          <span>
            <b className="text-cream">{profile.submissions}</b> submissions
          </span>
          <span>
            acceptance <b className="text-cream">{Math.round(profile.acceptance * 100)}%</b>
          </span>
        </div>
        <div className="mt-4">
          <p className="flex items-baseline justify-between text-[11px] font-bold uppercase tracking-wider text-plum-300">
            <span>Badges</span>
            <span className="font-code normal-case tracking-normal">
              {earnedCount} / {BADGES.length}
            </span>
          </p>
          <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
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
  onOpen: (id: string) => void;
}> = memo(({problem, index, attempts, onOpen}) => {
  const score = problemScore(problem, attempts);
  const onClick = useCallback(() => onOpen(problem.id), [onOpen, problem.id]);
  const solved = score.done === score.total;
  const started = score.done > 0;
  return (
    <li>
      <button
        className="group flex w-full items-start gap-3 rounded-xl border border-plum-600/60 bg-plum-900/50 px-4 py-3 text-left transition hover:border-candy-500/60 hover:bg-plum-800/60"
        onClick={onClick}
        type="button">
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-code text-[11px] font-semibold ${
            solved
              ? 'border-candy-400 bg-candy-500 text-white'
              : started
              ? 'border-candy-400/70 text-candy-300'
              : 'border-plum-500 text-plum-300'
          }`}>
          {solved ? '✓' : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-bold text-white group-hover:text-candy-200">{problem.title}</span>
            <DifficultyChip difficulty={problem.difficulty} />
            {problem.concepts.map(c => (
              <ConceptChip concept={c} key={c} />
            ))}
          </span>
          <span className="mt-0.5 block text-[12px] text-plum-300">{problem.tagline}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-code text-[10.5px] text-plum-300">
            <span>
              {score.done}/{score.total} steps
            </span>
            <span>
              {score.score}/{score.max} pts
            </span>
            <span>~{problem.minutes} min</span>
            {score.accepted < score.done ? (
              <span className="text-amber-300">{score.done - score.accepted} revealed</span>
            ) : null}
          </span>
        </span>
      </button>
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
  onOpen: (id: string) => void;
}> = memo(({problems, attempts, profile, streak, badges, onOpen}) => (
  <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-5">
    <div>
      <h1 className="text-2xl font-extrabold leading-tight text-white">Build systems, step by step</h1>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-plum-200">
        Every problem is a real system cut down to the parts that matter: an HTTPS API, a gRPC call, a Kafka topic, a
        Redis key. You implement it one file at a time in Python, Go, Scala or C++; the judge checks each step, hints
        cost points, and revealing the answer costs all of them. Each problem's tutorial can be downloaded as Markdown
        from its page.
      </p>
    </div>
    <ProfileCard badges={badges} profile={profile} streak={streak} />
    <section>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-candy-400">Problems</p>
      <ul className="space-y-2">
        {problems.map((problem, i) => (
          <ProblemRow attempts={attempts} index={i} key={problem.id} onOpen={onOpen} problem={problem} />
        ))}
      </ul>
    </section>
  </div>
));
ProblemList.displayName = 'ProblemList';

export default ProblemList;
