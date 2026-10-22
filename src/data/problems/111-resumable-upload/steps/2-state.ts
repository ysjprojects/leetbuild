import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis part manifest with atomic registration',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: parts register and the happy path counts them, so
the demo passes. The manifest hides three defects — a double count, a missing range check and a leak.
Find them, fix them, and prove the fix.

Implement the part manifest in Redis. Each part registers its number, size and checksum.

- The manifest key is \`upload:{upload_id}\`; the parts hash is \`upload:{upload_id}:parts\`; the byte
  counter is \`upload:{upload_id}:bytes\`.
- Registration is **one atomic Lua \`EVAL\`**: it must reject a \`part_number\` outside
  \`1..part_count\` (**out of range**), return \`0\` when the part is already present (idempotent — a
  re-sent part must not change the byte count), and on a new part record \`size\` and \`checksum\` in
  the hash and add \`size\` to the byte counter. A list append registers a re-sent part twice and
  the completed manifest double-counts bytes.
- The manifest, its parts and its byte counter must expire after **24 hours** (\`86400\` seconds),
  set inside the same script. The draft's key never expires, so an abandoned upload's parts pin
  memory forever.
- Registration is keyed by \`part_number\`, so the manifest has at most \`part_count\` entries and
  \`bytes\` is the sum of the unique part sizes.

**Failure mode the checks target.** \`RPUSH\` is not idempotent: a client that retries a part after a
timeout appends it again, the byte counter grows past \`total_bytes\`, and finalize never reconciles.
Nothing rejects a \`part_number\` of \`0\` or \`part_count + 1\`, so a buggy client can write entries the
object store will never have. And with no \`EXPIRE\`, an upload that is never completed keeps its
parts in Redis until someone deletes them by hand.`,
  sequence: {
    participants: ['Upload API', 'Redis', 'Object store'],
    messages: [
      {from: 'Upload API', to: 'Redis', label: 'EVAL register_part · KEYS[upload:{id}]', kind: 'sync'},
      {from: 'Redis', to: 'Upload API', label: '{1 registered | 0 duplicate | error}', kind: 'reply'},
      {from: 'Upload API', to: 'Redis', label: 'EXPIRE upload:{id} 86400', kind: 'async'},
      {from: 'Upload API', to: 'Object store', label: 'WritePart only after 1', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'WritePartReply{checksum}', kind: 'reply'},
    ],
  },
  hints: [
    'The whole registration is one script: `HEXISTS` the parts hash, return `0` if the number is already there, otherwise `HSET` the part and `INCRBY` the byte counter. Doing `HGET` then `HSET` from the client leaves a window where a retry writes the same part twice.',
    'The range guard is part of the same script: `if part_number < 1 or part_number > part_count then return redis.error_reply(...) end`. A number outside the declared count is a client bug you want to surface, not an entry the object store will never have.',
    'Set the expiry inside the script on every key the manifest owns — the parts hash and the byte counter as well as the manifest itself — so an abandoned upload releases all of its memory at once. `EXPIRE key 86400` on the first write is enough if the script runs on every part.',
  ],
  checks: [
    {
      id: 'atomic-register',
      title: 'Registers with one atomic Lua script',
      detail:
        'The parts hash and the byte counter are updated in a single `EVAL`/`NewScript` call, so two concurrent registrations cannot both observe the same part as new. The draft runs `RPUSH` as a bare command.',
      match: {
        python: {all: [/REGISTER_PART_SCRIPT/, /\.eval\(/]},
        typescript: {all: [/REGISTER_PART_SCRIPT/, /\.eval\(/]},
        go: {all: [/registerPartScript/, /NewScript\(/]},
        scala: {all: [/RegisterPartScript/, /\.eval\(/]},
        cpp: {all: [/kRegisterPartScript/, /\.eval/]},
      },
    },
    {
      id: 'idempotent-part',
      title: 'A re-sent part registers once',
      detail:
        'A part already in the hash returns `0` without touching the byte counter; the guard is `HEXISTS` before `HSET`, keyed by `part_number`. The draft appends to a list, so a retried part registers twice.',
      match: {
        python: {all: [/HEXISTS/, /HSET/]},
        typescript: {all: [/HEXISTS/, /HSET/]},
        go: {all: [/HEXISTS/, /HSET/]},
        scala: {all: [/HEXISTS/, /HSET/]},
        cpp: {all: [/HEXISTS/, /HSET/]},
      },
    },
    {
      id: 'part-range',
      title: 'Rejects a part number outside 1..part_count',
      detail:
        'The script rejects `part_number < 1 or part_number > part_count` before writing anything. The draft accepts any number, so a client bug writes entries the object store will never have.',
      match: {
        python: {all: [/part_number/, /part_count/, /out of range|> part_count/]},
        typescript: {all: [/partNumber/, /partCount/, /out of range|> partCount/]},
        go: {all: [/partNumber/, /partCount/, /out of range|> partCount/]},
        scala: {all: [/partNumber/, /partCount/, /out of range|> partCount/]},
        cpp: {all: [/partNumber/, /partCount/, /out of range|> partCount/]},
      },
    },
    {
      id: 'ttl',
      title: 'Abandoned sessions expire after 24 hours',
      detail:
        '`EXPIRE` runs inside the registration script with a 24-hour TTL, so an abandoned upload releases its manifest, parts and byte counter. The draft sets no expiry at all.',
      match: {
        python: {all: [/EXPIRE/, /MANIFEST_TTL_S/]},
        typescript: {all: [/EXPIRE/, /MANIFEST_TTL_S/]},
        go: {all: [/EXPIRE/, /manifestTTLS/]},
        scala: {all: [/EXPIRE/, /ManifestTtlS/]},
        cpp: {all: [/EXPIRE/, /kManifestTtlS/]},
      },
    },
    {
      id: 'byte-accounting',
      title: 'Counts bytes from unique parts only',
      detail:
        'A dedicated byte counter is incremented only when a part is new, so `bytes` equals the sum of unique part sizes. The draft’s list makes the completed manifest double-count a re-sent part.',
      match: {
        python: {all: [/INCRBY/, /:bytes/]},
        typescript: {all: [/INCRBY/, /:bytes/]},
        go: {all: [/INCRBY/, /:bytes/]},
        scala: {all: [/INCRBY/, /:bytes/]},
        cpp: {all: [/INCRBY/, /:bytes/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

redis_client = redis.Redis()


def register_part(upload_id: str, part_number: int, size: int, checksum: str) -> None:
    # TODO: this draft appends parts to a list as they arrive, so a re-sent part registers twice
    # and the completed manifest double-counts bytes; the manifest key never expires either.
    key = f"upload:{{upload_id}}:parts"
    redis_client.rpush(key, f"{part_number}:{size}:{checksum}")
`,
      solution: `import redis

redis_client = redis.Redis()

MANIFEST_TTL_S = 24 * 60 * 60

REGISTER_PART_SCRIPT = """
local key = KEYS[1]
local part_number = tonumber(ARGV[1])
local part_count = tonumber(ARGV[2])
local size = tonumber(ARGV[3])
local checksum = ARGV[4]
if part_number < 1 or part_number > part_count then
  return redis.error_reply('part_number out of range')
end
if redis.call('HEXISTS', key .. ':parts', part_number) == 1 then
  return 0
end
redis.call('HSET', key .. ':parts', part_number, size .. ':' .. checksum)
redis.call('INCRBY', key .. ':bytes', size)
redis.call('EXPIRE', key, tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':parts', tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':bytes', tonumber(ARGV[5]))
return 1
"""


def register_part(upload_id: str, part_number: int, part_count: int, size: int, checksum: str) -> bool:
    """Register one part atomically. True when it was new, False when it was already present."""
    key = "upload:" + upload_id
    result = redis_client.eval(
        REGISTER_PART_SCRIPT, 1, key, part_number, part_count, size, checksum, MANIFEST_TTL_S
    )
    return result == 1
`,
    },
    typescript: {
      starter: `/** Part manifest: a model-generated draft that appends to a Redis list. */
import Redis from 'ioredis';

const redis = new Redis();

export async function registerPart(
  uploadId: string,
  partNumber: number,
  size: number,
  checksum: string,
): Promise<void> {
  // TODO: this draft appends parts to a list as they arrive, so a re-sent part registers twice
  // and the completed manifest double-counts bytes; the manifest key never expires either.
  const key = \`upload:\${uploadId}:parts\`;
  await redis.rpush(key, \`\${partNumber}:\${size}:\${checksum}\`);
}
`,
      solution: `/** Part manifest: one atomic Lua script registers each part exactly once. */
import Redis from 'ioredis';

const redis = new Redis();

const MANIFEST_TTL_S = 24 * 60 * 60;

const REGISTER_PART_SCRIPT = \`
local key = KEYS[1]
local partNumber = tonumber(ARGV[1])
local partCount = tonumber(ARGV[2])
local size = tonumber(ARGV[3])
local checksum = ARGV[4]
if partNumber < 1 or partNumber > partCount then
  return redis.error_reply('part_number out of range')
end
if redis.call('HEXISTS', key .. ':parts', partNumber) == 1 then
  return 0
end
redis.call('HSET', key .. ':parts', partNumber, size .. ':' .. checksum)
redis.call('INCRBY', key .. ':bytes', size)
redis.call('EXPIRE', key, tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':parts', tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':bytes', tonumber(ARGV[5]))
return 1
\`;

export async function registerPart(
  uploadId: string,
  partNumber: number,
  partCount: number,
  size: number,
  checksum: string,
): Promise<boolean> {
  const key = \`upload:\${uploadId}\`;
  const result = (await redis.eval(
    REGISTER_PART_SCRIPT,
    1,
    key,
    String(partNumber),
    String(partCount),
    String(size),
    checksum,
    String(MANIFEST_TTL_S),
  )) as number;
  return result === 1;
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "localhost:6379"})

func RegisterPart(ctx context.Context, uploadID string, partNumber int, size int64, checksum string) error {
	// TODO: this draft appends parts to a list as they arrive, so a re-sent part registers twice
	// and the completed manifest double-counts bytes; the manifest key never expires either.
	key := fmt.Sprintf("upload:%s:parts", uploadID)
	return rdb.RPush(ctx, key, fmt.Sprintf("%d:%d:%s", partNumber, size, checksum)).Err()
}
`,
      solution: `package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const manifestTTLS = 24 * 60 * 60

const registerPartScript = \`
local key = KEYS[1]
local partNumber = tonumber(ARGV[1])
local partCount = tonumber(ARGV[2])
local size = tonumber(ARGV[3])
local checksum = ARGV[4]
if partNumber < 1 or partNumber > partCount then
  return redis.error_reply('part_number out of range')
end
if redis.call('HEXISTS', key .. ':parts', partNumber) == 1 then
  return 0
end
redis.call('HSET', key .. ':parts', partNumber, size .. ':' .. checksum)
redis.call('INCRBY', key .. ':bytes', size)
redis.call('EXPIRE', key, tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':parts', tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':bytes', tonumber(ARGV[5]))
return 1
\`

var (
	rdb            = redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	registerScript = redis.NewScript(registerPartScript)
)

func RegisterPart(ctx context.Context, uploadID string, partNumber, partCount int, size int64, checksum string) (bool, error) {
	key := "upload:" + uploadID
	result, err := registerScript.Run(ctx, rdb, []string{key}, partNumber, partCount, size, checksum, manifestTTLS).Int()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}
`,
    },
    scala: {
      starter: `package state

import redis.clients.jedis.Jedis

object PartManifest {
  def registerPart(jedis: Jedis, uploadId: String, partNumber: Long, size: Long, checksum: String): Unit = {
    // TODO: this draft appends parts to a list as they arrive, so a re-sent part registers twice
    // and the completed manifest double-counts bytes; the manifest key never expires either.
    val key = s"upload:$uploadId:parts"
    jedis.rpush(key, s"$partNumber:$size:$checksum")
  }
}
`,
      solution: `package state

import redis.clients.jedis.Jedis

object PartManifest {
  val ManifestTtlS: Long = 24 * 60 * 60

  val RegisterPartScript: String =
    """
      |local key = KEYS[1]
      |local partNumber = tonumber(ARGV[1])
      |local partCount = tonumber(ARGV[2])
      |local size = tonumber(ARGV[3])
      |local checksum = ARGV[4]
      |if partNumber < 1 or partNumber > partCount then
      |  return redis.error_reply('part_number out of range')
      |end
      |if redis.call('HEXISTS', key .. ':parts', partNumber) == 1 then
      |  return 0
      |end
      |redis.call('HSET', key .. ':parts', partNumber, size .. ':' .. checksum)
      |redis.call('INCRBY', key .. ':bytes', size)
      |redis.call('EXPIRE', key, tonumber(ARGV[5]))
      |redis.call('EXPIRE', key .. ':parts', tonumber(ARGV[5]))
      |redis.call('EXPIRE', key .. ':bytes', tonumber(ARGV[5]))
      |return 1
      |""".stripMargin

  def registerPart(
      jedis: Jedis,
      uploadId: String,
      partNumber: Long,
      partCount: Long,
      size: Long,
      checksum: String,
  ): Boolean = {
    val key = s"upload:$uploadId"
    val result = jedis.eval(
      RegisterPartScript,
      List(key),
      List(partNumber.toString, partCount.toString, size.toString, checksum, ManifestTtlS.toString),
    )
    result.asInstanceOf[Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

bool RegisterPart(
    sw::redis::Redis& redis,
    const std::string& uploadId,
    long long partNumber,
    long long size,
    const std::string& checksum) {
  // TODO: this draft appends parts to a list as they arrive, so a re-sent part registers twice
  // and the completed manifest double-counts bytes; the manifest key never expires either.
  const auto key = "upload:" + uploadId + ":parts";
  redis.rpush(key, std::to_string(partNumber) + ":" + std::to_string(size) + ":" + checksum);
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

constexpr long long kManifestTtlS = 24 * 60 * 60;

const std::string kRegisterPartScript = R"lua(
local key = KEYS[1]
local partNumber = tonumber(ARGV[1])
local partCount = tonumber(ARGV[2])
local size = tonumber(ARGV[3])
local checksum = ARGV[4]
if partNumber < 1 or partNumber > partCount then
  return redis.error_reply('part_number out of range')
end
if redis.call('HEXISTS', key .. ':parts', partNumber) == 1 then
  return 0
end
redis.call('HSET', key .. ':parts', partNumber, size .. ':' .. checksum)
redis.call('INCRBY', key .. ':bytes', size)
redis.call('EXPIRE', key, tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':parts', tonumber(ARGV[5]))
redis.call('EXPIRE', key .. ':bytes', tonumber(ARGV[5]))
return 1
)lua";

bool RegisterPart(
    sw::redis::Redis& redis,
    const std::string& uploadId,
    long long partNumber,
    long long partCount,
    long long size,
    const std::string& checksum) {
  const auto key = "upload:" + uploadId;
  const auto result = redis.eval<long long>(
      kRegisterPartScript,
      {key},
      {std::to_string(partNumber),
       std::to_string(partCount),
       std::to_string(size),
       checksum,
       std::to_string(kManifestTtlS)});
  return result == 1;
}
`,
    },
  },
  debrief: `The manifest is the single source of truth for what has actually arrived, so it must be written exactly once per part and never grow without bound. The draft's \`RPUSH\` looks harmless — a list is a natural place for parts — but a list cannot deduplicate, so a client that retries a part after a timeout inflates the byte count and the manifest disagrees with the object store. The range guard catches client bugs at the edge instead of storing entries the object store will never have. And the 24-hour TTL is what keeps an abandoned upload from pinning memory: without it, the parts hash of a client that gave up lives until an operator deletes it. Production manifests also keep the object store's ETag beside the checksum and a per-part \`stored_at\`, so finalize can reconcile against the store rather than trusting the client's list.`,
};
