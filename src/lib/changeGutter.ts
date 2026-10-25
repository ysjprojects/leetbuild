/**
 * Change markers right of the line numbers, as VS Code draws them against the last commit: what the
 * open file changed from its baseline (the starter, what `reset` restores). A green bar marks added
 * lines, a blue one changed lines, and a red triangle the place lines were removed from, on the
 * boundary they left. The line diff is @codemirror/merge's, updated incrementally as the file is
 * edited.
 */
import {Chunk} from '@codemirror/merge';
import {type Extension, type Range, RangeSet, StateField, Text} from '@codemirror/state';
import {gutter, GutterMarker} from '@codemirror/view';

/** Bounds the diff of large, very different texts (a paste over the whole file): coarser, but quick. */
const DIFF = {scanLimit: 500};

class ChangeMarker extends GutterMarker {
  constructor(className: string) {
    super();
    this.elementClass = className;
  }

  eq(other: GutterMarker): boolean {
    return other.elementClass === this.elementClass;
  }
}

const ADDED = new ChangeMarker('lb-change-added');
const CHANGED = new ChangeMarker('lb-change-changed');
/** Lines were removed above this one: the triangle sits on its top edge. */
const REMOVED = new ChangeMarker('lb-change-removed');
/** Lines were removed from the end of the file: the triangle sits on the last line's bottom edge. */
const REMOVED_END = new ChangeMarker('lb-change-removed-end');

interface Changes {
  base: Text;
  chunks: readonly Chunk[];
  marks: RangeSet<GutterMarker>;
}

/** Marks lines `first`…`last` of `doc` with `marker`. */
const markLines = (
  marks: Range<GutterMarker>[],
  doc: Text,
  marker: GutterMarker,
  first: number,
  last: number,
): void => {
  for (let line = first; line <= last; line += 1) marks.push(marker.range(doc.line(line).from));
};

/**
 * A chunk spans whole lines: from the start of its first changed line to one past the end of its
 * last (`toB` may be past the end of the document), or nothing on one side.
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
    if (chunk.fromA === chunk.toA) {
      markLines(marks, doc, ADDED, first, last);
      continue;
    }
    // At the end of the file the last line's terminator is a character like any other: lines
    // removed after it, or added after a last line without one, put that line in the chunk too.
    // VS Code compares lines, not their terminators, and so does this: that line keeps no marker.
    if (chunk.toB >= doc.length) {
      const before = base.sliceString(chunk.fromA, chunk.endA);
      const after = doc.sliceString(chunk.fromB, chunk.endB);
      if (before.startsWith(`${after}\n`)) {
        marks.push(REMOVED_END.range(doc.line(last).from));
        continue;
      }
      if (after.startsWith(`${before}\n`)) {
        markLines(marks, doc, ADDED, doc.lineAt(chunk.fromB + before.length + 1).number, last);
        continue;
      }
    }
    markLines(marks, doc, CHANGED, first, last);
  }
  return RangeSet.of(marks);
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
