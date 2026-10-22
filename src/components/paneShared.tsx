import {type FC, memo} from 'react';

import {
  type Company,
  type Concept,
  type Difficulty,
  type Language,
  CONCEPT_LABEL,
  LANGUAGE_LABEL,
  LANGUAGES,
} from '@/lib/types';
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
  pytorch: 'border-concept-pytorch/50 bg-concept-pytorch/10 text-concept-pytorch',
  cuda: 'border-concept-cuda/50 bg-concept-cuda/10 text-concept-cuda',
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
  <span className={`font-code rounded-full border px-1.5 py-0.5 text-[10px] ${CONCEPT_CLASS[concept]}`}>
    {CONCEPT_LABEL[concept]}
  </span>
));
ConceptChip.displayName = 'ConceptChip';

/** The company's logo, in the colours its brand guidelines use (see `src/data/companies.ts`). */
export const CompanyMark: FC<{company: Company; size?: 'sm' | 'lg'}> = memo(({company, size = 'sm'}) => {
  const {path, fill, tile, cutout} = company.logo;
  const px = size === 'lg' ? 36 : 14;
  return (
    <svg aria-hidden className="shrink-0" height={px} viewBox="0 0 24 24" width={px}>
      {tile !== undefined ? <rect fill={tile} height={24} rx={5.5} width={24} /> : null}
      {cutout !== undefined ? <circle cx={12} cy={12} fill={cutout} r={11} /> : null}
      <path d={path} fill={fill} transform={tile !== undefined ? 'translate(4.5 4.5) scale(0.625)' : undefined} />
    </svg>
  );
});
CompanyMark.displayName = 'CompanyMark';

/** "Company tagged": the company's logo and name, outlined like the concept pills. */
export const CompanyChip: FC<{company: Company}> = memo(({company}) => (
  <span
    className="border-ink-500 text-ink-100 inline-flex items-center gap-1 rounded-full border py-0.5 pl-1 pr-1.5 text-[10px] font-semibold"
    title={`company tagged: derived from the ${company.publication}`}>
    <CompanyMark company={company} />
    {company.name}
  </span>
));
CompanyChip.displayName = 'CompanyChip';

export const ghostButtonClass =
  'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-ink-200 transition hover:bg-ink-800 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-30';

export const primaryButtonClass =
  'rounded-lg bg-iris-400 px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition hover:bg-iris-300 disabled:cursor-not-allowed disabled:opacity-30';

const languageOption = (language: Language): {value: Language; label: string} => ({
  value: language,
  label: LANGUAGE_LABEL[language],
});

/** The five languages as `Select` options, shared by every language picker. */
export const LANGUAGE_OPTIONS = LANGUAGES.map(languageOption);

export const linkClass = 'text-iris-300 underline decoration-iris-400/50 hover:text-iris-200';
