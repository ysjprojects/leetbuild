import {type ChangeEvent, type FC, memo, useCallback, useEffect, useState} from 'react';

import {type ListQuery, type SortKey, type StatusFilter, SORTS, STATUS_LABEL} from '@/lib/catalog';
import {type Difficulty, DIFFICULTIES} from '@/lib/types';

import {selectClass} from './paneShared';

/**
 * The row above the problem list: a search box, difficulty and status chips, a company-tagged
 * toggle, the sort and its direction. Every control writes to the URL through `update`; the
 * search box keeps its own text so the caret never waits for the router.
 */

const chip = (on: boolean): string =>
  `rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
    on
      ? 'border-iris-400 bg-iris-400/15 text-iris-200'
      : 'border-ink-600 text-ink-300 hover:border-ink-500 hover:text-ink-50'
  }`;

const DIFFICULTY_LABEL: Record<Difficulty, string> = {easy: 'Easy', medium: 'Medium', hard: 'Hard'};

const Chip: FC<{on: boolean; label: string; onClick: () => void; title?: string}> = memo(
  ({on, label, onClick, title}) => (
    <button aria-pressed={on} className={chip(on)} onClick={onClick} title={title} type="button">
      {label}
    </button>
  ),
);
Chip.displayName = 'FilterChip';

const DifficultyChipButton: FC<{
  value: Difficulty | 'all';
  current: Difficulty | 'all';
  update: (p: Partial<ListQuery>) => void;
}> = memo(({value, current, update}) => {
  const onClick = useCallback(() => update({difficulty: value}), [update, value]);
  return <Chip label={value === 'all' ? 'All' : DIFFICULTY_LABEL[value]} on={current === value} onClick={onClick} />;
});
DifficultyChipButton.displayName = 'DifficultyChipButton';

const StatusChipButton: FC<{value: StatusFilter; current: StatusFilter; update: (p: Partial<ListQuery>) => void}> =
  memo(({value, current, update}) => {
    const onClick = useCallback(() => update({status: value}), [update, value]);
    return <Chip label={STATUS_LABEL[value]} on={current === value} onClick={onClick} />;
  });
StatusChipButton.displayName = 'StatusChipButton';

const SearchIcon: FC = memo(() => (
  <svg aria-hidden fill="none" height={12} stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16" width={12}>
    <circle cx={7} cy={7} r={4.5} />
    <path d="M10.5 10.5 14 14" strokeLinecap="round" />
  </svg>
));
SearchIcon.displayName = 'SearchIcon';

export const ListControls: FC<{
  query: ListQuery;
  update: (patch: Partial<ListQuery>) => void;
}> = memo(({query, update}) => {
  const [text, setText] = useState(query.q);
  // The URL changed from outside the box (Back, a shared link): follow it.
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
  const toggleCompany = useCallback(() => update({company: !query.company}), [update, query.company]);
  const onSort = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => update({sort: e.target.value as SortKey, desc: false}),
    [update],
  );
  const flip = useCallback(() => update({desc: !query.desc}), [update, query.desc]);
  const sort = SORTS.find(s => s.key === query.sort) ?? SORTS[0];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="border-ink-600 bg-ink-850 text-ink-300 focus-within:border-iris-400 flex min-w-[14rem] flex-1 items-center gap-1.5 rounded-lg border px-2.5 py-1 transition">
          <SearchIcon />
          <input
            aria-label="search courses"
            className="text-ink-50 placeholder:text-ink-500 w-full border-0 bg-transparent p-0 py-0.5 text-[12px] focus:outline-none focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
            onChange={onSearch}
            placeholder="search courses — a title, a company, a step, a concept"
            type="search"
            value={text}
          />
          {text !== '' ? (
            <button
              aria-label="clear search"
              className="text-ink-400 hover:text-ink-50 text-[12px] transition"
              onClick={clearSearch}
              type="button">
              ×
            </button>
          ) : null}
        </label>
        <span className="flex items-center gap-1 text-[11px]">
          <span className="text-ink-400">sort</span>
          <select aria-label="sort courses" className={`${selectClass} pr-7`} onChange={onSort} value={query.sort}>
            {SORTS.map(s => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            aria-label={
              query.desc
                ? 'reversed; click to restore the natural order'
                : `natural order: ${sort.blurb}; click to reverse`
            }
            className="border-ink-600 text-ink-300 hover:border-ink-500 hover:text-ink-50 font-code rounded-md border px-1.5 py-0.5 text-[11px] transition"
            onClick={flip}
            title={query.desc ? 'reversed — click to restore' : `${sort.blurb} — click to reverse`}
            type="button">
            {query.desc ? '↑' : '↓'}
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div aria-label="difficulty" className="flex flex-wrap items-center gap-1" role="group">
          <DifficultyChipButton current={query.difficulty} update={update} value="all" />
          {DIFFICULTIES.map(d => (
            <DifficultyChipButton current={query.difficulty} key={d} update={update} value={d} />
          ))}
        </div>
        <div aria-label="status" className="flex flex-wrap items-center gap-1" role="group">
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map(s => (
            <StatusChipButton current={query.status} key={s} update={update} value={s} />
          ))}
        </div>
        <Chip
          label="company-tagged"
          on={query.company}
          onClick={toggleCompany}
          title="courses derived from a company's engineering writing"
        />
      </div>
    </div>
  );
});
ListControls.displayName = 'ListControls';
