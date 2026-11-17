/**
 * What a run's outcome says, read for display: whether the learner's code ran at all (a compile,
 * syntax or import failure every check hit), and a check's message laid out so what it expected
 * leads and long values (a response body, a stored record) fold under it. Nothing here depends on a
 * course: it reads the shapes the runtimes and harnesses produce.
 */

/** The failure that stopped the learner's code before any check ran it, and where it points. */
export interface CompileFailure {
  message: string;
  file?: string;
  line?: number;
}

/** Said by a runtime when the code, the harness against it, or an import did not get as far as running. */
const COMPILE =
  /^(?:your code does not compile|the harness does not compile|the harness failed to load|the course's \.proto files|(?:ImportError|ModuleNotFoundError)\b|Error: Cannot find module)/;

/**
 * A syntax error raised compiling the learner's file: TypeScript's `SyntaxError: api.ts:5:28: …` or
 * Python's `SyntaxError: invalid syntax — api.py:12`. Not one raised by running code (`JSON.parse`,
 * `… — api.ts:21 in handler`), which names the function it came from.
 */
const SYNTAX = /^(?:SyntaxError|IndentationError|TabError): (?:[\w./-]+:\d+:\d+: |[^\n]* — [\w./-]+:\d+$)/;

/** Python: raised while the learner's module was being imported, so no check got to call it. */
const IMPORT = / — [\w./-]+\.py:\d+ in <module>$/;

const unreached = (message: string): boolean => COMPILE.test(message) || SYNTAX.test(message) || IMPORT.test(message);

/** Clang points an error in a header back at the learner's line: `(from token_bucket.cpp:12:3)`. */
const FROM = /\(from ([\w./-]+):(\d+)(?::\d+)?\)/;

/** `api.py:12`, `api.ts:5:28`, `server.go:12:5`, `token_bucket.cpp:12:3`: a file of the learner's and a line. */
const PLACE = /(?:^|[\s(:'"])((?:[\w-]+\/)*[\w-][\w.-]*\.(?:py|ts|tsx|js|mjs|go|cpp|cc|cxx|h|hpp)):(\d+)\b/g;

/** The files a learner never sees: the harness and the generated translation unit. */
const NOT_THEIRS = /(?:^|\/)(?:harness(?:_test)?\.\w+|main\.cpp)$/;

const locate = (message: string): Pick<CompileFailure, 'file' | 'line'> => {
  const from = FROM.exec(message);
  if (from !== null && !NOT_THEIRS.test(from[1])) return {file: from[1], line: Number(from[2])};
  for (const m of message.matchAll(PLACE)) {
    if (!NOT_THEIRS.test(m[1])) return {file: m[1], line: Number(m[2])};
  }
  return {};
};

/**
 * The shared failure when the learner's code never got to run: a run error saying the code did not
 * compile or import, or a compile, syntax or import error every check hit. Null when any check
 * passed or failed on its own logic.
 */
export function compileFailure(
  checks: readonly {passed: boolean; message?: string}[],
  error?: string,
): CompileFailure | null {
  if (error !== undefined) return unreached(error) ? {message: error, ...locate(error)} : null;
  if (checks.length === 0) return null;
  const message = checks[0].message;
  if (message === undefined || !unreached(message)) return null;
  if (!checks.every(c => !c.passed && c.message !== undefined && unreached(c.message))) return null;
  return {message, ...locate(message)};
}

// ---- a check's message, laid out --------------------------------------------------------------------

/** A run of a message's text, or a long value in it, folded behind a toggle that names it. */
export type MessagePart = {text: string} | {value: string; label: string};

/** A message laid out: the expectation first when it has one, then what was observed, then where. */
export interface MessageLayout {
  /** `expected …`: what the check wanted, when the message says it after what it saw. */
  expected: MessagePart[] | null;
  /** What the check observed (the whole message when it states no expectation). */
  observed: MessagePart[];
  /** ` — file.py:12 in fn`: where it was raised, when the message ends with it. */
  where: string | null;
}

/** A value shorter than this reads fine inline. */
const FOLD_CHARS = 48;

const CLOSE: Record<string, string> = {'{': '}', '[': ']'};

/** The end (exclusive) of the bracketed value opening at `start`, quotes respected; -1 when it does not close. */
const valueEnd = (text: string, start: number): number => {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') stack.push(CLOSE[c]);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
};

/**
 * The message's text, its long JSON or repr values (`{…}`, `[…]`) split out to fold, each named by the
 * words before it: a body the code answered, or a value it held.
 */
const foldValues = (text: string): MessagePart[] => {
  const parts: MessagePart[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{' || c === '[') {
      const end = valueEnd(text, i);
      if (end > 0 && end - i >= FOLD_CHARS) {
        if (i > from) parts.push({text: text.slice(from, i)});
        const answered = /\b(?:answered|returned|responded|replied|response|body)\b[^,;.]*$/i.test(text.slice(0, i));
        parts.push({value: text.slice(i, end), label: answered ? 'response' : 'value'});
        from = i = end;
        continue;
      }
      // A short or unclosed bracket stays text; a closed one is skipped whole, so nothing inside it splits.
      if (end > 0) {
        i = end;
        continue;
      }
    }
    i++;
  }
  if (from < text.length) parts.push({text: text.slice(from)});
  return parts;
};

/** `, expected …` outside any value: where the observation ends and the expectation starts. */
const EXPECTED = /,\s+(?=expected\b)/;

/** ` — api.py:12 in fn` or ` — raised inside the check …`: the runtime's note on where it was raised. */
const WHERE = / — (?:[\w./-]+:\d+|raised inside the check)/;

/** Split `parts` at the first match of `pattern` inside a text part: before, the separator dropped, after. */
const splitAt = (parts: MessagePart[], pattern: RegExp): [MessagePart[], string, MessagePart[]] | null => {
  for (const [k, part] of parts.entries()) {
    if (!('text' in part)) continue;
    const m = pattern.exec(part.text);
    if (m === null) continue;
    const head = part.text.slice(0, m.index);
    const tail = part.text.slice(m.index + m[0].length);
    return [
      [...parts.slice(0, k), ...(head === '' ? [] : [{text: head}])],
      m[0],
      [...(tail === '' ? [] : [{text: tail}]), ...parts.slice(k + 1)],
    ];
  }
  return null;
};

/**
 * A check's message laid out to read: `a zero-length range answered 201 {…}, expected 400 invalid_range`
 * becomes `expected 400 invalid_range` over `a zero-length range answered 201` with the body folded.
 * Only the order changes; every character of the message is still shown.
 */
export function layoutMessage(message: string): MessageLayout {
  let parts = foldValues(message);
  let where: string | null = null;
  const at = splitAt(parts, WHERE);
  if (at !== null && at[2].every(p => 'text' in p)) {
    parts = at[0];
    where = at[1] + at[2].map(p => ('text' in p ? p.text : '')).join('');
  }
  const split = splitAt(parts, EXPECTED);
  if (split === null || split[0].length === 0) return {expected: null, observed: parts, where};
  return {expected: split[2], observed: split[0], where};
}
