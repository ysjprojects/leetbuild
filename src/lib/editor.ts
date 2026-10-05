/**
 * CodeMirror configuration shared by the step editor and the static code blocks: the editing
 * feature set, the grammar per language, indentation conventions, and the token → CSS class
 * mapping that the `.tok-*` palette in globals.scss colours.
 */
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {cpp} from '@codemirror/lang-cpp';
import {go} from '@codemirror/lang-go';
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
import {scala} from '@codemirror/legacy-modes/mode/clike';
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
import {highlightCode, tagHighlighter, tags} from '@lezer/highlight';

import type {Language} from './types';

// ---- grammars ---------------------------------------------------------------------------------

const grammars: Record<Language, LanguageSupport | StreamLanguage<unknown>> = {
  python: python(),
  go: go(),
  scala: StreamLanguage.define(scala),
  cpp: cpp(),
};

/** Grammar + language data for the editor. */
export function editorLanguage(language: Language): Extension {
  return grammars[language];
}

/** Indentation the language community expects; Go is tabs (gofmt). */
export const INDENT: Record<Language, {unit: string; tabSize: number}> = {
  cpp: {unit: '  ', tabSize: 2},
  go: {unit: '\t', tabSize: 4},
  python: {unit: '    ', tabSize: 4},
  scala: {unit: '  ', tabSize: 2},
};

// ---- token classes ------------------------------------------------------------------------------

/** Tag → CSS class mapping shared by editors and static code blocks (see globals.scss). */
export const tokenHighlighter = tagHighlighter([
  {tag: tags.comment, class: 'tok-comment'},
  {tag: tags.keyword, class: 'tok-keyword'},
  {tag: tags.controlKeyword, class: 'tok-controlKeyword'},
  {tag: tags.operatorKeyword, class: 'tok-keyword'},
  {tag: tags.definitionKeyword, class: 'tok-keyword'},
  {tag: tags.moduleKeyword, class: 'tok-keyword'},
  {tag: tags.modifier, class: 'tok-modifier'},
  {tag: tags.annotation, class: 'tok-annotation'},
  {tag: tags.attributeName, class: 'tok-annotation'},
  {tag: tags.meta, class: 'tok-meta'},
  {tag: tags.processingInstruction, class: 'tok-processingInstruction'},
  {tag: tags.macroName, class: 'tok-macroName'},
  {tag: tags.typeName, class: 'tok-typeName'},
  {tag: tags.className, class: 'tok-className'},
  {tag: tags.namespace, class: 'tok-namespace'},
  {tag: tags.string, class: 'tok-string'},
  {tag: tags.special(tags.string), class: 'tok-string2'},
  {tag: tags.character, class: 'tok-character'},
  {tag: tags.number, class: 'tok-number'},
  {tag: tags.bool, class: 'tok-bool'},
  {tag: tags.atom, class: 'tok-atom'},
  {tag: tags.literal, class: 'tok-literal'},
  {tag: tags.variableName, class: 'tok-variableName'},
  {tag: tags.special(tags.variableName), class: 'tok-variableName2'},
  {tag: tags.propertyName, class: 'tok-propertyName'},
  {tag: tags.function(tags.variableName), class: 'tok-function'},
  {tag: tags.definition(tags.variableName), class: 'tok-definition'},
  {tag: tags.labelName, class: 'tok-labelName'},
  {tag: tags.operator, class: 'tok-operator'},
  {tag: tags.punctuation, class: 'tok-punctuation'},
  {tag: tags.heading, class: 'tok-labelName'},
  {tag: tags.invalid, class: 'tok-invalid'},
]);

export interface HighlightedSpan {
  text: string;
  className: string;
}

/** Tokenize a snippet for static rendering (code blocks, solutions); `\n` becomes an empty-class span. */
export function highlightCodeSpans(code: string, language: Language): HighlightedSpan[] {
  const support = grammars[language];
  const parser = 'language' in support ? support.language.parser : support.parser;
  const tree = parser.parse(code);
  const spans: HighlightedSpan[] = [];
  highlightCode(
    code,
    tree,
    tokenHighlighter,
    (text, className) => spans.push({text, className}),
    () => spans.push({text: '\n', className: ''}),
  );
  return spans;
}

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

export function editorExtensions(): Extension[] {
  return [
    ...shared,
    history(),
    foldGutter(),
    indentOnInput(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    rectangularSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
  ];
}
