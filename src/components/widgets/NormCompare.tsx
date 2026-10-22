import {type ChangeEvent, type FC, memo, useCallback, useMemo, useState} from 'react';

import {alpha, concept, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
/** Eight fixed activations, mean 0.25. */
const BASE = [0.9, -1.3, 2.2, 0.4, -0.6, 1.5, -1.8, 0.7] as const;
const EPS = 1e-5;
const WIDTH = 600;
const HEIGHT = 188;
const MARGIN = 8;
const GAP = 20;
const PANEL_W = (WIDTH - 2 * MARGIN - 2 * GAP) / 3;
const PLOT_TOP = 40;
const PLOT_H = 112;
const ZERO_Y = PLOT_TOP + PLOT_H / 2;
const OUT_RANGE = 3;
/** Gutters inside each plot for the ±range labels (left) and the μ marker (right). */
const BAR_L = 18;
const BAR_R = 12;
const NICE = [1, 2, 3, 5, 10, 15, 20, 25] as const;
const GRID = alpha(ink[500], 0.5);

interface Stats {
  mean: number;
  std: number;
  rms: number;
}

const stats = (v: readonly number[]): Stats => {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  const rms = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  return {mean, std: Math.sqrt(variance), rms};
};

/** Two decimals, with `-0.00` folded to `0.00`. */
const fmt = (n: number): string => {
  const s = n.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
};

interface Panel {
  title: string;
  formula: string;
  values: number[];
  stats: Stats;
  range: number;
  color: string;
}

const NormCompare: FC<WidgetProps> = memo(() => {
  const [offset, setOffset] = useState(0);
  const [scale, setScale] = useState(1);

  const onOffset = useCallback((e: ChangeEvent<HTMLInputElement>) => setOffset(Number(e.target.value)), []);
  const onScale = useCallback((e: ChangeEvent<HTMLInputElement>) => setScale(Number(e.target.value)), []);

  const panels = useMemo((): Panel[] => {
    const x = BASE.map(b => scale * (b + offset));
    const sx = stats(x);
    const ln = x.map(v => (v - sx.mean) / Math.sqrt(sx.std ** 2 + EPS));
    const rms = x.map(v => v / Math.sqrt(sx.rms ** 2 + EPS));
    const peak = Math.max(...x.map(Math.abs));
    return [
      {
        title: 'input x',
        formula: `${scale.toFixed(2)}·(x₀ ${offset < 0 ? '−' : '+'} ${Math.abs(offset).toFixed(1)})`,
        values: x,
        stats: sx,
        range: NICE.find(n => n >= peak) ?? Math.ceil(peak),
        color: iris[400],
      },
      {
        title: 'LayerNorm',
        formula: '(x − μ) / √(σ² + ε)',
        values: ln,
        stats: stats(ln),
        range: OUT_RANGE,
        color: success[400],
      },
      {
        title: 'RMSNorm',
        formula: 'x / √(mean(x²) + ε)',
        values: rms,
        stats: stats(rms),
        range: OUT_RANGE,
        color: concept.pytorch,
      },
    ];
  }, [offset, scale]);

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">offset</span>
          <input
            aria-label="offset added to every activation"
            className={RANGE_CLASS}
            max={3}
            min={-3}
            onChange={onOffset}
            step={0.1}
            type="range"
            value={offset}
          />
          <span className="font-code text-ink-100 w-9 tabular-nums">{offset.toFixed(1)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">scale</span>
          <input
            aria-label="scale multiplying every activation"
            className={RANGE_CLASS}
            max={4}
            min={0.25}
            onChange={onScale}
            step={0.25}
            type="range"
            value={scale}
          />
          <span className="font-code text-ink-100 w-9 tabular-nums">×{scale.toFixed(2)}</span>
        </label>
      </>
    ),
    [offset, onOffset, onScale, scale],
  );

  const readout = useMemo(() => {
    const [input, ln, rms] = panels;
    return (
      <>
        Input μ = {fmt(input.stats.mean)}, σ = {fmt(input.stats.std)}, rms = {fmt(input.stats.rms)}. LayerNorm comes out
        at μ = {fmt(ln.stats.mean)}, σ = {fmt(ln.stats.std)} for any offset or scale; RMSNorm only divides, so its rms
        is {fmt(rms.stats.rms)} but its mean is μ/rms = {fmt(rms.stats.mean)}, which follows the offset (both ignore the
        scale).
      </>
    );
  }, [panels]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="layernorm vs rmsnorm">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`Eight activations scaled by ${scale} after adding ${offset}, normalised by LayerNorm and RMSNorm`}</title>
        {panels.map((p, i) => {
          const x0 = MARGIN + i * (PANEL_W + GAP);
          const y = (v: number): number => ZERO_Y - (v / p.range) * (PLOT_H / 2);
          const slot = (PANEL_W - BAR_L - BAR_R) / BASE.length;
          const barW = slot * 0.62;
          const meanY = y(p.stats.mean);
          return (
            <g key={p.title}>
              <text fill={ink[100]} fontFamily={MONO} fontSize={11} fontWeight={600} x={x0} y={13}>
                {p.title}
              </text>
              <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={x0} y={27}>
                {p.formula}
              </text>
              <rect fill={ink[900]} height={PLOT_H} rx={3} width={PANEL_W} x={x0} y={PLOT_TOP} />
              <line stroke={GRID} x1={x0} x2={x0 + PANEL_W} y1={y(p.range / 2)} y2={y(p.range / 2)} />
              <line stroke={GRID} x1={x0} x2={x0 + PANEL_W} y1={y(-p.range / 2)} y2={y(-p.range / 2)} />
              <line stroke={ink[500]} x1={x0} x2={x0 + PANEL_W} y1={ZERO_Y} y2={ZERO_Y} />
              <text fill={ink[400]} fontFamily={MONO} fontSize={8} x={x0 + 3} y={PLOT_TOP + 9}>
                +{p.range}
              </text>
              <text fill={ink[400]} fontFamily={MONO} fontSize={8} x={x0 + 3} y={PLOT_TOP + PLOT_H - 3}>
                −{p.range}
              </text>
              {p.values.map((v, j) => {
                const top = Math.min(y(v), ZERO_Y);
                const h = Math.max(0.5, Math.abs(y(v) - ZERO_Y));
                return (
                  <rect
                    fill={p.color}
                    fillOpacity={0.8}
                    height={h}
                    key={j}
                    rx={1.5}
                    width={barW}
                    x={x0 + BAR_L + j * slot + (slot - barW) / 2}
                    y={top}
                  />
                );
              })}
              <line
                stroke={warning[300]}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                x1={x0}
                x2={x0 + PANEL_W}
                y1={meanY}
                y2={meanY}
              />
              <text
                fill={warning[300]}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="end"
                x={x0 + PANEL_W - 3}
                y={meanY < PLOT_TOP + 12 ? meanY + 11 : meanY - 3}>
                μ
              </text>
              <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={x0} y={PLOT_TOP + PLOT_H + 16}>
                μ {fmt(p.stats.mean)} · σ {fmt(p.stats.std)}
              </text>
              <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={x0} y={PLOT_TOP + PLOT_H + 30}>
                rms {fmt(p.stats.rms)}
              </text>
            </g>
          );
        })}
      </svg>
    </WidgetFrame>
  );
});
NormCompare.displayName = 'NormCompare';

export default NormCompare;
