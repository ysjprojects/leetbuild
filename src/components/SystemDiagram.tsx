import {type FC, type MouseEvent, memo, useCallback, useEffect, useMemo, useRef} from 'react';

import {type PlacedNode, EDGE_FONT, LABEL_FONT, layoutDiagram, SUB_FONT} from '@/lib/layout';
import type {Diagram, EdgeKind, NodeKind} from '@/lib/types';
import {concept, ink, node as KIND_COLOR} from '@/styles/palette';

/**
 * The problem's architecture as an SVG: boxes per component (coloured by kind) and labelled
 * edges, laid out automatically (see leetbuild/layout.ts). The nodes a step builds (`focus`) glow
 * while everything else dims, so the learner always sees which part of the system the file in
 * the editor belongs to.
 */

const MONO = 'var(--font-code), monospace';
/** Aspect ratio above which a diagram gets a scrollable minimum width instead of shrinking. */
const WIDE_ASPECT = 3;
const MIN_READABLE_SCALE = 0.72;
const NO_STEPS: number[] = [];

const NODE_FILL = ink[800];
const LIT_NODE_FILL = ink[700];
const LABEL_BACKDROP = ink[850];

const KIND_LABEL: Record<NodeKind, string> = {
  client: 'client',
  service: 'service',
  http: 'HTTPS',
  grpc: 'gRPC',
  kafka: 'Kafka topic',
  redis: 'Redis',
  db: 'database',
  external: 'external',
};

const EDGE_COLOR: Record<EdgeKind, string> = {...concept, plain: ink[400]};

/** 20×20 glyph per kind, drawn at the left of the box. */
const Glyph: FC<{kind: NodeKind; color: string}> = memo(({kind, color}) => {
  switch (kind) {
    case 'client':
      return (
        <g fill="none" stroke={color} strokeWidth={1.6}>
          <rect height={11} rx={1.5} width={16} x={2} y={2} />
          <path d="M7 17h6M10 13v4" strokeLinecap="round" />
        </g>
      );
    case 'http':
      return (
        <g fill="none" stroke={color} strokeWidth={1.6}>
          <rect height={9} rx={1.5} width={12} x={4} y={9} />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
          <circle cx={10} cy={13.5} fill={color} r={1.2} stroke="none" />
        </g>
      );
    case 'grpc':
      return (
        <g fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.6}>
          <path d="M3 7h12M12 4l3 3-3 3" />
          <path d="M17 13H5M8 10l-3 3 3 3" />
        </g>
      );
    case 'kafka':
      return (
        <g fill={color}>
          <rect height={3} rx={1} width={16} x={2} y={3} />
          <rect height={3} rx={1} width={11} x={2} y={8.5} />
          <rect height={3} rx={1} width={14} x={2} y={14} />
        </g>
      );
    case 'redis':
      return (
        <g fill={color}>
          <path d="M10 2l7 3.5-7 3.5-7-3.5z" />
          <path d="M3 9.5l7 3.5 7-3.5v2.5L10 15.5 3 12z" opacity={0.7} />
          <path d="M3 13.5l7 3.5 7-3.5V16l-7 3.5L3 16z" opacity={0.45} />
        </g>
      );
    case 'db':
      return (
        <g fill="none" stroke={color} strokeWidth={1.6}>
          <ellipse cx={10} cy={5} rx={7} ry={2.5} />
          <path d="M3 5v10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5" />
          <path d="M3 10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
        </g>
      );
    case 'external':
      return (
        <path
          d="M6 16a3.5 3.5 0 0 1-.6-6.95A5 5 0 0 1 15 8.2 3.4 3.4 0 0 1 15 15z"
          fill="none"
          stroke={color}
          strokeLinejoin="round"
          strokeWidth={1.6}
        />
      );
    case 'service':
      return (
        <g fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.6}>
          <rect height={14} rx={2} width={16} x={2} y={3} />
          <path d="M6 8l2.5 2.5L6 13M10.5 13h3.5" />
        </g>
      );
  }
});
Glyph.displayName = 'DiagramGlyph';

const Node: FC<{
  node: PlacedNode;
  lit: boolean;
  dimming: boolean;
  steps: readonly number[];
  clickable: boolean;
}> = memo(({node, lit, dimming, steps, clickable}) => {
  const color = KIND_COLOR[node.kind];
  const x = node.cx - node.w / 2;
  const y = node.cy - node.h / 2;
  const labelY = node.subLines.length === 0 ? y + node.h / 2 + 4.5 : y + 20;
  return (
    <g
      className={clickable ? 'cursor-pointer' : undefined}
      data-node={clickable ? node.id : undefined}
      opacity={lit ? 1 : 0.35}>
      <title>
        {steps.length === 0
          ? `${node.label} — provided, not built here`
          : `${node.label} — built in step ${steps.join(', ')}${clickable ? ' (click to open)' : ''}`}
      </title>
      <rect
        fill={lit && dimming ? LIT_NODE_FILL : NODE_FILL}
        filter={lit && dimming ? 'url(#lb-glow)' : undefined}
        height={node.h}
        rx={9}
        stroke={color}
        strokeWidth={lit && dimming ? 2 : 1.2}
        width={node.w}
        x={x}
        y={y}
      />
      <g transform={`translate(${x + 10}, ${node.cy - 10})`}>
        <Glyph color={color} kind={node.kind} />
      </g>
      <text fill={ink[50]} fontSize={LABEL_FONT} fontWeight={700} x={x + 36} y={labelY}>
        {node.label}
      </text>
      {node.subLines.map((line, i) => (
        <text fill={ink[300]} fontFamily={MONO} fontSize={SUB_FONT} key={i} x={x + 36} y={y + 34 + i * 11}>
          {line}
        </text>
      ))}
    </g>
  );
});
Node.displayName = 'DiagramNode';

const SystemDiagram: FC<{
  diagram: Diagram;
  focus: readonly string[];
  compact?: boolean;
  /** 1-based step numbers that build each node; shown in tooltips, and clickable when `onSelectNode` is set. */
  stepsByNode?: Record<string, number[]>;
  onSelectNode?: (id: string) => void;
}> = memo(({diagram, focus, compact = false, stepsByNode, onSelectNode}) => {
  // Event delegation: every node group carries data-node; one handler on the svg serves them all.
  const onClick = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      if (onSelectNode === undefined) return;
      const id = (e.target as SVGElement).closest('[data-node]')?.getAttribute('data-node');
      if (id !== null && id !== undefined) onSelectNode(id);
    },
    [onSelectNode],
  );
  const layout = useMemo(() => layoutDiagram(diagram), [diagram]);
  const focused = useMemo(() => {
    const map: Record<string, true> = {};
    for (const id of focus) map[id] = true;
    return map;
  }, [focus]);
  const dimming = focus.length > 0;
  const legend = useMemo(() => {
    const seen: Record<string, true> = {};
    const kinds: NodeKind[] = [];
    for (const node of diagram.nodes) {
      if (seen[node.kind] === undefined) {
        seen[node.kind] = true;
        kinds.push(node.kind);
      }
    }
    return kinds;
  }, [diagram.nodes]);
  const wide = layout.width / layout.height > WIDE_ASPECT;
  const svgStyle = useMemo(
    () =>
      wide
        ? {width: `max(100%, ${Math.round(layout.width * MIN_READABLE_SCALE)}px)`, height: 'auto'}
        : {maxHeight: compact ? 240 : undefined},
    [compact, wide, layout.width],
  );
  const scroller = useRef<HTMLDivElement>(null);
  // When a step opens, bring the first component it builds into view.
  useEffect(() => {
    const el = scroller.current;
    if (el === null || focus.length === 0 || el.scrollWidth <= el.clientWidth) return;
    const node = layout.nodes.find(n => n.id === focus[0]);
    if (node === undefined) return;
    const x = (node.cx / layout.width) * el.scrollWidth;
    el.scrollTo({left: Math.max(0, x - el.clientWidth / 2), behavior: 'smooth'});
  }, [focus, layout]);

  return (
    <div className="border-ink-700 bg-ink-850 overflow-x-auto rounded-xl border p-2" ref={scroller}>
      <svg
        className="w-full"
        onClick={onClick}
        role="img"
        style={svgStyle}
        viewBox={`0 ${layout.originY} ${layout.width} ${layout.height}`}>
        <title>System architecture</title>
        <defs>
          {(Object.keys(EDGE_COLOR) as EdgeKind[]).map(kind => (
            <marker
              id={`lb-arrow-${kind}`}
              key={kind}
              markerHeight={7}
              markerWidth={8}
              orient="auto"
              refX={7}
              refY={3.5}>
              <path d="M0 0L8 3.5L0 7z" fill={EDGE_COLOR[kind]} />
            </marker>
          ))}
          <filter height="160%" id="lb-glow" width="160%" x="-30%" y="-30%">
            <feGaussianBlur result="blur" stdDeviation={5} />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {layout.edges.map(({edge, kind, d, label, labelW}, i) => {
          const color = EDGE_COLOR[kind];
          const lit = !dimming || (focused[edge.from] === true && focused[edge.to] === true);
          return (
            <g key={i} opacity={lit ? 1 : 0.22}>
              <path
                d={d}
                fill="none"
                markerEnd={`url(#lb-arrow-${kind})`}
                stroke={color}
                strokeDasharray={kind === 'kafka' ? '6 4' : undefined}
                strokeWidth={lit ? 1.8 : 1.2}
              />
              {label !== null && edge.label !== undefined ? (
                <g>
                  <rect
                    fill={LABEL_BACKDROP}
                    height={14}
                    rx={3}
                    width={labelW}
                    x={label.x - labelW / 2}
                    y={label.y - 7}
                  />
                  <text
                    fill={color}
                    fontFamily={MONO}
                    fontSize={EDGE_FONT}
                    textAnchor="middle"
                    x={label.x}
                    y={label.y + 3.5}>
                    {edge.label}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
        {layout.nodes.map(node => {
          const steps = stepsByNode?.[node.id] ?? NO_STEPS;
          return (
            <Node
              clickable={onSelectNode !== undefined && steps.length > 0}
              dimming={dimming}
              key={node.id}
              lit={!dimming || focused[node.id] === true}
              node={node}
              steps={steps}
            />
          );
        })}
      </svg>
      <div className="text-ink-300 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px]">
        {legend.map(kind => (
          <span className="flex items-center gap-1" key={kind}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{background: KIND_COLOR[kind]}} />
            {KIND_LABEL[kind]}
          </span>
        ))}
        {wide ? <span className="text-ink-400">wide diagram · scroll sideways</span> : null}
        {dimming ? <span className="text-iris-300 ml-auto">highlighted: what this step builds</span> : null}
      </div>
    </div>
  );
});
SystemDiagram.displayName = 'SystemDiagram';

export default SystemDiagram;
