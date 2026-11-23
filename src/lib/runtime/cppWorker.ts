/**
 * The C++ runtime's Web Worker: clang compiled to WebAssembly from the CDN (`@yowasp/clang`, ~23 MB
 * the first time, cached by the browser), the sysroot and the runtime's pack (public/cpp, ~6.5 MB),
 * and PGlite from the CDN; then runs harness jobs off the main thread. Once a compile is done, the
 * precompiled header (public/cpp/pch.gz, ~16 MB) is fetched in the background and, if it was built
 * for the packs mounted here, used from the next compile on; no run waits for it. One worker holds
 * one runtime; a hung run is handled by the main thread terminating the worker. The message
 * protocol is the other workers'.
 */
import {type ClangCommand, type CppRuntime, createCppRuntime} from './cpp';
import {type Tree, mount, unpack} from './cpp/pack';
import {type PchIdentity, type PchManifest, pchIdentity, sha256Hex} from './cpp/pch';
import {CLANG_URL, CLANG_VERSION} from './cpp/support';
import {createDbBridge, openPgliteFromCdn} from './db';
import {luaEval} from './lua';
import type {WorkerIn, WorkerOut} from './types';

interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: MessageEvent<WorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: WorkerOut): void => scope.postMessage(message);

/** A file of public/cpp, as served. */
const download = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
};

/** A gzipped file of public/cpp, inflated. */
const inflate = async (gzipped: Uint8Array): Promise<Uint8Array> => {
  const inflated = new Response(gzipped).body?.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
};

/** A pack of public/cpp: served gzipped as a static file, inflated here, mounted as clang sees it. */
const mountPack = async (gzipped: Uint8Array): Promise<Tree> => mount({}, '', unpack(await inflate(gzipped)));

let booting: Promise<CppRuntime> | null = null;
/** What a PCH must have been built for to serve the packs mounted here: set at boot, cleared once it is fetched. */
let wanted: (() => Promise<PchIdentity>) | null = null;
let pch: Uint8Array | null = null;

/** The PCH, if its manifest names the packs, compiler and flags this worker compiles with and its bytes are those. */
const loadPch = async (identity: () => Promise<PchIdentity>): Promise<void> => {
  const manifest = (await (await fetch('/cpp/pch.json')).json()) as PchManifest;
  if (JSON.stringify(manifest.identity) !== JSON.stringify(await identity())) return;
  const bytes = await inflate(await download('/cpp/pch.gz'));
  if ((await sha256Hex(bytes)) === manifest.sha256) pch = bytes;
};

/** After a compile, once: fetch the PCH in the background. Any failure leaves compiling without it. */
const fetchPchLater = (): void => {
  if (wanted === null) return;
  void loadPch(wanted).catch(() => undefined);
  wanted = null;
};

const boot = async (): Promise<CppRuntime> => {
  post({type: 'phase', phase: 'clang'});
  // The compiler comes from the CDN at run time, outside the bundle: it locates its WebAssembly next to its module URL.
  const {commands} = (await import(/* webpackIgnore: true */ CLANG_URL)) as {commands: Record<string, ClangCommand>};
  const [sysrootPack, runtimePack] = await Promise.all([
    download('/cpp/sysroot.pack.gz'),
    download('/cpp/runtime.pack.gz'),
  ]);
  const [sysroot, runtime] = await Promise.all([mountPack(sysrootPack), mountPack(runtimePack)]);
  const cpp = await createCppRuntime({
    clang: async () => commands['clang++'],
    sysroot: async () => sysroot,
    runtime: async () => runtime,
    db: createDbBridge(openPgliteFromCdn),
    luaEval,
    pch: () => pch,
  });
  wanted = () => pchIdentity(runtimePack, sysrootPack, CLANG_VERSION);
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
  const started = (): void => {
    post({type: 'started', id: message.id});
    fetchPchLater();
  };
  post({type: 'result', id: message.id, result: await runtime.run(message.job, started)});
  // A program that did not compile never started: its compile is over all the same.
  fetchPchLater();
};
