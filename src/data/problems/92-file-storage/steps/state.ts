import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis upload sessions and quota accounting',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the Redis layer behind the
upload handshake: it writes the session hash, increments the tenant's usage, and acks a chunk with a
\`HSET\`. It compiles, it serves the demo, and it hides two production flaws — the ack and the
accounting are separate calls, and the session key never expires. Review it, fix it, and prove the fix
with the checks below.

Implement the upload state on Redis:

- The tenant's usage is one integer key \`quota:used:{tenant}\`; a session's declaration is also a
  member of the sorted set \`quota:reservations:{tenant}\` whose score is the declared size, so a
  reservation can be found without scanning the keyspace.
- \`session:{upload_id}\` is a hash: \`tenant\`, \`declared_size\`, \`actual_bytes\` and one field per
  acked chunk.
- **Reserve** (\`CREATE_LUA\`): \`INCRBY\` the tenant's usage, \`HSET\` the session, \`ZADD\` the
  reservation and \`EXPIRE\` both the session key and the reservation set in **one** \`EVAL\`, so the
  reservation and the bytes it protects cannot drift apart.
- **Ack a chunk** (\`ACK_LUA\`): the chunk's \`HSETNX\` and the session's \`actual_bytes\` accounting run
  in one script. A chunk that is acked twice — a client retry after a dropped response — must not add
  its bytes twice, so the accounting only happens when the field is new.
- The session key expires after **24 hours** (\`86400\` seconds) so an abandoned multi-gigabyte upload
  stops pinning the tenant's quota.
- **Sweep** (\`sweep\`): for each member of \`quota:reservations:{tenant}\` whose session key no longer
  exists, \`ZREM\` the reservation and \`DECRBY\` the tenant's usage, returning the released bytes. That is
  how an abandoned session's quota comes back without a background job that owns a copy of the state.

**Failure mode the checks target.** Two separate calls mean a crash between them charges the tenant for
a chunk that was never stored — a crash loop burns quota for bytes that do not exist. A session key
with no TTL means every abandoned upload pins its declared size forever, so the tenant's real headroom
silently shrinks. And an ack that just \`HSET\`s counts a retried chunk twice.`,
  sequence: {
    participants: ['Client', 'Upload API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Upload API', label: 'POST /v1/files · declared size', kind: 'sync'},
      {
        from: 'Upload API',
        to: 'Redis',
        label: 'EVAL CREATE_LUA · INCRBY quota:used · ZADD reservation · EXPIRE',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Upload API', label: 'reserved bytes', kind: 'reply'},
      {from: 'Upload API', to: 'Client', label: '201 {upload_id, declared_size}', kind: 'reply'},
      {from: 'Client', to: 'Upload API', label: 'PUT chunk 3 · 8 MiB', kind: 'sync'},
      {from: 'Upload API', to: 'Redis', label: 'EVAL ACK_LUA · HSETNX chunk · INCRBY actual_bytes', kind: 'sync'},
      {from: 'Redis', to: 'Upload API', label: 'stored bytes', kind: 'reply'},
      {from: 'Upload API', to: 'Redis', label: 'EXPIRE session:{upload_id} 86400', kind: 'async'},
      {from: 'Upload API', to: 'Redis', label: 'sweep · ZSCORE · ZREM expired · DECRBY quota:used', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'session-ttl',
      title: 'Sessions expire instead of pinning quota',
      detail:
        'The session key and its reservation carry a TTL of `86400` seconds. The draft writes the session with no expiry at all, so an abandoned upload keeps its declared size reserved forever.',
      match: {
        python: {all: [/EXPIRE/, /SESSION_TTL_S/]},
        typescript: {all: [/EXPIRE/, /SESSION_TTL_S/]},
        go: {all: [/EXPIRE/, /sessionTTLSeconds/]},
        scala: {all: [/EXPIRE/, /SessionTtlSeconds/]},
        cpp: {all: [/EXPIRE/, /kSessionTtlS/]},
      },
    },
    {
      id: 'atomic-ack',
      title: 'Chunk ack and byte accounting are one script',
      detail:
        'The chunk field and the session accounting move inside a single registered script (`ACK_LUA`), so a crash cannot ack a chunk without charging for it. The draft acks with `HSET` and increments in a second call.',
      match: {
        python: {all: [/ACK_LUA/, /register_script/, /redis\.call\(/]},
        typescript: {all: [/ACK_LUA/, /defineCommand/, /redis\.call\(/]},
        go: {all: [/ackLua/, /NewScript/, /redis\.call\(/]},
        scala: {all: [/AckLua/, /eval[<(]/, /redis\.call\(/]},
        cpp: {all: [/kAckLua/, /eval[<(]/, /redis\.call\(/]},
      },
    },
    {
      id: 'idempotent-ack',
      title: 'A re-acked chunk does not double-count',
      detail:
        'The chunk field is written with `HSETNX` and the accounting only runs when the field is new, so a retried ack cannot add the same bytes twice. The draft uses a plain `HSET` and charges every time.',
      match: {
        python: {all: [/HSETNX/, /chunk:/]},
        typescript: {all: [/HSETNX/, /chunk:/]},
        go: {all: [/HSETNX/, /chunk:/]},
        scala: {all: [/HSETNX/, /chunk:/]},
        cpp: {all: [/HSETNX/, /chunk:/]},
      },
    },
    {
      id: 'release-quota',
      title: 'An abandoned session returns its reservation',
      detail:
        'The sweep finds reservations whose session key is gone, `ZREM`s the member and `DECRBY`s the tenant usage. The draft never releases anything, so expired sessions keep spending quota.',
      match: {
        python: {all: [/ZREM/, /DECRBY/]},
        typescript: {all: [/ZREM/, /DECRBY/]},
        go: {all: [/ZREM/, /DECRBY/]},
        scala: {all: [/ZREM/, /DECRBY/]},
        cpp: {all: [/ZREM/, /DECRBY/]},
      },
    },
    {
      id: 'reserve-atomic',
      title: 'Reserving and charging the quota happen together',
      detail:
        '`CREATE_LUA` increments the usage and records the reservation in one `EVAL`, so the reservation set and the usage counter can never disagree. The draft increments the usage from the client with no reservation record.',
      match: {
        python: {all: [/CREATE_LUA/, /ZADD/, /quota:used/]},
        typescript: {all: [/CREATE_LUA/, /ZADD/, /quota:used/]},
        go: {all: [/createLua/, /ZADD/, /quota:used/]},
        scala: {all: [/CreateLua/, /ZADD/, /quota:used/]},
        cpp: {all: [/kCreateLua/, /ZADD/, /quota:used/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis.from_url("redis://localhost:6379")


def create_session(upload_id, tenant, declared_size):
    # TODO: this draft writes the session with no expiry and keeps no reservation record, so an
    # abandoned upload pins its declared size forever.
    r.hset("session:" + upload_id, mapping={"tenant": tenant, "declared_size": declared_size})
    r.incrby("quota:used:" + tenant, declared_size)


def ack_chunk(upload_id, tenant, chunk_index, size):
    # TODO: the ack and the accounting are two separate calls, so a crash between them leaves the
    # chunk unstored but its bytes charged.
    r.hset("session:" + upload_id, "chunk:" + str(chunk_index), size)
    r.incrby("quota:used:" + tenant, size)


def finalize(upload_id, tenant):
    r.hset("session:" + upload_id, "state", "committed")
`,
      solution: `import redis

SESSION_TTL_S = 86400
SESSION_PREFIX = "session:"
QUOTA_USED_PREFIX = "quota:used:"
RESERVATIONS_PREFIX = "quota:reservations:"

CREATE_LUA = """
local used = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "tenant", ARGV[1])
redis.call("HSET", KEYS[1], "declared_size", ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[4])
return used
"""

ACK_LUA = """
if redis.call("HSETNX", KEYS[1], "chunk:" .. ARGV[1], ARGV[2]) == 0 then
  return 0
end
local stored = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "actual_bytes", stored)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return stored
"""

RELEASE_LUA = """
local reserved = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not reserved then
  return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
return redis.call("DECRBY", KEYS[2], reserved)
"""


class UploadState:
    def __init__(self, client):
        self.client = client
        self.create_script = client.register_script(CREATE_LUA)
        self.ack_script = client.register_script(ACK_LUA)
        self.release_script = client.register_script(RELEASE_LUA)

    def reserve(self, upload_id, tenant, declared_size):
        return self.create_script(
            keys=[SESSION_PREFIX + upload_id, QUOTA_USED_PREFIX + tenant, RESERVATIONS_PREFIX + tenant],
            args=[tenant, declared_size, upload_id, SESSION_TTL_S],
        )

    def ack_chunk(self, upload_id, tenant, chunk_index, size):
        return self.ack_script(
            keys=[SESSION_PREFIX + upload_id, QUOTA_USED_PREFIX + tenant],
            args=[chunk_index, size, SESSION_TTL_S],
        )

    def sweep(self, tenant):
        released = 0
        for upload_id in self.client.zrange(RESERVATIONS_PREFIX + tenant, 0, -1):
            if not self.client.exists(SESSION_PREFIX + upload_id):
                released += self.release_script(
                    keys=[RESERVATIONS_PREFIX + tenant, QUOTA_USED_PREFIX + tenant],
                    args=[upload_id],
                )
        return released
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const client = new Redis();

export async function createSession(uploadId: string, tenant: string, declaredSize: number): Promise<number> {
  // TODO: this draft writes the session with no expiry and keeps no reservation record, so an
  // abandoned upload pins its declared size forever.
  await client.hset('session:' + uploadId, 'tenant', tenant, 'declared_size', String(declaredSize));
  return client.incrby('quota:used:' + tenant, declaredSize);
}

export async function ackChunk(uploadId: string, tenant: string, chunkIndex: number, size: number): Promise<number> {
  // TODO: the ack and the accounting are two separate calls, so a crash between them leaves the
  // chunk unstored but its bytes charged.
  await client.hset('session:' + uploadId, 'chunk:' + String(chunkIndex), String(size));
  return client.incrby('quota:used:' + tenant, size);
}

export async function finalize(uploadId: string): Promise<void> {
  await client.hset('session:' + uploadId, 'state', 'committed');
}
`,
      solution: `import Redis from 'ioredis';

const SESSION_TTL_S = 86400;
const SESSION_PREFIX = 'session:';
const QUOTA_USED_PREFIX = 'quota:used:';
const RESERVATIONS_PREFIX = 'quota:reservations:';

const CREATE_LUA = \`
local used = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "tenant", ARGV[1])
redis.call("HSET", KEYS[1], "declared_size", ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[4])
return used
\`;

const ACK_LUA = \`
if redis.call("HSETNX", KEYS[1], "chunk:" .. ARGV[1], ARGV[2]) == 0 then
  return 0
end
local stored = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "actual_bytes", stored)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return stored
\`;

const RELEASE_LUA = \`
local reserved = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not reserved then
  return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
return redis.call("DECRBY", KEYS[2], reserved)
\`;

export class UploadState {
  constructor(private readonly client: Redis) {
    client.defineCommand('createSession', {numberOfKeys: 3, lua: CREATE_LUA});
    client.defineCommand('ackChunk', {numberOfKeys: 2, lua: ACK_LUA});
    client.defineCommand('releaseReservation', {numberOfKeys: 2, lua: RELEASE_LUA});
  }

  reserve(uploadId: string, tenant: string, declaredSize: number): Promise<number> {
    return this.client.createSession(
      SESSION_PREFIX + uploadId,
      QUOTA_USED_PREFIX + tenant,
      RESERVATIONS_PREFIX + tenant,
      tenant,
      declaredSize,
      uploadId,
      SESSION_TTL_S,
    ) as Promise<number>;
  }

  ackChunk(uploadId: string, tenant: string, chunkIndex: number, size: number): Promise<number> {
    return this.client.ackChunk(
      SESSION_PREFIX + uploadId,
      QUOTA_USED_PREFIX + tenant,
      chunkIndex,
      size,
      SESSION_TTL_S,
    ) as Promise<number>;
  }

  async sweep(tenant: string): Promise<number> {
    let released = 0;
    for (const uploadId of await this.client.zrange(RESERVATIONS_PREFIX + tenant, 0, -1)) {
      if ((await this.client.exists(SESSION_PREFIX + uploadId)) === 0)
        released += (await this.client.releaseReservation(
          RESERVATIONS_PREFIX + tenant,
          QUOTA_USED_PREFIX + tenant,
          uploadId,
        )) as number;
    }
    return released;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

func createSession(ctx context.Context, rdb *redis.Client, uploadID, tenant string, declaredSize int64) error {
	// TODO: this draft writes the session with no expiry and keeps no reservation record, so an
	// abandoned upload pins its declared size forever.
	if err := rdb.HSet(ctx, "session:"+uploadID, "tenant", tenant, "declared_size", declaredSize).Err(); err != nil {
		return err
	}
	return rdb.IncrBy(ctx, "quota:used:"+tenant, declaredSize).Err()
}

func ackChunk(ctx context.Context, rdb *redis.Client, uploadID, tenant string, chunkIndex, size int64) error {
	// TODO: the ack and the accounting are two separate calls, so a crash between them leaves the
	// chunk unstored but its bytes charged.
	field := "chunk:" + strconv.FormatInt(chunkIndex, 10)
	if err := rdb.HSet(ctx, "session:"+uploadID, field, size).Err(); err != nil {
		return err
	}
	return rdb.IncrBy(ctx, "quota:used:"+tenant, size).Err()
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const sessionTTLSeconds = 86400

const createLua = \`
local used = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "tenant", ARGV[1])
redis.call("HSET", KEYS[1], "declared_size", ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[4])
return used
\`

const ackLua = \`
if redis.call("HSETNX", KEYS[1], "chunk:" .. ARGV[1], ARGV[2]) == 0 then
  return 0
end
local stored = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "actual_bytes", stored)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return stored
\`

const releaseLua = \`
local reserved = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not reserved then
  return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
return redis.call("DECRBY", KEYS[2], reserved)
\`

var (
	createScript  = redis.NewScript(createLua)
	ackScript     = redis.NewScript(ackLua)
	releaseScript = redis.NewScript(releaseLua)
)

func reserve(ctx context.Context, rdb *redis.Client, uploadID, tenant string, declaredSize int64) (int64, error) {
	return createScript.Run(ctx, rdb,
		[]string{"session:" + uploadID, "quota:used:" + tenant, "quota:reservations:" + tenant},
		tenant, declaredSize, uploadID, sessionTTLSeconds,
	).Int64()
}

func ackChunk(ctx context.Context, rdb *redis.Client, uploadID, tenant string, chunkIndex, size int64) (int64, error) {
	return ackScript.Run(ctx, rdb,
		[]string{"session:" + uploadID, "quota:used:" + tenant},
		chunkIndex, size, sessionTTLSeconds,
	).Int64()
}

func sweep(ctx context.Context, rdb *redis.Client, tenant string) (int64, error) {
	var released int64
	members, err := rdb.ZRange(ctx, "quota:reservations:"+tenant, 0, -1).Result()
	if err != nil {
		return 0, err
	}
	for _, uploadID := range members {
		exists, err := rdb.Exists(ctx, "session:"+uploadID).Result()
		if err != nil {
			return 0, err
		}
		if exists == 0 {
			n, err := releaseScript.Run(ctx, rdb,
				[]string{"quota:reservations:" + tenant, "quota:used:" + tenant},
				uploadID,
			).Int64()
			if err != nil {
				return 0, err
			}
			released += n
		}
	}
	return released, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object UploadState {
  def createSession(jedis: Jedis, uploadId: String, tenant: String, declaredSize: Long): Long = {
    // TODO: this draft writes the session with no expiry and keeps no reservation record, so an
    // abandoned upload pins its declared size forever.
    jedis.hset("session:" + uploadId, "tenant", tenant)
    jedis.hset("session:" + uploadId, "declared_size", String.valueOf(declaredSize))
    jedis.incrBy("quota:used:" + tenant, declaredSize)
  }

  def ackChunk(jedis: Jedis, uploadId: String, tenant: String, chunkIndex: Long, size: Long): Long = {
    // TODO: the ack and the accounting are two separate calls, so a crash between them leaves the
    // chunk unstored but its bytes charged.
    jedis.hset("session:" + uploadId, "chunk:" + String.valueOf(chunkIndex), String.valueOf(size))
    jedis.incrBy("quota:used:" + tenant, size)
  }

  def finalizeUpload(jedis: Jedis, uploadId: String): Long =
    jedis.hset("session:" + uploadId, "state", "committed")
}
`,
      solution: `import redis.clients.jedis.Jedis

object UploadState {
  val SessionTtlSeconds: Long = 86400

  val CreateLua: String = """
local used = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "tenant", ARGV[1])
redis.call("HSET", KEYS[1], "declared_size", ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[4])
return used
"""

  val AckLua: String = """
if redis.call("HSETNX", KEYS[1], "chunk:" .. ARGV[1], ARGV[2]) == 0 then
  return 0
end
local stored = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "actual_bytes", stored)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return stored
"""

  val ReleaseLua: String = """
local reserved = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not reserved then
  return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
return redis.call("DECRBY", KEYS[2], reserved)
"""

  def reserve(jedis: Jedis, uploadId: String, tenant: String, declaredSize: Long): Long =
    jedis
      .eval(
        CreateLua,
        java.util.List.of("session:" + uploadId, "quota:used:" + tenant, "quota:reservations:" + tenant),
        java.util.List.of(tenant, String.valueOf(declaredSize), uploadId, String.valueOf(SessionTtlSeconds)),
      )
      .toLong

  def ackChunk(jedis: Jedis, uploadId: String, tenant: String, chunkIndex: Long, size: Long): Long =
    jedis
      .eval(
        AckLua,
        java.util.List.of("session:" + uploadId, "quota:used:" + tenant),
        java.util.List.of(String.valueOf(chunkIndex), String.valueOf(size), String.valueOf(SessionTtlSeconds)),
      )
      .toLong

  def sweep(jedis: Jedis, tenant: String): Long = {
    var released = 0L
    val members = jedis.zrange("quota:reservations:" + tenant, 0, -1)
    members.forEach { uploadId =>
      if (!jedis.exists("session:" + uploadId)) {
        released += jedis
          .eval(
            ReleaseLua,
            java.util.List.of("quota:reservations:" + tenant, "quota:used:" + tenant),
            java.util.List.of(uploadId),
          )
          .toLong
      }
    }
    released
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

struct UploadState {
  sw::redis::Redis redis;

  long createSession(const std::string& uploadId, const std::string& tenant, long declaredSize) {
    // TODO: this draft writes the session with no expiry and keeps no reservation record, so an
    // abandoned upload pins its declared size forever.
    redis.hset("session:" + uploadId, "tenant", tenant);
    redis.hset("session:" + uploadId, "declared_size", std::to_string(declaredSize));
    return redis.incrby("quota:used:" + tenant, declaredSize);
  }

  long ackChunk(const std::string& uploadId, const std::string& tenant, long chunkIndex, long size) {
    // TODO: the ack and the accounting are two separate calls, so a crash between them leaves the
    // chunk unstored but its bytes charged.
    redis.hset("session:" + uploadId, "chunk:" + std::to_string(chunkIndex), std::to_string(size));
    return redis.incrby("quota:used:" + tenant, size);
  }
};
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

const long kSessionTtlS = 86400;

const char* const kCreateLua = R"lua(
local used = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "tenant", ARGV[1])
redis.call("HSET", KEYS[1], "declared_size", ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[4])
return used
)lua";

const char* const kAckLua = R"lua(
if redis.call("HSETNX", KEYS[1], "chunk:" .. ARGV[1], ARGV[2]) == 0 then
  return 0
end
local stored = redis.call("INCRBY", KEYS[2], ARGV[2])
redis.call("HSET", KEYS[1], "actual_bytes", stored)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return stored
)lua";

const char* const kReleaseLua = R"lua(
local reserved = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not reserved then
  return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
return redis.call("DECRBY", KEYS[2], reserved)
)lua";

struct UploadState {
  sw::redis::Redis redis;

  long reserve(const std::string& uploadId, const std::string& tenant, long declaredSize) {
    return redis.eval<long>(
        kCreateLua, {"session:" + uploadId, "quota:used:" + tenant, "quota:reservations:" + tenant},
        {tenant, std::to_string(declaredSize), uploadId, std::to_string(kSessionTtlS)});
  }

  long ackChunk(const std::string& uploadId, const std::string& tenant, long chunkIndex, long size) {
    return redis.eval<long>(kAckLua, {"session:" + uploadId, "quota:used:" + tenant},
                            {std::to_string(chunkIndex), std::to_string(size), std::to_string(kSessionTtlS)});
  }

  long sweep(const std::string& tenant) {
    long released = 0;
    std::vector<std::string> members;
    redis.zrange("quota:reservations:" + tenant, 0, -1, std::back_inserter(members));
    for (const auto& uploadId : members) {
      if (redis.exists("session:" + uploadId) == 0) {
        released += redis.eval<long>(kReleaseLua, {"quota:reservations:" + tenant, "quota:used:" + tenant},
                                     {uploadId});
      }
    }
    return released;
  }
};
`,
    },
  },
  hints: [
    'Both scripts exist for the same reason: the session hash and the quota counter must never disagree. Register them once at startup and call them by key, so the ack path cannot fall back to two round-trips.',
    'The TTL belongs on both keys the reserve script writes: the session hash so an abandoned upload stops existing, and the reservation set so the sweeper still has the member to release. A reservation with no session is a leak; a session with no reservation is unaccounted storage.',
    '`HSETNX` is what makes a retried ack safe. A client that never saw your response will resend the same chunk; the second ack must return the same stored total instead of adding the bytes again.',
  ],
  debrief: `The interviewer is testing whether you understand that a reservation is a promise about bytes that do not exist yet. The draft's two calls look equivalent to one script until the process dies between them, and its missing TTL looks harmless until an abandoned upload keeps its declared size reserved for a week. The two fixes are one idea: keep the accounting and the thing it accounts for in the same atomic unit, and give every promise an expiry with a path that releases it. Real systems add a sweeper on a schedule instead of inline, a lease so two sweepers cannot double-release, and a reconciliation job against the object store for the bytes that leaked anyway.`,
};
