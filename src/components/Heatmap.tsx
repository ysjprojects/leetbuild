import {type FC, memo, useMemo} from 'react';

import {type Streak, dayKey} from '@/lib/gamify';

/**
 * A year of accepted steps as a calendar: one cell per day, weeks as columns ending with this one,
 * Monday at the top, the tone rising with the count. Plain SVG in palette tokens, so both themes
 * draw it; the summary line carries the numbers the picture only suggests.
 */

const CELL = 10;
const GAP = 2;
const STEP = CELL + GAP;
const WEEKS = 53;
const LEFT = 26;
const TOP = 14;
const WEEKDAY: Record<number, string> = {0: 'Mon', 2: 'Wed', 4: 'Fri'};

const parseDay = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Monday-first weekday index. */
const weekday = (date: Date): number => (date.getDay() + 6) % 7;

const tone = (count: number): string =>
  count === 0 ? 'fill-ink-700' : count === 1 ? 'fill-iris-400/35' : count === 2 ? 'fill-iris-400/65' : 'fill-iris-400';

interface Cell {
  key: string;
  count: number;
  column: number;
  row: number;
  label: string;
}

export const ActivityHeatmap: FC<{days: Record<string, number>; today: string; streak: Streak}> = memo(
  ({days, today, streak}) => {
    const {cells, months, yearTotal} = useMemo(() => {
      const end = parseDay(today);
      // The first column holds the Monday 52 weeks before this week's.
      const start = new Date(end);
      start.setDate(end.getDate() - weekday(end) - 7 * (WEEKS - 1));
      const cells: Cell[] = [];
      const months: {column: number; label: string}[] = [];
      let yearTotal = 0;
      let lastMonth = -1;
      for (let i = 0, cursor = new Date(start); cursor <= end; i++, cursor.setDate(cursor.getDate() + 1)) {
        const key = dayKey(cursor);
        const count = days[key] ?? 0;
        yearTotal += count;
        const column = Math.floor(i / 7);
        const row = weekday(cursor);
        if (row === 0 && cursor.getMonth() !== lastMonth) {
          // Name a month at the column that starts it; skip a label that would collide with the previous one.
          if (months.length === 0 || column - months[months.length - 1].column >= 3)
            months.push({column, label: cursor.toLocaleDateString(undefined, {month: 'short'})});
          lastMonth = cursor.getMonth();
        }
        cells.push({
          key,
          count,
          column,
          row,
          label: `${
            count === 0 ? 'nothing accepted' : `${count} step${count === 1 ? '' : 's'} accepted`
          } · ${cursor.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}`,
        });
      }
      return {cells, months, yearTotal};
    }, [days, today]);
    const activeDays = Object.values(days).filter(n => n > 0).length;
    const width = LEFT + WEEKS * STEP;
    const height = TOP + 7 * STEP;
    return (
      <div>
        <p className="text-ink-300 mb-1.5 text-[12px]">
          <span className="font-code text-ink-100">{yearTotal}</span> step{yearTotal === 1 ? '' : 's'} accepted in the
          past year · <span className="font-code text-ink-100">{activeDays}</span> active day
          {activeDays === 1 ? '' : 's'} · best streak <span className="font-code text-ink-100">{streak.best}</span>
        </p>
        <div className="overflow-x-auto">
          <svg
            aria-label="accepted steps per day over the past year"
            className="block"
            height={height}
            role="img"
            viewBox={`0 0 ${width} ${height}`}
            width={width}>
            {months.map(m => (
              <text
                className="fill-ink-400 text-[9px]"
                key={`${m.label}-${m.column}`}
                x={LEFT + m.column * STEP}
                y={TOP - 5}>
                {m.label}
              </text>
            ))}
            {Object.entries(WEEKDAY).map(([row, label]) => (
              <text
                className="fill-ink-400 text-[9px]"
                dominantBaseline="middle"
                key={label}
                x={0}
                y={TOP + Number(row) * STEP + CELL / 2}>
                {label}
              </text>
            ))}
            {cells.map(c => (
              <rect
                className={tone(c.count)}
                height={CELL}
                key={c.key}
                rx={2}
                width={CELL}
                x={LEFT + c.column * STEP}
                y={TOP + c.row * STEP}>
                <title>{c.label}</title>
              </rect>
            ))}
          </svg>
        </div>
      </div>
    );
  },
);
ActivityHeatmap.displayName = 'ActivityHeatmap';
