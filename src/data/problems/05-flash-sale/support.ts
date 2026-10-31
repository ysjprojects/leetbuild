/** Hand-written support the flash-sale starters include but no step builds: C++ `ids.h` (order ids), Scala `flashsale.Tls`. */
import {CPP_IDS_H} from '../cpp-support';
import {scalaTls} from '../scala-support';

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

export const supportModulesScala: Record<string, string> = {
  ...scalaTls('flashsale'),
};
