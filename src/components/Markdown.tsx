import {type FC, type ReactNode, memo, useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';

import {githubSlug} from '@/lib/export';
import {type HighlightedSpan, leetbuildHighlighter} from '@/lib/highlight';
import {type Block, type InlineLeaf, type PopQuizSpec, inlineTokens, parseBlocks} from '@/lib/markdown';

import ArchitectureDiagram from './ArchitectureDiagram';
import GpuDiagram from './GpuDiagram';
import SequenceDiagram from './SequenceDiagram';
import SystemDiagram from './SystemDiagram';

/**
 * The course Markdown dialect, drawn: the dialect itself is parsed in lib/markdown.ts (one parser
 * for the pane, the learning guide and the exports). Fenced code is highlighted through
 * `highlight`; `try` on a fence adds "Load into editor"; `:::widget` goes through `renderWidget`;
 * `:::sequence` / `:::diagram` draw like a step's figures, `:::architecture` as a layer stack,
 * `:::gpu` as GPU references draw a kernel.
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
      case 'link': {
        const text = renderLeaves(token.parts);
        return (
          <a
            className="text-iris-300 decoration-iris-400/50 hover:text-iris-200 underline underline-offset-2"
            href={token.url}
            key={index}
            rel="noreferrer"
            target="_blank">
            {token.style === 'bold' ? (
              <strong className="font-semibold">{text}</strong>
            ) : token.style === 'em' ? (
              <em>{text}</em>
            ) : (
              text
            )}
          </a>
        );
      }
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

/**
 * An inline pop quiz. A wrong pick says "not quite", with that option's reason when the quiz gives
 * one, and leaves the answer hidden: pick again, or show the answer. A right pick (or "show answer")
 * reveals the answer and the explanation. The options are pressed buttons, never disabled, so focus
 * stays on the quiz; a status line announces each result.
 */
export const PopQuiz: FC<{quiz: PopQuizSpec; onAnswered?: (correct: boolean) => void}> = memo(({quiz, onAnswered}) => {
  const id = useId();
  /** The option picked last, and every wrong one picked so far. */
  const [picked, setPicked] = useState<number | null>(null);
  const [missed, setMissed] = useState<readonly number[]>([]);
  /** Answered right, or the answer asked for. */
  const [solved, setSolved] = useState<'correct' | 'shown' | null>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const onChoose = useCallback(
    (index: number) => {
      if (solved !== null) return;
      setPicked(index);
      if (index === quiz.answer) setSolved('correct');
      else setMissed(m => (m.includes(index) ? m : [...m, index]));
      onAnswered?.(index === quiz.answer);
    },
    [onAnswered, quiz.answer, solved],
  );
  const onShow = useCallback(() => {
    setSolved('shown');
    // The button goes away with the answer shown: focus moves to the answer, not to the page.
    options.current[quiz.answer]?.focus();
  }, [quiz.answer]);
  const onRetry = useCallback(() => {
    setPicked(null);
    setMissed([]);
    setSolved(null);
    options.current[0]?.focus();
  }, []);
  const reason = picked === null ? '' : quiz.reasons[picked] ?? '';
  const wrong = solved === null && picked !== null;
  return (
    <div className="border-ink-600 bg-ink-850 my-4 rounded-xl border p-3" data-prose>
      <p className="text-iris-300 mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
        <span className="bg-iris-400/15 rounded-full px-2 py-0.5">Pop quiz</span>
        {solved === 'correct' ? (
          <span aria-hidden className="text-success-300">
            Correct!
          </span>
        ) : wrong ? (
          <span aria-hidden className="text-danger-300">
            Not quite
          </span>
        ) : null}
      </p>
      <p className="text-ink-50 text-[14px]" id={`${id}-q`}>
        {renderInline(quiz.prompt)}
      </p>
      <div aria-labelledby={`${id}-q`} className="mt-2 grid gap-1.5" role="group">
        {quiz.options.map((option, index) => {
          const isAnswer = index === quiz.answer;
          const isMissed = missed.includes(index);
          const tone =
            solved !== null && isAnswer
              ? 'border-success-400/70 bg-success-400/15 text-ink-50'
              : isMissed
              ? `border-danger-400/70 bg-danger-400/15 text-danger-200 ${index === picked ? '' : 'opacity-70'}`
              : solved !== null
              ? 'border-ink-700 bg-ink-850 text-ink-400'
              : 'border-ink-600 bg-ink-800 text-ink-200 hover:border-iris-400/60 hover:text-ink-50';
          return (
            <button
              aria-disabled={solved !== null}
              aria-pressed={index === picked}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition ${tone} ${
                solved !== null ? 'cursor-default' : ''
              }`}
              key={index}
              onClick={() => onChoose(index)}
              ref={el => {
                options.current[index] = el;
              }}
              type="button">
              <span className="bg-ink-700 font-code text-iris-200 mt-0.5 shrink-0 rounded px-1.5 text-[10px]">
                {LETTERS[index]}
              </span>
              <span>{renderInline(option)}</span>
            </button>
          );
        })}
      </div>
      <div className="text-ink-200 mt-2 flex items-start justify-between gap-3 text-[13px]">
        {/* Always in the page, so a screen reader announces what changes in it. */}
        <div className="space-y-1" role="status">
          {wrong ? (
            <p>
              <span className="text-danger-300 font-semibold">Not quite.</span>
              {/* Names the pick, so a second wrong pick is announced too. */}
              <span className="sr-only"> You picked {LETTERS[picked ?? 0]}.</span>{' '}
              {reason === '' ? null : <>{renderInline(reason)} </>}
              Try another option, or show the answer.
            </p>
          ) : null}
          {solved !== null ? (
            <>
              {solved === 'correct' ? (
                <p className="sr-only">Correct!</p>
              ) : (
                <p>
                  <span className="text-success-300 font-semibold">The answer is {LETTERS[quiz.answer]}.</span>
                  {picked !== null && picked !== quiz.answer && reason !== '' ? (
                    <>
                      {' '}
                      You picked {LETTERS[picked]}: {renderInline(reason)}
                    </>
                  ) : null}
                </p>
              )}
              {solved === 'correct' && reason !== '' ? <p>{renderInline(reason)}</p> : null}
              <p>{renderInline(quiz.explanation)}</p>
            </>
          ) : null}
        </div>
        {wrong ? (
          <button className="text-iris-300 hover:text-ink-50 shrink-0 text-[11px]" onClick={onShow} type="button">
            show answer
          </button>
        ) : solved !== null ? (
          <button className="text-iris-300 hover:text-ink-50 shrink-0 text-[11px]" onClick={onRetry} type="button">
            try again
          </button>
        ) : null}
      </div>
    </div>
  );
});
PopQuiz.displayName = 'PopQuiz';

/** The anchors of the headings in a run of blocks, nested `:::details` included. */
const anchorsOf = (blocks: readonly Block[]): string[] =>
  blocks.flatMap(b => (b.kind === 'heading' ? [githubSlug(b.text)] : b.kind === 'details' ? anchorsOf(b.body) : []));

/** A collapsible section; it opens by itself when the address names a heading inside it. */
const Details: FC<{title: string; anchors: readonly string[]; children: ReactNode}> = memo(
  ({title, anchors, children}) => {
    const [open, setOpen] = useState(false);
    const toggle = useCallback(() => setOpen(o => !o), []);
    useEffect(() => {
      if (anchors.length === 0) return undefined;
      const onHash = (): void => {
        if (anchors.includes(decodeURIComponent(window.location.hash.slice(1)))) setOpen(true);
      };
      onHash();
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, [anchors]);
    return (
      <div className="border-ink-700 bg-ink-850 my-3 rounded-lg border">
        <button
          aria-expanded={open}
          className="text-iris-300 flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold"
          onClick={toggle}
          type="button">
          <span className="text-[10px]">{open ? '▼' : '▶'}</span>
          {title}
        </button>
        {open ? <div className="border-ink-700 border-t px-3 py-2">{children}</div> : null}
      </div>
    );
  },
);
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
          // Anchored like GitHub would, so a table of contents can link into the text. `data-prose`
          // marks running text, which a reading page may hold to a line length (figures, code and
          // tables keep the full width).
          return block.level === 1 ? (
            <h2
              className="text-ink-50 scroll-mt-20 pt-2 text-xl font-bold"
              data-prose
              id={githubSlug(block.text)}
              key={index}>
              {renderInline(block.text)}
            </h2>
          ) : block.level === 2 ? (
            <h3
              className="text-iris-300 scroll-mt-20 pt-2 text-base font-bold"
              data-prose
              id={githubSlug(block.text)}
              key={index}>
              {renderInline(block.text)}
            </h3>
          ) : (
            <h4
              className="text-ink-300 scroll-mt-20 pt-1 text-sm font-semibold uppercase tracking-wide"
              data-prose
              id={githubSlug(block.text)}
              key={index}>
              {renderInline(block.text)}
            </h4>
          );
        case 'paragraph':
          return (
            <p data-prose key={index}>
              {renderInline(block.text)}
            </p>
          );
        case 'quote':
          return (
            <div
              className="border-iris-400/40 bg-iris-400/10 text-iris-200 rounded-lg border px-3 py-2 text-[13px]"
              data-prose
              key={index}>
              {renderInline(block.text)}
            </div>
          );
        case 'list':
          return block.ordered ? (
            <ol className="marker:text-iris-400 list-decimal space-y-1 pl-5" data-prose key={index}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          ) : (
            <ul className="marker:text-iris-400 list-disc space-y-1 pl-5" data-prose key={index}>
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
                {/* No text-transform: uppercase would turn μ into Μ, π into Π and `d = buf` into D = BUF. */}
                <thead className="bg-ink-800 text-ink-200 text-left text-[12px]">
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
        case 'gpu':
          return (
            <div className="my-4" key={index}>
              <GpuDiagram spec={block.gpu} />
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
            <Details anchors={anchorsOf(block.body)} key={index} title={block.title}>
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
