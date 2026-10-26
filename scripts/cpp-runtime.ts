/**
 * The C++ runtime's pack (public/cpp/runtime.pack.gz): what it is built from and how. Its hash
 * covers the sources (cppruntime/), the flags, the sysroot release and the compiler's version;
 * `yarn build:cpp` records it next to the pack (public/cpp/runtime.json), and `yarn verify`
 * compares, so a pack built from other sources than the ones committed is caught. While the
 * committed pack is stale, `yarn verify` runs the checks on one built from the sources in the tree
 * (cached by hash under node_modules/.cache), so the runtime can be worked on without rebuilding
 * the committed pack after every edit.
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';

import {COMPILE_FLAGS, LINK_FLAGS} from '../src/lib/runtime/cpp/flags';
import {type Tree, mount, pack, unpack} from '../src/lib/runtime/cpp/pack';
import {fetchCpp, SYSROOT_PACK, SYSROOT_SHA256} from './fetch-cpp';

export const CPP_RUNTIME_DIR = 'cppruntime';
export const CPP_RUNTIME_PACK = 'public/cpp/runtime.pack.gz';
export const CPP_RUNTIME_MANIFEST = 'public/cpp/runtime.json';
const CACHE = 'node_modules/.cache/leetbuild-cpp';
/**
 * Objects of the library, ccache-style: by their source and the flags (`<source key>.deps.json`
 * lists the runtime headers its last compile read), then by those headers' contents
 * (`<object key>.o`), so editing one model recompiles the sources that include it, not all of them.
 */
const OBJECTS = join(CACHE, 'objects');

const sha256 = (...parts: (string | Uint8Array)[]): string => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
};

const files = (dir: string): string[] =>
  readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });

/** The compiler's version, from its package. */
export const clangVersion = (): string =>
  (JSON.parse(readFileSync('node_modules/@yowasp/clang/package.json', 'utf8')) as {version: string}).version;

export function cppRuntimeHash(dir = CPP_RUNTIME_DIR): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({COMPILE_FLAGS, LINK_FLAGS, sysroot: SYSROOT_SHA256, clang: clangVersion()}));
  for (const path of files(dir).sort()) {
    hash.update(relative(dir, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

/** Whether the committed pack was built from the sources in the tree. */
export function cppRuntimeFresh(): boolean {
  if (!existsSync(CPP_RUNTIME_MANIFEST)) return false;
  return (JSON.parse(readFileSync(CPP_RUNTIME_MANIFEST, 'utf8')) as {hash?: string}).hash === cppRuntimeHash();
}

/**
 * Compile cppruntime/src with the compiler the runtime ships (`@yowasp/clang`) into
 * libleetbuild.a, and pack it with the headers: the gzipped pack, and the library's size.
 */
export async function buildCppPack(log: (line: string) => void = () => undefined): Promise<{
  packed: Uint8Array;
  libraryBytes: number;
}> {
  await fetchCpp();
  const {commands} = await import('@yowasp/clang');
  const quiet = {fetchProgress: () => undefined};
  await commands['clang++'](null as unknown as string[], {}, quiet);
  const sysroot = mount({}, '', unpack(gunzipSync(readFileSync(SYSROOT_PACK))));
  const include = join(CPP_RUNTIME_DIR, 'include');
  // One read of the headers serves the compiles, the objects' keys and the pack, so an edit during the build cannot mix them.
  const headerFiles = new Map(files(include).map(path => [relative(include, path), readFileSync(path)]));
  const headers = mount({}, '', [...headerFiles]);
  const src = join(CPP_RUNTIME_DIR, 'src');
  const sources = readdirSync(src)
    .filter(name => name.endsWith('.cpp'))
    .sort();
  // -O2 for the library: built once, run by every program.
  const flags = [...COMPILE_FLAGS, '-O2', '-Wall'];
  // Which headers exist is part of every object's key: a header added to the runtime can shadow one the sysroot provided.
  const compiler = JSON.stringify({
    flags,
    sysroot: SYSROOT_SHA256,
    clang: clangVersion(),
    headers: [...headerFiles.keys()].sort(),
  });
  const objectKey = (sourceKey: string, deps: string[]): string =>
    sha256(sourceKey, ...deps.flatMap(path => [path, headerFiles.get(path) ?? '\0missing']));
  mkdirSync(OBJECTS, {recursive: true});
  const objects: Tree = {};
  for (const name of sources) {
    const object = name.replace(/\.cpp$/, '.o');
    const source = readFileSync(join(src, name));
    const sourceKey = sha256(compiler, name, source);
    const depsPath = join(OBJECTS, `${sourceKey}.deps.json`);
    if (existsSync(depsPath)) {
      const cached = join(OBJECTS, `${objectKey(sourceKey, JSON.parse(readFileSync(depsPath, 'utf8')) as string[])}.o`);
      if (existsSync(cached)) {
        objects[object] = readFileSync(cached);
        continue;
      }
    }
    const began = Date.now();
    let diagnostics = '';
    const collect = (bytes: Uint8Array | null): void => {
      if (bytes !== null) diagnostics += new TextDecoder().decode(bytes);
    };
    let out: Tree;
    try {
      out = (
        (await commands['clang++'](
          [...flags, '-MD', '-MF', `/out/${object}.d`, '-c', `/src/${name}`, '-o', `/out/${object}`],
          {sysroot, lb: {include: headers}, src: {[name]: source}, out: {}},
          {stdout: collect, stderr: collect, ...quiet},
        )) as Tree
      ).out as Tree;
    } catch {
      throw new Error(`cppruntime/src/${name} does not compile:\n${diagnostics}`);
    }
    objects[object] = out[object];
    // The depfile (make syntax, handed back as text) names every file the compile read; the runtime's headers are the ones that vary.
    const depfile = out[`${object}.d`];
    const deps = [
      ...new Set(
        (typeof depfile === 'string' ? depfile : new TextDecoder().decode(depfile as Uint8Array))
          .split(/\s+/)
          .filter(token => token.startsWith('/lb/include/'))
          .map(token => token.slice('/lb/include/'.length)),
      ),
    ].sort();
    writeAtomically(join(OBJECTS, `${objectKey(sourceKey, deps)}.o`), out[object] as Uint8Array);
    writeAtomically(depsPath, JSON.stringify(deps));
    if (diagnostics.trim() !== '') log(diagnostics.trim());
    log(`cppruntime/src/${name} compiled (${((Date.now() - began) / 1000).toFixed(1)} s)`);
  }
  const archived = (await commands.ar(
    ['rcs', '/out/libleetbuild.a', ...Object.keys(objects).map(o => `/out/${o}`)],
    {out: objects},
    {stdout: null, stderr: null, ...quiet},
  )) as Tree;
  const library = (archived.out as Tree)['libleetbuild.a'] as Uint8Array;
  const packed = gzipSync(
    pack([
      ...[...headerFiles].map(([path, bytes]): [string, Uint8Array] => [`include/${path}`, bytes]),
      ['lib/libleetbuild.a', library],
    ]),
    {level: 9},
  );
  return {packed, libraryBytes: library.length};
}

/** Write a file whole or not at all: concurrent `yarn verify` runs share the cache. */
function writeAtomically(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** A pack built from the sources in the tree, cached by their hash. */
export async function cppPackFromSources(log: (line: string) => void = () => undefined): Promise<Uint8Array> {
  const path = join(CACHE, `${cppRuntimeHash()}.pack.gz`);
  if (existsSync(path)) return readFileSync(path);
  const {packed} = await buildCppPack(log);
  mkdirSync(CACHE, {recursive: true});
  writeAtomically(path, packed);
  return packed;
}
