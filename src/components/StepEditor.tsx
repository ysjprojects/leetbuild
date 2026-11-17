import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import {indentUnit} from '@codemirror/language';
import {unifiedMergeView} from '@codemirror/merge';
import {type Extension, Compartment, EditorState, Prec, RangeSet, StateEffect, StateField} from '@codemirror/state';
import {type DecorationSet, Decoration, EditorView, keymap} from '@codemirror/view';
import {type MutableRefObject, memo, useEffect, useRef, useState} from 'react';

import {
  type Syntax,
  editorExtensions,
  editorLanguage,
  INDENT,
  settingsExtensions,
  viewerExtensions,
} from '@/lib/editor';
import {useEditorSettings} from '@/lib/editorSettings';
import {LANGUAGE_LABEL} from '@/lib/types';

interface Props {
  value: string;
  language: Syntax;
  /** Editable editors emit `onChange`; viewers replace their document whenever `value` changes. */
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  /** Cmd/Ctrl+': run the example check without recording anything. */
  onRun?: () => void;
  /** Baseline text for a unified diff against `value` (viewers only): the learner's code under the solution. */
  original?: string | null;
  /**
   * What the gutter marks the file's changes against (editors only), as VS Code marks them against
   * the last commit: the file's starter. Fixed for the file once its editor state exists.
   */
  baseline?: string | null;
  /**
   * Identity of the file being edited (editors only). When it changes the view swaps to that
   * file's own editor state — undo history and selection stay per file, and Cmd+Z never pulls
   * another file's text into this one.
   */
  fileKey?: string;
  /** Editors replace the open file's document with `value` in place when this changes (reset, load solution); undo brings the edits back. */
  resetKey?: number;
  /**
   * The line (1-based) the code never got past: a compile, syntax or import error the last Run or
   * Submit reported in this file (editors only). Underlined until the next run clears it; edits move it.
   */
  error?: {line: number; message: string} | null;
  viewRef?: MutableRefObject<EditorView | null>;
  className?: string;
  /** The editor's accessible name, usually the open file's name; defaults to "<Language> code". */
  label?: string;
}

const languageExtensions = (language: Syntax): Extension => [
  editorLanguage(language),
  EditorState.tabSize.of(INDENT[language].tabSize),
  indentUnit.of(INDENT[language].unit),
];

const labelExtension = (label: string | undefined, language: Syntax): Extension =>
  EditorView.contentAttributes.of({
    'aria-label': label ?? `${language === 'proto' ? 'Protocol Buffers' : LANGUAGE_LABEL[language]} code`,
  });

/** Mark (or clear, with null) the line a compile error points at. */
const setError = StateEffect.define<{line: number; message: string} | null>();

/**
 * The reported line's text underlined as the lint package would (`.cm-lintRange-error`), the message
 * in its tooltip; the mark follows edits until the next run replaces it.
 */
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, tr) => {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setError)) continue;
      next = Decoration.none;
      const error = effect.value;
      if (error === null || error.line < 1 || error.line > tr.state.doc.lines) continue;
      const line = tr.state.doc.line(error.line);
      const from = line.from + (line.text.length - line.text.trimStart().length);
      const tint = Decoration.line({class: 'bg-danger-400/10', attributes: {title: error.message}}).range(line.from);
      // The line tinted (a blank one too), its text underlined as a lint error.
      next =
        from < line.to
          ? RangeSet.of([tint, Decoration.mark({class: 'cm-lintRange cm-lintRange-error'}).range(from, line.to)])
          : RangeSet.of(tint);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

/** A file's editor state and where it was scrolled, both ways, kept while other files are open. */
interface CachedFile {
  state: EditorState;
  /** `EditorView.scrollSnapshot()`: its target type is not exported, and only the view reads it back. */
  scroll: StateEffect<unknown>;
}

/** Files whose editor state (undo history, selection, scroll) is kept while other files are open: a whole course in every language. */
const STATE_CACHE = 32;

const StepEditor = memo(
  ({
    value,
    language,
    readOnly = false,
    onChange,
    onSubmit,
    onRun,
    original = null,
    baseline = null,
    fileKey,
    resetKey,
    viewRef,
    className,
    label,
    error = null,
  }: Props) => {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);
    const onRunRef = useRef(onRun);
    const languageCompartment = useRef(new Compartment());
    const diffCompartment = useRef(new Compartment());
    const settingsCompartment = useRef(new Compartment());
    const labelCompartment = useRef(new Compartment());
    const settings = useEditorSettings();
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const labelRef = useRef(label);
    labelRef.current = label;
    /** Editor state and scroll of every file opened on this view, by `fileKey`; restored when the file is reopened. */
    const states = useRef(new Map<string, CachedFile>());
    /**
     * Focus arrived from the keyboard (not a click in the editor): the hint says how to leave again,
     * since Tab indents inside the editor.
     */
    const [keyboardFocus, setKeyboardFocus] = useState(false);
    const pointerDown = useRef(false);
    const lastFileKey = useRef(fileKey);
    const lastResetKey = useRef(resetKey);
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onRunRef.current = onRun;

    const buildState = (doc: string, diffOriginal: string | null): EditorState => {
      const extensions: Extension[] = [
        // First, so Vim's bindings see keys before the editing keymaps.
        settingsCompartment.current.of(settingsExtensions(settings, readOnly)),
        readOnly ? viewerExtensions() : [editorExtensions(baseline), errorField],
        // Typing comfort the read-only viewers do not need: paired brackets and completion of words
        // already in the file (the starter's identifiers are what the learner types most).
        readOnly ? [] : [closeBrackets(), autocompletion({override: [completeAnyWord]})],
        languageCompartment.current.of(languageExtensions(language)),
        labelCompartment.current.of(labelExtension(label, language)),
        diffCompartment.current.of(
          diffOriginal === null
            ? []
            : unifiedMergeView({
                original: diffOriginal,
                mergeControls: false,
                highlightChanges: true,
                gutter: true,
                syntaxHighlightDeletions: true,
                collapseUnchanged: {margin: 3, minSize: 6},
              }),
        ),
        // Above every other keymap: the default one binds Mod-Enter to insertBlankLine. Handled here, the
        // event is marked (defaultPrevented) so page-level shortcuts skip it; without a handler it passes on.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                const handler = onSubmitRef.current;
                handler?.();
                return handler !== undefined;
              },
            },
            {
              key: "Mod-'",
              run: () => {
                const handler = onRunRef.current;
                handler?.();
                return handler !== undefined;
              },
            },
          ]),
        ),
        keymap.of(readOnly ? [] : [...closeBracketsKeymap, ...completionKeymap]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !readOnly) onChangeRef.current?.(update.state.doc.toString());
        }),
      ];
      return EditorState.create({doc, extensions});
    };
    const buildStateRef = useRef(buildState);
    buildStateRef.current = buildState;

    // Create the view once per mount.
    useEffect(() => {
      const parent = host.current;
      if (parent === null) return undefined;
      const v = new EditorView({state: buildStateRef.current(value, original), parent});
      view.current = v;
      if (viewRef) viewRef.current = v;
      return () => {
        v.destroy();
        view.current = null;
        if (viewRef) viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Grammar and indentation follow `language`; document swaps and replacements are driven by `fileKey`/`resetKey` below.
    useEffect(() => {
      const v = view.current;
      if (v === null) return;
      v.dispatch({effects: languageCompartment.current.reconfigure(languageExtensions(language))});
    }, [language]);

    // The accessible name follows the open file.
    useEffect(() => {
      const v = view.current;
      if (v === null) return;
      v.dispatch({effects: labelCompartment.current.reconfigure(labelExtension(label, language))});
    }, [label, language]);

    // Font size, wrapping and key bindings follow the shared settings.
    useEffect(() => {
      const v = view.current;
      if (v === null) return;
      v.dispatch({effects: settingsCompartment.current.reconfigure(settingsExtensions(settings, readOnly))});
    }, [settings, readOnly]);

    // Viewers follow `value`/`original`; editors swap states on `fileKey` and replace in place on `resetKey`.
    useEffect(() => {
      const v = view.current;
      if (v === null) return;
      if (readOnly) {
        if (original !== null) {
          v.setState(buildStateRef.current(value, original));
        } else if (v.state.doc.toString() !== value) {
          v.setState(buildStateRef.current(value, null));
        }
        return;
      }
      if (lastFileKey.current !== fileKey) {
        const cache = states.current;
        // The reopened file's state leaves the cache (it lives in the view now); the outgoing file's
        // state joins at the end, so the map stays in least-recently-open order for eviction.
        const cached = fileKey === undefined ? undefined : cache.get(fileKey);
        if (fileKey !== undefined) cache.delete(fileKey);
        if (lastFileKey.current !== undefined) {
          cache.set(lastFileKey.current, {state: v.state, scroll: v.scrollSnapshot()});
          if (cache.size > STATE_CACHE) {
            const [oldest] = cache.keys();
            cache.delete(oldest);
          }
        }
        lastFileKey.current = fileKey;
        lastResetKey.current = resetKey;
        // A cached state is only reused when the file was not rewritten meanwhile (reset, load solution).
        v.setState(
          cached !== undefined && cached.state.doc.toString() === value
            ? cached.state
            : buildStateRef.current(value, null),
        );
        // The scroller is the view's, not the state's: each file comes back where it was left, both
        // ways, and a file opened for the first time starts at its top-left corner.
        v.scrollDOM.scrollTop = 0;
        v.scrollDOM.scrollLeft = 0;
        v.dispatch({
          effects: [
            languageCompartment.current.reconfigure(languageExtensions(language)),
            labelCompartment.current.reconfigure(labelExtension(labelRef.current, language)),
            settingsCompartment.current.reconfigure(settingsExtensions(settingsRef.current, readOnly)),
          ],
        });
        if (cached !== undefined) v.dispatch({effects: cached.scroll});
        return;
      }
      if (lastResetKey.current === resetKey) return;
      lastResetKey.current = resetKey;
      if (v.state.doc.toString() !== value) {
        v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: value}});
      }
    }, [value, original, readOnly, fileKey, resetKey, language]);

    // The compile error's line, in whichever file is open: set after a file swap, cleared with null.
    useEffect(() => {
      const v = view.current;
      if (v === null || readOnly) return;
      v.dispatch({
        effects:
          error === null || error.line > v.state.doc.lines
            ? setError.of(null)
            : [
                setError.of(error),
                EditorView.scrollIntoView(v.state.doc.line(error.line).from, {y: 'nearest', x: 'nearest'}),
              ],
      });
    }, [error, fileKey, readOnly]);

    if (readOnly) return <div className={className} ref={host} />;
    return (
      <div
        className={`relative flex flex-col ${className ?? ''}`}
        onBlur={() => setKeyboardFocus(false)}
        onFocus={() => {
          setKeyboardFocus(!pointerDown.current);
          pointerDown.current = false;
        }}
        onPointerDown={() => {
          pointerDown.current = true;
        }}>
        <div className="min-h-0 min-w-0 flex-1" ref={host} />
        {keyboardFocus ? (
          <p
            aria-hidden
            className="border-ink-600 bg-ink-850/90 text-ink-300 pointer-events-none absolute bottom-2 right-3 z-10 rounded-md border px-2 py-0.5 text-[10px]">
            <kbd className="font-code text-ink-100">Esc</kbd> then <kbd className="font-code text-ink-100">Tab</kbd> to
            leave the editor
          </p>
        ) : null}
      </div>
    );
  },
);
StepEditor.displayName = 'StepEditor';

export default StepEditor;
