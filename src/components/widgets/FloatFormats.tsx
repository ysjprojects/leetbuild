import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const WIDTH = 620;
const ROW_TOP = 22;
const ROW = 32;
const BITS_X = 92;
const CELL_W = 10;
const TEXT_X = 424;

interface Format {
  name: string;
  exp: number;
  man: number;
  bias: number;
  max: number;
  /** IEEE-style formats overflow to ±inf; E4M3 (the `e4m3fn` variant) has no infinities and overflows to NaN. */
  inf: boolean;
}

const FORMATS: readonly Format[] = [
  {name: 'fp32', exp: 8, man: 23, bias: 127, max: (2 - 2 ** -23) * 2 ** 127, inf: true},
  {name: 'fp16', exp: 5, man: 10, bias: 15, max: 65504, inf: true},
  {name: 'bf16', exp: 8, man: 7, bias: 127, max: (2 - 2 ** -7) * 2 ** 127, inf: true},
  {name: 'fp8 E4M3', exp: 4, man: 3, bias: 7, max: 448, inf: false},
  {name: 'fp8 E5M2', exp: 5, man: 2, bias: 15, max: 57344, inf: true},
];
const FP16 = FORMATS[1];

type Kind = 'normal' | 'subnormal' | 'underflow' | 'overflow';

interface Encoded {
  sign: number;
  exp: number;
  man: number;
  stored: number;
  kind: Kind;
}

/** Round half to even. */
const rne = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  if (d !== 0.5) return d < 0.5 ? f : f + 1;
  return f % 2 === 0 ? f : f + 1;
};

/** Round-to-nearest-even cast of a double into `f`, returning the bit fields and the value they decode to. */
const encode = (v: number, f: Format): Encoded => {
  const sign = v < 0 || Object.is(v, -0) ? 1 : 0;
  const s = sign ? -1 : 1;
  const a = Math.abs(v);
  if (a === 0) return {sign, exp: 0, man: 0, stored: 0, kind: 'normal'};
  const emin = 1 - f.bias;
  const lead = 2 ** f.man;
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  if (e < emin) {
    const k = rne(a / 2 ** (emin - f.man));
    if (k === 0) return {sign, exp: 0, man: 0, stored: s * 0, kind: 'underflow'};
    if (k === lead) return {sign, exp: 1, man: 0, stored: s * 2 ** emin, kind: 'normal'};
    return {sign, exp: 0, man: k, stored: s * k * 2 ** (emin - f.man), kind: 'subnormal'};
  }
  let k = rne(a / 2 ** (e - f.man));
  if (k === 2 * lead) {
    e++;
    k = lead;
  }
  const stored = k * 2 ** (e - f.man);
  if (stored > f.max) {
    const allOnes = 2 ** f.exp - 1;
    return f.inf
      ? {sign, exp: allOnes, man: 0, stored: s * Infinity, kind: 'overflow'}
      : {sign, exp: allOnes, man: lead - 1, stored: NaN, kind: 'overflow'};
  }
  return {sign, exp: e + f.bias, man: k - lead, stored: s * stored, kind: 'normal'};
};

const bitsOf = (n: number, width: number): number[] =>
  Array.from({length: width}, (_, i) => Math.floor(n / 2 ** (width - 1 - i)) % 2);

const sci = (n: number, digits = 2): string => n.toExponential(digits).replace('e+', 'e');

const storedText = (enc: Encoded): string => {
  if (Number.isNaN(enc.stored)) return 'NaN';
  if (!Number.isFinite(enc.stored)) return enc.stored > 0 ? '+inf' : '−inf';
  if (enc.stored === 0) return enc.sign ? '−0' : '0';
  return enc.stored.toPrecision(9).replace('e+', 'e').replace('-', '−');
};

const relErr = (enc: Encoded, v: number): number =>
  Number.isFinite(enc.stored) ? Math.abs(enc.stored - v) / Math.abs(v) : Infinity;

const errText = (err: number): string => (err === 0 ? 'exact' : Number.isFinite(err) ? sci(err, 1) : '∞');

const kindText = (enc: Encoded, f: Format): string => {
  switch (enc.kind) {
    case 'normal':
      return 'normal';
    case 'subnormal':
      return 'subnormal';
    case 'underflow':
      return 'underflow → 0';
    case 'overflow':
      return f.inf ? 'overflow → inf' : 'overflow → NaN';
  }
};

const kindColor = (k: Kind): string => {
  switch (k) {
    case 'normal':
      return success[300];
    case 'subnormal':
      return warning[300];
    case 'underflow':
    case 'overflow':
      return danger[300];
  }
};

const FIELD = [iris[400], success[400], concept.pytorch] as const;
const FIELD_ON = [alpha(FIELD[0], 0.55), alpha(FIELD[1], 0.55), alpha(FIELD[2], 0.55)] as const;
const FIELD_OFF = [alpha(FIELD[0], 0.12), alpha(FIELD[1], 0.12), alpha(FIELD[2], 0.12)] as const;

// ---- gradient histogram ----

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

const G_LO = -9;
const G_HI = -2;
const BIN = 0.25;
const BINS = (G_HI - G_LO) / BIN;
const SAMPLES = 4000;
/** Fixed gradient magnitudes: log₁₀|g| ~ N(−5.5, 1.3) truncated to [1e−9, 1e−2]. */
const sampleGradients = (): number[] => {
  const rand = mulberry32(20241022);
  const out: number[] = [];
  while (out.length < SAMPLES) {
    const u = 1 - rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    const l = -5.5 + 1.3 * z;
    if (l >= G_LO && l < G_HI) out.push(10 ** l);
  }
  return out;
};
const histogram = (grads: readonly number[]): number[] => {
  const c = new Array<number>(BINS).fill(0);
  for (const g of grads) c[Math.min(BINS - 1, Math.floor((Math.log10(g) - G_LO) / BIN))]++;
  return c;
};
const GRADS: readonly number[] = sampleGradients();
const COUNTS: readonly number[] = histogram(GRADS);
const PEAK = Math.max(...COUNTS);

const AX_LO = -10;
const AX_HI = 6;
const AX_X0 = 30;
const AX_X1 = WIDTH - 16;
const axX = (l: number): number => AX_X0 + ((l - AX_LO) / (AX_HI - AX_LO)) * (AX_X1 - AX_X0);
/** fp16 edges: half the smallest subnormal rounds to 0, 2⁻¹⁴ is the smallest normal, max + ½ulp rounds to inf. */
const ZERO_EDGE = Math.log10(2 ** -25);
const NORMAL_EDGE = Math.log10(2 ** -14);
const INF_EDGE = Math.log10(65520);
const HIST_TOP = ROW_TOP + FORMATS.length * ROW + 16;
const PLOT_TOP = HIST_TOP + 10;
const PLOT_H = 66;
const HEIGHT = PLOT_TOP + PLOT_H + 18;
const ZONES = [
  {lo: AX_LO, hi: ZERO_EDGE, fill: alpha(danger[400], 0.14), label: '→ 0', color: danger[300]},
  {lo: ZERO_EDGE, hi: NORMAL_EDGE, fill: alpha(warning[400], 0.14), label: 'subnormal', color: warning[300]},
  {lo: NORMAL_EDGE, hi: INF_EDGE, fill: alpha(success[400], 0.08), label: 'fp16 normal', color: success[300]},
  {lo: INF_EDGE, hi: AX_HI, fill: alpha(danger[400], 0.14), label: '→ inf', color: danger[300]},
] as const;

const FloatFormats: FC<WidgetProps> = memo(() => {
  const [log10v, setLog10v] = useState(-1);
  const [negative, setNegative] = useState(false);
  const [lossExp, setLossExp] = useState(0);

  const onValue = useCallback((e: ChangeEvent<HTMLInputElement>) => setLog10v(Number(e.target.value)), []);
  const toggleSign = useCallback(() => setNegative(n => !n), []);
  const onLoss = useCallback((e: ChangeEvent<HTMLInputElement>) => setLossExp(Number(e.target.value)), []);

  const value = (negative ? -1 : 1) * 10 ** log10v;
  const rows = useMemo(
    () =>
      FORMATS.map(f => {
        const enc = encode(value, f);
        return {f, enc, err: relErr(enc, value)};
      }),
    [value],
  );

  const cast = useMemo(() => {
    const scale = 2 ** lossExp;
    let zero = 0;
    let sub = 0;
    let over = 0;
    let largest = 0;
    for (const g of GRADS) {
      const enc = encode(g * scale, FP16);
      if (enc.kind === 'underflow') zero++;
      else if (enc.kind === 'subnormal') sub++;
      else if (enc.kind === 'overflow') over++;
      largest = Math.max(largest, g * scale);
    }
    return {scale, zero, sub, over, largest};
  }, [lossExp]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">value</span>
          <input
            aria-label="value, log scale from 1e-10 to 1e10"
            className={RANGE_CLASS}
            max={10}
            min={-10}
            onChange={onValue}
            step={0.01}
            type="range"
            value={log10v}
          />
          <span className="font-code text-ink-100 w-[72px] tabular-nums">{sci(value, 3).replace('-', '−')}</span>
        </label>
        <button aria-pressed={negative} className={tabClass(negative)} onClick={toggleSign} type="button">
          negative
        </button>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">loss scale</span>
          <input
            aria-label="loss scale exponent, 2 to the 0 through 2 to the 24"
            className={RANGE_CLASS}
            max={24}
            min={0}
            onChange={onLoss}
            step={1}
            type="range"
            value={lossExp}
          />
          <span className="font-code text-ink-100 w-8 tabular-nums">2^{lossExp}</span>
        </label>
      </>
    ),
    [log10v, lossExp, negative, onLoss, onValue, toggleSign, value],
  );

  const readout = useMemo(() => {
    const pct = (n: number): string => `${((100 * n) / SAMPLES).toFixed(1)}%`;
    const perFormat = rows
      .map(({f, enc, err}) => `${f.name} ${enc.kind === 'normal' ? errText(err) : kindText(enc, f)}`)
      .join(' · ');
    return (
      <>
        Relative error of {sci(value, 3).replace('-', '−')}: {perFormat}. Loss scale 2^{lossExp} ={' '}
        {cast.scale.toLocaleString('en-US')}: {pct(cast.zero)} of the {SAMPLES.toLocaleString('en-US')} gradients
        underflow to 0 in fp16 and {pct(cast.sub)} are subnormal;{' '}
        {cast.over > 0
          ? `${pct(cast.over)} overflow to inf (largest ${sci(
              cast.largest,
            )} > 65,504), so the step is skipped and the scale halved.`
          : `none overflow (largest ${sci(cast.largest)} ≤ 65,504).`}
      </>
    );
  }, [cast, lossExp, rows, value]);

  const shift = lossExp * Math.log10(2);
  return (
    <WidgetFrame controls={controls} readout={readout} title="float formats: bits, rounding, range">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`${value} stored in fp32, fp16, bf16 and fp8; gradients times 2^${lossExp} against fp16's range`}</title>
        <g fill={ink[400]} fontFamily={MONO} fontSize={9}>
          <text x={6} y={12}>
            format · s·e·m
          </text>
          <text fill={FIELD[0]} x={BITS_X} y={12}>
            sign
          </text>
          <text fill={FIELD[1]} x={BITS_X + 32} y={12}>
            exponent
          </text>
          <text fill={FIELD[2]} x={BITS_X + 86} y={12}>
            mantissa
          </text>
          <text x={TEXT_X} y={12}>
            stored value · rel. error
          </text>
        </g>
        {rows.map(({f, enc, err}, r) => {
          const y = ROW_TOP + r * ROW;
          const bits = [...bitsOf(enc.sign, 1), ...bitsOf(enc.exp, f.exp), ...bitsOf(enc.man, f.man)];
          return (
            <g key={f.name}>
              <text fill={ink[100]} fontFamily={MONO} fontSize={10} fontWeight={600} x={6} y={y + 12}>
                {f.name}
              </text>
              <text fill={ink[400]} fontFamily={MONO} fontSize={9} x={6} y={y + 25}>
                1·{f.exp}·{f.man}
              </text>
              {bits.map((b, i) => {
                const field = i === 0 ? 0 : i <= f.exp ? 1 : 2;
                const x = BITS_X + i * CELL_W;
                return (
                  <g key={i}>
                    <rect
                      fill={b ? FIELD_ON[field] : FIELD_OFF[field]}
                      height={18}
                      stroke={FIELD[field]}
                      strokeOpacity={0.6}
                      strokeWidth={0.6}
                      width={CELL_W - 1}
                      x={x}
                      y={y + 2}
                    />
                    <text
                      fill={b ? ink[50] : ink[400]}
                      fontFamily={MONO}
                      fontSize={9}
                      textAnchor="middle"
                      x={x + (CELL_W - 1) / 2}
                      y={y + 14.5}>
                      {b}
                    </text>
                  </g>
                );
              })}
              <text fill={ink[100]} fontFamily={MONO} fontSize={10} x={TEXT_X} y={y + 12}>
                {storedText(enc)}
              </text>
              <text fontFamily={MONO} fontSize={9} x={TEXT_X} y={y + 25}>
                <tspan fill={ink[300]}>err {errText(err)} · </tspan>
                <tspan fill={kindColor(enc.kind)}>{kindText(enc, f)}</tspan>
              </text>
            </g>
          );
        })}
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={6} y={HIST_TOP}>
          {`${SAMPLES} gradients × 2^${lossExp}, binned by |g| against fp16's range`}
        </text>
        {ZONES.map(z => (
          <g key={z.label}>
            <rect fill={z.fill} height={PLOT_H} width={axX(z.hi) - axX(z.lo)} x={axX(z.lo)} y={PLOT_TOP} />
            <text fill={z.color} fontFamily={MONO} fontSize={8} x={axX(z.lo) + 3} y={PLOT_TOP + 10}>
              {z.label}
            </text>
          </g>
        ))}
        {COUNTS.map((c, i) => {
          if (c === 0) return null;
          const lo = G_LO + i * BIN + shift;
          const h = Math.max(1, (c / PEAK) * (PLOT_H - 16));
          const mid = lo + BIN / 2;
          const color = mid < ZERO_EDGE || mid >= INF_EDGE ? danger[400] : mid < NORMAL_EDGE ? warning[400] : iris[400];
          return (
            <rect
              fill={color}
              fillOpacity={0.85}
              height={h}
              key={i}
              width={axX(lo + BIN) - axX(lo) - 1}
              x={axX(lo)}
              y={PLOT_TOP + PLOT_H - h}
            />
          );
        })}
        <line stroke={ink[500]} x1={AX_X0} x2={AX_X1} y1={PLOT_TOP + PLOT_H} y2={PLOT_TOP + PLOT_H} />
        <g fill={ink[400]} fontFamily={MONO} fontSize={8} textAnchor="middle">
          {Array.from({length: (AX_HI - AX_LO) / 2 + 1}, (_, i) => AX_LO + 2 * i).map(l => (
            <text key={l} x={axX(l)} y={PLOT_TOP + PLOT_H + 11}>
              1e{l}
            </text>
          ))}
        </g>
      </svg>
    </WidgetFrame>
  );
});
FloatFormats.displayName = 'FloatFormats';

export default FloatFormats;
