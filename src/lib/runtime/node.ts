/**
 * The runtimes in Node, for `yarn verify`. Python: Pyodide from the npm package (its packages come
 * from the CDN on first use and are cached under node_modules), assets from `public/py` on disk.
 * TypeScript: esbuild (native) as the transpiler. Both: fengari and PGlite from npm.
 */
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {transform} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadPyodide} from 'pyodide';

import {createDbBridge} from './db';
import {luaEval} from './lua';
import {bootPython, runPython} from './python';
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
  await bootPython(
    pyodide,
    {read: path => readFile(resolve(assetDir, path))},
    {luaEval, db: createDbBridge(openPglite)},
  );
  return {run: job => runPython(pyodide, job)};
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
