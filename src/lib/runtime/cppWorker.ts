/**
 * The C++ runtime's Web Worker: clang compiled to WebAssembly from the CDN (`@yowasp/clang`, ~23 MB
 * the first time, cached by the browser), the sysroot and the runtime's pack (public/cpp, ~6.5 MB),
 * and PGlite from the CDN; then runs harness jobs off the main thread. One worker holds one runtime;
 * a hung run is handled by the main thread terminating the worker. The message protocol is the
 * other workers'.
 */
import {type ClangCommand, type CppRuntime, createCppRuntime} from './cpp';
import {type Tree, mount, unpack} from './cpp/pack';
import {CLANG_URL} from './cpp/support';
import {createDbBridge, openPgliteFromCdn} from './db';
import {luaEval} from './lua';
import type {WorkerIn, WorkerOut} from './types';

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);

/** A pack of public/cpp: served gzipped as a static file, inflated here, mounted as clang sees it. */
const download = async (url: string): Promise<Tree> => {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`could not download ${url} (HTTP ${res.status})`);
  const buffer = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return mount({}, '', unpack(new Uint8Array(buffer)));
};

let booting: Promise<CppRuntime> | null = null;

const boot = async (): Promise<CppRuntime> => {
  post({type: 'phase', phase: 'clang'});
  // The compiler comes from the CDN at run time, outside the bundle: it locates its WebAssembly next to its module URL.
  const {commands} = (await import(/* webpackIgnore: true */ CLANG_URL)) as {commands: Record<string, ClangCommand>};
  const [sysroot, runtime] = await Promise.all([download('/cpp/sysroot.pack.gz'), download('/cpp/runtime.pack.gz')]);
  const cpp = await createCppRuntime({
    clang: async () => commands['clang++'],
    sysroot: async () => sysroot,
    runtime: async () => runtime,
    db: createDbBridge(openPgliteFromCdn),
    luaEval,
  });
  post({type: 'ready'});
  return cpp;
};

const ready = (): Promise<CppRuntime> => {
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
  let runtime: CppRuntime;
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
  const started = (): void => post({type: 'started', id: message.id});
  post({type: 'result', id: message.id, result: await runtime.run(message.job, started)});
};
