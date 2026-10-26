import {CPP_DIGEST_H} from '../cpp-support';

/**
 * C++ support of the feature gates: `sha256.h` (the assignment hash) and `gates.h`, step 2's
 * snapshot and decision as the later steps (the gRPC service, the exposure log) use them.
 */
export const supportModulesCpp: Record<string, string> = {
  'sha256.h': CPP_DIGEST_H,
  'gates.h': `// Step 2's snapshot and decision (gates.cpp), as the gRPC service and the exposure log use them.
#pragma once

#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <vector>

struct Share {
  std::string variant;
  int pct;
};

struct Population {
  std::map<std::string, std::string> match;
  std::vector<Share> mix;
};

struct Override {
  std::string user_id;
  std::string variant;
  long long expires_at;
};

// A gate as step 1 publishes it.
struct Gate {
  std::string name;
  std::string seed;
  std::string default_variant;
  std::vector<Population> populations;
  std::vector<Override> overrides;
  int version;
};

struct Snapshot {
  int version = 0;
  std::map<std::string, Gate> gates;
};

// Replaced whole by the loader (std::atomic_store): read it once with std::atomic_load(&snapshot).
extern std::shared_ptr<const Snapshot> snapshot;

// No I/O: unknown gate → OFF; unexpired override → its variant; first matching population → its share; else default.
std::string get_variant(const std::string& name, const std::map<std::string, std::string>& attrs);

// GET gates:version; unchanged → false. Otherwise HGETALL gates and replace the snapshot in one store.
bool refresh();

// Load once now, then refresh every interval in the background.
void start_loader(std::chrono::seconds interval = std::chrono::seconds{10});
`,
};

/**
 * Step 2's gates.cpp as its reference has it, for the C++ harnesses of steps 3 and 4: only the step's
 * own file is compiled, so the harness defines what gates.h declares (as the Go harness does).
 * start_loader is the loader's first poll; the checks call refresh() where its later polls would come.
 */
export const gatesStandInCpp = `#include <sw/redis++/redis++.h>

#include <atomic>
#include <ctime>
#include <iterator>

#include <nlohmann/json.hpp>

#include "sha256.h"

std::shared_ptr<const Snapshot> snapshot = std::make_shared<const Snapshot>();

namespace {

sw::redis::Redis& gatesRedis() {
  static sw::redis::Redis client("tcp://redis:6379");
  return client;
}

}  // namespace

std::string get_variant(const std::string& name, const std::map<std::string, std::string>& attrs) {
  const auto current = std::atomic_load(&snapshot);
  const auto found = current->gates.find(name);
  if (found == current->gates.end()) return "OFF";
  const Gate& gate = found->second;
  const auto user = attrs.find("user_id");
  const std::string user_id = user == attrs.end() ? "" : user->second;
  const long long now = std::time(nullptr);
  for (const auto& o : gate.overrides)
    if (o.user_id == user_id && o.expires_at > now) return o.variant;
  for (const auto& population : gate.populations) {
    bool matched = true;
    for (const auto& [key, value] : population.match) {
      const auto attr = attrs.find(key);
      matched = matched && attr != attrs.end() && attr->second == value;
    }
    if (!matched) continue;
    const int b = static_cast<int>(std::stoul(sha256_hex(gate.seed + ":" + user_id).substr(0, 8), nullptr, 16) % 10000);
    int edge = 0;
    for (const auto& share : population.mix) {
      edge += share.pct * 100;
      if (b < edge) return share.variant;
    }
    return population.mix.back().variant;
  }
  return gate.default_variant;
}

bool refresh() {
  const auto raw = gatesRedis().get("gates:version");
  const int version = raw ? std::stoi(*raw) : 0;
  if (version == std::atomic_load(&snapshot)->version) return false;
  std::map<std::string, std::string> fields;
  gatesRedis().hgetall("gates", std::inserter(fields, fields.begin()));
  auto next = std::make_shared<Snapshot>();
  next->version = version;
  for (const auto& [name, body] : fields) {
    const auto j = nlohmann::json::parse(body);
    Gate gate;
    gate.name = j.at("name");
    gate.seed = j.at("seed");
    gate.default_variant = j.value("default", "OFF");
    gate.version = j.value("version", 0);
    for (const auto& p : j.at("populations")) {
      Population population;
      for (const auto& [key, value] : p.at("match").items()) population.match[key] = value;
      for (const auto& s : p.at("mix")) population.mix.push_back({s.at("variant"), s.at("pct")});
      gate.populations.push_back(population);
    }
    for (const auto& o : j.value("overrides", nlohmann::json::array()))
      gate.overrides.push_back({o.at("user_id"), o.at("variant"), o.at("expires_at")});
    next->gates[name] = gate;
  }
  std::atomic_store(&snapshot, std::shared_ptr<const Snapshot>(next));
  return true;
}

void start_loader(std::chrono::seconds) { refresh(); }
`;
