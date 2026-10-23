/**
 * The Go runtime's Web Worker: downloads the interpreter (public/go/runtime.wasm.gz, ~9 MB, cached
 * by the browser) and PGlite from the CDN, then runs harness jobs off the main thread. One worker
 * holds one runtime; a hung run is handled by the main thread terminating the worker. The message
 * protocol is the other workers'.
 */
import {createDbBridge, openPgliteFromCdn} from './db';
import {type GoRuntime, createGoRuntime} from './go';
import {luaEval} from './lua';
import type {WorkerIn, WorkerOut} from './types';

const WASM_URL = '/go/runtime.wasm.gz';

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);

/** The runtime's WebAssembly: served gzipped as a static file, inflated here. */
const download = async (): Promise<ArrayBuffer> => {
  const res = await fetch(WASM_URL);
  if (!res.ok || res.body === null) throw new Error(`could not download the Go runtime (HTTP ${res.status})`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
};

let booting: Promise<GoRuntime> | null = null;

const boot = async (): Promise<GoRuntime> => {
  post({type: 'phase', phase: 'go'});
  const wasm = await download();
  post({type: 'phase', phase: 'runtime'});
  const runtime = await createGoRuntime({wasm: async () => wasm, luaEval, db: createDbBridge(openPgliteFromCdn)});
  post({type: 'ready'});
  return runtime;
};

const ready = (): Promise<GoRuntime> => {
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
  let runtime: GoRuntime;
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
