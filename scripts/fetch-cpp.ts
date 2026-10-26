/**
 * Fetches the C/C++ sysroot the C++ runtime compiles against into `public/cpp/sysroot.pack.gz`
 * (gitignored): wasi-sdk's (https://github.com/WebAssembly/wasi-sdk, Apache-2.0 WITH
 * LLVM-exception), pinned to one release and checked against its SHA-256, reduced to the slice the
 * runtime uses: wasm32-wasip1 with C++ exceptions (libc, libc++ and libc++abi built for wasm
 * exceptions, libunwind), about 6 MB gzipped instead of the release's 119 MB. The compiler itself,
 * clang and wasm-ld compiled to WebAssembly (`@yowasp/clang`), comes from npm in Node and from the
 * CDN in the browser. Runs before `yarn dev` and `yarn build`, and `yarn verify` calls it; a present
 * pack made from the pinned release is not fetched again.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

import {pack} from '../src/lib/runtime/cpp/pack';

const RELEASE = 'wasi-sdk-34';
const URL = `https://github.com/WebAssembly/wasi-sdk/releases/download/${RELEASE}/wasi-sysroot-34.0.tar.gz`;
/** The release tarball's digest: what the slice is cut from, and part of the runtime pack's hash. */
export const SYSROOT_SHA256 = '9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be';
const TARGET = 'wasm32-wasip1';

/** The pack, served as `/cpp/sysroot.pack.gz`; the stamp next to it names the release it was made from. */
export const SYSROOT_PACK = resolve('public/cpp/sysroot.pack.gz');
const STAMP = resolve('public/cpp/sysroot.json');

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Files under `dir`, as paths relative to `root`, minus what the runtime never uses. */
const slice = (root: string, dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    // noeh: the libraries built without exceptions; llvm-lto: bitcode for LTO; .so: shared libraries.
    if (name === 'noeh' || name === 'llvm-lto' || name.endsWith('.so')) return [];
    return statSync(path).isDirectory() ? slice(root, path) : [relative(root, path)];
  });

/** Make sure the pinned sysroot slice is in place; download and cut it when it is missing or stale. */
export async function fetchCpp(): Promise<void> {
  if (existsSync(SYSROOT_PACK) && existsSync(STAMP)) {
    const stamp = JSON.parse(readFileSync(STAMP, 'utf8')) as {sha256?: string};
    if (stamp.sha256 === SYSROOT_SHA256) return;
  }
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`downloading ${URL}: ${response.status} ${response.statusText}`);
  const tarball = new Uint8Array(await response.arrayBuffer());
  const got = digest(tarball);
  if (got !== SYSROOT_SHA256) throw new Error(`wasi-sysroot: SHA-256 ${got}, expected ${SYSROOT_SHA256}`);
  const dir = mkdtempSync(join(tmpdir(), 'leetbuild-sysroot-'));
  try {
    writeFileSync(join(dir, 'sysroot.tar.gz'), tarball);
    execFileSync('tar', ['-xzf', 'sysroot.tar.gz', '--strip-components=1'], {cwd: dir});
    const files = [...slice(dir, join(dir, 'include', TARGET)), ...slice(dir, join(dir, 'lib', TARGET))].sort();
    const packed = gzipSync(pack(files.map(path => [path, readFileSync(join(dir, path))])), {level: 9});
    mkdirSync(resolve('public/cpp'), {recursive: true});
    const tmp = `${SYSROOT_PACK}.${process.pid}.tmp`;
    writeFileSync(tmp, packed);
    renameSync(tmp, SYSROOT_PACK);
    writeFileSync(
      STAMP,
      `${JSON.stringify({release: RELEASE, sha256: SYSROOT_SHA256, files: files.length}, null, 2)}\n`,
    );
    console.log(`public/cpp/sysroot.pack.gz fetched (${files.length} files, ${(packed.length / 1e6).toFixed(1)} MB)`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename)) {
  fetchCpp().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
