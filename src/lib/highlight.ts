/**
 * Static syntax highlighting for fenced code in problem text and guides, rendered to `tok-*` spans:
 * the editor's grammars and token classes without the editor, so a page that only shows code loads
 * the parsers and not CodeMirror's view, keymaps or Vim.
 */
import {cppLanguage} from '@codemirror/lang-cpp';
import {goLanguage} from '@codemirror/lang-go';
import {typescriptLanguage} from '@codemirror/lang-javascript';
import {pythonLanguage} from '@codemirror/lang-python';
import {type Language as Grammar, StreamLanguage} from '@codemirror/language';
import {scala} from '@codemirror/legacy-modes/mode/clike';
import {highlightCode, tagHighlighter, tags} from '@lezer/highlight';

import type {Highlighter} from '@/components/Markdown';

import type {Language} from './types';

/** Scala's grammar, a legacy stream mode; the editor uses this one too. */
export const scalaLanguage = StreamLanguage.define(scala);

/** The parsers the editor's language support wraps, one per language. */
const grammars: Record<Language, Grammar> = {
  python: pythonLanguage,
  typescript: typescriptLanguage,
  go: goLanguage,
  scala: scalaLanguage,
  cpp: cppLanguage,
  cuda: cppLanguage,
};

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
  const tree = grammars[language].parser.parse(code);
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

/** Fence info words → language; protobuf reads well enough through the C++ grammar. */
const FENCE_LANGUAGE: Record<string, Language> = {
  python: 'python',
  py: 'python',
  go: 'go',
  scala: 'scala',
  cpp: 'cpp',
  'c++': 'cpp',
  c: 'cpp',
  proto: 'cpp',
  protobuf: 'cpp',
  cuda: 'cuda',
  cu: 'cuda',
  typescript: 'typescript',
  ts: 'typescript',
};

export const leetbuildHighlighter: Highlighter = (code, info) => {
  const language = FENCE_LANGUAGE[info];
  return language === undefined ? [{text: code, className: ''}] : highlightCodeSpans(code, language);
};
