import {CPP_DIGEST_H} from '../cpp-support';
import {protoFiles} from './proto';

/** C++ support of the image-cache starters: the resizer proto and sha256.h (step 1's ETag digest). */
export const supportModulesCpp: Record<string, string> = {
  ...protoFiles,
  'sha256.h': CPP_DIGEST_H,
};
