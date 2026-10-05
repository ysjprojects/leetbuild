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

import {editorExtensions, editorLanguage, INDENT, viewerExtensions} from '@/lib/editor';
import type {Language} from '@/lib/types';

interface Props {
  value: string;
  language: Language;
  /** Editable editors emit `onChange`; viewers replace their document whenever `value` changes. */
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  /** Baseline text for a unified diff against `value` (viewers only): the learner's code under the solution. */
  original?: string | null;
  /** Editable editors only replace their document (discarding edits) when this key changes. */
  resetKey?: string | number;
  viewRef?: MutableRefObject<EditorView | null>;
  className?: string;
}

const languageExtensions = (language: Language): Extension => [
  editorLanguage(language),
  EditorState.tabSize.of(INDENT[language].tabSize),
  indentUnit.of(INDENT[language].unit),
];

const StepEditor = memo(
  ({value, language, readOnly = false, onChange, onSubmit, original = null, resetKey, viewRef, className}: Props) => {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);
    const languageCompartment = useRef(new Compartment());
    const diffCompartment = useRef(new Compartment());
    const lastResetKey = useRef(resetKey);
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;

    const buildState = (doc: string, baseline: string | null): EditorState => {
      const extensions: Extension[] = [
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

    // Grammar and indentation follow `language`; document replacement is driven by `resetKey`/`value` below.
    useEffect(() => {
      const v = view.current;
      if (v === null) return;
      v.dispatch({effects: languageCompartment.current.reconfigure(languageExtensions(language))});
    }, [language]);

    // Viewers follow `value`/`original`; editors only follow `resetKey`.
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
      if (lastResetKey.current === resetKey) return;
      lastResetKey.current = resetKey;
      if (v.state.doc.toString() !== value) {
        v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: value}});
      }
    }, [value, original, readOnly, resetKey]);

    return <div className={className} ref={host} />;
  },
);
StepEditor.displayName = 'StepEditor';

export default StepEditor;
