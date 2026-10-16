import {type FC, memo, useMemo} from 'react';

import {type Badge, type BadgeProgress, BADGES, TRACKS} from '@/lib/gamify';

import {CONCEPT_COLOR} from './paneShared';

/**
 * Badges as the learner sees them: a glyph disc (earned: filled in iris, or the concept colour for
 * mastery badges; locked: a thin outline), and the catalog — every badge grouped by track with its
 * progress, the closest unearned ones first in an "Up next" strip, so the list says what to do
 * rather than what has not been done.
 */

const SIZES = {sm: 'h-6 w-6 text-[9px]', md: 'h-8 w-8 text-[10px]', lg: 'h-10 w-10 text-[12px]'} as const;

export const BadgeGlyph: FC<{badge: Badge; earned: boolean; size?: keyof typeof SIZES}> = memo(
  ({badge, earned, size = 'md'}) => {
    const color = badge.concept === undefined ? undefined : CONCEPT_COLOR[badge.concept];
    return (
      <span
        aria-hidden
        className={`font-code flex shrink-0 items-center justify-center rounded-full font-bold ${SIZES[size]} ${
          earned
            ? color === undefined
              ? 'bg-iris-400 text-ink-950 ring-iris-400/25 ring-[3px]'
              : 'text-ink-950'
            : 'border-ink-600 text-ink-400 border border-dashed'
        }`}
        style={earned && color !== undefined ? {background: color} : undefined}>
        {badge.glyph}
      </span>
    );
  },
);
BadgeGlyph.displayName = 'BadgeGlyph';

const formatDay = (at: number): string => new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});

/** `3/16 Kafka steps`, `4/6 · Image Cache`, or nothing for a binary badge. */
const progressLabel = (p: BadgeProgress): string | null => {
  if (p.target <= 1) return null;
  const detail =
    p.detail === undefined
      ? ''
      : p.detail.endsWith('steps') || p.detail === 'points' || p.detail === 'days'
      ? ` ${p.detail}`
      : ` · ${p.detail}`;
  return `${p.value}/${p.target}${detail}`;
};

const BadgeRow: FC<{badge: Badge; progress: BadgeProgress; earnedAt: number | undefined}> = memo(
  ({badge, progress, earnedAt}) => {
    const earned = earnedAt !== undefined;
    const label = progressLabel(progress);
    const share = progress.target <= 1 ? (earned ? 1 : 0) : Math.min(1, progress.value / progress.target);
    const color = badge.concept === undefined ? undefined : CONCEPT_COLOR[badge.concept];
    return (
      <li className="flex items-center gap-3 py-1.5">
        <BadgeGlyph badge={badge} earned={earned} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`text-[12.5px] font-semibold ${earned ? 'text-ink-50' : 'text-ink-200'}`}>
              {badge.title}
            </span>
            <span className="font-code text-ink-400 shrink-0 text-[10.5px]">
              {earned ? `earned ${formatDay(earnedAt)}` : label ?? 'locked'}
            </span>
          </span>
          <span className="text-ink-400 block text-[11px]">{badge.blurb}</span>
          {!earned && progress.target > 1 ? (
            <span className="bg-ink-700 mt-1 block h-1 overflow-hidden rounded-full">
              <span
                className={`block h-full rounded-full ${color === undefined ? 'bg-iris-400' : ''}`}
                style={{width: `${share * 100}%`, background: color}}
              />
            </span>
          ) : null}
        </span>
      </li>
    );
  },
);
BadgeRow.displayName = 'BadgeRow';

/** Unearned badges with measurable progress, closest to completion first; binary ones follow. */
export function upNext(
  progress: Record<string, BadgeProgress>,
  earned: Record<string, number>,
  count: number,
): Badge[] {
  return BADGES.filter(b => earned[b.id] === undefined)
    .map(b => ({badge: b, share: progress[b.id].target <= 1 ? -1 : progress[b.id].value / progress[b.id].target}))
    .sort((a, b) => b.share - a.share)
    .slice(0, count)
    .map(x => x.badge);
}

export const BadgeCatalog: FC<{progress: Record<string, BadgeProgress>; earned: Record<string, number>}> = memo(
  ({progress, earned}) => {
    const next = useMemo(() => upNext(progress, earned, 3), [progress, earned]);
    return (
      <div className="space-y-4">
        {next.length > 0 ? (
          <section className="border-iris-400/30 bg-iris-400/5 rounded-lg border px-3 py-2">
            <p className="text-iris-300 text-[10.5px] font-bold uppercase tracking-wider">Up next</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {next.map(b => (
                <li className="text-ink-200 flex items-center gap-1.5 text-[12px]" key={b.id}>
                  <BadgeGlyph badge={b} earned={false} size="sm" />
                  <span className="font-semibold">{b.title}</span>
                  {progressLabel(progress[b.id]) !== null ? (
                    <span className="font-code text-ink-400 text-[10.5px]">{progressLabel(progress[b.id])}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {TRACKS.map(track => (
          <section key={track.id}>
            <p className="flex items-baseline justify-between">
              <span className="text-ink-100 text-[12px] font-bold">{track.title}</span>
              <span className="text-ink-400 text-[11px]">{track.blurb}</span>
            </p>
            <ul className="divide-ink-700/70 mt-0.5 divide-y">
              {BADGES.filter(b => b.track === track.id).map(badge => (
                <BadgeRow badge={badge} earnedAt={earned[badge.id]} key={badge.id} progress={progress[badge.id]} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  },
);
BadgeCatalog.displayName = 'BadgeCatalog';
