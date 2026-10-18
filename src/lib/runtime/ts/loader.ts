/**
 * Modules for the TypeScript runtime: every file (the learner's under `/work`, the course's support
 * under `/support`, the step's harness) is transpiled once per run with esbuild (TypeScript → CommonJS,
 * types erased, no type checking — grading is by execution) and run as a CommonJS module with a
 * `require` that resolves relative paths against the virtual tree, bare names against the course's
 * support tree and the runtime's packages (`ioredis`, `kafkajs`, `@grpc/grpc-js`, `fastify`, `pg`,
 * `node:*`). Module instances are purged between checks so each check starts from fresh state.
 * Error positions are mapped back to the learner's TypeScript through esbuild's source map.
 */

export interface Transformed {
  code: string;
  /** esbuild's source map JSON, for error positions. */
  map: string;
}

export interface Transformer {
  (source: string, file: string): Promise<Transformed>;
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntaxError';
  }
}

interface Compiled {
  code: string;
  /** Generated line (1-based) → original `{line, column}` segments (0-based columns), from the source map. */
  lines: Map<number, {column: number; line: number; originalColumn: number}[]>;
}

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a source map's `mappings` into per-generated-line segments (only the original line/column matter here). */
const decodeMappings = (mappings: string): Compiled['lines'] => {
  const lines: Compiled['lines'] = new Map();
  let line = 1;
  let column = 0;
  let sourceLine = 0;
  let sourceColumn = 0;

  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  const flush = (): void => {
    if (fields.length >= 4) {
      column += fields[0];
      sourceLine += fields[2];
      sourceColumn += fields[3];
      const segments = lines.get(line) ?? [];
      segments.push({column, line: sourceLine + 1, originalColumn: sourceColumn});
      lines.set(line, segments);
    } else if (fields.length === 1) column += fields[0];
    fields.length = 0;
  };
  for (const ch of mappings) {
    if (ch === ';') {
      flush();
      line += 1;
      column = 0;
      continue;
    }
    if (ch === ',') {
      flush();
      continue;
    }
    const digit = VLQ.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      const negative = value & 1;
      const magnitude = value >> 1;
      fields.push(negative ? -magnitude : magnitude);
      value = 0;
      shift = 0;
    }
  }
  flush();
  return lines;
};

/** Where a frame points in the original TypeScript, or the generated position when the map has no entry. */
const originalPosition = (compiled: Compiled, line: number, column: number): {line: number; column: number} => {
  const segments = compiled.lines.get(line);
  if (segments === undefined || segments.length === 0) return {line, column};
  let best = segments[0];
  for (const s of segments) if (s.column <= column) best = s;
  return {line: best.line, column: best.originalColumn + 1};
};

export interface Frame {
  file: string;
  line: number;
  column: number;
  fn: string | null;
}

/** V8 (`at fn (file:l:c)`, `at file:l:c`) and JavaScriptCore/SpiderMonkey (`fn@file:l:c`) stack lines. */
const parseStack = (stack: string): Frame[] => {
  const frames: Frame[] = [];
  for (const raw of stack.split('\n')) {
    const text = raw.trim();
    const m = /^(?:at\s+(?:(.*?)\s+\()?|(.*?)@)?(.+?):(\d+):(\d+)\)?$/.exec(text);
    if (m === null) continue;
    const fn = (m[1] ?? m[2] ?? '').trim();
    frames.push({
      file: m[3],
      line: Number(m[4]),
      column: Number(m[5]),
      fn: fn === '' || fn === 'eval' || fn === 'anonymous' ? null : fn,
    });
  }
  return frames;
};

export const WORK = '/work';
export const SUPPORT = '/support';
export const HARNESS = '/harness.ts';

const RUNTIME_PREFIX = 'leetbuild:';

/** `new Function` wraps the body in a function header: frames are off by the header's line count. */
const wrapperLineOffset = ((): number => {
  const probe = new Function('return new Error("probe").stack ?? ""')() as string;
  const frame = parseStack(probe)[0];
  return frame === undefined ? 0 : frame.line - 1;
})();

interface ModuleRecord {
  exports: Record<string, unknown>;
  loaded: boolean;
}

export class ModuleSystem {
  /** Names given to every module's scope besides the CommonJS ones (`process`). */
  moduleGlobals: Record<string, unknown> = {};
  /** Names given to the harness module's scope on top of those (`assert`). */
  harnessGlobals: Record<string, unknown> = {};
  private readonly sources = new Map<string, string>();
  private readonly compiled = new Map<string, Compiled | CompileError>();
  private readonly instances = new Map<string, ModuleRecord>();
  private readonly packages = new Map<string, () => unknown>();

  constructor(private readonly transform: Transformer) {}

  /** A runtime package reachable by its bare name (`ioredis`), built lazily once. */
  registerPackage(name: string, factory: () => unknown): void {
    let instance: unknown;
    let built = false;
    this.packages.set(name, () => {
      if (!built) {
        instance = factory();
        built = true;
      }
      return instance;
    });
  }

  /** Transpile every file up front, so no compiler runs while a check does. Compile errors surface at `require`. */
  async prepare(files: Record<string, string>): Promise<void> {
    this.sources.clear();
    this.compiled.clear();
    this.instances.clear();
    for (const [path, source] of Object.entries(files)) this.sources.set(path, source);
    await Promise.all(
      [...this.sources].map(async ([path, source]) => {
        if (!/\.(ts|js|mts|cts|tsx)$/.test(path)) return;
        try {
          const out = await this.transform(source, path);
          const map = JSON.parse(out.map) as {mappings?: string};
          this.compiled.set(path, {code: out.code, lines: decodeMappings(map.mappings ?? '')});
        } catch (e) {
          this.compiled.set(path, new CompileError(describeCompileError(e, path)));
        }
      }),
    );
  }

  /** Forget every module instance (not the compiled code): the next `require` runs the file again. */
  purge(): void {
    this.instances.clear();
  }

  /** Forget one module instance so the next `require` evaluates it again (a second replica of the learner's service). */
  forget(path: string): void {
    this.instances.delete(path);
  }

  has(path: string): boolean {
    return this.sources.has(path);
  }

  /** The source of a file in the virtual tree (`/support/gateway/cert.pem`), or null. */
  read(path: string): string | null {
    return this.sources.get(path) ?? null;
  }

  /** Files whose name ends with `suffix`, with their sources. */
  filesEndingWith(suffix: string): [string, string][] {
    return [...this.sources].filter(([path]) => path.endsWith(suffix));
  }

  /** Load a module by absolute virtual path; the learner's `redirect` is `/work/redirect.ts`. */
  load(path: string): Record<string, unknown> {
    return this.require(path, '/');
  }

  /** Frames of `error` that point into the virtual tree, positions mapped to the original TypeScript. */
  frames(error: unknown): Frame[] {
    const stack = error instanceof Error ? error.stack ?? '' : '';
    const out: Frame[] = [];
    for (const frame of parseStack(stack)) {
      if (!frame.file.startsWith(RUNTIME_PREFIX)) continue;
      const path = frame.file.slice(RUNTIME_PREFIX.length);
      const compiled = this.compiled.get(path);
      if (compiled === undefined || compiled instanceof CompileError) continue;
      const position = originalPosition(compiled, frame.line - wrapperLineOffset, frame.column - 1);
      out.push({file: path, line: position.line, column: position.column, fn: frame.fn});
    }
    return out;
  }
  private resolve(spec: string, from: string): string | (() => unknown) {
    if (spec.startsWith('node:')) spec = spec.slice(5);
    const pkg = this.packages.get(spec);
    if (pkg !== undefined) return pkg;
    const candidates: string[] = [];
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec : joinPath(dirname(from), spec);
      candidates.push(base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`);
    } else {
      for (const root of [SUPPORT, WORK])
        candidates.push(`${root}/${spec}`, `${root}/${spec}.ts`, `${root}/${spec}/index.ts`);
    }
    for (const c of candidates) if (this.sources.has(c)) return c;
    const where = from.startsWith(WORK)
      ? ` from ${from.slice(WORK.length + 1)}`
      : from === HARNESS
      ? ' from the harness'
      : '';
    const known = [...this.sources.keys()]
      .filter(p => p.startsWith(WORK) || p.startsWith(SUPPORT))
      .map(p => p.replace(/^\/(work|support)\//, ''));
    throw new Error(
      `Cannot find module '${spec}'${where}. Files: ${known.join(', ') || 'none'}; packages: ${[...this.packages.keys()]
        .filter(p => !p.includes('/') || p.startsWith('@'))
        .join(', ')}`,
    );
  }

  private require(spec: string, from: string): Record<string, unknown> {
    const resolved = this.resolve(spec, from);
    if (typeof resolved === 'function') return resolved() as Record<string, unknown>;
    const path = resolved;
    const existing = this.instances.get(path);
    if (existing !== undefined) return existing.exports;
    const compiled = this.compiled.get(path);
    if (compiled === undefined) throw new Error(`${path} is not a module (only .ts files can be imported)`);
    if (compiled instanceof CompileError) throw compiled;
    const record: ModuleRecord = {exports: {}, loaded: false};
    this.instances.set(path, record);
    const cjsModule = {exports: record.exports};
    const require = (s: string): unknown => this.require(s, path);
    const extra = path === HARNESS ? {...this.moduleGlobals, ...this.harnessGlobals} : this.moduleGlobals;
    const names = ['exports', 'require', 'module', '__filename', '__dirname', ...Object.keys(extra)];
    const fn = new Function(...names, `${compiled.code}\n//# sourceURL=${RUNTIME_PREFIX}${path}`);
    try {
      fn(cjsModule.exports, require, cjsModule, path, dirname(path), ...Object.values(extra));
    } catch (e) {
      this.instances.delete(path);
      throw e;
    }
    record.exports = cjsModule.exports;
    record.loaded = true;
    return record.exports;
  }
}

const dirname = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
};

const joinPath = (dir: string, rel: string): string => {
  const parts = dir.split('/').filter(p => p !== '');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
};

/** esbuild's error shape → `redirect.ts:12:5: Expected ";" but found "x"`. */
const describeCompileError = (e: unknown, path: string): string => {
  const short = path.startsWith(WORK) ? path.slice(WORK.length + 1) : path === HARNESS ? 'harness' : path;
  if (e !== null && typeof e === 'object' && 'errors' in e && Array.isArray(e.errors) && e.errors.length > 0) {
    const first: unknown = e.errors[0];
    if (first !== null && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
      const location =
        'location' in first && first.location !== null && typeof first.location === 'object' ? first.location : null;
      const line = location !== null && 'line' in location && typeof location.line === 'number' ? location.line : null;
      const column =
        location !== null && 'column' in location && typeof location.column === 'number' ? location.column + 1 : null;
      return line === null ? `${short}: ${first.text}` : `${short}:${line}:${column ?? 1}: ${first.text}`;
    }
  }
  return `${short}: ${e instanceof Error ? e.message : String(e)}`;
};
