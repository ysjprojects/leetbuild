import {renderToStaticMarkup} from 'react-dom/server';

import type {Guide} from '@/lib/export';
import {layoutDiagram} from '@/lib/layout';
import {type Block, parseBlocks} from '@/lib/markdown';
import {type FigureImage, type Figures, guideDocument, MAX_PANEL_PX, RASTER_SCALE} from '@/lib/pdf';
import type {Diagram} from '@/lib/types';
import {cssVariables, day} from '@/styles/palette';

import SequenceDiagram from './SequenceDiagram';
import SystemDiagram from './SystemDiagram';

/**
 * The PDF download of a learning guide. The figures are the page's own SVG components drawn in
 * the Day palette and rasterized by the browser at 3× (markers, filters and fonts come out exactly
 * as on screen, which the PDF's SVG importer cannot promise). An architecture diagram too wide for
 * the page is cut at column boundaries into panels that stack down the page, each legible at its
 * own width, like a map continued across pages. pdfmake and its fonts load only when asked for.
 */

const DAY = cssVariables(day);
const NO_FOCUS: readonly string[] = [];

interface Panel {
  svg: string;
  width: number;
  height: number;
}

/**
 * The component's `<svg>` as standalone documents, one per panel: palette variables made concrete,
 * fonts named, the viewBox narrowed to the panel's slice of the drawing and the size fixed.
 */
const panels = (markup: string, cuts: number[]): Panel[] => {
  const found = /<svg[\s\S]*?<\/svg>/.exec(markup);
  const viewBox = found === null ? null : /viewBox="([-\d. ]+)"/.exec(found[0]);
  if (found === null || viewBox === null) return [];
  const [x0, y0, w, h] = viewBox[1].split(/\s+/).map(Number);
  const body = found[0]
    .replace(/rgb\(var\((--[\w-]+)\)(?: \/ ([\d.]+))?\)/g, (_, name: string, a?: string) =>
      a === undefined ? `rgb(${DAY[name]})` : `rgb(${DAY[name]} / ${a})`,
    )
    .replace(/var\(--font-code\), monospace/g, 'Menlo, Consolas, monospace');
  const edges = [x0, ...cuts, x0 + w];
  return edges.slice(1).map((right, i) => {
    const left = edges[i];
    const width = right - left;
    const svg = body.replace(/^<svg[^>]*>/, tag => {
      const bare = tag
        .replace(/ class="[^"]*"/, '')
        .replace(/ style="[^"]*"/, '')
        .replace(/ viewBox="[^"]*"/, '')
        .replace(/>$/, '');
      const attributes = [
        'xmlns="http://www.w3.org/2000/svg"',
        `viewBox="${left} ${y0} ${width} ${h}"`,
        `width="${width}"`,
        `height="${h}"`,
        'font-family="Helvetica Neue, Helvetica, Arial, sans-serif"',
      ];
      return `${bare} ${attributes.join(' ')}>`;
    });
    return {svg, width, height: h};
  });
};

/**
 * Where to cut a diagram wider than a panel: just past a column's boxes, as far along as a panel
 * allows, so every panel holds whole nodes and the edges that cross a cut simply continue below.
 */
const cutsOf = (diagram: Diagram): number[] => {
  const layout = layoutDiagram(diagram);
  if (layout.width <= MAX_PANEL_PX) return [];
  const layers = Math.max(...layout.nodes.map(n => n.layer)) + 1;
  const candidates: number[] = [];
  for (let c = 0; c < layers - 1; c++)
    candidates.push(Math.max(...layout.nodes.filter(n => n.layer === c).map(n => n.cx + n.w / 2)) + 6);
  const cuts: number[] = [];
  let start = 0;
  while (layout.width - start > MAX_PANEL_PX) {
    const fits = candidates.filter(x => x > start && x - start <= MAX_PANEL_PX);
    const next = fits.length > 0 ? fits[fits.length - 1] : candidates.find(x => x > start);
    if (next === undefined) break;
    cuts.push(next);
    start = next;
  }
  return cuts;
};

const rasterize = ({svg, width, height}: Panel): Promise<FigureImage> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * RASTER_SCALE);
      canvas.height = Math.round(height * RASTER_SCALE);
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        reject(new Error('no canvas'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height});
    };
    img.onerror = () => reject(new Error('the figure did not render'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

const panelsOf = (block: Block): Panel[] => {
  if (block.kind === 'sequence') return panels(renderToStaticMarkup(<SequenceDiagram sequence={block.sequence} />), []);
  if (block.kind === 'diagram')
    return panels(
      renderToStaticMarkup(<SystemDiagram compact diagram={block.diagram} focus={NO_FOCUS} />),
      cutsOf(block.diagram),
    );
  return [];
};

/** Every figure in the guide, rasterized panel by panel; `:::details` bodies included. */
async function figuresOf(blocks: Block[]): Promise<Figures> {
  const out: Figures = new Map();
  for (const block of blocks) {
    if (block.kind === 'details') for (const [b, images] of await figuresOf(block.body)) out.set(b, images);
    const slices = panelsOf(block);
    if (slices.length > 0) out.set(block, await Promise.all(slices.map(rasterize)));
  }
  return out;
}

/** A font file from public/pdf as the base64 the virtual file system holds. */
const fontFile = async (file: string): Promise<string> => {
  const bytes = new Uint8Array(await (await fetch(`/pdf/${file}`)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(binary);
};

/** Build the guide's PDF in the browser and hand it to the download. */
export async function downloadGuidePdf(guide: Guide, guideUrl: string, fileName: string): Promise<void> {
  const blocks = parseBlocks(guide.learn);
  const [figures, pdfMake, vfs, monoRegular, monoBold] = await Promise.all([
    figuresOf(blocks),
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    fontFile('JetBrainsMono-Regular.ttf'),
    fontFile('JetBrainsMono-Bold.ttf'),
  ]);
  pdfMake.addVirtualFileSystem({
    ...vfs.default,
    'JetBrainsMono-Regular.ttf': monoRegular,
    'JetBrainsMono-Bold.ttf': monoBold,
  });
  pdfMake.setFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
    // The site's code font (public/pdf, OFL): code, and the arrows Roboto's subset lacks.
    JetBrainsMono: {
      normal: 'JetBrainsMono-Regular.ttf',
      bold: 'JetBrainsMono-Bold.ttf',
      italics: 'JetBrainsMono-Regular.ttf',
      bolditalics: 'JetBrainsMono-Bold.ttf',
    },
  });
  void pdfMake.createPdf(guideDocument(guide, blocks, figures, guideUrl)).download(fileName);
}
