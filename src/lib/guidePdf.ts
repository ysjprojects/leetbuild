import type {Guide} from './export';
import {guideDocument} from './pdf';

/**
 * The PDF download of a learning guide: pdfmake and its fonts load only when someone asks for a
 * PDF, then the document built in lib/pdf.ts is handed to the browser's download.
 */

/** A font file from public/pdf as the base64 the virtual file system holds. */
const fontFile = async (file: string): Promise<string> => {
  const bytes = new Uint8Array(await (await fetch(`/pdf/${file}`)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(binary);
};

export async function downloadGuidePdf(guide: Guide, fileName: string): Promise<void> {
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
  void pdfMake.createPdf(guideDocument(guide)).download(fileName);
}
