/**
 * Builds the Go runtime (goruntime/: the yaegi interpreter, the symbol tables, the models, the
 * harness) to WebAssembly: `public/go/runtime.wasm.gz`, which the Go worker and `yarn verify` load,
 * and `public/go/runtime.json` with the hash of the sources it was built from. Needs the Go
 * toolchain (go 1.27); run `yarn build:go` after editing goruntime/. The symbol tables are
 * regenerated first, so a model's new export is visible to interpreted code; `--lenient` skips a
 * model that does not type-check yet (development only: its library is then missing).
 *
 * Builds take a machine-wide lock, so concurrent ones run one after another, and replace their
 * outputs atomically, so a `yarn verify` starting mid-build loads the previous runtime whole.
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

import {GO_RUNTIME_DIR, GO_RUNTIME_MANIFEST, goRuntimeHash} from './go-runtime';

const LOCK = join(tmpdir(), 'leetbuild-go-build.lock');
/** A lock older than this is a crashed build's: a build takes about a minute. */
const STALE_LOCK_MS = 15 * 60_000;

const go = (args: string[], env: NodeJS.ProcessEnv = process.env): void => {
  execFileSync('go', args, {cwd: GO_RUNTIME_DIR, env, stdio: 'inherit'});
};

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function lock(): void {
  for (let waited = false; ; ) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_LOCK_MS) rmSync(LOCK, {recursive: true, force: true});
    } catch {
      // released meanwhile
    }
    if (!waited) console.log('another Go runtime build is running; waiting for it');
    waited = true;
    sleep(2000);
  }
}

/** Writes path through a temporary file and a rename, so readers never see it half written. */
function replace(path: string, data: Buffer | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function main(): void {
  lock();
  const dir = mkdtempSync(join(tmpdir(), 'leetbuild-go-'));
  try {
    go(['run', './cmd/gensyms', ...(process.argv.includes('--lenient') ? ['-lenient'] : [])]);
    const hash = goRuntimeHash();
    const out = join(dir, 'runtime.wasm');
    go(['build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/wasm'], {...process.env, GOOS: 'js', GOARCH: 'wasm'});
    const wasm = readFileSync(out);
    const packed = gzipSync(wasm, {level: 9});
    replace(resolve('public/go/runtime.wasm.gz'), packed);
    replace(
      resolve(GO_RUNTIME_MANIFEST),
      `${JSON.stringify({hash, wasmBytes: wasm.length, gzipBytes: packed.length}, null, 2)}\n`,
    );
    console.log(`public/go/runtime.wasm.gz built (${(packed.length / 1e6).toFixed(1)} MB gzipped)`);
    if (goRuntimeHash() !== hash) {
      console.log('goruntime/ changed during the build: the runtime is already stale, run yarn build:go again');
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
    rmSync(LOCK, {recursive: true, force: true});
  }
}

main();
