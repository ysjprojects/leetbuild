/**
 * Bundles the runtimes' workers — src/lib/runtime/worker.ts (Python) into `public/py/worker.js`
 * and src/lib/runtime/tsWorker.ts (TypeScript) into `public/ts/worker.js` — as ES-module workers
 * served as static assets. They are built outside webpack on purpose: Pyodide only runs in module
 * workers, and webpack emits classic workers unless the whole app is built as ESM. Runs before
 * `next dev` / `next build` (`predev`, `prebuild`); `yarn build:runtime` rebuilds them.
 */
import {build} from 'esbuild';
import {resolve} from 'node:path';

const shim = (name: string): string => resolve('src/lib/runtime/shims', name);

const WORKERS: [entry: string, outfile: string][] = [
  ['src/lib/runtime/worker.ts', 'public/py/worker.js'],
  ['src/lib/runtime/tsWorker.ts', 'public/ts/worker.js'],
];

async function main(): Promise<void> {
  for (const [entry, outfile] of WORKERS) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outfile,
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
    console.log(`${outfile} built`);
  }
}

void main();
