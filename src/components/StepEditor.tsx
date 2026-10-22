import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import {indentUnit} from '@codemirror/language';
import {unifiedMergeView} from '@codemirror/merge';
import {type Extension, Compartment, EditorState} from '@codemirror/state';
import {EditorView, keymap} from '@codemirror/view';
import {type MutableRefObject, memo, useEffect, useRef} from 'react';

import {
  type Syntax,
  editorExtensions,
  editorLanguage,
  INDENT,
  settingsExtensions,
  viewerExtensions,
} from '@/lib/editor';
import {useEditorSettings} from '@/lib/editorSettings';

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
   * Identity of the file being edited (editors only). When it changes the view swaps to that
   * file's own editor state — undo history and selection stay per file, and Cmd+Z never pulls
   * another file's text into this one.
   */
  fileKey?: string;
  /** Editors replace the open file's document with `value` in place when this changes (reset, load solution); undo brings the edits back. */
  resetKey?: number;
  viewRef?: MutableRefObject<EditorView | null>;
  className?: string;
}

const languageExtensions = (language: Syntax): Extension => [
  editorLanguage(language),
  EditorState.tabSize.of(INDENT[language].tabSize),
  indentUnit.of(INDENT[language].unit),
];

/** Files whose editor state (undo history, selection) is kept while other files are open: a whole course in every language. */
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
    fileKey,
    resetKey,
    viewRef,
    className,
  }: Props) => {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);
    const onRunRef = useRef(onRun);
    const languageCompartment = useRef(new Compartment());
    const diffCompartment = useRef(new Compartment());
    const settingsCompartment = useRef(new Compartment());
    const settings = useEditorSettings();
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    /** Editor state of every file opened on this view, by `fileKey`; restored when the file is reopened. */
    const states = useRef(new Map<string, EditorState>());
    const lastFileKey = useRef(fileKey);
    const lastResetKey = useRef(resetKey);
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onRunRef.current = onRun;

    const buildState = (doc: string, baseline: string | null): EditorState => {
      const extensions: Extension[] = [
        // First, so Vim's bindings see keys before the editing keymaps.
        settingsCompartment.current.of(settingsExtensions(settings, readOnly)),
        readOnly ? viewerExtensions() : editorExtensions(),
        // Typing comfort the read-only viewers do not need: paired brackets and completion of words
        // already in the file (the starter's identifiers are what the learner types most).
        readOnly ? [] : [closeBrackets(), autocompletion({override: [completeAnyWord]})],
        languageCompartment.current.of(languageExtensions(language)),
        diffCompartment.current.of(
          baseline === null
            ? []
            : unifiedMergeView({
                original: baseline,
                mergeControls: false,
                highlightChanges: true,
                gutter: true,
                syntaxHighlightDeletions: true,
                collapseUnchanged: {margin: 3, minSize: 6},
              }),
        ),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onSubmitRef.current?.();
              return true;
            },
          },
          {
            key: "Mod-'",
            run: () => {
              onRunRef.current?.();
              return true;
            },
          },
          ...(readOnly ? [] : [...closeBracketsKeymap, ...completionKeymap]),
        ]),
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
          cache.set(lastFileKey.current, v.state);
          if (cache.size > STATE_CACHE) {
            const [oldest] = cache.keys();
            cache.delete(oldest);
          }
        }
        lastFileKey.current = fileKey;
        lastResetKey.current = resetKey;
        // A cached state is only reused when the file was not rewritten meanwhile (reset, load solution).
        v.setState(
          cached !== undefined && cached.doc.toString() === value ? cached : buildStateRef.current(value, null),
        );
        v.dispatch({
          effects: [
            languageCompartment.current.reconfigure(languageExtensions(language)),
            settingsCompartment.current.reconfigure(settingsExtensions(settingsRef.current, readOnly)),
          ],
        });
        return;
      }
      if (lastResetKey.current === resetKey) return;
      lastResetKey.current = resetKey;
      if (v.state.doc.toString() !== value) {
        v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: value}});
      }
    }, [value, original, readOnly, fileKey, resetKey, language]);

    return <div className={className} ref={host} />;
  },
);
StepEditor.displayName = 'StepEditor';

export default StepEditor;
