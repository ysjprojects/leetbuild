import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WARP = 32;
const BANKS = 32;
const LEFT = 48;
const WIDTH = 600;
const LANE = (WIDTH - LEFT - 8) / WARP;
const THREAD_Y = 34;
const THREAD_H = 14;
const BANK_Y = 112;
const BANK_H = 20;
const HEIGHT = 164;

const THREAD_FILL = alpha(iris[400], 0.3);
const OK_FILL = alpha(success[400], 0.3);
const BAD_FILL = alpha(danger[400], 0.35);
const OK_LINK = alpha(success[400], 0.75);
const BAD_LINK = alpha(danger[400], 0.75);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const BankConflicts: FC<WidgetProps> = memo(() => {
  const [stride, setStride] = useState(32);
  const [pad, setPad] = useState(false);

  const onStride = useCallback((e: ChangeEvent<HTMLInputElement>) => setStride(Number(e.target.value)), []);
  const togglePad = useCallback(() => setPad(p => !p), []);

  const pitch = stride + (pad ? 1 : 0);
  const model = useMemo(() => {
    const words = Array.from({length: WARP}, (_, t) => t * pitch);
    /** Distinct word addresses per bank: two threads on the same word share one broadcast, not a conflict. */
    const perBank = Array.from({length: BANKS}, () => new Set<number>());
    for (const w of words) perBank[w % BANKS].add(w);
    const counts = perBank.map(s => s.size);
    const degree = Math.max(...counts);
    return {
      words,
      counts,
      degree,
      used: counts.filter(c => c > 0).length,
      worst: counts.indexOf(degree),
    };
  }, [pitch]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">stride</span>
          <input
            aria-label="stride in 4-byte words"
            className={RANGE_CLASS}
            max={33}
            min={1}
            onChange={onStride}
            step={1}
            type="range"
            value={stride}
          />
          <span className="font-code text-ink-100 tabular-nums">{stride}</span>
        </label>
        <button aria-pressed={pad} className={tabClass(pad)} onClick={togglePad} type="button">
          pad rows (+1 word)
        </button>
      </>
    ),
    [onStride, pad, stride, togglePad],
  );

  const {degree, used, worst} = model;
  const readout = useMemo(
    () => (
      <>
        Thread t reads word t·{pitch}
        {pad ? ` (row width ${stride} + 1 pad)` : ''}, bank = word mod 32: {used} of 32 banks hit, bank {worst} gets{' '}
        {degree} distinct word{degree === 1 ? '' : 's'} (gcd({pitch}, 32) = {gcd(pitch, BANKS)}).{' '}
        <b className="text-ink-100">
          {degree === 1
            ? 'Conflict-free: 1 transaction.'
            : `${degree}-way conflict: ${degree} serialised transactions.`}
        </b>{' '}
        {stride === 32 && !pad
          ? 'This is a 32×32 float tile read by column; padding the row pitch to 33 spreads the column over all 32 banks.'
          : ''}
      </>
    ),
    [degree, pad, pitch, stride, used, worst],
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="shared-memory bank conflicts: 32 banks × 4 bytes">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Warp reading shared memory at word tid·${pitch}: ${degree}-way bank conflict`}</title>
        <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={4} y={11}>
          __shared__ float s[32][{stride}
          {pad ? ' + 1' : ''}]; v = s[threadIdx.x][0]; // word tid·{pitch}
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={THREAD_Y + 10}>
          warp
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={BANK_Y + 14}>
          banks
        </text>
        {model.words.map((w, t) => {
          const x = LEFT + t * LANE;
          const bank = w % BANKS;
          return (
            <g key={t}>
              {t % 4 === 0 || t === WARP - 1 ? (
                <text
                  fill={ink[400]}
                  fontFamily={MONO}
                  fontSize={9}
                  textAnchor="middle"
                  x={x + LANE / 2}
                  y={THREAD_Y - 4}>
                  t{t}
                </text>
              ) : null}
              <rect
                fill={THREAD_FILL}
                height={THREAD_H}
                rx={2}
                stroke={iris[400]}
                strokeWidth={0.75}
                width={LANE - 2}
                x={x + 1}
                y={THREAD_Y}
              />
              <line
                stroke={model.counts[bank] > 1 ? BAD_LINK : OK_LINK}
                strokeWidth={0.9}
                x1={x + LANE / 2}
                x2={LEFT + (bank + 0.5) * LANE}
                y1={THREAD_Y + THREAD_H}
                y2={BANK_Y}
              />
            </g>
          );
        })}
        {model.counts.map((c, b) => {
          const x = LEFT + b * LANE;
          return (
            <g key={b}>
              <rect
                fill={c === 0 ? ink[800] : c > 1 ? BAD_FILL : OK_FILL}
                height={BANK_H}
                rx={2}
                stroke={c === 0 ? ink[700] : c > 1 ? danger[400] : success[400]}
                strokeWidth={0.75}
                width={LANE - 2}
                x={x + 1}
                y={BANK_Y}
              />
              {c > 0 ? (
                <text
                  fill={ink[50]}
                  fontFamily={MONO}
                  fontSize={9}
                  fontWeight={600}
                  textAnchor="middle"
                  x={x + LANE / 2}
                  y={BANK_Y + 14}>
                  {c}
                </text>
              ) : null}
              {b % 4 === 0 || b === BANKS - 1 ? (
                <text
                  fill={ink[400]}
                  fontFamily={MONO}
                  fontSize={9}
                  textAnchor="middle"
                  x={x + LANE / 2}
                  y={BANK_Y + BANK_H + 11}>
                  b{b}
                </text>
              ) : null}
            </g>
          );
        })}
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={LEFT} y={HEIGHT - 3}>
          number in a bank = distinct words requested there (same word broadcasts)
        </text>
      </svg>
    </WidgetFrame>
  );
});
BankConflicts.displayName = 'BankConflicts';

export default BankConflicts;
