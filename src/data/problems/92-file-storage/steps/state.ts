import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis upload sessions: one reservation, counted once, released once',
  concept: 'redis',
  guides: ['atomic-state', 'idempotent-requests', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the Redis layer behind the upload API (provided to the other steps
as \`files.sessions\`): \`open_session(tenant, declared_size, mime, name)\` reads the tenant's
\`quota:used\` and \`quota:limit\`, then increments the usage, adds the upload to
\`quota:reservations:{tenant}\` and writes \`session:{upload_id}\`; \`ack_part(upload_id, n, size)\`
records part n and adds its size to \`actual_bytes\`; \`sweep(tenant)\` gives back the reservation of
every upload whose session is gone. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two uploads that each fit the quota alone both open; an abandoned
upload holds its reservation forever; a client that retries a part is charged for it twice; and a
second sweep hands the same bytes back again.

- The quota check, \`INCRBY\`, \`ZADD\`, the session \`HSET\` and its \`EXPIRE\` run in **one** Lua
  script (\`OPEN_LUA\`).
- \`session:{upload_id}\` expires \`SESSION_TTL_S\` = 86400 seconds after it opens.
- \`ack_part\` is one script (\`ACK_LUA\`): \`HSETNX\` the \`part:{n}\` field and add to \`actual_bytes\`
  only when the field is new; -1 when the session is gone.
- \`sweep\` releases a reservation only when its own \`ZREM\` removed it.`,
  sequence: {
    participants: ['Upload API', 'Redis', 'Sweeper'],
    messages: [
      {
        from: 'Upload API',
        to: 'Redis',
        label: 'EVAL OPEN_LUA · check quota · INCRBY · ZADD · HSET · EXPIRE 86400',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Upload API', label: '1 opened · 0 over quota', kind: 'reply'},
      {from: 'Upload API', to: 'Redis', label: 'EVAL ACK_LUA · HSETNX part:{n} · HINCRBY actual_bytes', kind: 'sync'},
      {from: 'Redis', to: 'Upload API', label: 'actual bytes (a retried part adds nothing)', kind: 'reply'},
      {from: 'Sweeper', to: 'Redis', label: 'ZRANGE reservations · EXISTS session', kind: 'sync'},
      {from: 'Sweeper', to: 'Redis', label: 'ZREM upload → 1 · DECRBY quota:used', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'reserve-atomic',
      title: 'Checks and reserves the quota in one script',
      detail:
        'The quota check, the `INCRBY` of `quota:used:{tenant}`, the `ZADD` of the reservation and the session write run in one Lua script; a check in the application followed by a separate `INCRBY` lets two uploads that each fit both open.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/\br\.incrby\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/redis\.incrby\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/rdb\.IncrBy\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]INCRBY['"]/],
          none: [/redis\.incrby\(/],
        },
      },
    },
    {
      id: 'session-ttl',
      title: 'The session expires after 24 hours',
      detail:
        '`session:{upload_id}` gets its `EXPIRE` of 86400 seconds when it opens, in the same script, so an abandoned upload stops existing and the sweep can release its reservation; acknowledging a part does not extend it.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /SESSION_TTL_S\s*=\s*86400/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /SESSION_TTL_S\s*=\s*86400/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /sessionTTL\s*=\s*24\s*\*\s*time\.Hour/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /kSessionTtl\{86400\}/]},
      },
    },
    {
      id: 'ack-idempotent',
      title: 'A retried part is counted once',
      detail:
        'The part field is written with `HSETNX` and `actual_bytes` grows only when it was new, both in one script; an `HSET` followed by an unconditional `HINCRBY` charges a retried part twice.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HSETNX['"]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\br\.hincrby\(/]},
        typescript: {
          all: [/redis\.call\(\s*['"]HSETNX['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/redis\.hincrby\(/],
        },
        go: {all: [/redis\.call\(\s*['"]HSETNX['"]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/rdb\.HIncrBy\(/]},
        cpp: {all: [/redis\.call\(\s*['"]HSETNX['"]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/redis\.hincrby\(/]},
      },
    },
    {
      id: 'sweep-release',
      title: 'A sweep releases each reservation once',
      detail:
        'For a reservation whose session is gone, the sweep removes the member with `ZREM` and gives the bytes back only when that `ZREM` removed it; without it, every sweep releases the same reservation again.',
      match: {
        python: {order: [/def sweep/, /\.zrem\(/, /\.decrby\(/]},
        typescript: {order: [/function sweep/, /\.zrem\(/, /\.decrby\(/]},
        go: {order: [/func sweep/, /\.ZRem\(/, /\.DecrBy\(/]},
        cpp: {order: [/long long sweep/, /\.zrem\(/, /\.decrby\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SESSION_TTL_S = 86400
DEFAULT_QUOTA_BYTES = 1 << 30


def open_session(tenant: str, declared_size: int, mime: str, name: str) -> str | None:
    """Reserve declared_size against the tenant's quota and open the session; its upload id, or None over quota."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    upload_id = f"up-{r.incr('upload:seq')}"
    used = int(r.get(f"quota:used:{tenant}") or 0)
    limit = int(r.get(f"quota:limit:{tenant}") or DEFAULT_QUOTA_BYTES)
    if used + declared_size > limit:
        return None
    r.incrby(f"quota:used:{tenant}", declared_size)
    r.zadd(f"quota:reservations:{tenant}", {upload_id: declared_size})
    r.hset(f"session:{upload_id}", mapping={"tenant": tenant, "declared_size": declared_size, "mime": mime, "name": name, "actual_bytes": 0})
    return upload_id


def ack_part(upload_id: str, n: int, size: int) -> int:
    """Count part n once; the upload's actual bytes after it, or -1 when the session is gone."""
    if not r.exists(f"session:{upload_id}"):
        return -1
    r.hset(f"session:{upload_id}", f"part:{n}", size)
    return r.hincrby(f"session:{upload_id}", "actual_bytes", size)


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
        r.decrby(f"quota:used:{tenant}", int(declared))
        released += int(declared)
    return released
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SESSION_TTL_S = 86400
DEFAULT_QUOTA_BYTES = 1 << 30

# The check and every write of the reservation in one script: no other upload can land in between.
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
# A part is counted only the first time its field is written.
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
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Session} from 'files/sessions';

const redis = new Redis({host: 'redis', port: 6379});

export const SESSION_TTL_S = 86400;
export const DEFAULT_QUOTA_BYTES = 1024 ** 3;

/** Reserve declaredSize against the tenant's quota and open the session; its upload id, or null over quota. */
export async function openSession(tenant: string, declaredSize: number, mime: string, name: string): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const uploadId = \`up-\${await redis.incr('upload:seq')}\`;
  const used = Number((await redis.get(\`quota:used:\${tenant}\`)) ?? 0);
  const limit = Number((await redis.get(\`quota:limit:\${tenant}\`)) ?? DEFAULT_QUOTA_BYTES);
  if (used + declaredSize > limit) return null;
  await redis.incrby(\`quota:used:\${tenant}\`, declaredSize);
  await redis.zadd(\`quota:reservations:\${tenant}\`, declaredSize, uploadId);
  await redis.hset(\`session:\${uploadId}\`, {tenant, declared_size: declaredSize, mime, name, actual_bytes: 0});
  return uploadId;
}

/** Count part n once; the upload's actual bytes after it, or -1 when the session is gone. */
export async function ackPart(uploadId: string, n: number, size: number): Promise<number> {
  if (!(await redis.exists(\`session:\${uploadId}\`))) return -1;
  await redis.hset(\`session:\${uploadId}\`, \`part:\${n}\`, size);
  return redis.hincrby(\`session:\${uploadId}\`, 'actual_bytes', size);
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
    await redis.decrby(\`quota:used:\${tenant}\`, declared);
    released += declared;
  }
  return released;
}
`,
      solution: `import Redis from 'ioredis';

import type {Session} from 'files/sessions';

export const SESSION_TTL_S = 86400;
export const DEFAULT_QUOTA_BYTES = 1024 ** 3;

// The check and every write of the reservation in one script: no other upload can land in between.
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
// A part is counted only the first time its field is written.
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
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"files/sessions" // sessions.Session
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	sessionTTL              = 24 * time.Hour
	defaultQuotaBytes int64 = 1 << 30
)

// openSession reserves declaredSize against the tenant's quota and opens the session; its upload id, or "" over quota.
func openSession(ctx context.Context, tenant string, declaredSize int64, mime, name string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	seq, err := rdb.Incr(ctx, "upload:seq").Result()
	if err != nil {
		return "", err
	}
	uploadID := fmt.Sprintf("up-%d", seq)
	used, _ := rdb.Get(ctx, "quota:used:"+tenant).Int64()
	limit, err := rdb.Get(ctx, "quota:limit:"+tenant).Int64()
	if err != nil {
		limit = defaultQuotaBytes
	}
	if used+declaredSize > limit {
		return "", nil
	}
	rdb.IncrBy(ctx, "quota:used:"+tenant, declaredSize)
	rdb.ZAdd(ctx, "quota:reservations:"+tenant, redis.Z{Score: float64(declaredSize), Member: uploadID})
	rdb.HSet(ctx, "session:"+uploadID, map[string]any{"tenant": tenant, "declared_size": declaredSize, "mime": mime, "name": name, "actual_bytes": 0})
	return uploadID, nil
}

// ackPart counts part n once; the upload's actual bytes after it, or -1 when the session is gone.
func ackPart(ctx context.Context, uploadID string, n int, size int64) (int64, error) {
	if rdb.Exists(ctx, "session:"+uploadID).Val() == 0 {
		return -1, nil
	}
	rdb.HSet(ctx, "session:"+uploadID, fmt.Sprintf("part:%d", n), size)
	return rdb.HIncrBy(ctx, "session:"+uploadID, "actual_bytes", size).Result()
}

// findSession is the session, or nil.
func findSession(ctx context.Context, uploadID string) (*sessions.Session, error) {
	raw, err := rdb.HGetAll(ctx, "session:"+uploadID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	s := &sessions.Session{UploadID: uploadID, Tenant: raw["tenant"], Mime: raw["mime"], Name: raw["name"], Parts: map[int]int64{}}
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

// sweep releases the reservations whose session expired without a commit; the bytes released.
func sweep(ctx context.Context, tenant string) (int64, error) {
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
		rdb.DecrBy(ctx, "quota:used:"+tenant, int64(z.Score))
		released += int64(z.Score)
	}
	return released, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"files/sessions" // sessions.Session
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	sessionTTL              = 24 * time.Hour
	defaultQuotaBytes int64 = 1 << 30
)

// openScript: the check and every write of the reservation in one script, so no other upload can land in between.
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

// ackScript counts a part only the first time its field is written.
var ackScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
\`)

// openSession reserves declaredSize against the tenant's quota and opens the session; its upload id, or "" over quota.
func openSession(ctx context.Context, tenant string, declaredSize int64, mime, name string) (string, error) {
	seq, err := rdb.Incr(ctx, "upload:seq").Result()
	if err != nil {
		return "", err
	}
	uploadID := fmt.Sprintf("up-%d", seq)
	keys := []string{"quota:used:" + tenant, "quota:limit:" + tenant, "quota:reservations:" + tenant, "session:" + uploadID}
	opened, err := openScript.Run(ctx, rdb, keys, declaredSize, uploadID, tenant, mime, name, int64(sessionTTL/time.Second), defaultQuotaBytes).Int64()
	if err != nil || opened != 1 {
		return "", err
	}
	return uploadID, nil
}

// ackPart counts part n once; the upload's actual bytes after it, or -1 when the session is gone.
func ackPart(ctx context.Context, uploadID string, n int, size int64) (int64, error) {
	return ackScript.Run(ctx, rdb, []string{"session:" + uploadID}, n, size).Int64()
}

// findSession is the session, or nil.
func findSession(ctx context.Context, uploadID string) (*sessions.Session, error) {
	raw, err := rdb.HGetAll(ctx, "session:"+uploadID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	s := &sessions.Session{UploadID: uploadID, Tenant: raw["tenant"], Mime: raw["mime"], Name: raw["name"], Parts: map[int]int64{}}
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

// sweep releases the reservations whose session expired without a commit; the bytes released.
func sweep(ctx context.Context, tenant string) (int64, error) {
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
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "files/sessions.h"  // sessions::Session

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSessionTtl{86400};
constexpr long long kDefaultQuotaBytes = 1LL << 30;

// Reserve declared_size against the tenant's quota and open the session; its upload id, or none over quota.
std::optional<std::string> openSession(const std::string& tenant, long long declared_size, const std::string& mime, const std::string& name) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string upload_id = "up-" + std::to_string(redis.incr("upload:seq"));
  const long long used = std::stoll(redis.get("quota:used:" + tenant).value_or("0"));
  const long long limit = std::stoll(redis.get("quota:limit:" + tenant).value_or(std::to_string(kDefaultQuotaBytes)));
  if (used + declared_size > limit) return std::nullopt;
  redis.incrby("quota:used:" + tenant, declared_size);
  redis.zadd("quota:reservations:" + tenant, upload_id, static_cast<double>(declared_size));
  redis.hset("session:" + upload_id, {std::make_pair(std::string("tenant"), tenant), {"declared_size", std::to_string(declared_size)},
                                      {"mime", mime}, {"name", name}, {"actual_bytes", "0"}});
  return upload_id;
}

// Count part n once; the upload's actual bytes after it, or -1 when the session is gone.
long long ackPart(const std::string& upload_id, int n, long long size) {
  if (redis.exists("session:" + upload_id) == 0) return -1;
  redis.hset("session:" + upload_id, "part:" + std::to_string(n), std::to_string(size));
  return redis.hincrby("session:" + upload_id, "actual_bytes", size);
}

// The session, or none.
std::optional<sessions::Session> findSession(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall("session:" + upload_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  sessions::Session s{upload_id, text("tenant"), std::stoll(text("declared_size")), std::stoll(text("actual_bytes")), text("mime"), text("name"), {}};
  for (const auto& [field, value] : raw) {
    if (field.rfind("part:", 0) == 0) s.parts[std::stoi(field.substr(5))] = std::stoll(value);
  }
  return s;
}

// Release the reservations whose session expired without a commit; the bytes released.
long long sweep(const std::string& tenant) {
  std::vector<std::pair<std::string, double>> entries;
  redis.zrange("quota:reservations:" + tenant, 0, -1, std::back_inserter(entries));
  long long released = 0;
  for (const auto& [upload_id, declared] : entries) {
    if (redis.exists("session:" + upload_id) == 1) continue;
    redis.decrby("quota:used:" + tenant, static_cast<long long>(declared));
    released += static_cast<long long>(declared);
  }
  return released;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "files/sessions.h"  // sessions::Session

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSessionTtl{86400};
constexpr long long kDefaultQuotaBytes = 1LL << 30;

// The check and every write of the reservation in one script: no other upload can land in between.
const std::string kOpenLua = R"lua(
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or ARGV[7])
if used + tonumber(ARGV[1]) > limit then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'tenant', ARGV[3], 'declared_size', ARGV[1], 'mime', ARGV[4], 'name', ARGV[5], 'actual_bytes', 0)
redis.call('EXPIRE', KEYS[4], ARGV[6])
return 1
)lua";

// A part is counted only the first time its field is written.
const std::string kAckLua = R"lua(
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[1], 'part:' .. ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'actual_bytes', ARGV[2])
end
return tonumber(redis.call('HGET', KEYS[1], 'actual_bytes'))
)lua";

// Reserve declared_size against the tenant's quota and open the session; its upload id, or none over quota.
std::optional<std::string> openSession(const std::string& tenant, long long declared_size, const std::string& mime, const std::string& name) {
  const std::string upload_id = "up-" + std::to_string(redis.incr("upload:seq"));
  const long long opened = redis.eval<long long>(
      kOpenLua, {"quota:used:" + tenant, "quota:limit:" + tenant, "quota:reservations:" + tenant, "session:" + upload_id},
      {std::to_string(declared_size), upload_id, tenant, mime, name, std::to_string(kSessionTtl.count()), std::to_string(kDefaultQuotaBytes)});
  if (opened != 1) return std::nullopt;
  return upload_id;
}

// Count part n once; the upload's actual bytes after it, or -1 when the session is gone.
long long ackPart(const std::string& upload_id, int n, long long size) {
  return redis.eval<long long>(kAckLua, {"session:" + upload_id}, {std::to_string(n), std::to_string(size)});
}

// The session, or none.
std::optional<sessions::Session> findSession(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall("session:" + upload_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  sessions::Session s{upload_id, text("tenant"), std::stoll(text("declared_size")), std::stoll(text("actual_bytes")), text("mime"), text("name"), {}};
  for (const auto& [field, value] : raw) {
    if (field.rfind("part:", 0) == 0) s.parts[std::stoi(field.substr(5))] = std::stoll(value);
  }
  return s;
}

// Release the reservations whose session expired without a commit; the bytes released.
long long sweep(const std::string& tenant) {
  std::vector<std::pair<std::string, double>> entries;
  redis.zrange("quota:reservations:" + tenant, 0, -1, std::back_inserter(entries));
  long long released = 0;
  for (const auto& [upload_id, declared] : entries) {
    if (redis.exists("session:" + upload_id) == 1) continue;
    // Only the sweeper that removed the reservation releases it.
    if (redis.zrem("quota:reservations:" + tenant, upload_id) == 1) {
      redis.decrby("quota:used:" + tenant, static_cast<long long>(declared));
      released += static_cast<long long>(declared);
    }
  }
  return released;
}
`,
    },
  },
  harness: {
    python: `def _used(ctx, tenant="t1"):
    return int(ctx.redis.get(f"quota:used:{tenant}") or 0)


def _snapshot(ctx, tenant="t1"):
    return ctx.redis.zrange(f"quota:reservations:{tenant}", 0, -1), {k: ctx.redis.ttl(k) for k in ctx.redis.keys("session:*")}


def check_reserve_atomic(ctx):
    m = ctx.load("state")
    ctx.redis.set("quota:limit:t1", 100)
    # A second upload of the same tenant lands while this one is reserving; first, what the reservation left.
    def rival_upload():
        seen = _snapshot(ctx)
        return seen, m.open_session("t1", 60, "image/png", "b.png")

    rival = ctx.redis_after("quota:used:t1", rival_upload)
    mine = m.open_session("t1", 60, "image/png", "a.png")
    assert rival.fired, "open_session never touched quota:used:t1"
    if rival.error is not None:
        raise rival.error
    (reserved, sessions_seen), theirs = rival.result
    opened = [u for u in (mine, theirs) if u is not None]
    assert len(opened) == 1, f"two 60-byte uploads against a 100-byte quota both opened ({opened}); quota:used:t1 is {_used(ctx)}. The quota check and the INCRBY must be one script"
    assert len(reserved) == 1 and len(sessions_seen) == 1, f"right after quota:used:t1 grew, the reservations were {reserved} and the sessions {list(sessions_seen)}: the reservation and the session are written in the same script as the INCRBY"
    assert _used(ctx) == 60, f"quota:used:t1 is {_used(ctx)} after one 60-byte reservation"
    assert ctx.redis.zrange("quota:reservations:t1", 0, -1) == opened, f"quota:reservations:t1 holds {ctx.redis.zrange('quota:reservations:t1', 0, -1)}, expected {opened}"
    assert m.open_session("t1", 50, "image/png", "c.png") is None, "a 50-byte upload with 40 bytes of quota left must not open"
    assert _used(ctx) == 60 and len(ctx.redis.keys("session:*")) == 1, f"a refused upload changed the quota ({_used(ctx)}) or left a session ({ctx.redis.keys('session:*')})"
    assert m.open_session("t1", 40, "image/png", "d.png") is not None, "a 40-byte upload with exactly 40 bytes of quota left must open"
    assert _used(ctx) == 100, f"quota:used:t1 is {_used(ctx)} after filling the 100-byte quota"


def check_session_ttl(ctx):
    m = ctx.load("state")
    seen = ctx.redis_after("quota:used:t1", lambda: _snapshot(ctx)[1])
    upload_id = m.open_session("t1", 10, "image/png", "a.png")
    assert upload_id is not None, "a 10-byte upload under the default quota must open"
    assert seen.fired and seen.error is None, f"open_session never touched quota:used:t1 ({seen.error})"
    at_open = seen.result.get(f"session:{upload_id}")
    assert at_open is not None and 86000 <= at_open <= 86400, f"right after the reservation, session:{upload_id} had TTL {at_open}: the session gets its expiry in the script that opens it, not in a later command"
    ttl = ctx.redis.ttl(f"session:{upload_id}")
    assert 86000 <= ttl <= 86400, f"session:{upload_id} has TTL {ttl}: an abandoned upload must expire after 86400 seconds, or its reservation is held forever"
    ctx.clock.advance(3600)
    assert m.ack_part(upload_id, 1, 4) == 4, "acknowledging part 1 (4 bytes) must answer 4"
    ttl = ctx.redis.ttl(f"session:{upload_id}")
    assert 0 < ttl <= 82800, f"an hour after it opened, acknowledging a part left session:{upload_id} with TTL {ttl}: the session expires 86400 seconds after it opens, a part does not extend it"


def check_ack_idempotent(ctx):
    m = ctx.load("state")
    upload_id = m.open_session("t1", 10, "image/png", "a.png")
    assert m.ack_part(upload_id, 1, 4) == 4, "acknowledging part 1 (4 bytes) must answer 4"
    retried = m.ack_part(upload_id, 1, 4)
    assert retried == 4, f"a retried part 1 answered {retried}: the retry was counted again. Count a part only when its field is new"
    assert m.ack_part(upload_id, 2, 6) == 10, "part 2 (6 bytes) after part 1 must answer 10"
    session = m.find_session(upload_id)
    assert session["actual_bytes"] == 10 and session["parts"] == {1: 4, 2: 6}, f"the session holds {session}, expected actual_bytes 10 and parts {{1: 4, 2: 6}}"
    assert m.ack_part("up-404", 1, 4) == -1, "a part of an upload with no session must answer -1"
    assert ctx.redis.exists("session:up-404") == 0, "acknowledging a part of a gone session recreated it without an expiry"
    late = m.open_session("t1", 10, "image/png", "b.png")
    # The session's 24 hours run out while its part is being acknowledged.
    expired = ctx.redis_after(f"session:{late}", lambda: ctx.redis.delete(f"session:{late}"))
    answer = m.ack_part(late, 1, 4)
    assert expired.fired, f"ack_part never touched session:{late}"
    assert ctx.redis.exists(f"session:{late}") == 0, f"session:{late} expired while part 1 was acknowledged and came back as {ctx.redis.hgetall(f'session:{late}')} with TTL {ctx.redis.ttl(f'session:{late}')} (ack_part answered {answer}): the existence check and the count are one script"


def check_sweep_release(ctx):
    m = ctx.load("state")
    ctx.redis.set("quota:limit:t1", 1000)
    gone = m.open_session("t1", 400, "image/png", "a.png")
    live = m.open_session("t1", 300, "image/png", "b.png")
    ctx.redis.delete(f"session:{gone}")  # its 24 hours ran out
    assert m.sweep("t1") == 400, "the sweep must release the 400 bytes of the expired upload"
    assert _used(ctx) == 300 and ctx.redis.zrange("quota:reservations:t1", 0, -1) == [live], f"after the sweep quota:used:t1 is {_used(ctx)} and the reservations are {ctx.redis.zrange('quota:reservations:t1', 0, -1)}, expected 300 and [{live}]"
    again = m.sweep("t1")
    assert again == 0 and _used(ctx) == 300, f"a second sweep released {again} bytes and left quota:used:t1 at {_used(ctx)}: the expired reservation was released twice"
    late = m.open_session("t1", 100, "image/png", "c.png")
    ctx.redis.delete(f"session:{late}")
    # Two sweepers find the same expired upload.
    rival = ctx.redis_after(f"session:{late}", lambda: m.sweep("t1"))
    mine = m.sweep("t1")
    assert rival.fired and rival.error is None, f"the parallel sweep did not run cleanly: {rival.error}"
    assert mine + rival.result == 100 and _used(ctx) == 300, f"two sweepers released {mine} and {rival.result} bytes of one 100-byte reservation; quota:used:t1 is {_used(ctx)}, expected 300"
    last = m.open_session("t1", 100, "image/png", "d.png")
    ctx.redis.delete(f"session:{last}")
    # This time the other sweeper lands right after this one's next command on the reservations, if it has one.
    outer = ctx.redis_after(f"session:{last}", lambda: ctx.redis_after("quota:reservations:t1", lambda: m.sweep("t1")))
    mine = m.sweep("t1")
    assert outer.fired and outer.error is None, f"the sweep never looked at session:{last} ({outer.error})"
    inner = outer.result
    if inner.error is not None:
        raise inner.error
    theirs = inner.result if inner.fired else 0
    assert mine + theirs == 100 and _used(ctx) == 300, f"two sweepers released {mine} and {theirs} bytes of one 100-byte reservation; quota:used:t1 is {_used(ctx)}, expected 300. Release only when your own ZREM removed the member"
`,
    typescript: `const used = (ctx, tenant = 't1'): number => Number(ctx.redis.get(\`quota:used:\${tenant}\`) ?? 0);

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

function snapshot(ctx): {reserved: string[]; ttls: Record<string, number>} {
  const ttls: Record<string, number> = {};
  for (const key of ctx.redis.keys('session:*')) ttls[key] = Number(ctx.redis.ttl(key));
  return {reserved: ctx.redis.zrange('quota:reservations:t1', 0, -1), ttls};
}

export async function check_reserve_atomic(ctx) {
  const m = ctx.load('state');
  ctx.redis.set('quota:limit:t1', 100);
  // A second upload of the same tenant lands while this one is reserving; first, what the reservation left.
  const rival = ctx.redisAfter('quota:used:t1', () => ({seen: snapshot(ctx), theirs: m.openSession('t1', 60, 'image/png', 'b.png')}));
  const mine = await m.openSession('t1', 60, 'image/png', 'a.png');
  const {seen, theirs} = await settled(rival, 'quota:used:t1');
  const opened = [mine, await theirs].filter(u => u !== null);
  assert.equal(opened.length, 1, \`two 60-byte uploads against a 100-byte quota both opened (\${JSON.stringify(opened)}); quota:used:t1 is \${used(ctx)}. The quota check and the INCRBY must be one script\`);
  assert(seen.reserved.length === 1 && Object.keys(seen.ttls).length === 1, \`right after quota:used:t1 grew, the reservations were \${JSON.stringify(seen.reserved)} and the sessions \${JSON.stringify(Object.keys(seen.ttls))}: the reservation and the session are written in the same script as the INCRBY\`);
  assert.equal(used(ctx), 60, 'quota:used:t1 after one 60-byte reservation');
  assert.deepStrictEqual(ctx.redis.zrange('quota:reservations:t1', 0, -1), opened, 'quota:reservations:t1 must hold the one upload that opened');
  assert.equal(await m.openSession('t1', 50, 'image/png', 'c.png'), null, 'a 50-byte upload with 40 bytes of quota left must not open');
  assert(used(ctx) === 60 && ctx.redis.keys('session:*').length === 1, \`a refused upload changed the quota (\${used(ctx)}) or left a session (\${JSON.stringify(ctx.redis.keys('session:*'))})\`);
  assert.notEqual(await m.openSession('t1', 40, 'image/png', 'd.png'), null, 'a 40-byte upload with exactly 40 bytes of quota left must open');
  assert.equal(used(ctx), 100, 'quota:used:t1 after filling the 100-byte quota');
}

export async function check_session_ttl(ctx) {
  const m = ctx.load('state');
  const seen = ctx.redisAfter('quota:used:t1', () => snapshot(ctx).ttls);
  const uploadId = await m.openSession('t1', 10, 'image/png', 'a.png');
  assert(uploadId !== null, 'a 10-byte upload under the default quota must open');
  const atOpen = (await settled(seen, 'quota:used:t1'))[\`session:\${uploadId}\`];
  assert(atOpen !== undefined && atOpen >= 86000 && atOpen <= 86400, \`right after the reservation, session:\${uploadId} had TTL \${atOpen}: the session gets its expiry in the script that opens it, not in a later command\`);
  const ttl = Number(ctx.redis.ttl(\`session:\${uploadId}\`));
  assert(ttl >= 86000 && ttl <= 86400, \`session:\${uploadId} has TTL \${ttl}: an abandoned upload must expire after 86400 seconds, or its reservation is held forever\`);
  ctx.clock.advance(3600);
  assert.equal(await m.ackPart(uploadId, 1, 4), 4, 'acknowledging part 1 (4 bytes) must answer 4');
  const later = Number(ctx.redis.ttl(\`session:\${uploadId}\`));
  assert(later > 0 && later <= 82800, \`an hour after it opened, acknowledging a part left session:\${uploadId} with TTL \${later}: the session expires 86400 seconds after it opens, a part does not extend it\`);
}

export async function check_ack_idempotent(ctx) {
  const m = ctx.load('state');
  const uploadId = await m.openSession('t1', 10, 'image/png', 'a.png');
  assert.equal(await m.ackPart(uploadId, 1, 4), 4, 'acknowledging part 1 (4 bytes) must answer 4');
  const retried = await m.ackPart(uploadId, 1, 4);
  assert.equal(retried, 4, \`a retried part 1 answered \${retried}: the retry was counted again. Count a part only when its field is new\`);
  assert.equal(await m.ackPart(uploadId, 2, 6), 10, 'part 2 (6 bytes) after part 1 must answer 10');
  const session = await m.findSession(uploadId);
  assert(session.actual_bytes === 10 && JSON.stringify(session.parts) === JSON.stringify({1: 4, 2: 6}), \`the session holds \${JSON.stringify(session)}, expected actual_bytes 10 and parts {1: 4, 2: 6}\`);
  assert.equal(await m.ackPart('up-404', 1, 4), -1, 'a part of an upload with no session must answer -1');
  assert.equal(Number(ctx.redis.exists('session:up-404')), 0, 'acknowledging a part of a gone session recreated it without an expiry');
  const late = await m.openSession('t1', 10, 'image/png', 'b.png');
  // The session's 24 hours run out while its part is being acknowledged.
  const expired = ctx.redisAfter(\`session:\${late}\`, () => ctx.redis.del(\`session:\${late}\`));
  const answer = await m.ackPart(late, 1, 4);
  assert(expired.fired, \`ackPart never touched session:\${late}\`);
  assert.equal(Number(ctx.redis.exists(\`session:\${late}\`)), 0, \`session:\${late} expired while part 1 was acknowledged and came back as \${JSON.stringify(ctx.redis.hgetall(\`session:\${late}\`))} with TTL \${ctx.redis.ttl(\`session:\${late}\`)} (ackPart answered \${answer}): the existence check and the count are one script\`);
}

export async function check_sweep_release(ctx) {
  const m = ctx.load('state');
  ctx.redis.set('quota:limit:t1', 1000);
  const gone = await m.openSession('t1', 400, 'image/png', 'a.png');
  const live = await m.openSession('t1', 300, 'image/png', 'b.png');
  ctx.redis.del(\`session:\${gone}\`); // its 24 hours ran out
  assert.equal(await m.sweep('t1'), 400, 'the sweep must release the 400 bytes of the expired upload');
  assert(used(ctx) === 300 && JSON.stringify(ctx.redis.zrange('quota:reservations:t1', 0, -1)) === JSON.stringify([live]), \`after the sweep quota:used:t1 is \${used(ctx)} and the reservations are \${JSON.stringify(ctx.redis.zrange('quota:reservations:t1', 0, -1))}, expected 300 and [\${live}]\`);
  const again = await m.sweep('t1');
  assert(again === 0 && used(ctx) === 300, \`a second sweep released \${again} bytes and left quota:used:t1 at \${used(ctx)}: the expired reservation was released twice\`);
  const late = await m.openSession('t1', 100, 'image/png', 'c.png');
  ctx.redis.del(\`session:\${late}\`);
  // Two sweepers find the same expired upload.
  const rival = ctx.redisAfter(\`session:\${late}\`, () => m.sweep('t1'));
  const mine = await m.sweep('t1');
  const theirs = await settled(rival, \`session:\${late}\`);
  assert(mine + theirs === 100 && used(ctx) === 300, \`two sweepers released \${mine} and \${theirs} bytes of one 100-byte reservation; quota:used:t1 is \${used(ctx)}, expected 300\`);
  const last = await m.openSession('t1', 100, 'image/png', 'd.png');
  ctx.redis.del(\`session:\${last}\`);
  // This time the other sweeper lands right after this one's next command on the reservations, if it has one.
  const outer = ctx.redisAfter(\`session:\${last}\`, () => ctx.redisAfter('quota:reservations:t1', () => m.sweep('t1')));
  const ours = await m.sweep('t1');
  const inner = await settled(outer, \`session:\${last}\`);
  if (inner.error !== undefined) throw inner.error;
  const other = inner.fired ? await inner.result : 0;
  assert(ours + other === 100 && used(ctx) === 300, \`two sweepers released \${ours} and \${other} bytes of one 100-byte reservation; quota:used:t1 is \${used(ctx)}, expected 300. Release only when your own ZREM removed the member\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

var hBg = context.Background()

func hUsed(ctx *harness.Ctx) int64 {
	raw, _ := ctx.Redis.Get("quota:used:t1")
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

func hReservations(ctx *harness.Ctx) []string {
	var members []string
	for _, z := range ctx.Redis.ZRangeWithScores("quota:reservations:t1", 0, -1) {
		members = append(members, z.Member)
	}
	return members
}

// hSessionTTLs is every session key and its TTL at this instant.
func hSessionTTLs(ctx *harness.Ctx) map[string]int64 {
	ttls := map[string]int64{}
	for _, key := range ctx.Redis.Keys("session:*") {
		ttls[key] = ctx.Redis.TTL(key)
	}
	return ttls
}

func hOpen(ctx *harness.Ctx, size int64, name string) string {
	uploadID, err := openSession(hBg, "t1", size, "image/png", name)
	ctx.NoError(err, "openSession(t1, %d) failed", size)
	return uploadID
}

func hAck(ctx *harness.Ctx, uploadID string, n int, size int64) int64 {
	actual, err := ackPart(hBg, uploadID, n, size)
	ctx.NoError(err, "ackPart(%s, %d, %d) failed", uploadID, n, size)
	return actual
}

func hSweep(ctx *harness.Ctx) int64 {
	released, err := sweep(hBg, "t1")
	ctx.NoError(err, "sweep(t1) failed")
	return released
}

func CheckReserveAtomic(ctx *harness.Ctx) {
	ctx.Redis.Set("quota:limit:t1", "100")
	// A second upload of the same tenant lands while this one is reserving; first, what the reservation left.
	var reserved []string
	var sessionsSeen map[string]int64
	rival := ctx.Redis.After("quota:used:t1", func() any {
		reserved, sessionsSeen = hReservations(ctx), hSessionTTLs(ctx)
		uploadID, _ := openSession(hBg, "t1", 60, "image/png", "b.png")
		return uploadID
	})
	mine := hOpen(ctx, 60, "a.png")
	ctx.Assert(rival.Fired, "openSession never touched quota:used:t1")
	ctx.NoError(rival.Err, "the rival upload failed")
	var opened []string
	for _, u := range []string{mine, rival.Result.(string)} {
		if u != "" {
			opened = append(opened, u)
		}
	}
	ctx.Assert(len(opened) == 1, "two 60-byte uploads against a 100-byte quota both opened (%v); quota:used:t1 is %d. The quota check and the INCRBY must be one script", opened, hUsed(ctx))
	ctx.Assert(len(reserved) == 1 && len(sessionsSeen) == 1, "right after quota:used:t1 grew, the reservations were %v and the sessions %v: the reservation and the session are written in the same script as the INCRBY", reserved, sessionsSeen)
	ctx.Equal(hUsed(ctx), int64(60), "quota:used:t1 after one 60-byte reservation")
	ctx.Equal(hReservations(ctx), opened, "quota:reservations:t1 must hold the one upload that opened")
	ctx.Equal(hOpen(ctx, 50, "c.png"), "", "a 50-byte upload with 40 bytes of quota left must not open; its upload id")
	ctx.Assert(hUsed(ctx) == 60 && len(ctx.Redis.Keys("session:*")) == 1, "a refused upload changed the quota (%d) or left a session (%v)", hUsed(ctx), ctx.Redis.Keys("session:*"))
	ctx.Assert(hOpen(ctx, 40, "d.png") != "", "a 40-byte upload with exactly 40 bytes of quota left must open")
	ctx.Equal(hUsed(ctx), int64(100), "quota:used:t1 after filling the 100-byte quota")
}

func CheckSessionTtl(ctx *harness.Ctx) {
	seen := ctx.Redis.After("quota:used:t1", func() any { return hSessionTTLs(ctx) })
	uploadID := hOpen(ctx, 10, "a.png")
	ctx.Assert(uploadID != "", "a 10-byte upload under the default quota must open")
	ctx.Assert(seen.Fired && seen.Err == nil, "openSession never touched quota:used:t1 (%v)", seen.Err)
	atOpen, ok := seen.Result.(map[string]int64)["session:"+uploadID]
	ctx.Assert(ok && atOpen >= 86000 && atOpen <= 86400, "right after the reservation, session:%s had TTL %d (present: %v): the session gets its expiry in the script that opens it, not in a later command", uploadID, atOpen, ok)
	ttl := ctx.Redis.TTL("session:" + uploadID)
	ctx.Assert(ttl >= 86000 && ttl <= 86400, "session:%s has TTL %d: an abandoned upload must expire after 86400 seconds, or its reservation is held forever", uploadID, ttl)
	ctx.Clock.Advance(3600)
	ctx.Equal(hAck(ctx, uploadID, 1, 4), int64(4), "acknowledging part 1 (4 bytes)")
	later := ctx.Redis.TTL("session:" + uploadID)
	ctx.Assert(later > 0 && later <= 82800, "an hour after it opened, acknowledging a part left session:%s with TTL %d: the session expires 86400 seconds after it opens, a part does not extend it", uploadID, later)
}

func CheckAckIdempotent(ctx *harness.Ctx) {
	uploadID := hOpen(ctx, 10, "a.png")
	ctx.Equal(hAck(ctx, uploadID, 1, 4), int64(4), "acknowledging part 1 (4 bytes)")
	ctx.Equal(hAck(ctx, uploadID, 1, 4), int64(4), "a retried part 1 must not be counted again (count a part only when its field is new); actual bytes")
	ctx.Equal(hAck(ctx, uploadID, 2, 6), int64(10), "part 2 (6 bytes) after part 1; actual bytes")
	s, err := findSession(hBg, uploadID)
	ctx.NoError(err, "findSession failed")
	ctx.Assert(s != nil && s.ActualBytes == 10 && len(s.Parts) == 2 && s.Parts[1] == 4 && s.Parts[2] == 6, "the session holds %+v, expected actual bytes 10 and parts {1: 4, 2: 6}", s)
	ctx.Equal(hAck(ctx, "up-404", 1, 4), int64(-1), "a part of an upload with no session")
	ctx.Equal(ctx.Redis.Exists("session:up-404"), int64(0), "acknowledging a part of a gone session must not recreate it; session:up-404 exists")
	late := hOpen(ctx, 10, "b.png")
	// The session's 24 hours run out while its part is being acknowledged.
	expired := ctx.Redis.After("session:"+late, func() any { return ctx.Redis.Del("session:" + late) })
	answer, _ := ackPart(hBg, late, 1, 4)
	ctx.Assert(expired.Fired, "ackPart never touched session:%s", late)
	ctx.Assert(ctx.Redis.Exists("session:"+late) == 0, "session:%s expired while part 1 was acknowledged and came back as %v with TTL %d (ackPart answered %d): the existence check and the count are one script", late, ctx.Redis.HGetAll("session:"+late), ctx.Redis.TTL("session:"+late), answer)
}

func CheckSweepRelease(ctx *harness.Ctx) {
	ctx.Redis.Set("quota:limit:t1", "1000")
	gone := hOpen(ctx, 400, "a.png")
	live := hOpen(ctx, 300, "b.png")
	ctx.Redis.Del("session:" + gone) // its 24 hours ran out
	ctx.Equal(hSweep(ctx), int64(400), "the sweep must release the 400 bytes of the expired upload; released")
	ctx.Equal(hUsed(ctx), int64(300), "quota:used:t1 after the sweep")
	ctx.Equal(hReservations(ctx), []string{live}, "the reservations after the sweep")
	again := hSweep(ctx)
	ctx.Assert(again == 0 && hUsed(ctx) == 300, "a second sweep released %d bytes and left quota:used:t1 at %d: the expired reservation was released twice", again, hUsed(ctx))
	late := hOpen(ctx, 100, "c.png")
	ctx.Redis.Del("session:" + late)
	// Two sweepers find the same expired upload.
	rival := ctx.Redis.After("session:"+late, func() any {
		released, _ := sweep(hBg, "t1")
		return released
	})
	mine := hSweep(ctx)
	ctx.Assert(rival.Fired, "the sweep never looked at session:%s", late)
	theirs := rival.Result.(int64)
	ctx.Assert(mine+theirs == 100 && hUsed(ctx) == 300, "two sweepers released %d and %d bytes of one 100-byte reservation; quota:used:t1 is %d, expected 300", mine, theirs, hUsed(ctx))
	last := hOpen(ctx, 100, "d.png")
	ctx.Redis.Del("session:" + last)
	// This time the other sweeper lands right after this one's next command on the reservations, if it has one.
	var other int64
	outer := ctx.Redis.After("session:"+last, func() any {
		ctx.Redis.After("quota:reservations:t1", func() any {
			other, _ = sweep(hBg, "t1")
			return other
		})
		return nil
	})
	ours := hSweep(ctx)
	ctx.Assert(outer.Fired && outer.Err == nil, "the sweep never looked at session:%s (%v)", last, outer.Err)
	ctx.Assert(ours+other == 100 && hUsed(ctx) == 300, "two sweepers released %d and %d bytes of one 100-byte reservation; quota:used:t1 is %d, expected 300. Release only when your own ZREM removed the member", ours, other, hUsed(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace {

long long hUsed(harness::Ctx& ctx) { return std::stoll(ctx.Redis.Get("quota:used:t1").value_or("0")); }

std::vector<std::string> hReservations(harness::Ctx& ctx) {
  std::vector<std::string> members;
  for (const auto& z : ctx.Redis.ZRangeWithScores("quota:reservations:t1", 0, -1)) members.push_back(z.Member);
  return members;
}

// Every session key and its TTL at this instant.
std::map<std::string, long long> hSessionTtls(harness::Ctx& ctx) {
  std::map<std::string, long long> ttls;
  for (const std::string& key : ctx.Redis.Keys("session:*")) ttls[key] = ctx.Redis.TTL(key);
  return ttls;
}

std::string hOpen(long long size, const std::string& name) { return openSession("t1", size, "image/png", name).value_or(""); }

}  // namespace

void CheckReserveAtomic(harness::Ctx& ctx) {
  ctx.Redis.Set("quota:limit:t1", "100");
  // A second upload of the same tenant lands while this one is reserving; first, what the reservation left.
  bool fired = false;
  std::string theirs;
  std::vector<std::string> reserved;
  std::map<std::string, long long> sessions_seen;
  ctx.Redis.After("quota:used:t1", [&] {
    fired = true;
    reserved = hReservations(ctx);
    sessions_seen = hSessionTtls(ctx);
    theirs = hOpen(60, "b.png");
  });
  const std::string mine = hOpen(60, "a.png");
  ctx.Assert(fired, "openSession never touched quota:used:t1");
  std::vector<std::string> opened;
  for (const std::string& u : {mine, theirs}) {
    if (!u.empty()) opened.push_back(u);
  }
  ctx.Assert(opened.size() == 1, "two 60-byte uploads against a 100-byte quota both opened (%v); quota:used:t1 is %d. The quota check and the INCRBY must be one script", opened, hUsed(ctx));
  ctx.Assert(reserved.size() == 1 && sessions_seen.size() == 1, "right after quota:used:t1 grew, the reservations were %v and %d sessions existed: the reservation and the session are written in the same script as the INCRBY", reserved, sessions_seen.size());
  ctx.Equal(hUsed(ctx), 60, "quota:used:t1 after one 60-byte reservation");
  ctx.Equal(hReservations(ctx), opened, "quota:reservations:t1 must hold the one upload that opened");
  ctx.Equal(hOpen(50, "c.png"), "", "a 50-byte upload with 40 bytes of quota left must not open; its upload id");
  ctx.Assert(hUsed(ctx) == 60 && ctx.Redis.Keys("session:*").size() == 1, "a refused upload changed the quota (%d) or left a session (%v)", hUsed(ctx), ctx.Redis.Keys("session:*"));
  ctx.Assert(!hOpen(40, "d.png").empty(), "a 40-byte upload with exactly 40 bytes of quota left must open");
  ctx.Equal(hUsed(ctx), 100, "quota:used:t1 after filling the 100-byte quota");
}

void CheckSessionTtl(harness::Ctx& ctx) {
  bool fired = false;
  std::map<std::string, long long> seen;
  ctx.Redis.After("quota:used:t1", [&] {
    fired = true;
    seen = hSessionTtls(ctx);
  });
  const std::string upload_id = hOpen(10, "a.png");
  ctx.Assert(!upload_id.empty(), "a 10-byte upload under the default quota must open");
  ctx.Assert(fired, "openSession never touched quota:used:t1");
  const long long at_open = seen.count("session:" + upload_id) ? seen.at("session:" + upload_id) : -2;
  ctx.Assert(at_open >= 86000 && at_open <= 86400, "right after the reservation, session:%s had TTL %d (-2: not written yet): the session gets its expiry in the script that opens it, not in a later command", upload_id, at_open);
  const long long ttl = ctx.Redis.TTL("session:" + upload_id);
  ctx.Assert(ttl >= 86000 && ttl <= 86400, "session:%s has TTL %d: an abandoned upload must expire after 86400 seconds, or its reservation is held forever", upload_id, ttl);
  ctx.Clock.Advance(3600);
  ctx.Equal(ackPart(upload_id, 1, 4), 4, "acknowledging part 1 (4 bytes)");
  const long long later = ctx.Redis.TTL("session:" + upload_id);
  ctx.Assert(later > 0 && later <= 82800, "an hour after it opened, acknowledging a part left session:%s with TTL %d: the session expires 86400 seconds after it opens, a part does not extend it", upload_id, later);
}

void CheckAckIdempotent(harness::Ctx& ctx) {
  const std::string upload_id = hOpen(10, "a.png");
  ctx.Equal(ackPart(upload_id, 1, 4), 4, "acknowledging part 1 (4 bytes)");
  ctx.Equal(ackPart(upload_id, 1, 4), 4, "a retried part 1 must not be counted again (count a part only when its field is new); actual bytes");
  ctx.Equal(ackPart(upload_id, 2, 6), 10, "part 2 (6 bytes) after part 1; actual bytes");
  const auto s = findSession(upload_id);
  ctx.Assert(s && s->actual_bytes == 10 && s->parts.size() == 2 && s->parts.at(1) == 4 && s->parts.at(2) == 6, "the session holds actual bytes %d and %d parts, expected 10 and parts {1: 4, 2: 6}", s ? s->actual_bytes : -1, s ? s->parts.size() : 0);
  ctx.Equal(ackPart("up-404", 1, 4), -1, "a part of an upload with no session");
  ctx.Equal(ctx.Redis.Exists("session:up-404"), 0, "acknowledging a part of a gone session must not recreate it; session:up-404 exists");
  const std::string late = hOpen(10, "b.png");
  // The session's 24 hours run out while its part is being acknowledged.
  bool expired = false;
  ctx.Redis.After("session:" + late, [&] {
    expired = true;
    ctx.Redis.Del("session:" + late);
  });
  const long long answer = ackPart(late, 1, 4);
  ctx.Assert(expired, "ackPart never touched session:%s", late);
  ctx.Assert(ctx.Redis.Exists("session:" + late) == 0, "session:%s expired while part 1 was acknowledged and came back with %d fields and TTL %d (ackPart answered %d): the existence check and the count are one script", late, ctx.Redis.HGetAll("session:" + late).size(), ctx.Redis.TTL("session:" + late), answer);
}

void CheckSweepRelease(harness::Ctx& ctx) {
  ctx.Redis.Set("quota:limit:t1", "1000");
  const std::string gone = hOpen(400, "a.png");
  const std::string live = hOpen(300, "b.png");
  ctx.Redis.Del("session:" + gone);  // its 24 hours ran out
  ctx.Equal(sweep("t1"), 400, "the sweep must release the 400 bytes of the expired upload; released");
  ctx.Equal(hUsed(ctx), 300, "quota:used:t1 after the sweep");
  ctx.Equal(hReservations(ctx), {live}, "the reservations after the sweep");
  const long long again = sweep("t1");
  ctx.Assert(again == 0 && hUsed(ctx) == 300, "a second sweep released %d bytes and left quota:used:t1 at %d: the expired reservation was released twice", again, hUsed(ctx));
  const std::string late = hOpen(100, "c.png");
  ctx.Redis.Del("session:" + late);
  // Two sweepers find the same expired upload.
  bool fired = false;
  long long theirs = 0;
  ctx.Redis.After("session:" + late, [&] {
    fired = true;
    theirs = sweep("t1");
  });
  const long long mine = sweep("t1");
  ctx.Assert(fired, "the sweep never looked at session:%s", late);
  ctx.Assert(mine + theirs == 100 && hUsed(ctx) == 300, "two sweepers released %d and %d bytes of one 100-byte reservation; quota:used:t1 is %d, expected 300", mine, theirs, hUsed(ctx));
  const std::string last = hOpen(100, "d.png");
  ctx.Redis.Del("session:" + last);
  // This time the other sweeper lands right after this one's next command on the reservations, if it has one.
  bool looked = false;
  long long other = 0;
  ctx.Redis.After("session:" + last, [&] {
    looked = true;
    ctx.Redis.After("quota:reservations:t1", [&] { other = sweep("t1"); });
  });
  const long long ours = sweep("t1");
  ctx.Assert(looked, "the sweep never looked at session:%s", last);
  ctx.Assert(ours + other == 100 && hUsed(ctx) == 300, "two sweepers released %d and %d bytes of one 100-byte reservation; quota:used:t1 is %d, expected 300. Release only when your own ZREM removed the member", ours, other, hUsed(ctx));
}
`,
  },
  hints: [
    'Open two 60-byte uploads at once against a 100-byte quota: both get an upload id. Retry a part: the session says the upload is larger than what was sent, and an abandoned upload never gives its bytes back.',
    'The quota is read, compared in the application and incremented in three round trips, so another upload fits in between. Nothing sets an expiry, the ack adds the size whether or not the part was new, and the sweep never removes what it released.',
    'Move the check, `INCRBY`, `ZADD`, `HSET` and `EXPIRE` into `OPEN_LUA`; in `ACK_LUA`, `HINCRBY` only when `HSETNX` returned 1; in `sweep`, `DECRBY` only when `ZREM` returned 1.',
  ],
  debrief: `A reservation is a promise against a shared budget, so the read of the budget and the write of the promise have to be one step: a Lua script is the smallest transaction Redis offers that can branch on what it read. The expiry is what turns an abandoned upload into something the sweep can see, and gating the release on its own \`ZREM\` makes the sweep safe to run on every replica at once. Counting a part on \`HSETNX\` makes the client's retry free, which is the whole point of a part. A production quota service would also reconcile \`quota:used\` against the file index on a schedule, since any counter kept beside the data drifts eventually.`,
};
