/**
 * Hand-written support modules the dataset-registry steps import but no step builds: the `registry`
 * package. `registry.store` is the registry database and the object store (Redis is the course's
 * stand-in for both): objects under their content hash, one hash per version record, the outbox
 * and the URL signer. `registry.pointer` is the latest-version pointer of step 2 as later steps use
 * it: `promote`, `latest`, `pin` and `purge`. The five languages keep the same keys, so a harness
 * reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'registry/__init__.py': '',
  'registry/store.py': `"""
The registry store (provided). object:{sha} holds an object's bytes under its SHA-256, one row per
line. dataset:{dataset}:v:{version} is a version record, a hash with tenant, dataset, version,
content_sha256, license, owner, size_bytes, row_count, status (registered, validated, rejected or
pending) and report (the validator's report as JSON, "" when none); dataset:{dataset}:versions is
the set of a dataset's version names; outbox is a list of events the broker did not take.
A record is returned as a dict: size_bytes and row_count are ints, report a dict or None.
"""
import hashlib
import hmac
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SIGNING_KEY = b"registry-signing-key"
OBJECT_BASE = "https://objects.registry.internal"
FIELDS = ("tenant", "dataset", "version", "content_sha256", "license", "owner", "size_bytes", "row_count", "status")


def version_key(dataset: str, version: str) -> str:
    return f"dataset:{dataset}:v:{version}"


def versions_key(dataset: str) -> str:
    return f"dataset:{dataset}:versions"


def put_object(content: str) -> str:
    """Store an object's bytes under their SHA-256 and return the hash."""
    sha = hashlib.sha256(content.encode()).hexdigest()
    r.set(f"object:{sha}", content)
    return sha


def read_object(sha: str) -> str | None:
    return r.get(f"object:{sha}")


def measure(sha: str) -> tuple[int, int] | None:
    """One scan of the stored object: (size in bytes, rows), or None when no object has that hash."""
    content = read_object(sha)
    if content is None:
        return None
    return len(content.encode()), sum(1 for line in content.split("\\n") if line)


def _mapping(record: dict) -> dict:
    mapping = {name: "" if record.get(name) is None else str(record[name]) for name in FIELDS}
    mapping["status"] = mapping["status"] or "registered"
    report = record.get("report")
    mapping["report"] = "" if report is None else json.dumps(report)
    return mapping


def version(dataset: str, version: str) -> dict | None:
    """The version record, or None."""
    raw = r.hgetall(version_key(dataset, version))
    if not raw:
        return None
    record = {name: raw.get(name, "") for name in FIELDS}
    record["size_bytes"] = int(raw.get("size_bytes") or 0)
    record["row_count"] = int(raw.get("row_count") or 0)
    record["report"] = json.loads(raw["report"]) if raw.get("report") else None
    return record


def versions(dataset: str) -> list[str]:
    """The dataset's version names, sorted."""
    return sorted(r.smembers(versions_key(dataset)))


def put_version(record: dict) -> None:
    """The bulk importer's writer: writes the record over whatever the key holds."""
    r.hset(version_key(record["dataset"], record["version"]), mapping=_mapping(record))
    r.sadd(versions_key(record["dataset"]), record["version"])


def create_version(record: dict) -> bool:
    """Writes the record only if (dataset, version) does not exist yet (HSETNX decides); False when it does."""
    key = version_key(record["dataset"], record["version"])
    if not r.hsetnx(key, "dataset", record["dataset"]):
        return False
    r.hset(key, mapping=_mapping(record))
    r.sadd(versions_key(record["dataset"]), record["version"])
    return True


def set_validation(dataset: str, version: str, status: str, report: dict | None) -> None:
    """Record the validation outcome (validated, rejected or pending) and the report, if any."""
    r.hset(version_key(dataset, version), mapping={"status": status, "report": "" if report is None else json.dumps(report)})


def add_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take; a relay produces it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def sign_url(tenant: str, sha: str, expires_at: int) -> str:
    """A download URL for the object, valid for tenant until expires_at (epoch seconds)."""
    sig = hmac.new(SIGNING_KEY, f"{tenant}:{sha}:{expires_at}".encode(), hashlib.sha256).hexdigest()
    return f"{OBJECT_BASE}/{sha}?tenant={tenant}&expires={expires_at}&sig={sig}"
`,
  'registry/pointer.py': `"""
The latest-version pointer (provided; step 2 builds the same functions). dataset:{dataset}:latest
names the promoted version and has no expiry; dataset:{dataset}:audit lists every promotion as
"{previous}->{version} by {actor}", appended in the same Lua script that moves the pointer;
dataset:{dataset}:pins maps a consumer to the version it pinned, which no promotion touches.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PROMOTE_LUA = """
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
"""
PURGE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
"""
promote_script = r.register_script(PROMOTE_LUA)
purge_script = r.register_script(PURGE_LUA)


class LatestVersionMissing(Exception):
    """The dataset has no promoted version."""


class VersionPinned(Exception):
    """The version is the latest or a consumer pins it: it cannot be purged."""


def latest_key(dataset: str) -> str:
    return f"dataset:{dataset}:latest"


def audit_key(dataset: str) -> str:
    return f"dataset:{dataset}:audit"


def pins_key(dataset: str) -> str:
    return f"dataset:{dataset}:pins"


def promote(dataset: str, version: str, actor: str) -> str:
    """Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none)."""
    return promote_script(keys=[latest_key(dataset), audit_key(dataset)], args=[version, actor])


def latest(dataset: str) -> str:
    """The promoted version; raises LatestVersionMissing when there is none."""
    version = r.get(latest_key(dataset))
    if version is None:
        raise LatestVersionMissing(dataset)
    return version


def pin(dataset: str, consumer: str, version: str) -> None:
    r.hset(pins_key(dataset), consumer, version)


def purge(dataset: str, version: str) -> None:
    """Delete a version record; raises VersionPinned when it is the latest or a consumer pins it."""
    keys = [latest_key(dataset), pins_key(dataset), f"dataset:{dataset}:v:{version}", f"dataset:{dataset}:versions"]
    if purge_script(keys=keys, args=[version]) == 0:
        raise VersionPinned(f"{dataset}@{version}")
`,
};

export const supportModulesTs: Record<string, string> = {
  'registry/store.ts': `/**
 * The registry store (provided). object:{sha} holds an object's bytes under its SHA-256, one row per
 * line. dataset:{dataset}:v:{version} is a version record, a hash with tenant, dataset, version,
 * content_sha256, license, owner, size_bytes, row_count, status (registered, validated, rejected or
 * pending) and report (the validator's report as JSON, "" when none); dataset:{dataset}:versions is
 * the set of a dataset's version names; outbox is a list of events the broker did not take.
 */
import Redis from 'ioredis';
import {createHash, createHmac} from 'node:crypto';

const redis = new Redis({host: 'redis', port: 6379});

export const SIGNING_KEY = 'registry-signing-key';
export const OBJECT_BASE = 'https://objects.registry.internal';
const FIELDS = ['tenant', 'dataset', 'version', 'content_sha256', 'license', 'owner', 'size_bytes', 'row_count', 'status'] as const;

export interface Report {
  passed: boolean;
  rows_scanned: number;
  rows_total: number;
  failures: string[];
}

export interface VersionRecord {
  tenant: string;
  dataset: string;
  version: string;
  content_sha256: string;
  license: string;
  owner: string;
  size_bytes: number;
  row_count: number;
  status: string;
  report: Report | null;
}

export const versionKey = (dataset: string, version: string): string => \`dataset:\${dataset}:v:\${version}\`;
export const versionsKey = (dataset: string): string => \`dataset:\${dataset}:versions\`;

/** Store an object's bytes under their SHA-256 and return the hash. */
export async function putObject(content: string): Promise<string> {
  const sha = createHash('sha256').update(content).digest('hex') as string;
  await redis.set(\`object:\${sha}\`, content);
  return sha;
}

export async function readObject(sha: string): Promise<string | null> {
  return redis.get(\`object:\${sha}\`);
}

/** One scan of the stored object: its size in bytes and its rows, or null when no object has that hash. */
export async function measure(sha: string): Promise<{size_bytes: number; row_count: number} | null> {
  const content = await readObject(sha);
  if (content === null) return null;
  return {size_bytes: new TextEncoder().encode(content).length, row_count: content.split('\\n').filter(line => line !== '').length};
}

function mapping(record: VersionRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FIELDS) out[name] = record[name] === undefined || record[name] === null ? '' : String(record[name]);
  out.status = out.status || 'registered';
  out.report = record.report ? JSON.stringify(record.report) : '';
  return out;
}

/** The version record, or null. */
export async function version(dataset: string, version: string): Promise<VersionRecord | null> {
  const raw = await redis.hgetall(versionKey(dataset, version));
  if (Object.keys(raw).length === 0) return null;
  return {
    tenant: raw.tenant ?? '',
    dataset: raw.dataset ?? '',
    version: raw.version ?? '',
    content_sha256: raw.content_sha256 ?? '',
    license: raw.license ?? '',
    owner: raw.owner ?? '',
    size_bytes: Number(raw.size_bytes || 0),
    row_count: Number(raw.row_count || 0),
    status: raw.status ?? '',
    report: raw.report ? (JSON.parse(raw.report) as Report) : null,
  };
}

/** The dataset's version names, sorted. */
export async function versions(dataset: string): Promise<string[]> {
  return (await redis.smembers(versionsKey(dataset))).sort();
}

/** The bulk importer's writer: writes the record over whatever the key holds. */
export async function putVersion(record: VersionRecord): Promise<void> {
  await redis.hset(versionKey(record.dataset, record.version), mapping(record));
  await redis.sadd(versionsKey(record.dataset), record.version);
}

/** Writes the record only if (dataset, version) does not exist yet (HSETNX decides); false when it does. */
export async function createVersion(record: VersionRecord): Promise<boolean> {
  const key = versionKey(record.dataset, record.version);
  if ((await redis.hsetnx(key, 'dataset', record.dataset)) === 0) return false;
  await redis.hset(key, mapping(record));
  await redis.sadd(versionsKey(record.dataset), record.version);
  return true;
}

/** Record the validation outcome (validated, rejected or pending) and the report, if any. */
export async function setValidation(dataset: string, version: string, status: string, report: Report | null): Promise<void> {
  await redis.hset(versionKey(dataset, version), {status, report: report ? JSON.stringify(report) : ''});
}

/** Keep an event the broker did not take; a relay produces it later. */
export async function addOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** A download URL for the object, valid for tenant until expiresAt (epoch seconds). */
export function signUrl(tenant: string, sha: string, expiresAt: number): string {
  const sig = createHmac('sha256', SIGNING_KEY).update(\`\${tenant}:\${sha}:\${expiresAt}\`).digest('hex') as string;
  return \`\${OBJECT_BASE}/\${sha}?tenant=\${tenant}&expires=\${expiresAt}&sig=\${sig}\`;
}
`,
  'registry/pointer.ts': `/**
 * The latest-version pointer (provided; step 2 builds the same functions). dataset:{dataset}:latest
 * names the promoted version and has no expiry; dataset:{dataset}:audit lists every promotion as
 * "{previous}->{version} by {actor}", appended in the same Lua script that moves the pointer;
 * dataset:{dataset}:pins maps a consumer to the version it pinned, which no promotion touches.
 */
import Redis from 'ioredis';

export const PROMOTE_LUA = \`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
\`;
export const PURGE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
\`;

interface PointerRedis extends Redis {
  promoteVersion(latest: string, audit: string, version: string, actor: string): Promise<string>;
  purgeVersion(latest: string, pins: string, record: string, versions: string, version: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PointerRedis;
redis.defineCommand('promoteVersion', {numberOfKeys: 2, lua: PROMOTE_LUA});
redis.defineCommand('purgeVersion', {numberOfKeys: 4, lua: PURGE_LUA});

/** The dataset has no promoted version. */
export class LatestVersionMissing extends Error {}
/** The version is the latest or a consumer pins it: it cannot be purged. */
export class VersionPinned extends Error {}

export const latestKey = (dataset: string): string => \`dataset:\${dataset}:latest\`;
export const auditKey = (dataset: string): string => \`dataset:\${dataset}:audit\`;
export const pinsKey = (dataset: string): string => \`dataset:\${dataset}:pins\`;

/** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
export async function promote(dataset: string, version: string, actor: string): Promise<string> {
  return redis.promoteVersion(latestKey(dataset), auditKey(dataset), version, actor);
}

/** The promoted version; throws LatestVersionMissing when there is none. */
export async function latest(dataset: string): Promise<string> {
  const version = await redis.get(latestKey(dataset));
  if (version === null) throw new LatestVersionMissing(dataset);
  return version;
}

export async function pin(dataset: string, consumer: string, version: string): Promise<void> {
  await redis.hset(pinsKey(dataset), consumer, version);
}

/** Delete a version record; throws VersionPinned when it is the latest or a consumer pins it. */
export async function purge(dataset: string, version: string): Promise<void> {
  const purged = await redis.purgeVersion(latestKey(dataset), pinsKey(dataset), \`dataset:\${dataset}:v:\${version}\`, \`dataset:\${dataset}:versions\`, version);
  if (purged === 0) throw new VersionPinned(\`\${dataset}@\${version}\`);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'registry/store/store.go': `// Package store is the registry store (provided). object:{sha} holds an object's bytes under its
// SHA-256, one row per line. dataset:{dataset}:v:{version} is a version record, a hash with tenant,
// dataset, version, content_sha256, license, owner, size_bytes, row_count, status (registered,
// validated, rejected or pending) and report (the validator's report as JSON, "" when none);
// dataset:{dataset}:versions is the set of a dataset's version names; outbox is a list of events
// the broker did not take.
package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	SigningKey = "registry-signing-key"
	ObjectBase = "https://objects.registry.internal"
)

// Report is what the validator answered about a version.
type Report struct {
	Passed      bool     \`json:"passed"\`
	RowsScanned int64    \`json:"rows_scanned"\`
	RowsTotal   int64    \`json:"rows_total"\`
	Failures    []string \`json:"failures"\`
}

// VersionRecord is one registered version of a dataset.
type VersionRecord struct {
	Tenant        string  \`json:"tenant"\`
	Dataset       string  \`json:"dataset"\`
	Version       string  \`json:"version"\`
	ContentSHA256 string  \`json:"content_sha256"\`
	License       string  \`json:"license"\`
	Owner         string  \`json:"owner"\`
	SizeBytes     int64   \`json:"size_bytes"\`
	RowCount      int64   \`json:"row_count"\`
	Status        string  \`json:"status"\`
	Report        *Report \`json:"report"\`
}

// VersionKey is the hash of one version record.
func VersionKey(dataset, version string) string { return "dataset:" + dataset + ":v:" + version }

// VersionsKey is the set of a dataset's version names.
func VersionsKey(dataset string) string { return "dataset:" + dataset + ":versions" }

// PutObject stores an object's bytes under their SHA-256 and returns the hash.
func PutObject(ctx context.Context, content string) string {
	sum := sha256.Sum256([]byte(content))
	sha := hex.EncodeToString(sum[:])
	rdb.Set(ctx, "object:"+sha, content, 0)
	return sha
}

// ReadObject is the object's bytes; ok is false when no object has that hash.
func ReadObject(ctx context.Context, sha string) (string, bool) {
	content, err := rdb.Get(ctx, "object:"+sha).Result()
	return content, err == nil
}

// Measure is one scan of the stored object: its size in bytes and its rows; ok is false when no
// object has that hash.
func Measure(ctx context.Context, sha string) (sizeBytes, rowCount int64, ok bool) {
	content, found := ReadObject(ctx, sha)
	if !found {
		return 0, 0, false
	}
	for _, line := range strings.Split(content, "\\n") {
		if line != "" {
			rowCount++
		}
	}
	return int64(len(content)), rowCount, true
}

func mapping(rec *VersionRecord) map[string]any {
	status := rec.Status
	if status == "" {
		status = "registered"
	}
	report := ""
	if rec.Report != nil {
		raw, _ := json.Marshal(rec.Report)
		report = string(raw)
	}
	return map[string]any{
		"tenant": rec.Tenant, "dataset": rec.Dataset, "version": rec.Version, "content_sha256": rec.ContentSHA256,
		"license": rec.License, "owner": rec.Owner, "size_bytes": strconv.FormatInt(rec.SizeBytes, 10),
		"row_count": strconv.FormatInt(rec.RowCount, 10), "status": status, "report": report,
	}
}

// Version is the version record, or nil.
func Version(ctx context.Context, dataset, version string) *VersionRecord {
	raw := rdb.HGetAll(ctx, VersionKey(dataset, version)).Val()
	if len(raw) == 0 {
		return nil
	}
	size, _ := strconv.ParseInt(raw["size_bytes"], 10, 64)
	rows, _ := strconv.ParseInt(raw["row_count"], 10, 64)
	rec := &VersionRecord{
		Tenant: raw["tenant"], Dataset: raw["dataset"], Version: raw["version"], ContentSHA256: raw["content_sha256"],
		License: raw["license"], Owner: raw["owner"], SizeBytes: size, RowCount: rows, Status: raw["status"],
	}
	if raw["report"] != "" {
		var report Report
		if json.Unmarshal([]byte(raw["report"]), &report) == nil {
			rec.Report = &report
		}
	}
	return rec
}

// Versions is the dataset's version names, sorted.
func Versions(ctx context.Context, dataset string) []string {
	names := rdb.SMembers(ctx, VersionsKey(dataset)).Val()
	sort.Strings(names)
	return names
}

// PutVersion is the bulk importer's writer: it writes the record over whatever the key holds.
func PutVersion(ctx context.Context, rec *VersionRecord) error {
	if err := rdb.HSet(ctx, VersionKey(rec.Dataset, rec.Version), mapping(rec)).Err(); err != nil {
		return err
	}
	return rdb.SAdd(ctx, VersionsKey(rec.Dataset), rec.Version).Err()
}

// CreateVersion writes the record only if (dataset, version) does not exist yet (HSETNX decides);
// false when it does.
func CreateVersion(ctx context.Context, rec *VersionRecord) (bool, error) {
	key := VersionKey(rec.Dataset, rec.Version)
	created, err := rdb.HSetNX(ctx, key, "dataset", rec.Dataset).Result()
	if err != nil || !created {
		return false, err
	}
	if err := rdb.HSet(ctx, key, mapping(rec)).Err(); err != nil {
		return false, err
	}
	return true, rdb.SAdd(ctx, VersionsKey(rec.Dataset), rec.Version).Err()
}

// SetValidation records the validation outcome (validated, rejected or pending) and the report, if any.
func SetValidation(ctx context.Context, dataset, version, status string, report *Report) error {
	raw := ""
	if report != nil {
		encoded, _ := json.Marshal(report)
		raw = string(encoded)
	}
	return rdb.HSet(ctx, VersionKey(dataset, version), map[string]any{"status": status, "report": raw}).Err()
}

// AddOutbox keeps an event the broker did not take; a relay produces it later.
func AddOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", string(raw)).Err()
}

// SignURL is a download URL for the object, valid for tenant until expiresAt (epoch seconds).
func SignURL(tenant, sha string, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(SigningKey))
	mac.Write([]byte(fmt.Sprintf("%s:%s:%d", tenant, sha, expiresAt)))
	return fmt.Sprintf("%s/%s?tenant=%s&expires=%d&sig=%s", ObjectBase, sha, tenant, expiresAt, hex.EncodeToString(mac.Sum(nil)))
}
`,
  'registry/pointer/pointer.go': `// Package pointer is the latest-version pointer (provided; step 2 builds the same functions).
// dataset:{dataset}:latest names the promoted version and has no expiry; dataset:{dataset}:audit
// lists every promotion as "{previous}->{version} by {actor}", appended in the same Lua script that
// moves the pointer; dataset:{dataset}:pins maps a consumer to the version it pinned, which no
// promotion touches.
package pointer

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	// ErrLatestVersionMissing: the dataset has no promoted version.
	ErrLatestVersionMissing = errors.New("latest version missing")
	// ErrVersionPinned: the version is the latest or a consumer pins it, it cannot be purged.
	ErrVersionPinned = errors.New("version is pinned")
)

var promoteScript = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
\`)

var purgeScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
\`)

func LatestKey(dataset string) string { return "dataset:" + dataset + ":latest" }
func AuditKey(dataset string) string  { return "dataset:" + dataset + ":audit" }
func PinsKey(dataset string) string   { return "dataset:" + dataset + ":pins" }

// Promote makes version the dataset's latest and appends the audit entry; it returns the previous
// latest ("" when none).
func Promote(ctx context.Context, dataset, version, actor string) (string, error) {
	return promoteScript.Run(ctx, rdb, []string{LatestKey(dataset), AuditKey(dataset)}, version, actor).Text()
}

// Latest is the promoted version; ErrLatestVersionMissing when there is none.
func Latest(ctx context.Context, dataset string) (string, error) {
	version, err := rdb.Get(ctx, LatestKey(dataset)).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("%w: %s", ErrLatestVersionMissing, dataset)
	}
	return version, err
}

// Pin records the version a consumer reads.
func Pin(ctx context.Context, dataset, consumer, version string) error {
	return rdb.HSet(ctx, PinsKey(dataset), consumer, version).Err()
}

// Purge deletes a version record; ErrVersionPinned when it is the latest or a consumer pins it.
func Purge(ctx context.Context, dataset, version string) error {
	keys := []string{LatestKey(dataset), PinsKey(dataset), "dataset:" + dataset + ":v:" + version, "dataset:" + dataset + ":versions"}
	purged, err := purgeScript.Run(ctx, rdb, keys, version).Int64()
	if err != nil {
		return err
	}
	if purged == 0 {
		return fmt.Errorf("%w: %s@%s", ErrVersionPinned, dataset, version)
	}
	return nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'registry/store.h': `// The registry store (provided). object:{sha} holds an object's bytes under its SHA-256, one row per
// line. dataset:{dataset}:v:{version} is a version record, a hash with tenant, dataset, version,
// content_sha256, license, owner, size_bytes, row_count, status (registered, validated, rejected or
// pending) and report (the validator's report as JSON, "" when none); dataset:{dataset}:versions is
// the set of a dataset's version names; outbox is a list of events the broker did not take.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kSigningKey = "registry-signing-key";
inline const std::string kObjectBase = "https://objects.registry.internal";

struct VersionRecord {
  std::string tenant;
  std::string dataset;
  std::string version;
  std::string content_sha256;
  std::string license;
  std::string owner;
  long long size_bytes = 0;
  long long row_count = 0;
  std::string status = "registered";
  std::optional<nlohmann::json> report;  // {passed, rows_scanned, rows_total, failures}
};

struct Measured {
  long long size_bytes = 0;
  long long row_count = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string versionKey(const std::string& dataset, const std::string& version) {
  return "dataset:" + dataset + ":v:" + version;
}

inline std::string versionsKey(const std::string& dataset) { return "dataset:" + dataset + ":versions"; }

inline std::string toHex(const unsigned char* data, size_t n) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < n; i++) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 15];
  }
  return out;
}

// Store an object's bytes under their SHA-256 and return the hash.
inline std::string putObject(const std::string& content) {
  unsigned char digest[32];
  SHA256(reinterpret_cast<const unsigned char*>(content.data()), content.size(), digest);
  const std::string sha = toHex(digest, 32);
  redis().set("object:" + sha, content);
  return sha;
}

inline std::optional<std::string> readObject(const std::string& sha) {
  const auto content = redis().get("object:" + sha);
  if (!content) return std::nullopt;
  return std::string(*content);
}

// One scan of the stored object: its size in bytes and its rows, or none when no object has that hash.
inline std::optional<Measured> measure(const std::string& sha) {
  const auto content = readObject(sha);
  if (!content) return std::nullopt;
  Measured m;
  m.size_bytes = static_cast<long long>(content->size());
  std::istringstream lines(*content);
  for (std::string line; std::getline(lines, line);) {
    if (!line.empty()) m.row_count++;
  }
  return m;
}

inline std::map<std::string, std::string> mapping(const VersionRecord& rec) {
  return {{"tenant", rec.tenant},
          {"dataset", rec.dataset},
          {"version", rec.version},
          {"content_sha256", rec.content_sha256},
          {"license", rec.license},
          {"owner", rec.owner},
          {"size_bytes", std::to_string(rec.size_bytes)},
          {"row_count", std::to_string(rec.row_count)},
          {"status", rec.status.empty() ? "registered" : rec.status},
          {"report", rec.report ? rec.report->dump() : ""}};
}

// The version record, or none.
inline std::optional<VersionRecord> version(const std::string& dataset, const std::string& version) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(versionKey(dataset, version));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  VersionRecord rec;
  rec.tenant = text("tenant");
  rec.dataset = text("dataset");
  rec.version = text("version");
  rec.content_sha256 = text("content_sha256");
  rec.license = text("license");
  rec.owner = text("owner");
  rec.size_bytes = text("size_bytes").empty() ? 0 : std::stoll(text("size_bytes"));
  rec.row_count = text("row_count").empty() ? 0 : std::stoll(text("row_count"));
  rec.status = text("status");
  if (!text("report").empty()) rec.report = nlohmann::json::parse(text("report"));
  return rec;
}

// The dataset's version names, sorted.
inline std::vector<std::string> versions(const std::string& dataset) {
  std::vector<std::string> names = redis().smembers(versionsKey(dataset));
  std::sort(names.begin(), names.end());
  return names;
}

// The bulk importer's writer: writes the record over whatever the key holds.
inline void putVersion(const VersionRecord& rec) {
  const auto fields = mapping(rec);
  redis().hset(versionKey(rec.dataset, rec.version), fields.begin(), fields.end());
  redis().sadd(versionsKey(rec.dataset), rec.version);
}

// Writes the record only if (dataset, version) does not exist yet (HSETNX decides); false when it does.
inline bool createVersion(const VersionRecord& rec) {
  const std::string key = versionKey(rec.dataset, rec.version);
  if (!redis().hsetnx(key, "dataset", rec.dataset)) return false;
  const auto fields = mapping(rec);
  redis().hset(key, fields.begin(), fields.end());
  redis().sadd(versionsKey(rec.dataset), rec.version);
  return true;
}

// Record the validation outcome (validated, rejected or pending) and the report, if any.
inline void setValidation(const std::string& dataset, const std::string& version, const std::string& status,
                          const std::optional<nlohmann::json>& report) {
  const std::string raw = report ? report->dump() : std::string();
  redis().hset(versionKey(dataset, version), "status", status, "report", raw);
}

// Keep an event the broker did not take; a relay produces it later.
inline void addOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// A download URL for the object, valid for tenant until expires_at (epoch seconds).
inline std::string signUrl(const std::string& tenant, const std::string& sha, long long expires_at) {
  const std::string message = tenant + ":" + sha + ":" + std::to_string(expires_at);
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int len = 0;
  HMAC(EVP_sha256(), kSigningKey.data(), static_cast<int>(kSigningKey.size()),
       reinterpret_cast<const unsigned char*>(message.data()), message.size(), mac, &len);
  return kObjectBase + "/" + sha + "?tenant=" + tenant + "&expires=" + std::to_string(expires_at) + "&sig=" + toHex(mac, len);
}

}  // namespace store
`,
  'registry/pointer.h': `// The latest-version pointer (provided; step 2 builds the same functions). dataset:{dataset}:latest
// names the promoted version and has no expiry; dataset:{dataset}:audit lists every promotion as
// "{previous}->{version} by {actor}", appended in the same Lua script that moves the pointer;
// dataset:{dataset}:pins maps a consumer to the version it pinned, which no promotion touches.
#pragma once

#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

namespace pointer {

inline const std::string kPromoteLua = R"lua(
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
return previous
)lua";

inline const std::string kPurgeLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
  if pinned == ARGV[1] then return 0 end
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[1])
return 1
)lua";

// The dataset has no promoted version.
struct LatestVersionMissing : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The version is the latest or a consumer pins it: it cannot be purged.
struct VersionPinned : std::runtime_error {
  using std::runtime_error::runtime_error;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string latestKey(const std::string& dataset) { return "dataset:" + dataset + ":latest"; }
inline std::string auditKey(const std::string& dataset) { return "dataset:" + dataset + ":audit"; }
inline std::string pinsKey(const std::string& dataset) { return "dataset:" + dataset + ":pins"; }

// Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none).
inline std::string promote(const std::string& dataset, const std::string& version, const std::string& actor) {
  return redis().eval<std::string>(kPromoteLua, {latestKey(dataset), auditKey(dataset)}, {version, actor});
}

// The promoted version; throws LatestVersionMissing when there is none.
inline std::string latest(const std::string& dataset) {
  const auto version = redis().get(latestKey(dataset));
  if (!version) throw LatestVersionMissing(dataset);
  return std::string(*version);
}

inline void pin(const std::string& dataset, const std::string& consumer, const std::string& version) {
  redis().hset(pinsKey(dataset), consumer, version);
}

// Delete a version record; throws VersionPinned when it is the latest or a consumer pins it.
inline void purge(const std::string& dataset, const std::string& version) {
  const long long purged = redis().eval<long long>(
      kPurgeLua, {latestKey(dataset), pinsKey(dataset), "dataset:" + dataset + ":v:" + version, "dataset:" + dataset + ":versions"},
      {version});
  if (purged == 0) throw VersionPinned(dataset + "@" + version);
}

}  // namespace pointer
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('registry', 'Store')]: `package registry

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The registry store (provided). object:{sha} holds an object's bytes under its SHA-256, one row per
 * line. dataset:{dataset}:v:{version} is a version record, a hash with tenant, dataset, version,
 * content_sha256, license, owner, size_bytes, row_count, status (registered, validated, rejected or
 * pending) and report (the validator's report as JSON, "" when none); dataset:{dataset}:versions is
 * the set of a dataset's version names; outbox is a list of events the broker did not take.
 */
object Store {
  final case class VersionRecord(
      tenant: String,
      dataset: String,
      version: String,
      contentSha256: String,
      license: String,
      owner: String,
      sizeBytes: Long,
      rowCount: Long,
      status: String = "registered",
      report: Option[JsObject] = None)

  val SigningKey = "registry-signing-key"
  val ObjectBase = "https://objects.registry.internal"

  val jedis = new JedisPooled("redis", 6379)

  def versionKey(dataset: String, version: String): String = s"dataset:$dataset:v:$version"
  def versionsKey(dataset: String): String = s"dataset:$dataset:versions"

  private def hex(bytes: Array[Byte]): String = bytes.map(b => f"\${b & 0xff}%02x").mkString

  /** Store an object's bytes under their SHA-256 and return the hash. */
  def putObject(content: String): String = {
    val sha = hex(MessageDigest.getInstance("SHA-256").digest(content.getBytes("UTF-8")))
    jedis.set(s"object:$sha", content)
    sha
  }

  def readObject(sha: String): Option[String] = Option(jedis.get(s"object:$sha"))

  /** One scan of the stored object: (size in bytes, rows), or None when no object has that hash. */
  def measure(sha: String): Option[(Long, Long)] =
    readObject(sha).map(content => (content.getBytes("UTF-8").length.toLong, content.split("\\n").count(_.nonEmpty).toLong))

  private def mapping(rec: VersionRecord): Map[String, String] = Map(
    "tenant" -> rec.tenant, "dataset" -> rec.dataset, "version" -> rec.version, "content_sha256" -> rec.contentSha256,
    "license" -> rec.license, "owner" -> rec.owner, "size_bytes" -> rec.sizeBytes.toString, "row_count" -> rec.rowCount.toString,
    "status" -> (if (rec.status.isEmpty) "registered" else rec.status), "report" -> rec.report.map(_.compactPrint).getOrElse(""))

  /** The version record, if it exists. */
  def version(dataset: String, version: String): Option[VersionRecord] = {
    val raw = jedis.hgetAll(versionKey(dataset, version)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      def number(name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
      Some(VersionRecord(text("tenant"), text("dataset"), text("version"), text("content_sha256"), text("license"), text("owner"),
        number("size_bytes"), number("row_count"), text("status"), raw.get("report").filter(_.nonEmpty).map(_.parseJson.asJsObject)))
    }
  }

  /** The dataset's version names, sorted. */
  def versions(dataset: String): Seq[String] = jedis.smembers(versionsKey(dataset)).asScala.toSeq.sorted

  /** The bulk importer's writer: writes the record over whatever the key holds. */
  def putVersion(rec: VersionRecord): Unit = {
    jedis.hset(versionKey(rec.dataset, rec.version), mapping(rec).asJava)
    jedis.sadd(versionsKey(rec.dataset), rec.version)
  }

  /** Writes the record only if (dataset, version) does not exist yet (HSETNX decides); false when it does. */
  def createVersion(rec: VersionRecord): Boolean = {
    val key = versionKey(rec.dataset, rec.version)
    if (jedis.hsetnx(key, "dataset", rec.dataset) == 0L) false
    else {
      jedis.hset(key, mapping(rec).asJava)
      jedis.sadd(versionsKey(rec.dataset), rec.version)
      true
    }
  }

  /** Record the validation outcome (validated, rejected or pending) and the report, if any. */
  def setValidation(dataset: String, version: String, status: String, report: Option[JsObject]): Unit =
    jedis.hset(versionKey(dataset, version), Map("status" -> status, "report" -> report.map(_.compactPrint).getOrElse("")).asJava)

  /** Keep an event the broker did not take; a relay produces it later. */
  def addOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** A download URL for the object, valid for tenant until expiresAt (epoch seconds). */
  def signUrl(tenant: String, sha: String, expiresAt: Long): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(SigningKey.getBytes("UTF-8"), "HmacSHA256"))
    val sig = hex(mac.doFinal(s"$tenant:$sha:$expiresAt".getBytes("UTF-8")))
    s"$ObjectBase/$sha?tenant=$tenant&expires=$expiresAt&sig=$sig"
  }
}
`,
  [scalaPath('registry', 'Pointer')]: `package registry

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The dataset has no promoted version. */
final class LatestVersionMissing(message: String) extends Exception(message)
/** The version is the latest or a consumer pins it: it cannot be purged. */
final class VersionPinned(message: String) extends Exception(message)

/**
 * The latest-version pointer (provided; step 2 builds the same functions). dataset:{dataset}:latest
 * names the promoted version and has no expiry; dataset:{dataset}:audit lists every promotion as
 * "{previous}->{version} by {actor}", appended in the same Lua script that moves the pointer;
 * dataset:{dataset}:pins maps a consumer to the version it pinned, which no promotion touches.
 */
object Pointer {
  val jedis = new JedisPooled("redis", 6379)

  val PromoteLua: String =
    """local previous = redis.call('GET', KEYS[1]) or ''
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('RPUSH', KEYS[2], previous .. '->' .. ARGV[1] .. ' by ' .. ARGV[2])
      |return previous
      |""".stripMargin

  val PurgeLua: String =
    """if redis.call('GET', KEYS[1]) == ARGV[1] then return 0 end
      |for _, pinned in ipairs(redis.call('HVALS', KEYS[2])) do
      |  if pinned == ARGV[1] then return 0 end
      |end
      |redis.call('DEL', KEYS[3])
      |redis.call('SREM', KEYS[4], ARGV[1])
      |return 1
      |""".stripMargin

  def latestKey(dataset: String): String = s"dataset:$dataset:latest"
  def auditKey(dataset: String): String = s"dataset:$dataset:audit"
  def pinsKey(dataset: String): String = s"dataset:$dataset:pins"

  /** Make version the dataset's latest and append the audit entry; returns the previous latest ("" when none). */
  def promote(dataset: String, version: String, actor: String): String =
    jedis.eval(PromoteLua, List(latestKey(dataset), auditKey(dataset)).asJava, List(version, actor).asJava).asInstanceOf[String]

  /** The promoted version; throws LatestVersionMissing when there is none. */
  def latest(dataset: String): String =
    Option(jedis.get(latestKey(dataset))).getOrElse(throw new LatestVersionMissing(dataset))

  def pin(dataset: String, consumer: String, version: String): Unit = jedis.hset(pinsKey(dataset), consumer, version)

  /** Delete a version record; throws VersionPinned when it is the latest or a consumer pins it. */
  def purge(dataset: String, version: String): Unit = {
    val keys = List(latestKey(dataset), pinsKey(dataset), s"dataset:$dataset:v:$version", s"dataset:$dataset:versions").asJava
    if (jedis.eval(PurgeLua, keys, List(version).asJava).asInstanceOf[java.lang.Long] == 0L) throw new VersionPinned(s"$dataset@$version")
  }
}
`,
};
