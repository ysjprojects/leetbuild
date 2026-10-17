/**
 * The scratchpad: a whiteboard beside the IDE for sketching the system while building it — boxes
 * with labels, arrows that attach to box borders, freehand ink and text, with pan and zoom, undo,
 * PNG export, and the course's architecture diagram as a starting sketch.
 *
 * Shapes live in world coordinates; a `View` maps them onto the canvas (`screen = world × scale +
 * offset`). Everything here is pure — geometry, hit-testing, rendering, export — so the component
 * only holds state and pointer gestures. Colours are palette *names* resolved at draw time, so a
 * sketch survives a theme switch.
 */
import {type Palette, type Theme, PALETTE} from '@/styles/palette';

import {layoutDiagram} from './layout';
import type {EdgeKind, NodeKind, Problem} from './types';

export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'eraser';

export type Hue = 'ink' | 'iris' | 'http' | 'grpc' | 'kafka' | 'redis' | 'success' | 'warning' | 'danger';

export const HUES: readonly Hue[] = ['ink', 'iris', 'http', 'grpc', 'kafka', 'redis', 'success', 'warning', 'danger'];

export const HUE_LABEL: Record<Hue, string> = {
  ink: 'ink',
  iris: 'iris',
  http: 'HTTPS blue',
  grpc: 'gRPC violet',
  kafka: 'Kafka orange',
  redis: 'Redis red',
  success: 'green',
  warning: 'amber',
  danger: 'red',
};

/** Stroke widths offered by the toolbar: thin, regular, bold. */
export const WIDTHS: readonly number[] = [2, 3.5, 6];

/** Text size for each stroke width. */
export const textSize = (width: number): number => (width <= 2 ? 14 : width <= 3.5 ? 18 : 26);

export type Point = [number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
  hue: Hue;
  width: number;
}

export interface PenShape extends Base {
  kind: 'pen';
  points: Point[];
}

export type BoxKind = 'rect' | 'ellipse' | 'diamond';

export interface BoxShape extends Base {
  kind: BoxKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tinted with the hue. */
  fill: boolean;
  /** Centred, word-wrapped; `\n` breaks lines. */
  label: string;
}

/** Cubic control points `[c1x, c1y, c2x, c2y]` of a curved connector (the course diagram's routes). */
export type Curve = [number, number, number, number];

export interface LineShape extends Base {
  kind: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Straight when absent. */
  curve?: Curve;
  /** Sits at `labelAt`, else on the middle of the path. */
  label: string;
  labelAt?: Point;
}

/** Point at parameter `t` along a connector's cubic curve (its ends when straight). */
export function cubicAt(s: LineShape, t: number): Point {
  if (s.curve === undefined) return [s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t];
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * s.x1 + b * s.curve[0] + c * s.curve[2] + d * s.x2, a * s.y1 + b * s.curve[1] + c * s.curve[3] + d * s.y2];
}

export interface TextShape extends Base {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  /** Measured when the text was set; keeps hit-testing free of a canvas. */
  w: number;
  h: number;
}

export type Shape = PenShape | BoxShape | LineShape | TextShape;

export interface View {
  x: number;
  y: number;
  scale: number;
}

/** One course's sketch, as persisted. */
export interface Scratchpad {
  shapes: Shape[];
  updatedAt: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const GRID = 24;
export const DEFAULT_VIEW: View = {x: 32, y: 32, scale: 1};
/** A click (no drag) with a box tool places a box of this size. */
export const DEFAULT_BOX = {w: 168, h: 72};
export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_SIZE = 13;
const EDGE_LABEL_SIZE = 12;
const LINE_HEIGHT = 1.3;
const HANDLE = 8;
const NEW_BOX_PADDING = 8;

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const isBox = (s: Shape): s is BoxShape => s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond';
export const isLine = (s: Shape): s is LineShape => s.kind === 'line' || s.kind === 'arrow';

// ---- coordinates ---------------------------------------------------------------------------------

export const toWorld = (view: View, sx: number, sy: number): Point => [
  (sx - view.x) / view.scale,
  (sy - view.y) / view.scale,
];

export const toScreen = (view: View, wx: number, wy: number): Point => [
  wx * view.scale + view.x,
  wy * view.scale + view.y,
];

export const snap = (v: number, on: boolean): number => (on ? Math.round(v / (GRID / 3)) * (GRID / 3) : v);

/** Zoom by `factor` keeping the world point under screen `(sx, sy)` fixed. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  if (scale === view.scale) return view;
  const [wx, wy] = toWorld(view, sx, sy);
  return {scale, x: sx - wx * scale, y: sy - wy * scale};
}

/** A view that shows every shape with a margin, no larger than 1:1. */
export function fitView(shapes: readonly Shape[], width: number, height: number): View {
  const b = boundsOf(shapes);
  if (b === null) return DEFAULT_VIEW;
  const pad = 48;
  const scale = Math.min(1, (width - pad * 2) / Math.max(1, b.w), (height - pad * 2) / Math.max(1, b.h));
  const s = Math.max(MIN_SCALE, scale);
  return {scale: s, x: (width - b.w * s) / 2 - b.x * s, y: (height - b.h * s) / 2 - b.y * s};
}

// ---- geometry ------------------------------------------------------------------------------------

export const normalizeRect = (x: number, y: number, w: number, h: number): Rect => ({
  x: Math.min(x, x + w),
  y: Math.min(y, y + h),
  w: Math.abs(w),
  h: Math.abs(h),
});

/** A connector as a polyline: its two ends, or 24 samples along its curve. */
export function linePoints(s: LineShape): Point[] {
  if (s.curve === undefined)
    return [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ];
  const pts: Point[] = [];
  for (let i = 0; i <= 24; i++) pts.push(cubicAt(s, i / 24));
  return pts;
}

/** Where a connector's label sits: its stored anchor, else the middle of its path. */
export const labelAnchor = (s: LineShape): Point =>
  s.labelAt ?? (s.curve === undefined ? [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2] : cubicAt(s, 0.5));

const pointsBounds = (pts: readonly Point[]): Rect => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
};

export function bounds(s: Shape): Rect {
  switch (s.kind) {
    case 'pen':
      return pointsBounds(s.points);
    case 'line':
    case 'arrow':
      return pointsBounds(linePoints(s));
    case 'text':
      return {x: s.x, y: s.y, w: s.w, h: s.h};
    default:
      return normalizeRect(s.x, s.y, s.w, s.h);
  }
}

export function boundsOf(shapes: readonly Shape[]): Rect | null {
  if (shapes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) {
    const b = bounds(s);
    const pad = s.width;
    x0 = Math.min(x0, b.x - pad);
    y0 = Math.min(y0, b.y - pad);
    x1 = Math.max(x1, b.x + b.w + pad);
    y1 = Math.max(y1, b.y + b.h + pad);
  }
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

const center = (b: Rect): Point => [b.x + b.w / 2, b.y + b.h / 2];

const distanceToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
};

/** Inside the box's outline (its area counts: diagram boxes are grabbed by their body). */
function insideBox(box: BoxShape, px: number, py: number, tol: number): boolean {
  const b = normalizeRect(box.x, box.y, box.w, box.h);
  const [cx, cy] = center(b);
  const rx = b.w / 2 + tol;
  const ry = b.h / 2 + tol;
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  if (box.kind === 'ellipse') return rx > 0 && ry > 0 && (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  if (box.kind === 'diamond') return rx > 0 && ry > 0 && dx / rx + dy / ry <= 1;
  return dx <= rx && dy <= ry;
}

export function hits(s: Shape, px: number, py: number, tol: number): boolean {
  switch (s.kind) {
    case 'pen': {
      const b = bounds(s);
      if (!intersects({x: px - tol, y: py - tol, w: tol * 2, h: tol * 2}, b)) return false;
      const t = tol + s.width / 2;
      for (let i = 1; i < s.points.length; i++) {
        const [ax, ay] = s.points[i - 1];
        const [bx, by] = s.points[i];
        if (distanceToSegment(px, py, ax, ay, bx, by) <= t) return true;
      }
      return s.points.length === 1 && Math.hypot(px - s.points[0][0], py - s.points[0][1]) <= t;
    }
    case 'line':
    case 'arrow': {
      const pts = linePoints(s);
      const t = tol + s.width / 2;
      for (let i = 1; i < pts.length; i++)
        if (distanceToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= t) return true;
      return false;
    }
    case 'text':
      return px >= s.x - tol && px <= s.x + s.w + tol && py >= s.y - tol && py <= s.y + s.h + tol;
    default:
      return insideBox(s, px, py, tol);
  }
}

/** The topmost shape under a world point. */
export function hitTest(shapes: readonly Shape[], px: number, py: number, tol: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) if (hits(shapes[i], px, py, tol)) return shapes[i];
  return null;
}

export function inRect(s: Shape, r: Rect): boolean {
  return intersects(bounds(s), r);
}

export function translate<S extends Shape>(s: S, dx: number, dy: number): S {
  switch (s.kind) {
    case 'pen':
      return {...s, points: s.points.map(([x, y]): Point => [x + dx, y + dy])};
    case 'line':
    case 'arrow':
      return {
        ...s,
        x1: s.x1 + dx,
        y1: s.y1 + dy,
        x2: s.x2 + dx,
        y2: s.y2 + dy,
        ...(s.curve === undefined
          ? {}
          : {curve: [s.curve[0] + dx, s.curve[1] + dy, s.curve[2] + dx, s.curve[3] + dy] as Curve}),
        ...(s.labelAt === undefined ? {} : {labelAt: [s.labelAt[0] + dx, s.labelAt[1] + dy] as Point}),
      };
    default:
      return {...s, x: s.x + dx, y: s.y + dy};
  }
}

/** Where a connector leaving the box toward `[tx, ty]` crosses its outline. */
export function borderPoint(box: BoxShape, tx: number, ty: number): Point {
  const b = normalizeRect(box.x, box.y, box.w, box.h);
  const [cx, cy] = center(b);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const rx = b.w / 2;
  const ry = b.h / 2;
  let t: number;
  if (box.kind === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  else if (box.kind === 'diamond') t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  else t = Math.min(dx === 0 ? Infinity : rx / Math.abs(dx), dy === 0 ? Infinity : ry / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

/** Snap a connector endpoint dropped inside a box onto that box's outline, facing the other end. */
export function attach(shapes: readonly Shape[], px: number, py: number, ox: number, oy: number): Point {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (isBox(s) && insideBox(s, px, py, 0)) return borderPoint(s, ox, oy);
  }
  return [px, py];
}

/** Constrain a direction to multiples of 45° (shift while drawing a connector). */
export function constrainAngle(x1: number, y1: number, x2: number, y2: number): Point {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [x2, y2];
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len];
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'a' | 'b';

/** Handle positions of a shape in world coordinates: box corners, or a connector's two ends. */
export function handles(s: Shape): Partial<Record<Handle, Point>> {
  if (isBox(s)) {
    const b = normalizeRect(s.x, s.y, s.w, s.h);
    return {nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h]};
  }
  if (isLine(s)) return {a: [s.x1, s.y1], b: [s.x2, s.y2]};
  return {};
}

/** The handle under screen point `(sx, sy)`, if any. */
export function handleAt(s: Shape, view: View, sx: number, sy: number): Handle | null {
  for (const [name, [wx, wy]] of Object.entries(handles(s)) as [Handle, Point][]) {
    const [hx, hy] = toScreen(view, wx, wy);
    if (Math.abs(sx - hx) <= HANDLE && Math.abs(sy - hy) <= HANDLE) return name;
  }
  return null;
}

/** Move one handle of a box or connector to a world point. */
export function withHandle(s: Shape, handle: Handle, px: number, py: number): Shape {
  if (isBox(s)) {
    const b = normalizeRect(s.x, s.y, s.w, s.h);
    const left = handle === 'nw' || handle === 'sw';
    const top = handle === 'nw' || handle === 'ne';
    const x0 = left ? px : b.x;
    const x1 = left ? b.x + b.w : px;
    const y0 = top ? py : b.y;
    const y1 = top ? b.y + b.h : py;
    return {...s, ...normalizeRect(x0, y0, x1 - x0, y1 - y0)};
  }
  if (isLine(s)) {
    // The adjacent control point follows the end it shapes; the label returns to the midpoint.
    const dx = px - (handle === 'a' ? s.x1 : s.x2);
    const dy = py - (handle === 'a' ? s.y1 : s.y2);
    const curve =
      s.curve === undefined
        ? undefined
        : handle === 'a'
        ? ([s.curve[0] + dx, s.curve[1] + dy, s.curve[2], s.curve[3]] as Curve)
        : ([s.curve[0], s.curve[1], s.curve[2] + dx, s.curve[3] + dy] as Curve);
    const moved = handle === 'a' ? {x1: px, y1: py} : {x2: px, y2: py};
    return {...s, ...moved, curve, labelAt: undefined};
  }
  return s;
}

// ---- text ----------------------------------------------------------------------------------------

let measurer: CanvasRenderingContext2D | null = null;

const measureContext = (): CanvasRenderingContext2D | null => {
  if (measurer === null && typeof document !== 'undefined')
    measurer = document.createElement('canvas').getContext('2d');
  return measurer;
};

/** Size of a text block as rendered: the widest line by the line count. */
export function measureText(text: string, size: number): {w: number; h: number} {
  const ctx = measureContext();
  const lines = text.split('\n');
  let w = 0;
  if (ctx !== null) {
    ctx.font = `${size}px ${FONT}`;
    for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  } else w = Math.max(...lines.map(l => l.length)) * size * 0.55;
  return {w: Math.max(w, size * 0.6), h: lines.length * size * LINE_HEIGHT};
}

/** Word-wrap `text` into lines no wider than `maxW`; explicit newlines are kept. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && ctx.measureText(candidate).width > maxW) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}

// ---- colours -------------------------------------------------------------------------------------

export function hueColor(palette: Palette, hue: Hue): string {
  switch (hue) {
    case 'ink':
      return palette.ink[100];
    case 'iris':
      return palette.iris[400];
    case 'http':
    case 'grpc':
    case 'kafka':
    case 'redis':
      return palette.concept[hue];
    default:
      return palette[hue][400];
  }
}

/** `#rrggbb` → `rgba(r, g, b, alpha)`. */
const withAlpha = (hex: string, alpha: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

// ---- rendering -----------------------------------------------------------------------------------

export interface Scene {
  shapes: readonly Shape[];
  /** Shapes mid-gesture (moved, resized) drawn in place of their committed versions. */
  overrides: ReadonlyMap<string, Shape>;
  /** The shape being drawn right now. */
  draft: Shape | null;
  selection: ReadonlySet<string>;
  /** Shapes the eraser has swept over, drawn faded until the gesture ends. */
  erasing: ReadonlySet<string>;
  /** Hidden while its text is being edited in the overlay. */
  editing: string | null;
  marquee: Rect | null;
  view: View;
  theme: Theme;
  grid: boolean;
}

function tracePath(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.beginPath();
  switch (s.kind) {
    case 'pen': {
      const pts = s.points;
      if (pts.length === 1) {
        ctx.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2);
        return;
      }
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0], last[1]);
      return;
    }
    case 'line':
    case 'arrow':
      ctx.moveTo(s.x1, s.y1);
      if (s.curve === undefined) ctx.lineTo(s.x2, s.y2);
      else ctx.bezierCurveTo(s.curve[0], s.curve[1], s.curve[2], s.curve[3], s.x2, s.y2);
      return;
    case 'ellipse': {
      const b = normalizeRect(s.x, s.y, s.w, s.h);
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      return;
    }
    case 'diamond': {
      const b = normalizeRect(s.x, s.y, s.w, s.h);
      ctx.moveTo(b.x + b.w / 2, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h / 2);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h / 2);
      ctx.closePath();
      return;
    }
    case 'rect': {
      const b = normalizeRect(s.x, s.y, s.w, s.h);
      const r = Math.min(8, b.w / 2, b.h / 2);
      ctx.roundRect(b.x, b.y, b.w, b.h, r);
      return;
    }
    default:
      return;
  }
}

function drawArrowhead(ctx: CanvasRenderingContext2D, s: LineShape, color: string): void {
  // Along the tangent at the tip: for a curve, from the last control point.
  const [tx, ty] = s.curve === undefined ? [s.x1, s.y1] : [s.curve[2], s.curve[3]];
  const angle = Math.atan2(s.y2 - ty, s.x2 - tx);
  const size = 9 + s.width * 1.8;
  ctx.save();
  ctx.translate(s.x2, s.y2);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.42);
  ctx.lineTo(-size * 0.7, 0);
  ctx.lineTo(-size, size * 0.42);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxW: number,
  size: number,
  color: string,
  backdrop: string | null,
): void {
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrap(ctx, text, maxW);
  const lh = size * LINE_HEIGHT;
  const top = cy - ((lines.length - 1) * lh) / 2;
  if (backdrop !== null) {
    const w = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.fillStyle = backdrop;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2 - 4, top - lh / 2 - 1, w + 8, lines.length * lh + 2, 3);
    ctx.fill();
  }
  ctx.fillStyle = color;
  lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lh));
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, palette: Palette, editing: boolean): void {
  const color = hueColor(palette, s.hue);
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  if (s.kind === 'text') {
    if (editing) return;
    ctx.font = `${s.size}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.x, s.y + i * s.size * LINE_HEIGHT));
    return;
  }
  tracePath(ctx, s);
  if (isBox(s) && s.fill) {
    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.fill();
  }
  if (s.kind === 'pen' && s.points.length === 1) {
    ctx.fillStyle = color;
    ctx.fill();
  } else ctx.stroke();
  if (isLine(s)) {
    if (s.kind === 'arrow') drawArrowhead(ctx, s, color);
    if (s.label !== '' && !editing) {
      const [lx, ly] = labelAnchor(s);
      drawLabel(ctx, s.label, lx, ly, 220, EDGE_LABEL_SIZE, color, palette.ink[850]);
    }
  } else if (isBox(s) && s.label !== '' && !editing) {
    const b = normalizeRect(s.x, s.y, s.w, s.h);
    const inset = s.kind === 'rect' ? NEW_BOX_PADDING * 2 : b.w * 0.3;
    drawLabel(ctx, s.label, b.x + b.w / 2, b.y + b.h / 2, Math.max(24, b.w - inset), LABEL_SIZE, palette.ink[50], null);
  }
}

export function render(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number, scene: Scene): void {
  const palette = PALETTE[scene.theme];
  const {view} = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.ink[850];
  ctx.fillRect(0, 0, width, height);

  if (scene.grid && view.scale >= 0.5) {
    const step = GRID * view.scale;
    const ox = ((view.x % step) + step) % step;
    const oy = ((view.y % step) + step) % step;
    ctx.fillStyle = withAlpha(palette.ink[500], scene.theme === 'light' ? 0.45 : 0.35);
    for (let x = ox; x < width; x += step)
      for (let y = oy; y < height; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  for (const s of scene.shapes) {
    const shape = scene.overrides.get(s.id) ?? s;
    ctx.globalAlpha = scene.erasing.has(s.id) ? 0.25 : 1;
    drawShape(ctx, shape, palette, scene.editing === s.id);
  }
  ctx.globalAlpha = 1;
  if (scene.draft !== null) drawShape(ctx, scene.draft, palette, false);
  ctx.restore();

  // Selection chrome in screen space so it stays crisp at any zoom.
  const accent = palette.iris[400];
  for (const s of scene.shapes) {
    if (!scene.selection.has(s.id)) continue;
    const shape = scene.overrides.get(s.id) ?? s;
    const b = bounds(shape);
    const [x0, y0] = toScreen(view, b.x, b.y);
    const [x1, y1] = toScreen(view, b.x + b.w, b.y + b.h);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = accent;
    ctx.strokeRect(x0 - 5, y0 - 5, x1 - x0 + 10, y1 - y0 + 10);
    ctx.setLineDash([]);
    if (scene.selection.size === 1) {
      for (const [wx, wy] of Object.values(handles(shape))) {
        const [hx, hy] = toScreen(view, wx, wy);
        ctx.fillStyle = palette.ink[850];
        ctx.beginPath();
        if (isLine(shape)) ctx.arc(hx, hy, HANDLE / 2 + 1, 0, Math.PI * 2);
        else ctx.rect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  if (scene.marquee !== null) {
    const m = scene.marquee;
    const [x0, y0] = toScreen(view, m.x, m.y);
    const [x1, y1] = toScreen(view, m.x + m.w, m.y + m.h);
    ctx.fillStyle = withAlpha(accent, 0.12);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}

/** The sketch as a PNG at 2× on the panel colour, cropped to its contents; `null` when empty. */
export function exportPng(shapes: readonly Shape[], theme: Theme): Promise<Blob | null> {
  const b = boundsOf(shapes);
  if (b === null) return Promise.resolve(null);
  const pad = 32;
  const width = Math.ceil(b.w + pad * 2);
  const height = Math.ceil(b.h + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Promise.resolve(null);
  render(ctx, width, height, 2, {
    shapes,
    overrides: new Map(),
    draft: null,
    selection: new Set(),
    erasing: new Set(),
    editing: null,
    marquee: null,
    view: {x: pad - b.x, y: pad - b.y, scale: 1},
    theme,
    grid: false,
  });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// ---- the course's architecture as a sketch -------------------------------------------------------

const NODE_HUE: Record<NodeKind, Hue> = {
  client: 'ink',
  service: 'ink',
  external: 'ink',
  db: 'iris',
  http: 'http',
  grpc: 'grpc',
  kafka: 'kafka',
  redis: 'redis',
};

const EDGE_HUE: Record<EdgeKind, Hue> = {http: 'http', grpc: 'grpc', kafka: 'kafka', redis: 'redis', plain: 'ink'};

/**
 * The problem's architecture diagram as editable boxes and arrows, roomier than the pane draws it.
 * The arrows keep the pane's routing — S-curves between columns that detour around the boxes in
 * between, arcs over the top for back edges — and its label placement, so nothing lands on top of
 * anything else.
 */
export function fromDiagram(problem: Problem): Shape[] {
  const layout = layoutDiagram(problem.diagram);
  const K = 1.5;
  const px = (x: number): number => x * K;
  const py = (y: number): number => (y - layout.originY) * K;
  const shapes: Shape[] = [];
  for (const {edge, kind, from, to, controls, label} of layout.edges) {
    if (edge.from === edge.to) continue;
    shapes.push({
      id: uid(),
      kind: 'arrow',
      hue: EDGE_HUE[kind],
      width: 2,
      x1: px(from.x),
      y1: py(from.y),
      x2: px(to.x),
      y2: py(to.y),
      ...(controls === null
        ? {}
        : {curve: [px(controls[0].x), py(controls[0].y), px(controls[1].x), py(controls[1].y)] as Curve}),
      ...(label === null ? {} : {labelAt: [px(label.x), py(label.y)] as Point}),
      label: edge.label ?? '',
    });
  }
  // Boxes after the arrows: painted over them, and hit-tested first, so their bodies stay grabbable.
  for (const n of layout.nodes)
    shapes.push({
      id: uid(),
      kind: n.kind === 'db' ? 'ellipse' : 'rect',
      hue: NODE_HUE[n.kind],
      width: 2,
      x: px(n.cx - n.w / 2),
      y: py(n.cy - n.h / 2),
      w: n.w * K,
      h: n.h * K,
      fill: n.kind !== 'service' && n.kind !== 'external',
      label: n.sub === undefined ? n.label : `${n.label}\n${n.sub}`,
    });
  return shapes;
}

// ---- persistence ---------------------------------------------------------------------------------

const isHue = (v: unknown): v is Hue => typeof v === 'string' && HUES.includes(v as Hue);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);

/** Shapes from stored data, dropping anything malformed. */
export function normalizeShapes(value: unknown): Shape[] {
  if (!Array.isArray(value)) return [];
  const out: Shape[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string') continue;
    const base = {id: s.id, hue: isHue(s.hue) ? s.hue : ('ink' as const), width: num(s.width) ? s.width : WIDTHS[0]};
    switch (s.kind) {
      case 'pen':
        if (Array.isArray(s.points) && s.points.length > 0 && s.points.every(isPoint))
          out.push({...base, kind: 'pen', points: s.points});
        break;
      case 'rect':
      case 'ellipse':
      case 'diamond':
        if (num(s.x) && num(s.y) && num(s.w) && num(s.h))
          out.push({
            ...base,
            kind: s.kind,
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            fill: s.fill === true,
            label: typeof s.label === 'string' ? s.label : '',
          });
        break;
      case 'line':
      case 'arrow':
        if (num(s.x1) && num(s.y1) && num(s.x2) && num(s.y2)) {
          const curve =
            Array.isArray(s.curve) && s.curve.length === 4 && s.curve.every(num) ? (s.curve as Curve) : undefined;
          out.push({
            ...base,
            kind: s.kind,
            x1: s.x1,
            y1: s.y1,
            x2: s.x2,
            y2: s.y2,
            ...(curve === undefined ? {} : {curve}),
            ...(isPoint(s.labelAt) ? {labelAt: s.labelAt} : {}),
            label: typeof s.label === 'string' ? s.label : '',
          });
        }
        break;
      case 'text':
        if (num(s.x) && num(s.y) && typeof s.text === 'string' && s.text !== '') {
          const size = num(s.size) ? s.size : textSize(base.width);
          const measured = num(s.w) && num(s.h) ? {w: s.w, h: s.h} : measureText(s.text, size);
          out.push({...base, kind: 'text', x: s.x, y: s.y, text: s.text, size, ...measured});
        }
        break;
      default:
        break;
    }
  }
  return out;
}
