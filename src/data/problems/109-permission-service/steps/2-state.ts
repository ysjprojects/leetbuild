import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  concept: 'redis',
  file: 'state',
  title: 'Redis permission cache invalidated by version bump',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it caches the effective
permission set per \`(subject, scope)\` in Redis, serves it for 300 s, and clears the entry on every
assignment change, so the demo — assign, then read — always shows the new set. It compiles, it
serves the happy path, and it hides the flaw that makes a revocation unreliable. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement the effective-permission cache behind every read:

- The cache key is \`perm:{subject}:{scope}\`; the entry holds the permission set and a TTL of
  **300 s**. The TTL bounds memory only — it is never the invalidation mechanism.
- One global counter \`perm:grant_version\` is the invalidation clock. Every assignment change bumps
  it with an atomic **\`INCR\`** *after* the grant store records the change and *before* the
  response is acked, so the bump is durable by the time the caller sees \`200\`.
- A read loads the current version first, then the entry, and serves the entry only while the
  entry's stamped version equals the version it just read; a mismatch recomputes instead of serving.
- The recompute is **single-flight** behind a short-lived \`SET NX\` lock at
  \`perm:lock:{subject}:{scope}\` with a **2000 ms** TTL, so concurrent misses cannot stampede the
  policy engine and none of them can stamp the entry from a snapshot taken before the last change.
- The freshly derived entry is written with the current version stamp and the 300 s TTL, so a
  revocation is visible to a reader holding an old entry **within one second** — neither the lock
  nor the TTL may override the counter.

**Failure mode the checks target.** Delete-after-write invalidation looks correct in a demo and is
wrong under load: a read that lands between the \`DEL\` and the re-derive repopulates the pre-change
set, so a revoked contractor keeps access for the rest of the TTL. Deleting the key is not the
mechanism — bumping the shared counter is.`,
  sequence: {
    participants: ['Permission Service', 'Redis', 'Grant store', 'Policy engine'],
    messages: [
      {from: 'Permission Service', to: 'Redis', label: 'GET perm:grant_version', kind: 'sync'},
      {from: 'Redis', to: 'Permission Service', label: '4', kind: 'reply'},
      {from: 'Permission Service', to: 'Redis', label: 'HGETALL perm:user:ada:team:eng', kind: 'sync'},
      {from: 'Redis', to: 'Permission Service', label: '{perms, version=3} / (nil)', kind: 'reply'},
      {from: 'Permission Service', to: 'Permission Service', label: 'stamp 3 ≠ current 4 → recompute', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'SET NX perm:lock:user:ada:team:eng · px 2000',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Permission Service', label: 'OK — one rebuild', kind: 'reply'},
      {from: 'Permission Service', to: 'Policy engine', label: 'derive the effective permission set', kind: 'sync'},
      {from: 'Policy engine', to: 'Permission Service', label: 'CheckReply{permissions}', kind: 'reply'},
      {from: 'Permission Service', to: 'Redis', label: 'HSET {perms, version=4} · EXPIRE 300', kind: 'async'},
      {from: 'Permission Service', to: 'Grant store', label: 'record_change(subject, scope)', kind: 'async'},
      {from: 'Permission Service', to: 'Redis', label: 'INCR perm:grant_version → 5', kind: 'async'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'ack only after the bump: every entry stamped before it is now stale',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'A TTL bounds memory, not truth: an entry written before a revocation is still a perfectly valid entry until it expires. Something per-write has to let a read tell "derived before the change" from "derived after", and it has to be cheap enough to check on every single read.',
    'That something is a counter: entries carry the counter value they were derived at, and the read compares it with the current counter before trusting the entry. The mutation path increments the counter *after* the grant is recorded and *before* it acks, so the very next read already sees a mismatch and cannot serve a pre-change entry.',
    'Recomputing on every mismatch is a stampede: concurrent misses all rebuild, and the slowest one can write an older snapshot over a newer one. The rebuild runs under a short-lived `SET NX` lock, so only the holder derives and the others read what it wrote; the lock may lapse, because the entry it produces — not the lock — is the durable result.',
  ],
  checks: [
    {
      id: 'version-stamp',
      title: 'Cache entries carry the grant version',
      detail:
        'Every cached entry is stamped with the value of the global `grant_version` counter at write time. The draft stores the set under a TTL and no version, so a reader cannot tell a fresh entry from one written before the last revocation.',
      match: {
        python: {all: [/GRANT_VERSION_KEY/, /CACHE_VERSION_FIELD/]},
        typescript: {all: [/GRANT_VERSION_KEY/, /CACHE_VERSION_FIELD/]},
        go: {all: [/grantVersionKey/, /cacheVersionField/]},
        scala: {all: [/GrantVersionKey/, /CacheVersionField/]},
        cpp: {all: [/kGrantVersionKey/, /kCacheVersionField/]},
      },
    },
    {
      id: 'version-mismatch',
      title: 'A version mismatch forces recomputation',
      detail:
        'The read compares the stamped version with the current `grant_version` and recomputes when they differ instead of serving the entry; a TTL alone cannot make a revocation immediate.',
      match: {
        python: {all: [/CACHE_VERSION_FIELD/, /cache_is_current\(/]},
        typescript: {all: [/CACHE_VERSION_FIELD/, /cacheIsCurrent\(/]},
        go: {all: [/cacheVersionField/, /cacheIsCurrent\(/]},
        scala: {all: [/CacheVersionField/, /cacheIsCurrent\(/]},
        cpp: {all: [/kCacheVersionField/, /cacheIsCurrent\(/]},
      },
    },
    {
      id: 'bump-not-delete',
      title: 'Invalidates by bumping the counter, never by deleting keys',
      detail:
        'Every assignment change bumps the shared counter with an atomic `INCR`, so an old entry dies the moment the bump lands. Deleting keys is not the mechanism: a concurrent read between the delete and the re-derive repopulates the pre-change set.',
      match: {
        python: {all: [/def bump_version\(/, /\.incr\(/], none: [/redis\.delete\(/]},
        typescript: {all: [/function bumpVersion\(/, /\.incr\(/], none: [/redis\.del\(/]},
        go: {all: [/func bumpVersion\(/, /\.Incr\(/], none: [/\.Del\(/]},
        scala: {all: [/def bumpVersion\(/, /\.incr\(/], none: [/\.del\(/]},
        cpp: {all: [/bumpVersion\(/, /\.incr\(|->incr\(/], none: [/\.del\(|->del\(/]},
      },
    },
    {
      id: 'single-flight',
      title: 'Collapses concurrent misses behind one recompute',
      detail:
        'A miss recomputes under a short-lived `SET NX` lock, so two concurrent misses cannot both rebuild and neither can repopulate the entry from a stale snapshot.',
      match: {
        python: {all: [/LOCK_KEY_PREFIX/, /nx=True|\.lock\(/]},
        typescript: {all: [/LOCK_KEY_PREFIX/, /'NX'|"NX"/]},
        go: {all: [/lockKeyPrefix/, /SetNX\(/]},
        scala: {all: [/LockKeyPrefix/, /nx\(\)/]},
        cpp: {all: [/kLockKeyPrefix/, /NOT_EXIST/]},
      },
    },
    {
      id: 'bump-after-commit',
      title: 'Bumps the version after the grant commits and before the ack',
      detail:
        'The bump happens after the grant store records the change and before the response is acked, so no read can serve an entry older than the bump. The draft never bumps at all.',
      match: {
        python: {order: [/store\.record_change\(/, /\.incr\(/]},
        typescript: {order: [/store\.recordChange\(/, /\.incr\(/]},
        go: {order: [/store\.RecordChange\(/, /\.Incr\(/]},
        scala: {order: [/store\.recordChange\(/, /\.incr\(/]},
        cpp: {order: [/store\.recordChange\(/, /\.incr\(|->incr\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Effective-permission cache: a model-generated draft that deletes the key on every change."""
import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis import Redis

app = FastAPI()
logger = logging.getLogger("permissions")

redis = Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 300


class GrantStore:
    def effective(self, subject: str, scope: str) -> set[str]:
        """Derive the effective permission set from the grants and the role catalog."""
        raise NotImplementedError

    def put(self, subject: str, scope: str, role: str) -> None:
        """Persist an assignment."""
        raise NotImplementedError


store = GrantStore()


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


def cache_key(subject: str, scope: str) -> str:
    return f"perm:{subject}:{scope}"


def effective_permissions(subject: str, scope: str) -> set[str]:
    key = cache_key(subject, scope)
    entry = redis.hgetall(key)
    if entry:
        return set(filter(None, entry.get("perms", "").split(",")))
    perms = store.effective(subject, scope)
    redis.hset(key, "perms", ",".join(sorted(perms)))
    redis.expire(key, CACHE_TTL_S)
    return perms


@app.get("/v1/users/{subject}/permissions")
def get_permissions(subject: str, scope: str = "org") -> JSONResponse:
    perms = effective_permissions(subject, scope)
    return JSONResponse({"subject": subject, "scope": scope, "permissions": sorted(perms)})


@app.post("/v1/roles/assignments")
def assign(body: Assignment) -> JSONResponse:
    # TODO: this draft invalidates by deleting the cached key after the write and leans on the
    # 300 s TTL. A read that slips in between the write and the re-derive repopulates the old set,
    # so a revoked permission survives. There is no version stamp, no counter and no lock either.
    store.put(body.subject, body.scope, body.role)
    redis.delete(cache_key(body.subject, body.scope))
    logger.info("assigned subject=%s role=%s scope=%s", body.subject, body.role, body.scope)
    return JSONResponse({"subject": body.subject, "role": body.role, "scope": body.scope}, status_code=200)
`,
      solution: `"""Effective-permission cache: version-stamped entries invalidated by bumping a global counter."""
import logging
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis import Redis

app = FastAPI()
logger = logging.getLogger("permissions")

redis = Redis(host="redis", port=6379, decode_responses=True)

GRANT_VERSION_KEY = "perm:grant_version"
CACHE_VERSION_FIELD = "version"
CACHE_PERMS_FIELD = "perms"
CACHE_TTL_S = 300
LOCK_KEY_PREFIX = "perm:lock:"
LOCK_TTL_MS = 2000

# Compare-and-delete: a slow worker must not release the lock a younger worker now owns.
RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end"


class GrantStore:
    def effective(self, subject: str, scope: str) -> set[str]:
        """Derive the effective permission set from the grants and the role catalog."""
        raise NotImplementedError

    def record_change(self, subject: str, scope: str) -> None:
        """Persist the assignment change before anything derived from it becomes visible."""
        raise NotImplementedError


store = GrantStore()


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


def cache_key(subject: str, scope: str) -> str:
    return f"perm:{subject}:{scope}"


def lock_key(subject: str, scope: str) -> str:
    return f"{LOCK_KEY_PREFIX}{subject}:{scope}"


def current_version() -> int:
    return int(redis.get(GRANT_VERSION_KEY) or 0)


def cache_is_current(entry: dict[str, str], version: int) -> bool:
    """An entry is trustworthy only while its stamp equals the counter read this request."""
    return entry.get(CACHE_VERSION_FIELD) == str(version)


def recompute_effective(subject: str, scope: str, version: int) -> set[str]:
    key = cache_key(subject, scope)
    lock = lock_key(subject, scope)
    token = uuid4().hex
    if redis.set(lock, token, nx=True, px=LOCK_TTL_MS):
        try:
            perms = store.effective(subject, scope)
            pipe = redis.pipeline()
            pipe.hset(key, mapping={CACHE_PERMS_FIELD: ",".join(sorted(perms)), CACHE_VERSION_FIELD: str(version)})
            pipe.expire(key, CACHE_TTL_S)
            pipe.execute()
            return perms
        finally:
            redis.eval(RELEASE_LOCK_LUA, 1, lock, token)
    # Another worker holds the lock: serve what it wrote, and derive locally only if it has not
    # finished — the 2000 ms lock TTL bounds that wait.
    entry = redis.hgetall(key)
    if entry and cache_is_current(entry, version):
        return set(filter(None, entry[CACHE_PERMS_FIELD].split(",")))
    return store.effective(subject, scope)


def effective_permissions(subject: str, scope: str) -> set[str]:
    version = current_version()
    entry = redis.hgetall(cache_key(subject, scope))
    if entry and cache_is_current(entry, version):
        return set(filter(None, entry[CACHE_PERMS_FIELD].split(",")))
    return recompute_effective(subject, scope, version)


@app.get("/v1/users/{subject}/permissions")
def get_permissions(subject: str, scope: str = "org") -> JSONResponse:
    perms = effective_permissions(subject, scope)
    return JSONResponse({"subject": subject, "scope": scope, "permissions": sorted(perms)})


@app.post("/v1/roles/assignments")
def assign(body: Assignment) -> JSONResponse:
    # The grant is durable first; only then does the clock move, so a read that raced the
    # assignment either served the old version (and recomputed) or the new one.
    store.record_change(body.subject, body.scope)
    bump_version()
    logger.info("assigned subject=%s role=%s scope=%s", body.subject, body.role, body.scope)
    return JSONResponse({"subject": body.subject, "role": body.role, "scope": body.scope}, status_code=200)


def bump_version() -> int:
    """Move the invalidation clock: every entry stamped before this read is now stale."""
    return int(redis.incr(GRANT_VERSION_KEY))
`,
    },
    typescript: {
      starter: `/** Effective-permission cache: a model-generated draft that deletes the key on every change. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://redis:6379');

const CACHE_TTL_S = 300;

export interface GrantStore {
  effective(subject: string, scope: string): Promise<string[]>;
  put(subject: string, scope: string, role: string): Promise<void>;
}

export const store: GrantStore = {
  async effective() {
    throw new Error('not wired');
  },
  async put() {
    throw new Error('not wired');
  },
};

const cacheKey = (subject: string, scope: string): string => \`perm:\${subject}:\${scope}\`;

async function effectivePermissions(subject: string, scope: string): Promise<string[]> {
  const key = cacheKey(subject, scope);
  const entry = await redis.hgetall(key);
  if (Object.keys(entry).length > 0) return entry.perms.split(',').filter(Boolean);
  const perms = await store.effective(subject, scope);
  await redis.hset(key, 'perms', perms.join(','));
  await redis.expire(key, CACHE_TTL_S);
  return perms;
}

app.get('/v1/users/:subject/permissions', async (request, reply) => {
  const {subject} = request.params as {subject: string};
  const scope = (request.query as {scope?: string}).scope ?? 'org';
  return reply.code(200).send({subject, scope, permissions: await effectivePermissions(subject, scope)});
});

app.post('/v1/roles/assignments', async (request, reply) => {
  // TODO: this draft invalidates by deleting the cached key after the write and leans on the 300 s
  // TTL. A read that slips in between the write and the re-derive repopulates the old set, so a
  // revoked permission survives. There is no version stamp, no counter and no lock either.
  const body = request.body as {subject: string; role: string; scope: string};
  await store.put(body.subject, body.scope, body.role);
  await redis.del(cacheKey(body.subject, body.scope));
  request.log.info({subject: body.subject, role: body.role, scope: body.scope}, 'assigned');
  return reply.code(200).send({subject: body.subject, role: body.role, scope: body.scope});
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
      solution: `/** Effective-permission cache: version-stamped entries invalidated by bumping a global counter. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://redis:6379');

const GRANT_VERSION_KEY = 'perm:grant_version';
const CACHE_VERSION_FIELD = 'version';
const CACHE_PERMS_FIELD = 'perms';
const CACHE_TTL_S = 300;
const LOCK_KEY_PREFIX = 'perm:lock:';
const LOCK_TTL_MS = 2000;

// Compare-and-delete: a slow worker must not release the lock a younger worker now owns.
const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end";

export interface GrantStore {
  effective(subject: string, scope: string): Promise<string[]>;
  recordChange(subject: string, scope: string): Promise<void>;
}

export const store: GrantStore = {
  async effective() {
    throw new Error('not wired');
  },
  async recordChange() {
    throw new Error('not wired');
  },
};

const cacheKey = (subject: string, scope: string): string => \`perm:\${subject}:\${scope}\`;
const lockKey = (subject: string, scope: string): string => \`\${LOCK_KEY_PREFIX}\${subject}:\${scope}\`;

const currentVersion = async (): Promise<number> => Number((await redis.get(GRANT_VERSION_KEY)) ?? 0);

/** An entry is trustworthy only while its stamp equals the counter read this request. */
function cacheIsCurrent(entry: Record<string, string>, version: number): boolean {
  return entry[CACHE_VERSION_FIELD] === String(version);
}

async function recomputeEffective(subject: string, scope: string, version: number): Promise<string[]> {
  const key = cacheKey(subject, scope);
  const lock = lockKey(subject, scope);
  const token = randomUUID();
  if ((await redis.set(lock, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') {
    try {
      const perms = await store.effective(subject, scope);
      await redis
        .multi()
        .hset(key, CACHE_PERMS_FIELD, perms.join(','), CACHE_VERSION_FIELD, String(version))
        .expire(key, CACHE_TTL_S)
        .exec();
      return perms;
    } finally {
      await redis.eval(RELEASE_LOCK_LUA, 1, lock, token);
    }
  }
  const entry = await redis.hgetall(key);
  if (Object.keys(entry).length > 0 && cacheIsCurrent(entry, version))
    return entry[CACHE_PERMS_FIELD].split(',').filter(Boolean);
  return store.effective(subject, scope);
}

async function effectivePermissions(subject: string, scope: string): Promise<string[]> {
  const version = await currentVersion();
  const entry = await redis.hgetall(cacheKey(subject, scope));
  if (Object.keys(entry).length > 0 && cacheIsCurrent(entry, version))
    return entry[CACHE_PERMS_FIELD].split(',').filter(Boolean);
  return recomputeEffective(subject, scope, version);
}

app.get('/v1/users/:subject/permissions', async (request, reply) => {
  const {subject} = request.params as {subject: string};
  const scope = (request.query as {scope?: string}).scope ?? 'org';
  return reply.code(200).send({subject, scope, permissions: await effectivePermissions(subject, scope)});
});

app.post('/v1/roles/assignments', async (request, reply) => {
  const body = request.body as {subject: string; role: string; scope: string};
  // The grant is durable first; only then does the clock move, and only then is the call acked.
  await store.recordChange(body.subject, body.scope);
  await bumpVersion();
  request.log.info({subject: body.subject, role: body.role, scope: body.scope}, 'assigned');
  return reply.code(200).send({subject: body.subject, role: body.role, scope: body.scope});
});

/** Move the invalidation clock: every entry stamped before this call is now stale. */
async function bumpVersion(): Promise<number> {
  return await redis.incr(GRANT_VERSION_KEY);
}
`,
    },
    go: {
      starter: `// Effective-permission cache: a model-generated draft that deletes the key on every change.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const cacheTTL = 300 * time.Second

type GrantStore struct{}

func (s *GrantStore) Effective(ctx context.Context, subject, scope string) ([]string, error) {
	return nil, nil
}

func (s *GrantStore) Put(ctx context.Context, subject, scope, role string) error { return nil }

var store = &GrantStore{}

type AssignmentRequest struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

func cacheKey(subject, scope string) string { return "perm:" + subject + ":" + scope }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func effectivePermissions(ctx context.Context, subject, scope string) ([]string, error) {
	key := cacheKey(subject, scope)
	entry, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(entry) > 0 {
		return strings.Split(entry["perms"], ","), nil
	}
	perms, err := store.Effective(ctx, subject, scope)
	if err != nil {
		return nil, err
	}
	rdb.HSet(ctx, key, "perms", strings.Join(perms, ","))
	rdb.Expire(ctx, key, cacheTTL)
	return perms, nil
}

func getPermissions(rw http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "org"
	}
	perms, err := effectivePermissions(r.Context(), r.PathValue("subject"), scope)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"subject": r.PathValue("subject"), "scope": scope, "permissions": perms})
}

func assign(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft invalidates by deleting the cached key after the write and leans on the
	// 300 s TTL. A read that slips in between the write and the re-derive repopulates the old set,
	// so a revoked permission survives. There is no version stamp, no counter and no lock either.
	var body AssignmentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	_ = store.Put(r.Context(), body.Subject, body.Scope, body.Role)
	rdb.Del(r.Context(), cacheKey(body.Subject, body.Scope))
	log.Printf("assigned subject=%s role=%s scope=%s", body.Subject, body.Role, body.Scope)
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{subject}/permissions", getPermissions)
	mux.HandleFunc("POST /v1/roles/assignments", assign)
	log.Fatal(http.ListenAndServe(":8444", mux))
}
`,
      solution: `// Effective-permission cache: version-stamped entries invalidated by bumping a global counter.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	grantVersionKey   = "perm:grant_version"
	cacheVersionField = "version"
	cachePermsField   = "perms"
	cacheTTL          = 300 * time.Second
	lockKeyPrefix     = "perm:lock:"
	lockTTL           = 2 * time.Second
)

// Compare-and-delete: a slow worker must not release the lock a younger worker now owns.
const releaseLockLua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end"

type GrantStore struct{}

func (s *GrantStore) Effective(ctx context.Context, subject, scope string) ([]string, error) {
	return nil, nil
}

func (s *GrantStore) RecordChange(ctx context.Context, subject, scope, role string) error { return nil }

var store = &GrantStore{}

type AssignmentRequest struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

func cacheKey(subject, scope string) string { return "perm:" + subject + ":" + scope }

func lockKey(subject, scope string) string { return lockKeyPrefix + subject + ":" + scope }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func currentVersion(ctx context.Context) int64 {
	value, err := rdb.Get(ctx, grantVersionKey).Int64()
	if err != nil {
		return 0
	}
	return value
}

// cacheIsCurrent reports whether entry was stamped with the counter read this request.
func cacheIsCurrent(entry map[string]string, version int64) bool {
	stamped, err := strconv.ParseInt(entry[cacheVersionField], 10, 64)
	return err == nil && stamped == version
}

func recomputeEffective(ctx context.Context, subject, scope string, version int64) ([]string, error) {
	key, lock := cacheKey(subject, scope), lockKey(subject, scope)
	token := uuid.NewString()
	acquired, err := rdb.SetNX(ctx, lock, token, lockTTL).Result()
	if err != nil {
		return nil, err
	}
	if acquired {
		defer func() { _ = rdb.Eval(ctx, releaseLockLua, []string{lock}, token) }()
		perms, err := store.Effective(ctx, subject, scope)
		if err != nil {
			return nil, err
		}
		pipe := rdb.TxPipeline()
		pipe.HSet(ctx, key, cachePermsField, strings.Join(perms, ","), cacheVersionField, strconv.FormatInt(version, 10))
		pipe.Expire(ctx, key, cacheTTL)
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
		return perms, nil
	}
	entry, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(entry) > 0 && cacheIsCurrent(entry, version) {
		return strings.Split(entry[cachePermsField], ","), nil
	}
	return store.Effective(ctx, subject, scope)
}

func effectivePermissions(ctx context.Context, subject, scope string) ([]string, error) {
	version := currentVersion(ctx)
	entry, err := rdb.HGetAll(ctx, cacheKey(subject, scope)).Result()
	if err != nil {
		return nil, err
	}
	if len(entry) > 0 && cacheIsCurrent(entry, version) {
		return strings.Split(entry[cachePermsField], ","), nil
	}
	return recomputeEffective(ctx, subject, scope, version)
}

func getPermissions(rw http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "org"
	}
	perms, err := effectivePermissions(r.Context(), r.PathValue("subject"), scope)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"subject": r.PathValue("subject"), "scope": scope, "permissions": perms})
}

func assign(rw http.ResponseWriter, r *http.Request) {
	var body AssignmentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// The grant is durable first; only then does the clock move, and only then is the call acked.
	if err := store.RecordChange(r.Context(), body.Subject, body.Scope, body.Role); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	bumpVersion(r.Context())
	log.Printf("assigned subject=%s role=%s scope=%s", body.Subject, body.Role, body.Scope)
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{subject}/permissions", getPermissions)
	mux.HandleFunc("POST /v1/roles/assignments", assign)
	log.Fatal(http.ListenAndServe(":8444", mux))
}

// bumpVersion moves the invalidation clock: every entry stamped before this call is now stale.
func bumpVersion(ctx context.Context) int64 {
	version, err := rdb.Incr(ctx, grantVersionKey).Result()
	if err != nil {
		return 0
	}
	return version
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AssignmentRequest(subject: String, role: String, scope: String)

object StateCache {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val requestFormat: RootJsonFormat[AssignmentRequest] = jsonFormat3(AssignmentRequest)

  val jedis = new Jedis("redis", 6379)
  val CacheTtlS = 300

  val store = GrantStore.open()

  def cacheKey(subject: String, scope: String): String = s"perm:$subject:$scope"

  def effectivePermissions(subject: String, scope: String): Set[String] = {
    val key = cacheKey(subject, scope)
    val cached = jedis.hgetAll(key)
    if (!cached.isEmpty) cached.get("perms").split(",").filter(_.nonEmpty).toSet
    else {
      val perms = store.effective(subject, scope)
      jedis.hset(key, "perms", perms.mkString(","))
      jedis.expire(key, CacheTtlS)
      perms
    }
  }

  def jsonArray(values: Set[String]): String =
    values.toSeq.sorted.map(p => """ + p + """).mkString("[", ",", "]")

  val route: Route =
    path("v1" / "users" / Segment / "permissions") { subject =>
      get {
        parameter("scope".?) { scopeOpt =>
          val scope = scopeOpt.getOrElse("org")
          complete(
            StatusCodes.OK,
            s"""{"subject":"$subject","scope":"$scope","permissions":\${jsonArray(effectivePermissions(subject, scope))}}""",
          )
        }
      }
    } ~
      path("v1" / "roles" / "assignments") {
        post {
          entity(as[AssignmentRequest]) { body =>
            // TODO: this draft invalidates by deleting the cached key after the write and leans on
            // the 300 s TTL. A read that slips in between the write and the re-derive repopulates
            // the old set, so a revoked permission survives. No version, no counter, no lock.
            store.put(body.subject, body.scope, body.role)
            jedis.del(cacheKey(body.subject, body.scope))
            system.log.info(s"assigned subject=\${body.subject} role=\${body.role} scope=\${body.scope}")
            complete(
              StatusCodes.OK,
              s"""{"subject":"\${body.subject}","role":"\${body.role}","scope":"\${body.scope}"}""",
            )
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.{Jedis, SetParams}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AssignmentRequest(subject: String, role: String, scope: String)

object StateCache {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val requestFormat: RootJsonFormat[AssignmentRequest] = jsonFormat3(AssignmentRequest)

  val jedis = new Jedis("redis", 6379)

  val GrantVersionKey = "perm:grant_version"
  val CacheVersionField = "version"
  val CachePermsField = "perms"
  val CacheTtlS = 300
  val LockKeyPrefix = "perm:lock:"
  val LockTtlMs = 2000

  // Compare-and-delete: a slow worker must not release the lock a younger worker now owns.
  val ReleaseLockLua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end"

  val store = GrantStore.open()

  def cacheKey(subject: String, scope: String): String = s"perm:$subject:$scope"

  def lockKey(subject: String, scope: String): String = s"$LockKeyPrefix$subject:$scope"

  def currentVersion(): Long = Option(jedis.get(GrantVersionKey)).map(_.toLong).getOrElse(0L)

  /** An entry is trustworthy only while its stamp equals the counter read this request. */
  def cacheIsCurrent(entry: java.util.Map[String, String], version: Long): Boolean =
    Option(entry.get(CacheVersionField)).contains(version.toString)

  def recomputeEffective(subject: String, scope: String, version: Long): Set[String] = {
    val key = cacheKey(subject, scope)
    val lock = lockKey(subject, scope)
    val token = UUID.randomUUID().toString
    if (jedis.set(lock, token, SetParams.setParams().nx().px(LockTtlMs)) == "OK") {
      try {
        val perms = store.effective(subject, scope)
        jedis.hset(key, CachePermsField, perms.mkString(","))
        jedis.hset(key, CacheVersionField, version.toString)
        jedis.expire(key, CacheTtlS)
        perms
      } finally {
        jedis.eval(ReleaseLockLua, 1, lock, token)
      }
    } else {
      val entry = jedis.hgetAll(key)
      if (!entry.isEmpty && cacheIsCurrent(entry, version))
        entry.get(CachePermsField).split(",").filter(_.nonEmpty).toSet
      else store.effective(subject, scope)
    }
  }

  def effectivePermissions(subject: String, scope: String): Set[String] = {
    val version = currentVersion()
    val entry = jedis.hgetAll(cacheKey(subject, scope))
    if (!entry.isEmpty && cacheIsCurrent(entry, version))
      entry.get(CachePermsField).split(",").filter(_.nonEmpty).toSet
    else recomputeEffective(subject, scope, version)
  }

  def jsonArray(values: Set[String]): String =
    values.toSeq.sorted.map(p => """ + p + """).mkString("[", ",", "]")

  val route: Route =
    path("v1" / "users" / Segment / "permissions") { subject =>
      get {
        parameter("scope".?) { scopeOpt =>
          val scope = scopeOpt.getOrElse("org")
          complete(
            StatusCodes.OK,
            s"""{"subject":"$subject","scope":"$scope","permissions":\${jsonArray(effectivePermissions(subject, scope))}}""",
          )
        }
      }
    } ~
      path("v1" / "roles" / "assignments") {
        post {
          entity(as[AssignmentRequest]) { body =>
            // The grant is durable first; only then does the clock move, and only then is the call acked.
            store.recordChange(body.subject, body.scope)
            bumpVersion()
            system.log.info(s"assigned subject=\${body.subject} role=\${body.role} scope=\${body.scope}")
            complete(
              StatusCodes.OK,
              s"""{"subject":"\${body.subject}","role":"\${body.role}","scope":"\${body.scope}"}""",
            )
          }
        }
      }

  /** Move the invalidation clock: every entry stamped before this call is now stale. */
  def bumpVersion(): Long = jedis.incr(GrantVersionKey)

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// Effective-permission cache: a model-generated draft that deletes the key on every change.
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

const int kCacheTtlS = 300;

struct GrantStore {
  std::vector<std::string> effective(const std::string& subject, const std::string& scope);
  void put(const std::string& subject, const std::string& scope, const std::string& role);
};

GrantStore store;

sw::redis::Redis redis("tcp://redis:6379");

std::string cacheKey(const std::string& subject, const std::string& scope) {
  return "perm:" + subject + ":" + scope;
}

std::string joinPerms(const std::vector<std::string>& perms) {
  std::string joined;
  for (const auto& perm : perms) {
    if (!joined.empty()) joined += ",";
    joined += perm;
  }
  return joined;
}

std::vector<std::string> splitPerms(const std::string& joined) {
  std::vector<std::string> out;
  std::stringstream stream(joined);
  std::string part;
  while (std::getline(stream, part, ',')) {
    if (!part.empty()) out.push_back(part);
  }
  return out;
}

std::vector<std::string> effectivePermissions(const std::string& subject, const std::string& scope) {
  std::unordered_map<std::string, std::string> entry;
  redis.hgetall(cacheKey(subject, scope), std::inserter(entry, entry.end()));
  if (!entry.empty()) return splitPerms(entry.at("perms"));
  const auto perms = store.effective(subject, scope);
  redis.hset(cacheKey(subject, scope), "perms", joinPerms(perms));
  redis.expire(cacheKey(subject, scope), std::chrono::seconds(kCacheTtlS));
  return perms;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/users/:subject/permissions", [](const httplib::Request& req, httplib::Response& res) {
    const auto subject = req.path_params.at("subject");
    const auto scope = req.has_param("scope") ? req.get_param_value("scope") : std::string("org");
    json permissions = json::array();
    for (const auto& perm : effectivePermissions(subject, scope)) permissions.push_back(perm);
    res.status = 200;
    res.set_content(json{{"subject", subject}, {"scope", scope}, {"permissions", permissions}}.dump(),
                    "application/json");
  });

  svr.Post("/v1/roles/assignments", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft invalidates by deleting the cached key after the write and leans on the
    // 300 s TTL. A read that slips in between the write and the re-derive repopulates the old set,
    // so a revoked permission survives. There is no version stamp, no counter and no lock either.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto subject = body.value("subject", std::string());
    const auto role = body.value("role", std::string());
    const auto scope = body.value("scope", std::string());
    store.put(subject, scope, role);
    redis.del(cacheKey(subject, scope));
    std::cerr << "assigned subject=" << subject << " role=" << role << " scope=" << scope << "\\n";
    res.status = 200;
    res.set_content(json{{"subject", subject}, {"role", role}, {"scope", scope}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
      solution: `// Effective-permission cache: version-stamped entries invalidated by bumping a global counter.
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

const std::string kGrantVersionKey = "perm:grant_version";
const std::string kCacheVersionField = "version";
const std::string kCachePermsField = "perms";
const int kCacheTtlS = 300;
const std::string kLockKeyPrefix = "perm:lock:";
const int kLockTtlMs = 2000;

// Compare-and-delete: a slow worker must not release the lock a younger worker now owns.
const std::string kReleaseLockLua =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end";

struct GrantStore {
  std::vector<std::string> effective(const std::string& subject, const std::string& scope);
  void recordChange(const std::string& subject, const std::string& scope, const std::string& role);
};

GrantStore store;

sw::redis::Redis redis("tcp://redis:6379");

long bumpVersion();
std::string uuidString();

std::string cacheKey(const std::string& subject, const std::string& scope) {
  return "perm:" + subject + ":" + scope;
}

std::string lockKey(const std::string& subject, const std::string& scope) {
  return kLockKeyPrefix + subject + ":" + scope;
}

long currentVersion() {
  auto value = redis.get(kGrantVersionKey);
  return value ? std::stol(*value) : 0L;
}

// cacheIsCurrent reports whether entry was stamped with the counter read this request.
bool cacheIsCurrent(const std::unordered_map<std::string, std::string>& entry, long version) {
  auto stamped = entry.find(kCacheVersionField);
  return stamped != entry.end() && stamped->second == std::to_string(version);
}

std::string joinPerms(const std::vector<std::string>& perms) {
  std::string joined;
  for (const auto& perm : perms) {
    if (!joined.empty()) joined += ",";
    joined += perm;
  }
  return joined;
}

std::vector<std::string> splitPerms(const std::string& joined) {
  std::vector<std::string> out;
  std::stringstream stream(joined);
  std::string part;
  while (std::getline(stream, part, ',')) {
    if (!part.empty()) out.push_back(part);
  }
  return out;
}

std::vector<std::string> recomputeEffective(const std::string& subject, const std::string& scope, long version) {
  const auto key = cacheKey(subject, scope);
  const auto lock = lockKey(subject, scope);
  const auto token = uuidString();
  if (redis.set(lock, token, std::chrono::milliseconds(kLockTtlMs), sw::redis::UpdateType::NOT_EXIST)) {
    try {
      const auto perms = store.effective(subject, scope);
      redis.hset(key, kCachePermsField, joinPerms(perms));
      redis.hset(key, kCacheVersionField, std::to_string(version));
      redis.expire(key, std::chrono::seconds(kCacheTtlS));
      return perms;
    } catch (...) {
      redis.eval(kReleaseLockLua, {lock}, {token});
      throw;
    }
  }
  std::unordered_map<std::string, std::string> entry;
  redis.hgetall(key, std::inserter(entry, entry.end()));
  if (!entry.empty() && cacheIsCurrent(entry, version)) return splitPerms(entry.at(kCachePermsField));
  return store.effective(subject, scope);
}

std::vector<std::string> effectivePermissions(const std::string& subject, const std::string& scope) {
  const auto version = currentVersion();
  std::unordered_map<std::string, std::string> entry;
  redis.hgetall(cacheKey(subject, scope), std::inserter(entry, entry.end()));
  if (!entry.empty() && cacheIsCurrent(entry, version)) return splitPerms(entry.at(kCachePermsField));
  return recomputeEffective(subject, scope, version);
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/users/:subject/permissions", [](const httplib::Request& req, httplib::Response& res) {
    const auto subject = req.path_params.at("subject");
    const auto scope = req.has_param("scope") ? req.get_param_value("scope") : std::string("org");
    json permissions = json::array();
    for (const auto& perm : effectivePermissions(subject, scope)) permissions.push_back(perm);
    res.status = 200;
    res.set_content(json{{"subject", subject}, {"scope", scope}, {"permissions", permissions}}.dump(),
                    "application/json");
  });

  svr.Post("/v1/roles/assignments", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto subject = body.value("subject", std::string());
    const auto role = body.value("role", std::string());
    const auto scope = body.value("scope", std::string());
    // The grant is durable first; only then does the clock move, and only then is the call acked.
    store.recordChange(subject, scope, role);
    bumpVersion();
    std::cerr << "assigned subject=" << subject << " role=" << role << " scope=" << scope << "\\n";
    res.status = 200;
    res.set_content(json{{"subject", subject}, {"role", role}, {"scope", scope}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}

// bumpVersion moves the invalidation clock: every entry stamped before this call is now stale.
long bumpVersion() { return redis.incr(kGrantVersionKey); }

std::string uuidString() {
  static int counter = 0;
  return "lock-" + std::to_string(++counter);
}
`,
    },
  },
  debrief: `The interview question behind this step is whether a cached authorization decision can outlive the change that should have killed it. Delete-on-write reads as invalidation but is only a hint: the key is gone, so the next reader rebuilds it — and if that reader sampled the grants before the change, it rebuilds the old set and stamps it with a fresh 300 s TTL. Nothing tells the following reader that the entry predates the revocation, and that is exactly what a version counter removes: the entry carries the counter value it was derived at, the read compares it with the counter now, and the mutation path — record the grant, then \`INCR\`, then ack — guarantees the mismatch is visible to the very next read. Single-flight is the second half: without a lock, concurrent misses all rebuild, and the slowest one can write an older snapshot over a newer entry. Real services also publish the version through the event stream so the counter can be rebuilt after a Redis loss, warm the entry on write instead of on the next read, and shard the lock so one slow subject cannot stall the rest.`,
};
