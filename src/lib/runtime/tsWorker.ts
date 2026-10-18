/**
 * The TypeScript runtime's Web Worker: boots esbuild-wasm (the transpiler, ~14 MB, cached by the
 * browser) and PGlite from the CDN, then runs harness jobs off the main thread. One worker holds
 * one runtime; a hung run is handled by the main thread terminating the worker. The message
 * protocol is the Python worker's.
 */
import type * as esbuild from 'esbuild-wasm';

import {createDbBridge} from './db';
import {luaEval} from './lua';
import {reportUnhandledRejection} from './ts/harness';
import type {WorkerIn, WorkerOut} from './types';
import {type TypeScriptRuntime, createTypeScriptRuntime} from './typescript';

const ESBUILD_VERSION = '0.28.2';
/** Both come from the CDN at run time: they locate their own .wasm next to their module URL. */
const ESBUILD_MODULE_URL = `https://cdn.jsdelivr.net/npm/esbuild-wasm@${ESBUILD_VERSION}/esm/browser.min.js`;
const ESBUILD_WASM_URL = `https://cdn.jsdelivr.net/npm/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;
const PGLITE_URL = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.9/dist/index.js';

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);
// A fire-and-forget promise of the learner's that rejects is logged into the run, not raised at the worker.
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  reportUnhandledRejection(event.reason);
});

let booting: Promise<TypeScriptRuntime> | null = null;

const boot = async (): Promise<TypeScriptRuntime> => {
  post({type: 'phase', phase: 'esbuild'});
  // Runtime import on purpose: the npm copy bundled by esbuild would look for its wasm inside the
  // bundle; the CDN copy is told where its wasm is.
  const mod = (await import(/* webpackIgnore: true */ ESBUILD_MODULE_URL)) as typeof esbuild;
  // The runtime swaps the timer globals while a check runs; esbuild's Go scheduler must not depend
  // on them, so it runs in this thread (no nested worker) and only ever between checks.
  await mod.initialize({wasmURL: ESBUILD_WASM_URL, worker: false});
  post({type: 'phase', phase: 'runtime'});
  const runtime = createTypeScriptRuntime({
    transform: async (source, file) => {
      const out = await mod.transform(source, {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
        sourcemap: true,
        sourcefile: file,
      });
      return {code: out.code, map: out.map};
    },
    luaEval,
    db: createDbBridge(async () => {
      // Runtime import on purpose, as above.
      const pglite = (await import(/* webpackIgnore: true */ PGLITE_URL)) as typeof import('@electric-sql/pglite');
      return new pglite.PGlite();
    }),
  });
  post({type: 'ready'});
  return runtime;
};

const ready = (): Promise<TypeScriptRuntime> => {
  if (booting === null) {
    booting = boot().catch(error => {
      booting = null;
      throw error;
    });
  }
  return booting;
};

scope.onmessage = async event => {
  const message = event.data;
  if (message.type === 'boot') {
    try {
      await ready();
    } catch (error) {
      post({type: 'boot-failed', message: error instanceof Error ? error.message : String(error)});
    }
    return;
  }
  let runtime: TypeScriptRuntime;
  try {
    runtime = await ready();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({
      type: 'result',
      id: message.id,
      result: {checks: [], stdout: '', stderr: '', error: `the runtime could not start: ${text}`, ms: 0},
    });
    return;
  }
  post({type: 'result', id: message.id, result: await runtime.run(message.job)});
};
