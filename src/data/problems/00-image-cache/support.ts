import {CPP_DIGEST_H} from '../cpp-support';
import {scalaTls} from '../scala-support';
import {protoFiles} from './proto';

/** C++ support of the image-cache starters: the resizer proto and sha256.h (step 1's ETag digest). */
export const supportModulesCpp: Record<string, string> = {
  ...protoFiles,
  'sha256.h': CPP_DIGEST_H,
};

/** Scala support of the image-cache starters: the shared `thumbs.Tls` helper. */
export const supportModulesScala: Record<string, string> = scalaTls('thumbs');
