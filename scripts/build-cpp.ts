/**
 * Builds the C++ runtime's pack, `yarn build:cpp`: compiles cppruntime/src with the compiler the
 * runtime ships (`@yowasp/clang`, clang compiled to WebAssembly) into libleetbuild.a, and packs it
 * with the headers (cppruntime/include) into public/cpp/runtime.pack.gz, which the browser worker
 * and `yarn verify` mount at /lb. Records the sources' hash in public/cpp/runtime.json; `yarn
 * verify` fails while it does not match (scripts/cpp-runtime.ts). Fetches the sysroot first.
 */
import {mkdirSync, renameSync, writeFileSync} from 'node:fs';

import {buildCppPack, CPP_RUNTIME_MANIFEST, CPP_RUNTIME_PACK, cppRuntimeHash} from './cpp-runtime';

async function buildCpp(): Promise<void> {
  const hash = cppRuntimeHash();
  const {packed, libraryBytes} = await buildCppPack(line => console.log(line));
  mkdirSync('public/cpp', {recursive: true});
  const tmp = `${CPP_RUNTIME_PACK}.${process.pid}.tmp`;
  writeFileSync(tmp, packed);
  renameSync(tmp, CPP_RUNTIME_PACK);
  writeFileSync(CPP_RUNTIME_MANIFEST, `${JSON.stringify({hash, libraryBytes, gzipBytes: packed.length}, null, 2)}\n`);
  console.log(`${CPP_RUNTIME_PACK} built (${(packed.length / 1e6).toFixed(2)} MB gzipped)`);
  if (cppRuntimeHash() !== hash) {
    console.log('cppruntime/ changed during the build: the pack is already stale, run yarn build:cpp again');
  }
}

buildCpp().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
