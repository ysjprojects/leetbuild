import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useState} from 'react';

import {danger, ink, iris} from '@/styles/palette';

import WidgetFrame, {clamp, numParam, RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
const COLUMNS = 25;
const CELL = 14;
const GAP = 2;
const BUCKETS = 10_000;
const VARIANTS = ['RED_BUTTON', 'BLUE_BUTTON', 'CONTROL'] as const;
type Variant = (typeof VARIANTS)[number];

const COLOR: Record<Variant, string> = {RED_BUTTON: danger[400], BLUE_BUTTON: iris[400], CONTROL: ink[600]};

const INPUT_CLASS =
  'w-28 rounded-md border border-ink-600 bg-ink-900 px-2 py-0.5 font-code text-[11px] text-ink-100 focus:border-iris-400 focus:ring-0';

/** 32-bit FNV-1a. Stormcrow hashes with SHA-256; any stable hash gives the same property, this one fits in a widget. */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** The step's rule: shares own consecutive runs of buckets in a fixed order, so a bigger share only moves its edge. */
const pick = (bucket: number, red: number, blue: number): Variant => {
  if (bucket < red * 100) return 'RED_BUTTON';
  if (bucket < (red + blue) * 100) return 'BLUE_BUTTON';
  return 'CONTROL';
};

interface Assignment {
  variants: Variant[];
  previous: Variant[] | null;
}

const PercentRollout: FC<WidgetProps> = memo(({params}) => {
  const users = Math.round(clamp(numParam(params, 'users', 200), 50, 400));
  const [red, setRed] = useState(10);
  const [blue, setBlue] = useState(30);
  const [seed, setSeed] = useState('button_color');
  const [mode, setMode] = useState<'hash' | 'random'>('hash');
  const [generation, setGeneration] = useState(0);
  const [assignment, setAssignment] = useState<Assignment>({variants: [], previous: null});

  const ids = useMemo(() => Array.from({length: users}, (_, i) => `user-${i + 1}`), [users]);

  useEffect(() => {
    const variants = ids.map(id =>
      pick(mode === 'hash' ? fnv1a(`${seed}:${id}`) % BUCKETS : Math.floor(Math.random() * BUCKETS), red, blue),
    );
    setAssignment(a => ({variants, previous: a.variants.length === variants.length ? a.variants : null}));
  }, [ids, mode, seed, red, blue, generation]);

  const onRed = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    setRed(next);
    setBlue(b => Math.min(b, 100 - next));
  }, []);
  const onBlue = useCallback((e: ChangeEvent<HTMLInputElement>) => setBlue(Number(e.target.value)), []);
  const onSeed = useCallback((e: ChangeEvent<HTMLInputElement>) => setSeed(e.target.value || 'button_color'), []);
  const useHash = useCallback(() => setMode('hash'), []);
  const useRandom = useCallback(() => setMode('random'), []);
  const onAgain = useCallback(() => setGeneration(g => g + 1), []);

  const {variants, previous} = assignment;
  const counts = useMemo(
    () => Object.fromEntries(VARIANTS.map(v => [v, variants.filter(x => x === v).length])) as Record<Variant, number>,
    [variants],
  );
  const churn = useMemo(() => {
    if (previous === null) return null;
    let changed = 0;
    let joinedRed = 0;
    let leftRed = 0;
    variants.forEach((v, i) => {
      if (v !== previous[i]) changed += 1;
      if (v === 'RED_BUTTON' && previous[i] !== 'RED_BUTTON') joinedRed += 1;
      if (v !== 'RED_BUTTON' && previous[i] === 'RED_BUTTON') leftRed += 1;
    });
    return {changed, joinedRed, leftRed};
  }, [previous, variants]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span style={{color: COLOR.RED_BUTTON}}>RED</span>
          <input
            aria-label="RED_BUTTON share"
            className={RANGE_CLASS}
            max={100}
            min={0}
            onChange={onRed}
            type="range"
            value={red}
          />
          <span className="font-code w-7 text-right">{red}%</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span style={{color: COLOR.BLUE_BUTTON}}>BLUE</span>
          <input
            aria-label="BLUE_BUTTON share"
            className={RANGE_CLASS}
            max={100 - red}
            min={0}
            onChange={onBlue}
            type="range"
            value={blue}
          />
          <span className="font-code w-7 text-right">{blue}%</span>
        </label>
        <input
          aria-label="seed"
          className={INPUT_CLASS}
          defaultValue={seed}
          onChange={onSeed}
          spellCheck={false}
          type="text"
        />
        <button className={tabClass(mode === 'hash')} onClick={useHash} type="button">
          hash(seed:user)
        </button>
        <button className={tabClass(mode === 'random')} onClick={useRandom} type="button">
          coin toss
        </button>
        <button className={BUTTON_CLASS} onClick={onAgain} type="button">
          evaluate again
        </button>
      </>
    ),
    [blue, mode, onAgain, onBlue, onRed, onSeed, red, seed, useHash, useRandom],
  );

  const readout = useMemo(() => {
    const control = 100 - red - blue;
    const split = `${counts.RED_BUTTON} red · ${counts.BLUE_BUTTON} blue · ${counts.CONTROL} control of ${users} users (shares ${red} / ${blue} / ${control}).`;
    if (churn === null)
      return `${split} Move a slider: with the hash, a bigger share only recolours the users at its edge.`;
    if (mode === 'random') {
      return `${split} ${churn.changed} users changed variant on this evaluation — a coin toss reassigns people every time they load the page; nothing you can roll out, measure or roll back.`;
    }
    if (churn.changed === 0)
      return `${split} Nothing moved: the same seed and user always hash to the same bucket, on every server, forever.`;
    return (
      <>
        {split} <b className="text-ink-100">{churn.changed}</b> users changed: {churn.joinedRed} joined RED,{' '}
        {churn.leftRed} left it. Shares are cumulative edges in a fixed order — RED owns buckets 0–{red * 100 - 1}, BLUE
        the next {blue * 100} — so growing a share keeps everyone it already had.
      </>
    );
  }, [blue, churn, counts, mode, red, users]);

  const rows = Math.ceil(users / COLUMNS);
  const width = COLUMNS * (CELL + GAP) + GAP;
  const height = rows * (CELL + GAP) + GAP;

  return (
    <WidgetFrame controls={controls} readout={readout} title="percentage rollout: a stateless hash versus a coin toss">
      <svg className="mx-auto block max-w-full" role="img" style={{maxHeight: 260}} viewBox={`0 0 ${width} ${height}`}>
        <title>{`${users} users coloured by the variant they are assigned`}</title>
        {variants.map((v, i) => {
          const x = GAP + (i % COLUMNS) * (CELL + GAP);
          const y = GAP + Math.floor(i / COLUMNS) * (CELL + GAP);
          const moved = previous !== null && previous[i] !== v;
          return (
            <rect
              fill={COLOR[v]}
              height={CELL}
              key={ids[i]}
              rx={3}
              stroke={moved ? ink[50] : 'none'}
              strokeWidth={moved ? 1.5 : 0}
              width={CELL}
              x={x}
              y={y}>
              <title>{`${ids[i]} → ${v}${
                mode === 'hash' ? ` (bucket ${fnv1a(`${seed}:${ids[i]}`) % BUCKETS})` : ''
              }`}</title>
            </rect>
          );
        })}
        {variants.length === 0 ? (
          <text fill={ink[300]} fontFamily={MONO} fontSize={10} x={GAP} y={14}>
            assigning…
          </text>
        ) : null}
      </svg>
    </WidgetFrame>
  );
});
PercentRollout.displayName = 'PercentRollout';

export default PercentRollout;
