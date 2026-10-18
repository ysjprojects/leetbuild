/**
 * The Python runtime's Web Worker (an ES-module worker — Pyodide refuses classic ones): boots
 * Pyodide from the CDN (the core is ~10 MB, cached by the browser), the runtime's assets from
 * `/py`, and runs harness jobs off the main thread. One worker holds one runtime; a hung run is
 * handled by the main thread terminating the worker.
 */
import type {PyodideInterface} from 'pyodide';

import {createDbBridge} from './db';
import {luaEval} from './lua';
import {bootPython, PYODIDE_INDEX_URL, runPython} from './python';
import type {WorkerIn, WorkerOut} from './types';

/** Both come from the CDN at run time: they locate their own .wasm/.data next to their module URL. */
const PYODIDE_MODULE_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;
const PGLITE_URL = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.9/dist/index.js';

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);

let booting: Promise<PyodideInterface> | null = null;

const boot = async (): Promise<PyodideInterface> => {
  post({type: 'phase', phase: 'pyodide'});
  // Runtime imports on purpose: the npm copies bundled by webpack would look for their wasm/data
  // files inside the bundle; the CDN copies resolve them relative to their own URL.
  const {loadPyodide} = (await import(/* webpackIgnore: true */ PYODIDE_MODULE_URL)) as typeof import('pyodide');
  const pyodide = await loadPyodide({indexURL: PYODIDE_INDEX_URL});
  await bootPython(
    pyodide,
    {
      read: async path => {
        const response = await fetch(`/py/${path}`);
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    },
    {
      luaEval,
      db: createDbBridge(async () => {
        // Runtime import on purpose, as for Pyodide above.
        const mod = (await import(/* webpackIgnore: true */ PGLITE_URL)) as typeof import('@electric-sql/pglite');
        return new mod.PGlite();
      }),
    },
    phase => post({type: 'phase', phase}),
  );
  post({type: 'ready'});
  return pyodide;
};

const ready = (): Promise<PyodideInterface> => {
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
  let pyodide: PyodideInterface;
  try {
    pyodide = await ready();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({
      type: 'result',
      id: message.id,
      result: {checks: [], stdout: '', stderr: '', error: `the runtime could not start: ${text}`, ms: 0},
    });
    return;
  }
  post({type: 'result', id: message.id, result: await runPython(pyodide, message.job)});
};
