/**
 * Bundles the Python runtime's worker (src/lib/runtime/worker.ts) into `public/py/worker.js`, an
 * ES-module worker served as a static asset. It is built outside webpack on purpose: Pyodide only
 * runs in module workers, and webpack emits classic workers unless the whole app is built as ESM.
 * Runs before `next dev` / `next build` (`predev`, `prebuild`); `yarn build:runtime` rebuilds it.
 */
import {build} from 'esbuild';
import {resolve} from 'node:path';

const shim = (name: string): string => resolve('src/lib/runtime/shims', name);

async function main(): Promise<void> {
  const result = await build({
    entryPoints: ['src/lib/runtime/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'public/py/worker.js',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    // fengari (the Lua VM) guards its Node-only code behind `typeof process`; the bundle keeps `process`
    // undefined so those branches never run, stubs the Node modules they would require (esbuild still
    // resolves them), and replaces the two `process.*` expressions evaluated at import time.
    alias: {
      fs: shim('empty.js'),
      os: shim('empty.js'),
      path: shim('empty.js'),
      child_process: shim('empty.js'),
      tmp: shim('empty.js'),
      'readline-sync': shim('empty.js'),
    },
    define: {'process.env.FENGARICONF': 'undefined', 'process.versions.node': '"0"'},
  });
  if (result.errors.length > 0) process.exit(1);
  console.log('public/py/worker.js built');
}

void main();
