/**
 * Change markers right of the line numbers, as VS Code draws them against the last commit: what the
 * open file changed from its baseline (the starter, what `reset` restores). A green bar marks added
 * lines, a blue one changed lines, and a red triangle the place lines were removed from, on the
 * boundary they left. The line diff is @codemirror/merge's, updated incrementally as the file is
 * edited; within a region of changes each line is matched to the one it came from, so lines removed
 * beside an edited line keep their triangle.
 */
import {Chunk} from '@codemirror/merge';
import {type Extension, type Range, RangeSet, StateField, Text} from '@codemirror/state';
import {gutter, GutterMarker} from '@codemirror/view';

/** Bounds the diff of large, very different texts (a paste over the whole file): coarser, but quick. */
const DIFF = {scanLimit: 500};

/** A region with more line pairs than this (a paste over the whole file) is not matched line by line. */
const ALIGN_LIMIT = 10_000;

/** One marker. A line can hold a bar and a triangle or two, so each is an element of its own. */
class ChangeMarker extends GutterMarker {
  constructor(private readonly kind: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }

  toDOM(): Node {
    const mark = document.createElement('span');
    mark.className = `lb-change-${this.kind}`;
    return mark;
  }
}

const ADDED = new ChangeMarker('added');
const CHANGED = new ChangeMarker('changed');
/** Lines were removed above this one: the triangle sits on its top edge. */
const REMOVED = new ChangeMarker('removed');
/** Lines were removed below this one, the file's last: the triangle sits on its bottom edge. */
const REMOVED_END = new ChangeMarker('removed-end');

interface Changes {
  base: Text;
  chunks: readonly Chunk[];
  marks: RangeSet<GutterMarker>;
}

type Op = 'equal' | 'changed' | 'added' | 'removed';

/** How alike two lines are, from 0 to 1: the prefix and suffix they share, indentation aside, over the longer. */
const similarity = (a: string, b: string): number => {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return 1;
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < x.length - prefix &&
    suffix < y.length - prefix &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / Math.max(x.length, y.length);
};

/**
 * The cheapest edit from lines `a` to lines `b`, in order. Removing or adding a line costs 1 and
 * keeping one in place what tells the two apart (nothing when they are equal), so an edited line is
 * matched to the line it came from. Between equally cheap edits, the earliest lines are matched.
 */
const align = (a: readonly string[], b: readonly string[]): Op[] => {
  const width = b.length + 1;
  const cost = new Float64Array((a.length + 1) * width);
  const replace = (i: number, j: number): number => (a[i] === b[j] ? 0 : 1 - similarity(a[i], b[j]));
  for (let i = 0; i <= a.length; i += 1) {
    for (let j = 0; j <= b.length; j += 1) {
      cost[i * width + j] =
        i === 0 || j === 0
          ? i + j
          : Math.min(
              cost[(i - 1) * width + j - 1] + replace(i - 1, j - 1),
              cost[(i - 1) * width + j] + 1,
              cost[i * width + j - 1] + 1,
            );
    }
  }
  // Walked back from the end, so taking a removal or an addition first leaves the matches early.
  const ops: Op[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const here = cost[i * width + j];
    if (i > 0 && here === cost[(i - 1) * width + j] + 1) {
      ops.push('removed');
      i -= 1;
    } else if (j > 0 && here === cost[i * width + j - 1] + 1) {
      ops.push('added');
      j -= 1;
    } else {
      ops.push(a[i - 1] === b[j - 1] ? 'equal' : 'changed');
      i -= 1;
      j -= 1;
    }
  }
  return ops.reverse();
};

/** The text of lines `first`…`last`. */
const lineTexts = (text: Text, first: number, last: number): string[] => {
  const out: string[] = [];
  for (let line = first; line <= last; line += 1) out.push(text.line(line).text);
  return out;
};

/**
 * A chunk spans whole lines: from the start of its first changed line to one past the end of its
 * last (`to` may be past the end of the document), or nothing on one side. Lines removed are marked
 * on the boundary they left: the top of the line after them, or the bottom of the file's last.
 */
const marksFor = (base: Text, doc: Text, chunks: readonly Chunk[]): RangeSet<GutterMarker> => {
  const marks: Range<GutterMarker>[] = [];
  for (const chunk of chunks) {
    if (chunk.fromB === chunk.toB) {
      marks.push(
        chunk.fromB > doc.length
          ? REMOVED_END.range(doc.line(doc.lines).from)
          : REMOVED.range(doc.lineAt(chunk.fromB).from),
      );
      continue;
    }
    const first = doc.lineAt(chunk.fromB).number;
    const last = doc.lineAt(Math.min(chunk.toB - 1, doc.length)).number;
    const before =
      chunk.fromA === chunk.toA
        ? []
        : lineTexts(base, base.lineAt(chunk.fromA).number, base.lineAt(Math.min(chunk.toA - 1, base.length)).number);
    const after = lineTexts(doc, first, last);
    if (before.length * after.length > ALIGN_LIMIT) {
      for (let line = first; line <= last; line += 1) marks.push(CHANGED.range(doc.line(line).from));
      continue;
    }
    let line = first;
    let removed = false;
    for (const op of align(before, after)) {
      if (op === 'removed') {
        removed = true;
        continue;
      }
      if (removed) marks.push(REMOVED.range(doc.line(line).from));
      removed = false;
      if (op !== 'equal') marks.push((op === 'added' ? ADDED : CHANGED).range(doc.line(line).from));
      line += 1;
    }
    if (removed) {
      marks.push(line <= doc.lines ? REMOVED.range(doc.line(line).from) : REMOVED_END.range(doc.line(doc.lines).from));
    }
  }
  return RangeSet.of(marks, true);
};

const changes = StateField.define<Changes | null>({
  create: () => null,
  update(value, tr) {
    if (value === null || !tr.docChanged) return value;
    const chunks = Chunk.updateB(value.chunks, value.base, tr.newDoc, tr.changes, DIFF);
    return {base: value.base, chunks, marks: marksFor(value.base, tr.newDoc, chunks)};
  },
});

/** The change gutter of a file whose changes are shown against `baseline`. */
export function changeGutter(baseline: string): Extension {
  // Split the way the editor splits its own document.
  const base = Text.of(baseline.split(/\r\n?|\n/));
  return [
    changes.init(state => {
      const chunks = Chunk.build(base, state.doc, DIFF);
      return {base, chunks, marks: marksFor(base, state.doc, chunks)};
    }),
    gutter({class: 'lb-change-gutter', markers: view => view.state.field(changes)?.marks ?? RangeSet.empty}),
  ];
}
