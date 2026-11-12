/**
 * CodeMirror configuration of the step editor: the editing feature set, the grammar per language
 * and indentation conventions. The token → CSS class mapping it shares with static code blocks
 * (the `.tok-*` palette in globals.scss) lives in `highlight.ts`.
 */
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {cpp} from '@codemirror/lang-cpp';
import {go} from '@codemirror/lang-go';
import {javascript} from '@codemirror/lang-javascript';
import {python} from '@codemirror/lang-python';
import {
  type LanguageSupport,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import {protobuf} from '@codemirror/legacy-modes/mode/protobuf';
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search';
import {type Extension, EditorState} from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import {vim} from '@replit/codemirror-vim';

import {changeGutter} from './changeGutter';
import type {EditorSettings} from './editorSettings';
import {scalaLanguage, tokenHighlighter} from './highlight';
import type {Language} from './types';

/** What an editor can highlight: the five languages, plus `.proto` for the provided contracts. */
export type Syntax = Language | 'proto';

// ---- grammars ---------------------------------------------------------------------------------

const grammars: Record<Syntax, LanguageSupport | StreamLanguage<unknown>> = {
  python: python(),
  typescript: javascript({typescript: true}),
  go: go(),
  scala: scalaLanguage,
  cpp: cpp(),
  cuda: cpp(),
  proto: StreamLanguage.define(protobuf),
};

/** Grammar + language data for the editor. */
export function editorLanguage(syntax: Syntax): Extension {
  return grammars[syntax];
}

/** Indentation the language community expects; Go is tabs (gofmt). */
export const INDENT: Record<Syntax, {unit: string; tabSize: number}> = {
  cpp: {unit: '  ', tabSize: 2},
  cuda: {unit: '  ', tabSize: 2},
  go: {unit: '\t', tabSize: 4},
  python: {unit: '    ', tabSize: 4},
  typescript: {unit: '  ', tabSize: 2},
  scala: {unit: '  ', tabSize: 2},
  proto: {unit: '  ', tabSize: 2},
};

// ---- editor feature sets ---------------------------------------------------------------------

const theme = EditorView.theme(
  {
    '&': {height: '100%'},
    '.cm-scroller': {overflow: 'auto'},
    '.cm-gutters': {minWidth: '3ch'},
  },
  {dark: true},
);

const shared: Extension[] = [
  theme,
  lineNumbers(),
  drawSelection(),
  bracketMatching(),
  highlightSelectionMatches(),
  syntaxHighlighting(tokenHighlighter),
  EditorState.tabSize.of(2),
];

export function viewerExtensions(): Extension[] {
  return [
    ...shared,
    foldGutter(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    keymap.of([...searchKeymap, ...foldKeymap]),
  ];
}

/**
 * Editors. `baseline` is the text the gutter right of the line numbers marks changes against (the
 * file's starter; `src/lib/changeGutter.ts`); without one there is no change gutter.
 */
export function editorExtensions(baseline: string | null = null): Extension[] {
  return [
    ...shared,
    // After the line numbers in the configuration, so its gutter sits right beside them.
    baseline === null ? [] : changeGutter(baseline),
    history(),
    foldGutter(),
    indentOnInput(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    rectangularSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
  ];
}

/**
 * What the learner's settings add: Vim bindings (editors only; first in the configuration so they
 * see keys before the other keymaps), the font size, line wrapping. Lives in its own compartment
 * so a change reconfigures the live view.
 */
export function settingsExtensions(settings: EditorSettings, readOnly: boolean): Extension[] {
  return [
    settings.keymap === 'vim' && !readOnly ? vim({status: true}) : [],
    EditorView.theme({'&.cm-editor': {fontSize: `${settings.fontSize}px`}}),
    settings.wrap ? EditorView.lineWrapping : [],
  ];
}
