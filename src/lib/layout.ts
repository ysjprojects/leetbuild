/**
 * Automatic layout for architecture diagrams: a left-to-right layered graph drawing. Nodes are
 * placed by their position in the call graph (clients on the left, what they call to the right),
 * ordered within a column to reduce crossings, sized to their text, and spaced so edge labels fit
 * in the gaps between columns. Authored `x`/`y` only break ties in column order, so content
 * authors never have to account for box sizes.
 */
import type {Diagram, DiagramEdge, DiagramNode, EdgeKind} from './types';

export interface PlacedNode extends DiagramNode {
  layer: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** `sub` wrapped to at most two lines. */
  subLines: string[];
}

export interface Point {
  x: number;
  y: number;
}

export interface RoutedEdge {
  edge: DiagramEdge;
  kind: EdgeKind;
  /** SVG path data. */
  d: string;
  /** Where the label sits. */
  label: Point | null;
  labelW: number;
  /** The path's ends and, for curves, its two cubic control points — the same geometry as `d`. */
  from: Point;
  to: Point;
  controls: [Point, Point] | null;
}
export interface Layout {
  width: number;
  height: number;
  /** Top of the viewBox; negative when a curve or label reaches above the first row. */
  originY: number;
  nodes: PlacedNode[];
  edges: RoutedEdge[];
}

export const LABEL_FONT = 12.5;
export const SUB_FONT = 8.5;
export const EDGE_FONT = 9.5;

const LABEL_CHAR = 7.4;
const SUB_CHAR = 5.3;
const EDGE_CHAR = 6;
const ICON_W = 36;
const PAD_X = 14;
const MIN_W = 120;
const MAX_W = 230;
const SUB_MAX_CHARS = 34;
const V_GAP = 28;
const MIN_H_GAP = 76;
const MARGIN = 10;

export const edgeLabelWidth = (label: string): number => label.length * EDGE_CHAR + 12;

/** Split a long `sub` at ` · ` or spaces into at most two lines no wider than the box allows. */
function wrapSub(sub: string): string[] {
  if (sub.length <= SUB_MAX_CHARS) return [sub];
  const parts = sub.split(' · ');
  if (parts.length > 1) {
    // Greedy: fill the first line, the rest goes to the second.
    let first = parts[0];
    let i = 1;
    while (i < parts.length && `${first} · ${parts[i]}`.length <= SUB_MAX_CHARS) first = `${first} · ${parts[i++]}`;
    const second = parts.slice(i).join(' · ');
    if (second.length === 0) return [first];
    return [first, second.length > SUB_MAX_CHARS ? `${second.slice(0, SUB_MAX_CHARS - 1)}…` : second];
  }
  const cut = sub.lastIndexOf(' ', SUB_MAX_CHARS);
  const at = cut > 8 ? cut : SUB_MAX_CHARS;
  const second = sub.slice(at).trim();
  return [sub.slice(0, at), second.length > SUB_MAX_CHARS ? `${second.slice(0, SUB_MAX_CHARS - 1)}…` : second];
}

/**
 * Longest-path layering over the DAG left after dropping back edges found by a depth-first search
 * from every source; sources (no incoming edges) sit in column 0.
 */
function assignLayers(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): Record<string, number> {
  const out: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};
  for (const n of nodes) {
    out[n.id] = [];
    indeg[n.id] = 0;
  }
  // Drop back edges (cycles) with a DFS colouring so the longest path is well defined.
  const state: Record<string, 0 | 1 | 2> = {};
  const forward: DiagramEdge[] = [];
  const adjacency: Record<string, DiagramEdge[]> = {};
  for (const e of edges) (adjacency[e.from] ??= []).push(e);
  const visit = (id: string): void => {
    state[id] = 1;
    for (const e of adjacency[id] ?? []) {
      if (state[e.to] === 1) continue; // back edge
      forward.push(e);
      if (state[e.to] === undefined) visit(e.to);
    }
    state[id] = 2;
  };
  for (const n of nodes) if (state[n.id] === undefined) visit(n.id);
  for (const e of forward) {
    out[e.from].push(e.to);
    indeg[e.to] += 1;
  }
  const layer: Record<string, number> = {};
  const queue = nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
  for (const id of queue) layer[id] = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of out[id]) {
      layer[next] = Math.max(layer[next] ?? 0, layer[id] + 1);
      indeg[next] -= 1;
      if (indeg[next] === 0) queue.push(next);
    }
  }
  for (const n of nodes) layer[n.id] ??= 0;
  return layer;
}

/** Barycenter ordering within each column, seeded by the authored vertical order. */
function orderColumns(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  layer: Record<string, number>,
): DiagramNode[][] {
  const count = Math.max(...nodes.map(n => layer[n.id])) + 1;
  const columns: DiagramNode[][] = Array.from({length: count}, () => []);
  for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) columns[layer[n.id]].push(n);
  const position: Record<string, number> = {};
  const index = (): void => {
    for (const column of columns) column.forEach((n, i) => (position[n.id] = i));
  };
  index();
  const neighbours = (id: string, towards: 'left' | 'right'): number[] =>
    edges
      .filter(e =>
        towards === 'left' ? e.to === id && layer[e.from] < layer[id] : e.from === id && layer[e.to] > layer[id],
      )
      .map(e => position[towards === 'left' ? e.from : e.to]);
  for (let pass = 0; pass < 4; pass++) {
    const towards = pass % 2 === 0 ? 'left' : 'right';
    const range = towards === 'left' ? columns.keys() : [...columns.keys()].reverse();
    for (const c of range) {
      const column = columns[c];
      const bary = column.map((n, i) => {
        const ns = neighbours(n.id, towards);
        return {n, key: ns.length === 0 ? i : ns.reduce((s, v) => s + v, 0) / ns.length, i};
      });
      bary.sort((a, b) => a.key - b.key || a.i - b.i);
      columns[c] = bary.map(b => b.n);
      index();
    }
  }
  return columns;
}

/** Point at parameter `t` of a cubic Bézier. */
const cubicAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};

/**
 * The arrowhead at the end of an edge, as SVG path data: a triangle whose axis follows the part of
 * the line the eye sees entering it — the chord over the last stretch of the curve — not the curve's
 * tangent at its very last point, which on a tight arc can point somewhere the visible line does not.
 */
export function arrowHead(edge: RoutedEdge, length = 8, halfWidth = 3.5): string {
  const tip = edge.to;
  let back: Point = edge.from;
  if (edge.controls !== null) {
    const [p1, p2] = edge.controls;
    for (let t = 0.98; t >= 0; t -= 0.01) {
      back = cubicAt(edge.from, p1, p2, tip, t);
      if (Math.hypot(tip.x - back.x, tip.y - back.y) >= length * 1.75) break;
    }
  }
  const dx = tip.x - back.x;
  const dy = tip.y - back.y;
  const norm = Math.hypot(dx, dy) || 1;
  const ux = dx / norm;
  const uy = dy / norm;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  return `M${tip.x} ${tip.y}L${bx - uy * halfWidth} ${by + ux * halfWidth}L${bx + uy * halfWidth} ${
    by - ux * halfWidth
  }Z`;
}

export function layoutDiagram(diagram: Diagram): Layout {
  const {nodes, edges} = diagram;
  if (nodes.length === 0) return {width: 10, height: 10, originY: 0, nodes: [], edges: []};
  const layer = assignLayers(nodes, edges);
  const columns = orderColumns(nodes, edges, layer);

  // Box sizes from text.
  const sized: Record<string, {w: number; h: number; subLines: string[]}> = {};
  for (const n of nodes) {
    const subLines = n.sub === undefined ? [] : wrapSub(n.sub);
    const textW = Math.max(n.label.length * LABEL_CHAR, ...subLines.map(l => l.length * SUB_CHAR));
    const w = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(textW) + ICON_W + PAD_X * 2));
    const h = subLines.length === 0 ? 42 : subLines.length === 1 ? 50 : 60;
    sized[n.id] = {w, h, subLines};
  }

  // Column widths and the gap after each column: wide enough for the widest label routed through it.
  const columnW = columns.map(column => Math.max(...column.map(n => sized[n.id].w)));
  const gapAfter = columns.map(() => MIN_H_GAP);
  for (const e of edges) {
    if (e.label === undefined) continue;
    const from = layer[e.from];
    const to = layer[e.to];
    if (to <= from) continue;
    gapAfter[from] = Math.max(gapAfter[from], edgeLabelWidth(e.label) + 28);
  }
  const columnX: number[] = [];
  let x = MARGIN;
  columns.forEach((_, c) => {
    columnX.push(x);
    x += columnW[c] + gapAfter[c];
  });
  const width = x - gapAfter[columns.length - 1] + MARGIN;

  // Back edges arc above the top row: leave room for them.
  const hasBack = edges.some(
    e => layer[e.to] !== undefined && layer[e.from] !== undefined && layer[e.to] < layer[e.from],
  );
  const topPad = hasBack ? 36 : 0;
  const columnH = columns.map(column => column.reduce((s, n) => s + sized[n.id].h, 0) + (column.length - 1) * V_GAP);
  const height = Math.max(...columnH) + 2 * MARGIN + 8 + topPad;

  const placed: Record<string, PlacedNode> = {};
  columns.forEach((column, c) => {
    let y = topPad + (height - topPad - columnH[c]) / 2;
    for (const n of column) {
      const s = sized[n.id];
      placed[n.id] = {...n, layer: c, cx: columnX[c] + columnW[c] / 2, cy: y + s.h / 2, ...s};
      y += s.h + V_GAP;
    }
  });

  // Edges leaving a box share its right side and edges entering share its left; spread them along the
  // side (ordered by the other end's row) so arrowheads and tails do not stack on one point.
  const outgoing: Record<string, DiagramEdge[]> = {};
  const incoming: Record<string, DiagramEdge[]> = {};
  for (const e of edges) {
    const s = placed[e.from];
    const t = placed[e.to];
    if (s === undefined || t === undefined || t.layer <= s.layer) continue;
    (outgoing[e.from] ??= []).push(e);
    (incoming[e.to] ??= []).push(e);
  }
  for (const list of Object.values(outgoing)) list.sort((a, b) => placed[a.to].cy - placed[b.to].cy);
  for (const list of Object.values(incoming)) list.sort((a, b) => placed[a.from].cy - placed[b.from].cy);
  const anchorY = (n: PlacedNode, list: DiagramEdge[] | undefined, e: DiagramEdge): number => {
    if (list === undefined || list.length <= 1) return n.cy;
    const span = Math.min(n.h - 18, (list.length - 1) * 14);
    return n.cy - span / 2 + (span * list.indexOf(e)) / (list.length - 1);
  };

  // Edges: forward edges are horizontal-tangent S-curves between columns with the label in the first
  // gap after the source; same-column edges run vertically; back edges arc over the top.
  const routed: RoutedEdge[] = [];
  for (const e of edges) {
    const s = placed[e.from];
    const t = placed[e.to];
    if (s === undefined || t === undefined) continue;
    const kind = e.kind ?? 'plain';
    const labelW = e.label === undefined ? 0 : edgeLabelWidth(e.label);
    if (t.layer > s.layer) {
      const p0 = {x: s.cx + s.w / 2, y: anchorY(s, outgoing[e.from], e)};
      const p3 = {x: t.cx - t.w / 2, y: anchorY(t, incoming[e.to], e)};
      const dx = p3.x - p0.x;
      let p1 = {x: p0.x + dx * 0.45, y: p0.y};
      let p2 = {x: p3.x - dx * 0.45, y: p3.y};
      // An edge that skips columns would run through the boxes in between: detour above or below them,
      // whichever band is closer to the straight line.
      const between = columns
        .slice(s.layer + 1, t.layer)
        .flat()
        .map(n => placed[n.id]);
      const lineY = (p0.y + p3.y) / 2;
      const blocking = between.filter(n => Math.abs(n.cy - lineY) < n.h / 2 + 12);
      if (blocking.length > 0) {
        const top = Math.min(...between.map(n => n.cy - n.h / 2)) - 18;
        const bottom = Math.max(...between.map(n => n.cy + n.h / 2)) + 18;
        const band = Math.abs(top - lineY) <= Math.abs(bottom - lineY) ? top : bottom;
        // Control points overshoot the band so the curve itself reaches it.
        const control = band + (band - lineY) * 0.35;
        p1 = {x: p0.x + Math.min(90, dx * 0.3), y: control};
        p2 = {x: p3.x - Math.min(90, dx * 0.3), y: control};
      }
      let label: Point | null = null;
      if (e.label !== undefined) {
        // In the middle of the first gap when the edge crosses just one gap; otherwise a little further
        // along, where fanned-out curves have already diverged from each other.
        const gapMid = p0.x + gapAfter[s.layer] * (t.layer === s.layer + 1 ? 0.5 : 0.62);
        let best = 0.5;
        let bestDist = Infinity;
        for (let i = 1; i < 60; i++) {
          const tt = i / 60;
          const dist = Math.abs(cubicAt(p0, p1, p2, p3, tt).x - gapMid);
          if (dist < bestDist) {
            bestDist = dist;
            best = tt;
          }
        }
        label = cubicAt(p0, p1, p2, p3, best);
      }
      routed.push({
        edge: e,
        kind,
        d: `M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,
        label,
        labelW,
        from: p0,
        to: p3,
        controls: [p1, p2],
      });
    } else if (t.layer === s.layer) {
      const down = t.cy > s.cy;
      const p0 = {x: s.cx, y: down ? s.cy + s.h / 2 : s.cy - s.h / 2};
      const p3 = {x: t.cx, y: down ? t.cy - t.h / 2 : t.cy + t.h / 2};
      const label = e.label === undefined ? null : {x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 + 3};
      routed.push({
        edge: e,
        kind,
        d: `M${p0.x} ${p0.y} L${p3.x} ${p3.y}`,
        label,
        labelW,
        from: p0,
        to: p3,
        controls: null,
      });
    } else {
      const p0 = {x: s.cx, y: s.cy - s.h / 2};
      const p3 = {x: t.cx, y: t.cy - t.h / 2};
      // The arc's apex clears every box in the columns it spans, not just the two it joins: a cubic
      // with both controls at `c` peaks at ⅛(p0+p3) + ¾c, so solve for the control height.
      const spanTop = Math.min(
        ...columns
          .slice(t.layer, s.layer + 1)
          .flat()
          .map(n => placed[n.id].cy - placed[n.id].h / 2),
      );
      const apex = spanTop - 26;
      const control = (apex - (p0.y + p3.y) / 8) / 0.75;
      const p1 = {x: p0.x, y: control};
      const p2 = {x: p3.x, y: control};
      const label =
        e.label === undefined ? null : {...cubicAt(p0, p1, p2, p3, 0.5), y: cubicAt(p0, p1, p2, p3, 0.5).y - 8};
      routed.push({
        edge: e,
        kind,
        d: `M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,
        label,
        labelW,
        from: p0,
        to: p3,
        controls: [p1, p2],
      });
    }
  }

  // Labels whose boxes would overlap are pushed apart vertically, top to bottom.
  const LABEL_H = 15;
  const labelled = routed.filter(r => r.label !== null).sort((a, b) => (a.label as Point).y - (b.label as Point).y);
  for (let i = 0; i < labelled.length; i++) {
    const a = labelled[i].label as Point;
    for (let j = 0; j < i; j++) {
      const b = labelled[j].label as Point;
      const overlapX = Math.abs(a.x - b.x) < (labelled[i].labelW + labelled[j].labelW) / 2 + 4;
      if (overlapX && a.y - b.y < LABEL_H) a.y = b.y + LABEL_H;
    }
  }

  // Detours and labels may poke above/below the node rows: grow the canvas rather than clip them.
  let minY = 0;
  let maxY = height;
  for (const r of routed) {
    for (const m of r.d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) {
      const y = Number(m[2]);
      minY = Math.min(minY, y - 6);
      maxY = Math.max(maxY, y + 6);
    }
    if (r.label !== null) {
      minY = Math.min(minY, r.label.y - 10);
      maxY = Math.max(maxY, r.label.y + 10);
    }
  }

  return {width, height: maxY - minY, originY: minY, nodes: nodes.map(n => placed[n.id]), edges: routed};
}
