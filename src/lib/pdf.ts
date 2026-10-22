/**
 * The learning guide as a PDF of its own: an A4 document laid out for paper — title page with a
 * table of contents, sections with running footers, figures as images at page width, code and
 * callouts in boxes, pop quizzes with the answer printed — built from the same parsed dialect the
 * page draws (lib/markdown.ts). Pure: the figures arrive as images; nothing here touches the DOM.
 */
import type {Content, ContentTable, ContentText, TableCell, TDocumentDefinitions} from 'pdfmake/interfaces';

import type {Guide} from './export';
import {type Block, type InlineToken, inlineTokens} from './markdown';
import {WIDGETS} from './widgets';

/** One panel of a figure (`:::sequence` / `:::diagram`) rasterized by the browser: a PNG data URL and its pixel size. */
export interface FigureImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** A figure's panels, top to bottom — one for most figures, several for a diagram cut to fit the column. */
export type Figures = Map<Block, FigureImage[]>;

// A4 is 595 × 842 pt; the text column is what is left inside the margins.
const PAGE_WIDTH = 595;
const MARGIN_X = 56;
const COLUMN = PAGE_WIDTH - 2 * MARGIN_X;
/** The rasterizer's pixels per CSS pixel of the drawing. */
export const RASTER_SCALE = 3;
/** The widest slice of a diagram (in its own pixels) that stays legible when fitted to the column. */
export const MAX_PANEL_PX = Math.round(COLUMN / 0.75);

const INK = '#1c2030';
const MUTED = '#5c6478';
const FAINT = '#8a92a6';
const ACCENT = '#5a44d6';
const RULE = '#d9dce6';
const PANEL = '#f4f5f9';
const CODE_PANEL = '#f0f1f6';
const SUCCESS = '#1f7a4d';

const MONO = 'JetBrainsMono';

/** Glyphs the body font's subset lacks; they come from the code font instead. */
const SYMBOLS = /([→←↔⇒✓▸])/;

/** A prose run with its symbols set in the code font, which has them. */
const withSymbols = (run: ContentText & {text: string}): ContentText[] =>
  run.text
    .split(SYMBOLS)
    .filter(part => part !== '')
    .map(part => (SYMBOLS.test(part) ? {...run, text: part, font: MONO} : {...run, text: part}));

/** Inline runs → pdfmake text runs. */
const runs = (text: string): ContentText[] =>
  inlineTokens(text).flatMap((token: InlineToken): ContentText[] => {
    switch (token.kind) {
      case 'bold':
        return withSymbols({text: token.text, bold: true});
      case 'em':
        return withSymbols({text: token.text, italics: true});
      case 'code':
        return [{text: token.text, font: MONO, fontSize: 9, color: ACCENT}];
      case 'link':
        return withSymbols({text: token.text, link: token.url, color: ACCENT, decoration: 'underline'});
      case 'text':
        return withSymbols({text: token.text});
    }
  });

/** A one-cell box: a panel with a fill and no borders, or a callout with a bar down its left edge. */
const box = (body: Content[], kind: 'panel' | 'code' | 'callout' | 'figure'): ContentTable => ({
  table: {widths: ['*'], body: [[{stack: body, margin: kind === 'figure' ? [4, 4, 4, 4] : [10, 8, 10, 8]}]]},
  layout: {
    hLineWidth: () => (kind === 'figure' ? 0.5 : 0),
    vLineWidth: (i: number) => (kind === 'callout' ? (i === 0 ? 2 : 0) : kind === 'figure' ? 0.5 : 0),
    hLineColor: () => RULE,
    vLineColor: () => (kind === 'callout' ? ACCENT : RULE),
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

const blockContent = (block: Block, figures: Figures, guideUrl: string): Content => {
  switch (block.kind) {
    case 'heading':
      return block.level === 1
        ? {text: block.text, style: 'h1', tocItem: true, tocStyle: 'toc'}
        : block.level === 2
        ? {text: block.text, style: 'h2'}
        : {text: block.text, style: 'h3'};
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
    case 'quiz':
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
        ],
        'panel',
      );
    case 'widget':
      return box(
        [
          {text: 'INTERACTIVE DEMO', style: 'label'},
          {
            text: [
              {text: `${WIDGETS[block.name]?.about ?? block.name} `},
              {text: 'Open the guide at ', color: MUTED},
              {text: guideUrl, link: guideUrl, color: ACCENT, decoration: 'underline'},
              {text: ' to use it.', color: MUTED},
            ],
            style: 'body',
            margin: [0, 2, 0, 0],
          },
        ],
        'panel',
      );
    case 'details':
      return {
        stack: [
          {text: block.title, style: 'h3', margin: [0, 4, 0, 4]},
          ...block.body.map(b => blockContent(b, figures, guideUrl)),
        ],
      };
    case 'sequence':
    case 'diagram': {
      const images = figures.get(block);
      if (images === undefined) return {text: ''};
      // Each panel at the column's width — but never blown up past its own drawing size.
      return box(
        images.map(image => ({
          image: image.dataUrl,
          width: Math.min(COLUMN - 8, image.width / RASTER_SCALE),
          alignment: 'center',
          margin: [0, 2, 0, 2],
        })),
        'figure',
      );
    }
    case 'malformed':
      return {text: block.what, style: 'body', color: MUTED, italics: true};
  }
};

/** The whole document from the guide's parsed blocks (the figures are keyed by them); `guideUrl` is where the interactive version lives. */
export function guideDocument(guide: Guide, blocks: Block[], figures: Figures, guideUrl: string): TDocumentDefinitions {
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
      {text: guide.title, style: 'title'},
      {text: guide.tagline, style: 'tagline'},
      {toc: {title: {text: 'Contents', style: 'contents'}, textMargin: [0, 1, 0, 1]}},
      {text: '', pageBreak: 'after'},
      ...blocks.map(block => blockContent(block, figures, guideUrl)),
      ...(guide.sources.length === 0
        ? []
        : [
            {text: 'Sources', style: 'h1'},
            ...guide.sources.map(
              (s): Content => ({
                text: [
                  {text: s.title, link: s.url, color: ACCENT, decoration: 'underline'},
                  {text: `${s.by !== undefined ? ` — ${s.by}` : ''}, ${s.date}. ${s.url}`},
                ],
                style: 'source',
              }),
            ),
          ]),
    ],
  };
}
