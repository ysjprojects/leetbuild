/**
 * The hash of the Go runtime's sources (goruntime/, tests excluded): `yarn build:go` records it next
 * to the WebAssembly it builds (public/go/runtime.json), and `yarn verify` compares, so a runtime
 * built from other sources than the ones committed is caught.
 */
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';

export const GO_RUNTIME_DIR = 'goruntime';
export const GO_RUNTIME_MANIFEST = 'public/go/runtime.json';

const files = (dir: string): string[] =>
  readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('_test.go') ? [] : [path];
  });

export function goRuntimeHash(dir = GO_RUNTIME_DIR): string {
  const hash = createHash('sha256');
  for (const path of files(dir).sort()) {
    hash.update(relative(dir, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}
