/**
 * A worker of `yarn verify`'s C++ precompile: compiles its share of the C++ jobs (every `count`-th
 * from `index`, of a JSON file of RunJobs) into the program cache directory, so the checks that
 * follow load each program instead of compiling them one after another. Clang runs single-threaded
 * in WebAssembly; a process per core is what makes the compiles parallel.
 *
 *   tsx scripts/cpp-compile-worker.ts <jobs.json> <program-dir> <index> <count>
 */
import {readFileSync} from 'node:fs';

import {createNodeCppRuntime} from '../src/lib/runtime/node';
import type {RunJob} from '../src/lib/runtime/types';
import {cppPackFromSources, cppRuntimeFresh} from './cpp-runtime';

async function main(): Promise<void> {
  // A worker outlives nothing: when `yarn verify` goes, so does its IPC channel, and so does the worker.
  process.on('disconnect', () => process.exit(1));
  const [file, programs, index, count] = process.argv.slice(2);
  const jobs = JSON.parse(readFileSync(file, 'utf8')) as RunJob[];
  const runtime = await createNodeCppRuntime(cppRuntimeFresh() ? undefined : await cppPackFromSources(), programs);
  for (let i = Number(index); i < jobs.length; i += Number(count)) await runtime.compile(jobs[i]);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
