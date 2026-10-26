/**
 * What the app needs to know about the C++ runtime without loading it: whether this engine can run
 * its programs, and where the browser gets the compiler. Kept apart from cpp.ts so the main bundle
 * stays small.
 */

/** `@yowasp/clang`, the version in package.json: the browser compiles with what `yarn verify` and `yarn build:cpp` ran. */
export const CLANG_VERSION = '22.0.0-git20542-10';

/** The compiler's module on the CDN: it fetches its WebAssembly (~23 MB compressed) next to itself. */
export const CLANG_URL = `https://cdn.jsdelivr.net/npm/@yowasp/clang@${CLANG_VERSION}/gen/bundle.js`;

/**
 * Whether this engine runs the C++ runtime's programs: WebAssembly stack switching (JSPI) for green
 * threads, which arrived together with the exception references the programs' C++ exceptions use.
 */
export function cppSupported(): boolean {
  const wasm = globalThis.WebAssembly as unknown as Record<string, unknown> | undefined;
  return typeof wasm?.Suspending === 'function' && typeof wasm.promising === 'function';
}

export const CPP_UNSUPPORTED =
  'C++ runs on WebAssembly stack switching (JSPI), which this browser lacks: use Chrome 137+, Firefox 153+ or Safari 27+';
