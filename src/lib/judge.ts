/**
 * The judge: runs a step's checks against the learner's code and returns a LeetCode-style verdict.
 *
 * Checks are static. Nothing is compiled or executed and no broker or server is contacted: each
 * check is a set of patterns that a correct implementation of the step necessarily contains (a
 * handler on the right route, a TTL on the SET, a commit after the processing call…). Comments are
 * blanked before matching so commented-out code and the starter's TODO notes never satisfy or
 * defeat a check; string literals are kept because routes, topics and keys live in them.
 */
import type {Language, Matcher, Step, StepCheck} from './types';

export interface CheckResult {
  id: string;
  title: string;
  detail: string;
  passed: boolean;
}

export interface Verdict {
  accepted: boolean;
  results: CheckResult[];
  passed: number;
  total: number;
}

/** Replaces every comment character (but not newlines) with a space so positions and lines survive. */
export function stripComments(code: string, language: Language): string {
  return language === 'python' ? stripPython(code) : stripCLike(code, language);
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

function stripPython(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '#') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = code.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (!triple && code[j] === '\n') break;
        j++;
      }
      out += code.slice(i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripCLike(code: string, language: Language): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && language === 'go')) {
      const triple = c === '"' && language === 'scala' && code.startsWith('"""', i);
      const quote = triple ? '"""' : c;
      const raw = c === '`';
      let j = i + quote.length;
      while (j < n) {
        if (!raw && !triple && code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (!raw && !triple && code[j] === '\n') break;
        j++;
      }
      out += code.slice(i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const firstMatchFrom = (pattern: RegExp, text: string, from: number): number => {
  // Patterns are shared module-level literals: never rely on their lastIndex.
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index + Math.max(m[0].length, 1);
};

/** True when the (comment-stripped) code satisfies the matcher. */
export function matches(matcher: Matcher, text: string): boolean {
  for (const pattern of matcher.all ?? []) if (firstMatchFrom(pattern, text, 0) === -1) return false;
  for (const pattern of matcher.none ?? []) if (firstMatchFrom(pattern, text, 0) !== -1) return false;
  if (matcher.order !== undefined) {
    // Each pattern must match somewhere after the previous pattern's match: "A, then B".
    let from = 0;
    for (const pattern of matcher.order) {
      const end = firstMatchFrom(pattern, text, from);
      if (end === -1) return false;
      from = end;
    }
  }
  return true;
}

export function runCheck(check: StepCheck, language: Language, stripped: string): CheckResult {
  return {id: check.id, title: check.title, detail: check.detail, passed: matches(check.match[language], stripped)};
}

export function judge(step: Step, language: Language, code: string): Verdict {
  const stripped = stripComments(code, language);
  const results = step.checks.map(check => runCheck(check, language, stripped));
  const passed = results.filter(r => r.passed).length;
  return {accepted: passed === results.length, results, passed, total: results.length};
}

// ---- explaining a check ----------------------------------------------------------------------------

/**
 * Renders a pattern's source the way a learner reads code: whitespace classes become a space,
 * escapes are dropped, unbounded wildcards become `…`. Not reversible; only for display.
 */
export function describePattern(pattern: RegExp): string {
  return pattern.source
    .replace(/\(\?:\(\?!\\n[^)]*\)\[\\s\\S\]\)\*\?/g, ' … ')
    .replace(/\[\\s\\S\]\{0,\d+\}\??/g, ' … ')
    .replace(/\[\^\\n\]\*/g, ' … ')
    .replace(/\[\^\)\]\*/g, '…')
    .replace(/\["'\]|\['"\]/g, '"')
    .replace(/\\s[*+]/g, ' ')
    .replace(/\\b/g, '')
    .replace(/\(\?:/g, '(')
    .replace(/\\([.()[\]{}$*+?|\\/-])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .replace(/ ,/g, ',')
    .trim();
}

export interface MatcherDescription {
  /** Fragments the code must contain. */
  contains: string[];
  /** Fragments that must appear in this order. */
  inOrder: string[];
  /** Fragments the code must not contain. */
  avoids: string[];
}

export function describeMatcher(matcher: Matcher): MatcherDescription {
  return {
    contains: (matcher.all ?? []).map(describePattern),
    inOrder: (matcher.order ?? []).map(describePattern),
    avoids: (matcher.none ?? []).map(describePattern),
  };
}
