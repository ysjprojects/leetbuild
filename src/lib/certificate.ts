/**
 * The certificate of completion as a PNG, drawn on a canvas (no server, no dependencies): the
 * learner's name, the course, its concepts, the date, the score, the timed-run time when there
 * is one, and the certificate id with its verification address. Always in the Night palette, so
 * the file is the same whatever theme the learner reads the site in.
 */
import {night} from '@/styles/palette';

import {type CertificateDetails, certificateId, ORGANIZATION} from './social';
import {CONCEPT_LABEL, LANGUAGE_LABEL} from './types';

/** A4 landscape at 2×: prints well, reads well in a feed. */
export const CERTIFICATE_SIZE = {width: 2338, height: 1654};

const SANS = '"Inter", "SF Pro Text", "Segoe UI", system-ui, -apple-system, sans-serif';
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

const formatDate = (at: number): string =>
  new Date(at).toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric'});

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${String(s).padStart(2, '0')} s`;
};

/** Shrink a font until `text` fits `maxWidth`; returns the font actually set. */
const fitText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: string,
  start: number,
  min: number,
  maxWidth: number,
): void => {
  let size = start;
  for (;;) {
    ctx.font = `${weight} ${size}px ${SANS}`;
    if (ctx.measureText(text).width <= maxWidth || size <= min) return;
    size -= 4;
  }
};

/** The rising-steps mark (public/leetbuild-logo.svg) at `size` px with its top-left corner at (x, y); brand colours, not themed. */
const drawMark = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void => {
  const scale = size / 512;
  const boxes: [number, number, string][] = [
    [51.1, 333.7, '#6c4cf1'],
    [192.4, 192.4, '#6c4cf1'],
    [192.4, 333.7, '#6c4cf1'],
    [333.7, 51.1, '#2dd4a0'],
    [333.7, 192.4, '#6c4cf1'],
    [333.7, 333.7, '#6c4cf1'],
  ];
  for (const [bx, by, fill] of boxes) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x + bx * scale, y + by * scale, 127.2 * scale, 127.2 * scale, 17.8 * scale);
    ctx.fill();
  }
};

export function drawCertificate(canvas: HTMLCanvasElement, details: CertificateDetails, verifyUrl: string): void {
  const {width: W, height: H} = CERTIFICATE_SIZE;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context unavailable');
  const {ink, iris, concept} = night;

  // Background, frame, a soft accent glow in one corner.
  ctx.fillStyle = ink[950];
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.86, H * 0.12, 0, W * 0.86, H * 0.12, W * 0.55);
  glow.addColorStop(0, 'rgba(148, 158, 251, 0.22)');
  glow.addColorStop(1, 'rgba(148, 158, 251, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = ink[700];
  ctx.lineWidth = 3;
  ctx.strokeRect(72, 72, W - 144, H - 144);
  ctx.strokeStyle = iris[400];
  ctx.lineWidth = 6;
  ctx.strokeRect(96, 96, W - 192, H - 192);

  // Concept stripe along the left edge: one band per concept of the course.
  const bandH = (H - 192) / details.problem.concepts.length;
  details.problem.concepts.forEach((c, i) => {
    ctx.fillStyle = concept[c];
    ctx.fillRect(96, 96 + i * bandH, 18, bandH);
  });

  const left = 220;
  const right = W - 220;
  const maxWidth = right - left;
  ctx.textBaseline = 'alphabetic';
  // Mark, wordmark and kicker.
  drawMark(ctx, left, 260 - 46, 52);
  const wordmarkLeft = left + 52 + 20;
  ctx.fillStyle = iris[300];
  ctx.font = `800 54px ${SANS}`;
  ctx.fillText(ORGANIZATION, wordmarkLeft, 260);
  const wordmarkWidth = ctx.measureText(ORGANIZATION).width;
  ctx.fillStyle = ink[300];
  ctx.font = `500 30px ${SANS}`;
  ctx.fillText('build systems step by step', wordmarkLeft + wordmarkWidth + 36, 260);

  ctx.fillStyle = ink[300];
  ctx.font = `600 34px ${SANS}`;
  ctx.letterSpacing = '8px';
  ctx.fillText('CERTIFICATE OF COMPLETION', left, 440);
  ctx.letterSpacing = '0px';

  // Name.
  ctx.fillStyle = ink[50];
  fitText(ctx, details.name, '800', 150, 72, maxWidth);
  ctx.fillText(details.name, left, 610);

  ctx.fillStyle = ink[200];
  ctx.font = `400 40px ${SANS}`;
  ctx.fillText('built, step by step and with every check passing,', left, 700);

  // Course.
  ctx.fillStyle = ink[50];
  fitText(ctx, details.problem.title, '800', 96, 56, maxWidth);
  ctx.fillText(details.problem.title, left, 820);

  ctx.fillStyle = ink[300];
  ctx.font = `400 36px ${SANS}`;
  const concepts = details.problem.concepts.map(c => CONCEPT_LABEL[c]).join(' · ');
  ctx.fillText(`${details.problem.steps} steps · ${concepts} · in ${LANGUAGE_LABEL[details.language]}`, left, 890);

  // Facts row.
  const facts: [string, string][] = [
    ['Completed', formatDate(details.completedAt)],
    ['Score', `${details.score} / ${details.max} pts`],
    ['Difficulty', details.problem.difficulty],
  ];
  if (details.time !== null) facts.push(['Timed run', formatTime(details.time)]);
  const colW = Math.min(480, maxWidth / facts.length);
  facts.forEach(([label, value], i) => {
    const x = left + i * colW;
    ctx.fillStyle = ink[400];
    ctx.font = `600 26px ${SANS}`;
    ctx.letterSpacing = '4px';
    ctx.fillText(label.toUpperCase(), x, 1090);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = ink[50];
    ctx.font = `700 44px ${SANS}`;
    ctx.fillText(value, x, 1150);
  });

  // Footer: id and verification address.
  ctx.fillStyle = ink[700];
  ctx.fillRect(left, 1340, maxWidth, 2);
  ctx.fillStyle = ink[400];
  ctx.font = `500 26px ${MONO}`;
  ctx.fillText(`Certificate ${certificateId(details)}`, left, 1410);
  ctx.fillStyle = ink[300];
  ctx.font = `400 26px ${MONO}`;
  const url = verifyUrl.replace(/^https?:\/\//, '');
  let shown = url;
  while (ctx.measureText(shown).width > maxWidth && shown.length > 20) shown = `${shown.slice(0, -4)}…`;
  ctx.fillText(shown, left, 1460);
  ctx.fillStyle = ink[400];
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText(
    'Every step was judged by running the code against in-browser Redis, Kafka, gRPC and Postgres.',
    left,
    1520,
  );
}

/** Render the certificate and hand back the PNG. */
export function certificatePng(details: CertificateDetails, verifyUrl: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  drawCertificate(canvas, details, verifyUrl);
  const {promise, resolve, reject} = Promise.withResolvers<Blob>();
  canvas.toBlob(
    blob => (blob === null ? reject(new Error('could not encode the certificate')) : resolve(blob)),
    'image/png',
  );
  return promise;
}

export function certificateFileName(details: CertificateDetails): string {
  return `leetbuild-certificate-${details.problem.id}.png`;
}

export async function downloadCertificate(details: CertificateDetails, verifyUrl: string): Promise<void> {
  const blob = await certificatePng(details, verifyUrl);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = certificateFileName(details);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
