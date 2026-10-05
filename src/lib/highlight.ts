/**
 * Static syntax highlighting for fenced code in problem text: the same grammars the editor uses,
 * rendered to `tok-*` spans.
 */
import type {Highlighter} from '@/components/Markdown';
import {highlightCodeSpans} from '@/lib/editor';

import type {Language} from './types';

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
};

export const leetbuildHighlighter: Highlighter = (code, info) => {
  const language = FENCE_LANGUAGE[info];
  return language === undefined ? [{text: code, className: ''}] : highlightCodeSpans(code, language);
};
