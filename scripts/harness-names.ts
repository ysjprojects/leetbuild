/**
 * The harness prefix rule: a Go harness is a file of the learner's package and a C++ harness is compiled
 * after the learner's file in one translation unit, so every top-level name either declares would collide
 * with a learner's fix that declares the same name. Such a name carries a harness prefix (`hName`,
 * `HName`, `kHName`, or `harness…`), unless it is a `Check<Id>` function, `main`, `init`, `_`, C++'s
 * `using json = nlohmann::json;`, or a contract stand-in: a name the step's own starter or solution uses
 * without declaring it at top level (another step's function, a provided store), or, in C++, a name one
 * of the course's support headers declares without defining (the harness defines what the header the
 * learner's file includes promises). Usage over-approximates (a local of the same name exempts too): the
 * rule may miss a collision, never block a legitimate stand-in.
 *
 * The scanners below are lexical, not compilers: they find the names declared at file (namespace) scope
 * and the identifier tokens code uses, skipping comments, strings and member names.
 */
import {type Language, type Problem} from '../src/lib/types';

/** `Check<Id>`, the Go and C++ harness function for a check: `release-atomic` → `CheckReleaseAtomic` (goruntime/host). */
export const goCheckName = (id: string): string =>
  `Check${id
    .split(/[-_ ]/)
    .filter(part => part !== '')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')}`;

type Kind = 'id' | 'op' | 'str' | 'num' | 'pp' | 'nl';
interface Token {
  kind: Kind;
  text: string;
}

/**
 * One Go token per match: a newline (1), a block comment (2, a newline if it spans lines), a string or
 * rune (3), an identifier (4), a number (5), any other character (6). Spaces and line comments match none.
 */
const GO_TOKEN =
  /(\n)|[^\S\n]+|\/\/[^\n]*|(\/\*[\s\S]*?(?:\*\/|$))|(`[^`]*`?|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|([\p{L}_][\p{L}\p{N}_]*)|([0-9][\w.']*)|([\s\S])/gu;

/** Go tokens: comments dropped (a newline inside one kept, for semicolon insertion), strings and runes whole. */
function goTokens(src: string): Token[] {
  const tokens: Token[] = [];
  for (const [, nl, block, str, id, num, op] of src.matchAll(GO_TOKEN)) {
    if (nl !== undefined || block?.includes('\n') === true) tokens.push({kind: 'nl', text: '\n'});
    else if (str !== undefined) tokens.push({kind: 'str', text: str});
    else if (id !== undefined) tokens.push({kind: 'id', text: id});
    else if (num !== undefined) tokens.push({kind: 'num', text: num});
    else if (op !== undefined) tokens.push({kind: 'op', text: op});
  }
  return tokens;
}

/** Whether Go inserts a semicolon at a newline after `token` (the spec's rule, for the tokens a declaration ends on). */
const endsGoStatement = (token: Token | undefined): boolean =>
  token !== undefined &&
  (token.kind === 'id' || token.kind === 'num' || token.kind === 'str' || [')', ']', '}'].includes(token.text));

/**
 * The names a Go file declares at package level: functions (not methods, which have a receiver) and the
 * `var`, `const` and `type` names, grouped or not. Imports are not declarations of the package's.
 */
export function goTopLevel(src: string): string[] {
  const tokens = goTokens(src);
  const names: string[] = [];
  const next = (from: number): number => {
    let j = from;
    while (tokens[j]?.kind === 'nl') j++;
    return j;
  };
  /** One spec of a `var`/`const` (a list of names) or `type` (one name) declaration, from token `j`. */
  const spec = (j: number, list: boolean): void => {
    if (tokens[j]?.kind !== 'id') return;
    names.push(tokens[j].text);
    while (list && tokens[j + 1]?.text === ',' && tokens[j + 2]?.kind === 'id') {
      j += 2;
      names.push(tokens[j].text);
    }
  };
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'op' && '([{'.includes(token.text)) depth++;
    else if (token.kind === 'op' && ')]}'.includes(token.text)) depth--;
    if (depth !== 0 || token.kind !== 'id') continue;
    if (token.text === 'func') {
      const j = next(i + 1);
      if (tokens[j]?.kind === 'id') names.push(tokens[j].text);
    } else if (token.text === 'var' || token.text === 'const' || token.text === 'type') {
      const list = token.text !== 'type';
      const j = next(i + 1);
      if (tokens[j]?.text !== '(') {
        spec(j, list);
        continue;
      }
      // A group: one spec per line (or per `;`) at the group's own depth.
      let inner = 0;
      let start = true;
      let k = j + 1;
      for (; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind === 'op' && '([{'.includes(t.text)) inner++;
        else if (t.kind === 'op' && ')]}'.includes(t.text)) {
          if (inner === 0) break;
          inner--;
        }
        if (inner !== 0) continue;
        if (t.text === ';' || (t.kind === 'nl' && endsGoStatement(tokens[k - 1]))) start = true;
        else if (start && t.kind !== 'nl') {
          spec(k, list);
          start = false;
        }
      }
      i = k;
    }
  }
  return names;
}

/**
 * One C++ token per match: a preprocessor line with its continuations (1), a string, raw string or
 * character (2, its raw delimiter 3), an identifier (4), a number (5), `::`, `->` or any other character
 * (6). Spaces and comments match none.
 */
const CPP_TOKEN =
  /\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|(#(?:[^\n\\]|\\[\s\S])*)|((?:u8|u|U|L)?R"([^(\s]*)\([\s\S]*?\)\3"|(?:u8|u|U|L)?"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|([\p{L}_][\p{L}\p{N}_]*)|([0-9][\w.']*)|(::|->|[\s\S])/gu;

/** C++ tokens: comments dropped, a preprocessor line one token, strings (raw ones included) and characters whole. */
function cppTokens(src: string): Token[] {
  const tokens: Token[] = [];
  for (const [, pp, str, , id, num, op] of src.matchAll(CPP_TOKEN)) {
    if (pp !== undefined) tokens.push({kind: 'pp', text: pp});
    else if (str !== undefined) tokens.push({kind: 'str', text: str});
    else if (id !== undefined) tokens.push({kind: 'id', text: id});
    else if (num !== undefined) tokens.push({kind: 'num', text: num});
    else if (op !== undefined) tokens.push({kind: 'op', text: op});
  }
  return tokens;
}

/** Words that open a declaration but never name one. */
const CPP_KEYWORD = new RegExp(
  `^(?:${(
    'alignas alignof auto bool char char8_t char16_t char32_t class const consteval constexpr constinit ' +
    'decltype double enum explicit extern final float friend inline int long mutable noexcept override ' +
    'register short signed static struct template thread_local typename union unsigned virtual void ' +
    'volatile wchar_t'
  ).replaceAll(' ', '|')})$`,
);

/**
 * One namespace-scope statement from token `i`: its end (exclusive) and the indexes of its tokens at
 * bracket depth 0 (brackets themselves included). A function body ends the statement at its brace.
 */
function cppStatement(tokens: Token[], i: number): {end: number; top: number[]} {
  const top: number[] = [];
  let depth = 0;
  let closedParen = false;
  for (let j = i; j < tokens.length; j++) {
    const {kind, text} = tokens[j];
    if (kind === 'op' && '([{'.includes(text)) {
      if (depth === 0) {
        top.push(j);
        if (text === '{' && closedParen && !top.some(x => tokens[x].text === '=')) {
          // A function body: through its closing brace.
          let d = 0;
          for (let k = j; k < tokens.length; k++) {
            if (tokens[k].kind !== 'op') continue;
            if (tokens[k].text === '{') d++;
            else if (tokens[k].text === '}' && --d === 0) return {end: k + 1, top: [...top, k]};
          }
          return {end: tokens.length, top};
        }
      }
      depth++;
    } else if (kind === 'op' && ')]}'.includes(text)) {
      depth--;
      if (depth === 0) {
        top.push(j);
        if (text === ')') closedParen = true;
      }
      if (depth < 0) return {end: j, top};
    } else if (depth === 0) {
      top.push(j);
      if (text === ';') return {end: j + 1, top};
    }
  }
  return {end: tokens.length, top};
}

/** The index past a `template <…>` header starting at `words[w]`, or `w` when there is none. */
function pastTemplateHeaders(words: string[], w: number): number {
  while (words[w] === 'template' && words[w + 1] === '<') {
    let angle = 0;
    let k = w + 1;
    for (; k < words.length; k++) {
      if (words[k] === '<') angle++;
      else if (words[k] === '>' && --angle === 0) break;
    }
    w = k + 1;
  }
  return w;
}

const isIdent = (word: string | undefined): word is string =>
  word !== undefined && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(word) && !CPP_KEYWORD.test(word);

/**
 * The declarators of one statement's depth-0 words from `w`: each name stands before the first `(`, `=`,
 * `{`, `[`, `;` or `,` outside template brackets (its `stop`), and a `,` starts the next. A name qualified
 * by `::` (an out-of-line member) or an operator is no namespace-scope name.
 */
function declarators(words: string[], w: number): {name: string; stop: string}[] {
  const found: {name: string; stop: string}[] = [];
  let angle = 0;
  let pending = true;
  for (let k = w; k < words.length; k++) {
    const word = words[k];
    if (word === 'operator') return found;
    if (word === '<') angle++;
    else if (word === '>' && angle > 0) angle--;
    else if (angle === 0 && pending && ['(', '=', '{', '[', ';', ','].includes(word)) {
      pending = false;
      const name = words[k - 1];
      const qualified = words[k - 2] === '::' || words[k - 2] === '~';
      if (k > w && isIdent(name) && !qualified) found.push({name, stop: word});
      if (word === ',') pending = true;
    } else if (angle === 0 && word === ',') pending = true;
  }
  return found;
}

/**
 * What one C++ file declares at namespace scope: `names`, every function, variable, constant and type
 * (struct, class, union, enum, `using` alias, typedef) at file scope or in an anonymous namespace, and
 * a named namespace's own name (not its contents); `defined`, those it gives a body or a value, leaving
 * out prototypes and `extern` declarations (a declaration that a stand-in defines is still a use).
 */
export function cppTopLevel(src: string): {names: string[]; defined: string[]} {
  const tokens = cppTokens(src);
  const names: string[] = [];
  const defined: string[] = [];
  const add = (name: string, definition: boolean): void => {
    names.push(name);
    if (definition) defined.push(name);
  };
  let i = 0;
  while (i < tokens.length) {
    const {kind, text} = tokens[i];
    if (kind === 'pp' || text === ';' || text === '}') {
      i++;
      continue;
    }
    // A linkage block (`extern "C" {`) and an anonymous namespace: their contents are file scope.
    if (text === 'extern' && tokens[i + 1]?.kind === 'str' && tokens[i + 2]?.text === '{') {
      i += 3;
      continue;
    }
    const at = text === 'inline' && tokens[i + 1]?.text === 'namespace' ? i + 1 : i;
    if (tokens[at].text === 'namespace') {
      if (tokens[at + 1]?.text === '{') {
        i = at + 2;
        continue;
      }
      // A named namespace (or an alias): its name is the harness's, its contents are not at file scope.
      if (tokens[at + 1]?.kind === 'id') add(tokens[at + 1].text, true);
      let j = at + 1;
      while (j < tokens.length && tokens[j].text !== '{' && tokens[j].text !== ';') j++;
      if (tokens[j]?.text === '{') {
        let d = 0;
        for (; j < tokens.length; j++) {
          if (tokens[j].kind !== 'op') continue;
          if (tokens[j].text === '{') d++;
          else if (tokens[j].text === '}' && --d === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    const {end, top} = cppStatement(tokens, i);
    i = Math.max(end, i + 1);
    const words = top.map(x => tokens[x].text);
    let w = 0;
    // Leading attributes: `[[nodiscard]]` shows at depth 0 as `[` `]`.
    while (words[w] === '[' && words[w + 1] === ']') w += 2;
    w = pastTemplateHeaders(words, w);
    const first = words[w];
    if (first === undefined || first === 'static_assert' || first === 'friend') continue;
    if (first === 'using') {
      // An alias (`using Name = …;`); `using namespace x;` and `using x::y;` declare nothing of the harness's.
      if (isIdent(words[w + 1]) && words[w + 2] === '=') {
        const json = words.slice(w).join(' ') === 'using json = nlohmann :: json ;';
        if (!json) add(words[w + 1], true);
      }
      continue;
    }
    if (first === 'typedef') {
      const name = words[words.length - 2];
      if (isIdent(name)) add(name, true);
      continue;
    }
    if (['struct', 'class', 'union', 'enum'].includes(first)) {
      const brace = words.indexOf('{', w);
      if (brace >= 0 || words.length - w <= 3) {
        // A type defined (or declared ahead), and any variables declared after its closing brace.
        let k = w + 1;
        if (first === 'enum' && (words[k] === 'class' || words[k] === 'struct')) k++;
        while (words[k] === 'alignas' && words[k + 1] === '(') k += 3;
        if (isIdent(words[k]) && k < (brace < 0 ? words.length : brace)) add(words[k], brace >= 0);
        if (brace >= 0) {
          if (first === 'enum' && words[w + 1] !== 'class' && words[w + 1] !== 'struct') {
            // An unscoped enumeration's enumerators are names of the enclosing scope.
            for (let x = top[brace] + 1; x < tokens.length && tokens[x].text !== '}'; x++)
              if (tokens[x].kind === 'id' && (tokens[x - 1].text === '{' || tokens[x - 1].text === ','))
                add(tokens[x].text, true);
          }
          const close = words.indexOf('}', brace);
          for (const {name} of declarators(words, close + 1)) add(name, !words.includes('extern'));
        }
        continue;
      }
    }
    const declared = declarators(words, w);
    // A function is defined when it has a body; a variable unless it is an `extern` declaration.
    const isFunction = declared.length === 1 && declared[0].stop === '(';
    const definition = isFunction ? words.at(-1) === '}' : !words.includes('extern');
    for (const {name} of declared) add(name, definition);
  }
  return {names, defined};
}

/**
 * The names `code` uses without declaring (defining, in C++) them itself, what a harness may stand in for:
 * identifier tokens outside comments and strings and not a member (after `.`, `->` or `::`).
 */
function standIns(code: string, language: 'go' | 'cpp'): Set<string> {
  const tokens = language === 'go' ? goTokens(code) : cppTokens(code);
  const used = new Set(
    tokens.filter((t, k) => t.kind === 'id' && !['.', '->', '::'].includes(tokens[k - 1]?.text ?? '')).map(t => t.text),
  );
  for (const name of language === 'go' ? goTopLevel(code) : cppTopLevel(code).defined) used.delete(name);
  return used;
}

/** A name that already carries the harness prefix: `hName`, `HName`, `kHName`, `h2`, `H_x`, or `harness…`. */
export const harnessPrefixed = (name: string): boolean =>
  /^(?:kH|h|H)[\p{Lu}\p{N}_]/u.test(name) || /^(?:harness|Harness|kHarness)/.test(name);

/** Every top-level name of each Go and C++ harness of `problem` that breaks the prefix rule, as errors. */
export function harnessNameProblems(problem: Problem): string[] {
  const errors: string[] = [];
  // What the course's C++ headers declare and leave to be defined: a harness defines it under that name.
  let promised: string[] | undefined;
  for (const step of problem.steps) {
    const checks = new Set(step.checks.map(check => goCheckName(check.id)));
    for (const language of ['go', 'cpp'] as const satisfies readonly Language[]) {
      const harness = step.harness?.[language];
      if (harness === undefined) continue;
      const unprefixed = [...new Set(language === 'go' ? goTopLevel(harness) : cppTopLevel(harness).names)].filter(
        name => !harnessPrefixed(name) && !checks.has(name) && !['main', 'init', '_'].includes(name),
      );
      // Only a name left unprefixed needs a stand-in's excuse: the step's code is scanned for those alone.
      if (unprefixed.length === 0) continue;
      if (language === 'cpp')
        promised ??= Object.entries(problem.support?.cpp ?? {})
          .filter(([path]) => /\.(h|hh|hpp)$/.test(path))
          .flatMap(([, source]) => {
            const {names, defined} = cppTopLevel(source);
            return names.filter(name => !defined.includes(name));
          });
      const code = step.code[language];
      const exempt = new Set([
        ...(code === undefined ? [] : [...standIns(code.starter, language), ...standIns(code.solution, language)]),
        ...(language === 'cpp' ? promised ?? [] : []),
      ]);
      for (const name of unprefixed) {
        if (exempt.has(name)) continue;
        const base = name.replace(/^k(?=\p{Lu})/u, '');
        const cap = base[0].toUpperCase() + base.slice(1);
        const shares = language === 'go' ? 'package' : 'translation unit';
        errors.push(
          `${problem.id}/${step.id} [${language} harness]: top-level ${name} is not prefixed; ` +
            `call it h${cap} (H${cap} for a type, kH${cap} for a constant): the harness shares the learner's ${shares}`,
        );
      }
    }
  }
  return errors;
}
