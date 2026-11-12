/**
 * Hand-written support modules the secrets-rotation steps import but no step builds: the `secretd`
 * package. `secretd.vault` is the version store (every secret is a sequence of version rows in
 * Redis hashes, the course's stand-in for the vault's database): versions with their material,
 * registered consumers, the consumers that verified a version, and the alerts a blocked rotation
 * raised. `secretd.rotation` is the active-version pointer of step 2 as later steps use it:
 * `activate`, `valid_versions`, `revoke`, plus `retire`, which ends an overlap early. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'secretd/__init__.py': '',
  'secretd/vault.py': `"""
The version store (provided). secret:{name} holds the secret's owner; secret:{name}:v:{version_id}
one version (name, version_id, fingerprint, material, rotation_seconds, created_at, rotate_at,
activated_at, retired_at; an unset time is ""); secret:{name}:versions the version ids, oldest
first. secret:{name}:consumers is the set of registered consumers (each served at
{consumer_id}:9000), secret:{name}:accepted:{version_id} the consumers that verified a version,
secret:{name}:alerts the pages raised for a rotation that could not finish (JSON, oldest first).
A version is returned as a dict with its material: the vault's record, not a response body.
Times are whole seconds since the epoch; an unset one is None.
"""
import hashlib
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def fingerprint(material: str) -> str:
    """The lowercase hex SHA-256 of the material: it names a version without revealing it."""
    return hashlib.sha256(material.encode()).hexdigest()


def version_key(name: str, version_id: str) -> str:
    return f"secret:{name}:v:{version_id}"


def _version(raw: dict) -> dict | None:
    if not raw:
        return None
    out = {field: raw[field] for field in ("name", "version_id", "fingerprint", "material")}
    for field in ("rotation_seconds", "created_at", "rotate_at"):
        out[field] = int(raw[field])
    for field in ("activated_at", "retired_at"):
        out[field] = int(raw[field]) if raw.get(field) else None
    return out


def create_version(name: str, material: str, rotation_seconds: int, owner: str) -> dict:
    """Write a new, not yet active version with its material (once); the first creator owns the secret."""
    version_id = f"v{r.incr(f'secret:{name}:seq')}"
    now = int(time.time())
    r.hset(
        version_key(name, version_id),
        mapping={
            "name": name,
            "version_id": version_id,
            "fingerprint": fingerprint(material),
            "material": material,
            "rotation_seconds": rotation_seconds,
            "created_at": now,
            "rotate_at": now + rotation_seconds,
            "activated_at": "",
            "retired_at": "",
        },
    )
    r.rpush(f"secret:{name}:versions", version_id)
    r.hsetnx(f"secret:{name}", "owner", owner)
    return get_version(name, version_id)


def get_version(name: str, version_id: str) -> dict | None:
    return _version(r.hgetall(version_key(name, version_id)))


def versions(name: str) -> list[dict]:
    """Every version of the secret, oldest first."""
    return [get_version(name, v) for v in r.lrange(f"secret:{name}:versions", 0, -1)]


def owner_of(name: str) -> str | None:
    return r.hget(f"secret:{name}", "owner")


def register_consumer(name: str, consumer_id: str) -> None:
    r.sadd(f"secret:{name}:consumers", consumer_id)


def consumers(name: str) -> list[str]:
    """The registered consumers of the secret, sorted."""
    return sorted(r.smembers(f"secret:{name}:consumers"))


def record_acceptance(name: str, version_id: str, consumer_id: str) -> None:
    """The consumer proved it can read the version."""
    r.sadd(f"secret:{name}:accepted:{version_id}", consumer_id)


def accepted(name: str, version_id: str) -> list[str]:
    """The consumers that verified the version, sorted."""
    return sorted(r.smembers(f"secret:{name}:accepted:{version_id}"))


def record_activation(name: str, version_id: str) -> None:
    r.hset(version_key(name, version_id), "activated_at", int(time.time()))


def record_retirement(name: str, version_id: str) -> None:
    r.hset(version_key(name, version_id), "retired_at", int(time.time()))


def raise_alert(name: str, version_id: str, pending: list[str]) -> None:
    """Page the secret's on-call: the rotation to version_id cannot finish until pending verify."""
    r.rpush(f"secret:{name}:alerts", json.dumps({"version_id": version_id, "pending": list(pending)}))


def alerts(name: str) -> list[dict]:
    return [json.loads(raw) for raw in r.lrange(f"secret:{name}:alerts", 0, -1)]
`,
  'secretd/rotation.py': `"""
The active-version pointer (provided; step 2 builds activate, valid_versions and revoke).
secret:{name}:active is the version a new consumer must use (no TTL); secret:{name}:overlap the
previous version while it is still valid (EXPIRE OVERLAP_SECONDS); secret:{name}:revoked the set
of revoked version ids. activate swaps the pointer in one Lua script and answers the previous
version (None for the first); retire ends the overlap of version_id early.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OVERLAP_SECONDS = 900

SWAP_LUA = """
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
"""
swap = r.register_script(SWAP_LUA)


def active_key(name: str) -> str:
    return f"secret:{name}:active"


def overlap_key(name: str) -> str:
    return f"secret:{name}:overlap"


def revoked_key(name: str) -> str:
    return f"secret:{name}:revoked"


def activate(name: str, version_id: str) -> str | None:
    previous = swap(keys=[active_key(name), overlap_key(name)], args=[version_id, OVERLAP_SECONDS])
    return previous or None


def valid_versions(name: str) -> list[str]:
    """The active version, then the overlapping previous one while its window lasts; never a revoked one."""
    revoked = r.smembers(revoked_key(name))
    return [v for v in r.mget(active_key(name), overlap_key(name)) if v and v not in revoked]


def revoke(name: str, version_id: str) -> bool:
    """Revoke a version that is not the active one; False (and nothing changes) for the active version."""
    if r.get(active_key(name)) == version_id:
        return False
    r.sadd(revoked_key(name), version_id)
    return True


def retire(name: str, version_id: str) -> None:
    """End the overlap now when it holds version_id."""
    if r.get(overlap_key(name)) == version_id:
        r.delete(overlap_key(name))
`,
};

export const supportModulesTs: Record<string, string> = {
  'secretd/vault.ts': `/**
 * The version store (provided). secret:{name} holds the secret's owner; secret:{name}:v:{version_id}
 * one version (name, version_id, fingerprint, material, rotation_seconds, created_at, rotate_at,
 * activated_at, retired_at; an unset time is ""); secret:{name}:versions the version ids, oldest
 * first. secret:{name}:consumers is the set of registered consumers (each served at
 * {consumer_id}:9000), secret:{name}:accepted:{version_id} the consumers that verified a version,
 * secret:{name}:alerts the pages raised for a rotation that could not finish (JSON, oldest first).
 * A Version carries its material: the vault's record, not a response body. Times are whole seconds
 * since the epoch; an unset one is null.
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Version {
  name: string;
  version_id: string;
  fingerprint: string;
  material: string;
  rotation_seconds: number;
  created_at: number;
  rotate_at: number;
  activated_at: number | null;
  retired_at: number | null;
}

export interface Alert {
  version_id: string;
  pending: string[];
}

const now = (): number => Math.floor(Date.now() / 1000);

/** The lowercase hex SHA-256 of the material: it names a version without revealing it. */
export const fingerprint = (material: string): string => createHash('sha256').update(material).digest('hex');

export const versionKey = (name: string, versionId: string): string => \`secret:\${name}:v:\${versionId}\`;

function version(raw: Record<string, string>): Version | null {
  if (Object.keys(raw).length === 0) return null;
  const time = (field: string): number | null => (raw[field] ? Number(raw[field]) : null);
  return {
    name: raw.name,
    version_id: raw.version_id,
    fingerprint: raw.fingerprint,
    material: raw.material,
    rotation_seconds: Number(raw.rotation_seconds),
    created_at: Number(raw.created_at),
    rotate_at: Number(raw.rotate_at),
    activated_at: time('activated_at'),
    retired_at: time('retired_at'),
  };
}

/** Write a new, not yet active version with its material (once); the first creator owns the secret. */
export async function createVersion(name: string, material: string, rotationSeconds: number, owner: string): Promise<Version> {
  const versionId = \`v\${await redis.incr(\`secret:\${name}:seq\`)}\`;
  const at = now();
  await redis.hset(versionKey(name, versionId), {
    name,
    version_id: versionId,
    fingerprint: fingerprint(material),
    material,
    rotation_seconds: String(rotationSeconds),
    created_at: String(at),
    rotate_at: String(at + rotationSeconds),
    activated_at: '',
    retired_at: '',
  });
  await redis.rpush(\`secret:\${name}:versions\`, versionId);
  await redis.hsetnx(\`secret:\${name}\`, 'owner', owner);
  return (await getVersion(name, versionId)) as Version;
}

export async function getVersion(name: string, versionId: string): Promise<Version | null> {
  return version(await redis.hgetall(versionKey(name, versionId)));
}

/** Every version of the secret, oldest first. */
export async function versions(name: string): Promise<Version[]> {
  const ids = await redis.lrange(\`secret:\${name}:versions\`, 0, -1);
  const out: Version[] = [];
  for (const id of ids) out.push((await getVersion(name, id)) as Version);
  return out;
}

export async function ownerOf(name: string): Promise<string | null> {
  return redis.hget(\`secret:\${name}\`, 'owner');
}

export async function registerConsumer(name: string, consumerId: string): Promise<void> {
  await redis.sadd(\`secret:\${name}:consumers\`, consumerId);
}

/** The registered consumers of the secret, sorted. */
export async function consumers(name: string): Promise<string[]> {
  return (await redis.smembers(\`secret:\${name}:consumers\`)).sort();
}

/** The consumer proved it can read the version. */
export async function recordAcceptance(name: string, versionId: string, consumerId: string): Promise<void> {
  await redis.sadd(\`secret:\${name}:accepted:\${versionId}\`, consumerId);
}

/** The consumers that verified the version, sorted. */
export async function accepted(name: string, versionId: string): Promise<string[]> {
  return (await redis.smembers(\`secret:\${name}:accepted:\${versionId}\`)).sort();
}

export async function recordActivation(name: string, versionId: string): Promise<void> {
  await redis.hset(versionKey(name, versionId), 'activated_at', String(now()));
}

export async function recordRetirement(name: string, versionId: string): Promise<void> {
  await redis.hset(versionKey(name, versionId), 'retired_at', String(now()));
}

/** Page the secret's on-call: the rotation to versionId cannot finish until pending verify. */
export async function raiseAlert(name: string, versionId: string, pending: string[]): Promise<void> {
  await redis.rpush(\`secret:\${name}:alerts\`, JSON.stringify({version_id: versionId, pending: [...pending]}));
}

export async function alerts(name: string): Promise<Alert[]> {
  return (await redis.lrange(\`secret:\${name}:alerts\`, 0, -1)).map(raw => JSON.parse(raw) as Alert);
}
`,
  'secretd/rotation.ts': `/**
 * The active-version pointer (provided; step 2 builds activate, validVersions and revoke).
 * secret:{name}:active is the version a new consumer must use (no TTL); secret:{name}:overlap the
 * previous version while it is still valid (EXPIRE OVERLAP_SECONDS); secret:{name}:revoked the set
 * of revoked version ids. activate swaps the pointer in one Lua script and answers the previous
 * version (null for the first); retire ends the overlap of versionId early.
 */
import Redis from 'ioredis';

export const OVERLAP_SECONDS = 900;

export const SWAP_LUA = \`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
\`;

interface SwapRedis extends Redis {
  swapActive(active: string, overlap: string, versionId: string, overlapSeconds: number): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapActive', {numberOfKeys: 2, lua: SWAP_LUA});

export const activeKey = (name: string): string => \`secret:\${name}:active\`;
export const overlapKey = (name: string): string => \`secret:\${name}:overlap\`;
export const revokedKey = (name: string): string => \`secret:\${name}:revoked\`;

export async function activate(name: string, versionId: string): Promise<string | null> {
  const previous = await redis.swapActive(activeKey(name), overlapKey(name), versionId, OVERLAP_SECONDS);
  return previous === '' ? null : previous;
}

/** The active version, then the overlapping previous one while its window lasts; never a revoked one. */
export async function validVersions(name: string): Promise<string[]> {
  const revoked = new Set(await redis.smembers(revokedKey(name)));
  const [active, overlap] = await redis.mget(activeKey(name), overlapKey(name));
  return [active, overlap].filter((v): v is string => v !== null && !revoked.has(v));
}

/** Revoke a version that is not the active one; false (and nothing changes) for the active version. */
export async function revoke(name: string, versionId: string): Promise<boolean> {
  if ((await redis.get(activeKey(name))) === versionId) return false;
  await redis.sadd(revokedKey(name), versionId);
  return true;
}

/** End the overlap now when it holds versionId. */
export async function retire(name: string, versionId: string): Promise<void> {
  if ((await redis.get(overlapKey(name))) === versionId) await redis.del(overlapKey(name));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'secretd/vault/vault.go': `// Package vault is the version store (provided). secret:{name} holds the secret's owner;
// secret:{name}:v:{version_id} one version (name, version_id, fingerprint, material,
// rotation_seconds, created_at, rotate_at, activated_at, retired_at; an unset time is "");
// secret:{name}:versions the version ids, oldest first. secret:{name}:consumers is the set of
// registered consumers (each served at {consumer_id}:9000), secret:{name}:accepted:{version_id} the
// consumers that verified a version, secret:{name}:alerts the pages raised for a rotation that could
// not finish (JSON, oldest first). A Version carries its material: the vault's record, not a
// response body. Times are whole seconds since the epoch; an unset one is 0.
package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Version is one version of a secret, as the vault stores it.
type Version struct {
	Name            string \`json:"name"\`
	VersionID       string \`json:"version_id"\`
	Fingerprint     string \`json:"fingerprint"\`
	Material        string \`json:"material"\`
	RotationSeconds int64  \`json:"rotation_seconds"\`
	CreatedAt       int64  \`json:"created_at"\`
	RotateAt        int64  \`json:"rotate_at"\`
	ActivatedAt     int64  \`json:"activated_at"\`
	RetiredAt       int64  \`json:"retired_at"\`
}

// Alert is one page raised for a rotation that could not finish.
type Alert struct {
	VersionID string   \`json:"version_id"\`
	Pending   []string \`json:"pending"\`
}

// Fingerprint is the lowercase hex SHA-256 of the material: it names a version without revealing it.
func Fingerprint(material string) string {
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:])
}

// VersionKey is the hash of one version.
func VersionKey(name, versionID string) string { return "secret:" + name + ":v:" + versionID }

func number(raw map[string]string, field string) int64 {
	n, _ := strconv.ParseInt(raw[field], 10, 64)
	return n
}

// CreateVersion writes a new, not yet active version with its material (once); the first creator
// owns the secret.
func CreateVersion(ctx context.Context, name, material string, rotationSeconds int64, owner string) (*Version, error) {
	seq, err := rdb.Incr(ctx, "secret:"+name+":seq").Result()
	if err != nil {
		return nil, err
	}
	versionID := fmt.Sprintf("v%d", seq)
	now := time.Now().Unix()
	err = rdb.HSet(ctx, VersionKey(name, versionID), map[string]any{
		"name": name, "version_id": versionID, "fingerprint": Fingerprint(material), "material": material,
		"rotation_seconds": rotationSeconds, "created_at": now, "rotate_at": now + rotationSeconds,
		"activated_at": "", "retired_at": "",
	}).Err()
	if err != nil {
		return nil, err
	}
	rdb.RPush(ctx, "secret:"+name+":versions", versionID)
	rdb.HSetNX(ctx, "secret:"+name, "owner", owner)
	return GetVersion(ctx, name, versionID), nil
}

// GetVersion is one version, or nil.
func GetVersion(ctx context.Context, name, versionID string) *Version {
	raw := rdb.HGetAll(ctx, VersionKey(name, versionID)).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Version{
		Name: raw["name"], VersionID: raw["version_id"], Fingerprint: raw["fingerprint"], Material: raw["material"],
		RotationSeconds: number(raw, "rotation_seconds"), CreatedAt: number(raw, "created_at"), RotateAt: number(raw, "rotate_at"),
		ActivatedAt: number(raw, "activated_at"), RetiredAt: number(raw, "retired_at"),
	}
}

// Versions is every version of the secret, oldest first.
func Versions(ctx context.Context, name string) []Version {
	var out []Version
	for _, id := range rdb.LRange(ctx, "secret:"+name+":versions", 0, -1).Val() {
		if v := GetVersion(ctx, name, id); v != nil {
			out = append(out, *v)
		}
	}
	return out
}

// OwnerOf is the secret's owner ("" for an unknown secret).
func OwnerOf(ctx context.Context, name string) string {
	return rdb.HGet(ctx, "secret:"+name, "owner").Val()
}

// RegisterConsumer adds a consumer of the secret.
func RegisterConsumer(ctx context.Context, name, consumerID string) {
	rdb.SAdd(ctx, "secret:"+name+":consumers", consumerID)
}

func members(ctx context.Context, key string) []string {
	out := rdb.SMembers(ctx, key).Val()
	sort.Strings(out)
	return out
}

// Consumers are the registered consumers of the secret, sorted.
func Consumers(ctx context.Context, name string) []string {
	return members(ctx, "secret:"+name+":consumers")
}

// RecordAcceptance records that the consumer proved it can read the version.
func RecordAcceptance(ctx context.Context, name, versionID, consumerID string) {
	rdb.SAdd(ctx, "secret:"+name+":accepted:"+versionID, consumerID)
}

// Accepted are the consumers that verified the version, sorted.
func Accepted(ctx context.Context, name, versionID string) []string {
	return members(ctx, "secret:"+name+":accepted:"+versionID)
}

// RecordActivation stamps the version's activated_at.
func RecordActivation(ctx context.Context, name, versionID string) {
	rdb.HSet(ctx, VersionKey(name, versionID), "activated_at", time.Now().Unix())
}

// RecordRetirement stamps the version's retired_at.
func RecordRetirement(ctx context.Context, name, versionID string) {
	rdb.HSet(ctx, VersionKey(name, versionID), "retired_at", time.Now().Unix())
}

// RaiseAlert pages the secret's on-call: the rotation to versionID cannot finish until pending verify.
func RaiseAlert(ctx context.Context, name, versionID string, pending []string) {
	raw, _ := json.Marshal(Alert{VersionID: versionID, Pending: append([]string{}, pending...)})
	rdb.RPush(ctx, "secret:"+name+":alerts", raw)
}

// Alerts are the pages raised for the secret, oldest first.
func Alerts(ctx context.Context, name string) []Alert {
	var out []Alert
	for _, raw := range rdb.LRange(ctx, "secret:"+name+":alerts", 0, -1).Val() {
		var a Alert
		json.Unmarshal([]byte(raw), &a)
		out = append(out, a)
	}
	return out
}
`,
  'secretd/rotation/rotation.go': `// Package rotation is the active-version pointer (provided; step 2 builds activate, validVersions
// and revoke). secret:{name}:active is the version a new consumer must use (no TTL);
// secret:{name}:overlap the previous version while it is still valid (EXPIRE OverlapSeconds);
// secret:{name}:revoked the set of revoked version ids. Activate swaps the pointer in one Lua script
// and answers the previous version ("" for the first); Retire ends the overlap of versionID early.
package rotation

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// OverlapSeconds is how long the previous version stays valid after a swap.
const OverlapSeconds = 900

// Swap moves the pointer (KEYS[1]) to ARGV[1] and keeps the previous version under KEYS[2] for ARGV[2] seconds.
var Swap = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
\`)

func ActiveKey(name string) string  { return "secret:" + name + ":active" }
func OverlapKey(name string) string { return "secret:" + name + ":overlap" }
func RevokedKey(name string) string { return "secret:" + name + ":revoked" }

// Activate makes versionID the active version and answers the previous one ("" for the first).
func Activate(ctx context.Context, name, versionID string) (string, error) {
	return Swap.Run(ctx, rdb, []string{ActiveKey(name), OverlapKey(name)}, versionID, OverlapSeconds).Text()
}

// ValidVersions is the active version, then the overlapping previous one while its window lasts;
// never a revoked one.
func ValidVersions(ctx context.Context, name string) ([]string, error) {
	revoked, err := rdb.SMembers(ctx, RevokedKey(name)).Result()
	if err != nil {
		return nil, err
	}
	pointers, err := rdb.MGet(ctx, ActiveKey(name), OverlapKey(name)).Result()
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, p := range pointers {
		v, ok := p.(string)
		if !ok || v == "" {
			continue
		}
		isRevoked := false
		for _, r := range revoked {
			isRevoked = isRevoked || r == v
		}
		if !isRevoked {
			out = append(out, v)
		}
	}
	return out, nil
}

// Revoke revokes a version that is not the active one; false (and nothing changes) for the active version.
func Revoke(ctx context.Context, name, versionID string) (bool, error) {
	if rdb.Get(ctx, ActiveKey(name)).Val() == versionID {
		return false, nil
	}
	return true, rdb.SAdd(ctx, RevokedKey(name), versionID).Err()
}

// Retire ends the overlap now when it holds versionID.
func Retire(ctx context.Context, name, versionID string) error {
	if rdb.Get(ctx, OverlapKey(name)).Val() != versionID {
		return nil
	}
	return rdb.Del(ctx, OverlapKey(name)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'secretd/vault.h': `// The version store (provided). secret:{name} holds the secret's owner; secret:{name}:v:{version_id}
// one version (name, version_id, fingerprint, material, rotation_seconds, created_at, rotate_at,
// activated_at, retired_at; an unset time is ""); secret:{name}:versions the version ids, oldest
// first. secret:{name}:consumers is the set of registered consumers (each served at
// {consumer_id}:9000), secret:{name}:accepted:{version_id} the consumers that verified a version,
// secret:{name}:alerts the pages raised for a rotation that could not finish (JSON, oldest first).
// A Version carries its material (and converts to JSON with it): the vault's record, not a
// response body. Times are whole seconds since the epoch; an unset one is 0.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace vault {

struct Version {
  std::string name;
  std::string version_id;
  std::string fingerprint;
  std::string material;
  long long rotation_seconds = 0;
  long long created_at = 0;
  long long rotate_at = 0;
  long long activated_at = 0;
  long long retired_at = 0;
};

// The whole record as JSON, material included.
inline void to_json(nlohmann::json& j, const Version& v) {
  j = nlohmann::json{{"name", v.name}, {"version_id", v.version_id}, {"fingerprint", v.fingerprint}, {"material", v.material},
                     {"rotation_seconds", v.rotation_seconds}, {"created_at", v.created_at}, {"rotate_at", v.rotate_at},
                     {"activated_at", v.activated_at}, {"retired_at", v.retired_at}};
}

struct Alert {
  std::string version_id;
  std::vector<std::string> pending;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The lowercase hex SHA-256 of the material: it names a version without revealing it.
inline std::string fingerprint(const std::string& material) {
  unsigned char md[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(material.data()), material.size(), md);
  char hex[2 * SHA256_DIGEST_LENGTH + 1];
  for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) std::snprintf(hex + 2 * i, 3, "%02x", md[i]);
  return std::string(hex, 2 * SHA256_DIGEST_LENGTH);
}

inline std::string versionKey(const std::string& name, const std::string& version_id) {
  return "secret:" + name + ":v:" + version_id;
}

inline std::optional<Version> getVersion(const std::string& name, const std::string& version_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(versionKey(name, version_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  const auto number = [&raw](const char* field) { return raw[field].empty() ? 0LL : std::stoll(raw[field]); };
  Version v;
  v.name = raw["name"];
  v.version_id = raw["version_id"];
  v.fingerprint = raw["fingerprint"];
  v.material = raw["material"];
  v.rotation_seconds = number("rotation_seconds");
  v.created_at = number("created_at");
  v.rotate_at = number("rotate_at");
  v.activated_at = number("activated_at");
  v.retired_at = number("retired_at");
  return v;
}

// Write a new, not yet active version with its material (once); the first creator owns the secret.
inline Version createVersion(const std::string& name, const std::string& material, long long rotation_seconds, const std::string& owner) {
  const std::string version_id = "v" + std::to_string(redis().incr("secret:" + name + ":seq"));
  const long long now = nowSeconds();
  const std::unordered_map<std::string, std::string> row = {
      {"name", name}, {"version_id", version_id}, {"fingerprint", fingerprint(material)}, {"material", material},
      {"rotation_seconds", std::to_string(rotation_seconds)}, {"created_at", std::to_string(now)},
      {"rotate_at", std::to_string(now + rotation_seconds)}, {"activated_at", ""}, {"retired_at", ""}};
  redis().hset(versionKey(name, version_id), row.begin(), row.end());
  redis().rpush("secret:" + name + ":versions", version_id);
  redis().hsetnx("secret:" + name, "owner", owner);
  return *getVersion(name, version_id);
}

// Every version of the secret, oldest first.
inline std::vector<Version> versions(const std::string& name) {
  std::vector<std::string> ids;
  redis().lrange("secret:" + name + ":versions", 0, -1, std::back_inserter(ids));
  std::vector<Version> out;
  for (const auto& id : ids) {
    if (auto v = getVersion(name, id)) out.push_back(*v);
  }
  return out;
}

// The secret's owner ("" for an unknown secret).
inline std::string ownerOf(const std::string& name) { return redis().hget("secret:" + name, "owner").value_or(""); }

inline void registerConsumer(const std::string& name, const std::string& consumer_id) {
  redis().sadd("secret:" + name + ":consumers", consumer_id);
}

inline std::vector<std::string> sortedMembers(const std::string& key) {
  std::vector<std::string> out;
  redis().smembers(key, std::back_inserter(out));
  std::sort(out.begin(), out.end());
  return out;
}

// The registered consumers of the secret, sorted.
inline std::vector<std::string> consumers(const std::string& name) { return sortedMembers("secret:" + name + ":consumers"); }

// The consumer proved it can read the version.
inline void recordAcceptance(const std::string& name, const std::string& version_id, const std::string& consumer_id) {
  redis().sadd("secret:" + name + ":accepted:" + version_id, consumer_id);
}

// The consumers that verified the version, sorted.
inline std::vector<std::string> accepted(const std::string& name, const std::string& version_id) {
  return sortedMembers("secret:" + name + ":accepted:" + version_id);
}

inline void recordActivation(const std::string& name, const std::string& version_id) {
  redis().hset(versionKey(name, version_id), "activated_at", std::to_string(nowSeconds()));
}

inline void recordRetirement(const std::string& name, const std::string& version_id) {
  redis().hset(versionKey(name, version_id), "retired_at", std::to_string(nowSeconds()));
}

// Page the secret's on-call: the rotation to version_id cannot finish until pending verify.
inline void raiseAlert(const std::string& name, const std::string& version_id, const std::vector<std::string>& pending) {
  redis().rpush("secret:" + name + ":alerts", nlohmann::json{{"version_id", version_id}, {"pending", pending}}.dump());
}

inline std::vector<Alert> alerts(const std::string& name) {
  std::vector<std::string> raw;
  redis().lrange("secret:" + name + ":alerts", 0, -1, std::back_inserter(raw));
  std::vector<Alert> out;
  for (const auto& r : raw) {
    const auto j = nlohmann::json::parse(r);
    out.push_back(Alert{j.value("version_id", ""), j.value("pending", std::vector<std::string>{})});
  }
  return out;
}

}  // namespace vault
`,
  'secretd/rotation.h': `// The active-version pointer (provided; step 2 builds activate, validVersions and revoke).
// secret:{name}:active is the version a new consumer must use (no TTL); secret:{name}:overlap the
// previous version while it is still valid (EXPIRE kOverlapSeconds); secret:{name}:revoked the set
// of revoked version ids. activate swaps the pointer in one Lua script and answers the previous
// version ("" for the first); retire ends the overlap of version_id early.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <set>
#include <string>
#include <vector>

namespace rotation {

constexpr long long kOverlapSeconds = 900;

inline const std::string kSwapLua = R"lua(
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string activeKey(const std::string& name) { return "secret:" + name + ":active"; }
inline std::string overlapKey(const std::string& name) { return "secret:" + name + ":overlap"; }
inline std::string revokedKey(const std::string& name) { return "secret:" + name + ":revoked"; }

// Make version_id the active version; the previous one ("" for the first).
inline std::string activate(const std::string& name, const std::string& version_id) {
  return redis().eval<std::string>(kSwapLua, {activeKey(name), overlapKey(name)}, {version_id, std::to_string(kOverlapSeconds)});
}

// The active version, then the overlapping previous one while its window lasts; never a revoked one.
inline std::vector<std::string> validVersions(const std::string& name) {
  std::set<std::string> revoked;
  redis().smembers(revokedKey(name), std::inserter(revoked, revoked.begin()));
  std::vector<std::string> out;
  for (const auto& key : {activeKey(name), overlapKey(name)}) {
    const auto v = redis().get(key);
    if (v && !v->empty() && revoked.count(*v) == 0) out.push_back(*v);
  }
  return out;
}

// Revoke a version that is not the active one; false (and nothing changes) for the active version.
inline bool revoke(const std::string& name, const std::string& version_id) {
  if (redis().get(activeKey(name)).value_or("") == version_id) return false;
  redis().sadd(revokedKey(name), version_id);
  return true;
}

// End the overlap now when it holds version_id.
inline void retire(const std::string& name, const std::string& version_id) {
  if (redis().get(overlapKey(name)).value_or("") == version_id) redis().del(overlapKey(name));
}

}  // namespace rotation
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('secretd', 'Vault')]: `package secretd

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The version store (provided). secret:{name} holds the secret's owner; secret:{name}:v:{version_id}
 * one version (name, version_id, fingerprint, material, rotation_seconds, created_at, rotate_at,
 * activated_at, retired_at; an unset time is ""); secret:{name}:versions the version ids, oldest
 * first. secret:{name}:consumers is the set of registered consumers (each served at
 * {consumer_id}:9000), secret:{name}:accepted:{version_id} the consumers that verified a version,
 * secret:{name}:alerts the pages raised for a rotation that could not finish (JSON, oldest first).
 * A Version carries its material (toJson keeps it): the vault's record, not a response body. Times
 * are whole seconds since the epoch; an unset one is None.
 */
object Vault {
  final case class Version(
      name: String,
      versionId: String,
      fingerprint: String,
      material: String,
      rotationSeconds: Long,
      createdAt: Long,
      rotateAt: Long,
      activatedAt: Option[Long],
      retiredAt: Option[Long])

  final case class Alert(versionId: String, pending: Seq[String])

  val jedis = new JedisPooled("redis", 6379)

  private def now(): Long = System.currentTimeMillis() / 1000

  /** The lowercase hex SHA-256 of the material: it names a version without revealing it. */
  def fingerprint(material: String): String =
    MessageDigest.getInstance("SHA-256").digest(material.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def versionKey(name: String, versionId: String): String = s"secret:$name:v:$versionId"

  /** The whole record as JSON, material included. */
  def toJson(v: Version): JsObject = JsObject(
    "name" -> JsString(v.name),
    "version_id" -> JsString(v.versionId),
    "fingerprint" -> JsString(v.fingerprint),
    "material" -> JsString(v.material),
    "rotation_seconds" -> JsNumber(v.rotationSeconds),
    "created_at" -> JsNumber(v.createdAt),
    "rotate_at" -> JsNumber(v.rotateAt),
    "activated_at" -> v.activatedAt.map(JsNumber(_)).getOrElse(JsNull),
    "retired_at" -> v.retiredAt.map(JsNumber(_)).getOrElse(JsNull))

  /** Write a new, not yet active version with its material (once); the first creator owns the secret. */
  def createVersion(name: String, material: String, rotationSeconds: Long, owner: String): Version = {
    val versionId = s"v\${jedis.incr(s"secret:$name:seq")}"
    val at = now()
    jedis.hset(
      versionKey(name, versionId),
      Map(
        "name" -> name,
        "version_id" -> versionId,
        "fingerprint" -> fingerprint(material),
        "material" -> material,
        "rotation_seconds" -> rotationSeconds.toString,
        "created_at" -> at.toString,
        "rotate_at" -> (at + rotationSeconds).toString,
        "activated_at" -> "",
        "retired_at" -> "").asJava)
    jedis.rpush(s"secret:$name:versions", versionId)
    jedis.hsetnx(s"secret:$name", "owner", owner)
    getVersion(name, versionId).get
  }

  def getVersion(name: String, versionId: String): Option[Version] = {
    val raw = jedis.hgetAll(versionKey(name, versionId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def time(field: String): Option[Long] = raw.get(field).filter(_.nonEmpty).map(_.toLong)
      Some(Version(raw("name"), raw("version_id"), raw("fingerprint"), raw("material"), raw("rotation_seconds").toLong,
        raw("created_at").toLong, raw("rotate_at").toLong, time("activated_at"), time("retired_at")))
    }
  }

  /** Every version of the secret, oldest first. */
  def versions(name: String): Seq[Version] =
    jedis.lrange(s"secret:$name:versions", 0, -1).asScala.toSeq.flatMap(getVersion(name, _))

  def ownerOf(name: String): Option[String] = Option(jedis.hget(s"secret:$name", "owner"))

  def registerConsumer(name: String, consumerId: String): Unit = jedis.sadd(s"secret:$name:consumers", consumerId)

  /** The registered consumers of the secret, sorted. */
  def consumers(name: String): Seq[String] = jedis.smembers(s"secret:$name:consumers").asScala.toSeq.sorted

  /** The consumer proved it can read the version. */
  def recordAcceptance(name: String, versionId: String, consumerId: String): Unit =
    jedis.sadd(s"secret:$name:accepted:$versionId", consumerId)

  /** The consumers that verified the version, sorted. */
  def accepted(name: String, versionId: String): Seq[String] =
    jedis.smembers(s"secret:$name:accepted:$versionId").asScala.toSeq.sorted

  def recordActivation(name: String, versionId: String): Unit = jedis.hset(versionKey(name, versionId), "activated_at", now().toString)

  def recordRetirement(name: String, versionId: String): Unit = jedis.hset(versionKey(name, versionId), "retired_at", now().toString)

  /** Page the secret's on-call: the rotation to versionId cannot finish until pending verify. */
  def raiseAlert(name: String, versionId: String, pending: Seq[String]): Unit =
    jedis.rpush(s"secret:$name:alerts", JsObject("version_id" -> JsString(versionId), "pending" -> pending.toJson).compactPrint)

  def alerts(name: String): Seq[Alert] =
    jedis.lrange(s"secret:$name:alerts", 0, -1).asScala.toSeq.map { raw =>
      val fields = raw.parseJson.asJsObject.fields
      Alert(fields("version_id").convertTo[String], fields("pending").convertTo[Seq[String]])
    }
}
`,
  [scalaPath('secretd', 'Rotation')]: `package secretd

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The active-version pointer (provided; step 2 builds activate, validVersions and revoke).
 * secret:{name}:active is the version a new consumer must use (no TTL); secret:{name}:overlap the
 * previous version while it is still valid (EXPIRE OverlapSeconds); secret:{name}:revoked the set
 * of revoked version ids. activate swaps the pointer in one Lua script and answers the previous
 * version (None for the first); retire ends the overlap of versionId early.
 */
object Rotation {
  val jedis = new JedisPooled("redis", 6379)

  val OverlapSeconds = 900L

  val SwapLua: String =
    """local previous = redis.call('GET', KEYS[1]) or ''
      |redis.call('SET', KEYS[1], ARGV[1])
      |if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
      |return previous
      |""".stripMargin

  def activeKey(name: String): String = s"secret:$name:active"
  def overlapKey(name: String): String = s"secret:$name:overlap"
  def revokedKey(name: String): String = s"secret:$name:revoked"

  def activate(name: String, versionId: String): Option[String] = {
    val previous = jedis.eval(SwapLua, List(activeKey(name), overlapKey(name)).asJava, List(versionId, OverlapSeconds.toString).asJava)
    Option(previous).map(_.toString).filter(_.nonEmpty)
  }

  /** The active version, then the overlapping previous one while its window lasts; never a revoked one. */
  def validVersions(name: String): Seq[String] = {
    val revoked = jedis.smembers(revokedKey(name)).asScala
    jedis.mget(activeKey(name), overlapKey(name)).asScala.toSeq.filter(v => v != null && !revoked.contains(v))
  }

  /** Revoke a version that is not the active one; false (and nothing changes) for the active version. */
  def revoke(name: String, versionId: String): Boolean =
    if (Option(jedis.get(activeKey(name))).contains(versionId)) false
    else {
      jedis.sadd(revokedKey(name), versionId)
      true
    }

  /** End the overlap now when it holds versionId. */
  def retire(name: String, versionId: String): Unit =
    if (Option(jedis.get(overlapKey(name))).contains(versionId)) jedis.del(overlapKey(name))
}
`,
};
