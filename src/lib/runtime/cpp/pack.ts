/**
 * The file bundles the C++ runtime ships (`public/cpp/*.pack.gz`): the sysroot slice and the
 * runtime's own headers. A pack is a u32 (little-endian) length, a JSON index of `[path, size]`
 * pairs, then the files' bytes in index order; gzipped on disk. One reader for the worker and Node.
 */

/** A directory as clang (`@yowasp/clang`) mounts it: names to subtrees or file contents. */
export interface Tree {
  [name: string]: Tree | Uint8Array | string;
}

/** Pack `files` (path, bytes) into one buffer. */
export function pack(files: readonly [path: string, bytes: Uint8Array][]): Uint8Array {
  const index = new TextEncoder().encode(JSON.stringify(files.map(([path, bytes]) => [path, bytes.length])));
  const size = files.reduce((sum, [, bytes]) => sum + bytes.length, 4 + index.length);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, index.length, true);
  out.set(index, 4);
  let at = 4 + index.length;
  for (const [, bytes] of files) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** The files of a pack, by path. */
export function unpack(buffer: Uint8Array): [path: string, bytes: Uint8Array][] {
  const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length))) as [string, number][];
  const files: [string, Uint8Array][] = [];
  let at = 4 + length;
  for (const [path, size] of index) {
    files.push([path, buffer.subarray(at, at + size)]);
    at += size;
  }
  return files;
}

/** Mount `files` at `root` (a path like `sysroot`) in `tree`. */
export function mount(tree: Tree, root: string, files: readonly [string, Uint8Array][]): Tree {
  for (const [path, bytes] of files) {
    const parts = `${root}/${path}`.split('/').filter(part => part !== '');
    let dir = tree;
    for (const part of parts.slice(0, -1)) {
      const next = dir[part];
      if (next === undefined || typeof next === 'string' || next instanceof Uint8Array) dir[part] = {};
      dir = dir[part] as Tree;
    }
    dir[parts[parts.length - 1]] = bytes;
  }
  return tree;
}
