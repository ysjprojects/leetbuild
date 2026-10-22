import {type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {
  type Box,
  type GpuDataTone,
  type GpuFigure,
  type GpuLayout,
  type GpuMarkTone,
  type GpuTone,
  type Point,
  arrayLabelEnd,
  GPU_ARRAY_FONT,
  GPU_ARROW_FONT,
  GPU_CELL_FONT,
  GPU_LABEL_FONT,
  GPU_SUB_FONT,
  layoutGpu,
  THREAD_H,
  THREAD_W,
} from '@/lib/gpuFigure';
import {alpha, concept, danger, ink, iris, warning} from '@/styles/palette';

import {InlineMarkdown} from './Markdown';

/**
 * The CUDA programming model drawn as GPU references draw it (lib/gpuFigure.ts for the spec):
 * dashed scopes holding thread blocks, warps and threads, memory tinted by level, arrays with the
 * slice that matters marked, and arrows for the data that moves. Hover a part with a dot for what it
 * does; a step's focus dims the rest.
 */

const MONO = 'var(--font-code), monospace';
const ACCENT = iris[300];

const TONE: Record<GpuTone, {fill: string; stroke: string; dash?: string; text: string}> = {
  scope: {fill: alpha(ink[700], 0.16), stroke: ink[400], dash: '4 3', text: ink[100]},
  compute: {fill: alpha(ink[600], 0.32), stroke: ink[300], text: ink[50]},
  host: {fill: alpha(concept.http, 0.14), stroke: concept.http, text: ink[50]},
  global: {fill: alpha(concept.cuda, 0.14), stroke: concept.cuda, text: ink[50]},
  shared: {fill: alpha(warning[300], 0.15), stroke: warning[300], text: ink[50]},
  register: {fill: alpha(iris[400], 0.18), stroke: iris[300], text: ink[50]},
};

const DATA: Record<GpuDataTone, {cell: string; edge: string}> = {
  host: {cell: alpha(concept.http, 0.1), edge: alpha(concept.http, 0.55)},
  global: {cell: alpha(concept.cuda, 0.1), edge: alpha(concept.cuda, 0.55)},
  shared: {cell: alpha(warning[300], 0.1), edge: alpha(warning[300], 0.55)},
  register: {cell: alpha(iris[400], 0.12), edge: alpha(iris[400], 0.6)},
};

const MARK: Record<GpuMarkTone, {fill: string; stroke: string}> = {
  host: {fill: alpha(concept.http, 0.4), stroke: concept.http},
  global: {fill: alpha(concept.cuda, 0.4), stroke: concept.cuda},
  shared: {fill: alpha(warning[300], 0.42), stroke: warning[300]},
  register: {fill: alpha(iris[400], 0.45), stroke: iris[300]},
  muted: {fill: alpha(ink[400], 0.42), stroke: ink[300]},
  bad: {fill: alpha(danger[400], 0.35), stroke: danger[400]},
  // Categories (whose a slice is), in hues no memory level uses.
  a: {fill: alpha(concept.kafka, 0.4), stroke: concept.kafka},
  b: {fill: alpha(concept.grpc, 0.4), stroke: concept.grpc},
  c: {fill: alpha(concept.redis, 0.4), stroke: concept.redis},
};

const LEGEND: {tone: GpuDataTone; label: string}[] = [
  {tone: 'host', label: 'host memory'},
  {tone: 'global', label: 'global memory (HBM)'},
  {tone: 'shared', label: 'shared memory'},
  {tone: 'register', label: 'registers'},
];

const WIRE = ink[300];
const HALO = ink[850];
const DOT = alpha(iris[400], 0.85);
const DIM = 0.28;

const polyline = (points: Point[]): string => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');

/** Arrowhead at the end of a polyline, along its last segment. */
const arrowHead = (points: Point[], length = 7, halfWidth = 3.4): string => {
  const tip = points[points.length - 1];
  const back = points[points.length - 2];
  const dx = tip.x - back.x;
  const dy = tip.y - back.y;
  const n = Math.hypot(dx, dy) || 1;
  const ux = dx / n;
  const uy = dy / n;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  return `M${tip.x} ${tip.y}L${bx - uy * halfWidth} ${by + ux * halfWidth}L${bx + uy * halfWidth} ${
    by - ux * halfWidth
  }Z`;
};

/** One thread as the glossary draws it: a squiggle running down into an arrowhead. */
const threadPath = (x: number, top: number): {line: string; head: string} => {
  const bottom = top + THREAD_H - 5;
  const points: Point[] = [];
  for (let k = 0; k <= 8; k += 1)
    points.push({x: x + 2.1 * Math.sin((k * Math.PI) / 2), y: top + ((bottom - top) * k) / 8});
  const tip = {x, y: bottom + 4};
  return {line: polyline([...points, tip]), head: arrowHead([{x, y: bottom}, tip], 4, 2.2)};
};

interface Hover {
  label: string;
  sub?: string;
  detail: string;
  box: Box;
}

/** Hover and keyboard focus for a part with details; nothing for the rest. */
const interaction = (
  id: string | undefined,
  detail: string | undefined,
  label: string,
  onEnter: (id: string) => void,
  onLeave: () => void,
): Record<string, unknown> =>
  id === undefined || detail === undefined
    ? {}
    : {
        'aria-label': `${label}: details`,
        className: 'cursor-help outline-none',
        onBlur: onLeave,
        onFocus: () => onEnter(id),
        onMouseEnter: () => onEnter(id),
        onMouseLeave: onLeave,
        role: 'button',
        tabIndex: 0,
      };

const GpuDiagram: FC<{
  spec: GpuFigure;
  compact?: boolean;
  focus?: readonly string[];
  /** Compact mode: open the figure somewhere roomier. */
  onExpand?: () => void;
}> = memo(({spec, compact = false, focus, onExpand}) => {
  const layout: GpuLayout = useMemo(() => layoutGpu(spec), [spec]);
  const [hover, setHover] = useState<Hover | null>(null);
  const focused = useMemo(() => new Set(focus ?? []), [focus]);
  const dimming = focused.size > 0;

  const details = useMemo(() => {
    const map = new Map<string, Hover>();
    for (const b of layout.boxes)
      if (b.id !== undefined && b.detail !== undefined)
        map.set(b.id, {label: b.label ?? b.id, sub: b.sub, detail: b.detail, box: b.box});
    for (const a of layout.arrays)
      if (a.id !== undefined && a.detail !== undefined)
        map.set(a.id, {label: a.label, sub: a.sub, detail: a.detail, box: a.box});
    for (const t of layout.threads)
      if (t.id !== undefined && t.detail !== undefined)
        map.set(t.id, {label: t.label ?? `${t.count} threads`, detail: t.detail, box: t.box});
    return map;
  }, [layout]);
  const onEnter = useCallback((id: string) => setHover(details.get(id) ?? null), [details]);
  const onLeave = useCallback(() => setHover(null), []);

  const lit = useCallback(
    (id: string | undefined, ancestors: string[], descendants: string[] = []): boolean =>
      !dimming ||
      (id !== undefined && focused.has(id)) ||
      ancestors.some(a => focused.has(a)) ||
      descendants.some(d => focused.has(d)),
    [dimming, focused],
  );
  const litById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const b of layout.boxes) if (b.id !== undefined) map.set(b.id, lit(b.id, b.ancestors, b.descendants));
    for (const p of [...layout.arrays, ...layout.threads])
      if (p.id !== undefined) map.set(p.id, lit(p.id, p.ancestors));
    return map;
  }, [layout, lit]);

  // A step's parts come into view when the compact figure is wider than the pane.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el === null || !compact || focused.size === 0) return;
    const target = [...layout.boxes, ...layout.arrays, ...layout.threads].find(
      p => p.id !== undefined && focused.has(p.id),
    );
    if (target === undefined) return;
    const scale = el.scrollWidth / layout.width;
    el.scrollTo({left: Math.max(0, (target.box.x - layout.minX) * scale - el.clientWidth / 4), behavior: 'smooth'});
  }, [compact, focused, layout]);

  const legend = useMemo(() => {
    const used = new Set<string>();
    for (const b of layout.boxes) used.add(b.tone);
    for (const a of layout.arrays) {
      used.add(a.tone);
      for (const m of a.marks) used.add(m.tone);
    }
    return LEGEND.filter(l => used.has(l.tone));
  }, [layout]);
  const hasDetails = details.size > 0;

  const tooltip =
    hover === null ? null : (
      <div
        className="border-ink-600 bg-ink-800 text-ink-200 pointer-events-none absolute z-10 w-64 rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug shadow-xl"
        role="tooltip"
        style={{
          left: `${((hover.box.x + hover.box.w / 2 - layout.minX) / layout.width) * 100}%`,
          // Near the top a tooltip above the part would leave the figure: it opens below instead.
          ...((hover.box.y - layout.minY) / layout.height < 0.3
            ? {
                top: `${((hover.box.y + hover.box.h - layout.minY) / layout.height) * 100}%`,
                transform: 'translate(-50%, 8px)',
              }
            : {
                top: `${((hover.box.y - layout.minY) / layout.height) * 100}%`,
                transform: 'translate(-50%, calc(-100% - 8px))',
              }),
        }}>
        <p className="text-ink-50 font-semibold">
          {hover.label}
          {hover.sub !== undefined ? (
            <span className="font-code text-ink-300 ml-1.5 text-[10px]">{hover.sub}</span>
          ) : null}
        </p>
        <p className="mt-0.5">
          <InlineMarkdown source={hover.detail} />
        </p>
      </div>
    );

  const svg = (
    <svg
      className="block"
      role="img"
      style={{width: '100%', height: 'auto', fontVariantLigatures: 'none'}}
      viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}>
      <title>GPU figure</title>
      {layout.boxes.map((b, i) => {
        const s = TONE[b.tone];
        const {x, y, w, h} = b.box;
        const hot = hover !== null && b.id !== undefined && details.get(b.id) === hover;
        const name = [b.label, b.count].filter(Boolean).join(' ') || (b.id ?? 'box');
        return (
          <g
            key={`b${i}`}
            opacity={lit(b.id, b.ancestors, b.descendants) ? 1 : DIM}
            {...interaction(b.id, b.detail, name, onEnter, onLeave)}>
            <rect
              fill={s.fill}
              height={h}
              rx={b.leaf ? 6 : 9}
              stroke={hot ? ACCENT : s.stroke}
              strokeDasharray={s.dash}
              strokeWidth={hot ? 2 : 1.2}
              width={w}
              x={x}
              y={y}
            />
            {b.leaf ? (
              <>
                <text
                  fill={s.text}
                  fontSize={GPU_LABEL_FONT}
                  fontWeight={600}
                  textAnchor="middle"
                  x={x + w / 2}
                  y={y + (b.sub === undefined ? h / 2 + 4 : 17)}>
                  {b.label}
                  {b.count !== undefined ? (
                    <tspan dx={6} fill={ACCENT} fontFamily={MONO} fontSize={10.5} fontWeight={700}>
                      {b.count}
                    </tspan>
                  ) : null}
                </text>
                {b.sub !== undefined ? (
                  <text
                    fill={ink[300]}
                    fontFamily={MONO}
                    fontSize={GPU_SUB_FONT}
                    textAnchor="middle"
                    x={x + w / 2}
                    y={y + 31}>
                    {b.sub}
                  </text>
                ) : null}
              </>
            ) : (
              <>
                {b.label !== undefined ? (
                  <text fill={s.text} fontSize={GPU_LABEL_FONT} fontWeight={600} x={x + 10} y={y + 21}>
                    {b.label}
                  </text>
                ) : null}
                {b.count !== undefined ? (
                  <text
                    fill={ACCENT}
                    fontFamily={MONO}
                    fontSize={10.5}
                    fontWeight={700}
                    textAnchor="end"
                    x={x + w - 12}
                    y={y + 21}>
                    {b.count}
                  </text>
                ) : null}
                {b.sub !== undefined ? (
                  <text
                    fill={ink[300]}
                    fontFamily={MONO}
                    fontSize={GPU_SUB_FONT}
                    x={x + 10}
                    y={y + (b.label === undefined && b.count === undefined ? 21 : 33)}>
                    {b.sub}
                  </text>
                ) : null}
              </>
            )}
            {b.detail !== undefined && b.id !== undefined ? (
              <circle cx={x + w - 6} cy={y + 6} fill={DOT} r={2.2} />
            ) : null}
          </g>
        );
      })}
      {layout.arrays.map((a, i) => {
        const tone = DATA[a.tone];
        const {x: ox, y: oy} = a.origin;
        const labels = a.cells;
        const hot = hover !== null && a.id !== undefined && details.get(a.id) === hover;
        return (
          <g
            key={`a${i}`}
            opacity={lit(a.id, a.ancestors) ? 1 : DIM}
            {...interaction(a.id, a.detail, a.label, onEnter, onLeave)}>
            <text
              fill={hot ? ACCENT : ink[100]}
              fontFamily={MONO}
              fontSize={GPU_ARRAY_FONT}
              x={a.box.x}
              y={a.box.y + 11}>
              {a.label}
              {a.sub !== undefined ? (
                <tspan dx={8} fill={ink[300]} fontSize={GPU_SUB_FONT}>
                  {a.sub}
                </tspan>
              ) : null}
            </text>
            {Array.from({length: a.rows}, (_, r) =>
              Array.from({length: a.cols}, (__, c) => (
                <rect
                  fill={tone.cell}
                  height={a.cell}
                  key={`${r}:${c}`}
                  stroke={tone.edge}
                  strokeWidth={0.8}
                  width={a.cell}
                  x={ox + c * a.cell}
                  y={oy + r * a.cell}
                />
              )),
            )}
            {a.marks.map((m, k) => {
              const [r0, r1] = m.rows ?? [0, a.rows - 1];
              const style = MARK[m.tone];
              return (
                <rect
                  fill={style.fill}
                  height={(r1 - r0 + 1) * a.cell}
                  key={`m${k}`}
                  rx={1.5}
                  stroke={style.stroke}
                  strokeDasharray={m.tone === 'muted' ? '3 2' : undefined}
                  strokeWidth={1.4}
                  width={(m.cols[1] - m.cols[0] + 1) * a.cell}
                  x={ox + m.cols[0] * a.cell}
                  y={oy + r0 * a.cell}
                />
              );
            })}
            {labels !== undefined && a.cell >= 12
              ? Array.from({length: a.rows * a.cols}, (_, k) => {
                  const text = labels === 'index' ? String(a.rows === 1 ? k : k % a.cols) : labels[k];
                  if (text === undefined || text === '') return null;
                  return (
                    <text
                      fill={ink[100]}
                      fontFamily={MONO}
                      fontSize={GPU_CELL_FONT}
                      key={`c${k}`}
                      textAnchor="middle"
                      x={ox + (k % a.cols) * a.cell + a.cell / 2}
                      y={oy + Math.floor(k / a.cols) * a.cell + a.cell / 2 + 2.7}>
                      {text}
                    </text>
                  );
                })
              : null}
            {a.marks.map((m, k) => {
              if (m.label === undefined) return null;
              const [r0, r1] = m.rows ?? [0, a.rows - 1];
              const cx = ox + ((m.cols[0] + m.cols[1] + 1) / 2) * a.cell;
              return a.rows === 1 ? (
                <text
                  fill={MARK[m.tone].stroke}
                  fontFamily={MONO}
                  fontSize={8.5}
                  key={`ml${k}`}
                  textAnchor="middle"
                  x={cx}
                  y={oy + a.cell + 10}>
                  {m.label}
                </text>
              ) : (
                <text
                  fill={ink[50]}
                  fontFamily={MONO}
                  fontSize={8.5}
                  key={`ml${k}`}
                  paintOrder="stroke"
                  stroke={HALO}
                  strokeWidth={2.5}
                  textAnchor="middle"
                  x={cx}
                  y={oy + ((r0 + r1 + 1) / 2) * a.cell + 3}>
                  {m.label}
                </text>
              );
            })}
            {a.continues ? (
              <text
                fill={ink[300]}
                fontFamily={MONO}
                fontSize={12}
                x={ox + a.cols * a.cell + 4}
                y={oy + (a.rows * a.cell) / 2 + 4}>
                …
              </text>
            ) : null}
            {a.detail !== undefined && a.id !== undefined ? (
              <circle cx={arrayLabelEnd(a) + 5} cy={a.box.y + 7} fill={DOT} r={2.2} />
            ) : null}
          </g>
        );
      })}
      {layout.threads.map((t, i) => (
        <g
          key={`t${i}`}
          opacity={lit(t.id, t.ancestors) ? 1 : DIM}
          {...interaction(t.id, t.detail, t.label ?? `${t.count} threads`, onEnter, onLeave)}>
          {Array.from({length: t.count}, (_, k) => {
            const idle = k >= t.count - t.idle;
            const {line, head} = threadPath(t.box.x + k * THREAD_W + THREAD_W / 2, t.box.y + 1);
            const color = idle ? ink[500] : iris[300];
            return (
              <g key={k} opacity={idle ? 0.55 : 1}>
                <path d={line} fill="none" stroke={color} strokeWidth={1.1} />
                <path d={head} fill={color} />
              </g>
            );
          })}
          {t.continues ? (
            <text fill={ink[300]} fontFamily={MONO} fontSize={12} x={t.box.x + t.count * THREAD_W + 4} y={t.box.y + 12}>
              …
            </text>
          ) : null}
          {t.label !== undefined ? (
            <text fill={ink[300]} fontFamily={MONO} fontSize={GPU_SUB_FONT} x={t.box.x} y={t.box.y + THREAD_H + 9}>
              {t.label}
            </text>
          ) : null}
          {t.detail !== undefined && t.id !== undefined ? (
            <circle cx={t.box.x + t.count * THREAD_W + 3} cy={t.box.y + 3} fill={DOT} r={2.2} />
          ) : null}
        </g>
      ))}
      {layout.gaps.map((g, i) => (
        <text fill={ink[300]} fontFamily={MONO} fontSize={13} key={`g${i}`} textAnchor="middle" x={g.x} y={g.y}>
          {g.text}
        </text>
      ))}
      {layout.arrows.map((a, i) => {
        const on = !dimming || ((litById.get(a.from) ?? true) && (litById.get(a.to) ?? true));
        return (
          <g key={`w${i}`} opacity={on ? 1 : DIM}>
            <path
              d={polyline(a.points)}
              fill="none"
              stroke={WIRE}
              strokeDasharray={a.dashed ? '4 3' : undefined}
              strokeWidth={1.3}
            />
            <path d={arrowHead(a.points)} fill={WIRE} />
          </g>
        );
      })}
      {layout.arrows.map((a, i) =>
        a.label !== undefined && a.labelAt !== undefined ? (
          <text
            fill={ink[100]}
            fontFamily={MONO}
            fontSize={GPU_ARROW_FONT}
            key={`l${i}`}
            opacity={!dimming || ((litById.get(a.from) ?? true) && (litById.get(a.to) ?? true)) ? 1 : DIM}
            paintOrder="stroke"
            stroke={HALO}
            strokeLinejoin="round"
            strokeWidth={3.2}
            textAnchor={a.labelAnchor}
            x={a.labelAt.x}
            y={a.labelAt.y}>
            {a.label}
          </text>
        ) : null,
      )}
    </svg>
  );

  return (
    <div className="border-ink-700 bg-ink-850 rounded-xl border p-2">
      {compact && onExpand !== undefined ? (
        <div className="mb-1 flex items-center justify-end gap-2 px-1">
          <button
            className="border-ink-600 bg-ink-800 text-ink-200 hover:text-ink-50 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition"
            onClick={onExpand}
            title="The whole figure, at full size"
            type="button">
            ⤢ full figure
          </button>
        </div>
      ) : null}
      <div className={compact ? 'overflow-x-auto' : undefined} ref={scroller}>
        <div
          className="relative mx-auto"
          style={{
            maxWidth: layout.width * (compact ? 1 : 1.08),
            // In the pane a wide figure scrolls sideways rather than shrinking its text below 80%.
            minWidth: compact ? layout.width * 0.8 : undefined,
          }}>
          {svg}
          {tooltip}
        </div>
      </div>
      {legend.length > 0 || hasDetails ? (
        <p className="text-ink-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px]">
          {legend.map(l => (
            <span className="inline-flex items-center gap-1" key={l.tone}>
              <svg aria-hidden height={9} viewBox="0 0 9 9" width={9}>
                <rect
                  fill={DATA[l.tone].cell}
                  height={8}
                  rx={1.5}
                  stroke={TONE[l.tone].stroke}
                  width={8}
                  x={0.5}
                  y={0.5}
                />
              </svg>
              {l.label}
            </span>
          ))}
          {hasDetails ? <span>hover a part marked with a dot for what it does</span> : null}
        </p>
      ) : null}
    </div>
  );
});
GpuDiagram.displayName = 'GpuDiagram';

export default GpuDiagram;
