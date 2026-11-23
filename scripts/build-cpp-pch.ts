/**
 * Writes the C++ runtime's precompiled header next to its pack, before `yarn dev` and `yarn build`
 * (after fetch-cpp): lb/pch.h compiled for the committed public/cpp/runtime.pack.gz, the sysroot,
 * the compiler and the flags, as public/cpp/pch.gz with its manifest public/cpp/pch.json (both
 * gitignored). The browser worker fetches it in the background and uses it from the next compile
 * on (src/lib/runtime/cpp/pch.ts). Built once per runtime (about 50 s) and cached by what it was
 * built for (scripts/cpp-runtime.ts). A PCH that fails to build leaves none: the site compiles
 * without it, and this says so.
 */
import {copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';

import {CPP_RUNTIME_PACK, cppPch} from './cpp-runtime';

const PCH = 'public/cpp/pch.gz';
const MANIFEST = 'public/cpp/pch.json';

async function buildCppPch(): Promise<void> {
  const {path, manifest} = await cppPch(readFileSync(CPP_RUNTIME_PACK), line => console.log(line));
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // Already in place: the manifest is this one, and the file next to it has the PCH's size.
  const current = existsSync(MANIFEST) && readFileSync(MANIFEST, 'utf8') === text;
  if (current && existsSync(PCH) && statSync(PCH).size === manifest.gzipBytes) return;
  mkdirSync('public/cpp', {recursive: true});
  const tmp = `${PCH}.${process.pid}.tmp`;
  copyFileSync(path, tmp);
  renameSync(tmp, PCH);
  writeFileSync(MANIFEST, text);
  console.log(`${PCH} written (${(manifest.gzipBytes / 1e6).toFixed(1)} MB gzipped)`);
}

buildCppPch().catch(error => {
  // An old PCH would only be downloaded to be refused: the worker compiles without one.
  rmSync(PCH, {force: true});
  rmSync(MANIFEST, {force: true});
  const rule = '!'.repeat(100);
  console.error(
    [
      rule,
      '! The C++ precompiled header could not be built: C++ programs compile without it, a few seconds slower each.',
      `! ${error instanceof Error ? error.message : String(error)}`,
      rule,
    ].join('\n'),
  );
});
