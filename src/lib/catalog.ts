/**
 * The problem list's search, filters and sort, as pure functions over a `ListQuery` — the same
 * shape the landing page keeps in its URL (`/?q=redis&difficulty=hard&status=started&sort=points`),
 * so a filtered view is a link. Rows keep their catalogue number whatever the order on screen.
 */
import {type StepAttempt, problemScore, STEP_POINTS} from './scoring';
import {type Difficulty, type Problem, CONCEPT_LABEL, DIFFICULTIES} from './types';

export type StatusFilter = 'all' | 'open' | 'started' | 'solved';
export type SortKey = 'order' | 'difficulty' | 'points' | 'minutes' | 'progress' | 'title';

export interface ListQuery {
  /** Free text; every word must appear somewhere in the course. */
  q: string;
  difficulty: Difficulty | 'all';
  status: StatusFilter;
  /** Only company-tagged courses. */
  company: boolean;
  sort: SortKey;
  /** Reverse the sort's natural direction. */
  desc: boolean;
}

export const DEFAULT_LIST_QUERY: ListQuery = {
  q: '',
  difficulty: 'all',
  status: 'all',
  company: false,
  sort: 'order',
  desc: false,
};

export const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  open: 'Not started',
  started: 'In progress',
  solved: 'Solved',
};

/** Sort keys with the direction that reads naturally: hardest, richest and furthest first; shortest and A first. */
export const SORTS: readonly {key: SortKey; label: string; blurb: string}[] = [
  {key: 'order', label: 'Catalogue', blurb: 'the order the courses are taught in'},
  {key: 'difficulty', label: 'Difficulty', blurb: 'easy → hard'},
  {key: 'points', label: 'Points', blurb: 'most points first'},
  {key: 'minutes', label: 'Estimate', blurb: 'shortest first'},
  {key: 'progress', label: 'Progress', blurb: 'furthest along first'},
  {key: 'title', label: 'Title', blurb: 'A → Z'},
];

export function problemStatus(problem: Problem, attempts: Record<string, StepAttempt>): Exclude<StatusFilter, 'all'> {
  const score = problemScore(problem, attempts);
  return score.done === score.total ? 'solved' : score.done > 0 ? 'started' : 'open';
}

/** Words of the query, lower-cased; an empty query has none and matches everything. */
const tokens = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t !== '');

/** Everything a search may hit: title, tagline, id, difficulty, concepts, company, step titles. */
const haystack = (problem: Problem): string =>
  [
    problem.title,
    problem.tagline,
    problem.id,
    problem.difficulty,
    ...problem.concepts.map(c => CONCEPT_LABEL[c]),
    problem.company?.name ?? '',
    ...problem.steps.map(s => s.title),
  ]
    .join('\n')
    .toLowerCase();

export function matchesSearch(problem: Problem, q: string): boolean {
  const words = tokens(q);
  if (words.length === 0) return true;
  const text = haystack(problem);
  return words.every(w => text.includes(w));
}

const DIFFICULTY_RANK: Record<Difficulty, number> = Object.fromEntries(DIFFICULTIES.map((d, i) => [d, i])) as Record<
  Difficulty,
  number
>;

/** The problems `query` keeps, in the order it asks for; `problems` is the catalogue and decides ties. */
export function applyListQuery(
  problems: readonly Problem[],
  attempts: Record<string, StepAttempt>,
  query: ListQuery,
): Problem[] {
  const order = new Map(problems.map((p, i) => [p.id, i]));
  const kept = problems.filter(
    p =>
      (query.difficulty === 'all' || p.difficulty === query.difficulty) &&
      (query.status === 'all' || problemStatus(p, attempts) === query.status) &&
      (!query.company || p.company !== undefined) &&
      matchesSearch(p, query.q),
  );
  const byOrder = (a: Problem, b: Problem): number => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const natural = (a: Problem, b: Problem): number => {
    switch (query.sort) {
      case 'difficulty':
        return DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty];
      case 'points':
        return STEP_POINTS[b.difficulty] * b.steps.length - STEP_POINTS[a.difficulty] * a.steps.length;
      case 'minutes':
        return a.minutes - b.minutes;
      case 'progress': {
        const sa = problemScore(a, attempts);
        const sb = problemScore(b, attempts);
        return sb.done / sb.total - sa.done / sa.total || sb.done - sa.done;
      }
      case 'title':
        return a.title.localeCompare(b.title);
      default:
        return 0;
    }
  };
  return kept.sort((a, b) => {
    const n = natural(a, b);
    if (n !== 0) return query.desc ? -n : n;
    return query.sort === 'order' && query.desc ? byOrder(b, a) : byOrder(a, b);
  });
}

export const isDefaultQuery = (query: ListQuery): boolean =>
  query.q === '' && query.difficulty === 'all' && query.status === 'all' && !query.company;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The query a URL carries; anything missing or malformed is the default. */
export function parseListQuery(params: Record<string, string | string[] | undefined>): ListQuery {
  const difficulty = one(params.difficulty);
  const status = one(params.status);
  const sort = one(params.sort);
  return {
    q: one(params.q) ?? '',
    difficulty: (DIFFICULTIES as readonly string[]).includes(difficulty ?? '') ? (difficulty as Difficulty) : 'all',
    status: status !== undefined && status in STATUS_LABEL && status !== 'all' ? (status as StatusFilter) : 'all',
    company: one(params.company) === '1',
    sort: SORTS.some(s => s.key === sort) ? (sort as SortKey) : 'order',
    desc: one(params.desc) === '1',
  };
}

/** Only what differs from the defaults, so the plain landing URL stays `/`. */
export function serializeListQuery(query: ListQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.q.trim() !== '') params.q = query.q.trim();
  if (query.difficulty !== 'all') params.difficulty = query.difficulty;
  if (query.status !== 'all') params.status = query.status;
  if (query.company) params.company = '1';
  if (query.sort !== 'order') params.sort = query.sort;
  if (query.desc) params.desc = '1';
  return params;
}
