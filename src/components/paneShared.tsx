import {type FC, memo} from 'react';

import {type Concept, type Difficulty, CONCEPT_LABEL} from '@/lib/types';

export const DIFFICULTY_CLASS: Record<Difficulty, string> = {
  easy: 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300',
  medium: 'border-amber-400/50 bg-amber-500/10 text-amber-300',
  hard: 'border-rose-400/50 bg-rose-500/10 text-rose-300',
};

export const CONCEPT_CLASS: Record<Concept, string> = {
  http: 'border-candy-400/50 bg-candy-500/10 text-candy-200',
  grpc: 'border-plum-300/50 bg-plum-400/20 text-plum-200',
  kafka: 'border-amber-400/50 bg-amber-500/10 text-amber-200',
  redis: 'border-rose-400/50 bg-rose-500/10 text-rose-200',
};

/** Solid colour per concept for bars and dots (matches the diagram palette). */
export const CONCEPT_COLOR: Record<Concept, string> = {
  http: '#ff7ac8',
  grpc: '#a78bfa',
  kafka: '#fbbf24',
  redis: '#fb7185',
};

export const DifficultyChip: FC<{difficulty: Difficulty}> = memo(({difficulty}) => (
  <span
    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${DIFFICULTY_CLASS[difficulty]}`}>
    {difficulty}
  </span>
));
DifficultyChip.displayName = 'DifficultyChip';

export const ConceptChip: FC<{concept: Concept}> = memo(({concept}) => (
  <span className={`rounded-full border px-1.5 py-0.5 font-code text-[9.5px] ${CONCEPT_CLASS[concept]}`}>
    {CONCEPT_LABEL[concept]}
  </span>
));
ConceptChip.displayName = 'ConceptChip';

export const ghostButtonClass =
  'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-plum-200 transition hover:bg-plum-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30';

export const primaryButtonClass =
  'rounded-lg bg-candy-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow transition hover:bg-candy-400 disabled:cursor-not-allowed disabled:opacity-30';

export const selectClass =
  'rounded-md border border-plum-600 bg-plum-900/80 px-2 py-1 font-code text-[11px] text-cream focus:border-candy-500 focus:outline-none focus:ring-0';

export const linkClass = 'text-candy-300 underline decoration-candy-500/50 hover:text-candy-200';
