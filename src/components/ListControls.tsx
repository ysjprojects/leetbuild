import {
  type ChangeEvent,
  type FC,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type ListQuery,
  type SortKey,
  type StatusFilter,
  type TrackFilter,
  DEFAULT_LIST_QUERY,
  isDefaultQuery,
  SORTS,
  STATUS_LABEL,
  TRACKS,
} from '@/lib/catalog';
import {type Difficulty, DIFFICULTIES} from '@/lib/types';

/**
 * The rows above the problem list, LeetCode-style: a row of track tabs (All topics · Systems · AI
 * era, each with its icon; the active one is inverted), then a search pill, a sort menu and a
 * filter menu behind two round buttons (a dot marks one that is in effect), and at the right how
 * many courses of the track are solved — or, while filtering, how many rows match and the way out.
 * Every control writes to the URL through `update`; the search box keeps its own text so the caret
 * never waits for the router.
 */

const DIFFICULTY_LABEL: Record<Difficulty, string> = {easy: 'Easy', medium: 'Medium', hard: 'Hard'};

const iconButton = (open: boolean): string =>
  `relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
    open ? 'bg-ink-700 text-ink-50' : 'bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-50'
  }`;

const chip = (on: boolean): string =>
  `rounded-full px-3 py-1 text-[12px] font-semibold transition ${
    on ? 'bg-iris-400 text-ink-950' : 'bg-ink-700/70 text-ink-200 hover:bg-ink-600 hover:text-ink-50'
  }`;

const SearchIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={14} stroke="currentColor" strokeWidth={1.7} viewBox="0 0 16 16" width={14}>
    <circle cx={7} cy={7} r={4.5} />
    <path d="M10.5 10.5 14 14" strokeLinecap="round" />
  </svg>
));
SearchIcon.displayName = 'SearchIcon';

const SortIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={14} stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16" width={14}>
    <path d="M5 2.5v11M5 13.5 2.5 11M5 13.5 7.5 11" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11 13.5v-11M11 2.5 8.5 5M11 2.5l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
));
SortIcon.displayName = 'SortIcon';

const FilterIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={14} stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16" width={14}>
    <path d="M2 3h12l-4.5 5.5V13l-3 1V8.5L2 3Z" strokeLinejoin="round" />
  </svg>
));
FilterIcon.displayName = 'FilterIcon';

/** All topics: an archive box, as LeetCode draws it. */
const AllTopicsIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={15} stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16" width={15}>
    <rect height={3} rx={0.8} width={13} x={1.5} y={2.5} />
    <path d="M2.75 5.5v7a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-7M6.5 8.5h3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
));
AllTopicsIcon.displayName = 'AllTopicsIcon';

/** Systems: a server rack. */
const SystemsIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={15} stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16" width={15}>
    <rect height={4} rx={1} width={12} x={2} y={2.5} />
    <rect height={4} rx={1} width={12} x={2} y={9.5} />
    <path d="M4.75 4.5h.01M4.75 11.5h.01" strokeLinecap="round" strokeWidth={2.2} />
  </svg>
));
SystemsIcon.displayName = 'SystemsIcon';

/** AI era: sparkles. */
const AiEraIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={15} stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 16" width={15}>
    <path
      d="M6.5 2.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4Z"
      strokeLinejoin="round"
    />
    <path d="M12 9.5c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2Z" strokeLinejoin="round" />
  </svg>
));
AiEraIcon.displayName = 'AiEraIcon';

/** The icon and the colour it keeps while its tab is not selected (an inverted tab takes the text colour). */
const TRACK_ICON: Record<TrackFilter, {icon: FC; tint: string}> = {
  all: {icon: AllTopicsIcon, tint: 'text-ink-100'},
  systems: {icon: SystemsIcon, tint: 'text-warning-300'},
  ai: {icon: AiEraIcon, tint: 'text-iris-300'},
};

const TrackTab: FC<{value: TrackFilter; label: string; current: TrackFilter; update: (p: Partial<ListQuery>) => void}> =
  memo(({value, label, current, update}) => {
    const on = value === current;
    const {icon: Icon, tint} = TRACK_ICON[value];
    const onClick = useCallback(() => update({track: value}), [update, value]);
    return (
      <button
        aria-pressed={on}
        className={`flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition ${
          on ? 'bg-ink-50 text-ink-950' : 'bg-ink-800 text-ink-100 hover:bg-ink-700 hover:text-ink-50'
        }`}
        onClick={onClick}
        type="button">
        <span className={on ? '' : tint}>
          <Icon />
        </span>
        {label}
      </button>
    );
  });
TrackTab.displayName = 'TrackTab';

/** A small dot on a button whose setting is in effect. */
const Dot: FC = memo(() => (
  <span aria-hidden className="bg-iris-400 ring-ink-900 absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ring-2" />
));
Dot.displayName = 'ActiveDot';

/**
 * A round button and the panel it opens under itself. Closes on a click outside or Escape;
 * `closeOn` increments to close it from inside (a single-choice menu after a pick).
 */
const Menu: FC<{label: string; icon: 'sort' | 'filter'; active: boolean; closeOn: number; children: ReactNode}> = memo(
  ({label, icon, active, closeOn, children}) => {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const toggle = useCallback(() => setOpen(o => !o), []);
    useEffect(() => setOpen(false), [closeOn]);
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (e: MouseEvent): void => {
        if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      };
    }, [open]);
    return (
      <div className="relative" ref={root}>
        <button
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={label}
          className={iconButton(open)}
          onClick={toggle}
          title={label}
          type="button">
          {icon === 'sort' ? <SortIcon /> : <FilterIcon />}
          {active ? <Dot /> : null}
        </button>
        {open ? (
          <div className="border-ink-600 bg-ink-800 absolute left-0 top-full z-20 mt-1.5 min-w-[15rem] rounded-xl border p-2 shadow-2xl">
            {children}
          </div>
        ) : null}
      </div>
    );
  },
);
Menu.displayName = 'ToolbarMenu';

const SortOption: FC<{
  sortKey: SortKey;
  label: string;
  blurb: string;
  query: ListQuery;
  update: (p: Partial<ListQuery>) => void;
  onPicked: () => void;
}> = memo(({sortKey, label, blurb, query, update, onPicked}) => {
  const current = query.sort === sortKey;
  const onClick = useCallback(() => {
    // Picking the current sort again turns it around; another sort starts in its natural direction.
    update(current ? {desc: !query.desc} : {sort: sortKey, desc: false});
    onPicked();
  }, [current, query.desc, sortKey, update, onPicked]);
  return (
    <button
      aria-pressed={current}
      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left transition ${
        current ? 'bg-ink-700 text-ink-50' : 'text-ink-200 hover:bg-ink-700/70 hover:text-ink-50'
      }`}
      onClick={onClick}
      title={current ? 'click again to reverse' : blurb}
      type="button">
      <span className="text-[12px] font-semibold">{label}</span>
      <span className="font-code text-ink-400 text-[11px]">{current ? (query.desc ? '↑ reversed' : '↓') : blurb}</span>
    </button>
  );
});
SortOption.displayName = 'SortOption';

const FilterChip: FC<{on: boolean; label: string; onClick: () => void}> = memo(({on, label, onClick}) => (
  <button aria-pressed={on} className={chip(on)} onClick={onClick} type="button">
    {label}
  </button>
));
FilterChip.displayName = 'FilterChip';

const DifficultyChipButton: FC<{
  value: Difficulty | 'all';
  current: Difficulty | 'all';
  update: (p: Partial<ListQuery>) => void;
}> = memo(({value, current, update}) => {
  const onClick = useCallback(() => update({difficulty: value}), [update, value]);
  return (
    <FilterChip label={value === 'all' ? 'All' : DIFFICULTY_LABEL[value]} on={current === value} onClick={onClick} />
  );
});
DifficultyChipButton.displayName = 'DifficultyChipButton';

const StatusChipButton: FC<{value: StatusFilter; current: StatusFilter; update: (p: Partial<ListQuery>) => void}> =
  memo(({value, current, update}) => {
    const onClick = useCallback(() => update({status: value}), [update, value]);
    return <FilterChip label={STATUS_LABEL[value]} on={current === value} onClick={onClick} />;
  });
StatusChipButton.displayName = 'StatusChipButton';

const FilterRow: FC<{label: string; children: ReactNode}> = memo(({label, children}) => (
  <div className="px-1 py-1.5">
    <p className="text-ink-400 mb-1.5 text-[11px] font-bold uppercase tracking-wider">{label}</p>
    <div className="flex flex-wrap gap-1">{children}</div>
  </div>
));
FilterRow.displayName = 'FilterRow';

const RING = {size: 18, stroke: 2.5};

/** Solved courses as a small ring beside the count, as LeetCode draws it. */
const SolvedRing: FC<{share: number}> = memo(({share}) => {
  const r = (RING.size - RING.stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg aria-hidden className="shrink-0 -rotate-90" height={RING.size} width={RING.size}>
      <circle
        className="stroke-ink-700"
        cx={RING.size / 2}
        cy={RING.size / 2}
        fill="none"
        r={r}
        strokeWidth={RING.stroke}
      />
      <circle
        className="stroke-iris-400"
        cx={RING.size / 2}
        cy={RING.size / 2}
        fill="none"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - share)}
        strokeLinecap="round"
        strokeWidth={RING.stroke}
      />
    </svg>
  );
});
SolvedRing.displayName = 'SolvedRing';

export const ListControls: FC<{
  query: ListQuery;
  update: (patch: Partial<ListQuery>) => void;
  reset: () => void;
  /** Rows the query keeps, of the courses in the selected track. */
  shown: number;
  total: number;
  solved: number;
}> = memo(({query, update, reset, shown, total, solved}) => {
  const [text, setText] = useState(query.q);
  // The URL changed from outside the box (a shared link, Back): follow it.
  useEffect(() => setText(query.q), [query.q]);
  const onSearch = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value);
      update({q: e.target.value});
    },
    [update],
  );
  const clearSearch = useCallback(() => {
    setText('');
    update({q: ''});
  }, [update]);
  const [sortPicked, setSortPicked] = useState(0);
  const onSortPicked = useCallback(() => setSortPicked(n => n + 1), []);
  const toggleCompany = useCallback(() => update({company: !query.company}), [update, query.company]);
  const clearFilters = useCallback(() => update({difficulty: 'all', status: 'all', company: false}), [update]);
  const filtering = useMemo(() => !isDefaultQuery(query), [query]);
  const filtersSet = query.difficulty !== 'all' || query.status !== 'all' || query.company;
  const sortSet = query.sort !== DEFAULT_LIST_QUERY.sort || query.desc;
  return (
    <div className="space-y-3">
      <div aria-label="track" className="flex flex-wrap items-center gap-2" role="group">
        {TRACKS.map(t => (
          <TrackTab current={query.track} key={t.key} label={t.label} update={update} value={t.key} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="bg-ink-800 text-ink-400 focus-within:bg-ink-700 flex h-10 w-full items-center gap-2 rounded-full px-4 transition sm:w-80">
          <SearchIcon />
          <input
            aria-label="search courses"
            className="text-ink-50 placeholder:text-ink-400 w-full border-0 bg-transparent p-0 text-[13px] focus:outline-none focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
            onChange={onSearch}
            placeholder="Search courses"
            type="search"
            value={text}
          />
          {text !== '' ? (
            <button
              aria-label="clear search"
              className="hover:text-ink-50 text-[13px] transition"
              onClick={clearSearch}
              type="button">
              ×
            </button>
          ) : null}
        </label>
        <Menu active={sortSet} closeOn={sortPicked} icon="sort" label="sort">
          {SORTS.map(s => (
            <SortOption
              blurb={s.blurb}
              key={s.key}
              label={s.label}
              onPicked={onSortPicked}
              query={query}
              sortKey={s.key}
              update={update}
            />
          ))}
        </Menu>
        <Menu active={filtersSet} closeOn={0} icon="filter" label="filter">
          <FilterRow label="Difficulty">
            <DifficultyChipButton current={query.difficulty} update={update} value="all" />
            {DIFFICULTIES.map(d => (
              <DifficultyChipButton current={query.difficulty} key={d} update={update} value={d} />
            ))}
          </FilterRow>
          <FilterRow label="Status">
            {(Object.keys(STATUS_LABEL) as StatusFilter[]).map(s => (
              <StatusChipButton current={query.status} key={s} update={update} value={s} />
            ))}
          </FilterRow>
          <FilterRow label="Source">
            <FilterChip label="All" on={!query.company} onClick={toggleCompany} />
            <FilterChip label="Company-tagged" on={query.company} onClick={toggleCompany} />
          </FilterRow>
          {filtersSet ? (
            <div className="border-ink-700 mt-1 border-t px-1 pt-2">
              <button
                className="text-iris-300 hover:text-iris-200 text-[11px] transition"
                onClick={clearFilters}
                type="button">
                clear filters
              </button>
            </div>
          ) : null}
        </Menu>
        <span className="ml-auto flex items-center gap-2 text-[13px]">
          {filtering ? (
            <>
              <span className="text-ink-300">
                <span className="font-code text-ink-100">{shown}</span> of {total}
              </span>
              <button
                className="text-iris-300 hover:text-iris-200 text-[12px] transition"
                onClick={reset}
                type="button">
                clear
              </button>
            </>
          ) : (
            <span className="text-ink-300 flex items-center gap-1.5" title="courses with every step accepted">
              <SolvedRing share={total === 0 ? 0 : solved / total} />
              <span>
                <span className="font-code text-ink-100">
                  {solved}/{total}
                </span>{' '}
                solved
              </span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
});
ListControls.displayName = 'ListControls';
