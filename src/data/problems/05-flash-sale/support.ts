/** Hand-written C++ support the flash-sale starters include but no step builds: `ids.h` (order ids). */
import {CPP_IDS_H} from '../cpp-support';

export const supportModulesCpp: Record<string, string> = {
  'ids.h': `${CPP_IDS_H}
// new_order_id() is a fresh order id: a random UUID as 32 hex digits, without dashes.
inline std::string new_order_id() {
  std::string id;
  for (const char c : new_uuid())
    if (c != '-') id += c;
  return id;
}
`,
};
