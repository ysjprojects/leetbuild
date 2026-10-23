/**
 * The Python runtime's Web Worker (an ES-module worker — Pyodide refuses classic ones): boots
 * Pyodide from the CDN (the core is ~10 MB, cached by the browser), the runtime's assets from
 * `/py`, and runs harness jobs off the main thread. One worker holds one runtime; a hung run is
 * handled by the main thread terminating the worker.
 */
import type {PyodideInterface} from 'pyodide';

import {createDbBridge, openPgliteFromCdn} from './db';
import {luaEval} from './lua';
import {type Assets, bootPython, loadTorch, needsTorch, PYODIDE_INDEX_URL, runPython} from './python';
import type {WorkerIn, WorkerOut} from './types';

/** Pyodide comes from the CDN at run time: it locates its own .wasm/.data next to its module URL. */
const PYODIDE_MODULE_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);

let booting: Promise<PyodideInterface> | null = null;
let torch: Promise<void> | null = null;

/** The runtime's assets, from this site's `/py`. */
const assets: Assets = {
  read: async path => {
    const response = await fetch(`/py/${path}`);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
};

const boot = async (): Promise<PyodideInterface> => {
  post({type: 'phase', phase: 'pyodide'});
  // Runtime imports on purpose: the npm copies bundled by webpack would look for their wasm/data
  // files inside the bundle; the CDN copies resolve them relative to their own URL.
  const {loadPyodide} = (await import(/* webpackIgnore: true */ PYODIDE_MODULE_URL)) as typeof import('pyodide');
  const pyodide = await loadPyodide({indexURL: PYODIDE_INDEX_URL});
  await bootPython(pyodide, assets, {luaEval, db: createDbBridge(openPgliteFromCdn)}, phase =>
    post({type: 'phase', phase}),
  );
  post({type: 'ready'});
  return pyodide;
};

/** PyTorch, loaded on the first program that imports it (~40 MB the first time, then cached). */
const withTorch = (pyodide: PyodideInterface): Promise<void> => {
  if (torch === null) {
    post({type: 'phase', phase: 'torch'});
    torch = loadTorch(pyodide, assets).catch(error => {
      torch = null;
      throw error;
    });
  }
  return torch;
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
    if (message.job.program === true && needsTorch(message.job)) await withTorch(pyodide);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({
      type: 'result',
      id: message.id,
      result: {checks: [], stdout: '', stderr: '', error: `the runtime could not start: ${text}`, ms: 0},
    });
    return;
  }
  const {id} = message;
  post({type: 'started', id});
  post({
    type: 'result',
    id,
    result: await runPython(pyodide, message.job, line => post({type: 'output', id, ...line})),
  });
};
