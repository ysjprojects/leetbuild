/**
 * Hand-written support modules the checkpoint-store steps import but no step builds: the
 * `checkpoint` package. `checkpoint.store` is the upload store (runs, uploads and their staged
 * chunks in Redis, the outbox, signed read URLs); `checkpoint.commit` is step 2's commit as the
 * later steps use it: `commit` (one Lua script that writes the checkpoint record only for a
 * complete chunk set) and `latest_committed`. The five languages keep the same keys, so a harness
 * reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'checkpoint/__init__.py': '',
  'checkpoint/store.py': `"""
The upload store (provided). run:{run_id} holds the run's tenant. upload:{id} holds an upload's
upload_id, run_id, tenant, step and chunks (the chunk count); run:{run_id}:uploads indexes every
opened upload of the run by step, committed or not. upload:{id}:chunks maps a chunk index to the
chunk's bytes (base64), upload:{id}:digests to their SHA-256 (hex). Upload state expires UPLOAD_TTL
seconds after its last write unless a commit persists it. checkpoint:{id} is the record a commit
writes (upload_id, run_id, step, chunks, digest). outbox is a list of JSON rows {topic, key,
payload} a relay publishes later. A read URL is {BASE_URL}/{upload_id}?expires={unix s}&sig={mac}.
"""
import base64
import binascii
import hashlib
import hmac
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

UPLOAD_TTL = 86400
BASE_URL = "https://objects.ckpt.internal"
SIGNING_KEY = b"ckpt-objects-v1"


def create_run(run_id: str, tenant: str) -> None:
    r.hset(f"run:{run_id}", "tenant", tenant)


def run_tenant(run_id: str) -> str | None:
    """The tenant that owns the run, or None for an unknown run."""
    return r.hget(f"run:{run_id}", "tenant")


def upload(upload_id: str) -> dict | None:
    """The upload (upload_id, run_id, tenant, step, chunks), or None."""
    raw = r.hgetall(f"upload:{upload_id}")
    if not raw:
        return None
    return {**raw, "step": int(raw["step"]), "chunks": int(raw["chunks"])}


def open_upload(run_id: str, tenant: str, step: int, chunks: int) -> dict:
    """A new upload of the run's checkpoint at step, in chunks chunks; returns it."""
    upload_id = f"u-{r.incr('upload:seq')}"
    key = f"upload:{upload_id}"
    r.hset(key, mapping={"upload_id": upload_id, "run_id": run_id, "tenant": tenant, "step": step, "chunks": chunks})
    r.expire(key, UPLOAD_TTL)
    r.zadd(f"run:{run_id}:uploads", {upload_id: step})
    return upload(upload_id)


def latest_upload(run_id: str) -> dict | None:
    """The run's opened upload with the highest step, committed or not."""
    top = r.zrevrange(f"run:{run_id}:uploads", 0, 0)
    return upload(top[0]) if top else None


def encode(payload: bytes) -> str:
    return base64.b64encode(payload).decode()


def decode(data: str) -> bytes | None:
    """The bytes of base64 text, or None when it is not base64."""
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None


def digest(payload: bytes) -> str:
    """SHA-256 of the bytes, hex."""
    return hashlib.sha256(payload).hexdigest()


def stored_count(upload_id: str) -> int:
    """How many chunks of the upload are staged."""
    return r.hlen(f"upload:{upload_id}:chunks")


def chunk(upload_id: str, index: int) -> bytes | None:
    data = r.hget(f"upload:{upload_id}:chunks", str(index))
    return None if data is None else base64.b64decode(data)


def chunk_digest(upload_id: str, index: int) -> str | None:
    return r.hget(f"upload:{upload_id}:digests", str(index))


def put_chunk(upload_id: str, index: int, payload: bytes, chunk_sha: str) -> None:
    """Stage the chunk's bytes and digest at index (a write at an index overwrites it); refreshes the upload's TTL."""
    r.hset(f"upload:{upload_id}:chunks", str(index), encode(payload))
    r.hset(f"upload:{upload_id}:digests", str(index), chunk_sha)
    for key in (f"upload:{upload_id}", f"upload:{upload_id}:chunks", f"upload:{upload_id}:digests"):
        r.expire(key, UPLOAD_TTL)


def manifest(upload_id: str) -> str | None:
    """SHA-256 of the chunk digests in index order, or None while a chunk of the upload is missing."""
    chunks = r.hget(f"upload:{upload_id}", "chunks")
    if chunks is None:
        return None
    digests = r.hmget(f"upload:{upload_id}:digests", [str(i) for i in range(int(chunks))])
    if any(d is None for d in digests):
        return None
    return hashlib.sha256("".join(digests).encode()).hexdigest()


def record(upload_id: str) -> dict | None:
    """The committed checkpoint record (upload_id, run_id, step, chunks, digest), or None."""
    raw = r.hgetall(f"checkpoint:{upload_id}")
    if not raw:
        return None
    return {**raw, "step": int(raw["step"]), "chunks": int(raw["chunks"])}


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take, for the relay."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def mac(message: str) -> str:
    return hmac.new(SIGNING_KEY, message.encode(), hashlib.sha256).hexdigest()


def sign_url(upload_id: str, expires_at: int) -> str:
    """A read URL for the checkpoint's objects that the store serves until expires_at (unix seconds)."""
    return f"{BASE_URL}/{upload_id}?expires={expires_at}&sig={mac(f'{upload_id}|{expires_at}')}"


def verify_url(url: str) -> bool:
    """Whether the object store serves url now."""
    prefix = f"{BASE_URL}/"
    if not url.startswith(prefix) or "?" not in url:
        return False
    upload_id, query = url[len(prefix):].split("?", 1)
    params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
    expires = params.get("expires", "")
    if not expires.isdigit() or time.time() > int(expires):
        return False
    return hmac.compare_digest(params.get("sig", ""), mac(f"{upload_id}|{expires}"))
`,
  'checkpoint/commit.py': `"""
The commit (provided; step 2 builds the same two functions). commit(upload_id) runs COMMIT_LUA,
which, only while every chunk of the upload is staged, persists the upload's keys, writes the
checkpoint record checkpoint:{upload_id} and indexes it in run:{run_id}:checkpoints by step; it
returns the record, or None for an upload that is unknown or incomplete. latest_committed(run_id)
is the record with the highest committed step, or None.
"""
import redis

from checkpoint import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)

COMMIT_LUA = """
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
"""
commit_script = r.register_script(COMMIT_LUA)


def commit(upload_id: str) -> dict | None:
    """Commit a complete upload: its checkpoint record, or None."""
    upload = store.upload(upload_id)
    if upload is None:
        return None
    digest = store.manifest(upload_id)
    if digest is None:
        return None
    keys = [
        f"upload:{upload_id}",
        f"upload:{upload_id}:chunks",
        f"upload:{upload_id}:digests",
        f"checkpoint:{upload_id}",
        f"run:{upload['run_id']}:checkpoints",
    ]
    if commit_script(keys=keys, args=[upload_id, digest]) != 1:
        return None
    return store.record(upload_id)


def latest_committed(run_id: str) -> dict | None:
    """The run's committed checkpoint with the highest step, or None."""
    top = r.zrevrange(f"run:{run_id}:checkpoints", 0, 0)
    return store.record(top[0]) if top else None
`,
};

export const supportModulesTs: Record<string, string> = {
  'checkpoint/store.ts': `/**
 * The upload store (provided). run:{run_id} holds the run's tenant. upload:{id} holds an upload's
 * upload_id, run_id, tenant, step and chunks (the chunk count); run:{run_id}:uploads indexes every
 * opened upload of the run by step, committed or not. upload:{id}:chunks maps a chunk index to the
 * chunk's bytes (base64), upload:{id}:digests to their SHA-256 (hex). Upload state expires
 * UPLOAD_TTL seconds after its last write unless a commit persists it. checkpoint:{id} is the
 * record a commit writes (upload_id, run_id, step, chunks, digest). outbox is a list of JSON rows
 * {topic, key, payload} a relay publishes later. A read URL is
 * {BASE_URL}/{upload_id}?expires={unix s}&sig={mac}.
 */
import {createHash, createHmac} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const UPLOAD_TTL = 86400;
export const BASE_URL = 'https://objects.ckpt.internal';
const SIGNING_KEY = 'ckpt-objects-v1';

export interface Upload {
  upload_id: string;
  run_id: string;
  tenant: string;
  step: number;
  chunks: number;
}

export interface CheckpointRecord {
  upload_id: string;
  run_id: string;
  step: number;
  chunks: number;
  digest: string;
}

export async function createRun(runId: string, tenant: string): Promise<void> {
  await redis.hset(\`run:\${runId}\`, 'tenant', tenant);
}

/** The tenant that owns the run, or null for an unknown run. */
export async function runTenant(runId: string): Promise<string | null> {
  return redis.hget(\`run:\${runId}\`, 'tenant');
}

/** The upload, or null. */
export async function upload(uploadId: string): Promise<Upload | null> {
  const raw = await redis.hgetall(\`upload:\${uploadId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {upload_id: raw.upload_id, run_id: raw.run_id, tenant: raw.tenant, step: Number(raw.step), chunks: Number(raw.chunks)};
}

/** A new upload of the run's checkpoint at step, in chunks chunks; returns it. */
export async function openUpload(runId: string, tenant: string, step: number, chunks: number): Promise<Upload> {
  const uploadId = \`u-\${await redis.incr('upload:seq')}\`;
  const key = \`upload:\${uploadId}\`;
  await redis.hset(key, {upload_id: uploadId, run_id: runId, tenant, step: String(step), chunks: String(chunks)});
  await redis.expire(key, UPLOAD_TTL);
  await redis.zadd(\`run:\${runId}:uploads\`, step, uploadId);
  return (await upload(uploadId)) as Upload;
}

/** The run's opened upload with the highest step, committed or not. */
export async function latestUpload(runId: string): Promise<Upload | null> {
  const top = await redis.zrevrange(\`run:\${runId}:uploads\`, 0, 0);
  return top.length === 0 ? null : upload(top[0]);
}

export const encode = (payload: Buffer): string => payload.toString('base64');

/** The bytes of base64 text, or null when it is not base64. */
export function decode(data: string): Buffer | null {
  if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  return Buffer.from(data, 'base64');
}

/** SHA-256 of the bytes, hex. */
export const digest = (payload: Buffer | string): string => createHash('sha256').update(payload).digest('hex');

/** How many chunks of the upload are staged. */
export async function storedCount(uploadId: string): Promise<number> {
  return redis.hlen(\`upload:\${uploadId}:chunks\`);
}

export async function chunk(uploadId: string, index: number): Promise<Buffer | null> {
  const data = await redis.hget(\`upload:\${uploadId}:chunks\`, String(index));
  return data === null ? null : Buffer.from(data, 'base64');
}

export async function chunkDigest(uploadId: string, index: number): Promise<string | null> {
  return redis.hget(\`upload:\${uploadId}:digests\`, String(index));
}

/** Stage the chunk's bytes and digest at index (a write at an index overwrites it); refreshes the upload's TTL. */
export async function putChunk(uploadId: string, index: number, payload: Buffer, chunkSha: string): Promise<void> {
  await redis.hset(\`upload:\${uploadId}:chunks\`, String(index), encode(payload));
  await redis.hset(\`upload:\${uploadId}:digests\`, String(index), chunkSha);
  for (const key of [\`upload:\${uploadId}\`, \`upload:\${uploadId}:chunks\`, \`upload:\${uploadId}:digests\`]) await redis.expire(key, UPLOAD_TTL);
}

/** SHA-256 of the chunk digests in index order, or null while a chunk of the upload is missing. */
export async function manifest(uploadId: string): Promise<string | null> {
  const chunks = await redis.hget(\`upload:\${uploadId}\`, 'chunks');
  if (chunks === null) return null;
  const fields = Array.from({length: Number(chunks)}, (_, i) => String(i));
  const digests = fields.length === 0 ? [] : await redis.hmget(\`upload:\${uploadId}:digests\`, ...fields);
  if (digests.some(d => d === null)) return null;
  return digest(digests.join(''));
}

/** The committed checkpoint record, or null. */
export async function record(uploadId: string): Promise<CheckpointRecord | null> {
  const raw = await redis.hgetall(\`checkpoint:\${uploadId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {upload_id: raw.upload_id, run_id: raw.run_id, step: Number(raw.step), chunks: Number(raw.chunks), digest: raw.digest};
}

/** Keep an event the broker did not take, for the relay. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

export const mac = (message: string): string => createHmac('sha256', SIGNING_KEY).update(message).digest('hex');

/** A read URL for the checkpoint's objects that the store serves until expiresAt (unix seconds). */
export const signUrl = (uploadId: string, expiresAt: number): string =>
  \`\${BASE_URL}/\${uploadId}?expires=\${expiresAt}&sig=\${mac(\`\${uploadId}|\${expiresAt}\`)}\`;

/** Whether the object store serves url now. */
export function verifyUrl(url: string): boolean {
  const prefix = \`\${BASE_URL}/\`;
  if (!url.startsWith(prefix) || !url.includes('?')) return false;
  const [uploadId, query] = url.slice(prefix.length).split('?', 2);
  const params = new URLSearchParams(query);
  const expires = params.get('expires') ?? '';
  if (!/^\\d+$/.test(expires) || Date.now() / 1000 > Number(expires)) return false;
  return params.get('sig') === mac(\`\${uploadId}|\${expires}\`);
}
`,
  'checkpoint/commit.ts': `/**
 * The commit (provided; step 2 builds the same two functions). commit(uploadId) runs COMMIT_LUA,
 * which, only while every chunk of the upload is staged, persists the upload's keys, writes the
 * checkpoint record checkpoint:{upload_id} and indexes it in run:{run_id}:checkpoints by step; it
 * returns the record, or null for an upload that is unknown or incomplete. latestCommitted(runId)
 * is the record with the highest committed step, or null.
 */
import Redis from 'ioredis';

import {type CheckpointRecord, manifest, record, upload} from 'checkpoint/store';

export const COMMIT_LUA = \`
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
\`;

interface CommitRedis extends Redis {
  commitUpload(k1: string, k2: string, k3: string, k4: string, k5: string, uploadId: string, digest: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CommitRedis;
redis.defineCommand('commitUpload', {numberOfKeys: 5, lua: COMMIT_LUA});

/** Commit a complete upload: its checkpoint record, or null. */
export async function commit(uploadId: string): Promise<CheckpointRecord | null> {
  const current = await upload(uploadId);
  if (current === null) return null;
  const digest = await manifest(uploadId);
  if (digest === null) return null;
  const moved = await redis.commitUpload(
    \`upload:\${uploadId}\`,
    \`upload:\${uploadId}:chunks\`,
    \`upload:\${uploadId}:digests\`,
    \`checkpoint:\${uploadId}\`,
    \`run:\${current.run_id}:checkpoints\`,
    uploadId,
    digest,
  );
  return moved === 1 ? record(uploadId) : null;
}

/** The run's committed checkpoint with the highest step, or null. */
export async function latestCommitted(runId: string): Promise<CheckpointRecord | null> {
  const top = await redis.zrevrange(\`run:\${runId}:checkpoints\`, 0, 0);
  return top.length === 0 ? null : record(top[0]);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'checkpoint/store/store.go': `// Package store is the upload store (provided). run:{run_id} holds the run's tenant. upload:{id}
// holds an upload's upload_id, run_id, tenant, step and chunks (the chunk count);
// run:{run_id}:uploads indexes every opened upload of the run by step, committed or not.
// upload:{id}:chunks maps a chunk index to the chunk's bytes (base64), upload:{id}:digests to their
// SHA-256 (hex). Upload state expires UploadTTL after its last write unless a commit persists it.
// checkpoint:{id} is the record a commit writes (upload_id, run_id, step, chunks, digest). outbox
// is a list of JSON rows {topic, key, payload} a relay publishes later. A read URL is
// {BaseURL}/{upload_id}?expires={unix s}&sig={mac}.
package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// UploadTTL is how long upload state lives after its last write, unless a commit persists it.
const UploadTTL = 24 * time.Hour

// BaseURL is where the object store serves checkpoint reads.
const BaseURL = "https://objects.ckpt.internal"

var signingKey = []byte("ckpt-objects-v1")

// Upload is one checkpoint upload of a run.
type Upload struct {
	UploadID string \`json:"upload_id"\`
	RunID    string \`json:"run_id"\`
	Tenant   string \`json:"tenant"\`
	Step     int64  \`json:"step"\`
	Chunks   int64  \`json:"chunks"\`
}

// Record is a committed checkpoint.
type Record struct {
	UploadID string \`json:"upload_id"\`
	RunID    string \`json:"run_id"\`
	Step     int64  \`json:"step"\`
	Chunks   int64  \`json:"chunks"\`
	Digest   string \`json:"digest"\`
}

// CreateRun records the run's tenant.
func CreateRun(ctx context.Context, runID, tenant string) {
	rdb.HSet(ctx, "run:"+runID, "tenant", tenant)
}

// RunTenant is the tenant that owns the run, or "" for an unknown run.
func RunTenant(ctx context.Context, runID string) string {
	return rdb.HGet(ctx, "run:"+runID, "tenant").Val()
}

// GetUpload is the upload, or nil.
func GetUpload(ctx context.Context, uploadID string) *Upload {
	raw := rdb.HGetAll(ctx, "upload:"+uploadID).Val()
	if len(raw) == 0 {
		return nil
	}
	step, _ := strconv.ParseInt(raw["step"], 10, 64)
	chunks, _ := strconv.ParseInt(raw["chunks"], 10, 64)
	return &Upload{UploadID: raw["upload_id"], RunID: raw["run_id"], Tenant: raw["tenant"], Step: step, Chunks: chunks}
}

// OpenUpload starts a new upload of the run's checkpoint at step, in chunks chunks, and returns it.
func OpenUpload(ctx context.Context, runID, tenant string, step, chunks int64) *Upload {
	uploadID := fmt.Sprintf("u-%d", rdb.Incr(ctx, "upload:seq").Val())
	key := "upload:" + uploadID
	rdb.HSet(ctx, key, map[string]any{"upload_id": uploadID, "run_id": runID, "tenant": tenant, "step": strconv.FormatInt(step, 10), "chunks": strconv.FormatInt(chunks, 10)})
	rdb.Expire(ctx, key, UploadTTL)
	rdb.ZAdd(ctx, "run:"+runID+":uploads", redis.Z{Score: float64(step), Member: uploadID})
	return GetUpload(ctx, uploadID)
}

// LatestUpload is the run's opened upload with the highest step, committed or not.
func LatestUpload(ctx context.Context, runID string) *Upload {
	top := rdb.ZRevRange(ctx, "run:"+runID+":uploads", 0, 0).Val()
	if len(top) == 0 {
		return nil
	}
	return GetUpload(ctx, top[0])
}

// Encode is the base64 text of the bytes.
func Encode(payload []byte) string { return base64.StdEncoding.EncodeToString(payload) }

// Decode is the bytes of base64 text, or an error when it is not base64.
func Decode(data string) ([]byte, error) { return base64.StdEncoding.DecodeString(data) }

// Digest is the SHA-256 of the bytes, hex.
func Digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// StoredCount is how many chunks of the upload are staged.
func StoredCount(ctx context.Context, uploadID string) int64 {
	return rdb.HLen(ctx, "upload:"+uploadID+":chunks").Val()
}

// Chunk is the staged chunk at index, or nil.
func Chunk(ctx context.Context, uploadID string, index int64) []byte {
	data, err := rdb.HGet(ctx, "upload:"+uploadID+":chunks", strconv.FormatInt(index, 10)).Result()
	if err != nil {
		return nil
	}
	payload, _ := Decode(data)
	return payload
}

// ChunkDigest is the digest staged at index, or "".
func ChunkDigest(ctx context.Context, uploadID string, index int64) string {
	return rdb.HGet(ctx, "upload:"+uploadID+":digests", strconv.FormatInt(index, 10)).Val()
}

// PutChunk stages the chunk's bytes and digest at index (a write at an index overwrites it) and
// refreshes the upload's TTL.
func PutChunk(ctx context.Context, uploadID string, index int64, payload []byte, chunkSha string) {
	field := strconv.FormatInt(index, 10)
	rdb.HSet(ctx, "upload:"+uploadID+":chunks", field, Encode(payload))
	rdb.HSet(ctx, "upload:"+uploadID+":digests", field, chunkSha)
	for _, key := range []string{"upload:" + uploadID, "upload:" + uploadID + ":chunks", "upload:" + uploadID + ":digests"} {
		rdb.Expire(ctx, key, UploadTTL)
	}
}

// Manifest is the SHA-256 of the chunk digests in index order, or "" while a chunk is missing.
func Manifest(ctx context.Context, uploadID string) string {
	chunks, err := rdb.HGet(ctx, "upload:"+uploadID, "chunks").Int64()
	if err != nil || chunks <= 0 {
		return ""
	}
	fields := make([]string, chunks)
	for i := range fields {
		fields[i] = strconv.Itoa(i)
	}
	var joined strings.Builder
	for _, d := range rdb.HMGet(ctx, "upload:"+uploadID+":digests", fields...).Val() {
		text, ok := d.(string)
		if !ok {
			return ""
		}
		joined.WriteString(text)
	}
	return Digest([]byte(joined.String()))
}

// GetRecord is the committed checkpoint record, or nil.
func GetRecord(ctx context.Context, uploadID string) *Record {
	raw := rdb.HGetAll(ctx, "checkpoint:"+uploadID).Val()
	if len(raw) == 0 {
		return nil
	}
	step, _ := strconv.ParseInt(raw["step"], 10, 64)
	chunks, _ := strconv.ParseInt(raw["chunks"], 10, 64)
	return &Record{UploadID: raw["upload_id"], RunID: raw["run_id"], Step: step, Chunks: chunks, Digest: raw["digest"]}
}

// InsertOutbox keeps an event the broker did not take, for the relay.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}

// Mac is the store's HMAC-SHA256 (hex) of message.
func Mac(message string) string {
	h := hmac.New(sha256.New, signingKey)
	h.Write([]byte(message))
	return hex.EncodeToString(h.Sum(nil))
}

// SignURL is a read URL for the checkpoint's objects that the store serves until expiresAt (unix seconds).
func SignURL(uploadID string, expiresAt int64) string {
	return fmt.Sprintf("%s/%s?expires=%d&sig=%s", BaseURL, uploadID, expiresAt, Mac(fmt.Sprintf("%s|%d", uploadID, expiresAt)))
}

// VerifyURL says whether the object store serves raw now.
func VerifyURL(raw string) bool {
	prefix := BaseURL + "/"
	if !strings.HasPrefix(raw, prefix) || !strings.Contains(raw, "?") {
		return false
	}
	parts := strings.SplitN(raw[len(prefix):], "?", 2)
	params, err := url.ParseQuery(parts[1])
	if err != nil {
		return false
	}
	expires, err := strconv.ParseInt(params.Get("expires"), 10, 64)
	if err != nil || time.Now().Unix() > expires {
		return false
	}
	return hmac.Equal([]byte(params.Get("sig")), []byte(Mac(fmt.Sprintf("%s|%d", parts[0], expires))))
}
`,
  'checkpoint/commit/commit.go': `// Package commit is the commit (provided; step 2 builds the same two functions). Commit runs
// CommitScript, which, only while every chunk of the upload is staged, persists the upload's keys,
// writes the checkpoint record checkpoint:{upload_id} and indexes it in run:{run_id}:checkpoints
// by step; it returns the record, or nil for an upload that is unknown or incomplete.
// LatestCommitted is the record with the highest committed step, or nil.
package commit

import (
	"context"

	"github.com/redis/go-redis/v9"

	"checkpoint/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// CommitScript writes the record only for a complete chunk set, in one step.
var CommitScript = redis.NewScript(\`
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
\`)

// Commit commits a complete upload: its checkpoint record, or nil.
func Commit(ctx context.Context, uploadID string) (*store.Record, error) {
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return nil, nil
	}
	digest := store.Manifest(ctx, uploadID)
	if digest == "" {
		return nil, nil
	}
	keys := []string{"upload:" + uploadID, "upload:" + uploadID + ":chunks", "upload:" + uploadID + ":digests", "checkpoint:" + uploadID, "run:" + upload.RunID + ":checkpoints"}
	moved, err := CommitScript.Run(ctx, rdb, keys, uploadID, digest).Int64()
	if err != nil || moved != 1 {
		return nil, err
	}
	return store.GetRecord(ctx, uploadID), nil
}

// LatestCommitted is the run's committed checkpoint with the highest step, or nil.
func LatestCommitted(ctx context.Context, runID string) *store.Record {
	top := rdb.ZRevRange(ctx, "run:"+runID+":checkpoints", 0, 0).Val()
	if len(top) == 0 {
		return nil
	}
	return store.GetRecord(ctx, top[0])
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'checkpoint/store.h': `// The upload store (provided). run:{run_id} holds the run's tenant. upload:{id} holds an upload's
// upload_id, run_id, tenant, step and chunks (the chunk count); run:{run_id}:uploads indexes every
// opened upload of the run by step, committed or not. upload:{id}:chunks maps a chunk index to the
// chunk's bytes (base64), upload:{id}:digests to their SHA-256 (hex). Upload state expires
// kUploadTtl seconds after its last write unless a commit persists it. checkpoint:{id} is the
// record a commit writes (upload_id, run_id, step, chunks, digest). outbox is a list of JSON rows
// {topic, key, payload} a relay publishes later. A read URL is
// {kBaseUrl}/{upload_id}?expires={unix s}&sig={mac}. Bytes are std::string.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline constexpr long kUploadTtl = 86400;
inline const std::string kBaseUrl = "https://objects.ckpt.internal";
inline const std::string kSigningKey = "ckpt-objects-v1";

struct Upload {
  std::string upload_id;
  std::string run_id;
  std::string tenant;
  long step = 0;
  long chunks = 0;
};

struct Record {
  std::string upload_id;
  std::string run_id;
  long step = 0;
  long chunks = 0;
  std::string digest;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string hexOf(const unsigned char* bytes, unsigned int length) {
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned int i = 0; i < length; i++) {
    out += hex[bytes[i] >> 4];
    out += hex[bytes[i] & 15];
  }
  return out;
}

inline void createRun(const std::string& run_id, const std::string& tenant) { redis().hset("run:" + run_id, "tenant", tenant); }

// The tenant that owns the run, or "" for an unknown run.
inline std::string runTenant(const std::string& run_id) { return redis().hget("run:" + run_id, "tenant").value_or(""); }

// The upload, or none.
inline std::optional<Upload> upload(const std::string& upload_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("upload:" + upload_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return Upload{raw["upload_id"], raw["run_id"], raw["tenant"], std::stol(raw["step"]), std::stol(raw["chunks"])};
}

// A new upload of the run's checkpoint at step, in chunks chunks; returns it.
inline Upload openUpload(const std::string& run_id, const std::string& tenant, long step, long chunks) {
  const std::string upload_id = "u-" + std::to_string(redis().incr("upload:seq"));
  const std::string key = "upload:" + upload_id;
  redis().hset(key, {std::make_pair(std::string("upload_id"), upload_id), std::make_pair(std::string("run_id"), run_id),
                     std::make_pair(std::string("tenant"), tenant), std::make_pair(std::string("step"), std::to_string(step)),
                     std::make_pair(std::string("chunks"), std::to_string(chunks))});
  redis().expire(key, kUploadTtl);
  redis().zadd("run:" + run_id + ":uploads", upload_id, static_cast<double>(step));
  return *upload(upload_id);
}

// The run's opened upload with the highest step, committed or not.
inline std::optional<Upload> latestUpload(const std::string& run_id) {
  std::vector<std::string> top;
  redis().zrevrange("run:" + run_id + ":uploads", 0, 0, std::back_inserter(top));
  if (top.empty()) return std::nullopt;
  return upload(top[0]);
}

// The base64 text of the bytes.
inline std::string encode(const std::string& payload) {
  std::string out(4 * ((payload.size() + 2) / 3) + 1, '\\0');
  const int n = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(out.data()), reinterpret_cast<const unsigned char*>(payload.data()),
                                static_cast<int>(payload.size()));
  out.resize(n);
  return out;
}

// The bytes of base64 text, or none when it is not base64.
inline std::optional<std::string> decode(const std::string& data) {
  if (data.size() % 4 != 0) return std::nullopt;
  std::string out(data.size() / 4 * 3 + 1, '\\0');
  const int n = EVP_DecodeBlock(reinterpret_cast<unsigned char*>(out.data()), reinterpret_cast<const unsigned char*>(data.data()),
                                static_cast<int>(data.size()));
  if (n < 0) return std::nullopt;
  size_t padding = 0;
  if (!data.empty() && data.back() == '=') padding++;
  if (data.size() > 1 && data[data.size() - 2] == '=') padding++;
  out.resize(static_cast<size_t>(n) - padding);
  return out;
}

// SHA-256 of the bytes, hex.
inline std::string digest(const std::string& payload) {
  unsigned char sum[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), sum);
  return hexOf(sum, SHA256_DIGEST_LENGTH);
}

// How many chunks of the upload are staged.
inline long storedCount(const std::string& upload_id) { return redis().hlen("upload:" + upload_id + ":chunks"); }

// The staged chunk at index, or none.
inline std::optional<std::string> chunk(const std::string& upload_id, long index) {
  const auto data = redis().hget("upload:" + upload_id + ":chunks", std::to_string(index));
  if (!data) return std::nullopt;
  return decode(*data);
}

// The digest staged at index, or "".
inline std::string chunkDigest(const std::string& upload_id, long index) {
  return redis().hget("upload:" + upload_id + ":digests", std::to_string(index)).value_or("");
}

// Stage the chunk's bytes and digest at index (a write at an index overwrites it); refreshes the
// upload's TTL.
inline void putChunk(const std::string& upload_id, long index, const std::string& payload, const std::string& chunk_sha) {
  redis().hset("upload:" + upload_id + ":chunks", std::to_string(index), encode(payload));
  redis().hset("upload:" + upload_id + ":digests", std::to_string(index), chunk_sha);
  for (const std::string& key : {"upload:" + upload_id, "upload:" + upload_id + ":chunks", "upload:" + upload_id + ":digests"}) {
    redis().expire(key, kUploadTtl);
  }
}

// SHA-256 of the chunk digests in index order, or "" while a chunk of the upload is missing.
inline std::string manifest(const std::string& upload_id) {
  const auto chunks = redis().hget("upload:" + upload_id, "chunks");
  if (!chunks || std::stol(*chunks) <= 0) return "";
  std::vector<std::string> fields;
  for (long i = 0; i < std::stol(*chunks); i++) fields.push_back(std::to_string(i));
  std::vector<std::optional<std::string>> digests;
  redis().hmget("upload:" + upload_id + ":digests", fields.begin(), fields.end(), std::back_inserter(digests));
  std::string joined;
  for (const auto& d : digests) {
    if (!d) return "";
    joined += *d;
  }
  return digest(joined);
}

// The committed checkpoint record, or none.
inline std::optional<Record> record(const std::string& upload_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("checkpoint:" + upload_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return Record{raw["upload_id"], raw["run_id"], std::stol(raw["step"]), std::stol(raw["chunks"]), raw["digest"]};
}

// Keep an event the broker did not take, for the relay.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The store's HMAC-SHA256 (hex) of message.
inline std::string mac(const std::string& message) {
  unsigned char sum[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kSigningKey.data(), static_cast<int>(kSigningKey.size()), reinterpret_cast<const unsigned char*>(message.data()),
       message.size(), sum, &length);
  return hexOf(sum, length);
}

// A read URL for the checkpoint's objects that the store serves until expires_at (unix seconds).
inline std::string signUrl(const std::string& upload_id, long long expires_at) {
  const std::string expires = std::to_string(expires_at);
  return kBaseUrl + "/" + upload_id + "?expires=" + expires + "&sig=" + mac(upload_id + "|" + expires);
}

// Whether the object store serves url now.
inline bool verifyUrl(const std::string& url) {
  const std::string prefix = kBaseUrl + "/";
  if (url.rfind(prefix, 0) != 0) return false;
  const size_t q = url.find('?');
  if (q == std::string::npos) return false;
  const std::string upload_id = url.substr(prefix.size(), q - prefix.size());
  std::map<std::string, std::string> params;
  size_t start = q + 1;
  while (start <= url.size()) {
    size_t amp = url.find('&', start);
    if (amp == std::string::npos) amp = url.size();
    const std::string part = url.substr(start, amp - start);
    const size_t eq = part.find('=');
    if (eq != std::string::npos && eq > 0) params[part.substr(0, eq)] = part.substr(eq + 1);
    start = amp + 1;
  }
  const std::string expires = params["expires"];
  if (expires.empty() || expires.find_first_not_of("0123456789") != std::string::npos) return false;
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  if (now > std::stoll(expires)) return false;
  return params["sig"] == mac(upload_id + "|" + expires);
}

}  // namespace store
`,
  'checkpoint/commit.h': `// The commit (provided; step 2 builds the same two functions). commit runs kCommitLua, which, only
// while every chunk of the upload is staged, persists the upload's keys, writes the checkpoint
// record checkpoint:{upload_id} and indexes it in run:{run_id}:checkpoints by step; it returns the
// record, or none for an upload that is unknown or incomplete. latestCommitted is the record with
// the highest committed step, or none.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

#include "checkpoint/store.h"

namespace commit {

inline const std::string kCommitLua = R"lua(
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
)lua";

// Commit a complete upload: its checkpoint record, or none.
inline std::optional<store::Record> commit(const std::string& upload_id) {
  const auto upload = store::upload(upload_id);
  if (!upload) return std::nullopt;
  const std::string digest = store::manifest(upload_id);
  if (digest.empty()) return std::nullopt;
  const std::vector<std::string> keys = {"upload:" + upload_id, "upload:" + upload_id + ":chunks", "upload:" + upload_id + ":digests",
                                         "checkpoint:" + upload_id, "run:" + upload->run_id + ":checkpoints"};
  const std::vector<std::string> args = {upload_id, digest};
  if (store::redis().eval<long long>(kCommitLua, keys.begin(), keys.end(), args.begin(), args.end()) != 1) return std::nullopt;
  return store::record(upload_id);
}

// The run's committed checkpoint with the highest step, or none.
inline std::optional<store::Record> latestCommitted(const std::string& run_id) {
  std::vector<std::string> top;
  store::redis().zrevrange("run:" + run_id + ":checkpoints", 0, 0, std::back_inserter(top));
  if (top.empty()) return std::nullopt;
  return store::record(top[0]);
}

}  // namespace commit
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('checkpoint', 'Store')]: `package checkpoint

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._
import scala.util.Try

/**
 * The upload store (provided). run:{run_id} holds the run's tenant. upload:{id} holds an upload's
 * upload_id, run_id, tenant, step and chunks (the chunk count); run:{run_id}:uploads indexes every
 * opened upload of the run by step, committed or not. upload:{id}:chunks maps a chunk index to the
 * chunk's bytes (base64), upload:{id}:digests to their SHA-256 (hex). Upload state expires
 * UploadTtl seconds after its last write unless a commit persists it. checkpoint:{id} is the record
 * a commit writes (upload_id, run_id, step, chunks, digest). outbox is a list of JSON rows {topic,
 * key, payload} a relay publishes later. A read URL is {BaseUrl}/{upload_id}?expires={unix s}&sig={mac}.
 */
object Store {
  final case class Upload(uploadId: String, runId: String, tenant: String, step: Long, chunks: Long)
  final case class Record(uploadId: String, runId: String, step: Long, chunks: Long, digest: String)

  val UploadTtl = 86400L
  val BaseUrl = "https://objects.ckpt.internal"
  private val SigningKey = "ckpt-objects-v1"

  val jedis = new JedisPooled("redis", 6379)

  def createRun(runId: String, tenant: String): Unit = jedis.hset(s"run:$runId", "tenant", tenant)

  /** The tenant that owns the run, if the run exists. */
  def runTenant(runId: String): Option[String] = Option(jedis.hget(s"run:$runId", "tenant"))

  /** The upload, if it exists. */
  def upload(uploadId: String): Option[Upload] = {
    val raw = jedis.hgetAll(s"upload:$uploadId").asScala
    if (raw.isEmpty) None else Some(Upload(raw("upload_id"), raw("run_id"), raw("tenant"), raw("step").toLong, raw("chunks").toLong))
  }

  /** A new upload of the run's checkpoint at step, in chunks chunks; returns it. */
  def openUpload(runId: String, tenant: String, step: Long, chunks: Long): Upload = {
    val uploadId = s"u-\${jedis.incr("upload:seq")}"
    val key = s"upload:$uploadId"
    jedis.hset(key, Map("upload_id" -> uploadId, "run_id" -> runId, "tenant" -> tenant, "step" -> step.toString, "chunks" -> chunks.toString).asJava)
    jedis.expire(key, UploadTtl)
    jedis.zadd(s"run:$runId:uploads", step.toDouble, uploadId)
    upload(uploadId).get
  }

  /** The run's opened upload with the highest step, committed or not. */
  def latestUpload(runId: String): Option[Upload] = jedis.zrevrange(s"run:$runId:uploads", 0, 0).asScala.headOption.flatMap(upload)

  def encode(payload: Array[Byte]): String = Base64.getEncoder.encodeToString(payload)

  /** The bytes of base64 text, if it is base64. */
  def decode(data: String): Option[Array[Byte]] = Try(Base64.getDecoder.decode(data)).toOption

  /** SHA-256 of the bytes, hex. */
  def digest(payload: Array[Byte]): String = MessageDigest.getInstance("SHA-256").digest(payload).map("%02x".format(_)).mkString

  /** How many chunks of the upload are staged. */
  def storedCount(uploadId: String): Long = jedis.hlen(s"upload:$uploadId:chunks")

  def chunk(uploadId: String, index: Long): Option[Array[Byte]] =
    Option(jedis.hget(s"upload:$uploadId:chunks", index.toString)).map(Base64.getDecoder.decode(_))

  def chunkDigest(uploadId: String, index: Long): Option[String] = Option(jedis.hget(s"upload:$uploadId:digests", index.toString))

  /** Stage the chunk's bytes and digest at index (a write at an index overwrites it); refreshes the upload's TTL. */
  def putChunk(uploadId: String, index: Long, payload: Array[Byte], chunkSha: String): Unit = {
    jedis.hset(s"upload:$uploadId:chunks", index.toString, encode(payload))
    jedis.hset(s"upload:$uploadId:digests", index.toString, chunkSha)
    Seq(s"upload:$uploadId", s"upload:$uploadId:chunks", s"upload:$uploadId:digests").foreach(jedis.expire(_, UploadTtl))
  }

  /** SHA-256 of the chunk digests in index order, or None while a chunk of the upload is missing. */
  def manifest(uploadId: String): Option[String] =
    Option(jedis.hget(s"upload:$uploadId", "chunks")).map(_.toInt).filter(_ > 0).flatMap { chunks =>
      val digests = jedis.hmget(s"upload:$uploadId:digests", (0 until chunks).map(_.toString): _*).asScala
      if (digests.contains(null)) None else Some(digest(digests.mkString.getBytes(UTF_8)))
    }

  /** The committed checkpoint record, if any. */
  def record(uploadId: String): Option[Record] = {
    val raw = jedis.hgetAll(s"checkpoint:$uploadId").asScala
    if (raw.isEmpty) None else Some(Record(raw("upload_id"), raw("run_id"), raw("step").toLong, raw("chunks").toLong, raw("digest")))
  }

  /** Keep an event the broker did not take, for the relay. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  def mac(message: String): String = {
    val hmac = Mac.getInstance("HmacSHA256")
    hmac.init(new SecretKeySpec(SigningKey.getBytes(UTF_8), "HmacSHA256"))
    hmac.doFinal(message.getBytes(UTF_8)).map("%02x".format(_)).mkString
  }

  /** A read URL for the checkpoint's objects that the store serves until expiresAt (unix seconds). */
  def signUrl(uploadId: String, expiresAt: Long): String = s"$BaseUrl/$uploadId?expires=$expiresAt&sig=\${mac(s"$uploadId|$expiresAt")}"
}
`,
  [scalaPath('checkpoint', 'Commit')]: `package checkpoint

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The commit (provided; step 2 builds the same two functions). commit runs CommitLua, which, only
 * while every chunk of the upload is staged, persists the upload's keys, writes the checkpoint
 * record checkpoint:{upload_id} and indexes it in run:{run_id}:checkpoints by step; it returns the
 * record, or None for an upload that is unknown or incomplete. latestCommitted is the record with
 * the highest committed step, or None.
 */
object Commit {
  val jedis = new JedisPooled("redis", 6379)

  val CommitLua: String =
    """local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
      |if not meta[1] then return 0 end
      |local chunks = tonumber(meta[3])
      |if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
      |redis.call('PERSIST', KEYS[1])
      |redis.call('PERSIST', KEYS[2])
      |redis.call('PERSIST', KEYS[3])
      |redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
      |redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
      |return 1
      |""".stripMargin

  /** Commit a complete upload: its checkpoint record, or None. */
  def commit(uploadId: String): Option[Store.Record] =
    for {
      upload <- Store.upload(uploadId)
      digest <- Store.manifest(uploadId)
      keys = List(s"upload:$uploadId", s"upload:$uploadId:chunks", s"upload:$uploadId:digests", s"checkpoint:$uploadId", s"run:\${upload.runId}:checkpoints")
      if jedis.eval(CommitLua, keys.asJava, List(uploadId, digest).asJava).asInstanceOf[java.lang.Long] == 1L
      record <- Store.record(uploadId)
    } yield record

  /** The run's committed checkpoint with the highest step, or None. */
  def latestCommitted(runId: String): Option[Store.Record] =
    jedis.zrevrange(s"run:$runId:checkpoints", 0, 0).asScala.headOption.flatMap(Store.record)
}
`,
};
