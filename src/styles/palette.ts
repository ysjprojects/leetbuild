/**
 * LeetBuild Night and Day — the one place colours are defined.
 *
 * Two palettes of one shape. Each becomes a set of CSS custom properties (`--ink-850: 25 29 44`,
 * space-separated sRGB) on `:root` — Night by default, Day under `:root[data-theme="light"]` —
 * emitted by tailwind.config.ts. Everything else refers to the variables, so the theme switches
 * live without a re-render: Tailwind classes (`bg-ink-850`, `text-iris-300`, `border-concept-http/50`)
 * come from `colors`; the CodeMirror theme reads them with `theme()` in globals.scss; SVG widgets
 * and the diagrams use `ink[200]`, `alpha(iris[400], 0.3)` and friends, which are `rgb(var(--…))`
 * strings. Only canvas (`resolve`) and the Markdown export (`night`, literal hex for Mermaid) need
 * concrete values.
 *
 * Night, after a survey of the most-installed dark themes (GitHub Dark, One Dark, Dracula,
 * Tokyo Night, Catppuccin) and Material's dark-theme guidance:
 * - Surfaces are a near-neutral slate (OKLCH hue 272°, chroma ≤ 0.034): dark grey, not pure
 *   black and not a saturated colour, so text and accents do not fight the background.
 * - Elevation is lighter, not darker: page 900 → panels 850 → raised controls 800.
 * - Text has three tiers; every tier used for body copy passes WCAG AA on the darkest surface it
 *   sits on (ink-200 ≥ 9:1, ink-300 ≥ 7:1, ink-400 ≥ 5.5:1 on ink-850). ink-500 is only for
 *   disabled controls.
 * - Status is colour-coded the way every mainstream theme does it: green ok, yellow warning,
 *   red failure; the brand accent is a periwinkle blue (iris) that never doubles as a status.
 * - Syntax tokens span distinct hues (violet keyword, green string, orange number, yellow type,
 *   blue function, cyan property) instead of one pink family, so code structure is legible.
 *
 * Day is Night mirrored, not a separate design. Every colour keeps its Night hue (OKLCH) with a
 * little more chroma, and its lightness was solved numerically for the same contrast targets on
 * the white panel: text tiers 12 / 9.5 / 7 / 5.8:1, accent 400s 5:1 (so they carry white text and
 * stand as labels), 300s 6.2:1 (links, hover fills), 200s 8:1 (text on a 10 % tint), concept hues
 * 5.6:1 (≥ 4.8:1 on their own chip tint), syntax tokens 5.2:1. The ink scale keeps its roles, so
 * `text-ink-950` on an accent fill is near-black on a pastel at night and white on a deep tone by
 * day; the one deliberate departure from a strict lightness mirror is that white panels sit on a
 * cool grey page (cards on a canvas) and raised controls are the slightly darker tone, since
 * nothing is lighter than white.
 */

/** Neutral slate: 950 inset → 900 page → 850 panel → 800 raised → 700/600 borders → 500 disabled → 400…50 text. */
const nightInk = {
  50: '#f0f2f7',
  100: '#dee1ea',
  200: '#c6cad7',
  300: '#a5aaba',
  400: '#8f95a6',
  500: '#656b7f',
  600: '#464c60',
  700: '#32374a',
  800: '#232839',
  850: '#191d2c',
  900: '#121523',
  950: '#0a0e1a',
};

/** One hue per course concept; also the edge and node colours of the architecture diagrams. */
const nightConcept = {http: '#85b1ff', grpc: '#c9a3f5', kafka: '#f99f5d', redis: '#f77d84'};

export const night = {
  ink: nightInk,
  /** Brand / interactive accent (periwinkle): 400 fills and labels, 300 links and hover fills, 200 text on tinted bg. */
  iris: {200: '#ced4ff', 300: '#b1bbff', 400: '#949efb'},
  success: {200: '#ade9b8', 300: '#7fd994', 400: '#5ac576'},
  warning: {200: '#fada99', 300: '#f1c45e', 400: '#e3ae28'},
  danger: {200: '#fcbfc2', 300: '#fa969f', 400: '#f47281'},
  concept: nightConcept,
  /** Diagram node kinds: the four concepts plus the parts a learner never builds. */
  node: {...nightConcept, client: '#75dac4', db: '#7fd2ee', service: nightInk[200], external: nightInk[400]},
  /** Editor and static-code token colours (classHighlighter `tok-*` classes). */
  syntax: {
    comment: nightInk[400],
    keyword: nightConcept.grpc,
    string: '#91d993',
    number: '#fea668',
    type: '#edce79',
    function: '#8db7ff',
    property: '#87d7f7',
    meta: '#f1b6d6',
    operator: nightInk[300],
    variable: nightInk[100],
    invalid: '#f47281',
  },
};

export type Palette = typeof night;

/** Same roles as nightInk: 950 is white (the lightest surface, and the text on accent fills), 900 the grey page, 850 white panels. */
const dayInk = {
  50: '#222636',
  100: '#313647',
  200: '#404557',
  300: '#53586a',
  400: '#5f6577',
  500: '#8e94a8',
  600: '#b9bdcb',
  700: '#d5d9e4',
  800: '#e3e6f0',
  850: '#ffffff',
  900: '#edf0f8',
  950: '#ffffff',
};

const dayConcept = {http: '#3364bf', grpc: '#8151b1', kafka: '#a25200', redis: '#bf3045'};

export const day: Palette = {
  ink: dayInk,
  iris: {200: '#4442ac', 300: '#5254bf', 400: '#5f63d1'},
  success: {200: '#005d27', 300: '#007031', 400: '#008139'},
  warning: {200: '#684c00', 300: '#7c5b00', 400: '#8e6900'},
  danger: {200: '#a30035', 300: '#bb1d43', 400: '#cd3351'},
  concept: dayConcept,
  node: {...dayConcept, client: '#007e6b', db: '#007996', service: dayInk[200], external: dayInk[400]},
  syntax: {
    comment: dayInk[400],
    keyword: dayConcept.grpc,
    string: '#197d28',
    number: '#a95600',
    type: '#866900',
    function: '#3a6bbf',
    property: '#007697',
    meta: '#9d547f',
    operator: dayInk[300],
    variable: dayInk[100],
    invalid: '#cd3351',
  },
};

export type Theme = 'dark' | 'light';

export const PALETTE: Record<Theme, Palette> = {dark: night, light: day};

const channels = (hex: string): string => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ');

/** `{'--ink-850': '25 29 44', …}` for one palette; space-separated so `rgb(var(--ink-850) / 0.5)` works. */
export function cssVariables(palette: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, shades] of Object.entries(palette as Record<string, Record<string, string>>)) {
    for (const [shade, hex] of Object.entries(shades)) out[`--${group}-${shade}`] = channels(hex);
  }
  return out;
}

const refs = <G extends Record<string, string>>(
  group: string,
  shape: G,
  wrap: (channels: string) => string,
): Record<keyof G, string> =>
  Object.fromEntries(Object.keys(shape).map(shade => [shade, wrap(`var(--${group}-${shade})`)])) as Record<
    keyof G,
    string
  >;

const css = (c: string): string => `rgb(${c})`;
const tailwind = (c: string): string => `rgb(${c} / <alpha-value>)`;

// Live references: `rgb(var(--ink-200))`, resolved by the browser against the theme on <html>.
export const ink = refs('ink', night.ink, css);
export const iris = refs('iris', night.iris, css);
export const success = refs('success', night.success, css);
export const warning = refs('warning', night.warning, css);
export const danger = refs('danger', night.danger, css);
export const concept = refs('concept', night.concept, css);
export const node = refs('node', night.node, css);
export const syntax = refs('syntax', night.syntax, css);

/** Distinct hues for categorical series (partition keys, consumers, confetti). */
export const categorical = [
  iris[400],
  concept.kafka,
  success[400],
  concept.http,
  concept.grpc,
  danger[400],
  node.client,
  warning[300],
] as const;

/** A reference with opacity: `rgb(var(--x))` → `rgb(var(--x) / a)`; call once at module level, not per render. */
export const alpha = (color: string, a: number): string => `${color.slice(0, -1)} / ${a})`;

/** A reference made concrete (`rgb(r g b)`) from the root element's current variables, for canvas, which CSS variables cannot reach. */
export function resolve(color: string): string {
  const style = getComputedStyle(document.documentElement);
  return color.replace(/var\((--[\w-]+)\)/, (_, name: string) => style.getPropertyValue(name));
}

/** Everything Tailwind should know about; `theme.extend.colors` in tailwind.config.ts. */
export const colors = {
  ink: refs('ink', night.ink, tailwind),
  iris: refs('iris', night.iris, tailwind),
  success: refs('success', night.success, tailwind),
  warning: refs('warning', night.warning, tailwind),
  danger: refs('danger', night.danger, tailwind),
  concept: refs('concept', night.concept, tailwind),
  syntax: refs('syntax', night.syntax, tailwind),
};
