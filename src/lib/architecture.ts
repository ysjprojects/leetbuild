/**
 * Architecture figures for the deep-learning track, drawn the way model papers and the LLM
 * Architecture Gallery draw them: a stack of layers read bottom to top, frames for the model and
 * for the repeated block (with its `N ×` brace), residual connections that leave the main path
 * below a sublayer and come back in at a ⊕, parallel paths that meet again (a gated MLP, Q/K/V),
 * boxes feeding in from the side (RoPE into attention), callouts on dotted leaders with the
 * figures that matter highlighted, and insets that open one layer up (the feed-forward network).
 *
 * The spec is JSON in the course Markdown (`:::architecture`) and on `Problem.architecture`; this
 * module validates it, lays it out (pure geometry, no DOM) and turns it into Mermaid for the
 * Markdown export. `components/ArchitectureDiagram.tsx` draws it.
 */

/** What a box is, which decides how it looks. */
export type ArchKind =
  | 'layer'
  | 'attention'
  | 'ffn'
  | 'norm'
  | 'embed'
  | 'io'
  | 'head'
  | 'loss'
  | 'host'
  | 'memory'
  | 'kernel';

export const ARCH_KINDS: readonly ArchKind[] = [
  'layer',
  'attention',
  'ffn',
  'norm',
  'embed',
  'io',
  'head',
  'loss',
  'host',
  'memory',
  'kernel',
];

/** A layer, a stage, a memory level: one box. */
export interface ArchBlock {
  id: string;
  label: string;
  /** Second line, small and monospaced: a dimension, a formula, `768 → 3,072`. */
  sub?: string;
  kind?: ArchKind;
  /** Shown on hover and focus: what it computes, its shapes, its parameters. Inline Markdown. */
  detail?: string;
  /** The tensor it hands to the next item, shown on its outgoing arrow when shapes are switched on. */
  shape?: string;
  /** A box to its left feeding into it: RoPE into attention, a mask into the softmax. */
  side?: {label: string; sub?: string; detail?: string};
}

/** ⊕ or ⊗ on the main path; with `from`, a residual connection carries the input of that block around to it. */
export interface ArchOp {
  id: string;
  op: '+' | '×';
  from?: string;
  detail?: string;
}

export interface ArchGroup {
  /** In the frame's top-left corner: "Transformer block". */
  label?: string;
  /** Beside a brace on the frame's left: "12 ×". */
  repeat?: string;
  /** The whole model (neutral), a repeated block (tinted), or a dotted outline. */
  tone?: 'model' | 'block' | 'dotted';
  items: ArchItem[];
}

/** Parallel paths from one input, each a stack read bottom to top; their outputs meet in the next item. */
export interface ArchBranch {
  columns: ArchItem[][];
}

export type ArchItem = ArchBlock | ArchOp | ArchGroup | ArchBranch;

export interface ArchNote {
  /** The block or op the leader points at. */
  at: string;
  /** Text with **highlighted** figures. */
  text: string;
  side?: 'left' | 'right';
}

export interface ArchInset {
  /** The block the inset opens up. */
  for: string;
  title?: string;
  items: ArchItem[];
  /** Under the inset, with **highlighted** figures. */
  note?: string;
}

export interface Architecture {
  /** Text under the first arrow: "Every effort moves you". */
  input?: string;
  /** Text above the last arrow: "next-token logits". */
  output?: string;
  /** Bottom to top. */
  items: ArchItem[];
  notes?: ArchNote[];
  insets?: ArchInset[];
}

export const isBranch = (item: ArchItem): item is ArchBranch => 'columns' in item;
export const isGroup = (item: ArchItem): item is ArchGroup => 'items' in item;
export const isOp = (item: ArchItem): item is ArchOp => 'op' in item;
export const isBlock = (item: ArchItem): item is ArchBlock =>
  !isBranch(item) && !isGroup(item) && !isOp(item) && 'label' in item;

// ---- validation -----------------------------------------------------------------------------------

/** Every way the spec is wrong, as sentences; empty when it can be drawn. */
export function architectureProblems(spec: unknown): string[] {
  const problems: string[] = [];
  if (typeof spec !== 'object' || spec === null || !Array.isArray((spec as Architecture).items))
    return ['an architecture is an object with an `items` array'];
  const arch = spec as Architecture;
  const ids = new Map<string, 'block' | 'op'>();
  const note = (id: unknown, what: string): void => {
    if (typeof id !== 'string' || id === '') problems.push(`${what} has no id`);
    else if (ids.has(id)) problems.push(`duplicate id '${id}'`);
  };
  const walk = (items: unknown, where: string): void => {
    if (!Array.isArray(items) || items.length === 0) {
      problems.push(`${where} has no items`);
      return;
    }
    const below = new Set<string>();
    for (const raw of items as ArchItem[]) {
      if (typeof raw !== 'object' || raw === null) {
        problems.push(`${where}: an item is not an object`);
        continue;
      }
      if (isBranch(raw)) {
        if (!Array.isArray(raw.columns) || raw.columns.length < 2)
          problems.push(`${where}: a branch needs two columns`);
        else raw.columns.forEach((c, i) => walk(c, `${where} › branch column ${i + 1}`));
      } else if (isGroup(raw)) {
        if (raw.tone !== undefined && !['model', 'block', 'dotted'].includes(raw.tone))
          problems.push(`${where}: unknown group tone '${String(raw.tone)}'`);
        walk(raw.items, `${where} › ${raw.label ?? 'group'}`);
      } else if (isOp(raw)) {
        note(raw.id, `${where}: an op`);
        if (raw.op !== '+' && raw.op !== '×') problems.push(`${where}: op '${raw.id}' is neither '+' nor '×'`);
        if (raw.from !== undefined && !below.has(raw.from))
          problems.push(
            `${where}: op '${raw.id}' takes its residual from '${raw.from}', which is not a block below it in the same stack`,
          );
        ids.set(raw.id, 'op');
      } else if (isBlock(raw)) {
        note(raw.id, `${where}: a block`);
        if (typeof raw.label !== 'string' || raw.label.trim() === '')
          problems.push(`${where}: block '${raw.id}' has no label`);
        if (raw.kind !== undefined && !ARCH_KINDS.includes(raw.kind))
          problems.push(`${where}: block '${raw.id}' has unknown kind '${String(raw.kind)}'`);
        ids.set(raw.id, 'block');
        below.add(raw.id);
      } else problems.push(`${where}: an item is neither a block, an op, a group nor a branch`);
    }
  };
  walk(arch.items, 'items');
  for (const inset of arch.insets ?? []) {
    if (!ids.has(inset.for)) problems.push(`an inset opens up '${inset.for}', which is not a block`);
    walk(inset.items, `inset for ${inset.for}`);
  }
  for (const n of arch.notes ?? []) {
    if (!ids.has(n.at)) problems.push(`a note points at '${n.at}', which is not a block or an op`);
    if (typeof n.text !== 'string' || n.text.trim() === '') problems.push(`the note at '${n.at}' has no text`);
    if (n.side !== undefined && n.side !== 'left' && n.side !== 'right')
      problems.push(`the note at '${n.at}' has side '${String(n.side)}'`);
  }
  return problems;
}

/** Every block and op id of the figure, insets included (step `focus` names them). */
export function architectureIds(arch: Architecture): Set<string> {
  const out = new Set<string>();
  const walk = (items: ArchItem[]): void => {
    for (const item of items) {
      if (isBranch(item)) item.columns.forEach(walk);
      else if (isGroup(item)) walk(item.items);
      else out.add(item.id);
    }
  };
  walk(arch.items);
  for (const inset of arch.insets ?? []) walk(inset.items);
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

export interface PlacedBlock {
  id: string;
  label: string;
  sub?: string;
  kind: ArchKind;
  detail?: string;
  shape?: string;
  box: Box;
  /** True for a side box (it has no outgoing arrow of its own on the main path). */
  side: boolean;
  /** For a side box, the block it feeds. */
  feeds?: string;
}

export interface PlacedOp {
  id: string;
  op: '+' | '×';
  detail?: string;
  c: Point;
  r: number;
}

export interface PlacedFrame {
  box: Box;
  tone: 'model' | 'block' | 'dotted';
  label?: string;
  repeat?: string;
  /**
   * Inside another repeated frame: its brace goes at the top of its left edge, so its `N ×` does
   * not sit level with the outer one's at the bottom.
   */
  nested?: boolean;
}

/** A connector: a polyline, with an arrowhead at its end unless `open`. */
export interface Wire {
  points: Point[];
  open?: boolean;
  /** Residual connections and joins, drawn as junction dots where they leave the main path. */
  junction?: Point;
}

export interface PlacedText {
  lines: string[];
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

export interface PlacedNote {
  at: string;
  text: PlacedText;
  /** The dotted leader, from the target's edge to the text. */
  leader: Point[];
}

export interface PlacedShape {
  text: string;
  x: number;
  y: number;
}

export interface ArchLayout {
  minX: number;
  minY: number;
  width: number;
  height: number;
  blocks: PlacedBlock[];
  ops: PlacedOp[];
  frames: PlacedFrame[];
  wires: Wire[];
  shapes: PlacedShape[];
  notes: PlacedNote[];
  /** Dotted leaders from a block to its inset, and from an inset to its note. */
  leaders: Point[][];
  texts: PlacedText[];
}

export const LABEL_FONT = 12.5;
export const SUB_FONT = 9;
export const NOTE_FONT = 12;
const LABEL_CHAR = 7.1;
const SUB_CHAR = 5.45;
const NOTE_CHAR = 6.7;
const MIN_W = 132;
const MAX_W = 250;
const PAD_X = 16;
const BLOCK_H = 30;
const BLOCK_H_SUB = 42;
const OP_R = 9;
const GAP = 22;
const SIDE_GAP = 26;
const FRAME_PAD_X = 18;
const FRAME_PAD_Y = 14;
const FRAME_LABEL_H = 16;
const BRACE_W = 50;
/** Width of one character of the `N ×` label (13 px bold), which ends 20 px left of the frame. */
const REPEAT_CHAR = 7.8;
const LANE = 16;
const COLUMN_GAP = 26;
const SPLIT = 26;
const JOIN = 18;
const NOTE_GAP = 34;
const NOTE_WRAP = 30;
const NOTE_LINE = 15;
const INSET_PAD = 14;

const plainLength = (text: string): number => text.replace(/\*\*/g, '').length;

/**
 * Greedy word wrap at `width` characters (Markdown `**` markers not counted). A bold span the wrap
 * cuts in two is closed at the end of its first line and reopened on the next, so each line parses
 * on its own.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (plainLength(next) > width && line !== '') {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  let open = false;
  return lines.map(l => {
    const text = open ? `**${l}` : l;
    open = (text.match(/\*\*/g) ?? []).length % 2 === 1;
    return open ? `${text}**` : text;
  });
}

const blockWidth = (b: {label: string; sub?: string}): number =>
  Math.min(
    MAX_W,
    Math.max(MIN_W, Math.ceil(Math.max(b.label.length * LABEL_CHAR, (b.sub ?? '').length * SUB_CHAR)) + PAD_X * 2),
  );

/** A laid-out stack in local coordinates: column centre at x = 0, top at y = 0. */
interface Fragment {
  blocks: PlacedBlock[];
  ops: PlacedOp[];
  frames: PlacedFrame[];
  wires: Wire[];
  shapes: PlacedShape[];
  texts: PlacedText[];
  left: number;
  right: number;
  height: number;
  /** Where the incoming connection attaches (bottom centre). */
  inPort: Point;
  /** Where outgoing connections leave (one, or one per branch column). */
  outPorts: Point[];
  /** The incoming wire ends in an arrowhead here (false for a branch, whose own wires carry the arrows on). */
  arrowIn: boolean;
  /** The element the incoming arrow points at: a block or op id, for residual branch points. */
  bottomId?: string;
  /** For a block: the shape label for its outgoing arrow. */
  outShape?: string;
}

const shiftPoint = (p: Point, dx: number, dy: number): Point => ({x: p.x + dx, y: p.y + dy});

function shift(f: Fragment, dx: number, dy: number): Fragment {
  const box = (b: Box): Box => ({...b, x: b.x + dx, y: b.y + dy});
  return {
    ...f,
    blocks: f.blocks.map(b => ({...b, box: box(b.box)})),
    ops: f.ops.map(o => ({...o, c: shiftPoint(o.c, dx, dy)})),
    frames: f.frames.map(fr => ({...fr, box: box(fr.box)})),
    wires: f.wires.map(w => ({
      ...w,
      points: w.points.map(p => shiftPoint(p, dx, dy)),
      junction: w.junction === undefined ? undefined : shiftPoint(w.junction, dx, dy),
    })),
    shapes: f.shapes.map(s => ({...s, x: s.x + dx, y: s.y + dy})),
    texts: f.texts.map(t => ({...t, x: t.x + dx, y: t.y + dy})),
    left: f.left + dx,
    right: f.right + dx,
    inPort: shiftPoint(f.inPort, dx, dy),
    outPorts: f.outPorts.map(p => shiftPoint(p, dx, dy)),
  };
}

const emptyFragment = (): Fragment => ({
  blocks: [],
  ops: [],
  frames: [],
  wires: [],
  shapes: [],
  texts: [],
  left: 0,
  right: 0,
  height: 0,
  inPort: {x: 0, y: 0},
  outPorts: [{x: 0, y: 0}],
  arrowIn: true,
});

function blockFragment(b: ArchBlock): Fragment {
  const w = blockWidth(b);
  const h = b.sub === undefined ? BLOCK_H : BLOCK_H_SUB;
  const f = emptyFragment();
  f.blocks.push({
    id: b.id,
    label: b.label,
    sub: b.sub,
    kind: b.kind ?? 'layer',
    detail: b.detail,
    shape: b.shape,
    box: {x: -w / 2, y: 0, w, h},
    side: false,
  });
  f.left = -w / 2;
  f.right = w / 2;
  f.height = h;
  f.inPort = {x: 0, y: h};
  f.outPorts = [{x: 0, y: 0}];
  f.bottomId = b.id;
  f.outShape = b.shape;
  if (b.side !== undefined) {
    const sw = blockWidth(b.side);
    const sh = b.side.sub === undefined ? BLOCK_H : BLOCK_H_SUB;
    const sx = -w / 2 - SIDE_GAP - sw;
    const sy = (h - sh) / 2;
    f.blocks.push({
      id: `${b.id}:side`,
      label: b.side.label,
      sub: b.side.sub,
      kind: 'layer',
      detail: b.side.detail,
      box: {x: sx, y: sy, w: sw, h: sh},
      side: true,
      feeds: b.id,
    });
    f.wires.push({
      points: [
        {x: sx + sw, y: h / 2},
        {x: -w / 2, y: h / 2},
      ],
    });
    f.left = sx;
  }
  return f;
}

function opFragment(o: ArchOp): Fragment {
  const f = emptyFragment();
  f.ops.push({id: o.id, op: o.op, detail: o.detail, c: {x: 0, y: OP_R}, r: OP_R});
  f.left = -OP_R;
  f.right = OP_R;
  f.height = OP_R * 2;
  f.inPort = {x: 0, y: OP_R * 2};
  f.outPorts = [{x: 0, y: 0}];
  f.bottomId = o.id;
  return f;
}

/** Room a repeated frame needs on its left for the brace and its `N ×` label. */
const braceWidth = (repeat: string | undefined): number =>
  repeat === undefined ? 0 : Math.max(BRACE_W, 28 + repeat.length * REPEAT_CHAR);

function groupFragment(g: ArchGroup): Fragment {
  const inner = stackFragment(g.items);
  const top = FRAME_PAD_Y + (g.label === undefined ? 0 : FRAME_LABEL_H);
  const f = shift(inner, 0, top);
  const box: Box = {
    x: inner.left - FRAME_PAD_X,
    y: 0,
    w: inner.right - inner.left + FRAME_PAD_X * 2,
    h: inner.height + top + FRAME_PAD_Y,
  };
  const nested = g.repeat !== undefined;
  f.frames = [
    {box, tone: g.tone ?? 'block', label: g.label, repeat: g.repeat},
    ...f.frames.map(fr => (nested && fr.repeat !== undefined ? {...fr, nested: true} : fr)),
  ];
  f.left = box.x - braceWidth(g.repeat);
  f.right = box.x + box.w;
  f.height = box.h;
  return f;
}

function branchFragment(b: ArchBranch): Fragment {
  const columns = b.columns.map(c => stackFragment(c));
  const tallest = Math.max(...columns.map(c => c.height));
  const total = columns.reduce((s, c) => s + (c.right - c.left), 0) + COLUMN_GAP * (columns.length - 1);
  let x = -total / 2;
  const placed = columns.map(c => {
    // Bottom-aligned: every column starts at the same height above the split.
    const p = shift(c, x - c.left, tallest - c.height);
    x += c.right - c.left + COLUMN_GAP;
    return p;
  });
  const height = tallest + SPLIT;
  const f = emptyFragment();
  for (const p of placed) {
    f.blocks.push(...p.blocks);
    f.ops.push(...p.ops);
    f.frames.push(...p.frames);
    f.wires.push(...p.wires);
    f.shapes.push(...p.shapes);
    f.texts.push(...p.texts);
  }
  const splitY = height - SPLIT / 2;
  // The split: up from the shared input, across, then up into each column's first item.
  for (const p of placed) {
    f.wires.push({
      points: [{x: 0, y: height}, {x: 0, y: splitY}, {x: p.inPort.x, y: splitY}, p.inPort],
      open: !p.arrowIn,
      junction: {x: 0, y: splitY},
    });
  }
  f.left = -total / 2;
  f.right = total / 2;
  f.height = height;
  f.inPort = {x: 0, y: height};
  f.outPorts = placed.flatMap(p => p.outPorts);
  f.arrowIn = false;
  return f;
}

function itemFragment(item: ArchItem): Fragment {
  if (isBranch(item)) return branchFragment(item);
  if (isGroup(item)) return groupFragment(item);
  if (isOp(item)) return opFragment(item);
  return blockFragment(item);
}

/** Where a wire from below enters `upper` at horizontal offset `x` (spread across a box, gathered into a circle). */
function entry(upper: Fragment, x: number): Point {
  const block = upper.blocks.find(b => b.id === upper.bottomId && !b.side);
  if (block !== undefined) {
    const half = block.box.w / 2 - 12;
    return {x: Math.max(upper.inPort.x - half, Math.min(upper.inPort.x + half, x)), y: upper.inPort.y};
  }
  return upper.inPort;
}

/** Items bottom to top, laid out top to bottom with the connections between them and the residuals among them. */
function stackFragment(items: ArchItem[]): Fragment {
  const parts = items.map(itemFragment);
  const f = emptyFragment();
  // Lay out from the top (the last item) down.
  let y = 0;
  const placed: Fragment[] = new Array<Fragment>(parts.length);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = shift(parts[i], 0, y);
    placed[i] = p;
    const next = parts[i - 1];
    // A branch below needs room for its outputs to come together.
    const gap = next !== undefined && next.outPorts.length > 1 ? GAP + JOIN : GAP;
    y += parts[i].height + gap;
  }
  for (const p of placed) {
    f.blocks.push(...p.blocks);
    f.ops.push(...p.ops);
    f.frames.push(...p.frames);
    f.wires.push(...p.wires);
    f.shapes.push(...p.shapes);
    f.texts.push(...p.texts);
  }
  // Connections: from each item to the one above it.
  for (let i = 0; i < placed.length - 1; i++) {
    const lower = placed[i];
    const upper = placed[i + 1];
    if (lower.outPorts.length === 1) {
      f.wires.push({points: [lower.outPorts[0], upper.inPort], open: !upper.arrowIn});
    } else {
      // Above every column's top, so a short column's wire rises in its own lane before turning in.
      const top = Math.min(...lower.outPorts.map(p => p.y));
      const joinY = upper.inPort.y + (top - upper.inPort.y) * 0.45;
      const spread = (upper.right - upper.left) / Math.max(2, lower.outPorts.length + 1);
      lower.outPorts.forEach((p, k) => {
        const target = entry(upper, upper.inPort.x + (k - (lower.outPorts.length - 1) / 2) * spread);
        f.wires.push({
          points: [p, {x: p.x, y: joinY}, {x: target.x, y: joinY}, target],
          open: !upper.arrowIn,
        });
      });
    }
    if (lower.outShape !== undefined)
      f.shapes.push({
        text: lower.outShape,
        x: lower.outPorts[0].x + 6,
        y: (lower.outPorts[0].y + upper.inPort.y) / 2 + 3,
      });
  }
  // Residuals: each op with `from` takes the input of that block (the middle of the arrow entering it) around to its right side.
  const lastExtent = (from: number, to: number): number => Math.max(...placed.slice(from, to + 1).map(p => p.right));
  let right = Math.max(...placed.map(p => p.right));
  items.forEach((item, k) => {
    if (!isOp(item) || item.from === undefined) return;
    const j = items.findIndex(it => isBlock(it) && it.id === item.from);
    if (j < 0 || j >= k) return;
    const src = placed[j];
    const op = placed[k].ops.find(o => o.id === item.id);
    if (op === undefined) return;
    const branchY = src.inPort.y + GAP / 2;
    const laneX = lastExtent(j, k) + LANE;
    right = Math.max(right, laneX + 2);
    f.wires.push({
      points: [
        {x: src.inPort.x, y: branchY},
        {x: laneX, y: branchY},
        {x: laneX, y: op.c.y},
        {x: op.c.x + op.r, y: op.c.y},
      ],
      junction: {x: src.inPort.x, y: branchY},
    });
  });
  f.left = Math.min(...placed.map(p => p.left));
  f.right = right;
  f.height = y - GAP;
  f.inPort = placed[0].inPort;
  f.outPorts = placed[placed.length - 1].outPorts;
  f.arrowIn = placed[0].arrowIn;
  f.bottomId = placed[0].bottomId;
  f.outShape = placed[placed.length - 1].outShape;
  return f;
}

interface Obstacle {
  top: number;
  bottom: number;
}

/** Note texts in one column, pushed apart so none overlaps another or an inset. */
function placeColumn(wanted: {y: number; lines: string[]}[], obstacles: Obstacle[]): number[] {
  const order = wanted.map((w, i) => ({...w, i})).sort((a, b) => a.y - b.y);
  const out = new Array<number>(wanted.length);
  let floor = -Infinity;
  for (const w of order) {
    const h = w.lines.length * NOTE_LINE;
    let top = Math.max(w.y - h / 2, floor);
    for (const o of obstacles) if (top < o.bottom + 8 && top + h > o.top - 8) top = o.bottom + 10;
    out[w.i] = top + h / 2;
    floor = top + h + 10;
  }
  return out;
}

/** The whole figure; `compact` leaves out the callouts and insets (the problem pane's narrow column). */
export function layoutArchitecture(arch: Architecture, compact = false): ArchLayout {
  // Output above the last item (a branch on top first gathers its columns), input below the first.
  const stack = stackFragment(arch.items);
  const fanIn = arch.output !== undefined && stack.outPorts.length > 1 ? JOIN : 0;
  const top = arch.output === undefined ? 0 : GAP + 18 + fanIn;
  const root = shift(stack, 0, top);
  const texts: PlacedText[] = [...root.texts];
  const wires: Wire[] = [...root.wires];
  if (arch.output !== undefined) {
    // From the last item's top (inside its frame when it is a group) to above the whole stack.
    const outs = root.outPorts;
    const cx = (Math.min(...outs.map(p => p.x)) + Math.max(...outs.map(p => p.x))) / 2;
    const end = {x: cx, y: top - fanIn - GAP};
    if (outs.length === 1) wires.push({points: [outs[0], end]});
    else {
      const joinY = top - fanIn / 2;
      for (const p of outs) wires.push({points: [p, {x: p.x, y: joinY}, {x: cx, y: joinY}], open: true});
      wires.push({points: [{x: cx, y: joinY}, end], junction: {x: cx, y: joinY}});
    }
    texts.push({lines: [arch.output], x: cx, y: end.y - 8, anchor: 'middle'});
  }
  let bottom = root.height + top;
  if (arch.input !== undefined) {
    wires.push({points: [{x: root.inPort.x, y: bottom + GAP}, root.inPort], open: !root.arrowIn});
    texts.push({lines: [arch.input], x: root.inPort.x, y: bottom + GAP + 16, anchor: 'middle'});
    bottom += GAP + 24;
  }
  const blocks = [...root.blocks];
  const ops = [...root.ops];
  const frames = [...root.frames];
  const shapes = [...root.shapes];
  const leaders: Point[][] = [];
  const notes: PlacedNote[] = [];
  let left = root.left;
  let right = root.right;
  let minY = 0;
  let maxY = bottom;
  const findBox = (id: string): Box | null => {
    const b = blocks.find(x => x.id === id && !x.side);
    if (b !== undefined) return b.box;
    const o = ops.find(x => x.id === id);
    return o === undefined ? null : {x: o.c.x - o.r, y: o.c.y - o.r, w: o.r * 2, h: o.r * 2};
  };
  if (!compact) {
    const columnRight = right + NOTE_GAP;
    const obstacles: Obstacle[] = [];
    for (const inset of arch.insets ?? []) {
      const target = findBox(inset.for);
      if (target === null) continue;
      const inner = stackFragment(inset.items);
      const titleH = inset.title === undefined ? 0 : FRAME_LABEL_H;
      const w = inner.right - inner.left + INSET_PAD * 2;
      const h = inner.height + INSET_PAD * 2 + titleH;
      const x = columnRight;
      const centre = target.y + target.h / 2;
      let y = Math.max(minY, centre - h / 2);
      for (const o of obstacles) if (y < o.bottom + 12 && y + h > o.top - 12) y = o.bottom + 16;
      const placed = shift(inner, x + INSET_PAD - inner.left, y + INSET_PAD + titleH);
      frames.push({box: {x, y, w, h}, tone: 'dotted', label: inset.title});
      blocks.push(...placed.blocks);
      ops.push(...placed.ops);
      frames.push(...placed.frames);
      wires.push(...placed.wires);
      shapes.push(...placed.shapes);
      texts.push(...placed.texts);
      leaders.push([
        {x: target.x + target.w + 4, y: centre},
        {x, y: Math.max(y + 10, Math.min(y + h - 10, centre))},
      ]);
      let blockBottom = y + h;
      if (inset.note !== undefined) {
        const lines = wrapText(inset.note, NOTE_WRAP);
        const ny = y + h + 26;
        leaders.push([
          {x: x + w / 2, y: y + h + 2},
          {x: x + w / 2, y: ny - 12},
        ]);
        texts.push({lines, x: x + w / 2, y: ny, anchor: 'middle'});
        blockBottom = ny + lines.length * NOTE_LINE;
        right = Math.max(right, x + w / 2 + (Math.max(...lines.map(plainLength)) * NOTE_CHAR) / 2);
      }
      obstacles.push({top: y, bottom: blockBottom});
      right = Math.max(right, x + w);
      maxY = Math.max(maxY, blockBottom);
    }
    for (const side of ['right', 'left'] as const) {
      const mine = (arch.notes ?? []).filter(n => (n.side ?? 'right') === side);
      const targets = mine.map(n => findBox(n.at));
      const wanted = mine.map((n, i) => {
        const t = targets[i];
        return {y: t === null ? 0 : t.y + t.h / 2, lines: wrapText(n.text, NOTE_WRAP)};
      });
      const ys = placeColumn(wanted, side === 'right' ? obstacles : []);
      mine.forEach((n, i) => {
        const t = targets[i];
        if (t === null) return;
        const lines = wanted[i].lines;
        const textW = Math.max(...lines.map(plainLength)) * NOTE_CHAR;
        const cy = ys[i];
        const textTop = cy - (lines.length * NOTE_LINE) / 2 + NOTE_FONT;
        if (side === 'right') {
          const x = root.right + NOTE_GAP;
          notes.push({
            at: n.at,
            text: {lines, x, y: textTop, anchor: 'start'},
            leader: [
              {x: t.x + t.w + 4, y: t.y + t.h / 2},
              {x: x - 6, y: cy},
            ],
          });
          right = Math.max(right, x + textW);
        } else {
          const x = root.left - NOTE_GAP;
          notes.push({
            at: n.at,
            text: {lines, x, y: textTop, anchor: 'end'},
            leader: [
              {x: t.x - 4, y: t.y + t.h / 2},
              {x: x + 6, y: cy},
            ],
          });
          left = Math.min(left, x - textW);
        }
        minY = Math.min(minY, cy - (lines.length * NOTE_LINE) / 2);
        maxY = Math.max(maxY, cy + (lines.length * NOTE_LINE) / 2);
      });
    }
  }
  for (const t of texts) {
    const w = Math.max(...t.lines.map(plainLength)) * NOTE_CHAR;
    if (t.anchor === 'middle') {
      left = Math.min(left, t.x - w / 2);
      right = Math.max(right, t.x + w / 2);
    }
  }
  for (const fr of frames) if (fr.repeat !== undefined) left = Math.min(left, fr.box.x - braceWidth(fr.repeat));
  const pad = 10;
  return {
    minX: left - pad,
    minY: minY - pad,
    width: right - left + pad * 2,
    height: maxY - minY + pad * 2,
    blocks,
    ops,
    frames,
    wires,
    shapes,
    notes,
    leaders,
    texts,
  };
}

// ---- Mermaid --------------------------------------------------------------------------------------

const mermaidText = (s: string): string => s.replace(/\*\*/g, '').replace(/"/g, '#quot;');

/** The figure as a Mermaid flowchart read bottom to top: frames as subgraphs, residuals dotted. */
export function architectureToMermaid(arch: Architecture): string {
  const lines = ['flowchart BT'];
  let n = 0;
  const node = (id: string): string => `a_${id.replace(/[^\w]/g, '_')}`;
  /** For each block, the node(s) feeding it: where a residual around that block leaves the main path. */
  const feeders = new Map<string, string[]>();
  /**
   * Lays out items, returns the ids of the entry node(s) and the exit node(s). `before` is what
   * flows into the first item (the parent's previous exits), recorded for residuals only: the
   * parent draws those edges itself.
   */
  const walk = (items: ArchItem[], indent: string, before: string[]): {first: string[]; last: string[]} => {
    let prev: string[] = [];
    let feed = before;
    let first: string[] = [];
    for (const item of items) {
      let entries: string[];
      let exits: string[];
      if (isBranch(item)) {
        const cols = item.columns.map(c => walk(c, indent, feed));
        entries = cols.flatMap(c => c.first);
        exits = cols.flatMap(c => c.last);
      } else if (isGroup(item)) {
        n += 1;
        const title = [item.repeat, item.label].filter(Boolean).join(' ') || ' ';
        lines.push(`${indent}subgraph g${n}["${mermaidText(title)}"]`);
        const inner = walk(item.items, `${indent}  `, feed);
        lines.push(`${indent}end`);
        entries = inner.first;
        exits = inner.last;
      } else if (isOp(item)) {
        lines.push(`${indent}${node(item.id)}(("${item.op === '+' ? '+' : '×'}"))`);
        entries = [node(item.id)];
        exits = entries;
      } else {
        const label = item.sub === undefined ? item.label : `${item.label}<br/>${item.sub}`;
        lines.push(`${indent}${node(item.id)}["${mermaidText(label)}"]`);
        if (item.side !== undefined) {
          lines.push(`${indent}${node(item.id)}_side["${mermaidText(item.side.label)}"]`);
          lines.push(`${indent}${node(item.id)}_side --> ${node(item.id)}`);
        }
        feeders.set(item.id, feed);
        entries = [node(item.id)];
        exits = entries;
      }
      for (const p of prev) for (const e of entries) lines.push(`${indent}${p} --> ${e}`);
      if (first.length === 0) first = entries;
      prev = exits;
      feed = exits;
    }
    return {first, last: prev};
  };
  const main = walk(arch.items, '  ', arch.input !== undefined ? ['a_input'] : []);
  if (arch.input !== undefined) {
    lines.push(`  a_input(["${mermaidText(arch.input)}"])`);
    for (const e of main.first) lines.push(`  a_input --> ${e}`);
  }
  if (arch.output !== undefined) {
    lines.push(`  a_output(["${mermaidText(arch.output)}"])`);
    for (const e of main.last) lines.push(`  ${e} --> a_output`);
  }
  // Residuals: from whatever feeds the `from` block (its input, before any norm), dotted, into the op.
  const residuals = (items: ArchItem[]): void => {
    items.forEach(item => {
      if (isBranch(item)) item.columns.forEach(residuals);
      else if (isGroup(item)) residuals(item.items);
      else if (isOp(item) && item.from !== undefined) {
        const sources = feeders.get(item.from) ?? [];
        for (const s of sources.length > 0 ? sources : [node(item.from)]) lines.push(`  ${s} -.-> ${node(item.id)}`);
      }
    });
  };
  residuals(arch.items);
  for (const inset of arch.insets ?? []) {
    n += 1;
    lines.push(`  subgraph g${n}["${mermaidText(inset.title ?? `inside ${inset.for}`)}"]`);
    const inner = walk(inset.items, '    ', []);
    lines.push('  end');
    for (const e of inner.first) lines.push(`  ${node(inset.for)} -.- ${e}`);
    residuals(inset.items);
  }
  return lines.join('\n');
}
