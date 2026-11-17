import {type ReactElement, createElement} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';

import ArchitectureDiagram from '@/components/ArchitectureDiagram';
import GpuDiagram from '@/components/GpuDiagram';
import SequenceDiagram from '@/components/SequenceDiagram';
import SystemDiagram from '@/components/SystemDiagram';
import {cssVariables, day} from '@/styles/palette';

import type {Guide} from './export';
import {parseBlocks} from './markdown';
import {type FigureArt, type FigureBlock, figureBlocksOf, guideDocument} from './pdf';

/**
 * The PDF download of a learning guide: pdfmake and its fonts load only when someone asks for a
 * PDF, the figures are drawn by the page's own components in the Day palette and taken as SVG,
 * then the document built in lib/pdf.ts is handed to the browser's download.
 */

/** A font file from public/pdf as the base64 the virtual file system holds. */
const fontFile = async (file: string): Promise<string> => {
  const bytes = new Uint8Array(await (await fetch(`/pdf/${file}`)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(binary);
};

const NO_FOCUS: readonly string[] = [];

const figureElement = (block: FigureBlock): ReactElement => {
  switch (block.kind) {
    case 'sequence':
      return createElement(SequenceDiagram, {sequence: block.sequence});
    case 'diagram':
      return createElement(SystemDiagram, {compact: true, diagram: block.diagram, focus: NO_FOCUS});
    case 'architecture':
      return createElement(ArchitectureDiagram, {spec: block.architecture});
    case 'gpu':
      return createElement(GpuDiagram, {spec: block.gpu});
  }
};

/** What the figures style through CSS (classes, variables, inheritance), written out as attributes. */
const PAINT = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'marker-start',
  'marker-end',
] as const;

/** Glyphs the body font's subset lacks (lib/pdf.ts sets them in the code font too). */
const SYMBOLS = /[→←↔⇒✓▸∩≲⊕⊗⌈⌉‖∅]/;

/** The PDF's two fonts: code, and text with a symbol only the code font has, in the code font; the rest in the body font. */
const pdfFont = (family: string, text: string): string =>
  /mono|code/i.test(family) || SYMBOLS.test(text) ? 'JetBrainsMono' : 'Roboto';

/**
 * A drawn figure as standalone SVG the PDF can read: every element's computed paint and type as
 * plain attributes (`url("#m")` as `url(#m)`), no classes, titles or hidden parts, and a text
 * halo (`paint-order: stroke`, which the PDF's SVG reader ignores) as a copy drawn underneath.
 */
const standalone = (live: SVGSVGElement): FigureArt => {
  const box = live.viewBox.baseVal;
  const copy = live.cloneNode(true) as SVGSVGElement;
  const sources = [live, ...Array.from(live.querySelectorAll('*'))];
  const targets = [copy, ...Array.from(copy.querySelectorAll('*'))];
  const hidden: Element[] = [];
  const halos: Element[] = [];
  sources.forEach((source, i) => {
    const target = targets[i];
    const style = getComputedStyle(source);
    if (style.display === 'none' || style.visibility === 'hidden') {
      hidden.push(target);
      return;
    }
    for (const property of PAINT) {
      const value = style.getPropertyValue(property);
      if (value !== '') target.setAttribute(property, value.replace(/url\("([^"]*)"\)/g, 'url($1)'));
    }
    if (source instanceof SVGTextElement || source instanceof SVGTSpanElement)
      target.setAttribute('font-family', pdfFont(style.fontFamily, source.textContent ?? ''));
    if (source instanceof SVGTextElement && style.paintOrder.startsWith('stroke') && style.stroke !== 'none')
      halos.push(target);
    target.removeAttribute('class');
    target.removeAttribute('style');
    target.removeAttribute('filter');
  });
  for (const element of hidden) element.remove();
  for (const element of Array.from(copy.querySelectorAll('title, desc'))) element.remove();
  for (const text of halos) {
    const halo = text.cloneNode(true) as Element;
    halo.setAttribute('fill', 'none');
    for (const tspan of Array.from(halo.querySelectorAll('tspan'))) tspan.setAttribute('fill', 'none');
    text.removeAttribute('stroke');
    text.parentNode?.insertBefore(halo, text);
  }
  copy.setAttribute('width', String(box.width));
  copy.setAttribute('height', String(box.height));
  return {svg: new XMLSerializer().serializeToString(copy), width: box.width, height: box.height};
};

/** The figure's drawing: the largest `<svg>` the component renders (legend swatches are svgs too). */
const mainSvg = (root: HTMLElement): SVGSVGElement | null => {
  let best: SVGSVGElement | null = null;
  let bestArea = 0;
  for (const svg of Array.from(root.querySelectorAll('svg'))) {
    const {width, height} = svg.viewBox.baseVal;
    if (width * height > bestArea) {
      best = svg;
      bestArea = width * height;
    }
  }
  return best;
};

/** Draws every figure off-screen in the Day palette, the paper's; `null` for one that fails to draw. */
const drawFigures = (blocks: readonly FigureBlock[]): (FigureArt | null)[] => {
  if (blocks.length === 0) return [];
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {position: 'fixed', left: '-10000px', top: '0', width: '960px', pointerEvents: 'none'});
  for (const [name, value] of Object.entries(cssVariables(day))) host.style.setProperty(name, value);
  // The code font's variable lives on the page's wrapper, not on <body> where the figures are drawn.
  const page = document.querySelector('main') ?? document.body;
  host.style.setProperty('--font-code', getComputedStyle(page).getPropertyValue('--font-code'));
  document.body.appendChild(host);
  try {
    return blocks.map(block => {
      const mount = document.createElement('div');
      host.appendChild(mount);
      const root = createRoot(mount);
      try {
        flushSync(() => root.render(figureElement(block)));
        const svg = mainSvg(mount);
        return svg === null ? null : standalone(svg);
      } catch (error) {
        console.error(error);
        return null;
      } finally {
        root.unmount();
        mount.remove();
      }
    });
  } finally {
    host.remove();
  }
};

export async function downloadGuidePdf(guide: Guide, fileName: string): Promise<void> {
  const figures = drawFigures(figureBlocksOf(parseBlocks(guide.learn)));
  const [pdfMake, vfs, monoRegular, monoBold] = await Promise.all([
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
  void pdfMake.createPdf(guideDocument(guide, figures)).download(fileName);
}
