/**
 * GPU figures for the CUDA courses, drawn the way GPU references draw the programming model
 * (Modal's GPU Glossary, NVIDIA's guides): containment rather than flow. A grid holds thread
 * blocks, a block holds its warps and its shared memory, a thread its registers; data is a strip or
 * a matrix of cells with the slice that matters marked; arrows carry data between memory levels,
 * labelled with what moves. Software scopes are dashed outlines; hardware and memory are solid and
 * tinted by level.
 *
 * The spec is JSON in the course Markdown (`:::gpu`) and among `Problem.figures`; this module
 * validates it, lays it out (pure geometry, no DOM) and turns it into Mermaid for the Markdown
 * export. `components/GpuDiagram.tsx` draws it.
 */

/** What a box is: a software scope (dashed), a compute unit, or memory at one level of the hierarchy. */
export type GpuTone = 'scope' | 'compute' | 'host' | 'global' | 'shared' | 'register';
export const GPU_TONES: readonly GpuTone[] = ['scope', 'compute', 'host', 'global', 'shared', 'register'];

/**
 * What a marked slice is: about to move to, or living in, a memory level (`host` … `register`), idle
 * or padding (`muted`), wrong (`bad`), or whose it is (`a`, `b`, `c`: a sequence, a rank, a group).
 * The three categories are not memory levels, so the legend leaves them out; say in a label or the
 * detail what each one is.
 */
export type GpuMarkTone = 'host' | 'global' | 'shared' | 'register' | 'muted' | 'bad' | 'a' | 'b' | 'c';
export const GPU_MARK_TONES: readonly GpuMarkTone[] = [
  'host',
  'global',
  'shared',
  'register',
  'muted',
  'bad',
  'a',
  'b',
  'c',
];
export type GpuDataTone = 'host' | 'global' | 'shared' | 'register';
const DATA_TONES: readonly GpuDataTone[] = ['host', 'global', 'shared', 'register'];

export type GpuAlign = 'start' | 'center' | 'end';
const ALIGNS: readonly GpuAlign[] = ['start', 'center', 'end'];

/**
 * A container or a unit: a grid, a thread block, a warp, a loop (`scope`); an SM, a tensor core, a
 * copy engine (`compute`); a memory (`host`, `global`, `shared`, `register`). With `items` it holds
 * them; without, it is a labelled unit (a memory bar, a core).
 */
export interface GpuBox {
  id?: string;
  label?: string;
  /** Second line, small and monospaced: a size, a shape, a launch configuration. */
  sub?: string;
  tone?: GpuTone;
  /** Children left to right (`row`, the default), top to bottom (`column`), or `grid` with `columns`. */
  layout?: 'row' | 'column' | 'grid';
  /** Where children sit across the layout's direction (default `center`): `end` lines a row up at the bottom. */
  align?: GpuAlign;
  columns?: number;
  /** At the right of the title: this box stands for many ("× 512"). */
  count?: string;
  /** In a column, as wide as the column: a memory bar under a row of blocks. */
  stretch?: boolean;
  /** Shown on hover and focus. Inline Markdown. */
  detail?: string;
  items?: GpuItem[];
}

/** A slice of an array: columns (and rows) inclusive, zero-based. */
export interface GpuMark {
  cols: [number, number];
  rows?: [number, number];
  tone: GpuMarkTone;
  /** Under the slice (one-row arrays) or inside it (matrices). */
  label?: string;
}

/** Data: a strip of cells, or a matrix of `rows` × `cols` (each cell an element or a tile). */
export interface GpuArray {
  id?: string;
  /** The name above the cells: `a[n]`, `A · M × K`. */
  array: string;
  sub?: string;
  cols: number;
  rows?: number;
  /** Where it lives, which tints the cells (default `global`). */
  tone?: GpuDataTone;
  /** Text in the cells: their index, or one label per cell, row by row. */
  cells?: 'index' | string[];
  marks?: GpuMark[];
  /** The array goes on past the last column drawn. */
  continues?: boolean;
  detail?: string;
}

/** Threads as the glossary draws them, one squiggle each: a warp's lanes, a block's threads. */
export interface GpuThreads {
  id?: string;
  threads: number;
  label?: string;
  /** The last `idle` of them do no work (threads past `n`). */
  idle?: number;
  continues?: boolean;
  detail?: string;
}

/** Between siblings: more of the same (`…`), or an operator (`=`, `@`, `+`). */
export interface GpuGap {
  gap: string;
}

export type GpuItem = GpuBox | GpuArray | GpuThreads | GpuGap;

/** Data moving from one part to another. */
export interface GpuArrow {
  from: string;
  to: string;
  /** What moves: `float4 loads`, `cudaMemcpyAsync · 4 MiB`. */
  label?: string;
  /** A dependency rather than a transfer (an event, a barrier). */
  dashed?: boolean;
}

export interface GpuFigure {
  /** The top-level items left to right (`row`, the default) or top to bottom. */
  layout?: 'row' | 'column';
  align?: GpuAlign;
  items: GpuItem[];
  arrows?: GpuArrow[];
}

export const isGpuArray = (item: GpuItem): item is GpuArray => 'array' in item;
export const isGpuThreads = (item: GpuItem): item is GpuThreads => 'threads' in item;
export const isGpuGap = (item: GpuItem): item is GpuGap => 'gap' in item;
export const isGpuBox = (item: GpuItem): item is GpuBox => !isGpuArray(item) && !isGpuThreads(item) && !isGpuGap(item);

const MAX_COLS = 32;
const MAX_ROWS = 16;
const ID = /^[A-Za-z0-9][\w-]*$/;

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

const isRange = (v: unknown, size: number): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isInt(v[0], 0, size - 1) && isInt(v[1], 0, size - 1) && v[0] <= v[1];

// ---- validation -----------------------------------------------------------------------------------

/** Every way the spec is wrong, as sentences; empty when it can be drawn. */
export function gpuProblems(spec: unknown): string[] {
  const problems: string[] = [];
  if (typeof spec !== 'object' || spec === null || !Array.isArray((spec as GpuFigure).items))
    return ['a GPU figure is an object with an `items` array'];
  const fig = spec as GpuFigure;
  if (fig.layout !== undefined && fig.layout !== 'row' && fig.layout !== 'column')
    problems.push(`layout '${String(fig.layout)}' is neither 'row' nor 'column'`);
  if (fig.align !== undefined && !ALIGNS.includes(fig.align)) problems.push(`unknown align '${String(fig.align)}'`);
  const ids = new Set<string>();
  const claim = (id: unknown, what: string): void => {
    if (id === undefined) return;
    if (typeof id !== 'string' || !ID.test(id)) problems.push(`${what} has an id that is not a plain name`);
    else if (ids.has(id)) problems.push(`duplicate id '${id}'`);
    else ids.add(id);
  };
  const walk = (items: unknown, where: string): void => {
    if (!Array.isArray(items) || items.length === 0) {
      problems.push(`${where} has no items`);
      return;
    }
    for (const raw of items as GpuItem[]) {
      if (typeof raw !== 'object' || raw === null) {
        problems.push(`${where}: an item is not an object`);
        continue;
      }
      if (isGpuGap(raw)) {
        if (typeof raw.gap !== 'string' || raw.gap.trim() === '') problems.push(`${where}: a gap has no text`);
      } else if (isGpuThreads(raw)) {
        claim(raw.id, `${where}: threads`);
        if (!isInt(raw.threads, 1, MAX_COLS))
          problems.push(`${where}: threads is a whole number from 1 to ${MAX_COLS}`);
        else if (raw.idle !== undefined && !isInt(raw.idle, 0, raw.threads))
          problems.push(`${where}: idle threads must be between 0 and ${raw.threads}`);
      } else if (isGpuArray(raw)) {
        claim(raw.id, `${where}: array '${String(raw.array)}'`);
        const name = `${where}: array '${String(raw.array)}'`;
        if (typeof raw.array !== 'string' || raw.array.trim() === '') problems.push(`${where}: an array has no name`);
        if (!isInt(raw.cols, 1, MAX_COLS)) problems.push(`${name}: cols is a whole number from 1 to ${MAX_COLS}`);
        if (raw.rows !== undefined && !isInt(raw.rows, 1, MAX_ROWS))
          problems.push(`${name}: rows is a whole number from 1 to ${MAX_ROWS}`);
        if (raw.tone !== undefined && !DATA_TONES.includes(raw.tone))
          problems.push(`${name}: unknown tone '${String(raw.tone)}'`);
        const cols = isInt(raw.cols, 1, MAX_COLS) ? raw.cols : 1;
        const rows = raw.rows ?? 1;
        if (raw.cells !== undefined && raw.cells !== 'index') {
          if (!Array.isArray(raw.cells) || raw.cells.some(c => typeof c !== 'string'))
            problems.push(`${name}: cells is 'index' or a list of strings`);
          else if (raw.cells.length > rows * cols) problems.push(`${name}: more cell labels than cells`);
        }
        for (const m of raw.marks ?? []) {
          if (!isRange(m.cols, cols)) problems.push(`${name}: a mark's cols are not a range inside 0..${cols - 1}`);
          if (m.rows !== undefined && !isRange(m.rows, rows))
            problems.push(`${name}: a mark's rows are not a range inside 0..${rows - 1}`);
          if (!GPU_MARK_TONES.includes(m.tone)) problems.push(`${name}: unknown mark tone '${String(m.tone)}'`);
        }
      } else {
        claim(raw.id, `${where}: a box`);
        const name = `${where} › ${raw.label ?? raw.id ?? 'box'}`;
        if (raw.tone !== undefined && !GPU_TONES.includes(raw.tone))
          problems.push(`${name}: unknown tone '${String(raw.tone)}'`);
        if (raw.layout !== undefined && !['row', 'column', 'grid'].includes(raw.layout))
          problems.push(`${name}: unknown layout '${String(raw.layout)}'`);
        if (raw.align !== undefined && !ALIGNS.includes(raw.align))
          problems.push(`${name}: unknown align '${String(raw.align)}'`);
        if (raw.layout === 'grid' && !isInt(raw.columns, 1, MAX_COLS))
          problems.push(`${name}: a grid needs a whole number of columns`);
        if (raw.items === undefined) {
          if (typeof raw.label !== 'string' || raw.label.trim() === '') problems.push(`${where}: a box has no label`);
        } else walk(raw.items, name);
      }
    }
  };
  walk(fig.items, 'items');
  for (const a of fig.arrows ?? []) {
    if (!ids.has(a.from)) problems.push(`an arrow starts at '${String(a.from)}', which is not an id in the figure`);
    if (!ids.has(a.to)) problems.push(`an arrow ends at '${String(a.to)}', which is not an id in the figure`);
    if (a.from === a.to) problems.push(`an arrow from '${a.from}' to itself`);
  }
  return problems;
}

/** Every id of the figure (step `focus` names them). */
export function gpuIds(fig: GpuFigure): Set<string> {
  const out = new Set<string>();
  const walk = (items: GpuItem[]): void => {
    for (const item of items) {
      if (isGpuGap(item)) continue;
      if (item.id !== undefined) out.add(item.id);
      if (isGpuBox(item) && item.items !== undefined) walk(item.items);
    }
  };
  walk(fig.items);
  return out;
}

// ---- layout ---------------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  id?: string;
  detail?: string;
  box: Box;
  /** Ids of the boxes around it, outermost first. */
  ancestors: string[];
}

export interface PlacedGpuBox extends Placed {
  label?: string;
  sub?: string;
  count?: string;
  tone: GpuTone;
  /** No items: a unit, its label centred. */
  leaf: boolean;
  /** Ids inside it, at any depth. */
  descendants: string[];
}

export interface PlacedGpuArray extends Placed {
  label: string;
  sub?: string;
  tone: GpuDataTone;
  cols: number;
  rows: number;
  cell: number;
  /** The cells' top-left corner. */
  origin: Point;
  cells?: 'index' | string[];
  marks: GpuMark[];
  continues: boolean;
}

export interface PlacedGpuThreads extends Placed {
  count: number;
  idle: number;
  label?: string;
  continues: boolean;
}

export interface PlacedGpuGap {
  text: string;
  x: number;
  y: number;
}

export interface PlacedGpuArrow {
  from: string;
  to: string;
  points: Point[];
  label?: string;
  labelAt?: Point;
  /** Where the label anchors on `labelAt`. */
  labelAnchor: 'start' | 'middle';
  dashed: boolean;
}

export interface GpuLayout {
  minX: number;
  minY: number;
  width: number;
  height: number;
  boxes: PlacedGpuBox[];
  arrays: PlacedGpuArray[];
  threads: PlacedGpuThreads[];
  gaps: PlacedGpuGap[];
  arrows: PlacedGpuArrow[];
}

export const GPU_LABEL_FONT = 11.5;
export const GPU_SUB_FONT = 9;
export const GPU_ARRAY_FONT = 10;
export const GPU_CELL_FONT = 7.5;
export const GPU_ARROW_FONT = 9;
const LABEL_CHAR = 6.7;
const SUB_CHAR = 5.45;
const ARRAY_CHAR = 6.05;
const COUNT_CHAR = 6.4;
const ARROW_CHAR = 5.45;
const PAD = 10;
const GAP = 12;
const TOP_GAP = 40;
const TITLE_H = 17;
const SUB_H = 12;
const HEAD_GAP = 6;
const LEAF_MIN_W = 84;
const LEAF_H = 28;
const LEAF_H_SUB = 40;
const ARRAY_LABEL_H = 15;
const MARK_LABEL_H = 13;
const MORE_W = 18;
export const THREAD_W = 9;
export const THREAD_H = 20;
const THREAD_LABEL_H = 13;
const MARGIN = 12;
/** Facing sides that overlap by this much take a straight arrow. */
const STRAIGHT = 14;

const textWidth = (text: string | undefined, perChar: number): number =>
  text === undefined ? 0 : [...text].length * perChar;

const cellSize = (a: GpuArray): number => (a.cols > 24 ? 12 : 14);

interface Size {
  w: number;
  h: number;
}

/** A layout pass: the arrows (they widen the gaps they cross) and what has been measured. */
interface Ctx {
  arrows: GpuArrow[];
  sizes: Map<GpuItem, Size>;
  ids: Map<GpuItem, Set<string>>;
}

/** The item's id and every id inside it. */
function idsOf(item: GpuItem, ctx: Ctx): Set<string> {
  const known = ctx.ids.get(item);
  if (known !== undefined) return known;
  const out = new Set<string>();
  if (!isGpuGap(item)) {
    if (item.id !== undefined) out.add(item.id);
    if (isGpuBox(item)) for (const child of item.items ?? []) for (const id of idsOf(child, ctx)) out.add(id);
  }
  ctx.ids.set(item, out);
  return out;
}

/**
 * The room between consecutive siblings: the base gap, or enough for the arrows that cross it, with
 * their labels above them (a row's gap) or beside them (a column's).
 */
function gapsBetween(items: GpuItem[], axis: 'row' | 'column', base: number, ctx: Ctx): number[] {
  const gaps: number[] = [];
  for (let k = 0; k + 1 < items.length; k += 1) {
    const a = idsOf(items[k], ctx);
    const b = idsOf(items[k + 1], ctx);
    const crossing = ctx.arrows.filter(w => (a.has(w.from) && b.has(w.to)) || (b.has(w.from) && a.has(w.to)));
    if (crossing.length === 0) gaps.push(base);
    else if (axis === 'column') gaps.push(Math.max(base, 34));
    else gaps.push(Math.max(base, 44, ...crossing.map(w => textWidth(w.label, ARROW_CHAR) + 28)));
  }
  return gaps;
}

const headerHeight = (b: GpuBox): number => {
  const title = b.label !== undefined || b.count !== undefined ? TITLE_H : 0;
  const sub = b.sub !== undefined ? SUB_H : 0;
  return title + sub === 0 ? 0 : title + sub + HEAD_GAP;
};

const headerWidth = (b: GpuBox): number =>
  Math.max(
    textWidth(b.label, LABEL_CHAR) + (b.count === undefined ? 0 : textWidth(b.count, COUNT_CHAR) + 14),
    textWidth(b.sub, SUB_CHAR),
  );

/** A one-row array's marks with labels need a line under the cells. */
const markLabelRow = (a: GpuArray): boolean => (a.rows ?? 1) === 1 && (a.marks ?? []).some(m => m.label !== undefined);

/** Width of an array's name line: the name, then the sub in the smaller face. */
const arrayLabelWidth = (a: GpuArray): number =>
  textWidth(a.array, ARRAY_CHAR) + (a.sub === undefined ? 0 : 8 + textWidth(a.sub, SUB_CHAR));

function measure(item: GpuItem, ctx: Ctx): Size {
  const known = ctx.sizes.get(item);
  if (known !== undefined) return known;
  let size: Size;
  if (isGpuGap(item)) size = {w: textWidth(item.gap, ARRAY_CHAR * 1.2) + 10, h: 18};
  else if (isGpuThreads(item))
    size = {
      w: Math.max(item.threads * THREAD_W + (item.continues === true ? MORE_W : 0), textWidth(item.label, SUB_CHAR)),
      h: THREAD_H + (item.label === undefined ? 0 : THREAD_LABEL_H),
    };
  else if (isGpuArray(item)) {
    const cell = cellSize(item);
    size = {
      w: Math.max(item.cols * cell + (item.continues === true ? MORE_W : 0), arrayLabelWidth(item)),
      h: ARRAY_LABEL_H + (item.rows ?? 1) * cell + (markLabelRow(item) ? MARK_LABEL_H : 0),
    };
  } else if (item.items === undefined || item.items.length === 0) {
    const text = Math.max(
      textWidth(item.label, LABEL_CHAR) + (item.count === undefined ? 0 : textWidth(item.count, COUNT_CHAR) + 10),
      textWidth(item.sub, SUB_CHAR),
    );
    size = {w: Math.max(LEAF_MIN_W, Math.ceil(text) + 24), h: item.sub === undefined ? LEAF_H : LEAF_H_SUB};
  } else {
    const inner = innerSize(item.layout, item.columns, item.items, GAP, ctx);
    size = {w: Math.max(inner.w, headerWidth(item)) + PAD * 2, h: headerHeight(item) + inner.h + PAD * 2};
  }
  ctx.sizes.set(item, size);
  return size;
}

function innerSize(
  layout: string | undefined,
  columns: number | undefined,
  items: GpuItem[],
  base: number,
  ctx: Ctx,
): Size {
  const sizes = items.map(i => measure(i, ctx));
  if (layout === 'grid') {
    const cols = Math.max(1, Math.min(columns ?? 1, items.length));
    const rows = Math.ceil(items.length / cols);
    const cw = Math.max(...sizes.map(s => s.w));
    const ch = Math.max(...sizes.map(s => s.h));
    return {w: cols * cw + base * (cols - 1), h: rows * ch + base * (rows - 1)};
  }
  const column = layout === 'column';
  const gaps = gapsBetween(items, column ? 'column' : 'row', base, ctx).reduce((s, g) => s + g, 0);
  return column
    ? {w: Math.max(...sizes.map(s => s.w)), h: sizes.reduce((s, x) => s + x.h, 0) + gaps}
    : {w: sizes.reduce((s, x) => s + x.w, 0) + gaps, h: Math.max(...sizes.map(s => s.h))};
}

interface Out {
  boxes: PlacedGpuBox[];
  arrays: PlacedGpuArray[];
  threads: PlacedGpuThreads[];
  gaps: PlacedGpuGap[];
  /** Each id's containers, outermost first, then its own box: where two ends' chains part is the free corridor. */
  chains: Map<string, Box[]>;
}

const across = (align: GpuAlign | undefined, start: number, room: number, size: number): number =>
  align === 'start' ? start : align === 'end' ? start + room - size : start + (room - size) / 2;

/** Lays `items` out inside `area` the way `layout` says, placed across the layout by `align`. */
function placeChildren(
  items: GpuItem[],
  layout: string | undefined,
  columns: number | undefined,
  align: GpuAlign | undefined,
  area: Box,
  base: number,
  ancestors: string[],
  chain: Box[],
  ctx: Ctx,
  out: Out,
): void {
  const sizes = items.map(i => measure(i, ctx));
  if (layout === 'grid') {
    const cols = Math.max(1, Math.min(columns ?? 1, items.length));
    const cw = Math.max(...sizes.map(s => s.w));
    const ch = Math.max(...sizes.map(s => s.h));
    items.forEach((item, k) => {
      const s = sizes[k];
      const cx = area.x + (k % cols) * (cw + base) + cw / 2;
      const cy = area.y + Math.floor(k / cols) * (ch + base) + ch / 2;
      place(item, {x: cx - s.w / 2, y: cy - s.h / 2, w: s.w, h: s.h}, ancestors, chain, ctx, out);
    });
    return;
  }
  const column = layout === 'column';
  const gaps = gapsBetween(items, column ? 'column' : 'row', base, ctx);
  if (column) {
    let y = area.y;
    items.forEach((item, k) => {
      const s = sizes[k];
      const w = isGpuBox(item) && item.stretch === true ? area.w : s.w;
      place(item, {x: across(align, area.x, area.w, w), y, w, h: s.h}, ancestors, chain, ctx, out);
      y += s.h + (gaps[k] ?? 0);
    });
  } else {
    const total = sizes.reduce((s, x) => s + x.w, 0) + gaps.reduce((s, g) => s + g, 0);
    let x = area.x + (area.w - total) / 2;
    items.forEach((item, k) => {
      const s = sizes[k];
      place(item, {x, y: across(align, area.y, area.h, s.h), w: s.w, h: s.h}, ancestors, chain, ctx, out);
      x += s.w + (gaps[k] ?? 0);
    });
  }
}

function place(item: GpuItem, box: Box, ancestors: string[], chain: Box[], ctx: Ctx, out: Out): void {
  if (isGpuGap(item)) {
    out.gaps.push({text: item.gap, x: box.x + box.w / 2, y: box.y + box.h / 2 + 4});
    return;
  }
  if (item.id !== undefined) out.chains.set(item.id, [...chain, box]);
  if (isGpuThreads(item)) {
    out.threads.push({
      id: item.id,
      detail: item.detail,
      box,
      ancestors,
      count: item.threads,
      idle: item.idle ?? 0,
      label: item.label,
      continues: item.continues === true,
    });
    return;
  }
  if (isGpuArray(item)) {
    out.arrays.push({
      id: item.id,
      detail: item.detail,
      box,
      ancestors,
      label: item.array,
      sub: item.sub,
      tone: item.tone ?? 'global',
      cols: item.cols,
      rows: item.rows ?? 1,
      cell: cellSize(item),
      origin: {x: box.x, y: box.y + ARRAY_LABEL_H},
      cells: item.cells,
      marks: item.marks ?? [],
      continues: item.continues === true,
    });
    return;
  }
  const leaf = item.items === undefined || item.items.length === 0;
  out.boxes.push({
    id: item.id,
    detail: item.detail,
    box,
    ancestors,
    label: item.label,
    sub: item.sub,
    count: item.count,
    tone: item.tone ?? 'scope',
    leaf,
    descendants: [...idsOf(item, ctx)].filter(id => id !== item.id),
  });
  if (leaf || item.items === undefined) return;
  const head = headerHeight(item);
  const inner: Box = {x: box.x + PAD, y: box.y + PAD + head, w: box.w - PAD * 2, h: box.h - PAD * 2 - head};
  const within = item.id === undefined ? ancestors : [...ancestors, item.id];
  placeChildren(item.items, item.layout, item.columns, item.align, inner, GAP, within, [...chain, box], ctx, out);
}

type Side = 'left' | 'right' | 'top' | 'bottom';

interface Route {
  arrow: GpuArrow;
  from: Box;
  to: Box;
  out: Side;
  in: Side;
  /** The shared coordinate of a straight arrow (y across a row, x down a column). */
  straight: number | null;
}

const sideOf = (from: Box, to: Box): [Side, Side] => {
  const dx = Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w));
  const dy = Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h));
  if (dx >= dy) return to.x >= from.x + from.w / 2 ? ['right', 'left'] : ['left', 'right'];
  return to.y >= from.y + from.h / 2 ? ['bottom', 'top'] : ['top', 'bottom'];
};

const horizontal = (side: Side): boolean => side === 'left' || side === 'right';

/** The overlap of two boxes' extents across an arrow's direction. */
const overlap = (a: Box, b: Box, rowWise: boolean): [number, number] =>
  rowWise ? [Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)] : [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)];

const edge = (b: Box, side: Side): number =>
  side === 'left' ? b.x : side === 'right' ? b.x + b.w : side === 'top' ? b.y : b.y + b.h;

/**
 * Arrows leave and enter on the sides facing each other: straight where those sides overlap (several
 * between one pair share the overlap), otherwise with a bend. Bends and labels sit in the corridor
 * between the two containers, one around each end, that stand side by side where the ends' chains of
 * containers part: nothing else is drawn there. Bent arrows on one side spread along it.
 */
function routeArrows(
  arrows: GpuArrow[],
  boxOf: Map<string, Box>,
  attach: Map<string, {row: Box; column: Box}>,
  chains: Map<string, Box[]>,
): PlacedGpuArrow[] {
  const routes: Route[] = [];
  for (const arrow of arrows) {
    const from = boxOf.get(arrow.from);
    const to = boxOf.get(arrow.to);
    if (from === undefined || to === undefined) continue;
    const [o, i] = sideOf(from, to);
    // An array is met at its cells from the side, and over its whole height (name line included) from above or below.
    const meet = (id: string, b: Box): Box => {
      const a = attach.get(id);
      return a === undefined ? b : horizontal(o) ? a.row : a.column;
    };
    routes.push({arrow, from: meet(arrow.from, from), to: meet(arrow.to, to), out: o, in: i, straight: null});
  }
  // Straight arrows: one pair of boxes shares its overlap between the arrows that join them.
  const pairs = new Map<string, Route[]>();
  for (const r of routes) {
    const rowWise = horizontal(r.out);
    const [lo, hi] = overlap(r.from, r.to, rowWise);
    // Enough shared extent for a straight line: a quarter of the thinner part (a one-row array is 14 high), at most STRAIGHT.
    const thinner = rowWise ? Math.min(r.from.h, r.to.h) : Math.min(r.from.w, r.to.w);
    if (hi - lo < Math.min(STRAIGHT, thinner / 4)) continue;
    const key = [r.arrow.from, r.arrow.to].sort().join(' ');
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  for (const list of pairs.values())
    list.forEach((r, k) => {
      const [lo, hi] = overlap(r.from, r.to, horizontal(r.out));
      r.straight = lo + ((hi - lo) * (k + 1)) / (list.length + 1);
    });
  // Bent arrows: per box and side, spread the attachments in the order of the other end along that side.
  const ports = new Map<string, {route: Route; end: 'from' | 'to'}[]>();
  for (const r of routes) {
    if (r.straight !== null) continue;
    for (const end of ['from', 'to'] as const) {
      const key = `${end === 'from' ? r.arrow.from : r.arrow.to}:${end === 'from' ? r.out : r.in}`;
      ports.set(key, [...(ports.get(key) ?? []), {route: r, end}]);
    }
  }
  const at = new Map<Route, {from?: Point; to?: Point}>();
  for (const [key, list] of ports) {
    const side = key.slice(key.lastIndexOf(':') + 1) as Side;
    const other = (e: {route: Route; end: 'from' | 'to'}): number => {
      const b = e.end === 'from' ? e.route.to : e.route.from;
      return horizontal(side) ? b.y + b.h / 2 : b.x + b.w / 2;
    };
    list.sort((a, b) => other(a) - other(b));
    list.forEach((e, k) => {
      const b = e.end === 'from' ? e.route.from : e.route.to;
      const f = (k + 1) / (list.length + 1);
      const p: Point =
        side === 'left'
          ? {x: b.x, y: b.y + b.h * f}
          : side === 'right'
          ? {x: b.x + b.w, y: b.y + b.h * f}
          : side === 'top'
          ? {x: b.x + b.w * f, y: b.y}
          : {x: b.x + b.w * f, y: b.y + b.h};
      at.set(e.route, {...at.get(e.route), [e.end]: p});
    });
  }
  /** The containers, one around each end, that stand side by side under the ends' common container. */
  const split = (r: Route): [Box, Box] => {
    const a = chains.get(r.arrow.from) ?? [r.from];
    const b = chains.get(r.arrow.to) ?? [r.to];
    let k = 0;
    while (k < a.length - 1 && k < b.length - 1 && a[k] === b[k]) k += 1;
    return a[k] === b[k] ? [r.from, r.to] : [a[k], b[k]];
  };
  return routes.map(r => {
    const rowWise = horizontal(r.out);
    let points: Point[];
    let labelAt: Point;
    let labelAnchor: 'start' | 'middle' = 'middle';
    // The corridor's middle along the arrow, where the bend and the label go.
    const [a, b] = split(r);
    const forward = r.out === 'right' || r.out === 'bottom';
    const open = forward ? edge(a, r.out) <= edge(b, r.in) : edge(a, r.out) >= edge(b, r.in);
    const mid = open ? (edge(a, r.out) + edge(b, r.in)) / 2 : (edge(r.from, r.out) + edge(r.to, r.in)) / 2;
    if (r.straight !== null) {
      const c = r.straight;
      const p0 = rowWise ? {x: edge(r.from, r.out), y: c} : {x: c, y: edge(r.from, r.out)};
      const p1 = rowWise ? {x: edge(r.to, r.in), y: c} : {x: c, y: edge(r.to, r.in)};
      points = [p0, p1];
      if (rowWise) labelAt = {x: mid, y: c - 5};
      else {
        labelAt = {x: c + 6, y: mid + 3};
        labelAnchor = 'start';
      }
    } else {
      const ends = at.get(r) ?? {};
      const p0 = ends.from ?? {x: edge(r.from, r.out), y: r.from.y};
      const p1 = ends.to ?? {x: edge(r.to, r.in), y: r.to.y};
      if (rowWise) {
        points = [p0, {x: mid, y: p0.y}, {x: mid, y: p1.y}, p1];
        // Above the upper run, beside the bend: never on the jog itself.
        labelAt = {x: mid, y: Math.min(p0.y, p1.y) - 5};
      } else {
        points = [p0, {x: p0.x, y: mid}, {x: p1.x, y: mid}, p1];
        labelAt = {x: (p0.x + p1.x) / 2, y: mid - 4};
      }
    }
    return {
      from: r.arrow.from,
      to: r.arrow.to,
      points,
      label: r.arrow.label,
      labelAt: r.arrow.label === undefined ? undefined : labelAt,
      labelAnchor,
      dashed: r.arrow.dashed === true,
    };
  });
}

/** The whole figure, laid out; the drawing scales it to the column. */
export function layoutGpu(fig: GpuFigure): GpuLayout {
  const ctx: Ctx = {arrows: fig.arrows ?? [], sizes: new Map(), ids: new Map()};
  const out: Out = {boxes: [], arrays: [], threads: [], gaps: [], chains: new Map()};
  const layout = fig.layout ?? 'row';
  // Top-level items sit further apart than siblings inside a box: arrows between them need the room.
  const span = innerSize(layout, undefined, fig.items, TOP_GAP, ctx);
  placeChildren(fig.items, layout, undefined, fig.align, {x: 0, y: 0, ...span}, TOP_GAP, [], [], ctx, out);
  const boxOf = new Map<string, Box>();
  for (const p of [...out.boxes, ...out.arrays, ...out.threads]) if (p.id !== undefined) boxOf.set(p.id, p.box);
  const attach = new Map<string, {row: Box; column: Box}>();
  for (const a of out.arrays)
    if (a.id !== undefined) {
      // From the side an arrow meets the cells, past the `…` of an array that goes on.
      const cells = {x: a.origin.x, y: a.origin.y, w: a.cols * a.cell + (a.continues ? MORE_W : 0), h: a.rows * a.cell};
      attach.set(a.id, {row: cells, column: {x: cells.x, y: a.box.y, w: cells.w, h: a.box.h}});
    }
  const arrows = routeArrows(ctx.arrows, boxOf, attach, out.chains);
  let minX = 0;
  let minY = 0;
  let maxX = span.w;
  let maxY = span.h;
  for (const a of arrows) {
    for (const p of a.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    if (a.label !== undefined && a.labelAt !== undefined) {
      const w = textWidth(a.label, ARROW_CHAR);
      const x0 = a.labelAnchor === 'start' ? a.labelAt.x : a.labelAt.x - w / 2;
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0 + w);
      minY = Math.min(minY, a.labelAt.y - 10);
      maxY = Math.max(maxY, a.labelAt.y + 3);
    }
  }
  return {
    minX: minX - MARGIN,
    minY: minY - MARGIN,
    width: maxX - minX + MARGIN * 2,
    height: maxY - minY + MARGIN * 2,
    boxes: out.boxes,
    arrays: out.arrays,
    threads: out.threads,
    gaps: out.gaps,
    arrows,
  };
}

/** The x where an array's name line ends: its detail dot goes just past it. */
export const arrayLabelEnd = (a: PlacedGpuArray): number =>
  a.box.x +
  Math.max(
    a.cols * a.cell,
    textWidth(a.label, ARRAY_CHAR) + (a.sub === undefined ? 0 : 8 + textWidth(a.sub, SUB_CHAR)),
  );

// ---- Mermaid --------------------------------------------------------------------------------------

const mermaidText = (s: string): string => s.replace(/\*\*/g, '').replace(/"/g, '#quot;').replace(/\|/g, '¦');

/** The figure as a Mermaid flowchart: boxes with items as subgraphs, the rest as nodes, arrows as edges. */
export function gpuToMermaid(fig: GpuFigure): string {
  const lines = [`flowchart ${fig.layout === 'column' ? 'TB' : 'LR'}`];
  let anon = 0;
  const node = (id: string | undefined): string =>
    id === undefined ? `g_${(anon += 1)}` : `g_${id.replace(/[^\w]/g, '_')}`;
  const walk = (items: GpuItem[], indent: string): void => {
    for (const item of items) {
      if (isGpuGap(item)) continue;
      if (isGpuThreads(item)) {
        const label = `${item.threads} threads${item.label === undefined ? '' : ` · ${item.label}`}`;
        lines.push(`${indent}${node(item.id)}(["${mermaidText(label)}"])`);
      } else if (isGpuArray(item)) {
        const label = item.sub === undefined ? item.array : `${item.array}<br/>${item.sub}`;
        lines.push(`${indent}${node(item.id)}[("${mermaidText(label)}")]`);
      } else if (item.items === undefined || item.items.length === 0) {
        const head = [item.label, item.count].filter(Boolean).join(' ');
        const label = item.sub === undefined ? head : `${head}<br/>${item.sub}`;
        lines.push(`${indent}${node(item.id)}["${mermaidText(label)}"]`);
      } else {
        const head = [item.label, item.count].filter(Boolean).join(' ') || ' ';
        lines.push(`${indent}subgraph ${node(item.id)}["${mermaidText(head)}"]`);
        walk(item.items, `${indent}  `);
        lines.push(`${indent}end`);
      }
    }
  };
  walk(fig.items, '  ');
  for (const a of fig.arrows ?? []) {
    const label = a.label === undefined ? '' : `|"${mermaidText(a.label)}"|`;
    lines.push(`  ${node(a.from)} ${a.dashed === true ? '-.->' : '-->'}${label} ${node(a.to)}`);
  }
  return lines.join('\n');
}
