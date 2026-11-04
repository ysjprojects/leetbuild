/**
 * Hand-written support modules the file-storage steps import but no step builds: the `files`
 * package. `files.store` is the file index and the staging area (parts staged under
 * part:{upload_id}:{n}, committed files as file:{file_id} hashes), the mime sniffer and the CDN's URL
 * signer. `files.sessions` is step 2's upload-session and quota layer as later steps use it:
 * `open_session`, `ack_part`, `find_session`, `sweep`. The five languages keep the same keys, so a
 * harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'files/__init__.py': '',
  'files/store.py': `"""
The file index and the staging area (provided). A part the API accepted is staged under
part:{upload_id}:{n} (bytes, 24 h) until the object store has it. A committed file is the hash
file:{file_id} with file_id, upload_id, tenant, name, mime, size, digest, object_key and state
(committed or deleted); its id is the upload's number, f-7 for up-7. commit_file settles the
upload: usage moves from the declared size to the actual one, the reservation leaves
quota:reservations:{tenant}, the session and its staged parts are dropped. A download URL is signed
with HMAC-SHA256 over the file id, the tenant and the expiry; verify_url is what the CDN runs.
"""
import hashlib
import hmac
from urllib.parse import parse_qs, urlparse

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
raw = redis.Redis(host="redis", port=6379)  # staged parts stay bytes

MAX_UPLOAD_BYTES = 5 << 30
ALLOWED_MIME = ("image/png", "image/jpeg", "application/pdf")
STAGE_TTL_S = 86400
CDN = "https://cdn.stored.example"
SIGNING_KEY = b"stored-cdn-signing-key"
SIGNATURES = ((b"\\x89PNG\\r\\n\\x1a\\n", "image/png"), (b"\\xff\\xd8\\xff", "image/jpeg"), (b"%PDF-", "application/pdf"))


def sniff_mime(head: bytes) -> str:
    """The type the leading bytes say the file is; application/octet-stream when no signature matches."""
    for magic, mime in SIGNATURES:
        if head.startswith(magic):
            return mime
    return "application/octet-stream"


def stage_part(upload_id: str, n: int, data: bytes) -> None:
    """Keep part n's bytes until the object store has them."""
    raw.set(f"part:{upload_id}:{n}", data, ex=STAGE_TTL_S)


def staged_parts(upload_id: str) -> list[tuple[int, bytes]]:
    """The upload's acknowledged parts in order, as (part number, bytes)."""
    numbers = sorted(int(field[5:]) for field in r.hkeys(f"session:{upload_id}") if field.startswith("part:"))
    return [(n, raw.get(f"part:{upload_id}:{n}") or b"") for n in numbers]


def file_id_for(upload_id: str) -> str:
    return "f-" + upload_id.removeprefix("up-")


def commit_file(upload_id: str, object_key: str, digest: str) -> dict:
    """Index the committed object as file:{file_id} and settle the upload; returns the record."""
    session = r.hgetall(f"session:{upload_id}")
    if not session:
        raise KeyError(f"no upload session {upload_id}")
    tenant = session["tenant"]
    size = int(session["actual_bytes"])
    record = {
        "file_id": file_id_for(upload_id),
        "upload_id": upload_id,
        "tenant": tenant,
        "name": session.get("name", ""),
        "mime": session["mime"],
        "size": size,
        "digest": digest,
        "object_key": object_key,
        "state": "committed",
    }
    r.hset(f"file:{record['file_id']}", mapping={k: str(v) for k, v in record.items()})
    r.incrby(f"quota:used:{tenant}", size - int(session["declared_size"]))
    r.zrem(f"quota:reservations:{tenant}", upload_id)
    parts = [f"part:{upload_id}:{field[5:]}" for field in session if field.startswith("part:")]
    r.delete(f"session:{upload_id}", *parts)
    return record


def find_file(file_id: str) -> dict | None:
    """The file's record, whatever its state, or None."""
    record = r.hgetall(f"file:{file_id}")
    if not record:
        return None
    return {**record, "size": int(record["size"])}


def delete_file(file_id: str) -> dict | None:
    """Mark a committed file deleted and give its bytes back to the tenant's quota; None when there is none."""
    record = find_file(file_id)
    if record is None or record["state"] != "committed":
        return None
    r.hset(f"file:{file_id}", "state", "deleted")
    r.decrby(f"quota:used:{record['tenant']}", record["size"])
    return {**record, "state": "deleted"}


def _signature(file_id: str, tenant: str, expires_at: int) -> str:
    return hmac.new(SIGNING_KEY, f"{file_id}\\n{tenant}\\n{expires_at}".encode(), hashlib.sha256).hexdigest()


def sign_url(file_id: str, tenant: str, expires_at: int) -> str:
    """A CDN URL for the file that the CDN honours until expires_at (epoch seconds), for this tenant only."""
    return f"{CDN}/f/{file_id}?tenant={tenant}&expires={expires_at}&sig={_signature(file_id, tenant, expires_at)}"


def verify_url(url: str, now: int) -> dict | None:
    """The CDN's check: the grant (file_id, tenant, expires_at) when the signature matches and now is not past the expiry, else None."""
    parsed = urlparse(url)
    query = {name: values[0] for name, values in parse_qs(parsed.query).items()}
    if not url.startswith(CDN + "/f/") or not {"tenant", "expires", "sig"} <= query.keys() or not query["expires"].isdigit():
        return None
    file_id, tenant, expires_at = parsed.path[3:], query["tenant"], int(query["expires"])
    if expires_at < now or not hmac.compare_digest(query["sig"], _signature(file_id, tenant, expires_at)):
        return None
    return {"file_id": file_id, "tenant": tenant, "expires_at": expires_at}
`,
  'files/sessions.py': `"""
Upload sessions and quota (provided; step 2 builds the same functions). quota:used:{tenant} counts
the bytes a tenant has reserved or stored against quota:limit:{tenant} (DEFAULT_QUOTA_BYTES when
unset); quota:reservations:{tenant} scores each open upload by its declared size. session:{upload_id}
is a hash (tenant, declared_size, mime, name, actual_bytes and part:{n} = size per acknowledged part)
that expires SESSION_TTL_S after it opens. open_session reserves and opens in one script; ack_part
counts a part once; sweep releases the reservation of an upload whose session expired.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SESSION_TTL_S = 86400
DEFAULT_QUOTA_BYTES = 1 << 30

OPEN_LUA = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
if used + tonumber(ARGV[1]) > limit then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
redis.call('EXPIRE', KEYS[4], ARGV[6])
return 1
"""
ACK_LUA = """
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
"""
open_script = r.register_script(OPEN_LUA)
ack_script = r.register_script(ACK_LUA)


def open_session(tenant: str, declared_size: int, mime: str, name: str) -> str | None:
    """Reserve declared_size against the tenant's quota and open the session; its upload id, or None over quota."""
    upload_id = f"up-{r.incr('upload:seq')}"
    keys = [f"quota:used:{tenant}", f"quota:limit:{tenant}", f"quota:reservations:{tenant}", f"session:{upload_id}"]
    opened = open_script(keys=keys, args=[declared_size, upload_id, tenant, mime, name, SESSION_TTL_S, DEFAULT_QUOTA_BYTES])
    return upload_id if opened == 1 else None


def ack_part(upload_id: str, n: int, size: int) -> int:
    """Count part n once; the upload's actual bytes after it, or -1 when the session is gone."""
    return int(ack_script(keys=[f"session:{upload_id}"], args=[n, size]))


def find_session(upload_id: str) -> dict | None:
    """The session (upload_id, tenant, declared_size, actual_bytes, mime, name, parts {n: size}), or None."""
    raw = r.hgetall(f"session:{upload_id}")
    if not raw:
        return None
    return {
        "upload_id": upload_id,
        "tenant": raw["tenant"],
        "declared_size": int(raw["declared_size"]),
        "actual_bytes": int(raw["actual_bytes"]),
        "mime": raw["mime"],
        "name": raw.get("name", ""),
        "parts": {int(field[5:]): int(value) for field, value in raw.items() if field.startswith("part:")},
    }


def sweep(tenant: str) -> int:
    """Release the reservations whose session expired without a commit; the bytes released."""
    released = 0
    for upload_id, declared in r.zrange(f"quota:reservations:{tenant}", 0, -1, withscores=True):
        if r.exists(f"session:{upload_id}"):
            continue
        if r.zrem(f"quota:reservations:{tenant}", upload_id) == 1:  # only the sweeper that removed it releases it
            r.decrby(f"quota:used:{tenant}", int(declared))
            released += int(declared)
    return released
`,
};

export const supportModulesTs: Record<string, string> = {
  'files/store.ts': `/**
 * The file index and the staging area (provided). A part the API accepted is staged under
 * part:{upload_id}:{n} (bytes, 24 h) until the object store has it. A committed file is the hash
 * file:{file_id} with file_id, upload_id, tenant, name, mime, size, digest, object_key and state
 * (committed or deleted); its id is the upload's number, f-7 for up-7. commitFile settles the
 * upload: usage moves from the declared size to the actual one, the reservation leaves
 * quota:reservations:{tenant}, the session and its staged parts are dropped. A download URL is
 * signed with HMAC-SHA256 over the file id, the tenant and the expiry; verifyUrl is what the CDN runs.
 */
import {createHmac} from 'node:crypto';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'application/pdf'];
export const STAGE_TTL_S = 86400;
export const CDN = 'https://cdn.stored.example';
const SIGNING_KEY = 'stored-cdn-signing-key';
const SIGNATURES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x25, 0x50, 0x44, 0x46, 0x2d], 'application/pdf'],
];

export interface FileRecord {
  file_id: string;
  upload_id: string;
  tenant: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
  object_key: string;
  state: string;
}

export interface Grant {
  file_id: string;
  tenant: string;
  expires_at: number;
}

/** The type the leading bytes say the file is; application/octet-stream when no signature matches. */
export function sniffMime(head: Uint8Array): string {
  for (const [magic, mime] of SIGNATURES) {
    if (magic.every((b, i) => head[i] === b)) return mime;
  }
  return 'application/octet-stream';
}

/** Keep part n's bytes until the object store has them. */
export async function stagePart(uploadId: string, n: number, data: Uint8Array): Promise<void> {
  await redis.set(\`part:\${uploadId}:\${n}\`, Buffer.from(data), 'EX', STAGE_TTL_S);
}

/** The upload's acknowledged parts in order, as [part number, bytes]. */
export async function stagedParts(uploadId: string): Promise<[number, Buffer][]> {
  const fields = await redis.hkeys(\`session:\${uploadId}\`);
  const numbers = fields.filter(f => f.startsWith('part:')).map(f => Number(f.slice(5))).sort((a, b) => a - b);
  const parts: [number, Buffer][] = [];
  for (const n of numbers) parts.push([n, (await redis.getBuffer(\`part:\${uploadId}:\${n}\`)) ?? Buffer.alloc(0)]);
  return parts;
}

export const fileIdFor = (uploadId: string): string => \`f-\${uploadId.replace(/^up-/, '')}\`;

/** Index the committed object as file:{file_id} and settle the upload; returns the record. */
export async function commitFile(uploadId: string, objectKey: string, digest: string): Promise<FileRecord> {
  const session = await redis.hgetall(\`session:\${uploadId}\`);
  if (Object.keys(session).length === 0) throw new Error(\`no upload session \${uploadId}\`);
  const tenant = session.tenant;
  const size = Number(session.actual_bytes);
  const record: FileRecord = {
    file_id: fileIdFor(uploadId),
    upload_id: uploadId,
    tenant,
    name: session.name ?? '',
    mime: session.mime,
    size,
    digest,
    object_key: objectKey,
    state: 'committed',
  };
  await redis.hset(\`file:\${record.file_id}\`, Object.fromEntries(Object.entries(record).map(([k, v]) => [k, String(v)])));
  await redis.incrby(\`quota:used:\${tenant}\`, size - Number(session.declared_size));
  await redis.zrem(\`quota:reservations:\${tenant}\`, uploadId);
  const parts = Object.keys(session)
    .filter(f => f.startsWith('part:'))
    .map(f => \`part:\${uploadId}:\${f.slice(5)}\`);
  await redis.del(\`session:\${uploadId}\`, ...parts);
  return record;
}

/** The file's record, whatever its state, or null. */
export async function findFile(fileId: string): Promise<FileRecord | null> {
  const record = await redis.hgetall(\`file:\${fileId}\`);
  if (Object.keys(record).length === 0) return null;
  return {...(record as unknown as FileRecord), size: Number(record.size)};
}

/** Mark a committed file deleted and give its bytes back to the tenant's quota; null when there is none. */
export async function deleteFile(fileId: string): Promise<FileRecord | null> {
  const record = await findFile(fileId);
  if (record === null || record.state !== 'committed') return null;
  await redis.hset(\`file:\${fileId}\`, 'state', 'deleted');
  await redis.decrby(\`quota:used:\${record.tenant}\`, record.size);
  return {...record, state: 'deleted'};
}

const signature = (fileId: string, tenant: string, expiresAt: number): string =>
  createHmac('sha256', SIGNING_KEY).update(\`\${fileId}\\n\${tenant}\\n\${expiresAt}\`).digest('hex') as string;

/** A CDN URL for the file that the CDN honours until expiresAt (epoch seconds), for this tenant only. */
export const signUrl = (fileId: string, tenant: string, expiresAt: number): string =>
  \`\${CDN}/f/\${fileId}?tenant=\${tenant}&expires=\${expiresAt}&sig=\${signature(fileId, tenant, expiresAt)}\`;

/** The CDN's check: the grant when the signature matches and now is not past the expiry, else null. */
export function verifyUrl(url: string, now: number): Grant | null {
  if (!url.startsWith(\`\${CDN}/f/\`)) return null;
  const [path, query = ''] = url.slice(CDN.length + 3).split('?');
  const params = Object.fromEntries(query.split('&').map(pair => pair.split('=') as [string, string]));
  if (!params.tenant || !/^\\d+$/.test(params.expires ?? '') || !params.sig) return null;
  const expiresAt = Number(params.expires);
  if (expiresAt < now || params.sig !== signature(path, params.tenant, expiresAt)) return null;
  return {file_id: path, tenant: params.tenant, expires_at: expiresAt};
}
`,
  'files/sessions.ts': `/**
 * Upload sessions and quota (provided; step 2 builds the same functions). quota:used:{tenant} counts
 * the bytes a tenant has reserved or stored against quota:limit:{tenant} (DEFAULT_QUOTA_BYTES when
 * unset); quota:reservations:{tenant} scores each open upload by its declared size.
 * session:{upload_id} is a hash (tenant, declared_size, mime, name, actual_bytes and part:{n} = size
 * per acknowledged part) that expires SESSION_TTL_S after it opens. openSession reserves and opens in
 * one script; ackPart counts a part once; sweep releases the reservation of an upload whose session
 * expired.
 */
import Redis from 'ioredis';

export const SESSION_TTL_S = 86400;
export const DEFAULT_QUOTA_BYTES = 1024 ** 3;

export const OPEN_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
if used + tonumber(ARGV[1]) > limit then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
redis.call('EXPIRE', KEYS[4], ARGV[6])
return 1
\`;
export const ACK_LUA = \`
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
\`;

interface SessionRedis extends Redis {
  openUpload(used: string, limit: string, reservations: string, session: string, ...args: (string | number)[]): Promise<number>;
  ackUploadPart(session: string, n: number, size: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SessionRedis;
redis.defineCommand('openUpload', {numberOfKeys: 4, lua: OPEN_LUA});
redis.defineCommand('ackUploadPart', {numberOfKeys: 1, lua: ACK_LUA});

export interface Session {
  upload_id: string;
  tenant: string;
  declared_size: number;
  actual_bytes: number;
  mime: string;
  name: string;
  parts: Record<number, number>;
}

/** Reserve declaredSize against the tenant's quota and open the session; its upload id, or null over quota. */
export async function openSession(tenant: string, declaredSize: number, mime: string, name: string): Promise<string | null> {
  const uploadId = \`up-\${await redis.incr('upload:seq')}\`;
  const opened = await redis.openUpload(
    \`quota:used:\${tenant}\`,
    \`quota:limit:\${tenant}\`,
    \`quota:reservations:\${tenant}\`,
    \`session:\${uploadId}\`,
    declaredSize,
    uploadId,
    tenant,
    mime,
    name,
    SESSION_TTL_S,
    DEFAULT_QUOTA_BYTES,
  );
  return opened === 1 ? uploadId : null;
}

/** Count part n once; the upload's actual bytes after it, or -1 when the session is gone. */
export async function ackPart(uploadId: string, n: number, size: number): Promise<number> {
  return Number(await redis.ackUploadPart(\`session:\${uploadId}\`, n, size));
}

/** The session, or null. */
export async function findSession(uploadId: string): Promise<Session | null> {
  const raw = await redis.hgetall(\`session:\${uploadId}\`);
  if (Object.keys(raw).length === 0) return null;
  const parts: Record<number, number> = {};
  for (const [field, value] of Object.entries(raw)) if (field.startsWith('part:')) parts[Number(field.slice(5))] = Number(value);
  return {
    upload_id: uploadId,
    tenant: raw.tenant,
    declared_size: Number(raw.declared_size),
    actual_bytes: Number(raw.actual_bytes),
    mime: raw.mime,
    name: raw.name ?? '',
    parts,
  };
}

/** Release the reservations whose session expired without a commit; the bytes released. */
export async function sweep(tenant: string): Promise<number> {
  const entries = await redis.zrange(\`quota:reservations:\${tenant}\`, 0, -1, 'WITHSCORES');
  let released = 0;
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [uploadId, declared] = [entries[i], Number(entries[i + 1])];
    if (await redis.exists(\`session:\${uploadId}\`)) continue;
    // Only the sweeper that removed the reservation releases it.
    if ((await redis.zrem(\`quota:reservations:\${tenant}\`, uploadId)) === 1) {
      await redis.decrby(\`quota:used:\${tenant}\`, declared);
      released += declared;
    }
  }
  return released;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'files/store/store.go': `// Package store is the file index and the staging area (provided). A part the API accepted is
// staged under part:{upload_id}:{n} (bytes, 24 h) until the object store has it. A committed file
// is the hash file:{file_id} with file_id, upload_id, tenant, name, mime, size, digest, object_key
// and state (committed or deleted); its id is the upload's number, f-7 for up-7. CommitFile settles
// the upload: usage moves from the declared size to the actual one, the reservation leaves
// quota:reservations:{tenant}, the session and its staged parts are dropped. A download URL is
// signed with HMAC-SHA256 over the file id, the tenant and the expiry; VerifyURL is what the CDN runs.
package store

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	MaxUploadBytes int64 = 5 << 30
	StageTTL             = 24 * time.Hour
	CDN                  = "https://cdn.stored.example"
	signingKey           = "stored-cdn-signing-key"
)

var AllowedMime = []string{"image/png", "image/jpeg", "application/pdf"}

var signatures = []struct {
	magic []byte
	mime  string
}{
	{[]byte("\\x89PNG\\r\\n\\x1a\\n"), "image/png"},
	{[]byte("\\xff\\xd8\\xff"), "image/jpeg"},
	{[]byte("%PDF-"), "application/pdf"},
}

// File is a committed (or deleted) file's record.
type File struct {
	FileID    string \`json:"file_id"\`
	UploadID  string \`json:"upload_id"\`
	Tenant    string \`json:"tenant"\`
	Name      string \`json:"name"\`
	Mime      string \`json:"mime"\`
	Size      int64  \`json:"size"\`
	Digest    string \`json:"digest"\`
	ObjectKey string \`json:"object_key"\`
	State     string \`json:"state"\`
}

// Part is one staged part of an upload.
type Part struct {
	N    int
	Data []byte
}

// Grant is what a valid signed URL gives access to.
type Grant struct {
	FileID    string
	Tenant    string
	ExpiresAt int64
}

// SniffMime is the type the leading bytes say the file is; application/octet-stream when no signature matches.
func SniffMime(head []byte) string {
	for _, s := range signatures {
		if bytes.HasPrefix(head, s.magic) {
			return s.mime
		}
	}
	return "application/octet-stream"
}

// StagePart keeps part n's bytes until the object store has them.
func StagePart(ctx context.Context, uploadID string, n int, data []byte) error {
	return rdb.Set(ctx, fmt.Sprintf("part:%s:%d", uploadID, n), data, StageTTL).Err()
}

// StagedParts is the upload's acknowledged parts in order.
func StagedParts(ctx context.Context, uploadID string) ([]Part, error) {
	fields, err := rdb.HKeys(ctx, "session:"+uploadID).Result()
	if err != nil {
		return nil, err
	}
	var numbers []int
	for _, f := range fields {
		if strings.HasPrefix(f, "part:") {
			n, _ := strconv.Atoi(f[5:])
			numbers = append(numbers, n)
		}
	}
	sort.Ints(numbers)
	parts := make([]Part, 0, len(numbers))
	for _, n := range numbers {
		data, _ := rdb.Get(ctx, fmt.Sprintf("part:%s:%d", uploadID, n)).Bytes()
		parts = append(parts, Part{N: n, Data: data})
	}
	return parts, nil
}

// FileIDFor is the id the upload's file gets: f-7 for up-7.
func FileIDFor(uploadID string) string {
	return "f-" + strings.TrimPrefix(uploadID, "up-")
}

// CommitFile indexes the committed object as file:{file_id} and settles the upload; it returns the record.
func CommitFile(ctx context.Context, uploadID, objectKey, digest string) (*File, error) {
	session, err := rdb.HGetAll(ctx, "session:"+uploadID).Result()
	if err != nil {
		return nil, err
	}
	if len(session) == 0 {
		return nil, fmt.Errorf("no upload session %s", uploadID)
	}
	size, _ := strconv.ParseInt(session["actual_bytes"], 10, 64)
	declared, _ := strconv.ParseInt(session["declared_size"], 10, 64)
	f := &File{FileID: FileIDFor(uploadID), UploadID: uploadID, Tenant: session["tenant"], Name: session["name"], Mime: session["mime"], Size: size, Digest: digest, ObjectKey: objectKey, State: "committed"}
	rdb.HSet(ctx, "file:"+f.FileID, map[string]any{
		"file_id": f.FileID, "upload_id": uploadID, "tenant": f.Tenant, "name": f.Name, "mime": f.Mime,
		"size": strconv.FormatInt(size, 10), "digest": digest, "object_key": objectKey, "state": f.State,
	})
	rdb.IncrBy(ctx, "quota:used:"+f.Tenant, size-declared)
	rdb.ZRem(ctx, "quota:reservations:"+f.Tenant, uploadID)
	keys := []string{"session:" + uploadID}
	for field := range session {
		if strings.HasPrefix(field, "part:") {
			keys = append(keys, "part:"+uploadID+":"+field[5:])
		}
	}
	rdb.Del(ctx, keys...)
	return f, nil
}

// FindFile is the file's record, whatever its state, or nil.
func FindFile(ctx context.Context, fileID string) *File {
	raw := rdb.HGetAll(ctx, "file:"+fileID).Val()
	if len(raw) == 0 {
		return nil
	}
	size, _ := strconv.ParseInt(raw["size"], 10, 64)
	return &File{FileID: raw["file_id"], UploadID: raw["upload_id"], Tenant: raw["tenant"], Name: raw["name"], Mime: raw["mime"], Size: size, Digest: raw["digest"], ObjectKey: raw["object_key"], State: raw["state"]}
}

// DeleteFile marks a committed file deleted and gives its bytes back to the tenant's quota; nil when there is none.
func DeleteFile(ctx context.Context, fileID string) *File {
	f := FindFile(ctx, fileID)
	if f == nil || f.State != "committed" {
		return nil
	}
	rdb.HSet(ctx, "file:"+fileID, "state", "deleted")
	rdb.DecrBy(ctx, "quota:used:"+f.Tenant, f.Size)
	f.State = "deleted"
	return f
}

func signature(fileID, tenant string, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(signingKey))
	mac.Write([]byte(fmt.Sprintf("%s\\n%s\\n%d", fileID, tenant, expiresAt)))
	return hex.EncodeToString(mac.Sum(nil))
}

// SignURL is a CDN URL for the file that the CDN honours until expiresAt (epoch seconds), for this tenant only.
func SignURL(fileID, tenant string, expiresAt int64) string {
	return fmt.Sprintf("%s/f/%s?tenant=%s&expires=%d&sig=%s", CDN, fileID, tenant, expiresAt, signature(fileID, tenant, expiresAt))
}

// VerifyURL is the CDN's check: the grant when the signature matches and now is not past the expiry, else nil.
func VerifyURL(raw string, now int64) *Grant {
	if !strings.HasPrefix(raw, CDN+"/f/") {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	q := u.Query()
	expiresAt, err := strconv.ParseInt(q.Get("expires"), 10, 64)
	fileID, tenant := strings.TrimPrefix(u.Path, "/f/"), q.Get("tenant")
	if err != nil || tenant == "" || expiresAt < now || !hmac.Equal([]byte(q.Get("sig")), []byte(signature(fileID, tenant, expiresAt))) {
		return nil
	}
	return &Grant{FileID: fileID, Tenant: tenant, ExpiresAt: expiresAt}
}
`,
  'files/sessions/sessions.go': `// Package sessions is upload sessions and quota (provided; step 2 builds the same functions).
// quota:used:{tenant} counts the bytes a tenant has reserved or stored against quota:limit:{tenant}
// (DefaultQuotaBytes when unset); quota:reservations:{tenant} scores each open upload by its
// declared size. session:{upload_id} is a hash (tenant, declared_size, mime, name, actual_bytes and
// part:{n} = size per acknowledged part) that expires SessionTTL after it opens. OpenSession reserves
// and opens in one script; AckPart counts a part once; Sweep releases the reservation of an upload
// whose session expired.
package sessions

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	SessionTTL              = 24 * time.Hour
	DefaultQuotaBytes int64 = 1 << 30
)

var openScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
if used + tonumber(ARGV[1]) > limit then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
redis.call('EXPIRE', KEYS[4], ARGV[6])
return 1
\`)

var ackScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
\`)

// Session is an open upload.
type Session struct {
	UploadID     string
	Tenant       string
	DeclaredSize int64
	ActualBytes  int64
	Mime         string
	Name         string
	Parts        map[int]int64
}

// OpenSession reserves declaredSize against the tenant's quota and opens the session; its upload id, or "" over quota.
func OpenSession(ctx context.Context, tenant string, declaredSize int64, mime, name string) (string, error) {
	seq, err := rdb.Incr(ctx, "upload:seq").Result()
	if err != nil {
		return "", err
	}
	uploadID := fmt.Sprintf("up-%d", seq)
	keys := []string{"quota:used:" + tenant, "quota:limit:" + tenant, "quota:reservations:" + tenant, "session:" + uploadID}
	opened, err := openScript.Run(ctx, rdb, keys, declaredSize, uploadID, tenant, mime, name, int64(SessionTTL/time.Second), DefaultQuotaBytes).Int64()
	if err != nil || opened != 1 {
		return "", err
	}
	return uploadID, nil
}

// AckPart counts part n once; the upload's actual bytes after it, or -1 when the session is gone.
func AckPart(ctx context.Context, uploadID string, n int, size int64) (int64, error) {
	return ackScript.Run(ctx, rdb, []string{"session:" + uploadID}, n, size).Int64()
}

// FindSession is the session, or nil.
func FindSession(ctx context.Context, uploadID string) (*Session, error) {
	raw, err := rdb.HGetAll(ctx, "session:"+uploadID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	s := &Session{UploadID: uploadID, Tenant: raw["tenant"], Mime: raw["mime"], Name: raw["name"], Parts: map[int]int64{}}
	s.DeclaredSize, _ = strconv.ParseInt(raw["declared_size"], 10, 64)
	s.ActualBytes, _ = strconv.ParseInt(raw["actual_bytes"], 10, 64)
	for field, value := range raw {
		if strings.HasPrefix(field, "part:") {
			n, _ := strconv.Atoi(field[5:])
			s.Parts[n], _ = strconv.ParseInt(value, 10, 64)
		}
	}
	return s, nil
}

// Sweep releases the reservations whose session expired without a commit; the bytes released.
func Sweep(ctx context.Context, tenant string) (int64, error) {
	entries, err := rdb.ZRangeWithScores(ctx, "quota:reservations:"+tenant, 0, -1).Result()
	if err != nil {
		return 0, err
	}
	var released int64
	for _, z := range entries {
		uploadID := fmt.Sprint(z.Member)
		if rdb.Exists(ctx, "session:"+uploadID).Val() == 1 {
			continue
		}
		// Only the sweeper that removed the reservation releases it.
		if rdb.ZRem(ctx, "quota:reservations:"+tenant, uploadID).Val() == 1 {
			rdb.DecrBy(ctx, "quota:used:"+tenant, int64(z.Score))
			released += int64(z.Score)
		}
	}
	return released, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'files/store.h': `// The file index and the staging area (provided). A part the API accepted is staged under
// part:{upload_id}:{n} (bytes, 24 h) until the object store has it. A committed file is the hash
// file:{file_id} with file_id, upload_id, tenant, name, mime, size, digest, object_key and state
// (committed or deleted); its id is the upload's number, f-7 for up-7. commitFile settles the
// upload: usage moves from the declared size to the actual one, the reservation leaves
// quota:reservations:{tenant}, the session and its staged parts are dropped. A download URL is
// signed with HMAC-SHA256 over the file id, the tenant and the expiry; verifyUrl is what the CDN runs.
#pragma once

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace store {

constexpr long long kMaxUploadBytes = 5LL << 30;
const std::vector<std::string> kAllowedMime = {"image/png", "image/jpeg", "application/pdf"};
constexpr std::chrono::seconds kStageTtl{86400};
const std::string kCdn = "https://cdn.stored.example";

// A committed (or deleted) file's record.
struct File {
  std::string file_id;
  std::string upload_id;
  std::string tenant;
  std::string name;
  std::string mime;
  long long size = 0;
  std::string digest;
  std::string object_key;
  std::string state;
};

// What a valid signed URL gives access to.
struct Grant {
  std::string file_id;
  std::string tenant;
  long long expires_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The type the leading bytes say the file is; application/octet-stream when no signature matches.
inline std::string sniffMime(const std::string& head) {
  static const std::vector<std::pair<std::string, std::string>> signatures = {
      {std::string("\\x89PNG\\r\\n\\x1a\\n", 8), "image/png"},
      {std::string("\\xff\\xd8\\xff", 3), "image/jpeg"},
      {"%PDF-", "application/pdf"}};
  for (const auto& [magic, mime] : signatures) {
    if (head.compare(0, magic.size(), magic) == 0) return mime;
  }
  return "application/octet-stream";
}

// Keep part n's bytes until the object store has them.
inline void stagePart(const std::string& upload_id, int n, const std::string& data) {
  redis().set("part:" + upload_id + ":" + std::to_string(n), data, kStageTtl);
}

// The upload's acknowledged parts in order, as (part number, bytes).
inline std::vector<std::pair<int, std::string>> stagedParts(const std::string& upload_id) {
  std::vector<int> numbers;
  for (const std::string& field : redis().hkeys("session:" + upload_id)) {
    if (field.rfind("part:", 0) == 0) numbers.push_back(std::stoi(field.substr(5)));
  }
  std::sort(numbers.begin(), numbers.end());
  std::vector<std::pair<int, std::string>> parts;
  for (int n : numbers) parts.emplace_back(n, redis().get("part:" + upload_id + ":" + std::to_string(n)).value_or(""));
  return parts;
}

inline std::string fileIdFor(const std::string& upload_id) {
  return "f-" + (upload_id.rfind("up-", 0) == 0 ? upload_id.substr(3) : upload_id);
}

// Index the committed object as file:{file_id} and settle the upload; returns the record.
inline File commitFile(const std::string& upload_id, const std::string& object_key, const std::string& digest) {
  const std::unordered_map<std::string, std::string> session = redis().hgetall("session:" + upload_id);
  if (session.empty()) throw std::out_of_range("no upload session " + upload_id);
  const auto text = [&session](const char* name) { return session.count(name) ? session.at(name) : std::string(); };
  File f{fileIdFor(upload_id), upload_id, text("tenant"), text("name"), text("mime"), std::stoll(text("actual_bytes")), digest, object_key, "committed"};
  const std::map<std::string, std::string> record = {
      {"file_id", f.file_id}, {"upload_id", upload_id}, {"tenant", f.tenant}, {"name", f.name}, {"mime", f.mime},
      {"size", std::to_string(f.size)}, {"digest", digest}, {"object_key", object_key}, {"state", f.state}};
  redis().hset("file:" + f.file_id, record.begin(), record.end());
  redis().incrby("quota:used:" + f.tenant, f.size - std::stoll(text("declared_size")));
  redis().zrem("quota:reservations:" + f.tenant, upload_id);
  std::vector<std::string> keys = {"session:" + upload_id};
  for (const auto& [field, value] : session) {
    if (field.rfind("part:", 0) == 0) keys.push_back("part:" + upload_id + ":" + field.substr(5));
  }
  redis().del(keys.begin(), keys.end());
  return f;
}

// The file's record, whatever its state, or none.
inline std::optional<File> findFile(const std::string& file_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("file:" + file_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return File{text("file_id"), text("upload_id"), text("tenant"), text("name"), text("mime"), std::stoll(text("size")), text("digest"), text("object_key"), text("state")};
}

// Mark a committed file deleted and give its bytes back to the tenant's quota; none when there is none.
inline std::optional<File> deleteFile(const std::string& file_id) {
  auto f = findFile(file_id);
  if (!f || f->state != "committed") return std::nullopt;
  redis().hset("file:" + file_id, "state", "deleted");
  redis().decrby("quota:used:" + f->tenant, f->size);
  f->state = "deleted";
  return f;
}

inline std::string urlSignature(const std::string& file_id, const std::string& tenant, long long expires_at) {
  static const std::string key = "stored-cdn-signing-key";
  const std::string message = file_id + "\\n" + tenant + "\\n" + std::to_string(expires_at);
  unsigned char mac[32];
  unsigned int length = 0;
  HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), reinterpret_cast<const unsigned char*>(message.data()), message.size(), mac, &length);
  std::string hex;
  char byte[3];
  for (unsigned int i = 0; i < length; i++) {
    std::snprintf(byte, sizeof byte, "%02x", mac[i]);
    hex += byte;
  }
  return hex;
}

// A CDN URL for the file that the CDN honours until expires_at (epoch seconds), for this tenant only.
inline std::string signUrl(const std::string& file_id, const std::string& tenant, long long expires_at) {
  return kCdn + "/f/" + file_id + "?tenant=" + tenant + "&expires=" + std::to_string(expires_at) + "&sig=" + urlSignature(file_id, tenant, expires_at);
}

// The CDN's check: the grant when the signature matches and now is not past the expiry, else none.
inline std::optional<Grant> verifyUrl(const std::string& url, long long now) {
  const std::string prefix = kCdn + "/f/";
  const size_t question = url.find('?');
  if (url.rfind(prefix, 0) != 0 || question == std::string::npos) return std::nullopt;
  std::map<std::string, std::string> params;
  size_t start = question + 1;
  while (start <= url.size()) {
    size_t amp = url.find('&', start);
    if (amp == std::string::npos) amp = url.size();
    const std::string pair = url.substr(start, amp - start);
    const size_t eq = pair.find('=');
    if (eq != std::string::npos) params[pair.substr(0, eq)] = pair.substr(eq + 1);
    start = amp + 1;
  }
  const std::string expires = params["expires"];
  if (params["tenant"].empty() || expires.empty() || expires.find_first_not_of("0123456789") != std::string::npos) return std::nullopt;
  Grant grant{url.substr(prefix.size(), question - prefix.size()), params["tenant"], std::stoll(expires)};
  if (grant.expires_at < now || params["sig"] != urlSignature(grant.file_id, grant.tenant, grant.expires_at)) return std::nullopt;
  return grant;
}

}  // namespace store
`,
  'files/sessions.h': `// Upload sessions and quota (provided; step 2 builds the same functions). quota:used:{tenant}
// counts the bytes a tenant has reserved or stored against quota:limit:{tenant} (kDefaultQuotaBytes
// when unset); quota:reservations:{tenant} scores each open upload by its declared size.
// session:{upload_id} is a hash (tenant, declared_size, mime, name, actual_bytes and part:{n} = size
// per acknowledged part) that expires kSessionTtl after it opens. openSession reserves and opens in
// one script; ackPart counts a part once; sweep releases the reservation of an upload whose session
// expired.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace sessions {

constexpr std::chrono::seconds kSessionTtl{86400};
constexpr long long kDefaultQuotaBytes = 1LL << 30;

inline const std::string kOpenLua = R"lua(
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
if used + tonumber(ARGV[1]) > limit then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
redis.call('EXPIRE', KEYS[4], ARGV[6])
return 1
)lua";

inline const std::string kAckLua = R"lua(
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
)lua";

// An open upload.
struct Session {
  std::string upload_id;
  std::string tenant;
  long long declared_size = 0;
  long long actual_bytes = 0;
  std::string mime;
  std::string name;
  std::map<int, long long> parts;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Reserve declared_size against the tenant's quota and open the session; its upload id, or none over quota.
inline std::optional<std::string> openSession(const std::string& tenant, long long declared_size, const std::string& mime, const std::string& name) {
  const std::string upload_id = "up-" + std::to_string(redis().incr("upload:seq"));
  const long long opened = redis().eval<long long>(
      kOpenLua, {"quota:used:" + tenant, "quota:limit:" + tenant, "quota:reservations:" + tenant, "session:" + upload_id},
      {std::to_string(declared_size), upload_id, tenant, mime, name, std::to_string(kSessionTtl.count()), std::to_string(kDefaultQuotaBytes)});
  if (opened != 1) return std::nullopt;
  return upload_id;
}

// Count part n once; the upload's actual bytes after it, or -1 when the session is gone.
inline long long ackPart(const std::string& upload_id, int n, long long size) {
  return redis().eval<long long>(kAckLua, {"session:" + upload_id}, {std::to_string(n), std::to_string(size)});
}

// The session, or none.
inline std::optional<Session> findSession(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("session:" + upload_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Session s{upload_id, text("tenant"), std::stoll(text("declared_size")), std::stoll(text("actual_bytes")), text("mime"), text("name"), {}};
  for (const auto& [field, value] : raw) {
    if (field.rfind("part:", 0) == 0) s.parts[std::stoi(field.substr(5))] = std::stoll(value);
  }
  return s;
}

// Release the reservations whose session expired without a commit; the bytes released.
inline long long sweep(const std::string& tenant) {
  std::vector<std::pair<std::string, double>> entries;
  redis().zrange("quota:reservations:" + tenant, 0, -1, std::back_inserter(entries));
  long long released = 0;
  for (const auto& [upload_id, declared] : entries) {
    if (redis().exists("session:" + upload_id) == 1) continue;
    // Only the sweeper that removed the reservation releases it.
    if (redis().zrem("quota:reservations:" + tenant, upload_id) == 1) {
      redis().decrby("quota:used:" + tenant, static_cast<long long>(declared));
      released += static_cast<long long>(declared);
    }
  }
  return released;
}

}  // namespace sessions
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('files', 'Store')]: `package files

import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The file index and the staging area (provided). A part the API accepted is staged under
 * part:{upload_id}:{n} (bytes, 24 h) until the object store has it. A committed file is the hash
 * file:{file_id} with file_id, upload_id, tenant, name, mime, size, digest, object_key and state
 * (committed or deleted); its id is the upload's number, f-7 for up-7. commitFile settles the
 * upload: usage moves from the declared size to the actual one, the reservation leaves
 * quota:reservations:{tenant}, the session and its staged parts are dropped. A download URL is
 * signed with HMAC-SHA256 over the file id, the tenant and the expiry; verifyUrl is what the CDN runs.
 */
object Store {
  final case class File(fileId: String, uploadId: String, tenant: String, name: String, mime: String, size: Long, digest: String, objectKey: String, state: String)
  final case class Grant(fileId: String, tenant: String, expiresAt: Long)

  val MaxUploadBytes: Long = 5L << 30
  val AllowedMime: Seq[String] = Seq("image/png", "image/jpeg", "application/pdf")
  val StageTtlSeconds = 86400L
  val Cdn = "https://cdn.stored.example"
  private val SigningKey = "stored-cdn-signing-key"
  private val Signatures: Seq[(Array[Byte], String)] = Seq(
    (Array(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).map(_.toByte), "image/png"),
    (Array(0xff, 0xd8, 0xff).map(_.toByte), "image/jpeg"),
    ("%PDF-".getBytes(StandardCharsets.US_ASCII), "application/pdf"))

  val jedis = new JedisPooled("redis", 6379)

  /** The type the leading bytes say the file is; application/octet-stream when no signature matches. */
  def sniffMime(head: Array[Byte]): String =
    Signatures.collectFirst { case (magic, mime) if head.startsWith(magic) => mime }.getOrElse("application/octet-stream")

  /** Keep part n's bytes until the object store has them. */
  def stagePart(uploadId: String, n: Int, data: Array[Byte]): Unit =
    jedis.setex(s"part:$uploadId:$n".getBytes(StandardCharsets.UTF_8), StageTtlSeconds, data)

  /** The upload's acknowledged parts in order, as (part number, bytes). */
  def stagedParts(uploadId: String): Seq[(Int, Array[Byte])] =
    jedis.hkeys(s"session:$uploadId").asScala.toSeq.filter(_.startsWith("part:")).map(_.drop(5).toInt).sorted.map { n =>
      n -> Option(jedis.get(s"part:$uploadId:$n".getBytes(StandardCharsets.UTF_8))).getOrElse(Array.emptyByteArray)
    }

  def fileIdFor(uploadId: String): String = "f-" + uploadId.stripPrefix("up-")

  /** Index the committed object as file:{file_id} and settle the upload; returns the record. */
  def commitFile(uploadId: String, objectKey: String, digest: String): File = {
    val session = jedis.hgetAll(s"session:$uploadId").asScala.toMap
    if (session.isEmpty) throw new NoSuchElementException(s"no upload session $uploadId")
    val f = File(fileIdFor(uploadId), uploadId, session("tenant"), session.getOrElse("name", ""), session("mime"), session("actual_bytes").toLong, digest, objectKey, "committed")
    jedis.hset(s"file:\${f.fileId}", Map(
      "file_id" -> f.fileId, "upload_id" -> uploadId, "tenant" -> f.tenant, "name" -> f.name, "mime" -> f.mime,
      "size" -> f.size.toString, "digest" -> digest, "object_key" -> objectKey, "state" -> f.state).asJava)
    jedis.incrBy(s"quota:used:\${f.tenant}", f.size - session("declared_size").toLong)
    jedis.zrem(s"quota:reservations:\${f.tenant}", uploadId)
    val parts = session.keys.filter(_.startsWith("part:")).map(field => s"part:$uploadId:\${field.drop(5)}").toSeq
    jedis.del((s"session:$uploadId" +: parts): _*)
    f
  }

  /** The file's record, whatever its state, if it exists. */
  def findFile(fileId: String): Option[File] = {
    val raw = jedis.hgetAll(s"file:$fileId").asScala.toMap
    if (raw.isEmpty) None
    else Some(File(raw("file_id"), raw("upload_id"), raw("tenant"), raw.getOrElse("name", ""), raw("mime"), raw("size").toLong, raw("digest"), raw("object_key"), raw("state")))
  }

  /** Mark a committed file deleted and give its bytes back to the tenant's quota; None when there is none. */
  def deleteFile(fileId: String): Option[File] = findFile(fileId).filter(_.state == "committed").map { f =>
    jedis.hset(s"file:$fileId", "state", "deleted")
    jedis.decrBy(s"quota:used:\${f.tenant}", f.size)
    f.copy(state = "deleted")
  }

  private def signature(fileId: String, tenant: String, expiresAt: Long): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(SigningKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"))
    mac.doFinal(s"$fileId\\n$tenant\\n$expiresAt".getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString
  }

  /** A CDN URL for the file that the CDN honours until expiresAt (epoch seconds), for this tenant only. */
  def signUrl(fileId: String, tenant: String, expiresAt: Long): String =
    s"$Cdn/f/$fileId?tenant=$tenant&expires=$expiresAt&sig=\${signature(fileId, tenant, expiresAt)}"

  /** The CDN's check: the grant when the signature matches and now is not past the expiry. */
  def verifyUrl(url: String, now: Long): Option[Grant] = {
    val prefix = s"$Cdn/f/"
    url.indexOf('?') match {
      case q if url.startsWith(prefix) && q > 0 =>
        val params = url.drop(q + 1).split('&').toSeq.flatMap(_.split("=", 2) match {
          case Array(k, v) => Some(k -> URLDecoder.decode(v, StandardCharsets.UTF_8))
          case _ => None
        }).toMap
        for {
          tenant <- params.get("tenant")
          expiresAt <- params.get("expires").flatMap(_.toLongOption)
          sig <- params.get("sig")
          fileId = url.substring(prefix.length, q)
          if expiresAt >= now && sig == signature(fileId, tenant, expiresAt)
        } yield Grant(fileId, tenant, expiresAt)
      case _ => None
    }
  }
}
`,
  [scalaPath('files', 'Sessions')]: `package files

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Upload sessions and quota (provided; step 2 builds the same functions). quota:used:{tenant} counts
 * the bytes a tenant has reserved or stored against quota:limit:{tenant} (DefaultQuotaBytes when
 * unset); quota:reservations:{tenant} scores each open upload by its declared size.
 * session:{upload_id} is a hash (tenant, declared_size, mime, name, actual_bytes and part:{n} = size
 * per acknowledged part) that expires SessionTtlSeconds after it opens. openSession reserves and
 * opens in one script; ackPart counts a part once; sweep releases the reservation of an upload whose
 * session expired.
 */
object Sessions {
  final case class Session(uploadId: String, tenant: String, declaredSize: Long, actualBytes: Long, mime: String, name: String, parts: Map[Int, Long])

  val SessionTtlSeconds = 86400L
  val DefaultQuotaBytes: Long = 1L << 30

  val OpenLua: String =
    """local used = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
      |if used + tonumber(ARGV[1]) > limit then return 0 end
      |redis.call('INCRBY', KEYS[1], ARGV[1])
      |redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
      |redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
      |redis.call('EXPIRE', KEYS[4], ARGV[6])
      |return 1
      |""".stripMargin

  val AckLua: String =
    """if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
      |if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
      |  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
      |end
      |return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  /** Reserve declaredSize against the tenant's quota and open the session; its upload id, or None over quota. */
  def openSession(tenant: String, declaredSize: Long, mime: String, name: String): Option[String] = {
    val uploadId = s"up-\${jedis.incr("upload:seq")}"
    val keys = List(s"quota:used:$tenant", s"quota:limit:$tenant", s"quota:reservations:$tenant", s"session:$uploadId").asJava
    val args = List(declaredSize.toString, uploadId, tenant, mime, name, SessionTtlSeconds.toString, DefaultQuotaBytes.toString).asJava
    if (jedis.eval(OpenLua, keys, args).asInstanceOf[java.lang.Long] == 1L) Some(uploadId) else None
  }

  /** Count part n once; the upload's actual bytes after it, or -1 when the session is gone. */
  def ackPart(uploadId: String, n: Int, size: Long): Long =
    jedis.eval(AckLua, List(s"session:$uploadId").asJava, List(n.toString, size.toString).asJava).asInstanceOf[java.lang.Long]

  /** The session, if it is open. */
  def findSession(uploadId: String): Option[Session] = {
    val raw = jedis.hgetAll(s"session:$uploadId").asScala.toMap
    if (raw.isEmpty) None
    else {
      val parts = raw.collect { case (field, value) if field.startsWith("part:") => field.drop(5).toInt -> value.toLong }
      Some(Session(uploadId, raw("tenant"), raw("declared_size").toLong, raw("actual_bytes").toLong, raw("mime"), raw.getOrElse("name", ""), parts))
    }
  }

  /** Release the reservations whose session expired without a commit; the bytes released. */
  def sweep(tenant: String): Long =
    jedis.zrangeWithScores(s"quota:reservations:$tenant", 0, -1).asScala.toSeq.map { entry =>
      val uploadId = entry.getElement
      // Only the sweeper that removed the reservation releases it.
      if (!jedis.exists(s"session:$uploadId") && jedis.zrem(s"quota:reservations:$tenant", uploadId) == 1L) {
        jedis.decrBy(s"quota:used:$tenant", entry.getScore.toLong)
        entry.getScore.toLong
      } else 0L
    }.sum
}
`,
};
