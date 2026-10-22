import {type FC, type ReactElement, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {boolParam, numParam, tabClass} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

const MONO = 'var(--font-code), monospace';
/** One MXFP4 block: 32 values, which NVFP4 splits into two blocks of 16. */
const N = 32;
const NV_BLOCK = 16;
/** Non-negative E2M1 magnitudes; the 3-bit code of a magnitude is its index. */
const E2M1 = [0, 0.5, 1, 1.5, 2, 3, 4, 6] as const;
const E2M1_MAX = 6;
const E4M3_MAX = 448;
/** The largest power of two in E2M1 (4 = 2²): the OCP spec divides the block's power of two by it. */
const E2M1_EMAX = 2;
/** Where the outlier goes when switched on: inside NVFP4 block 0, so block 1 keeps its own scale. */
const OUTLIER_AT = 5;
const OUTLIER = 7.5;

const WIDTH = 600;
const PLOT_L = 84;
const PLOT_R = 592;
const GAP = 10;
const COL_W = (PLOT_R - PLOT_L - GAP) / N;
const PANEL_H = 104;
const PANELS = [26, 166] as const;
const HEIGHT = PANELS[1] + PANEL_H + 26;

const BLOCK_FILL = [alpha(iris[400], 0.08), alpha(concept.pytorch, 0.1)] as const;
const BLOCK_TEXT = [iris[300], concept.pytorch] as const;

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Box–Muller standard normal. */
const gauss = (rand: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());

/** Round half to even. */
const rne = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  if (d !== 0.5) return d < 0.5 ? f : f + 1;
  return f % 2 === 0 ? f : f + 1;
};

/** floor(log2(a)) for a > 0, exact at powers of two. */
const ilog2 = (a: number): number => {
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  return e;
};

/** E2M1 round to nearest even, saturating at ±6: the grid step is 0.5 below 2, 1 below 4, 2 above. */
const toE2m1 = (v: number): number => {
  const a = Math.abs(v);
  const step = a < 2 ? 0.5 : a < 4 ? 1 : 2;
  const q = Math.min(rne(a / step) * step, E2M1_MAX);
  return v < 0 ? -q : q;
};

/** A non-negative value cast to FP8 E4M3 (bias 7, 3 mantissa bits, subnormals from 2⁻⁹), round to nearest even, saturating at 448. */
const toE4m3 = (v: number): number => {
  if (v <= 0) return 0;
  if (v >= E4M3_MAX) return E4M3_MAX;
  const ulp = 2 ** (Math.max(ilog2(v), -6) - 3);
  return Math.min(rne(v / ulp) * ulp, E4M3_MAX);
};

const amaxOf = (xs: readonly number[]): number => xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

interface NvBlock {
  amax: number;
  /** amax_block / 6 / s_global before the cast. */
  exact: number;
  /** The stored E4M3 scale. */
  e4m3: number;
  /** e4m3 · s_global: what one E2M1 unit is worth in this block. */
  scale: number;
}

interface Quantized {
  globalScale: number;
  blocks: NvBlock[];
  nv: number[];
  mxExp: number;
  mxScale: number;
  mx: number[];
  mseNv: number;
  mseMx: number;
  /** Values that hit ±6 after scaling (clamped) in each format. */
  satNv: number;
  satMx: number;
}

const makeValues = (seed: number, outlier: boolean): number[] => {
  const rand = mulberry32(seed);
  const xs = Array.from({length: N}, () => gauss(rand));
  if (outlier) xs[OUTLIER_AT] = xs[OUTLIER_AT] < 0 ? -OUTLIER : OUTLIER;
  return xs;
};

const quantize = (xs: readonly number[]): Quantized => {
  const amax = amaxOf(xs);
  const globalScale = amax === 0 ? 1 : amax / (E2M1_MAX * E4M3_MAX);
  const blocks = [0, 1].map(b => {
    const bAmax = amaxOf(xs.slice(b * NV_BLOCK, (b + 1) * NV_BLOCK));
    const exact = bAmax / E2M1_MAX / globalScale;
    const e4m3 = toE4m3(exact);
    return {amax: bAmax, exact, e4m3, scale: e4m3 * globalScale};
  });
  let satNv = 0;
  const nv = xs.map((v, i) => {
    const {scale} = blocks[Math.floor(i / NV_BLOCK)];
    if (scale === 0) return 0;
    if (Math.abs(v / scale) > E2M1_MAX) satNv++;
    return toE2m1(v / scale) * scale;
  });

  // OCP MX v1.0, section 6.3: X = 2^floor(log2 amax) / 2^emax(E2M1), clamped into E8M0's 2^-127 … 2^127.
  const mxExp = amax === 0 ? -127 : Math.min(127, Math.max(-127, ilog2(amax) - E2M1_EMAX));
  const mxScale = 2 ** mxExp;
  let satMx = 0;
  const mx = xs.map(v => {
    if (Math.abs(v / mxScale) > E2M1_MAX) satMx++;
    return toE2m1(v / mxScale) * mxScale;
  });

  const mse = (q: readonly number[]): number => q.reduce((s, v, i) => s + (xs[i] - v) ** 2, 0) / N;
  return {globalScale, blocks, nv, mxExp, mxScale, mx, mseNv: mse(nv), mseMx: mse(mx), satNv, satMx};
};

const colX = (i: number): number => PLOT_L + (i + 0.5) * COL_W + (i >= NV_BLOCK ? GAP : 0);
const blockX0 = (b: number): number => PLOT_L + b * (NV_BLOCK * COL_W + GAP);
const blockX1 = (b: number): number => blockX0(b) + NV_BLOCK * COL_W;
const sci = (v: number): string => v.toExponential(2).replace('e-', 'e−').replace('e+', 'e');
const num = (v: number): string => (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(3));
const supText = (e: number): string => `2^${e < 0 ? `−${-e}` : e}`;

const Nvfp4Block: FC<WidgetProps> = memo(({params}) => {
  const [outlier, setOutlier] = useState(() => boolParam(params, 'outlier', false));
  const [seed, setSeed] = useState(() => Math.max(1, Math.floor(numParam(params, 'seed', 4))));

  const onPlain = useCallback(() => setOutlier(false), []);
  const onOutlier = useCallback(() => setOutlier(true), []);
  const onResample = useCallback(() => setSeed(s => s + 1), []);

  const xs = useMemo(() => makeValues(seed, outlier), [outlier, seed]);
  const r = useMemo(() => quantize(xs), [xs]);

  // One value axis for both panels, so a value sits at the same height in each.
  const top = Math.max(amaxOf(xs), E2M1_MAX * r.mxScale, ...r.blocks.map(b => E2M1_MAX * b.scale)) * 1.06;
  const y = (panel: number, v: number): number => PANELS[panel] + PANEL_H / 2 - (v / top) * (PANEL_H / 2);

  const controls = useMemo(
    () => (
      <>
        <button aria-pressed={!outlier} className={tabClass(!outlier)} onClick={onPlain} type="button">
          gaussian
        </button>
        <button aria-pressed={outlier} className={tabClass(outlier)} onClick={onOutlier} type="button">
          one outlier
        </button>
        <button className={BUTTON_CLASS} onClick={onResample} type="button">
          resample
        </button>
      </>
    ),
    [onOutlier, onPlain, onResample, outlier],
  );

  const ratio = r.mseNv === 0 ? Infinity : r.mseMx / r.mseNv;
  const readout = useMemo(
    () => (
      <>
        NVFP4: s_global = amax / 2,688 = {sci(r.globalScale)}; block scales{' '}
        {r.blocks.map((b, i) => (
          <span key={i}>
            {i === 0 ? '' : ' and '}
            e4m3({num(b.exact)}) = {num(b.e4m3)}
          </span>
        ))}{' '}
        give steps of {r.blocks.map(b => num(b.scale)).join(' and ')} per E2M1 unit; MSE{' '}
        <b className="text-ink-100">{sci(r.mseNv)}</b>. MXFP4: X = 2^floor(log₂ {num(amaxOf(xs))}) / 4 ={' '}
        {supText(r.mxExp)} = {num(r.mxScale)} for all 32; MSE <b className="text-ink-100">{sci(r.mseMx)}</b>
        {Number.isFinite(ratio) ? `, ${ratio.toFixed(1)}× NVFP4's` : ''}
        {r.satMx > 0 ? ` (${r.satMx} value${r.satMx === 1 ? '' : 's'} clamped to ±6X)` : ''}.
      </>
    ),
    [r, ratio, xs],
  );

  const drawPoints = (panel: number, q: readonly number[]): ReactElement[] =>
    xs.map((v, i) => {
      const cx = colX(i);
      const half = Math.min(COL_W / 2 - 1, 5);
      return (
        <g key={i}>
          <line stroke={warning[400]} strokeWidth={2.2} x1={cx} x2={cx} y1={y(panel, v)} y2={y(panel, q[i])} />
          <line
            stroke={iris[400]}
            strokeWidth={2.2}
            x1={cx - half}
            x2={cx + half}
            y1={y(panel, q[i])}
            y2={y(panel, q[i])}
          />
          <circle cx={cx} cy={y(panel, v)} fill={i === OUTLIER_AT && outlier ? danger[300] : ink[100]} r={2.3} />
        </g>
      );
    });

  const drawGrid = (panel: number, scale: number, x1: number, x2: number, key: string): ReactElement[] =>
    E2M1.flatMap(m => (m === 0 ? [0] : [m, -m])).map(m => (
      <line
        key={`${key}${m}`}
        stroke={Math.abs(m) === E2M1_MAX ? success[400] : m === 0 ? ink[500] : ink[700]}
        strokeDasharray={Math.abs(m) === E2M1_MAX ? '3 2' : undefined}
        strokeWidth={Math.abs(m) === E2M1_MAX ? 0.9 : 0.6}
        x1={x1}
        x2={x2}
        y1={y(panel, m * scale)}
        y2={y(panel, m * scale)}
      />
    ));

  return (
    <WidgetFrame controls={controls} readout={readout} title="nvfp4 vs mxfp4: one block of values">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>
          32 values quantized as NVFP4 (two blocks of 16, each with an E4M3 scale) and as MXFP4 (one block of 32 with a
          power-of-two E8M0 scale), with each format&apos;s scaled E2M1 grid, the quantized points and the errors
        </title>
        <g fontFamily={MONO} fontSize={9}>
          {/* NVFP4 */}
          {r.blocks.map((b, k) => (
            <g key={k}>
              <rect
                fill={BLOCK_FILL[k]}
                height={PANEL_H}
                width={blockX1(k) - blockX0(k)}
                x={blockX0(k)}
                y={PANELS[0]}
              />
              {drawGrid(0, b.scale, blockX0(k), blockX1(k), `nv${k}`)}
              <text fill={BLOCK_TEXT[k]} x={blockX0(k) + 2} y={PANELS[0] - 6}>
                block {k} · e4m3 {num(b.e4m3)} · ±6 → ±{num(E2M1_MAX * b.scale)}
              </text>
            </g>
          ))}
          {drawPoints(0, r.nv)}
          <text fill={ink[100]} fontWeight={700} x={4} y={PANELS[0] + 12}>
            NVFP4
          </text>
          <text fill={ink[300]} x={4} y={PANELS[0] + 25}>
            16 · E4M3
          </text>
          <text fill={ink[300]} x={4} y={PANELS[0] + 38}>
            + FP32 s_g
          </text>
          <text fill={ink[300]} x={4} y={PANELS[0] + 64}>
            MSE
          </text>
          <text fill={ink[100]} x={4} y={PANELS[0] + 77}>
            {sci(r.mseNv)}
          </text>

          {/* MXFP4 */}
          <rect fill={alpha(ink[400], 0.08)} height={PANEL_H} width={PLOT_R - PLOT_L} x={PLOT_L} y={PANELS[1]} />
          {drawGrid(1, r.mxScale, PLOT_L, PLOT_R, 'mx')}
          {drawPoints(1, r.mx)}
          <text fill={ink[200]} x={PLOT_L + 2} y={PANELS[1] - 6}>
            one block of 32 · E8M0 X = {supText(r.mxExp)} · ±6 → ±{num(E2M1_MAX * r.mxScale)}
          </text>
          <text fill={ink[100]} fontWeight={700} x={4} y={PANELS[1] + 12}>
            MXFP4
          </text>
          <text fill={ink[300]} x={4} y={PANELS[1] + 25}>
            32 · E8M0
          </text>
          <text fill={ink[300]} x={4} y={PANELS[1] + 38}>
            power of 2
          </text>
          <text fill={ink[300]} x={4} y={PANELS[1] + 64}>
            MSE
          </text>
          <text fill={ink[100]} x={4} y={PANELS[1] + 77}>
            {sci(r.mseMx)}
          </text>

          <text fill={ink[300]} x={4} y={HEIGHT - 8}>
            dot: value · bar: its E2M1 point × scale · orange: error · lines: the scaled grid, dashed at ±6
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
Nvfp4Block.displayName = 'Nvfp4Block';

export default Nvfp4Block;
