/**
 * The learning guide as a PDF of its own: an A4 document laid out for paper (title page with a
 * table of contents, sections with running footers, code and callouts in boxes, figures, pop
 * quizzes with the answer printed), built from the same parsed dialect the page draws
 * (lib/markdown.ts). Figures come in as SVG drawn by the page's own components (lib/guidePdf.ts);
 * an interactive demo stays on the page and is a one-line note here. Pure: nothing here touches
 * the DOM.
 */
import type {Content, ContentTable, ContentText, TableCell, TDocumentDefinitions} from 'pdfmake/interfaces';

import type {Guide} from './export';
import {type Block, type InlineLeaf, type InlineToken, inlineTokens, parseBlocks} from './markdown';
import {sourceCredit} from './types';
import {WIDGETS} from './widgets';

// A4 is 595 × 842 pt; the text column is what is left inside the margins.
const PAGE_WIDTH = 595;
const MARGIN_X = 56;
const COLUMN = PAGE_WIDTH - 2 * MARGIN_X;

const INK = '#1c2030';
const MUTED = '#5c6478';
const FAINT = '#8a92a6';
const ACCENT = '#5a44d6';
const RULE = '#d9dce6';
const PANEL = '#f4f5f9';
const CODE_PANEL = '#f0f1f6';
const SUCCESS = '#1f7a4d';

const MONO = 'JetBrainsMono';

/**
 * Glyphs the body font's subset lacks; they come from the code font instead. A combining hat goes
 * with the letter it sits on (`x̂`), or it would land on nothing.
 */
const SYMBOLS = /(\S\u0302|[→←↔⇒✓▸∩≲⊕⊗⌈⌉‖∅])/;

/** A prose run with its symbols set in the code font, which has them. */
const withSymbols = (run: ContentText & {text: string}): ContentText[] =>
  run.text
    .split(SYMBOLS)
    .filter(part => part !== '')
    .map(part => (SYMBOLS.test(part) ? {...run, text: part, font: MONO} : {...run, text: part}));

/** The runs inside bold, emphasis or a link: prose in `style`, code spans in the code font with it. */
const leafRuns = (parts: InlineLeaf[], style: Omit<ContentText, 'text'>): ContentText[] =>
  parts.flatMap(leaf =>
    leaf.kind === 'code'
      ? [{...style, text: leaf.text, font: MONO, fontSize: 9, color: ACCENT}]
      : withSymbols({...style, text: leaf.text}),
  );

/** Inline runs → pdfmake text runs. */
const runs = (text: string): ContentText[] =>
  inlineTokens(text).flatMap((token: InlineToken): ContentText[] => {
    switch (token.kind) {
      case 'bold':
        return leafRuns(token.parts, {bold: true});
      case 'em':
        return leafRuns(token.parts, {italics: true});
      case 'code':
        return [{text: token.text, font: MONO, fontSize: 9, color: ACCENT}];
      case 'link':
        return leafRuns(token.parts, {
          link: token.url,
          color: ACCENT,
          decoration: 'underline',
          ...(token.style === 'bold' ? {bold: true} : token.style === 'em' ? {italics: true} : {}),
        });
      case 'text':
        return withSymbols({text: token.text});
    }
  });

/** A one-cell box: a panel with a fill and no borders, or a callout with a bar down its left edge. */
const box = (body: Content[], kind: 'panel' | 'code' | 'callout'): ContentTable => ({
  table: {widths: ['*'], body: [[{stack: body, margin: [10, 8, 10, 8]}]]},
  layout: {
    hLineWidth: () => 0,
    vLineWidth: (i: number) => (kind === 'callout' && i === 0 ? 2 : 0),
    vLineColor: () => ACCENT,
    fillColor: () => (kind === 'code' ? CODE_PANEL : kind === 'panel' ? PANEL : null),
    paddingLeft: () => 0,
    paddingRight: () => 0,
    paddingTop: () => 0,
    paddingBottom: () => 0,
  },
  margin: [0, 2, 0, 10],
  unbreakable: true,
});

const LETTERS = 'ABCDEFGH';

/** A heading or title: plain text, with its symbols set in the code font when it has any. */
const plain = (text: string): string | ContentText[] => (SYMBOLS.test(text) ? withSymbols({text}) : text);

export type FigureBlock = Extract<Block, {kind: 'sequence' | 'diagram' | 'architecture' | 'gpu'}>;

/** A figure drawn for paper: standalone SVG markup and its size in CSS px. */
export interface FigureArt {
  svg: string;
  width: number;
  height: number;
}

/** The guide's figures in document order, `:::details` bodies included: the order `guideDocument` draws them in. */
export const figureBlocksOf = (blocks: readonly Block[]): FigureBlock[] =>
  blocks.flatMap((block): FigureBlock[] =>
    block.kind === 'details'
      ? figureBlocksOf(block.body)
      : block.kind === 'sequence' || block.kind === 'diagram' || block.kind === 'architecture' || block.kind === 'gpu'
      ? [block]
      : [],
  );

/** Tallest a figure is drawn, in points: a tall figure shrinks to keep a page's worth of room. */
const FIGURE_MAX_HEIGHT = 600;

/** A drawn figure, scaled to the text column (never above its own size), in a thin frame. */
const figureContent = (art: FigureArt): Content => {
  const scale = Math.min(1, COLUMN / art.width, FIGURE_MAX_HEIGHT / art.height);
  return {
    table: {
      widths: ['*'],
      body: [[{svg: art.svg, width: art.width * scale, alignment: 'center', margin: [0, 6, 0, 6]}]],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => RULE,
      vLineColor: () => RULE,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 2, 0, 10],
  };
};

const FIGURE_NAME: Record<FigureBlock['kind'], string> = {
  sequence: 'sequence diagram',
  diagram: 'system diagram',
  architecture: 'architecture figure',
  gpu: 'GPU figure',
};

/** One block of the dialect as pdfmake content; `null` for what the PDF leaves out. `figure` draws the next figure. */
const blockContent = (block: Block, figure: (block: FigureBlock) => FigureArt | null): Content | null => {
  switch (block.kind) {
    case 'heading':
      return block.level === 1
        ? {text: block.text, style: 'h1', tocItem: true, tocStyle: 'toc'}
        : block.level === 2
        ? {text: plain(block.text), style: 'h2'}
        : {text: plain(block.text), style: 'h3'};
    case 'paragraph':
      return {text: runs(block.text), style: 'body'};
    case 'quote':
      return box([{text: runs(block.text), style: 'body', italics: true, margin: [0, 0, 0, 0]}], 'callout');
    case 'list': {
      const items: Content[] = block.items.map(item => ({text: runs(item), style: 'body', margin: [0, 0, 0, 3]}));
      return block.ordered ? {ol: items, margin: [6, 0, 0, 8]} : {ul: items, margin: [6, 0, 0, 8]};
    }
    case 'code':
      return box([{text: block.code, font: MONO, fontSize: 8, lineHeight: 1.3, preserveLeadingSpaces: true}], 'code');
    case 'table': {
      const header: TableCell[] = block.header.map(h => ({text: runs(h), style: 'th'}));
      const rows: TableCell[][] = block.rows.map(row => row.map(cell => ({text: runs(cell), style: 'td'})));
      return {
        table: {headerRows: 1, widths: block.header.map(() => '*'), body: [header, ...rows]},
        layout: {
          hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.8 : 0.4),
          vLineWidth: () => 0,
          hLineColor: () => RULE,
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
        margin: [0, 2, 0, 10],
      };
    }
    case 'rule':
      return {
        canvas: [{type: 'line', x1: 0, y1: 0, x2: COLUMN, y2: 0, lineWidth: 0.5, lineColor: RULE}],
        margin: [0, 6, 0, 10],
      };
    case 'quiz': {
      const reasons = block.quiz.reasons
        .map((reason, i): Content | null =>
          reason === ''
            ? null
            : {
                text: [{text: `${LETTERS[i]}: `, bold: true, color: MUTED}, ...runs(reason)],
                style: 'body',
                margin: [0, 2, 0, 0],
              },
        )
        .filter((c): c is Content => c !== null);
      return box(
        [
          {text: 'POP QUIZ', style: 'label'},
          {text: runs(block.quiz.prompt), style: 'body', bold: true, margin: [0, 2, 0, 4]},
          {
            stack: block.quiz.options.map((option, i) => ({
              text: [{text: `${LETTERS[i]}  `, bold: true, color: MUTED}, ...runs(option)],
              style: 'body',
              margin: [0, 0, 0, 2],
            })),
          },
          {
            text: [
              {text: `Answer: ${LETTERS[block.quiz.answer]}. `, bold: true, color: SUCCESS},
              ...runs(block.quiz.explanation),
            ],
            style: 'body',
            margin: [0, 4, 0, 0],
          },
          ...reasons,
        ],
        'panel',
      );
    }
    case 'widget':
      return box(
        [
          {text: 'INTERACTIVE DEMO · ON THE PAGE', style: 'label'},
          {text: runs(WIDGETS[block.name]?.about ?? block.name), style: 'body', margin: [0, 2, 0, 0]},
        ],
        'panel',
      );
    case 'details':
      return {
        stack: [
          {text: plain(block.title), style: 'h3', margin: [0, 4, 0, 4]},
          ...block.body.map(b => blockContent(b, figure)).filter((c): c is Content => c !== null),
        ],
      };
    case 'sequence':
    case 'diagram':
    case 'architecture':
    case 'gpu': {
      const art = figure(block);
      return art !== null
        ? figureContent(art)
        : box(
            [
              {text: 'FIGURE · ON THE PAGE', style: 'label'},
              {
                text: `The ${FIGURE_NAME[block.kind]} could not be drawn here; see it on the page.`,
                style: 'body',
                margin: [0, 2, 0, 0],
              },
            ],
            'panel',
          );
    }
    case 'malformed':
      return {text: block.what, style: 'body', color: MUTED, italics: true};
  }
};

/**
 * The whole document. `figures` holds the drawn figures in `figureBlocksOf` order; a missing one
 * becomes a note pointing at the page.
 */
export function guideDocument(guide: Guide, figures: readonly (FigureArt | null)[] = []): TDocumentDefinitions {
  const blocks = parseBlocks(guide.learn);
  let next = 0;
  const figure = (): FigureArt | null => figures[next++] ?? null;
  const footerLabel = `${guide.title} — a LeetBuild learning guide`;
  return {
    pageSize: 'A4',
    pageMargins: [MARGIN_X, 64, MARGIN_X, 64],
    info: {title: `${guide.title}: the learning guide`, author: 'LeetBuild', subject: guide.tagline},
    defaultStyle: {font: 'Roboto', fontSize: 10, color: INK, lineHeight: 1.3},
    styles: {
      eyebrow: {fontSize: 9, bold: true, color: ACCENT, characterSpacing: 1},
      title: {fontSize: 26, bold: true, color: INK, lineHeight: 1.1, margin: [0, 6, 0, 8]},
      tagline: {fontSize: 11.5, color: MUTED, lineHeight: 1.35},
      contents: {fontSize: 13, bold: true, color: INK, margin: [0, 28, 0, 8]},
      toc: {fontSize: 10.5, color: INK, lineHeight: 1.5},
      h1: {fontSize: 16, bold: true, color: INK, lineHeight: 1.2, margin: [0, 16, 0, 8]},
      h2: {fontSize: 12.5, bold: true, color: INK, margin: [0, 10, 0, 5]},
      h3: {fontSize: 9.5, bold: true, color: MUTED, characterSpacing: 0.5, margin: [0, 8, 0, 4]},
      body: {fontSize: 10, lineHeight: 1.35, margin: [0, 0, 0, 7]},
      th: {fontSize: 8.5, bold: true, color: MUTED, characterSpacing: 0.3},
      td: {fontSize: 9, lineHeight: 1.3},
      label: {fontSize: 7.5, bold: true, color: ACCENT, characterSpacing: 1},
      source: {fontSize: 9.5, color: MUTED, margin: [0, 0, 0, 3]},
    },
    footer: (page: number, pages: number): Content => ({
      columns: [
        {text: footerLabel, fontSize: 8, color: FAINT},
        {text: `${page} / ${pages}`, fontSize: 8, color: FAINT, alignment: 'right'},
      ],
      margin: [MARGIN_X, 28, MARGIN_X, 0],
    }),
    content: [
      {text: 'LEETBUILD · LEARNING GUIDE', style: 'eyebrow'},
      {text: plain(guide.title), style: 'title'},
      {text: plain(guide.tagline), style: 'tagline'},
      {toc: {title: {text: 'Contents', style: 'contents'}, textMargin: [0, 1, 0, 1]}},
      {text: '', pageBreak: 'after'},
      ...blocks.map(b => blockContent(b, figure)).filter((c): c is Content => c !== null),
      ...(guide.sources.length === 0
        ? []
        : [
            {text: 'Sources', style: 'h1'},
            ...guide.sources.map((s): Content => {
              const credit = sourceCredit(s);
              return {
                text: [
                  {text: s.title, link: s.url, color: ACCENT, decoration: 'underline'},
                  {text: credit === '' ? '.' : ` · ${credit}.`},
                ],
                style: 'source',
              };
            }),
          ]),
    ],
  };
}
