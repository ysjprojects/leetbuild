import {type ChangeEvent, type FC, type MouseEvent, memo, useCallback, useMemo, useState} from 'react';

import {alpha, ink, iris, success, warning} from '@/styles/palette';

import WidgetFrame, {RANGE_CLASS, tabClass} from './frame';
import type {WidgetProps} from './index';

const MONO = 'var(--font-code), monospace';
const PATTERNS = ['contiguous', 'strided', 'misaligned', 'float4'] as const;
type Pattern = (typeof PATTERNS)[number];

const WARP = 32;
const SECTOR = 32;
const LINE = 128;
const LEFT = 48;
const WIDTH = 600;
const STRIP_W = WIDTH - LEFT - 8;
const LANE = STRIP_W / WARP;
const THREAD_Y = 20;
const THREAD_H = 14;
const MEM_Y = 92;
const MEM_H = 22;
const HEIGHT = 152;

const SECTOR_FILL = alpha(warning[400], 0.28);
const LINK = alpha(iris[400], 0.7);

const isPattern = (v: string): v is Pattern => (PATTERNS as readonly string[]).includes(v);

/** Byte address thread `t` loads from (array base aligned to a 128-byte line). */
const addressOf = (pattern: Pattern, t: number, stride: number, offset: number): number => {
  switch (pattern) {
    case 'contiguous':
      return 4 * t;
    case 'strided':
      return 4 * t * stride;
    case 'misaligned':
      return 4 * (t + offset);
    case 'float4':
      return 16 * t;
  }
};

const Coalescing: FC<WidgetProps> = memo(() => {
  const [pattern, setPattern] = useState<Pattern>('contiguous');
  const [stride, setStride] = useState(2);
  const [offset, setOffset] = useState(1);

  const onPattern = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    const v = e.currentTarget.value;
    if (isPattern(v)) setPattern(v);
  }, []);
  const onStride = useCallback((e: ChangeEvent<HTMLInputElement>) => setStride(Number(e.target.value)), []);
  const onOffset = useCallback((e: ChangeEvent<HTMLInputElement>) => setOffset(Number(e.target.value)), []);

  const size = pattern === 'float4' ? 16 : 4;
  const model = useMemo(() => {
    const addrs = Array.from({length: WARP}, (_, t) => addressOf(pattern, t, stride, offset));
    const sectors = new Set<number>();
    const lines = new Set<number>();
    for (const a of addrs) {
      for (let s = Math.floor(a / SECTOR); s <= Math.floor((a + size - 1) / SECTOR); s++) sectors.add(s);
      for (let l = Math.floor(a / LINE); l <= Math.floor((a + size - 1) / LINE); l++) lines.add(l);
    }
    const end = Math.max(...addrs) + size;
    const span = Math.max(LINE, Math.ceil(end / LINE) * LINE);
    return {addrs, sectors: [...sectors].sort((a, b) => a - b), lines: lines.size, span};
  }, [offset, pattern, size, stride]);

  const useful = WARP * size;
  const fetched = model.sectors.length * SECTOR;
  const efficiency = Number(((useful / fetched) * 100).toFixed(1));
  const scale = STRIP_W / model.span;
  const sectorW = SECTOR * scale;
  const lineCount = model.span / LINE;
  const lineLabelEvery = Math.max(1, Math.ceil(34 / (LINE * scale)));

  const controls = useMemo(
    () => (
      <>
        <div className="flex items-center gap-1">
          {PATTERNS.map(p => (
            <button
              aria-pressed={p === pattern}
              className={tabClass(p === pattern)}
              key={p}
              onClick={onPattern}
              type="button"
              value={p}>
              {p}
            </button>
          ))}
        </div>
        {pattern === 'strided' ? (
          <label className="flex items-center gap-1.5">
            <span className="text-ink-300">stride</span>
            <input
              aria-label="stride in elements"
              className={RANGE_CLASS}
              max={32}
              min={1}
              onChange={onStride}
              step={1}
              type="range"
              value={stride}
            />
            <span className="font-code text-ink-100 tabular-nums">{stride}</span>
          </label>
        ) : null}
        {pattern === 'misaligned' ? (
          <label className="flex items-center gap-1.5">
            <span className="text-ink-300">offset</span>
            <input
              aria-label="offset in elements"
              className={RANGE_CLASS}
              max={32}
              min={0}
              onChange={onOffset}
              step={1}
              type="range"
              value={offset}
            />
            <span className="font-code text-ink-100 tabular-nums">{offset}</span>
          </label>
        ) : null}
      </>
    ),
    [offset, onOffset, onPattern, onStride, pattern, stride],
  );

  const readout = useMemo(() => {
    const access = (() => {
      switch (pattern) {
        case 'contiguous':
          return 'x[tid], 4 B each';
        case 'strided':
          return `x[tid·${stride}], 4 B each`;
        case 'misaligned':
          return `x[tid + ${offset}] (base ${4 * offset} B past a line start), 4 B each`;
        case 'float4':
          return 'reinterpret_cast<float4*>(x)[tid], 16 B each';
      }
    })();
    return (
      <>
        <code className="font-code text-iris-200">{access}</code>: the warp needs {useful} B and touches{' '}
        <b className="text-ink-100">{model.sectors.length} sectors</b> of 32 B in {model.lines} 128-byte line
        {model.lines === 1 ? '' : 's'}, so {fetched} B are fetched for{' '}
        <b className="text-ink-100">{efficiency}% efficiency</b> (useful / fetched).
      </>
    );
  }, [efficiency, fetched, model, offset, pattern, stride, useful]);

  return (
    <WidgetFrame controls={controls} readout={readout} title="coalescing: one warp's loads → 32-byte sectors">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <title>{`${pattern} access: ${model.sectors.length} sectors, ${fetched} bytes fetched, ${efficiency}% efficiency`}</title>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={THREAD_Y + 10}>
          warp
        </text>
        <text fill={ink[300]} fontFamily={MONO} fontSize={9} x={4} y={MEM_Y + 15}>
          memory
        </text>
        {Array.from({length: WARP}, (_, t) => {
          const x = LEFT + t * LANE;
          return (
            <g key={t}>
              {t % 8 === 0 || t === WARP - 1 ? (
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
                fill={alpha(iris[400], 0.3)}
                height={THREAD_H}
                rx={2}
                stroke={iris[400]}
                strokeWidth={0.75}
                width={LANE - 2}
                x={x + 1}
                y={THREAD_Y}
              />
              <line
                stroke={LINK}
                strokeWidth={0.8}
                x1={x + LANE / 2}
                x2={LEFT + (model.addrs[t] + size / 2) * scale}
                y1={THREAD_Y + THREAD_H}
                y2={MEM_Y}
              />
            </g>
          );
        })}
        <rect fill={ink[800]} height={MEM_H} width={STRIP_W} x={LEFT} y={MEM_Y} />
        {model.sectors.map(s => (
          <rect
            fill={SECTOR_FILL}
            height={MEM_H}
            key={s}
            stroke={sectorW >= 6 ? warning[400] : 'none'}
            strokeWidth={0.75}
            width={sectorW}
            x={LEFT + s * sectorW}
            y={MEM_Y}
          />
        ))}
        {model.addrs.map((a, t) => (
          <rect
            fill={success[400]}
            height={MEM_H - 10}
            key={t}
            width={Math.max(1, size * scale - (size * scale > 4 ? 1 : 0))}
            x={LEFT + a * scale}
            y={MEM_Y + 5}
          />
        ))}
        {Array.from({length: lineCount + 1}, (_, l) => {
          const x = LEFT + l * LINE * scale;
          return (
            <g key={l}>
              <line stroke={ink[300]} strokeWidth={1} x1={x} x2={x} y1={MEM_Y - 4} y2={MEM_Y + MEM_H + 4} />
              {l % lineLabelEvery === 0 && l < lineCount ? (
                <text fill={ink[400]} fontFamily={MONO} fontSize={9} x={x + 2} y={MEM_Y + MEM_H + 13}>
                  {l * LINE}
                </text>
              ) : null}
            </g>
          );
        })}
        <g fontFamily={MONO} fontSize={9}>
          <rect fill={success[400]} height={8} width={8} x={LEFT} y={HEIGHT - 13} />
          <text fill={ink[300]} x={LEFT + 12} y={HEIGHT - 5}>
            useful bytes
          </text>
          <rect
            fill={SECTOR_FILL}
            height={8}
            stroke={warning[400]}
            strokeWidth={0.75}
            width={8}
            x={LEFT + 96}
            y={HEIGHT - 13}
          />
          <text fill={ink[300]} x={LEFT + 108} y={HEIGHT - 5}>
            32-B sector fetched
          </text>
          <line stroke={ink[300]} x1={LEFT + 232} x2={LEFT + 232} y1={HEIGHT - 14} y2={HEIGHT - 4} />
          <text fill={ink[300]} x={LEFT + 238} y={HEIGHT - 5}>
            128-B line boundary (byte offset)
          </text>
        </g>
      </svg>
    </WidgetFrame>
  );
});
Coalescing.displayName = 'Coalescing';

export default Coalescing;
