/**
 * The Python runtime in Node, for `yarn verify`: Pyodide from the npm package (its packages come
 * from the CDN on first use and are cached under node_modules), assets from `public/py` on disk,
 * fengari and PGlite from npm.
 */
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadPyodide} from 'pyodide';

import {createDbBridge} from './db';
import {luaEval} from './lua';
import {type RunJob, type RunResult, bootPython, runPython} from './python';

export interface NodeRuntime {
  run(job: RunJob): Promise<RunResult>;
}

export async function createNodeRuntime(assetDir = resolve(process.cwd(), 'public/py')): Promise<NodeRuntime> {
  const pyodide = await loadPyodide({stdout: () => undefined, stderr: () => undefined});
  await bootPython(
    pyodide,
    {read: path => readFile(resolve(assetDir, path))},
    {luaEval, db: createDbBridge(async () => new PGlite())},
  );
  return {run: job => runPython(pyodide, job)};
}
