import {type FC, memo} from 'react';

import {type Concept, type Difficulty, CONCEPT_LABEL} from '@/lib/types';
import {concept} from '@/styles/palette';

/** Difficulty is a level, not a tag: a solid badge with 1–3 bars, unlike the outlined concept pills. */
export const DIFFICULTY_CLASS: Record<Difficulty, string> = {
  easy: 'bg-success-400 text-ink-950',
  medium: 'bg-warning-400 text-ink-950',
  hard: 'bg-danger-400 text-ink-950',
};

const DIFFICULTY_LEVEL: Record<Difficulty, number> = {easy: 1, medium: 2, hard: 3};

export const CONCEPT_CLASS: Record<Concept, string> = {
  http: 'border-concept-http/50 bg-concept-http/10 text-concept-http',
  grpc: 'border-concept-grpc/50 bg-concept-grpc/10 text-concept-grpc',
  kafka: 'border-concept-kafka/50 bg-concept-kafka/10 text-concept-kafka',
  redis: 'border-concept-redis/50 bg-concept-redis/10 text-concept-redis',
};

/** Solid colour per concept for bars and dots (the diagram palette). */
export const CONCEPT_COLOR: Record<Concept, string> = concept;

export const DifficultyChip: FC<{difficulty: Difficulty}> = memo(({difficulty}) => {
  const level = DIFFICULTY_LEVEL[difficulty];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${DIFFICULTY_CLASS[difficulty]}`}>
      <svg aria-hidden fill="currentColor" height={8} viewBox="0 0 10 8" width={10}>
        <rect height={3} rx={0.5} width={2.5} x={0} y={5} />
        <rect height={5.5} opacity={level >= 2 ? 1 : 0.3} rx={0.5} width={2.5} x={3.75} y={2.5} />
        <rect height={8} opacity={level >= 3 ? 1 : 0.3} rx={0.5} width={2.5} x={7.5} y={0} />
      </svg>
      {difficulty}
    </span>
  );
});
DifficultyChip.displayName = 'DifficultyChip';

export const ConceptChip: FC<{concept: Concept}> = memo(({concept}) => (
  <span className={`font-code rounded-full border px-1.5 py-0.5 text-[9.5px] ${CONCEPT_CLASS[concept]}`}>
    {CONCEPT_LABEL[concept]}
  </span>
));
ConceptChip.displayName = 'ConceptChip';

export const ghostButtonClass =
  'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-ink-200 transition hover:bg-ink-800 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-30';

export const primaryButtonClass =
  'rounded-lg bg-iris-400 px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition hover:bg-iris-300 disabled:cursor-not-allowed disabled:opacity-30';

export const selectClass =
  'rounded-md border border-ink-600 bg-ink-800 px-2 py-1 font-code text-[11px] text-ink-100 focus:border-iris-400 focus:outline-none focus:ring-0';

export const linkClass = 'text-iris-300 underline decoration-iris-400/50 hover:text-iris-200';
