/**
 * Hand-written support modules the service-discovery steps import but no step builds: the
 * `discovery` package. `discovery.registry` is the deployment registry (the course's stand-in for
 * the service catalogue the deploy pipeline writes): each service's declared CIDR, each mesh
 * identity's grants, and an IPv4 CIDR test. `discovery.instances` is the instance record layout every
 * step shares: the record hash and its TTL, the members set, the shared probe verdict, and the
 * registration write of step 1 as later steps and the checks use it. `discovery.outbox` is the list a
 * relay republishes from. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'discovery/__init__.py': '',
  'discovery/registry.py': `"""
The deployment registry (provided): sd:deploy:{service} holds the CIDR the service's deployment
declared, sd:grants:{client_id} the set of services a mesh identity may register instances into.
in_cidr tests an IPv4 literal against a CIDR and is False for anything that does not parse.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def deployment_cidr(service: str) -> str | None:
    """The CIDR the service's deployment declared, or None when no such service is deployed."""
    return r.get(f"sd:deploy:{service}")


def allowed_services(client_id: str) -> set[str]:
    """The services client_id may register instances into."""
    return set(r.smembers(f"sd:grants:{client_id}"))


def _ipv4(text: str) -> int | None:
    parts = text.split(".")
    if len(parts) != 4 or not all(p.isascii() and p.isdigit() and len(p) <= 3 and int(p) <= 255 for p in parts):
        return None
    value = 0
    for part in parts:
        value = value * 256 + int(part)
    return value


def in_cidr(address: str, cidr: str) -> bool:
    """Whether the IPv4 literal address lies inside cidr ("10.4.0.0/16")."""
    base, _, bits = cidr.partition("/")
    ip, network = _ipv4(address), _ipv4(base)
    if ip is None or network is None or not bits.isdigit() or int(bits) > 32:
        return False
    block = 2 ** (32 - int(bits))
    return ip // block == network // block


def define_service(service: str, cidr: str) -> None:
    """Deploy a service into cidr (what the deploy pipeline writes)."""
    r.set(f"sd:deploy:{service}", cidr)


def grant(client_id: str, service: str) -> None:
    """Let client_id register instances into service."""
    r.sadd(f"sd:grants:{client_id}", service)
`,
  'discovery/instances.py': `"""
The instance records (provided). sd:{service}:{instance_id} is a hash (address, port,
heartbeat_interval, metadata_version, last_heartbeat in Unix seconds; every field a string) that
expires TTL_INTERVALS heartbeat intervals after its last write. sd:members:{service} is the set of
instance ids registered and not yet announced as expired. sd:probe:{service}:{instance_id} is the
shared probe verdict, SERVING or NOT_SERVING, with a short TTL. register_instance is the write step 1
builds, as later steps and the checks use it.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_INTERVALS = 3


def record_key(service: str, instance_id: str) -> str:
    return f"sd:{service}:{instance_id}"


def members_key(service: str) -> str:
    return f"sd:members:{service}"


def verdict_key(service: str, instance_id: str) -> str:
    return f"sd:probe:{service}:{instance_id}"


def register_instance(service: str, instance_id: str, address: str, port: int, heartbeat_interval: int, metadata_version: int) -> int:
    """Write the record with its expiry and add the instance to the members set, in one MULTI; returns the TTL."""
    ttl = TTL_INTERVALS * heartbeat_interval
    key = record_key(service, instance_id)
    pipe = r.pipeline(transaction=True)
    pipe.hset(key, mapping={
        "address": address,
        "port": port,
        "heartbeat_interval": heartbeat_interval,
        "metadata_version": metadata_version,
        "last_heartbeat": int(time.time()),
    })
    pipe.expire(key, ttl)
    pipe.sadd(members_key(service), instance_id)
    pipe.execute()
    return ttl


def lookup(service: str, instance_id: str) -> dict | None:
    """The live record (address, port, heartbeat_interval, metadata_version, last_heartbeat), or None once it lapsed."""
    raw = r.hgetall(record_key(service, instance_id))
    if not raw:
        return None
    number = lambda name: int(raw.get(name) or 0)
    return {
        "address": raw.get("address", ""),
        "port": number("port"),
        "heartbeat_interval": number("heartbeat_interval"),
        "metadata_version": number("metadata_version"),
        "last_heartbeat": number("last_heartbeat"),
    }


def members(service: str) -> list[str]:
    """The ids in the members set, sorted."""
    return sorted(r.smembers(members_key(service)))


def verdict(service: str, instance_id: str) -> str | None:
    """The shared probe verdict (SERVING or NOT_SERVING), or None when no probe is on record."""
    return r.get(verdict_key(service, instance_id))
`,
  'discovery/outbox.py': `"""
The outbox (provided): the Redis list sd:outbox of JSON rows {"topic", "key", "payload"} that a
relay republishes once the broker takes writes again.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def write(topic: str, key: str, payload: dict) -> None:
    """Queue a record the broker did not take."""
    r.rpush("sd:outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def rows() -> list[dict]:
    """Everything queued, oldest first."""
    return [json.loads(row) for row in r.lrange("sd:outbox", 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'discovery/registry.ts': `/**
 * The deployment registry (provided): sd:deploy:{service} holds the CIDR the service's deployment
 * declared, sd:grants:{client_id} the set of services a mesh identity may register instances into.
 * inCidr tests an IPv4 literal against a CIDR and is false for anything that does not parse.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The CIDR the service's deployment declared, or null when no such service is deployed. */
export async function deploymentCidr(service: string): Promise<string | null> {
  return redis.get(\`sd:deploy:\${service}\`);
}

/** The services clientId may register instances into. */
export async function allowedServices(clientId: string): Promise<Set<string>> {
  return new Set(await redis.smembers(\`sd:grants:\${clientId}\`));
}

function ipv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** Whether the IPv4 literal address lies inside cidr ("10.4.0.0/16"). */
export function inCidr(address: string, cidr: string): boolean {
  const [base, bits = ''] = cidr.split('/');
  const ip = ipv4(address);
  const network = ipv4(base);
  if (ip === null || network === null || !/^\\d{1,2}$/.test(bits) || Number(bits) > 32) return false;
  const block = 2 ** (32 - Number(bits));
  return Math.floor(ip / block) === Math.floor(network / block);
}

/** Deploy a service into cidr (what the deploy pipeline writes). */
export async function defineService(service: string, cidr: string): Promise<void> {
  await redis.set(\`sd:deploy:\${service}\`, cidr);
}

/** Let clientId register instances into service. */
export async function grant(clientId: string, service: string): Promise<void> {
  await redis.sadd(\`sd:grants:\${clientId}\`, service);
}
`,
  'discovery/instances.ts': `/**
 * The instance records (provided). sd:{service}:{instance_id} is a hash (address, port,
 * heartbeat_interval, metadata_version, last_heartbeat in Unix seconds; every field a string) that
 * expires TTL_INTERVALS heartbeat intervals after its last write. sd:members:{service} is the set of
 * instance ids registered and not yet announced as expired. sd:probe:{service}:{instance_id} is the
 * shared probe verdict, SERVING or NOT_SERVING, with a short TTL. registerInstance is the write step 1
 * builds, as later steps and the checks use it.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_INTERVALS = 3;

export interface Instance {
  address: string;
  port: number;
  heartbeat_interval: number;
  metadata_version: number;
  last_heartbeat: number;
}

export const recordKey = (service: string, instanceId: string): string => \`sd:\${service}:\${instanceId}\`;
export const membersKey = (service: string): string => \`sd:members:\${service}\`;
export const verdictKey = (service: string, instanceId: string): string => \`sd:probe:\${service}:\${instanceId}\`;

/** Write the record with its expiry and add the instance to the members set, in one MULTI; returns the TTL. */
export async function registerInstance(
  service: string,
  instanceId: string,
  address: string,
  port: number,
  heartbeatInterval: number,
  metadataVersion: number,
): Promise<number> {
  const ttl = TTL_INTERVALS * heartbeatInterval;
  const key = recordKey(service, instanceId);
  await redis
    .multi()
    .hset(key, {
      address,
      port: String(port),
      heartbeat_interval: String(heartbeatInterval),
      metadata_version: String(metadataVersion),
      last_heartbeat: String(Math.floor(Date.now() / 1000)),
    })
    .expire(key, ttl)
    .sadd(membersKey(service), instanceId)
    .exec();
  return ttl;
}

/** The live record, or null once it lapsed. */
export async function lookup(service: string, instanceId: string): Promise<Instance | null> {
  const raw = await redis.hgetall(recordKey(service, instanceId));
  if (Object.keys(raw).length === 0) return null;
  const number = (name: string): number => Number(raw[name] ?? 0) || 0;
  return {
    address: raw.address ?? '',
    port: number('port'),
    heartbeat_interval: number('heartbeat_interval'),
    metadata_version: number('metadata_version'),
    last_heartbeat: number('last_heartbeat'),
  };
}

/** The ids in the members set, sorted. */
export async function members(service: string): Promise<string[]> {
  return (await redis.smembers(membersKey(service))).sort();
}

/** The shared probe verdict (SERVING or NOT_SERVING), or null when no probe is on record. */
export async function verdict(service: string, instanceId: string): Promise<string | null> {
  return redis.get(verdictKey(service, instanceId));
}
`,
  'discovery/outbox.ts': `/**
 * The outbox (provided): the Redis list sd:outbox of JSON rows {"topic", "key", "payload"} that a
 * relay republishes once the broker takes writes again.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface OutboxRow {
  topic: string;
  key: string;
  payload: Record<string, unknown>;
}

/** Queue a record the broker did not take. */
export async function write(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('sd:outbox', JSON.stringify({topic, key, payload}));
}

/** Everything queued, oldest first. */
export async function rows(): Promise<OutboxRow[]> {
  return (await redis.lrange('sd:outbox', 0, -1)).map(row => JSON.parse(row) as OutboxRow);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'discovery/registry/registry.go': `// Package registry is the deployment registry (provided): sd:deploy:{service} holds the CIDR the
// service's deployment declared, sd:grants:{client_id} the set of services a mesh identity may
// register instances into. InCIDR tests an IPv4 literal against a CIDR and is false for anything
// that does not parse.
package registry

import (
	"context"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// DeploymentCIDR is the CIDR the service's deployment declared; ok is false when no such service is deployed.
func DeploymentCIDR(ctx context.Context, service string) (cidr string, ok bool, err error) {
	cidr, err = rdb.Get(ctx, "sd:deploy:"+service).Result()
	if err == redis.Nil {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return cidr, true, nil
}

// AllowedServices is the set of services clientID may register instances into.
func AllowedServices(ctx context.Context, clientID string) (map[string]bool, error) {
	names, err := rdb.SMembers(ctx, "sd:grants:"+clientID).Result()
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(names))
	for _, name := range names {
		out[name] = true
	}
	return out, nil
}

func ipv4(text string) (uint64, bool) {
	parts := strings.Split(text, ".")
	if len(parts) != 4 {
		return 0, false
	}
	var value uint64
	for _, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || part == "" || len(part) > 3 || strings.TrimLeft(part, "0123456789") != "" || n > 255 {
			return 0, false
		}
		value = value*256 + uint64(n)
	}
	return value, true
}

// InCIDR reports whether the IPv4 literal address lies inside cidr ("10.4.0.0/16").
func InCIDR(address, cidr string) bool {
	base, bits, found := strings.Cut(cidr, "/")
	ip, ok1 := ipv4(address)
	network, ok2 := ipv4(base)
	n, err := strconv.Atoi(bits)
	if !found || !ok1 || !ok2 || err != nil || n < 0 || n > 32 {
		return false
	}
	block := uint64(1) << uint(32-n)
	return ip/block == network/block
}

// DefineService deploys a service into cidr (what the deploy pipeline writes).
func DefineService(ctx context.Context, service, cidr string) error {
	return rdb.Set(ctx, "sd:deploy:"+service, cidr, 0).Err()
}

// Grant lets clientID register instances into service.
func Grant(ctx context.Context, clientID, service string) error {
	return rdb.SAdd(ctx, "sd:grants:"+clientID, service).Err()
}
`,
  'discovery/instances/instances.go': `// Package instances is the instance record layout (provided). sd:{service}:{instance_id} is a hash
// (address, port, heartbeat_interval, metadata_version, last_heartbeat in Unix seconds; every field a
// string) that expires TTLIntervals heartbeat intervals after its last write. sd:members:{service}
// is the set of instance ids registered and not yet announced as expired.
// sd:probe:{service}:{instance_id} is the shared probe verdict, SERVING or NOT_SERVING, with a short
// TTL. RegisterInstance is the write step 1 builds, as later steps and the checks use it.
package instances

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TTLIntervals is how many heartbeat intervals a record outlives its last write.
const TTLIntervals = 3

// Instance is a live record.
type Instance struct {
	Address           string \`json:"address"\`
	Port              int    \`json:"port"\`
	HeartbeatInterval int    \`json:"heartbeat_interval"\`
	MetadataVersion   int    \`json:"metadata_version"\`
	LastHeartbeat     int64  \`json:"last_heartbeat"\`
}

// RecordKey is the instance's record hash.
func RecordKey(service, instanceID string) string { return "sd:" + service + ":" + instanceID }

// MembersKey is the service's members set.
func MembersKey(service string) string { return "sd:members:" + service }

// VerdictKey is the instance's shared probe verdict.
func VerdictKey(service, instanceID string) string { return "sd:probe:" + service + ":" + instanceID }

// RegisterInstance writes the record with its expiry and adds the instance to the members set, in one MULTI; it returns the TTL in seconds.
func RegisterInstance(ctx context.Context, service, instanceID, address string, port, heartbeatInterval, metadataVersion int) (int, error) {
	ttl := TTLIntervals * heartbeatInterval
	key := RecordKey(service, instanceID)
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, key, map[string]any{
			"address":            address,
			"port":               port,
			"heartbeat_interval": heartbeatInterval,
			"metadata_version":   metadataVersion,
			"last_heartbeat":     time.Now().Unix(),
		})
		pipe.Expire(ctx, key, time.Duration(ttl)*time.Second)
		pipe.SAdd(ctx, MembersKey(service), instanceID)
		return nil
	})
	return ttl, err
}

// Lookup is the live record, or nil once it lapsed.
func Lookup(ctx context.Context, service, instanceID string) (*Instance, error) {
	raw, err := rdb.HGetAll(ctx, RecordKey(service, instanceID)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	number := func(name string) int64 {
		n, _ := strconv.ParseInt(raw[name], 10, 64)
		return n
	}
	return &Instance{
		Address:           raw["address"],
		Port:              int(number("port")),
		HeartbeatInterval: int(number("heartbeat_interval")),
		MetadataVersion:   int(number("metadata_version")),
		LastHeartbeat:     number("last_heartbeat"),
	}, nil
}

// Members is the ids in the members set, sorted.
func Members(ctx context.Context, service string) ([]string, error) {
	ids, err := rdb.SMembers(ctx, MembersKey(service)).Result()
	sort.Strings(ids)
	return ids, err
}

// Verdict is the shared probe verdict (SERVING or NOT_SERVING), or "" when no probe is on record.
func Verdict(ctx context.Context, service, instanceID string) (string, error) {
	v, err := rdb.Get(ctx, VerdictKey(service, instanceID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return v, err
}
`,
  'discovery/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list sd:outbox of JSON rows {"topic", "key",
// "payload"} that a relay republishes once the broker takes writes again.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one queued record.
type Row struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// Write queues a record the broker did not take.
func Write(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": json.RawMessage(raw)})
	return rdb.RPush(ctx, "sd:outbox", row).Err()
}

// Rows is everything queued, oldest first.
func Rows(ctx context.Context) ([]Row, error) {
	raw, err := rdb.LRange(ctx, "sd:outbox", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]Row, 0, len(raw))
	for _, text := range raw {
		var row Row
		if err := json.Unmarshal([]byte(text), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'discovery/registry.h': `// The deployment registry (provided): sd:deploy:{service} holds the CIDR the service's deployment
// declared, sd:grants:{client_id} the set of services a mesh identity may register instances into.
// inCidr tests an IPv4 literal against a CIDR and is false for anything that does not parse.
#pragma once

#include <sw/redis++/redis++.h>

#include <cstdint>
#include <iterator>
#include <optional>
#include <set>
#include <string>

namespace registry {

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The CIDR the service's deployment declared, or none when no such service is deployed.
inline std::optional<std::string> deploymentCidr(const std::string& service) {
  const auto cidr = client().get("sd:deploy:" + service);
  if (!cidr) return std::nullopt;
  return std::string(*cidr);
}

// The services client_id may register instances into.
inline std::set<std::string> allowedServices(const std::string& client_id) {
  std::set<std::string> out;
  client().smembers("sd:grants:" + client_id, std::inserter(out, out.begin()));
  return out;
}

inline std::optional<uint64_t> ipv4(const std::string& text) {
  uint64_t value = 0;
  int parts = 0;
  size_t start = 0;
  while (true) {
    const size_t dot = text.find('.', start);
    const std::string part = text.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
    if (part.empty() || part.size() > 3 || part.find_first_not_of("0123456789") != std::string::npos) return std::nullopt;
    const int n = std::stoi(part);
    if (n > 255) return std::nullopt;
    value = value * 256 + static_cast<uint64_t>(n);
    parts++;
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  if (parts != 4) return std::nullopt;
  return value;
}

// Whether the IPv4 literal address lies inside cidr ("10.4.0.0/16").
inline bool inCidr(const std::string& address, const std::string& cidr) {
  const size_t slash = cidr.find('/');
  if (slash == std::string::npos) return false;
  const std::string bits = cidr.substr(slash + 1);
  const auto ip = ipv4(address);
  const auto network = ipv4(cidr.substr(0, slash));
  if (!ip || !network || bits.empty() || bits.size() > 2 || bits.find_first_not_of("0123456789") != std::string::npos) return false;
  const int n = std::stoi(bits);
  if (n > 32) return false;
  const uint64_t block = uint64_t{1} << (32 - n);
  return *ip / block == *network / block;
}

// Deploy a service into cidr (what the deploy pipeline writes).
inline void defineService(const std::string& service, const std::string& cidr) { client().set("sd:deploy:" + service, cidr); }

// Let client_id register instances into service.
inline void grant(const std::string& client_id, const std::string& service) { client().sadd("sd:grants:" + client_id, service); }

}  // namespace registry
`,
  'discovery/instances.h': `// The instance records (provided). sd:{service}:{instance_id} is a hash (address, port,
// heartbeat_interval, metadata_version, last_heartbeat in Unix seconds; every field a string) that
// expires kTtlIntervals heartbeat intervals after its last write. sd:members:{service} is the set of
// instance ids registered and not yet announced as expired. sd:probe:{service}:{instance_id} is the
// shared probe verdict, SERVING or NOT_SERVING, with a short TTL. registerInstance is the write step
// 1 builds, as later steps and the checks use it.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace instances {

constexpr long kTtlIntervals = 3;

// A live record.
struct Instance {
  std::string address;
  long port = 0;
  long heartbeat_interval = 0;
  long metadata_version = 0;
  long long last_heartbeat = 0;
};

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string recordKey(const std::string& service, const std::string& instance_id) { return "sd:" + service + ":" + instance_id; }
inline std::string membersKey(const std::string& service) { return "sd:members:" + service; }
inline std::string verdictKey(const std::string& service, const std::string& instance_id) { return "sd:probe:" + service + ":" + instance_id; }

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Write the record with its expiry and add the instance to the members set, in one MULTI; returns the TTL.
inline long registerInstance(const std::string& service, const std::string& instance_id, const std::string& address, long port,
                             long heartbeat_interval, long metadata_version) {
  const long ttl = kTtlIntervals * heartbeat_interval;
  const std::string key = recordKey(service, instance_id);
  const std::unordered_map<std::string, std::string> fields = {
      {"address", address},
      {"port", std::to_string(port)},
      {"heartbeat_interval", std::to_string(heartbeat_interval)},
      {"metadata_version", std::to_string(metadata_version)},
      {"last_heartbeat", std::to_string(nowSeconds())}};
  auto tx = client().transaction();
  tx.hset(key, fields.begin(), fields.end()).expire(key, std::chrono::seconds(ttl)).sadd(membersKey(service), instance_id).exec();
  return ttl;
}

// The live record, or none once it lapsed.
inline std::optional<Instance> lookup(const std::string& service, const std::string& instance_id) {
  std::unordered_map<std::string, std::string> raw;
  client().hgetall(recordKey(service, instance_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  const auto number = [&raw](const char* name) -> long long {
    const auto it = raw.find(name);
    if (it == raw.end() || it->second.empty()) return 0;
    try {
      return std::stoll(it->second);
    } catch (const std::exception&) {
      return 0;
    }
  };
  Instance out;
  out.address = raw.count("address") ? raw.at("address") : "";
  out.port = static_cast<long>(number("port"));
  out.heartbeat_interval = static_cast<long>(number("heartbeat_interval"));
  out.metadata_version = static_cast<long>(number("metadata_version"));
  out.last_heartbeat = number("last_heartbeat");
  return out;
}

// The ids in the members set, sorted.
inline std::vector<std::string> members(const std::string& service) {
  std::vector<std::string> ids;
  client().smembers(membersKey(service), std::back_inserter(ids));
  std::sort(ids.begin(), ids.end());
  return ids;
}

// The shared probe verdict (SERVING or NOT_SERVING), or none when no probe is on record.
inline std::optional<std::string> verdict(const std::string& service, const std::string& instance_id) {
  const auto v = client().get(verdictKey(service, instance_id));
  if (!v) return std::nullopt;
  return std::string(*v);
}

}  // namespace instances
`,
  'discovery/outbox.h': `// The outbox (provided): the Redis list sd:outbox of JSON rows {"topic", "key", "payload"} that a
// relay republishes once the broker takes writes again.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

namespace outbox {

inline sw::redis::Redis& client() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Queue a record the broker did not take.
inline void write(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  client().rpush("sd:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<std::string> raw;
  client().lrange("sd:outbox", 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const std::string& row : raw) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('discovery', 'Registry')]: `package discovery

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The deployment registry (provided): sd:deploy:{service} holds the CIDR the service's deployment
 * declared, sd:grants:{client_id} the set of services a mesh identity may register instances into.
 * inCidr tests an IPv4 literal against a CIDR and is false for anything that does not parse.
 */
object Registry {
  val jedis = new JedisPooled("redis", 6379)

  /** The CIDR the service's deployment declared, or None when no such service is deployed. */
  def deploymentCidr(service: String): Option[String] = Option(jedis.get(s"sd:deploy:$service"))

  /** The services clientId may register instances into. */
  def allowedServices(clientId: String): Set[String] = jedis.smembers(s"sd:grants:$clientId").asScala.toSet

  private def ipv4(text: String): Option[Long] = {
    val parts = text.split("\\\\.", -1)
    if (parts.length != 4 || !parts.forall(p => p.nonEmpty && p.length <= 3 && p.forall(_.isDigit) && p.toInt <= 255)) None
    else Some(parts.foldLeft(0L)((value, part) => value * 256 + part.toLong))
  }

  /** Whether the IPv4 literal address lies inside cidr ("10.4.0.0/16"). */
  def inCidr(address: String, cidr: String): Boolean = cidr.split("/", -1) match {
    case Array(base, bits) if bits.nonEmpty && bits.length <= 2 && bits.forall(_.isDigit) && bits.toInt <= 32 =>
      val block = 1L << (32 - bits.toInt)
      (ipv4(address), ipv4(base)) match {
        case (Some(ip), Some(network)) => ip / block == network / block
        case _                         => false
      }
    case _ => false
  }

  /** Deploy a service into cidr (what the deploy pipeline writes). */
  def defineService(service: String, cidr: String): Unit = jedis.set(s"sd:deploy:$service", cidr)

  /** Let clientId register instances into service. */
  def grant(clientId: String, service: String): Unit = jedis.sadd(s"sd:grants:$clientId", service)
}
`,
  [scalaPath('discovery', 'Instances')]: `package discovery

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The instance records (provided). sd:{service}:{instance_id} is a hash (address, port,
 * heartbeat_interval, metadata_version, last_heartbeat in Unix seconds; every field a string) that
 * expires TtlIntervals heartbeat intervals after its last write. sd:members:{service} is the set of
 * instance ids registered and not yet announced as expired. sd:probe:{service}:{instance_id} is the
 * shared probe verdict, SERVING or NOT_SERVING, with a short TTL. registerInstance is the write step 1
 * builds, as later steps and the checks use it.
 */
object Instances {
  final case class Instance(address: String, port: Int, heartbeatInterval: Int, metadataVersion: Long, lastHeartbeat: Long)

  val TtlIntervals = 3

  val jedis = new JedisPooled("redis", 6379)

  def recordKey(service: String, instanceId: String): String = s"sd:$service:$instanceId"
  def membersKey(service: String): String = s"sd:members:$service"
  def verdictKey(service: String, instanceId: String): String = s"sd:probe:$service:$instanceId"

  /** Write the record with its expiry and add the instance to the members set, in one MULTI; returns the TTL. */
  def registerInstance(service: String, instanceId: String, address: String, port: Int, heartbeatInterval: Int, metadataVersion: Long): Int = {
    val ttl = TtlIntervals * heartbeatInterval
    val key = recordKey(service, instanceId)
    val fields = Map(
      "address" -> address,
      "port" -> port.toString,
      "heartbeat_interval" -> heartbeatInterval.toString,
      "metadata_version" -> metadataVersion.toString,
      "last_heartbeat" -> (System.currentTimeMillis() / 1000).toString
    )
    val tx = jedis.multi()
    tx.hset(key, fields.asJava)
    tx.expire(key, ttl.toLong)
    tx.sadd(membersKey(service), instanceId)
    tx.exec()
    ttl
  }

  /** The live record, or None once it lapsed. */
  def lookup(service: String, instanceId: String): Option[Instance] = {
    val raw = jedis.hgetAll(recordKey(service, instanceId)).asScala.toMap
    def number(name: String): Long = raw.get(name).flatMap(_.toLongOption).getOrElse(0L)
    if (raw.isEmpty) None
    else Some(Instance(raw.getOrElse("address", ""), number("port").toInt, number("heartbeat_interval").toInt, number("metadata_version"), number("last_heartbeat")))
  }

  /** The ids in the members set, sorted. */
  def members(service: String): Seq[String] = jedis.smembers(membersKey(service)).asScala.toSeq.sorted

  /** The shared probe verdict (SERVING or NOT_SERVING), or None when no probe is on record. */
  def verdict(service: String, instanceId: String): Option[String] = Option(jedis.get(verdictKey(service, instanceId)))
}
`,
  [scalaPath('discovery', 'Outbox')]: `package discovery

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The outbox (provided): the Redis list sd:outbox of JSON rows {"topic", "key", "payload"} that a
 * relay republishes once the broker takes writes again.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Queue a record the broker did not take. */
  def write(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("sd:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def rows(): Seq[JsValue] = jedis.lrange("sd:outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
