import {type FC, type ReactNode, memo, useCallback, useMemo, useState} from 'react';

import type {HighlightedSpan} from '@/lib/editor';
import {leetbuildHighlighter} from '@/lib/highlight';

/**
 * Markdown dialect for problem statements, step tasks, hints and debriefs.
 *
 *   # / ## / ###          headings
 *   paragraphs, > callouts, - bullets, 1. numbered lists (continuation lines indented)
 *   ```python try           fenced code (highlighted through `highlight`; `try` adds "Load into editor")
 *   | a | b |             pipe tables with a |---| separator row
 *   ---                   horizontal rule
 *   :::quiz               pop quiz: `Q: prompt`, options `- [ ]` / `- [x]`, `> explanation`, `:::`
 *   :::widget name {json} interactive visual (rendered through `renderWidget`)
 *   :::details Title      collapsible section until the closing `:::`
 *   inline: **bold**, *em*, `code`, [text](url)
 */

export interface PopQuizSpec {
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

/** Turns a fenced block into spans; `info` is the word after the opening fence (`cuda`, `python`…), lower-cased. */
export type Highlighter = (code: string, info: string) => HighlightedSpan[];

type Block =
  | {kind: 'heading'; level: number; text: string}
  | {kind: 'paragraph'; text: string}
  | {kind: 'quote'; text: string}
  | {kind: 'list'; ordered: boolean; items: string[]}
  | {kind: 'code'; info: string; code: string; tryable: boolean}
  | {kind: 'table'; header: string[]; rows: string[][]}
  | {kind: 'rule'}
  | {kind: 'quiz'; quiz: PopQuizSpec}
  | {kind: 'widget'; name: string; params: Record<string, unknown>}
  | {kind: 'details'; title: string; body: Block[]};

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

const parseBlocks = (source: string): Block[] => {
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

const renderInline = (text: string): ReactNode[] => {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong className="font-semibold text-white" key={index}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code className="rounded bg-plum-700/80 px-1.5 py-0.5 font-code text-[0.85em] text-candy-200" key={index}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em className="text-plum-200" key={index}>
          {part.slice(1, -1)}
        </em>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link !== null) {
      return (
        <a
          className="text-candy-400 underline decoration-candy-600/60 underline-offset-2 hover:text-candy-300"
          href={link[2]}
          key={index}
          rel="noreferrer"
          target="_blank">
          {link[1]}
        </a>
      );
    }
    return part;
  });
};

const CodeBlock: FC<{
  info: string;
  code: string;
  tryable: boolean;
  highlight: Highlighter;
  onTry?: (code: string) => void;
}> = memo(({info, code, tryable, highlight, onTry}) => {
  const spans = useMemo(() => highlight(code, info), [code, highlight, info]);
  const onClick = useCallback(() => onTry?.(code), [code, onTry]);
  return (
    <div className="group relative my-3">
      <pre className="overflow-x-auto rounded-lg border border-plum-600/70 bg-plum-900/80 p-3 font-code text-[12.5px] leading-relaxed text-cream">
        <code>
          {spans.map((span, index) =>
            span.className === '' ? (
              span.text
            ) : (
              <span className={span.className} key={index}>
                {span.text}
              </span>
            ),
          )}
        </code>
      </pre>
      {tryable && onTry ? (
        <button
          className="absolute right-2 top-2 rounded-md bg-candy-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow transition hover:bg-candy-400"
          onClick={onClick}
          type="button">
          Load into editor
        </button>
      ) : null}
    </div>
  );
});
CodeBlock.displayName = 'CodeBlock';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** An inline pop quiz: pick an option, get immediate feedback, retry freely. */
export const PopQuiz: FC<{quiz: PopQuizSpec; onAnswered?: (correct: boolean) => void}> = memo(({quiz, onAnswered}) => {
  const [chosen, setChosen] = useState<number | null>(null);
  const onChoose = useCallback(
    (index: number) => {
      setChosen(index);
      onAnswered?.(index === quiz.answer);
    },
    [onAnswered, quiz.answer],
  );
  const onRetry = useCallback(() => setChosen(null), []);
  const answered = chosen !== null;
  const correct = chosen === quiz.answer;
  return (
    <div className="my-4 rounded-xl border border-plum-500/70 bg-plum-950/50 p-3 shadow-[0_0_24px_rgba(122,79,199,0.15)]">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-candy-400">
        <span className="rounded-full bg-candy-500/20 px-2 py-0.5">Pop quiz</span>
        {answered ? (
          <span className={correct ? 'text-emerald-300' : 'text-rose-300'}>{correct ? 'Correct!' : 'Not quite'}</span>
        ) : null}
      </p>
      <p className="text-[14px] text-white">{renderInline(quiz.prompt)}</p>
      <div className="mt-2 grid gap-1.5">
        {quiz.options.map((option, index) => {
          const isAnswer = index === quiz.answer;
          const tone = !answered
            ? 'border-plum-600/70 bg-plum-900/60 text-plum-200 hover:border-candy-500/60 hover:text-white'
            : isAnswer
            ? 'border-emerald-400/70 bg-emerald-500/15 text-white'
            : index === chosen
            ? 'border-rose-400/70 bg-rose-500/15 text-rose-100'
            : 'border-plum-700/60 bg-plum-900/40 text-plum-400';
          return (
            <button
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition ${tone}`}
              disabled={answered}
              key={index}
              onClick={() => onChoose(index)}
              type="button">
              <span className="mt-0.5 shrink-0 rounded bg-plum-700/80 px-1.5 font-code text-[10px] text-candy-200">
                {LETTERS[index]}
              </span>
              <span>{renderInline(option)}</span>
            </button>
          );
        })}
      </div>
      {answered ? (
        <div className="mt-2 flex items-start justify-between gap-3 text-[13px] text-plum-200">
          <p>{renderInline(quiz.explanation)}</p>
          <button className="shrink-0 text-[11px] text-candy-300 hover:text-white" onClick={onRetry} type="button">
            try again
          </button>
        </div>
      ) : null}
    </div>
  );
});
PopQuiz.displayName = 'PopQuiz';

const Details: FC<{title: string; children: ReactNode}> = memo(({title, children}) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  return (
    <div className="my-3 rounded-lg border border-plum-600/70 bg-plum-900/40">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-candy-300"
        onClick={toggle}
        type="button">
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        {title}
      </button>
      {open ? <div className="border-t border-plum-600/60 px-3 py-2">{children}</div> : null}
    </div>
  );
});
Details.displayName = 'Details';

/** Inline-only markdown (bold, code, emphasis, links) for places that cannot hold block content. */
export const InlineMarkdown: FC<{source: string}> = memo(({source}) => <span>{renderInline(source)}</span>);
InlineMarkdown.displayName = 'InlineMarkdown';

export type WidgetRenderer = (name: string, params: Record<string, unknown>) => ReactNode;

interface Props {
  source: string;
  onTry?: (code: string) => void;
  renderWidget?: WidgetRenderer;
  /** Called when a pop quiz is answered. */
  onQuiz?: (correct: boolean) => void;
  /** Fenced-code highlighter; defaults to the CUDA/C++ one. */
  highlight?: Highlighter;
}

const Blocks: FC<{
  blocks: Block[];
  highlight: Highlighter;
  onTry?: (code: string) => void;
  renderWidget?: WidgetRenderer;
  onQuiz?: (correct: boolean) => void;
}> = memo(({blocks, highlight, onTry, renderWidget, onQuiz}) => (
  <>
    {blocks.map((block, index) => {
      switch (block.kind) {
        case 'heading':
          return block.level === 1 ? (
            <h2 className="pt-2 text-xl font-bold text-white" key={index}>
              {renderInline(block.text)}
            </h2>
          ) : block.level === 2 ? (
            <h3 className="pt-2 text-base font-bold text-candy-300" key={index}>
              {renderInline(block.text)}
            </h3>
          ) : (
            <h4 className="pt-1 text-sm font-semibold uppercase tracking-wide text-plum-300" key={index}>
              {renderInline(block.text)}
            </h4>
          );
        case 'paragraph':
          return <p key={index}>{renderInline(block.text)}</p>;
        case 'quote':
          return (
            <div
              className="rounded-lg border border-candy-500/40 bg-candy-500/10 px-3 py-2 text-[13px] text-candy-200"
              key={index}>
              {renderInline(block.text)}
            </div>
          );
        case 'list':
          return block.ordered ? (
            <ol className="list-decimal space-y-1 pl-5 marker:text-candy-400" key={index}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          ) : (
            <ul className="list-disc space-y-1 pl-5 marker:text-candy-400" key={index}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        case 'code':
          return (
            <CodeBlock
              code={block.code}
              highlight={highlight}
              info={block.info}
              key={index}
              onTry={onTry}
              tryable={block.tryable}
            />
          );
        case 'table':
          return (
            <div className="my-3 overflow-x-auto rounded-lg border border-plum-600/70" key={index}>
              <table className="w-full border-collapse text-[13px]">
                <thead className="bg-plum-800/70 text-left text-[11px] uppercase tracking-wide text-plum-300">
                  <tr>
                    {block.header.map((cell, j) => (
                      <th className="px-3 py-1.5 font-semibold" key={j}>
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr className="border-t border-plum-700/60 odd:bg-plum-900/30" key={r}>
                      {row.map((cell, c) => (
                        <td className="text-plum-100 px-3 py-1.5 align-top" key={c}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case 'rule':
          return <hr className="border-plum-600/60" key={index} />;
        case 'quiz':
          return <PopQuiz key={index} onAnswered={onQuiz} quiz={block.quiz} />;
        case 'widget':
          return (
            <div className="my-4" key={index}>
              {renderWidget ? (
                renderWidget(block.name, block.params)
              ) : (
                <div className="rounded-lg border border-dashed border-plum-500 p-3 text-[12px] text-plum-300">
                  widget: {block.name}
                </div>
              )}
            </div>
          );
        case 'details':
          return (
            <Details key={index} title={block.title}>
              <div className="space-y-3 text-[14px] leading-relaxed text-plum-200">
                <Blocks
                  blocks={block.body}
                  highlight={highlight}
                  onQuiz={onQuiz}
                  onTry={onTry}
                  renderWidget={renderWidget}
                />
              </div>
            </Details>
          );
      }
    })}
  </>
));
Blocks.displayName = 'MarkdownBlocks';

const Markdown: FC<Props> = memo(({source, onTry, renderWidget, onQuiz, highlight = leetbuildHighlighter}) => {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-plum-200">
      <Blocks blocks={blocks} highlight={highlight} onQuiz={onQuiz} onTry={onTry} renderWidget={renderWidget} />
    </div>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;

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
