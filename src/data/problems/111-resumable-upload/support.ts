/**
 * Hand-written support modules the resumable-upload steps import but no step builds: the `uploads`
 * package. `uploads.store` holds the upload records (Redis hashes, the course's stand-in for the
 * uploads table), the initiation idempotency records and the event outbox. `uploads.manifest` is the
 * part manifest of step 2 as later steps use it: `register_part`, `read_parts`, `uploaded_bytes`.
 * The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'uploads/__init__.py': '',
  'uploads/store.py': `"""
The upload records (provided): every upload is a Redis hash upload:{id} with upload_id, tenant,
total_bytes, part_bytes, part_count, content_type and status (pending or complete).
upload:idem:{tenant}:{key} holds, for 24 hours, the upload id an initiation with that
Idempotency-Key created. The list outbox holds one JSON row {topic, key, payload} per event the
broker did not take, for the relay to publish later. An upload is returned as a dict whose sizes
and part count are ints.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEMPOTENCY_TTL_S = 24 * 60 * 60
INT_FIELDS = ("total_bytes", "part_bytes", "part_count")


def upload_key(upload_id: str) -> str:
    return f"upload:{upload_id}"


def _upload(raw: dict) -> dict | None:
    if not raw:
        return None
    return {**raw, **{name: int(raw[name]) for name in INT_FIELDS}}


def get_upload(upload_id: str) -> dict | None:
    """The upload, or None."""
    return _upload(r.hgetall(upload_key(upload_id)))


def create_upload(tenant: str, total_bytes: int, part_bytes: int, part_count: int, content_type: str) -> dict:
    """A new pending upload with the next id (u-1, u-2, …); returns it."""
    upload_id = f"u-{r.incr('upload:seq')}"
    r.hset(
        upload_key(upload_id),
        mapping={
            "upload_id": upload_id,
            "tenant": tenant,
            "total_bytes": total_bytes,
            "part_bytes": part_bytes,
            "part_count": part_count,
            "content_type": content_type,
            "status": "pending",
        },
    )
    return get_upload(upload_id)


def initiation(tenant: str, key: str) -> dict | None:
    """The upload an earlier initiation with (tenant, Idempotency-Key) created, if any."""
    upload_id = r.get(f"upload:idem:{tenant}:{key}")
    return get_upload(upload_id) if upload_id else None


def record_initiation(tenant: str, key: str, upload_id: str) -> None:
    """Remember for 24 hours that (tenant, Idempotency-Key) created upload_id."""
    r.set(f"upload:idem:{tenant}:{key}", upload_id, ex=IDEMPOTENCY_TTL_S)


def mark_complete(upload_id: str) -> None:
    """The object is committed: the upload's status becomes complete."""
    r.hset(upload_key(upload_id), "status", "complete")


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """One row for the relay: the event the broker did not take."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'uploads/manifest.py': `"""
The part manifest (provided; step 2 builds the same functions): upload:{id}:parts is a hash from
part number to "size:checksum", upload:{id}:bytes the bytes of the registered parts. register_part
registers one part in one Lua script and answers -1 when the number is outside 1..part_count, 0
when the part is already registered (nothing changes), 1 when it is new; both keys expire 24 hours
after the last registration. read_parts lists the registered parts by number; uploaded_bytes reads
the counter.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MANIFEST_TTL_S = 24 * 60 * 60

REGISTER_PART_LUA = """
local n = tonumber(ARGV[1])
if n < 1 or n > tonumber(ARGV[2]) then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[3] .. ':' .. ARGV[4]) == 0 then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
"""
register = r.register_script(REGISTER_PART_LUA)


def parts_key(upload_id: str) -> str:
    return f"upload:{upload_id}:parts"


def bytes_key(upload_id: str) -> str:
    return f"upload:{upload_id}:bytes"


def register_part(upload_id: str, part_number: int, part_count: int, size: int, checksum: str) -> int:
    """1: registered; 0: already registered; -1: part_number outside 1..part_count."""
    return int(register(keys=[parts_key(upload_id), bytes_key(upload_id)], args=[part_number, part_count, size, checksum, MANIFEST_TTL_S]))


def read_parts(upload_id: str) -> list[dict]:
    """The registered parts, by part number: [{"part_number", "size", "checksum"}]."""
    parts = []
    for number, value in r.hgetall(parts_key(upload_id)).items():
        size, checksum = value.split(":", 1)
        parts.append({"part_number": int(number), "size": int(size), "checksum": checksum})
    return sorted(parts, key=lambda p: p["part_number"])


def uploaded_bytes(upload_id: str) -> int:
    """The bytes of the registered parts."""
    return int(r.get(bytes_key(upload_id)) or 0)
`,
};

export const supportModulesTs: Record<string, string> = {
  'uploads/store.ts': `/**
 * The upload records (provided): every upload is a Redis hash upload:{id} with upload_id, tenant,
 * total_bytes, part_bytes, part_count, content_type and status (pending or complete).
 * upload:idem:{tenant}:{key} holds, for 24 hours, the upload id an initiation with that
 * Idempotency-Key created. The list outbox holds one JSON row {topic, key, payload} per event the
 * broker did not take, for the relay to publish later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const IDEMPOTENCY_TTL_S = 24 * 60 * 60;

export interface Upload {
  upload_id: string;
  tenant: string;
  total_bytes: number;
  part_bytes: number;
  part_count: number;
  content_type: string;
  status: string;
}

export const uploadKey = (uploadId: string): string => \`upload:\${uploadId}\`;

function upload(raw: Record<string, string>): Upload | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    upload_id: raw.upload_id,
    tenant: raw.tenant,
    total_bytes: Number(raw.total_bytes),
    part_bytes: Number(raw.part_bytes),
    part_count: Number(raw.part_count),
    content_type: raw.content_type,
    status: raw.status,
  };
}

/** The upload, or null. */
export async function getUpload(uploadId: string): Promise<Upload | null> {
  return upload(await redis.hgetall(uploadKey(uploadId)));
}

/** A new pending upload with the next id (u-1, u-2, …); returns it. */
export async function createUpload(tenant: string, totalBytes: number, partBytes: number, partCount: number, contentType: string): Promise<Upload> {
  const uploadId = \`u-\${await redis.incr('upload:seq')}\`;
  await redis.hset(uploadKey(uploadId), {
    upload_id: uploadId,
    tenant,
    total_bytes: String(totalBytes),
    part_bytes: String(partBytes),
    part_count: String(partCount),
    content_type: contentType,
    status: 'pending',
  });
  return (await getUpload(uploadId)) as Upload;
}

/** The upload an earlier initiation with (tenant, Idempotency-Key) created, if any. */
export async function initiation(tenant: string, key: string): Promise<Upload | null> {
  const uploadId = await redis.get(\`upload:idem:\${tenant}:\${key}\`);
  return uploadId ? getUpload(uploadId) : null;
}

/** Remember for 24 hours that (tenant, Idempotency-Key) created uploadId. */
export async function recordInitiation(tenant: string, key: string, uploadId: string): Promise<void> {
  await redis.set(\`upload:idem:\${tenant}:\${key}\`, uploadId, 'EX', IDEMPOTENCY_TTL_S);
}

/** The object is committed: the upload's status becomes complete. */
export async function markComplete(uploadId: string): Promise<void> {
  await redis.hset(uploadKey(uploadId), 'status', 'complete');
}

/** One row for the relay: the event the broker did not take. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'uploads/manifest.ts': `/**
 * The part manifest (provided; step 2 builds the same functions): upload:{id}:parts is a hash from
 * part number to "size:checksum", upload:{id}:bytes the bytes of the registered parts. registerPart
 * registers one part in one Lua script and answers -1 when the number is outside 1..partCount, 0
 * when the part is already registered (nothing changes), 1 when it is new; both keys expire 24
 * hours after the last registration. readParts lists the registered parts by number;
 * uploadedBytes reads the counter.
 */
import Redis from 'ioredis';

export const MANIFEST_TTL_S = 24 * 60 * 60;

export const REGISTER_PART_LUA = \`
local n = tonumber(ARGV[1])
if n < 1 or n > tonumber(ARGV[2]) then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[3] .. ':' .. ARGV[4]) == 0 then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
\`;

interface ManifestRedis extends Redis {
  registerPart(partsKey: string, bytesKey: string, partNumber: number, partCount: number, size: number, checksum: string, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ManifestRedis;
redis.defineCommand('registerPart', {numberOfKeys: 2, lua: REGISTER_PART_LUA});

export interface Part {
  part_number: number;
  size: number;
  checksum: string;
}

export const partsKey = (uploadId: string): string => \`upload:\${uploadId}:parts\`;
export const bytesKey = (uploadId: string): string => \`upload:\${uploadId}:bytes\`;

/** 1: registered; 0: already registered; -1: partNumber outside 1..partCount. */
export async function registerPart(uploadId: string, partNumber: number, partCount: number, size: number, checksum: string): Promise<number> {
  return Number(await redis.registerPart(partsKey(uploadId), bytesKey(uploadId), partNumber, partCount, size, checksum, MANIFEST_TTL_S));
}

/** The registered parts, by part number. */
export async function readParts(uploadId: string): Promise<Part[]> {
  const raw = await redis.hgetall(partsKey(uploadId));
  return Object.entries(raw)
    .map(([number, value]) => {
      const at = value.indexOf(':');
      return {part_number: Number(number), size: Number(value.slice(0, at)), checksum: value.slice(at + 1)};
    })
    .sort((a, b) => a.part_number - b.part_number);
}

/** The bytes of the registered parts. */
export async function uploadedBytes(uploadId: string): Promise<number> {
  return Number((await redis.get(bytesKey(uploadId))) ?? 0);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'uploads/store/store.go': `// Package store holds the upload records (provided): every upload is a Redis hash upload:{id}
// with upload_id, tenant, total_bytes, part_bytes, part_count, content_type and status (pending
// or complete). upload:idem:{tenant}:{key} holds, for 24 hours, the upload id an initiation with
// that Idempotency-Key created. The list outbox holds one JSON row {topic, key, payload} per event
// the broker did not take, for the relay to publish later.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// IdempotencyTTL is how long an initiation's Idempotency-Key is remembered.
const IdempotencyTTL = 24 * time.Hour

// Upload is one upload record.
type Upload struct {
	UploadID    string \`json:"upload_id"\`
	Tenant      string \`json:"tenant"\`
	TotalBytes  int64  \`json:"total_bytes"\`
	PartBytes   int64  \`json:"part_bytes"\`
	PartCount   int    \`json:"part_count"\`
	ContentType string \`json:"content_type"\`
	Status      string \`json:"status"\`
}

// UploadKey is the hash of an upload record.
func UploadKey(uploadID string) string { return "upload:" + uploadID }

// GetUpload is the upload, or nil.
func GetUpload(ctx context.Context, uploadID string) *Upload {
	raw := rdb.HGetAll(ctx, UploadKey(uploadID)).Val()
	if len(raw) == 0 {
		return nil
	}
	total, _ := strconv.ParseInt(raw["total_bytes"], 10, 64)
	part, _ := strconv.ParseInt(raw["part_bytes"], 10, 64)
	count, _ := strconv.Atoi(raw["part_count"])
	return &Upload{UploadID: raw["upload_id"], Tenant: raw["tenant"], TotalBytes: total, PartBytes: part, PartCount: count, ContentType: raw["content_type"], Status: raw["status"]}
}

// CreateUpload makes a new pending upload with the next id (u-1, u-2, …) and returns it.
func CreateUpload(ctx context.Context, tenant string, totalBytes, partBytes int64, partCount int, contentType string) *Upload {
	uploadID := fmt.Sprintf("u-%d", rdb.Incr(ctx, "upload:seq").Val())
	rdb.HSet(ctx, UploadKey(uploadID), map[string]any{
		"upload_id": uploadID, "tenant": tenant, "total_bytes": strconv.FormatInt(totalBytes, 10), "part_bytes": strconv.FormatInt(partBytes, 10),
		"part_count": strconv.Itoa(partCount), "content_type": contentType, "status": "pending",
	})
	return GetUpload(ctx, uploadID)
}

// Initiation is the upload an earlier initiation with (tenant, Idempotency-Key) created, or nil.
func Initiation(ctx context.Context, tenant, key string) *Upload {
	uploadID, err := rdb.Get(ctx, "upload:idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	return GetUpload(ctx, uploadID)
}

// RecordInitiation remembers for 24 hours that (tenant, Idempotency-Key) created uploadID.
func RecordInitiation(ctx context.Context, tenant, key, uploadID string) {
	rdb.Set(ctx, "upload:idem:"+tenant+":"+key, uploadID, IdempotencyTTL)
}

// MarkComplete records that the object is committed: the upload's status becomes complete.
func MarkComplete(ctx context.Context, uploadID string) {
	rdb.HSet(ctx, UploadKey(uploadID), "status", "complete")
}

// InsertOutbox writes one row for the relay: the event the broker did not take.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", raw).Err()
}
`,
  'uploads/manifest/manifest.go': `// Package manifest is the part manifest (provided; step 2 builds the same functions):
// upload:{id}:parts is a hash from part number to "size:checksum", upload:{id}:bytes the bytes of
// the registered parts. RegisterPart registers one part in one Lua script and answers -1 when the
// number is outside 1..partCount, 0 when the part is already registered (nothing changes), 1 when
// it is new; both keys expire 24 hours after the last registration. ReadParts lists the registered
// parts by number; UploadedBytes reads the counter.
package manifest

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ManifestTTL is how long a manifest outlives its last registration.
const ManifestTTL = 24 * time.Hour

// RegisterPartScript registers one part: -1 out of range, 0 already registered, 1 new.
var RegisterPartScript = redis.NewScript(\`
local n = tonumber(ARGV[1])
if n < 1 or n > tonumber(ARGV[2]) then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[3] .. ':' .. ARGV[4]) == 0 then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
\`)

// Part is one registered part.
type Part struct {
	PartNumber int    \`json:"part_number"\`
	Size       int64  \`json:"size"\`
	Checksum   string \`json:"checksum"\`
}

// PartsKey is the hash of an upload's registered parts.
func PartsKey(uploadID string) string { return "upload:" + uploadID + ":parts" }

// BytesKey is the counter of an upload's registered bytes.
func BytesKey(uploadID string) string { return "upload:" + uploadID + ":bytes" }

// RegisterPart answers 1 when the part is registered, 0 when it already was, -1 when partNumber is outside 1..partCount.
func RegisterPart(ctx context.Context, uploadID string, partNumber, partCount int, size int64, checksum string) (int64, error) {
	return RegisterPartScript.Run(ctx, rdb, []string{PartsKey(uploadID), BytesKey(uploadID)}, partNumber, partCount, size, checksum, int(ManifestTTL.Seconds())).Int64()
}

// ReadParts lists the registered parts by part number.
func ReadParts(ctx context.Context, uploadID string) ([]Part, error) {
	raw, err := rdb.HGetAll(ctx, PartsKey(uploadID)).Result()
	if err != nil {
		return nil, err
	}
	parts := make([]Part, 0, len(raw))
	for number, value := range raw {
		n, _ := strconv.Atoi(number)
		size, checksum, _ := strings.Cut(value, ":")
		bytes, _ := strconv.ParseInt(size, 10, 64)
		parts = append(parts, Part{PartNumber: n, Size: bytes, Checksum: checksum})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	return parts, nil
}

// UploadedBytes is the bytes of the registered parts.
func UploadedBytes(ctx context.Context, uploadID string) (int64, error) {
	n, err := rdb.Get(ctx, BytesKey(uploadID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'uploads/store.h': `// The upload records (provided): every upload is a Redis hash upload:{id} with upload_id, tenant,
// total_bytes, part_bytes, part_count, content_type and status (pending or complete).
// upload:idem:{tenant}:{key} holds, for 24 hours, the upload id an initiation with that
// Idempotency-Key created. The list outbox holds one JSON row {topic, key, payload} per event the
// broker did not take, for the relay to publish later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

namespace store {

struct Upload {
  std::string upload_id;
  std::string tenant;
  long long total_bytes = 0;
  long long part_bytes = 0;
  int part_count = 0;
  std::string content_type;
  std::string status;
};

constexpr std::chrono::seconds kIdempotencyTtl{24 * 60 * 60};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string uploadKey(const std::string& upload_id) { return "upload:" + upload_id; }

// The upload, or none.
inline std::optional<Upload> getUpload(const std::string& upload_id) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall(uploadKey(upload_id));
  if (raw.empty()) return std::nullopt;
  Upload u;
  u.upload_id = raw["upload_id"];
  u.tenant = raw["tenant"];
  u.total_bytes = std::stoll(raw["total_bytes"]);
  u.part_bytes = std::stoll(raw["part_bytes"]);
  u.part_count = std::stoi(raw["part_count"]);
  u.content_type = raw["content_type"];
  u.status = raw["status"];
  return u;
}

// A new pending upload with the next id (u-1, u-2, …); returns it.
inline Upload createUpload(const std::string& tenant, long long total_bytes, long long part_bytes, int part_count,
                           const std::string& content_type) {
  const std::string upload_id = "u-" + std::to_string(redis().incr("upload:seq"));
  redis().hset(uploadKey(upload_id), {{"upload_id", upload_id},
                                      {"tenant", tenant},
                                      {"total_bytes", std::to_string(total_bytes)},
                                      {"part_bytes", std::to_string(part_bytes)},
                                      {"part_count", std::to_string(part_count)},
                                      {"content_type", content_type},
                                      {"status", "pending"}});
  return *getUpload(upload_id);
}

// The upload an earlier initiation with (tenant, Idempotency-Key) created, if any.
inline std::optional<Upload> initiation(const std::string& tenant, const std::string& key) {
  const auto upload_id = redis().get("upload:idem:" + tenant + ":" + key);
  if (!upload_id) return std::nullopt;
  return getUpload(*upload_id);
}

// Remember for 24 hours that (tenant, Idempotency-Key) created upload_id.
inline void recordInitiation(const std::string& tenant, const std::string& key, const std::string& upload_id) {
  redis().set("upload:idem:" + tenant + ":" + key, upload_id, kIdempotencyTtl);
}

// The object is committed: the upload's status becomes complete.
inline void markComplete(const std::string& upload_id) { redis().hset(uploadKey(upload_id), "status", "complete"); }

// One row for the relay: the event the broker did not take.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'uploads/manifest.h': `// The part manifest (provided; step 2 builds the same functions): upload:{id}:parts is a hash from
// part number to "size:checksum", upload:{id}:bytes the bytes of the registered parts. registerPart
// registers one part in one Lua script and answers -1 when the number is outside 1..part_count, 0
// when the part is already registered (nothing changes), 1 when it is new; both keys expire 24
// hours after the last registration. readParts lists the registered parts by number;
// uploadedBytes reads the counter.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

namespace manifest {

constexpr long long kManifestTtlSeconds = 24 * 60 * 60;

inline const std::string kRegisterPartLua = R"lua(
local n = tonumber(ARGV[1])
if n < 1 or n > tonumber(ARGV[2]) then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[3] .. ':' .. ARGV[4]) == 0 then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
)lua";

struct Part {
  int part_number = 0;
  long long size = 0;
  std::string checksum;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string partsKey(const std::string& upload_id) { return "upload:" + upload_id + ":parts"; }
inline std::string bytesKey(const std::string& upload_id) { return "upload:" + upload_id + ":bytes"; }

// 1: registered; 0: already registered; -1: part_number outside 1..part_count.
inline long long registerPart(const std::string& upload_id, int part_number, int part_count, long long size, const std::string& checksum) {
  return redis().eval<long long>(kRegisterPartLua, {partsKey(upload_id), bytesKey(upload_id)},
                                 {std::to_string(part_number), std::to_string(part_count), std::to_string(size), checksum,
                                  std::to_string(kManifestTtlSeconds)});
}

// The registered parts, by part number.
inline std::vector<Part> readParts(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(partsKey(upload_id));
  std::vector<Part> parts;
  for (const auto& [number, value] : raw) {
    const auto at = value.find(':');
    parts.push_back(Part{std::stoi(number), std::stoll(value.substr(0, at)), value.substr(at + 1)});
  }
  std::sort(parts.begin(), parts.end(), [](const Part& a, const Part& b) { return a.part_number < b.part_number; });
  return parts;
}

// The bytes of the registered parts.
inline long long uploadedBytes(const std::string& upload_id) {
  const auto value = redis().get(bytesKey(upload_id));
  return value ? std::stoll(*value) : 0;
}

}  // namespace manifest
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('uploads', 'Store')]: `package uploads

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/** One upload record. */
final case class Upload(uploadId: String, tenant: String, totalBytes: Long, partBytes: Long, partCount: Int, contentType: String, status: String)

/**
 * The upload records (provided): every upload is a Redis hash upload:{id} with upload_id, tenant,
 * total_bytes, part_bytes, part_count, content_type and status (pending or complete).
 * upload:idem:{tenant}:{key} holds, for 24 hours, the upload id an initiation with that
 * Idempotency-Key created. The list outbox holds one JSON row {topic, key, payload} per event the
 * broker did not take, for the relay to publish later.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  val IdempotencyTtlSeconds: Long = 24L * 60 * 60

  def uploadKey(uploadId: String): String = s"upload:$uploadId"

  /** The upload, if it exists. */
  def getUpload(uploadId: String): Option[Upload] = {
    val raw = jedis.hgetAll(uploadKey(uploadId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Upload(raw("upload_id"), raw("tenant"), raw("total_bytes").toLong, raw("part_bytes").toLong, raw("part_count").toInt, raw("content_type"), raw("status")))
  }

  /** A new pending upload with the next id (u-1, u-2, …); returns it. */
  def createUpload(tenant: String, totalBytes: Long, partBytes: Long, partCount: Int, contentType: String): Upload = {
    val uploadId = s"u-\${jedis.incr("upload:seq")}"
    jedis.hset(
      uploadKey(uploadId),
      Map(
        "upload_id" -> uploadId, "tenant" -> tenant, "total_bytes" -> totalBytes.toString, "part_bytes" -> partBytes.toString,
        "part_count" -> partCount.toString, "content_type" -> contentType, "status" -> "pending").asJava)
    getUpload(uploadId).get
  }

  /** The upload an earlier initiation with (tenant, Idempotency-Key) created, if any. */
  def initiation(tenant: String, key: String): Option[Upload] =
    Option(jedis.get(s"upload:idem:$tenant:$key")).flatMap(getUpload)

  /** Remember for 24 hours that (tenant, Idempotency-Key) created uploadId. */
  def recordInitiation(tenant: String, key: String, uploadId: String): Unit =
    jedis.set(s"upload:idem:$tenant:$key", uploadId, SetParams.setParams().ex(IdempotencyTtlSeconds))

  /** The object is committed: the upload's status becomes complete. */
  def markComplete(uploadId: String): Unit = jedis.hset(uploadKey(uploadId), "status", "complete")

  /** One row for the relay: the event the broker did not take. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('uploads', 'Manifest')]: `package uploads

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** One registered part. */
final case class Part(partNumber: Int, size: Long, checksum: String)

/**
 * The part manifest (provided; step 2 builds the same functions): upload:{id}:parts is a hash from
 * part number to "size:checksum", upload:{id}:bytes the bytes of the registered parts. registerPart
 * registers one part in one Lua script and answers -1 when the number is outside 1..partCount, 0
 * when the part is already registered (nothing changes), 1 when it is new; both keys expire 24
 * hours after the last registration. readParts lists the registered parts by number;
 * uploadedBytes reads the counter.
 */
object Manifest {
  val jedis = new JedisPooled("redis", 6379)

  val ManifestTtlSeconds: Long = 24L * 60 * 60

  val RegisterPartLua: String =
    """local n = tonumber(ARGV[1])
      |if n < 1 or n > tonumber(ARGV[2]) then return -1 end
      |if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[3] .. ':' .. ARGV[4]) == 0 then return 0 end
      |redis.call('INCRBY', KEYS[2], ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[5])
      |redis.call('EXPIRE', KEYS[2], ARGV[5])
      |return 1
      |""".stripMargin

  def partsKey(uploadId: String): String = s"upload:$uploadId:parts"
  def bytesKey(uploadId: String): String = s"upload:$uploadId:bytes"

  /** 1: registered; 0: already registered; -1: partNumber outside 1..partCount. */
  def registerPart(uploadId: String, partNumber: Int, partCount: Int, size: Long, checksum: String): Long = {
    val args = List(partNumber.toString, partCount.toString, size.toString, checksum, ManifestTtlSeconds.toString).asJava
    jedis.eval(RegisterPartLua, List(partsKey(uploadId), bytesKey(uploadId)).asJava, args).asInstanceOf[java.lang.Long]
  }

  /** The registered parts, by part number. */
  def readParts(uploadId: String): Seq[Part] =
    jedis.hgetAll(partsKey(uploadId)).asScala.toSeq.map { case (number, value) =>
      val (size, checksum) = value.splitAt(value.indexOf(':'))
      Part(number.toInt, size.toLong, checksum.drop(1))
    }.sortBy(_.partNumber)

  /** The bytes of the registered parts. */
  def uploadedBytes(uploadId: String): Long = Option(jedis.get(bytesKey(uploadId))).map(_.toLong).getOrElse(0L)
}
`,
};
