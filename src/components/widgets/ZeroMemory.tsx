import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, danger, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {numParam, RANGE_CLASS, stringParam, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';

/** Model sizes in billions of parameters (GPT-2 XL, LLaMA 7B/13B, the paper's 7.5B, 70B, GPT-3, 405B). */
const SIZES = [1.5, 7, 7.5, 13, 70, 175, 405] as const;
/** Data-parallel degrees N_d: powers of two from 1 to 1,024. */
const GPU_COUNTS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] as const;
/** Mixed-precision Adam, as the ZeRO paper counts it: fp16 weights, fp16 gradients, K = 12 bytes of fp32 state. */
const PARAM_BYTES = 2;
const GRAD_BYTES = 2;
const K = 12;
/** One 80 GB accelerator (A100 80GB, H100), in the paper's decimal gigabytes. */
const DEVICE_GB = 80;

type Stage = 'ddp' | 'zero1' | 'zero2' | 'zero3';
const STAGES: readonly Stage[] = ['ddp', 'zero1', 'zero2', 'zero3'];
const STAGE_LABEL: Record<Stage, string> = {ddp: 'DDP', zero1: 'ZeRO-1', zero2: 'ZeRO-2', zero3: 'ZeRO-3'};
/** What each stage partitions, as the paper names it: optimizer states, + gradients, + parameters. */
const STAGE_NAME: Record<Stage, string> = {
  ddp: 'replicated',
  zero1: 'P_os',
  zero2: 'P_os+g',
  zero3: 'P_os+g+p',
};
/** Per-step traffic in units of Ψ (times (N−1)/N on a ring): all-reduce = 2Ψ; ZeRO-3 gathers W twice and reduce-scatters G. */
const COMM_PSI: Record<Stage, number> = {ddp: 2, zero1: 2, zero2: 2, zero3: 3};
const COMM_FORMULA: Record<Stage, string> = {
  ddp: 'all-reduce G',
  zero1: 'reduce-scatter G, all-gather W',
  zero2: 'reduce-scatter G, all-gather W',
  zero3: 'all-gather W twice, reduce-scatter G',
};

interface Memory {
  params: number;
  grads: number;
  optim: number;
  total: number;
}

/** Bytes per GPU, in GB: what each stage keeps whole and what it divides by N. */
const memory = (stage: Stage, psiBillions: number, n: number): Memory => {
  const gb = (bytes: number, sharded: boolean): number => (bytes * psiBillions) / (sharded ? n : 1);
  const params = gb(PARAM_BYTES, stage === 'zero3');
  const grads = gb(GRAD_BYTES, stage === 'zero2' || stage === 'zero3');
  const optim = gb(K, stage !== 'ddp');
  return {params, grads, optim, total: params + grads + optim};
};

const FORMULA: Record<Stage, string> = {
  ddp: '2Ψ + 2Ψ + 12Ψ',
  zero1: '2Ψ + 2Ψ + 12Ψ/N',
  zero2: '2Ψ + (2 + 12)Ψ/N',
  zero3: '(2 + 2 + 12)Ψ/N',
};

const fmtGb = (v: number): string => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

const WIDTH = 600;
const LABEL_X = 4;
const BAR_X = 96;
const BAR_W = 330;
const MEM_X = 434;
const COMM_X = 506;
const COMM_W = 56;
const ROW_TOP = 26;
const ROW_H = 32;
const BAR_H = 14;
const LEGEND_Y = ROW_TOP + STAGES.length * ROW_H + 14;
const HEIGHT = LEGEND_Y + 30;

const PARAM_FILL = iris[400];
const GRAD_FILL = success[400];
const OPTIM_FILL = warning[400];

const ZeroMemory: FC<WidgetProps> = memo(({params}) => {
  const psi0 = numParam(params, 'psi', 7.5);
  const gpus0 = numParam(params, 'gpus', 64);
  const nearest = <T extends number>(list: readonly T[], v: number): number =>
    list.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(list[best] - v) ? i : best), 0);
  const [sizeIdx, setSizeIdx] = useState(() => nearest(SIZES, psi0));
  const [gpuIdx, setGpuIdx] = useState(() => nearest(GPU_COUNTS, gpus0));
  const [stage, setStage] = useState<Stage>(() => stringParam(params, 'stage', STAGES, 'zero3'));

  const psi = SIZES[sizeIdx];
  const n = GPU_COUNTS[gpuIdx];

  const onSize = useCallback((e: ChangeEvent<HTMLInputElement>) => setSizeIdx(Number(e.target.value)), []);
  const onGpus = useCallback((e: ChangeEvent<HTMLInputElement>) => setGpuIdx(Number(e.target.value)), []);
  const pick = useMemo(
    () => Object.fromEntries(STAGES.map(s => [s, () => setStage(s)])) as Record<Stage, () => void>,
    [],
  );

  const rows = useMemo(() => STAGES.map(s => ({stage: s, mem: memory(s, psi, n)})), [n, psi]);
  const scale = rows[0].mem.total;
  const x = (gb: number): number => (gb / scale) * BAR_W;
  const ring = n === 1 ? 0 : (n - 1) / n;
  const selected = rows[STAGES.indexOf(stage)].mem;
  const commGb = COMM_PSI[stage] * ring * psi * GRAD_BYTES;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">Ψ</span>
          <input
            aria-label="model size in billions of parameters"
            className={RANGE_CLASS}
            max={SIZES.length - 1}
            min={0}
            onChange={onSize}
            step={1}
            type="range"
            value={sizeIdx}
          />
          <span className="font-code text-ink-100 tabular-nums">{psi} B</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">N</span>
          <input
            aria-label="number of data-parallel GPUs"
            className={RANGE_CLASS}
            max={GPU_COUNTS.length - 1}
            min={0}
            onChange={onGpus}
            step={1}
            type="range"
            value={gpuIdx}
          />
          <span className="font-code text-ink-100 tabular-nums">{n} GPUs</span>
        </label>
        {STAGES.map(s => (
          <button aria-pressed={stage === s} className={tabClass(stage === s)} key={s} onClick={pick[s]} type="button">
            {STAGE_LABEL[s]}
          </button>
        ))}
      </>
    ),
    [gpuIdx, n, onGpus, onSize, pick, psi, sizeIdx, stage],
  );

  const fits = selected.total <= DEVICE_GB;
  const readout = useMemo(
    () => (
      <>
        {STAGE_LABEL[stage]} with Ψ = {psi} B on N = {n}: {FORMULA[stage]} ={' '}
        <b className="text-ink-100">{fmtGb(selected.total)} GB per GPU</b>
        {stage === 'ddp' ? '' : ` (DDP ${fmtGb(scale)} GB)`},{' '}
        {fits ? `within one ${DEVICE_GB} GB device` : `over one ${DEVICE_GB} GB device`}, before activations. Each GPU
        sends {COMM_PSI[stage]}Ψ·(N−1)/N = {fmtGb(commGb)} GB of fp16 per step ({COMM_FORMULA[stage]}),{' '}
        {COMM_PSI[stage] / COMM_PSI.ddp}× DDP.
      </>
    ),
    [commGb, fits, n, psi, scale, selected.total, stage],
  );

  const deviceX = BAR_X + x(DEVICE_GB);
  const commMax = Math.max(...STAGES.map(s => COMM_PSI[s]));

  return (
    <WidgetFrame controls={controls} readout={readout} title="zero memory per gpu">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Per-GPU memory of mixed-precision Adam for ${psi} B parameters on ${n} GPUs under DDP and ZeRO stages 1 to 3, with communication per step relative to DDP`}</title>
        <g fontFamily={MONO} fontSize={9}>
          <text fill={ink[300]} x={BAR_X} y={12}>
            per-GPU bytes · params + grads + optimizer states
          </text>
          <text fill={ink[300]} x={MEM_X} y={12}>
            GB/GPU
          </text>
          <text fill={ink[300]} x={COMM_X} y={12}>
            comm vs DDP
          </text>
          {rows.map(({stage: s, mem}, i) => {
            const y = ROW_TOP + i * ROW_H;
            const on = s === stage;
            const opacity = on ? 1 : 0.35;
            const segs = [
              {w: x(mem.params), fill: PARAM_FILL},
              {w: x(mem.grads), fill: GRAD_FILL},
              {w: x(mem.optim), fill: OPTIM_FILL},
            ];
            let acc = BAR_X;
            const comm = COMM_PSI[s] / COMM_PSI.ddp;
            return (
              <g key={s}>
                {on ? (
                  <rect
                    fill={alpha(iris[400], 0.08)}
                    height={ROW_H - 4}
                    rx={4}
                    stroke={alpha(iris[400], 0.5)}
                    width={WIDTH - 2}
                    x={1}
                    y={y - 6}
                  />
                ) : null}
                <text fill={on ? ink[50] : ink[300]} fontSize={10} fontWeight={on ? 700 : 400} x={LABEL_X} y={y + 6}>
                  {STAGE_LABEL[s]}
                </text>
                <text fill={on ? ink[200] : ink[400]} x={LABEL_X} y={y + 18}>
                  {STAGE_NAME[s]}
                </text>
                <rect fill={ink[800]} height={BAR_H} rx={2} width={BAR_W} x={BAR_X} y={y} />
                {segs.map((seg, k) => {
                  const sx = acc;
                  acc += seg.w;
                  return (
                    <rect
                      className="transition-all duration-300"
                      fill={seg.fill}
                      fillOpacity={opacity}
                      height={BAR_H}
                      key={k}
                      width={Math.max(seg.w, seg.w > 0 ? 0.75 : 0)}
                      x={sx}
                      y={y}
                    />
                  );
                })}
                <text fill={on ? ink[50] : ink[300]} fontSize={10} x={MEM_X} y={y + 11}>
                  {fmtGb(mem.total)}
                </text>
                <rect fill={ink[800]} height={8} rx={2} width={COMM_W} x={COMM_X} y={y + 3} />
                <rect
                  fill={comm > 1 ? danger[400] : ink[300]}
                  fillOpacity={opacity}
                  height={8}
                  rx={2}
                  width={(COMM_PSI[s] / commMax) * COMM_W}
                  x={COMM_X}
                  y={y + 3}
                />
                <text fill={on ? ink[100] : ink[300]} textAnchor="end" x={WIDTH - 4} y={y + 11}>
                  {comm}×
                </text>
              </g>
            );
          })}
          {DEVICE_GB < scale ? (
            <g>
              <line
                stroke={danger[300]}
                strokeDasharray="3 3"
                x1={deviceX}
                x2={deviceX}
                y1={ROW_TOP - 4}
                y2={ROW_TOP + STAGES.length * ROW_H - 6}
              />
              <text
                fill={danger[300]}
                textAnchor={deviceX > BAR_X + BAR_W - 60 ? 'end' : 'start'}
                x={deviceX > BAR_X + BAR_W - 60 ? deviceX - 3 : deviceX + 3}
                y={ROW_TOP + STAGES.length * ROW_H + 3}>
                {DEVICE_GB} GB
              </text>
            </g>
          ) : null}
          {[
            {label: `params ${fmtGb(selected.params)}`, fill: PARAM_FILL},
            {label: `grads ${fmtGb(selected.grads)}`, fill: GRAD_FILL},
            {label: `optimizer ${fmtGb(selected.optim)}`, fill: OPTIM_FILL},
          ].map((item, k) => (
            <g key={item.label}>
              <rect fill={item.fill} height={9} rx={2} width={12} x={BAR_X + k * 120} y={LEGEND_Y} />
              <text fill={ink[200]} x={BAR_X + k * 120 + 16} y={LEGEND_Y + 8}>
                {item.label} GB
              </text>
            </g>
          ))}
          <text fill={ink[300]} x={BAR_X} y={LEGEND_Y + 24}>
            {STAGE_LABEL[stage]}: {FORMULA[stage]} bytes · fp16 W and G, fp32 W, m, v (K = {K})
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
ZeroMemory.displayName = 'ZeroMemory';

export default ZeroMemory;
