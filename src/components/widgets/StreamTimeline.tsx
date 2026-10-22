import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
/** Kernel time for the whole batch; copies scale from it by the copy-to-compute ratio. */
const KERNEL_MS = 12;
const MIN_CHUNKS = 2;
const MAX_CHUNKS = 8;
const WIDTH = 620;
const LEFT = 92;
const RIGHT = 54;
const PLOT_W = WIDTH - LEFT - RIGHT;
const ROW_H = 18;
const ROW_GAP = 4;
const HEAD = 16;
const PANEL_GAP = 10;

type Kind = 'h2d' | 'kernel' | 'd2h';

interface Op {
  stream: number;
  chunk: number;
  kind: Kind;
  ms: number;
}

interface Scheduled extends Op {
  engine: number;
  start: number;
  end: number;
}

const COLOR: Record<Kind, string> = {h2d: iris[400], kernel: success[400], d2h: warning[400]};
const NAME: Record<Kind, string> = {h2d: 'H2D', kernel: 'kernel', d2h: 'D2H'};
/** Row labels indexed by engine. */
const ROWS_ONE = ['copy engine', 'compute engine'];
const ROWS_TWO = ['H2D engine', 'compute engine', 'D2H engine'];

/** Engine rows: 0 copy (H2D, and D2H too with one engine), 1 compute, 2 the second copy engine (D2H). */
const engineOf = (kind: Kind, copyEngines: number): number => {
  switch (kind) {
    case 'h2d':
      return 0;
    case 'kernel':
      return 1;
    case 'd2h':
      return copyEngines === 2 ? 2 : 0;
  }
};

/**
 * Event-driven list schedule. Ops arrive in issue order; within a stream each op waits for the previous one, and
 * each engine runs one op at a time, always the one that can start earliest (ties go to the earlier-issued op).
 */
const simulate = (ops: Op[], copyEngines: number): Scheduled[] => {
  const pending = [...ops];
  const free = [0, 0, 0];
  const streamEnd = new Map<number, number>();
  const out: Scheduled[] = [];
  while (pending.length > 0) {
    const heads = new Set<number>();
    let best = -1;
    let bestStart = Infinity;
    pending.forEach((op, i) => {
      if (heads.has(op.stream)) return;
      heads.add(op.stream);
      const start = Math.max(free[engineOf(op.kind, copyEngines)], streamEnd.get(op.stream) ?? 0);
      if (start < bestStart) {
        best = i;
        bestStart = start;
      }
    });
    const [op] = pending.splice(best, 1);
    const engine = engineOf(op.kind, copyEngines);
    const end = bestStart + op.ms;
    free[engine] = end;
    streamEnd.set(op.stream, end);
    out.push({...op, engine, start: bestStart, end});
  }
  return out;
};

const ms = (t: number): string => `${t.toFixed(1)} ms`;

const StreamTimeline: FC<WidgetProps> = memo(() => {
  const [chunks, setChunks] = useState(4);
  const [ratio, setRatio] = useState(0.5);
  const [copyEngines, setCopyEngines] = useState(2);

  const onChunks = useCallback((e: ChangeEvent<HTMLInputElement>) => setChunks(Number(e.target.value)), []);
  const onRatio = useCallback((e: ChangeEvent<HTMLInputElement>) => setRatio(Number(e.target.value)), []);
  const onEngines = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => setCopyEngines(Number(e.currentTarget.value)),
    [],
  );

  const sim = useMemo(() => {
    const copyMs = ratio * KERNEL_MS;
    const serial = simulate(
      [
        {stream: 0, chunk: 0, kind: 'h2d', ms: copyMs},
        {stream: 0, chunk: 0, kind: 'kernel', ms: KERNEL_MS},
        {stream: 0, chunk: 0, kind: 'd2h', ms: copyMs},
      ],
      copyEngines,
    );
    const issue: Op[] = [];
    for (let c = 0; c < chunks; c++) {
      for (const kind of ['h2d', 'kernel', 'd2h'] as const) {
        issue.push({stream: c, chunk: c, kind, ms: (kind === 'kernel' ? KERNEL_MS : copyMs) / chunks});
      }
    }
    const piped = simulate(issue, copyEngines);
    const serialMs = Math.max(...serial.map(o => o.end));
    const pipedMs = Math.max(...piped.map(o => o.end));
    const busy = [0, 0, 0];
    for (const o of piped) busy[o.engine] += o.ms;
    const bottleneck = busy.indexOf(Math.max(...busy));
    return {copyMs, serial, piped, serialMs, pipedMs, busy, bottleneck};
  }, [chunks, copyEngines, ratio]);

  const rows = copyEngines === 2 ? ROWS_TWO : ROWS_ONE;
  const panelH = HEAD + rows.length * (ROW_H + ROW_GAP);
  const height = 2 * panelH + PANEL_GAP + 20;
  const scale = PLOT_W / Math.max(sim.serialMs, sim.pipedMs);
  const speedup = sim.serialMs / sim.pipedMs;

  const controls = useMemo(
    () => (
      <>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">chunks</span>
          <input
            aria-label="chunks, one stream each"
            className={RANGE_CLASS}
            max={MAX_CHUNKS}
            min={MIN_CHUNKS}
            onChange={onChunks}
            step={1}
            type="range"
            value={chunks}
          />
          <span className="font-code text-ink-100 tabular-nums">{chunks}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">copy : compute</span>
          <input
            aria-label="copy-to-compute time ratio"
            className={RANGE_CLASS}
            max={2}
            min={0.25}
            onChange={onRatio}
            step={0.25}
            type="range"
            value={ratio}
          />
          <span className="font-code text-ink-100 tabular-nums">{ratio.toFixed(2)}</span>
        </label>
        <div className="flex items-center gap-1">
          {[1, 2].map(e => (
            <button
              aria-pressed={e === copyEngines}
              className={tabClass(e === copyEngines)}
              key={e}
              onClick={onEngines}
              type="button"
              value={e}>
              {e} copy engine{e === 1 ? '' : 's'}
            </button>
          ))}
        </div>
      </>
    ),
    [chunks, copyEngines, onChunks, onEngines, onRatio, ratio],
  );

  const readout = useMemo(
    () => (
      <>
        1 stream: {ms(sim.copyMs)} H2D + {ms(KERNEL_MS)} kernel + {ms(sim.copyMs)} D2H = {ms(sim.serialMs)}. {chunks}{' '}
        streams: <b className="text-ink-100">{ms(sim.pipedMs)}</b>, {speedup.toFixed(2)}× faster. The floor is the{' '}
        {rows[sim.bottleneck]}, busy {ms(sim.busy[sim.bottleneck])}
        {copyEngines === 1 && sim.bottleneck === 0 ? ' (H2D and D2H share it and never overlap)' : ''}
        {sim.pipedMs - sim.busy[sim.bottleneck] < 0.05
          ? ', and it never idles, so the schedule sits on that floor.'
          : `; it idles the other ${ms(sim.pipedMs - sim.busy[sim.bottleneck])} (pipeline fill, drain and stalls).`}
      </>
    ),
    [chunks, copyEngines, rows, sim, speedup],
  );

  const drawPanel = (y0: number, ops: Scheduled[], title: string, totalMs: number, serial: boolean): JSX.Element => (
    <g>
      <text fill={ink[200]} fontFamily={MONO} fontSize={9} x={4} y={y0 + 10}>
        {title}
      </text>
      {rows.map((label, r) => {
        const y = y0 + HEAD + r * (ROW_H + ROW_GAP);
        return (
          <g key={label}>
            <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={y + 12.5}>
              {label}
            </text>
            <rect fill={ink[800]} height={ROW_H} rx={2} width={PLOT_W} x={LEFT} y={y} />
          </g>
        );
      })}
      {ops.map((o, i) => {
        const x = LEFT + o.start * scale;
        const w = o.ms * scale;
        const y = y0 + HEAD + o.engine * (ROW_H + ROW_GAP);
        const label = serial ? NAME[o.kind] : `${o.chunk}`;
        return (
          <g key={i}>
            <rect fill={COLOR[o.kind]} height={ROW_H} rx={2} stroke={ink[850]} strokeWidth={1} width={w} x={x} y={y}>
              <title>{`${NAME[o.kind]} chunk ${o.chunk}: ${ms(o.start)} → ${ms(o.end)}`}</title>
            </rect>
            {w >= label.length * 5.6 + 4 ? (
              <text
                fill={ink[950]}
                fontFamily={MONO}
                fontSize={9}
                pointerEvents="none"
                textAnchor="middle"
                x={x + w / 2}
                y={y + 12.5}>
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
      <line
        stroke={ink[100]}
        strokeDasharray="2 2"
        strokeWidth={1}
        x1={LEFT + totalMs * scale}
        x2={LEFT + totalMs * scale}
        y1={y0 + HEAD - 3}
        y2={y0 + panelH - ROW_GAP + 1}
      />
      <text
        fill={ink[50]}
        fontFamily={MONO}
        fontSize={9}
        x={LEFT + totalMs * scale + 4}
        y={y0 + HEAD + (rows.length * (ROW_H + ROW_GAP)) / 2 + 3}>
        {ms(totalMs)}
      </text>
    </g>
  );

  const step = sim.serialMs > 40 ? 10 : 5;
  const ticks = Array.from({length: Math.floor(Math.max(sim.serialMs, sim.pipedMs) / step) + 1}, (_, i) => i * step);
  const axisY = 2 * panelH + PANEL_GAP + 4;
  return (
    <WidgetFrame controls={controls} readout={readout} title="cuda streams: overlapping copies and kernels">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>{`One stream ${ms(sim.serialMs)} against ${chunks} streams ${ms(
          sim.pipedMs,
        )} with ${copyEngines} copy engine${copyEngines === 1 ? '' : 's'}`}</title>
        {drawPanel(0, sim.serial, '1 stream: H2D all → kernel all → D2H all', sim.serialMs, true)}
        {drawPanel(
          panelH + PANEL_GAP,
          sim.piped,
          `${chunks} streams, chunk i on stream i: H2D ${ms(sim.copyMs / chunks)} · kernel ${ms(
            KERNEL_MS / chunks,
          )} · D2H ${ms(sim.copyMs / chunks)}`,
          sim.pipedMs,
          false,
        )}
        <g fill={ink[400]} fontFamily={MONO} fontSize={8} textAnchor="middle">
          {ticks.map(t => (
            <g key={t}>
              <line
                stroke={ink[600]}
                strokeWidth={0.75}
                x1={LEFT + t * scale}
                x2={LEFT + t * scale}
                y1={axisY}
                y2={axisY + 3}
              />
              <text x={LEFT + t * scale} y={axisY + 12}>
                {t}
              </text>
            </g>
          ))}
        </g>
        <text fill={ink[400]} fontFamily={MONO} fontSize={8} x={4} y={axisY + 12}>
          time (ms)
        </text>
      </svg>
    </WidgetFrame>
  );
});
StreamTimeline.displayName = 'StreamTimeline';

export default StreamTimeline;
