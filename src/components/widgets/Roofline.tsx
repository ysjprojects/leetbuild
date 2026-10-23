import {
  type FC,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useMemo,
  useState,
} from 'react';

import {alpha, concept, ink, iris} from '@/styles/palette';

import WidgetFrame, {tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';

interface Gpu {
  name: string;
  /** Dense FP32 (non-tensor) peak, FLOP/s. */
  fp32: number;
  /** Dense BF16 tensor-core peak, FLOP/s. */
  tensor: number;
  tensorLabel: string;
  /** DRAM bandwidth, bytes/s. */
  bw: number;
}

/** Published dense (no sparsity) datasheet peaks. */
const GPUS: Gpu[] = [
  {name: 'A100 SXM 80GB', fp32: 19.5e12, tensor: 312e12, tensorLabel: 'BF16 tensor', bw: 2.039e12},
  {name: 'H100 SXM', fp32: 67e12, tensor: 989e12, tensorLabel: 'BF16 tensor', bw: 3.35e12},
  {name: 'RTX 4090', fp32: 82.6e12, tensor: 165.2e12, tensorLabel: 'BF16 tensor (FP32 acc)', bw: 1.008e12},
];

type Roof = 'fp32' | 'tensor';

interface Kernel {
  name: string;
  short: string;
  flop: number;
  bytes: number;
  roof: Roof;
  /** How the FLOP and byte counts arise. */
  math: string;
}

const GEMM_N = 4096;
const TILE = 32;

const KERNELS: Kernel[] = [
  {
    name: 'vector add (fp32)',
    short: 'vector add',
    flop: 1,
    bytes: 12,
    roof: 'fp32',
    math: 'c[i] = a[i] + b[i]: 1 FLOP per element against 12 B (two 4 B loads, one 4 B store)',
  },
  {
    name: 'naive matmul (fp32)',
    short: 'naive matmul',
    flop: 2,
    bytes: 8,
    roof: 'fp32',
    math: 'every multiply-add (2 FLOP) loads A[i][k] and B[k][j] from DRAM with no reuse: 2 FLOP / 8 B',
  },
  {
    name: 'row softmax (fp32)',
    short: 'row softmax',
    flop: 5,
    bytes: 8,
    roof: 'fp32',
    math: 'a fused online softmax reads each element once and writes it once (8 B) for 5 FLOP (max, subtract, exp, add, divide)',
  },
  {
    name: 'fused GELU (fp32)',
    short: 'fused GELU',
    flop: 20,
    bytes: 8,
    roof: 'fp32',
    math: 'tanh-form 0.5x(1 + tanh(√(2/π)(x + 0.044715x³))) plus the bias add is about 8 multiply/adds and a tanhf of about 12 more (an exp, a reciprocal, fix-ups) ≈ 20 FLOP per element, against 4 B in + 4 B out',
  },
  {
    name: `tiled matmul (fp32, TILE = ${TILE})`,
    short: 'tiled matmul',
    flop: 2 * TILE,
    bytes: 8,
    roof: 'fp32',
    math: `per tile phase each thread loads one A and one B element (8 B) from DRAM into shared memory, then does TILE = ${TILE} multiply-adds (${
      2 * TILE
    } FLOP): TILE/4 FLOP/B`,
  },
  {
    name: `tensor-core GEMM (bf16, n = ${GEMM_N})`,
    short: 'tensor-core GEMM',
    flop: 2 * GEMM_N ** 3,
    bytes: 3 * GEMM_N ** 2 * 2,
    roof: 'tensor',
    math: `C = AB with n = ${GEMM_N}: 2n³ = ${((2 * GEMM_N ** 3) / 1e9).toFixed(1)} GFLOP over 3n² × 2 B = ${(
      (3 * GEMM_N ** 2 * 2) /
      1e6
    ).toFixed(1)} MB (A and B read once, C written once): n/3 FLOP/B`,
  },
];

const WIDTH = 600;
const HEIGHT = 300;
const PX0 = 54;
const PX1 = 582;
const PY0 = 14;
const PY1 = 222;
const X_MIN = -2;
const X_MAX = 4;
const Y_MIN = 10;
const Y_MAX = Math.log10(3e15);
const LEGEND_Y = 262;
const LEGEND_COL = 182;

const ROOF_COLOR: Record<Roof, string> = {fp32: iris[400], tensor: concept.cuda};
const SELECTED_FILL = alpha(iris[400], 0.18);

const px = (intensity: number): number => PX0 + ((Math.log10(intensity) - X_MIN) / (X_MAX - X_MIN)) * (PX1 - PX0);
const py = (flops: number): number => PY1 - ((Math.log10(flops) - Y_MIN) / (Y_MAX - Y_MIN)) * (PY1 - PY0);

const fmtRate = (v: number): string => {
  const [scale, unit] = v >= 1e15 ? [1e15, 'P'] : v >= 1e12 ? [1e12, 'T'] : [1e9, 'G'];
  const n = v / scale;
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit}FLOP/s`;
};
const fmtNum = (v: number): string =>
  v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
const fmtBw = (bw: number): string => `${(bw / 1e12).toFixed(2)} TB/s`;

const X_TICKS: Array<[number, string]> = [
  [0.01, '0.01'],
  [0.1, '0.1'],
  [1, '1'],
  [10, '10'],
  [100, '100'],
  [1000, '1k'],
  [10000, '10k'],
];
const Y_TICKS: Array<[number, string]> = [
  [1e10, '10G'],
  [1e11, '100G'],
  [1e12, '1T'],
  [1e13, '10T'],
  [1e14, '100T'],
  [1e15, '1P'],
];

const Roofline: FC<WidgetProps> = memo(() => {
  const [gpuIndex, setGpuIndex] = useState(0);
  const [selected, setSelected] = useState(4);
  const gpu = GPUS[gpuIndex];

  const onGpu = useCallback((e: MouseEvent<HTMLButtonElement>) => setGpuIndex(Number(e.currentTarget.value)), []);
  const onPick = useCallback((e: MouseEvent<SVGGElement>) => setSelected(Number(e.currentTarget.dataset.kernel)), []);
  const onFocus = useCallback((e: FocusEvent<SVGGElement>) => setSelected(Number(e.currentTarget.dataset.kernel)), []);
  const onKey = useCallback((e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setSelected(Number(e.currentTarget.dataset.kernel));
  }, []);

  const peak = useCallback((roof: Roof): number => (roof === 'fp32' ? gpu.fp32 : gpu.tensor), [gpu]);
  const placed = useMemo(
    () =>
      KERNELS.map(k => {
        const intensity = k.flop / k.bytes;
        const ridge = peak(k.roof) / gpu.bw;
        const rate = Math.min(peak(k.roof), gpu.bw * intensity);
        return {intensity, ridge, rate, memoryBound: intensity < ridge};
      }),
    [gpu, peak],
  );

  const controls = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-1">
        {GPUS.map((g, i) => (
          <button
            aria-pressed={i === gpuIndex}
            className={tabClass(i === gpuIndex)}
            key={g.name}
            onClick={onGpu}
            type="button"
            value={i}>
            {g.name}
          </button>
        ))}
      </div>
    ),
    [gpuIndex, onGpu],
  );

  const kernel = KERNELS[selected];
  const at = placed[selected];
  const readout = useMemo(() => {
    const roofPeak = peak(kernel.roof);
    const roofName = kernel.roof === 'fp32' ? 'FP32' : gpu.tensorLabel;
    return (
      <>
        <b className="text-ink-100">{kernel.name}</b>: {kernel.math} → {fmtNum(at.intensity)} FLOP/B. On {gpu.name} the{' '}
        {roofName} ridge is {fmtRate(roofPeak)} / {fmtBw(gpu.bw)} = {fmtNum(at.ridge)} FLOP/B, so it is{' '}
        <b className="text-ink-100">{at.memoryBound ? 'memory-bound' : 'compute-bound'}</b>:{' '}
        {at.memoryBound
          ? `attainable = ${fmtBw(gpu.bw)} × ${fmtNum(at.intensity)} FLOP/B = ${fmtRate(at.rate)}, ${(
              (100 * at.rate) /
              roofPeak
            ).toFixed(1)}% of the ${fmtRate(roofPeak)} peak.`
          : `attainable = the ${fmtRate(roofPeak)} ${roofName} peak.`}
      </>
    );
  }, [at, gpu, kernel, peak]);

  const fp32Ridge = gpu.fp32 / gpu.bw;
  const tensorRidge = gpu.tensor / gpu.bw;
  const xMinVal = 10 ** X_MIN;
  const xMaxVal = 10 ** X_MAX;
  const slopeStart = Math.max(xMinVal, 10 ** Y_MIN / gpu.bw);
  const compute = !at.memoryBound;
  const selX = px(at.intensity);
  const selY = py(at.rate);
  const labelRight = selX < PX1 - 200;

  return (
    <WidgetFrame controls={controls} readout={readout} title="roofline model">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Roofline of ${gpu.name}: attainable FLOP/s against arithmetic intensity, with six kernels placed by intensity`}</title>
        <g fontFamily={MONO} fontSize={9}>
          {X_TICKS.map(([v, label]) => (
            <g key={v}>
              <line stroke={ink[700]} x1={px(v)} x2={px(v)} y1={PY0} y2={PY1} />
              <text fill={ink[300]} textAnchor="middle" x={px(v)} y={PY1 + 12}>
                {label}
              </text>
            </g>
          ))}
          {Y_TICKS.map(([v, label]) => (
            <g key={v}>
              <line stroke={ink[700]} x1={PX0} x2={PX1} y1={py(v)} y2={py(v)} />
              <text fill={ink[300]} textAnchor="end" x={PX0 - 4} y={py(v) + 3}>
                {label}
              </text>
            </g>
          ))}
          <text fill={ink[300]} textAnchor="middle" x={(PX0 + PX1) / 2} y={PY1 + 25}>
            arithmetic intensity (FLOP/byte, log)
          </text>
          <text fill={ink[300]} textAnchor="middle" transform={`translate(10 ${(PY0 + PY1) / 2}) rotate(-90)`}>
            FLOP/s (log)
          </text>

          {/* Bandwidth slope, then the two flat compute ceilings. */}
          <line
            stroke={ink[200]}
            strokeWidth={2}
            x1={px(slopeStart)}
            x2={px(tensorRidge)}
            y1={py(gpu.bw * slopeStart)}
            y2={py(gpu.tensor)}
          />
          <line
            stroke={ROOF_COLOR.fp32}
            strokeWidth={2}
            x1={px(fp32Ridge)}
            x2={px(xMaxVal)}
            y1={py(gpu.fp32)}
            y2={py(gpu.fp32)}
          />
          <line
            stroke={ROOF_COLOR.tensor}
            strokeWidth={2}
            x1={px(tensorRidge)}
            x2={px(xMaxVal)}
            y1={py(gpu.tensor)}
            y2={py(gpu.tensor)}
          />
          {(
            [
              [ink[200], `DRAM ${fmtBw(gpu.bw)}`],
              [ROOF_COLOR.tensor, `${gpu.tensorLabel} ${fmtRate(gpu.tensor)}`],
              [ROOF_COLOR.fp32, `FP32 ${fmtRate(gpu.fp32)}`],
            ] as Array<[string, string]>
          ).map(([color, label], i) => (
            <g key={label}>
              <line
                stroke={color}
                strokeWidth={2}
                x1={PX0 + 8}
                x2={PX0 + 22}
                y1={PY0 + 9 + i * 13}
                y2={PY0 + 9 + i * 13}
              />
              <text fill={ink[100]} x={PX0 + 27} y={PY0 + 12 + i * 13}>
                {label}
              </text>
            </g>
          ))}
          {(
            [
              ['fp32', fp32Ridge, gpu.fp32],
              ['tensor', tensorRidge, gpu.tensor],
            ] as Array<[Roof, number, number]>
          ).map(([roof, ridge, top]) => (
            <g key={roof}>
              <line
                stroke={ROOF_COLOR[roof]}
                strokeDasharray="2 3"
                x1={px(ridge)}
                x2={px(ridge)}
                y1={py(top)}
                y2={PY1}
              />
              <text
                fill={ROOF_COLOR[roof]}
                textAnchor={roof === 'fp32' ? 'end' : 'start'}
                x={px(ridge) + (roof === 'fp32' ? -3 : 3)}
                y={PY1 - 4}>
                {fmtNum(ridge)}
              </text>
            </g>
          ))}

          {placed.map((p, i) => {
            const active = i === selected;
            return (
              <g
                className="cursor-pointer"
                data-kernel={i}
                key={KERNELS[i].name}
                onClick={onPick}
                onMouseEnter={onPick}>
                <circle cx={px(p.intensity)} cy={py(p.rate)} fill="transparent" r={11} />
                <circle
                  cx={px(p.intensity)}
                  cy={py(p.rate)}
                  fill={active ? ink[50] : ink[850]}
                  r={active ? 7.5 : 6.5}
                  stroke={ROOF_COLOR[KERNELS[i].roof]}
                  strokeWidth={1.5}
                />
                <text
                  fill={active ? ink[950] : ink[50]}
                  fontWeight={700}
                  pointerEvents="none"
                  textAnchor="middle"
                  x={px(p.intensity)}
                  y={py(p.rate) + 3}>
                  {i + 1}
                </text>
              </g>
            );
          })}
          <text
            fill={ink[50]}
            paintOrder="stroke"
            stroke={ink[850]}
            strokeWidth={3}
            textAnchor={labelRight ? 'start' : 'end'}
            x={selX + (labelRight ? 10 : -10)}
            y={compute ? selY - 11 : selY + 16}>
            {KERNELS[selected].short} · {fmtNum(at.intensity)} FLOP/B · {fmtRate(at.rate)}
          </text>

          {KERNELS.map((k, i) => {
            const active = i === selected;
            const x = PX0 - 40 + (i % 3) * LEGEND_COL;
            const y = LEGEND_Y + Math.floor(i / 3) * 18;
            return (
              <g
                aria-label={`${k.name}: ${fmtNum(placed[i].intensity)} FLOP per byte`}
                aria-pressed={active}
                className="cursor-pointer"
                data-kernel={i}
                key={k.name}
                onClick={onPick}
                onFocus={onFocus}
                onKeyDown={onKey}
                onMouseEnter={onPick}
                role="button"
                tabIndex={0}>
                <rect
                  fill={active ? SELECTED_FILL : 'transparent'}
                  height={16}
                  rx={8}
                  stroke={active ? iris[400] : 'none'}
                  width={LEGEND_COL - 6}
                  x={x}
                  y={y - 11}
                />
                <circle cx={x + 9} cy={y - 3} fill={ink[850]} r={6} stroke={ROOF_COLOR[k.roof]} strokeWidth={1.25} />
                <text fill={ink[50]} fontWeight={700} textAnchor="middle" x={x + 9} y={y}>
                  {i + 1}
                </text>
                <text fill={active ? ink[50] : ink[200]} x={x + 19} y={y}>
                  {k.short} · {fmtNum(placed[i].intensity)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </WidgetFrame>
  );
});
Roofline.displayName = 'Roofline';

export default Roofline;
