/**
 * The Python runtime, shared by the browser worker and `yarn verify` (Node): boot a Pyodide
 * instance into a LeetBuild runtime (packages, vendored wheels, the `leetbuild` package and its
 * `confluent_kafka`/`grpc`/`uvicorn` shims, the host bridges for Lua and Postgres) and run a
 * step's harness against a filesystem of learner files.
 *
 * Environment-specific pieces are injected: how to read assets under `public/py`, and the
 * Lua/Postgres host bridges (fengari and PGlite, from npm in Node and from the CDN in the worker).
 */
import type {PyodideInterface} from 'pyodide';

import type {DbBridge} from './db';

export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
/** Pyodide-built packages the runtime loads from the CDN (their dependencies come along). */
export const PYODIDE_PACKAGES = ['fastapi', 'httpx', 'sortedcontainers', 'protobuf', 'micropip'];
/** Pure-Python wheels vendored under `public/py/wheels` (not built into Pyodide). */
export const WHEELS = ['redis-8.1.0-py3-none-any.whl', 'fakeredis-2.39.0-py3-none-any.whl'];
/** The runtime's own modules under `public/py/runtime`, copied into Pyodide's filesystem at boot. */
export const RUNTIME_FILES = [
  'leetbuild/__init__.py',
  'leetbuild/clock.py',
  'leetbuild/kafka.py',
  'leetbuild/grpcsim.py',
  'leetbuild/db.py',
  'leetbuild/lua.py',
  'leetbuild/harness.py',
  'confluent_kafka/__init__.py',
  'grpc/__init__.py',
  'grpc/_utilities.py',
  'grpc/aio/__init__.py',
  'uvicorn/__init__.py',
];

const RUNTIME_DIR = '/leetbuild-runtime';
const WHEEL_DIR = '/wheels';
const WORK_DIR = '/work';
const SUPPORT_DIR = '/support';

export type BootPhase = 'pyodide' | 'packages' | 'runtime';

export interface Assets {
  /** Read a file under `public/py/` (e.g. `wheels/redis-….whl`, `runtime/leetbuild/kafka.py`). */
  read(path: string): Promise<Uint8Array>;
}

export interface HostBridges {
  luaEval(script: string, keysJson: string, argvJson: string, redisCall: (argsJson: string) => string): string;
  db: DbBridge;
}

export interface RunJob {
  /** The learner's files by file name (`thumb_server.py`). */
  files: Record<string, string>;
  /** The course's support modules by path (`payments/db.py`, `resizer_pb2.py`). */
  support: Record<string, string>;
  /** The step's harness module (`check_<id>(ctx)` functions). */
  harness: string;
  /** Check ids to run, in verdict order. */
  checks: string[];
}

export interface RuntimeCheckResult {
  id: string;
  passed: boolean;
  /** Why it failed: the assertion message, or the exception and where in the learner's code it was raised. */
  message?: string;
}

export interface RunResult {
  checks: RuntimeCheckResult[];
  stdout: string;
  stderr: string;
  /** The run could not complete (runtime failure, timeout); `checks` is then empty. */
  error?: string;
  ms: number;
}

const mkdirTree = (pyodide: PyodideInterface, path: string): void => {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    if (!pyodide.FS.analyzePath(current).exists) pyodide.FS.mkdir(current);
  }
};

const rmTree = (pyodide: PyodideInterface, path: string): void => {
  const fs = pyodide.FS;
  if (!fs.analyzePath(path).exists) return;
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) rmTree(pyodide, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
};

const writeTree = (pyodide: PyodideInterface, root: string, files: Record<string, string>): void => {
  rmTree(pyodide, root);
  mkdirTree(pyodide, root);
  const dirs = new Set<string>();
  for (const [name, text] of Object.entries(files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    mkdirTree(pyodide, `${root}/${parts.slice(0, -1).join('/')}`);
    pyodide.FS.writeFile(`${root}/${name}`, text);
  }
  // Every directory is a package: `from payments.db import db` works without an explicit __init__.py.
  for (const dir of dirs) {
    const init = `${root}/${dir}/__init__.py`;
    if (!pyodide.FS.analyzePath(init).exists) pyodide.FS.writeFile(init, '');
  }
};

/** Turn a fresh Pyodide instance into the LeetBuild runtime. Idempotent per instance. */
export async function bootPython(
  pyodide: PyodideInterface,
  assets: Assets,
  host: HostBridges,
  onPhase?: (phase: BootPhase) => void,
): Promise<void> {
  onPhase?.('packages');
  await pyodide.loadPackage(PYODIDE_PACKAGES, {messageCallback: () => undefined});
  onPhase?.('runtime');
  mkdirTree(pyodide, WHEEL_DIR);
  for (const wheel of WHEELS) pyodide.FS.writeFile(`${WHEEL_DIR}/${wheel}`, await assets.read(`wheels/${wheel}`));
  for (const file of RUNTIME_FILES) {
    mkdirTree(pyodide, `${RUNTIME_DIR}/${file.split('/').slice(0, -1).join('/')}`);
    pyodide.FS.writeFile(`${RUNTIME_DIR}/${file}`, await assets.read(`runtime/${file}`));
  }
  pyodide.registerJsModule('leetbuild_host', {
    lua_eval: host.luaEval,
    db_query: (sql: string, paramsJson: string) => host.db.query(sql, paramsJson),
    db_exec: (sql: string) => host.db.exec(sql),
  });
  await pyodide.runPythonAsync(`
import micropip, sys
await micropip.install([${WHEELS.map(w => `"emfs:${WHEEL_DIR}/${w}"`).join(', ')}], deps=False)
sys.path.insert(0, ${JSON.stringify(RUNTIME_DIR)})
import leetbuild
leetbuild.boot()
`);
}

/** Run one step's harness against the learner's files. The runtime must be booted. */
export async function runPython(pyodide: PyodideInterface, job: RunJob): Promise<RunResult> {
  const started = Date.now();
  const stdout: string[] = [];
  const stderr: string[] = [];
  pyodide.setStdout({batched: line => stdout.push(line)});
  pyodide.setStderr({batched: line => stderr.push(line)});
  try {
    writeTree(pyodide, WORK_DIR, job.files);
    writeTree(pyodide, SUPPORT_DIR, job.support);
    const runChecks = pyodide.runPython('from leetbuild.harness import run_checks\nrun_checks') as (
      harness: string,
      ids: unknown,
      files: unknown,
    ) => Promise<{toJs(options: {dict_converter: typeof Object.fromEntries}): RuntimeCheckResult[]; destroy(): void}>;
    const ids = pyodide.toPy(job.checks);
    const files = pyodide.toPy(job.files);
    try {
      const proxy = await runChecks(job.harness, ids, files);
      const checks = proxy.toJs({dict_converter: Object.fromEntries});
      proxy.destroy();
      return {checks, stdout: stdout.join('\n'), stderr: stderr.join('\n'), ms: Date.now() - started};
    } finally {
      ids.destroy();
      files.destroy();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {checks: [], stdout: stdout.join('\n'), stderr: stderr.join('\n'), error: message, ms: Date.now() - started};
  } finally {
    pyodide.setStdout();
    pyodide.setStderr();
  }
}
