import {type FC, type ReactNode, memo, useCallback, useMemo, useState} from 'react';

import type {HighlightedSpan} from '@/lib/editor';
import {githubSlug} from '@/lib/export';
import {leetbuildHighlighter} from '@/lib/highlight';
import {type Block, type InlineLeaf, type PopQuizSpec, inlineTokens, parseBlocks} from '@/lib/markdown';

import ArchitectureDiagram from './ArchitectureDiagram';
import SequenceDiagram from './SequenceDiagram';
import SystemDiagram from './SystemDiagram';

/**
 * The course Markdown dialect, drawn: the dialect itself is parsed in lib/markdown.ts (one parser
 * for the pane, the learning guide and the exports). Fenced code is highlighted through
 * `highlight`; `try` on a fence adds "Load into editor"; `:::widget` goes through `renderWidget`;
 * `:::sequence` / `:::diagram` draw like a step's figures, `:::architecture` as a layer stack.
 */

/** Turns a fenced block into spans; `info` is the word after the opening fence (`cuda`, `python`…), lower-cased. */
export type Highlighter = (code: string, info: string) => HighlightedSpan[];

const CODE_CLASS = 'bg-ink-800 font-code text-iris-200 rounded px-1.5 py-0.5 text-[0.85em]';

/** The runs inside bold, emphasis or a link: text as is, code spans as code. */
const renderLeaves = (parts: InlineLeaf[]): ReactNode[] =>
  parts.map((leaf, index) =>
    leaf.kind === 'code' ? (
      <code className={CODE_CLASS} key={index}>
        {leaf.text}
      </code>
    ) : (
      leaf.text
    ),
  );

const renderInline = (text: string): ReactNode[] =>
  inlineTokens(text).map((token, index) => {
    switch (token.kind) {
      case 'bold':
        return (
          <strong className="text-ink-50 font-semibold" key={index}>
            {renderLeaves(token.parts)}
          </strong>
        );
      case 'code':
        return (
          <code className={CODE_CLASS} key={index}>
            {token.text}
          </code>
        );
      case 'em':
        return (
          <em className="text-ink-200" key={index}>
            {renderLeaves(token.parts)}
          </em>
        );
      case 'link':
        return (
          <a
            className="text-iris-300 decoration-iris-400/50 hover:text-iris-200 underline underline-offset-2"
            href={token.url}
            key={index}
            rel="noreferrer"
            target="_blank">
            {renderLeaves(token.parts)}
          </a>
        );
      case 'text':
        return token.text;
    }
  });

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
      <pre className="border-ink-700 bg-ink-950 font-code text-ink-100 overflow-x-auto rounded-lg border p-3 text-[13px] leading-relaxed">
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
          className="bg-iris-400 text-ink-950 hover:bg-iris-300 absolute right-2 top-2 rounded-md px-2 py-0.5 text-[11px] font-semibold shadow transition"
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
    <div className="border-ink-600 bg-ink-850 my-4 rounded-xl border p-3">
      <p className="text-iris-400 mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
        <span className="bg-iris-400/15 rounded-full px-2 py-0.5">Pop quiz</span>
        {answered ? (
          <span className={correct ? 'text-success-300' : 'text-danger-300'}>{correct ? 'Correct!' : 'Not quite'}</span>
        ) : null}
      </p>
      <p className="text-ink-50 text-[14px]">{renderInline(quiz.prompt)}</p>
      <div className="mt-2 grid gap-1.5">
        {quiz.options.map((option, index) => {
          const isAnswer = index === quiz.answer;
          const tone = !answered
            ? 'border-ink-600 bg-ink-800 text-ink-200 hover:border-iris-400/60 hover:text-ink-50'
            : isAnswer
            ? 'border-success-400/70 bg-success-400/15 text-ink-50'
            : index === chosen
            ? 'border-danger-400/70 bg-danger-400/15 text-danger-200'
            : 'border-ink-700 bg-ink-850 text-ink-400';
          return (
            <button
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition ${tone}`}
              disabled={answered}
              key={index}
              onClick={() => onChoose(index)}
              type="button">
              <span className="bg-ink-700 font-code text-iris-200 mt-0.5 shrink-0 rounded px-1.5 text-[10px]">
                {LETTERS[index]}
              </span>
              <span>{renderInline(option)}</span>
            </button>
          );
        })}
      </div>
      {answered ? (
        <div className="text-ink-200 mt-2 flex items-start justify-between gap-3 text-[13px]">
          <p>{renderInline(quiz.explanation)}</p>
          <button className="text-iris-300 hover:text-ink-50 shrink-0 text-[11px]" onClick={onRetry} type="button">
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
    <div className="border-ink-700 bg-ink-850 my-3 rounded-lg border">
      <button
        className="text-iris-300 flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold"
        onClick={toggle}
        type="button">
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        {title}
      </button>
      {open ? <div className="border-ink-700 border-t px-3 py-2">{children}</div> : null}
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

const NO_FOCUS: readonly string[] = [];

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
          // Anchored like GitHub would, so a table of contents can link into the text.
          return block.level === 1 ? (
            <h2 className="text-ink-50 scroll-mt-20 pt-2 text-xl font-bold" id={githubSlug(block.text)} key={index}>
              {renderInline(block.text)}
            </h2>
          ) : block.level === 2 ? (
            <h3 className="text-iris-300 scroll-mt-20 pt-2 text-base font-bold" id={githubSlug(block.text)} key={index}>
              {renderInline(block.text)}
            </h3>
          ) : (
            <h4
              className="text-ink-300 scroll-mt-20 pt-1 text-sm font-semibold uppercase tracking-wide"
              id={githubSlug(block.text)}
              key={index}>
              {renderInline(block.text)}
            </h4>
          );
        case 'paragraph':
          return <p key={index}>{renderInline(block.text)}</p>;
        case 'quote':
          return (
            <div
              className="border-iris-400/40 bg-iris-400/10 text-iris-200 rounded-lg border px-3 py-2 text-[13px]"
              key={index}>
              {renderInline(block.text)}
            </div>
          );
        case 'list':
          return block.ordered ? (
            <ol className="marker:text-iris-400 list-decimal space-y-1 pl-5" key={index}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          ) : (
            <ul className="marker:text-iris-400 list-disc space-y-1 pl-5" key={index}>
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
            <div className="border-ink-700 my-3 overflow-x-auto rounded-lg border" key={index}>
              <table className="w-full border-collapse text-[13px]">
                <thead className="bg-ink-800 text-ink-300 text-left text-[11px] uppercase tracking-wide">
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
                    <tr className="border-ink-700 odd:bg-ink-850 border-t" key={r}>
                      {row.map((cell, c) => (
                        <td className="text-ink-200 px-3 py-1.5 align-top" key={c}>
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
          return <hr className="border-ink-700" key={index} />;
        case 'quiz':
          return <PopQuiz key={index} onAnswered={onQuiz} quiz={block.quiz} />;
        case 'widget':
          return (
            <div className="my-4" key={index}>
              {renderWidget ? (
                renderWidget(block.name, block.params)
              ) : (
                <div className="border-ink-600 text-ink-300 rounded-lg border border-dashed p-3 text-[12px]">
                  widget: {block.name}
                </div>
              )}
            </div>
          );
        case 'sequence':
          return (
            <div className="my-4" key={index}>
              <SequenceDiagram sequence={block.sequence} />
            </div>
          );
        case 'diagram':
          return (
            <div className="my-4" key={index}>
              <SystemDiagram compact diagram={block.diagram} focus={NO_FOCUS} />
            </div>
          );
        case 'architecture':
          return (
            <div className="my-4" key={index}>
              <ArchitectureDiagram spec={block.architecture} />
            </div>
          );
        case 'malformed':
          return (
            <div
              className="border-danger-400/60 text-danger-200 rounded-lg border border-dashed p-3 text-[12px]"
              key={index}>
              {block.what}
            </div>
          );
        case 'details':
          return (
            <Details key={index} title={block.title}>
              <div className="text-ink-200 space-y-3 text-[14px] leading-relaxed">
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
    <div className="text-ink-200 space-y-3 text-[14px] leading-relaxed">
      <Blocks blocks={blocks} highlight={highlight} onQuiz={onQuiz} onTry={onTry} renderWidget={renderWidget} />
    </div>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
