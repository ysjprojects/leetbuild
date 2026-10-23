/**
 * The runtimes in Node, for `yarn verify`. Python: Pyodide from the npm package (its packages come
 * from the CDN on first use and are cached under node_modules), assets from `public/py` on disk.
 * TypeScript: esbuild (native) as the transpiler. Go: the interpreter's WebAssembly from
 * `public/go` on disk. All: fengari and PGlite from npm.
 */
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {transform} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {loadPyodide} from 'pyodide';

import {createDbBridge} from './db';
import {createGoRuntime} from './go';
import {luaEval} from './lua';
import {bootPython, loadTorch, needsTorch, runPython} from './python';
import {reportUnhandledRejection} from './ts/harness';
import type {RunJob, RunResult} from './types';
import {createTypeScriptRuntime} from './typescript';

export interface NodeRuntime {
  run(job: RunJob): Promise<RunResult>;
}

/** The same Postgres the workers get from the CDN: PGlite with pgvector. */
const openPglite = async (): Promise<PGlite> => new PGlite({extensions: {vector}});

export async function createNodePythonRuntime(assetDir = resolve(process.cwd(), 'public/py')): Promise<NodeRuntime> {
  const pyodide = await loadPyodide({stdout: () => undefined, stderr: () => undefined});
  const assets = {read: (path: string) => readFile(resolve(assetDir, path))};
  await bootPython(pyodide, assets, {luaEval, db: createDbBridge(openPglite)});
  let torch: Promise<void> | null = null;
  return {
    run: async job => {
      if (job.program === true && needsTorch(job)) await (torch ??= loadTorch(pyodide, assets));
      return runPython(pyodide, job);
    },
  };
}

export function createNodeTypeScriptRuntime(): NodeRuntime {
  // A fire-and-forget promise of the learner's that rejects would otherwise end the verify process.
  process.on('unhandledRejection', reportUnhandledRejection);
  return createTypeScriptRuntime({
    transform: async (source, file) => {
      const out = await transform(source, {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
        sourcemap: true,
        sourcefile: file,
      });
      return {code: out.code, map: out.map};
    },
    luaEval,
    db: createDbBridge(openPglite),
  });
}

export async function createNodeGoRuntime(assetDir = resolve(process.cwd(), 'public/go')): Promise<NodeRuntime> {
  return createGoRuntime({
    wasm: async () => gunzipSync(await readFile(resolve(assetDir, 'runtime.wasm.gz'))),
    luaEval,
    db: createDbBridge(openPglite),
  });
}
