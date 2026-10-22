/**
 * The course Markdown dialect — one parser for every renderer (the pane, the learning guide, the
 * Markdown and PDF exports).
 *
 *   # / ## / ###          headings
 *   paragraphs, > callouts, - bullets, 1. numbered lists (continuation lines indented)
 *   ```python try           fenced code (`try` adds "Load into editor" where there is one)
 *   | a | b |             pipe tables with a |---| separator row
 *   ---                   horizontal rule
 *   :::quiz               pop quiz: `Q: prompt`, options `- [ ]` / `- [x]`, `> explanation`, `:::`
 *   :::widget name {json} interactive visual (the renderer decides what to draw)
 *   :::details Title      collapsible section until the closing `:::`
 *   :::sequence / :::diagram  a JSON `Sequence` / `Diagram` (lib/types) up to the closing `:::`
 *   :::architecture       a JSON `Architecture` (lib/architecture): layers read bottom to top
 *   inline: **bold**, *em*, `code`, [text](url)
 */
import {type Architecture, architectureProblems} from './architecture';
import type {Diagram, Sequence} from './types';

export interface PopQuizSpec {
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

export type Block =
  | {kind: 'heading'; level: number; text: string}
  | {kind: 'paragraph'; text: string}
  | {kind: 'quote'; text: string}
  | {kind: 'list'; ordered: boolean; items: string[]}
  | {kind: 'code'; info: string; code: string; tryable: boolean}
  | {kind: 'table'; header: string[]; rows: string[][]}
  | {kind: 'rule'}
  | {kind: 'quiz'; quiz: PopQuizSpec}
  | {kind: 'widget'; name: string; params: Record<string, unknown>}
  | {kind: 'details'; title: string; body: Block[]}
  | {kind: 'sequence'; sequence: Sequence}
  | {kind: 'diagram'; diagram: Diagram}
  | {kind: 'architecture'; architecture: Architecture}
  | {kind: 'malformed'; what: string};

/** A `:::sequence` / `:::diagram` body: JSON with the arrays the drawing needs, or a malformed block. */
/** A `:::architecture` body: the JSON spec, or a malformed block naming what is wrong with it. */
const parseArchitecture = (body: string[]): Block => {
  let value: unknown;
  try {
    value = JSON.parse(body.join('\n'));
  } catch {
    return {kind: 'malformed', what: 'architecture block: not JSON'};
  }
  const problems = architectureProblems(value);
  return problems.length === 0
    ? {kind: 'architecture', architecture: value as Architecture}
    : {kind: 'malformed', what: `architecture block: ${problems.join('; ')}`};
};

const parseFigure = (name: 'sequence' | 'diagram', body: string[]): Block => {
  try {
    const value = JSON.parse(body.join('\n')) as Record<string, unknown>;
    if (name === 'sequence' && Array.isArray(value.participants) && Array.isArray(value.messages))
      return {kind: 'sequence', sequence: value as unknown as Sequence};
    if (name === 'diagram' && Array.isArray(value.nodes) && Array.isArray(value.edges))
      return {kind: 'diagram', diagram: value as unknown as Diagram};
  } catch {
    // Reported below.
  }
  return {kind: 'malformed', what: `${name} block: not the JSON a ${name} needs`};
};

const BLOCK_START = /^(```|#{1,3}\s|> |-\s|\d+\.\s|\||---\s*$|:::)/;

const parseQuiz = (lines: string[]): PopQuizSpec => {
  const promptLines: string[] = [];
  const options: string[] = [];
  const explanation: string[] = [];
  let answer = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const option = /^-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (option !== null) {
      if (option[1].toLowerCase() === 'x') answer = options.length;
      options.push(option[2]);
      continue;
    }
    if (line.startsWith('> ')) {
      explanation.push(line.slice(2));
      continue;
    }
    if (line.startsWith('Q:')) {
      promptLines.push(line.slice(2).trim());
      continue;
    }
    if (line !== '') (options.length === 0 ? promptLines : explanation).push(line);
  }
  return {prompt: promptLines.join(' '), options, answer, explanation: explanation.join(' ')};
};

export const parseBlocks = (source: string): Block[] => {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^```\s*(\w+)?\s*(try)?\s*$/.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      const info = (fence[1] ?? 'text').toLowerCase();
      blocks.push({kind: 'code', info, code: code.join('\n'), tryable: fence[2] === 'try'});
      continue;
    }
    const directive = /^:::(\w+)\s*(.*)$/.exec(line);
    if (directive !== null) {
      const name = directive[1];
      const rest = directive[2].trim();
      if (name === 'widget') {
        const m = /^([\w-]+)\s*(\{.*\})?\s*$/.exec(rest);
        let params: Record<string, unknown> = {};
        if (m?.[2]) {
          try {
            params = JSON.parse(m[2]) as Record<string, unknown>;
          } catch {
            params = {};
          }
        }
        blocks.push({kind: 'widget', name: m?.[1] ?? rest, params});
        i++;
        continue;
      }
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ':::') body.push(lines[i++]);
      i++;
      if (name === 'quiz') blocks.push({kind: 'quiz', quiz: parseQuiz(body)});
      else if (name === 'details')
        blocks.push({kind: 'details', title: rest || 'Details', body: parseBlocks(body.join('\n'))});
      else if (name === 'sequence' || name === 'diagram') blocks.push(parseFigure(name, body));
      else if (name === 'architecture') blocks.push(parseArchitecture(body));
      else blocks.push({kind: 'paragraph', text: body.join(' ')});
      continue;
    }
    if (/^---\s*$/.test(line)) {
      blocks.push({kind: 'rule'});
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({kind: 'heading', level: heading[1].length, text: heading[2]});
      i++;
      continue;
    }
    if (line.startsWith('> ')) {
      const text: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) text.push(lines[i++].slice(2));
      blocks.push({kind: 'quote', text: text.join(' ')});
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(c => c.trim());
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [header, ...body] = rows;
      blocks.push({kind: 'table', header: header ?? [], rows: body});
      continue;
    }
    const bullet = /^(?:-|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        let item = lines[i++].replace(bullet, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      blocks.push({kind: 'list', ordered, items});
      continue;
    }
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i])) text.push(lines[i++]);
    if (text.length === 0) {
      // A line that looks like a block start we do not handle: keep it as text.
      text.push(lines[i++]);
    }
    blocks.push({kind: 'paragraph', text: text.join(' ')});
  }
  return blocks;
};

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

export type InlineToken =
  | {kind: 'text'; text: string}
  | {kind: 'bold'; text: string}
  | {kind: 'em'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'link'; text: string; url: string};

/** The inline runs of one line of the dialect, in order. */
export const inlineTokens = (text: string): InlineToken[] =>
  text
    .split(INLINE)
    .filter(part => part !== '')
    .map(part => {
      if (part.startsWith('**') && part.endsWith('**')) return {kind: 'bold', text: part.slice(2, -2)};
      if (part.startsWith('`') && part.endsWith('`')) return {kind: 'code', text: part.slice(1, -1)};
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return {kind: 'em', text: part.slice(1, -1)};
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link !== null) return {kind: 'link', text: link[1], url: link[2]};
      return {kind: 'text', text: part};
    });

/** Parsed pop quizzes of a lesson body (for authoring checks). */
export function popQuizzesOf(source: string): PopQuizSpec[] {
  const out: PopQuizSpec[] = [];
  const visit = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'quiz') out.push(b.quiz);
      if (b.kind === 'details') visit(b.body);
    }
  };
  visit(parseBlocks(source));
  return out;
}

/** What the parser could not make sense of — `:::sequence` / `:::diagram` bodies that are not the JSON they need. */
export function malformedBlocksOf(source: string): string[] {
  const out: string[] = [];
  const visit = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'malformed') out.push(b.what);
      if (b.kind === 'details') visit(b.body);
    }
  };
  visit(parseBlocks(source));
  return out;
}

/** Widget names referenced by a lesson body (for authoring checks). */
export function widgetsOf(source: string): string[] {
  const out: string[] = [];
  const visit = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'widget') out.push(b.name);
      if (b.kind === 'details') visit(b.body);
    }
  };
  visit(parseBlocks(source));
  return out;
}
