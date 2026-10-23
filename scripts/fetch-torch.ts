/**
 * Fetches the PyTorch wheel the deep-learning problems run on into `public/py/torch/` (gitignored):
 * an unofficial CPU build of PyTorch for Pyodide (https://github.com/mmtftr/pyodide-pytorch, MIT),
 * pinned to one release and checked against its SHA-256, so the site serves it from its own origin
 * (GitHub's release downloads send no CORS headers). Runs before `yarn dev` and `yarn build`, and
 * `yarn verify` calls it; a present file with the right digest is not downloaded again.
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

import {TORCH_WHEEL} from '../src/lib/runtime/python';

const RELEASE = 'torch-2.13.0-pyodide-314.0.2-r7';
const URL = `https://github.com/mmtftr/pyodide-pytorch/releases/download/${RELEASE}/${encodeURIComponent(TORCH_WHEEL)}`;
const SHA256 = '074e99919ddc271a0e955c90dac57a0aab5569db5bcf3ae0941b75e11b8a5e69';

/** Where the wheel lives: `public/py/torch/<wheel>`, served as `/py/torch/<wheel>`. */
export const TORCH_WHEEL_PATH = resolve('public/py/torch', TORCH_WHEEL);

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Make sure the pinned wheel is in place; download it when it is missing or not the pinned file. */
export async function fetchTorch(): Promise<void> {
  if (existsSync(TORCH_WHEEL_PATH) && digest(readFileSync(TORCH_WHEEL_PATH)) === SHA256) return;
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`downloading ${URL}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = digest(bytes);
  if (got !== SHA256) throw new Error(`${TORCH_WHEEL}: SHA-256 ${got}, expected ${SHA256}`);
  mkdirSync(dirname(TORCH_WHEEL_PATH), {recursive: true});
  const tmp = `${TORCH_WHEEL_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, TORCH_WHEEL_PATH);
  console.log(`public/py/torch/${TORCH_WHEEL} fetched (${(bytes.length / 1e6).toFixed(1)} MB)`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename)) {
  fetchTorch().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
