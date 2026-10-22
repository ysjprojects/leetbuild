import {type FC, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {
  type Architecture,
  type ArchKind,
  type ArchLayout,
  type Box,
  type PlacedBlock,
  type PlacedText,
  type Point,
  LABEL_FONT,
  layoutArchitecture,
  NOTE_FONT,
  SUB_FONT,
} from '@/lib/architecture';
import {alpha, concept, danger, ink, iris} from '@/styles/palette';

import {InlineMarkdown} from './Markdown';

/**
 * A model or kernel drawn as a stack of layers read bottom to top (see lib/architecture.ts for the
 * spec). Interactive: hovering or tabbing to a box shows what it computes; "shapes" writes the
 * tensor each layer hands on beside its arrow; `focus` lights the boxes a step builds and dims the
 * rest. `compact` (the problem pane) draws the main stack only, in a scrolling column, and offers
 * the full figure — callouts and insets — through `onExpand`.
 */

const MONO = 'var(--font-code), monospace';

const KIND_STYLE: Record<ArchKind, {fill: string; stroke: string; text: string}> = {
  layer: {fill: ink[900], stroke: ink[300], text: ink[50]},
  norm: {fill: ink[900], stroke: ink[300], text: ink[50]},
  embed: {fill: ink[900], stroke: ink[300], text: ink[50]},
  head: {fill: ink[900], stroke: ink[300], text: ink[50]},
  io: {fill: ink[850], stroke: ink[400], text: ink[100]},
  ffn: {fill: ink[700], stroke: ink[300], text: ink[50]},
  attention: {fill: alpha(iris[400], 0.3), stroke: iris[300], text: ink[50]},
  loss: {fill: alpha(danger[400], 0.16), stroke: danger[300], text: ink[50]},
  host: {fill: alpha(concept.http, 0.16), stroke: concept.http, text: ink[50]},
  memory: {fill: alpha(concept.cuda, 0.16), stroke: concept.cuda, text: ink[50]},
  kernel: {fill: alpha(iris[400], 0.22), stroke: iris[300], text: ink[50]},
};

const FRAME_STYLE = {
  model: {fill: alpha(ink[700], 0.32), stroke: ink[600], dash: undefined},
  block: {fill: alpha(iris[400], 0.12), stroke: alpha(iris[400], 0.5), dash: undefined},
  dotted: {fill: alpha(ink[700], 0.26), stroke: ink[400], dash: '2 4'},
} as const;

const WIRE = ink[300];
const LEADER = ink[400];
const ACCENT = iris[300];

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

const polyline = (points: Point[]): string => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');

/** A text line with `**…**` spans drawn in the accent colour, as the gallery highlights its figures. */
const Highlighted: FC<{line: string}> = memo(({line}) => (
  <>
    {line.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <tspan fill={ACCENT} fontWeight={700} key={i}>
          {part.slice(2, -2)}
        </tspan>
      ) : (
        <tspan key={i}>{part}</tspan>
      ),
    )}
  </>
));
Highlighted.displayName = 'ArchHighlighted';

const TextBlock: FC<{text: PlacedText; mono?: boolean; size?: number; color?: string}> = memo(
  ({text, mono = false, size = NOTE_FONT, color = ink[100]}) => (
    <text
      fill={color}
      fontFamily={mono ? MONO : undefined}
      fontSize={size}
      fontWeight={mono ? 400 : 600}
      textAnchor={text.anchor}
      x={text.x}
      y={text.y}>
      {text.lines.map((line, i) => (
        <tspan dy={i === 0 ? 0 : 15} key={i} x={text.x}>
          <Highlighted line={line} />
        </tspan>
      ))}
    </text>
  ),
);
TextBlock.displayName = 'ArchTextBlock';

/**
 * The `N ×` label and a curly brace along the left edge of a repeated block's frame: at the bottom,
 * as the gallery has it, or at the top for a frame nested in another repeated one.
 */
const Brace: FC<{box: Box; label: string; nested: boolean}> = memo(({box, label, nested}) => {
  const x = box.x - 8;
  const bottom = nested ? Math.min(box.y + box.h - 6, box.y + 54) : box.y + box.h - 6;
  const top = nested ? box.y + 6 : Math.max(box.y + 6, bottom - 48);
  const mid = (top + bottom) / 2;
  const d = `M${x} ${top}C${x - 7} ${top} ${x} ${mid - 3} ${x - 8} ${mid}C${x} ${mid + 3} ${
    x - 7
  } ${bottom} ${x} ${bottom}`;
  return (
    <g>
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={1.6} />
      <text fill={ACCENT} fontSize={13} fontWeight={700} textAnchor="end" x={x - 12} y={mid + 4.5}>
        {label}
      </text>
    </g>
  );
});
Brace.displayName = 'ArchBrace';

const BlockBox: FC<{
  block: PlacedBlock;
  lit: boolean;
  hot: boolean;
  onEnter: (id: string) => void;
  onLeave: () => void;
}> = memo(({block, lit, hot, onEnter, onLeave}) => {
  const style = KIND_STYLE[block.kind];
  const {x, y, w, h} = block.box;
  const interactive = block.detail !== undefined;
  const enter = useCallback(() => onEnter(block.id), [block.id, onEnter]);
  const pill = block.kind === 'io';
  return (
    <g
      aria-label={interactive ? `${block.label}: details` : undefined}
      className={interactive ? 'cursor-help outline-none' : undefined}
      onBlur={interactive ? onLeave : undefined}
      onFocus={interactive ? enter : undefined}
      onMouseEnter={interactive ? enter : undefined}
      onMouseLeave={interactive ? onLeave : undefined}
      opacity={lit ? 1 : 0.28}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}>
      <rect
        fill={style.fill}
        height={h}
        rx={pill ? h / 2 : 7}
        stroke={hot ? ACCENT : style.stroke}
        strokeWidth={hot ? 2.2 : 1.3}
        width={w}
        x={x}
        y={y}
      />
      <text
        fill={style.text}
        fontSize={LABEL_FONT}
        fontWeight={600}
        textAnchor="middle"
        x={x + w / 2}
        y={y + (block.sub === undefined ? h / 2 + 4.3 : 17)}>
        {block.label}
      </text>
      {block.sub !== undefined ? (
        <text fill={ink[300]} fontFamily={MONO} fontSize={SUB_FONT} textAnchor="middle" x={x + w / 2} y={y + 32}>
          {block.sub}
        </text>
      ) : null}
      {interactive ? <circle cx={x + w - 7} cy={y + 7} fill={alpha(iris[400], 0.85)} r={2.2} /> : null}
    </g>
  );
});
BlockBox.displayName = 'ArchBlockBox';

interface Hover {
  id: string;
  label: string;
  sub?: string;
  detail: string;
  box: Box;
}

const ArchitectureDiagram: FC<{
  spec: Architecture;
  compact?: boolean;
  focus?: readonly string[];
  /** Compact mode: open the full figure (callouts and insets) somewhere roomier. */
  onExpand?: () => void;
}> = memo(({spec, compact = false, focus, onExpand}) => {
  const layout: ArchLayout = useMemo(() => layoutArchitecture(spec, compact), [spec, compact]);
  const [shapesOn, setShapesOn] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const focused = useMemo(() => new Set(focus ?? []), [focus]);
  const dimming = focused.size > 0;
  const hasShapes = layout.shapes.length > 0;
  const hasMore = (spec.notes?.length ?? 0) > 0 || (spec.insets?.length ?? 0) > 0;

  const details = useMemo(() => {
    const map = new Map<string, Hover>();
    for (const b of layout.blocks)
      if (b.detail !== undefined) map.set(b.id, {id: b.id, label: b.label, sub: b.sub, detail: b.detail, box: b.box});
    for (const o of layout.ops)
      if (o.detail !== undefined)
        map.set(o.id, {
          id: o.id,
          label: o.op === '+' ? 'Residual add' : 'Elementwise product',
          detail: o.detail,
          box: {x: o.c.x - o.r, y: o.c.y - o.r, w: o.r * 2, h: o.r * 2},
        });
    return map;
  }, [layout]);
  const onEnter = useCallback((id: string) => setHover(details.get(id) ?? null), [details]);
  const onLeave = useCallback(() => setHover(null), []);
  const toggleShapes = useCallback(() => setShapesOn(on => !on), []);

  // A step's boxes come into view in the compact column.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el === null || !compact || focused.size === 0) return;
    const target = layout.blocks.find(b => focused.has(b.id));
    if (target === undefined) return;
    const scale = el.scrollWidth / layout.width;
    el.scrollTo({top: Math.max(0, (target.box.y - layout.minY) * scale - el.clientHeight / 3), behavior: 'smooth'});
  }, [compact, focused, layout]);

  const lit = useCallback(
    (id: string, feeds?: string): boolean => !dimming || focused.has(id) || (feeds !== undefined && focused.has(feeds)),
    [dimming, focused],
  );

  const tooltip =
    hover === null ? null : (
      <div
        className="border-ink-600 bg-ink-800 text-ink-200 pointer-events-none absolute z-10 w-64 rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug shadow-xl"
        role="tooltip"
        style={{
          left: `${((hover.box.x + hover.box.w / 2 - layout.minX) / layout.width) * 100}%`,
          // Near the top a tooltip above the block would leave the figure: it opens below instead.
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
      style={{
        width: '100%',
        maxWidth: layout.width * (compact ? 1 : 1.08),
        height: 'auto',
        // Subs are code: `==`, `->`, `>=` must read as typed, not as JetBrains Mono ligatures.
        fontVariantLigatures: 'none',
      }}
      viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}>
      <title>Architecture</title>
      {layout.frames.map((fr, i) => {
        const s = FRAME_STYLE[fr.tone];
        return (
          <g key={`f${i}`}>
            <rect
              fill={s.fill}
              height={fr.box.h}
              rx={14}
              stroke={s.stroke}
              strokeDasharray={s.dash}
              strokeLinecap="round"
              strokeWidth={fr.tone === 'dotted' ? 2 : 1.2}
              width={fr.box.w}
              x={fr.box.x}
              y={fr.box.y}
            />
            {fr.label !== undefined ? (
              <text
                fill={ink[300]}
                fontSize={9.5}
                fontWeight={700}
                letterSpacing={0.6}
                x={fr.box.x + 10}
                y={fr.box.y + 14}>
                {fr.label.toUpperCase()}
              </text>
            ) : null}
            {fr.repeat !== undefined ? <Brace box={fr.box} label={fr.repeat} nested={fr.nested === true} /> : null}
          </g>
        );
      })}
      {layout.wires.map((w, i) => (
        <g key={`w${i}`}>
          <path d={polyline(w.points)} fill="none" stroke={WIRE} strokeLinejoin="round" strokeWidth={1.4} />
          {w.open === true ? null : <path d={arrowHead(w.points)} fill={WIRE} />}
          {w.junction !== undefined ? <circle cx={w.junction.x} cy={w.junction.y} fill={WIRE} r={2.4} /> : null}
        </g>
      ))}
      {!compact
        ? layout.leaders.map((l, i) => (
            <path
              d={polyline(l)}
              fill="none"
              key={`l${i}`}
              stroke={LEADER}
              strokeDasharray="0.5 4"
              strokeLinecap="round"
              strokeWidth={2.2}
            />
          ))
        : null}
      {!compact
        ? layout.notes.map((n, i) => (
            <g key={`n${i}`} opacity={lit(n.at) ? 1 : 0.3}>
              <path
                d={polyline(n.leader)}
                fill="none"
                stroke={LEADER}
                strokeDasharray="0.5 4"
                strokeLinecap="round"
                strokeWidth={2.2}
              />
              <TextBlock text={n.text} />
            </g>
          ))
        : null}
      {layout.ops.map(o => {
        const interactive = o.detail !== undefined;
        const hot = hover?.id === o.id;
        return (
          <g
            className={interactive ? 'cursor-help outline-none' : undefined}
            key={o.id}
            onBlur={interactive ? onLeave : undefined}
            onFocus={interactive ? () => onEnter(o.id) : undefined}
            onMouseEnter={interactive ? () => onEnter(o.id) : undefined}
            onMouseLeave={interactive ? onLeave : undefined}
            opacity={lit(o.id) ? 1 : 0.28}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}>
            <circle cx={o.c.x} cy={o.c.y} fill={ink[900]} r={o.r} stroke={hot ? ACCENT : ink[200]} strokeWidth={1.4} />
            {o.op === '+' ? (
              <path
                d={`M${o.c.x - 5} ${o.c.y}H${o.c.x + 5}M${o.c.x} ${o.c.y - 5}V${o.c.y + 5}`}
                stroke={ink[50]}
                strokeWidth={1.6}
              />
            ) : (
              <path
                d={`M${o.c.x - 3.6} ${o.c.y - 3.6}L${o.c.x + 3.6} ${o.c.y + 3.6}M${o.c.x + 3.6} ${o.c.y - 3.6}L${
                  o.c.x - 3.6
                } ${o.c.y + 3.6}`}
                stroke={ink[50]}
                strokeWidth={1.6}
              />
            )}
          </g>
        );
      })}
      {layout.blocks.map(b => (
        <BlockBox
          block={b}
          hot={hover?.id === b.id}
          key={b.id}
          lit={lit(b.id, b.feeds)}
          onEnter={onEnter}
          onLeave={onLeave}
        />
      ))}
      {shapesOn
        ? layout.shapes.map((s, i) => (
            <text fill={ACCENT} fontFamily={MONO} fontSize={9} key={`s${i}`} x={s.x} y={s.y}>
              {s.text}
            </text>
          ))
        : null}
      {layout.texts.map((t, i) => (
        <Fragment key={`t${i}`}>
          <TextBlock
            color={ink[200]}
            mono={t.anchor === 'middle' && !t.lines.join('').includes('**')}
            size={11}
            text={t}
          />
        </Fragment>
      ))}
    </svg>
  );

  return (
    <div className="border-ink-700 bg-ink-850 rounded-xl border p-2">
      {hasShapes || (compact && hasMore && onExpand !== undefined) ? (
        <div className="mb-1 flex items-center justify-end gap-2 px-1">
          {hasShapes ? (
            <button
              aria-pressed={shapesOn}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                shapesOn
                  ? 'border-iris-400 bg-iris-400/15 text-ink-50'
                  : 'border-ink-600 bg-ink-800 text-ink-200 hover:text-ink-50'
              }`}
              onClick={toggleShapes}
              title="Show the tensor each layer hands to the next"
              type="button">
              tensor shapes
            </button>
          ) : null}
          {compact && hasMore && onExpand !== undefined ? (
            <button
              className="border-ink-600 bg-ink-800 text-ink-200 hover:text-ink-50 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition"
              onClick={onExpand}
              title="The whole figure, with its callouts and insets"
              type="button">
              ⤢ full figure
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={compact ? 'max-h-[360px] overflow-y-auto' : undefined} ref={scroller}>
        <div className="relative mx-auto" style={{maxWidth: layout.width * (compact ? 1 : 1.08)}}>
          {svg}
          {tooltip}
        </div>
      </div>
      <p className="text-ink-400 mt-1 px-1 text-[10px]">
        read bottom to top · hover a box marked with a dot for what it computes
      </p>
    </div>
  );
});
ArchitectureDiagram.displayName = 'ArchitectureDiagram';

export default ArchitectureDiagram;
