import {type FC, memo, useMemo} from 'react';

import {alpha, ink, iris} from '@/styles/palette';

import WidgetFrame from './frame';
import type {WidgetProps} from './index';
import PlaybackControls, {usePlayback} from './playback';

const MONO = 'var(--font-code), monospace';
/** Word counts; every word is pre-split into characters plus the end-of-word mark `_` (Sennrich's `</w>`). */
const CORPUS: readonly (readonly [string, number])[] = [
  ['low', 5],
  ['lower', 2],
  ['lowest', 3],
  ['newer', 6],
  ['wider', 3],
  ['new', 2],
];
const EOW = '_';
const MERGES = 12;

const WIDTH = 620;
const TOP = 22;
const ROW = 26;
const CHIP_H = 18;
const CHAR_W = 6.3;
const CORPUS_X = 34;
const TABLE_X = 184;
const BAR_X = 268;
const BAR_W = 84;
const VOCAB_X = 396;
const VOCAB_W = WIDTH - VOCAB_X - 6;
const HEIGHT = TOP + CORPUS.length * ROW + 4;
const NEW_FILL = alpha(iris[400], 0.3);
const PICK_FILL = alpha(iris[400], 0.16);

interface PairCount {
  a: string;
  b: string;
  count: number;
}

interface Frame {
  /** Token sequence of each corpus word after this frame's merges. */
  words: string[][];
  /** Pair counts sorted by count, then alphabetically: the table that chose this frame's merge (or the next one, at frame 0). */
  pairs: PairCount[];
  /** The merge made in this frame; `null` at frame 0. */
  merged: PairCount | null;
  vocab: string[];
}

const countPairs = (words: string[][]): PairCount[] => {
  const counts = new Map<string, PairCount>();
  words.forEach((toks, w) => {
    for (let i = 0; i + 1 < toks.length; i++) {
      const key = `${toks[i]}\u0000${toks[i + 1]}`;
      const hit = counts.get(key);
      if (hit) hit.count += CORPUS[w][1];
      else counts.set(key, {a: toks[i], b: toks[i + 1], count: CORPUS[w][1]});
    }
  });
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...counts.values()].sort((p, q) => q.count - p.count || cmp(p.a, q.a) || cmp(p.b, q.b));
};

/** Replace every non-overlapping `a b` (left to right) with `ab`. */
const applyMerge = (toks: string[], {a, b}: PairCount): string[] => {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (i + 1 < toks.length && toks[i] === a && toks[i + 1] === b) {
      out.push(a + b);
      i++;
    } else out.push(toks[i]);
  }
  return out;
};

const buildFrames = (): Frame[] => {
  let words = CORPUS.map(([w]) => [...w, EOW]);
  const base = [...new Set(words.flat())].sort();
  const frames: Frame[] = [{words, pairs: countPairs(words), merged: null, vocab: base}];
  for (let m = 0; m < MERGES; m++) {
    const pairs = countPairs(words);
    const merged = pairs[0];
    words = words.map(t => applyMerge(t, merged));
    frames.push({words, pairs, merged, vocab: [...frames[frames.length - 1].vocab, merged.a + merged.b]});
  }
  return frames;
};
const FRAMES: readonly Frame[] = buildFrames();
const wordCount = (): number => {
  let n = 0;
  for (const [, c] of CORPUS) n += c;
  return n;
};
const WORDS = wordCount();

const chipW = (tok: string): number => tok.length * CHAR_W + 8;

const tokenTotal = (words: string[][]): number => words.reduce((a, t, w) => a + t.length * CORPUS[w][1], 0);

const BpeMerges: FC<WidgetProps> = memo(() => {
  const playback = usePlayback(FRAMES.length, 1400);
  const step = Math.min(playback.step, FRAMES.length - 1);
  const frame = FRAMES[step];
  const newest = frame.merged ? frame.merged.a + frame.merged.b : null;

  const controls = useMemo(() => <PlaybackControls label="merge" playback={playback} />, [playback]);

  const readout = useMemo(() => {
    const tokens = tokenTotal(frame.words);
    const perWord = (tokens / WORDS).toFixed(2);
    const top = frame.pairs[0];
    const ties = frame.pairs.filter(p => p !== top && p.count === top.count);
    const tieText =
      ties.length === 0
        ? ''
        : ` (tied with ${ties.map(p => `(${p.a}, ${p.b})`).join(', ')}; ties go to the alphabetically first pair)`;
    if (!frame.merged) {
      return (
        <>
          {WORDS} words split into characters plus the end-of-word mark {EOW}: {frame.vocab.length} base symbols,{' '}
          {tokens} tokens, {perWord} per word. The most frequent adjacent pair is ({top.a}, {top.b}) at {top.count}
          {tieText}.
        </>
      );
    }
    return (
      <>
        <b className="text-ink-100">
          Merge {step}/{MERGES}
        </b>
        : ({frame.merged.a}, {frame.merged.b}) occurs {frame.merged.count} times{tieText}, so {newest} joins the
        vocabulary ({frame.vocab.length} tokens) and the corpus re-tokenises to {tokens} tokens, {perWord} per word.
      </>
    );
  }, [frame, newest, step]);

  const vocabChips = useMemo(() => {
    const out: {tok: string; x: number; y: number}[] = [];
    let x = VOCAB_X;
    let y = TOP;
    for (const tok of frame.vocab) {
      const w = chipW(tok);
      if (x + w > VOCAB_X + VOCAB_W) {
        x = VOCAB_X;
        y += CHIP_H + 4;
      }
      out.push({tok, x, y});
      x += w + 3;
    }
    return out;
  }, [frame]);

  const maxCount = frame.pairs[0]?.count ?? 1;
  return (
    <WidgetFrame controls={controls} readout={readout} title="byte-pair encoding: one merge per step">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`BPE after ${step} merges: ${frame.vocab.length} vocabulary tokens`}</title>
        <g fill={ink[400]} fontFamily={MONO} fontSize={9}>
          <text x={6} y={12}>
            count × word ({EOW} = end of word)
          </text>
          <text x={TABLE_X} y={12}>
            {step === 0 ? 'pair counts · next merge' : 'pair counts · merged'}
          </text>
          <text x={VOCAB_X} y={12}>
            vocabulary · {frame.vocab.length} tokens
          </text>
        </g>
        {frame.words.map((toks, w) => {
          const y = TOP + w * ROW;
          let x = CORPUS_X;
          return (
            <g key={w}>
              <text fill={ink[300]} fontFamily={MONO} fontSize={10} x={6} y={y + 13}>
                ×{CORPUS[w][1]}
              </text>
              {toks.map((tok, i) => {
                const cw = chipW(tok);
                const cx = x;
                x += cw + 3;
                const isNew = tok === newest;
                return (
                  <g key={i}>
                    <rect
                      fill={isNew ? NEW_FILL : ink[800]}
                      height={CHIP_H}
                      rx={4}
                      stroke={isNew ? iris[400] : ink[600]}
                      width={cw}
                      x={cx}
                      y={y}
                    />
                    <text
                      fill={tok === EOW ? ink[400] : ink[100]}
                      fontFamily={MONO}
                      fontSize={10}
                      textAnchor="middle"
                      x={cx + cw / 2}
                      y={y + 12.5}>
                      {tok}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        {frame.pairs.slice(0, 5).map((p, r) => {
          const y = TOP + r * ROW;
          const picked = r === 0;
          return (
            <g key={`${p.a} ${p.b}`}>
              {picked ? (
                <rect
                  fill={PICK_FILL}
                  height={CHIP_H + 2}
                  rx={4}
                  stroke={iris[400]}
                  width={BAR_X + BAR_W + 26 - TABLE_X + 4}
                  x={TABLE_X - 4}
                  y={y - 1}
                />
              ) : null}
              <text fill={picked ? ink[50] : ink[200]} fontFamily={MONO} fontSize={10} x={TABLE_X} y={y + 13}>
                {p.a} + {p.b}
              </text>
              <rect fill={ink[800]} height={8} rx={2} width={BAR_W} x={BAR_X} y={y + 5} />
              <rect
                fill={picked ? iris[400] : ink[500]}
                height={8}
                rx={2}
                width={(p.count / maxCount) * BAR_W}
                x={BAR_X}
                y={y + 5}
              />
              <text
                fill={picked ? ink[50] : ink[300]}
                fontFamily={MONO}
                fontSize={10}
                textAnchor="end"
                x={BAR_X + BAR_W + 22}
                y={y + 13}>
                {p.count}
              </text>
            </g>
          );
        })}
        {vocabChips.map(({tok, x, y}) => {
          const isNew = tok === newest;
          const w = chipW(tok);
          return (
            <g key={tok}>
              <rect
                fill={isNew ? NEW_FILL : ink[800]}
                height={CHIP_H}
                rx={4}
                stroke={isNew ? iris[400] : ink[600]}
                width={w}
                x={x}
                y={y}
              />
              <text
                fill={tok === EOW ? ink[400] : ink[100]}
                fontFamily={MONO}
                fontSize={10}
                textAnchor="middle"
                x={x + w / 2}
                y={y + 12.5}>
                {tok}
              </text>
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
BpeMerges.displayName = 'BpeMerges';

export default BpeMerges;
