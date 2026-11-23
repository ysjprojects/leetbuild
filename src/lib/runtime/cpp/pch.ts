/**
 * The C++ runtime's precompiled header: cppruntime/include/lb/pch.h, the headers every step
 * program's harness includes, compiled once per runtime pack, sysroot, compiler and flags
 * (scripts/cpp-runtime.ts builds it; `yarn dev`/`yarn build` write it to public/cpp/pch.gz with its
 * manifest public/cpp/pch.json). Every program force-includes lb/pch.h: from the PCH when the host
 * has the one built for what it mounted, parsed from the pack otherwise, so a program means the
 * same either way and only compiles faster with it. One module for the worker, Node and the scripts.
 */
import {COMPILE_FLAGS} from './flags';

/** The header, as the programs' -include names it (found in the runtime pack's include/). */
export const PCH_HEADER = 'lb/pch.h';
/** Where a program's compile mounts the PCH: /pch/lb.pch. */
export const PCH_DIR = 'pch';
export const PCH_FILE = 'lb.pch';
export const PCH_PATH = `/${PCH_DIR}/${PCH_FILE}`;

/**
 * Building it: the programs' own flags, the header compiled as a C++ header. No timestamps in the
 * PCH: the files clang reads come from packs, and the manifest, not their dates, says which.
 */
export const PCH_BUILD_ARGS = [
  ...COMPILE_FLAGS,
  '-Xclang',
  '-fno-pch-timestamp',
  '-x',
  'c++-header',
  `/lb/include/${PCH_HEADER}`,
  '-o',
  PCH_PATH,
];

/** What a PCH was built for: it serves only a compile with the same packs, compiler and flags. */
export interface PchIdentity {
  /** SHA-256 of the runtime pack (public/cpp/runtime.pack.gz, or the one `yarn verify` built), gzipped as served. */
  runtime: string;
  /** SHA-256 of the sysroot pack (public/cpp/sysroot.pack.gz). */
  sysroot: string;
  clang: string;
  args: string[];
}

/** public/cpp/pch.json: what the PCH in public/cpp/pch.gz was built for, and its digest once inflated. */
export interface PchManifest {
  identity: PchIdentity;
  sha256: string;
  bytes: number;
  gzipBytes: number;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export const pchIdentity = async (
  runtimePack: Uint8Array,
  sysrootPack: Uint8Array,
  clang: string,
): Promise<PchIdentity> => ({
  runtime: await sha256Hex(runtimePack),
  sysroot: await sha256Hex(sysrootPack),
  clang,
  args: PCH_BUILD_ARGS,
});
