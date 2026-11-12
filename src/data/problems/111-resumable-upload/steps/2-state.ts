import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A Redis part manifest that registers each part once',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the part manifest every later step uses (provided to them as
\`uploads.manifest\`): \`register_part(upload_id, part_number, part_count, size, checksum)\` writes
\`size:checksum\` under the part number into the hash \`upload:{id}:parts\` with \`HSET\`, adds
\`size\` to \`upload:{id}:bytes\` with \`INCRBY\` and answers 1; \`read_parts\` and \`uploaded_bytes\` read
them back. It serves the demo and hides four flaws.

**Failure mode the checks target.** A client that re-sends part 7 after a timeout has its bytes
counted twice; part 0 and part \`part_count + 1\` are registered; a reader landing between the two
writes sees a part whose bytes are not counted, and two servers registering one retried part both
count it; an abandoned upload stays in Redis forever.

- Answer **-1** and write nothing when \`part_number\` is outside \`1..part_count\`.
- Answer **0** and change nothing when the part is already registered, **1** when it is new.
- One Lua script (\`register_script\`/\`EVAL\`) does the check, the hash write and the counter, so no
  client sees one without the other.
- In the same script, both keys expire \`MANIFEST_TTL_S\` (24 hours) after the last registration.`,
  sequence: {
    participants: ['uploadd', 'Redis', 'Another uploadd'],
    messages: [
      {
        from: 'uploadd',
        to: 'Redis',
        label: 'EVAL register_part · KEYS parts, bytes · n, count, size, checksum',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'range check · HSETNX · INCRBY · EXPIRE ×2', kind: 'sync'},
      {from: 'Redis', to: 'uploadd', label: '1 new · 0 already registered · -1 out of range', kind: 'reply'},
      {from: 'Another uploadd', to: 'Redis', label: 'EVAL register_part (the same part, retried)', kind: 'sync'},
      {from: 'Redis', to: 'Another uploadd', label: '0: nothing counted twice', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'once',
      title: 'A re-sent part is registered once',
      detail:
        'Registering a part that is already in the hash answers 0 and leaves the hash and the byte counter alone (`HSETNX`, or `HEXISTS` before writing); the starter overwrites the entry and adds the size again.',
      match: {
        python: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
        typescript: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
        go: {all: [/HSETNX|HEXISTS|HSetNX|HExists/]},
        scala: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
        cpp: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
      },
    },
    {
      id: 'range',
      title: 'Refuses a part number outside 1..part_count',
      detail:
        'A part number below 1 or above `part_count` answers -1 and writes nothing; the starter registers any number, so a client bug leaves entries no object will ever hold.',
      match: {
        python: {all: [/return\s+-1\b/]},
        typescript: {all: [/return\s+-1\b/]},
        go: {all: [/return\s+-1\b/]},
        scala: {all: [/return\s+-1\b|\b-1L\b/]},
        cpp: {all: [/return\s+-1\b/]},
      },
    },
    {
      id: 'atomic',
      title: 'Registers a part in one Lua script',
      detail:
        'The check, the hash write and the counter run in one script (`register_script`/`eval`, `defineCommand`, `NewScript`, `jedis.eval`, `redis.eval`), so a reader between two commands cannot see a part without its bytes and a second server cannot count the same part; nothing writes the hash or the counter outside it.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCRBY/], none: [/\br\.(hset|hsetnx|incrby)\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCRBY/], none: [/redis\.(hset|hsetnx|incrby)\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /INCRBY/], none: [/\.(HSet|HSetNX|IncrBy)\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /INCRBY/], none: [/jedis\.(hset|hsetnx|incrBy)\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /INCRBY/], none: [/redis\.(hset|hsetnx|incrby)\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'An abandoned manifest expires after 24 hours',
      detail:
        'The script sets `EXPIRE` on both keys with `MANIFEST_TTL_S` (24 hours), so a manifest lives 24 hours past its last registration; the starter sets no expiry and abandoned uploads stay in Redis.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /MANIFEST_TTL_S/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /MANIFEST_TTL_S/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /manifestTTL/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /ManifestTtlSeconds/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /kManifestTtlSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def parts_key(upload_id: str) -> str:
    return f"upload:{upload_id}:parts"


def bytes_key(upload_id: str) -> str:
    return f"upload:{upload_id}:bytes"


def register_part(upload_id: str, part_number: int, part_count: int, size: int, checksum: str) -> int:
    """1: registered; 0: already registered; -1: part_number outside 1..part_count."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    r.hset(parts_key(upload_id), part_number, f"{size}:{checksum}")
    r.incrby(bytes_key(upload_id), size)
    return 1


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
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MANIFEST_TTL_S = 24 * 60 * 60

# KEYS: parts hash, byte counter. ARGV: part number, part count, size, checksum, TTL.
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
    # One script: no client sees the part without its bytes, and a retried part is counted once.
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
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Part {
  part_number: number;
  size: number;
  checksum: string;
}

export const partsKey = (uploadId: string): string => \`upload:\${uploadId}:parts\`;
export const bytesKey = (uploadId: string): string => \`upload:\${uploadId}:bytes\`;

/** 1: registered; 0: already registered; -1: partNumber outside 1..partCount. */
export async function registerPart(uploadId: string, partNumber: number, partCount: number, size: number, checksum: string): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await redis.hset(partsKey(uploadId), String(partNumber), \`\${size}:\${checksum}\`);
  await redis.incrby(bytesKey(uploadId), size);
  return 1;
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
      solution: `import Redis from 'ioredis';

export const MANIFEST_TTL_S = 24 * 60 * 60;

// KEYS: parts hash, byte counter. ARGV: part number, part count, size, checksum, TTL.
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
  // One script: no client sees the part without its bytes, and a retried part is counted once.
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
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Part is one registered part.
type Part struct {
	PartNumber int    \`json:"part_number"\`
	Size       int64  \`json:"size"\`
	Checksum   string \`json:"checksum"\`
}

func partsKey(uploadID string) string { return "upload:" + uploadID + ":parts" }
func bytesKey(uploadID string) string { return "upload:" + uploadID + ":bytes" }

// registerPart answers 1 when the part is registered, 0 when it already was, -1 when partNumber is outside 1..partCount.
func registerPart(ctx context.Context, uploadID string, partNumber, partCount int, size int64, checksum string) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if err := rdb.HSet(ctx, partsKey(uploadID), strconv.Itoa(partNumber), fmt.Sprintf("%d:%s", size, checksum)).Err(); err != nil {
		return 0, err
	}
	if err := rdb.IncrBy(ctx, bytesKey(uploadID), size).Err(); err != nil {
		return 0, err
	}
	return 1, nil
}

// readParts lists the registered parts by part number.
func readParts(ctx context.Context, uploadID string) ([]Part, error) {
	raw, err := rdb.HGetAll(ctx, partsKey(uploadID)).Result()
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

// uploadedBytes is the bytes of the registered parts.
func uploadedBytes(ctx context.Context, uploadID string) (int64, error) {
	n, err := rdb.Get(ctx, bytesKey(uploadID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}
`,
      solution: `package main

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const manifestTTL = 24 * time.Hour

// registerPartScript: KEYS parts hash, byte counter; ARGV part number, part count, size, checksum, TTL.
var registerPartScript = redis.NewScript(\`
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

func partsKey(uploadID string) string { return "upload:" + uploadID + ":parts" }
func bytesKey(uploadID string) string { return "upload:" + uploadID + ":bytes" }

// registerPart answers 1 when the part is registered, 0 when it already was, -1 when partNumber is outside 1..partCount.
func registerPart(ctx context.Context, uploadID string, partNumber, partCount int, size int64, checksum string) (int64, error) {
	// One script: no client sees the part without its bytes, and a retried part is counted once.
	keys := []string{partsKey(uploadID), bytesKey(uploadID)}
	return registerPartScript.Run(ctx, rdb, keys, partNumber, partCount, size, checksum, int(manifestTTL.Seconds())).Int64()
}

// readParts lists the registered parts by part number.
func readParts(ctx context.Context, uploadID string) ([]Part, error) {
	raw, err := rdb.HGetAll(ctx, partsKey(uploadID)).Result()
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

// uploadedBytes is the bytes of the registered parts.
func uploadedBytes(ctx context.Context, uploadID string) (int64, error) {
	n, err := rdb.Get(ctx, bytesKey(uploadID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Part(partNumber: Int, size: Long, checksum: String)

  val jedis = new JedisPooled("redis", 6379)

  def partsKey(uploadId: String): String = s"upload:$uploadId:parts"
  def bytesKey(uploadId: String): String = s"upload:$uploadId:bytes"

  /** 1: registered; 0: already registered; -1: partNumber outside 1..partCount. */
  def registerPart(uploadId: String, partNumber: Int, partCount: Int, size: Long, checksum: String): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    jedis.hset(partsKey(uploadId), partNumber.toString, s"$size:$checksum")
    jedis.incrBy(bytesKey(uploadId), size)
    1L
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
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Part(partNumber: Int, size: Long, checksum: String)

  val jedis = new JedisPooled("redis", 6379)

  val ManifestTtlSeconds: Long = 24L * 60 * 60

  /** KEYS: parts hash, byte counter. ARGV: part number, part count, size, checksum, TTL. */
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
    // One script: no client sees the part without its bytes, and a retried part is counted once.
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
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

struct Part {
  int part_number = 0;
  long long size = 0;
  std::string checksum;
};

std::string partsKey(const std::string& upload_id) { return "upload:" + upload_id + ":parts"; }
std::string bytesKey(const std::string& upload_id) { return "upload:" + upload_id + ":bytes"; }

// 1: registered; 0: already registered; -1: part_number outside 1..part_count.
long long registerPart(const std::string& upload_id, int part_number, int part_count, long long size, const std::string& checksum) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  redis.hset(partsKey(upload_id), std::to_string(part_number), std::to_string(size) + ":" + checksum);
  redis.incrby(bytesKey(upload_id), size);
  return 1;
}

// The registered parts, by part number.
std::vector<Part> readParts(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall(partsKey(upload_id));
  std::vector<Part> parts;
  for (const auto& [number, value] : raw) {
    const auto at = value.find(':');
    parts.push_back(Part{std::stoi(number), std::stoll(value.substr(0, at)), value.substr(at + 1)});
  }
  std::sort(parts.begin(), parts.end(), [](const Part& a, const Part& b) { return a.part_number < b.part_number; });
  return parts;
}

// The bytes of the registered parts.
long long uploadedBytes(const std::string& upload_id) {
  const auto value = redis.get(bytesKey(upload_id));
  return value ? std::stoll(*value) : 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kManifestTtlSeconds = 24 * 60 * 60;

// KEYS: parts hash, byte counter. ARGV: part number, part count, size, checksum, TTL.
const std::string kRegisterPartLua = R"lua(
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

std::string partsKey(const std::string& upload_id) { return "upload:" + upload_id + ":parts"; }
std::string bytesKey(const std::string& upload_id) { return "upload:" + upload_id + ":bytes"; }

// 1: registered; 0: already registered; -1: part_number outside 1..part_count.
long long registerPart(const std::string& upload_id, int part_number, int part_count, long long size, const std::string& checksum) {
  // One script: no client sees the part without its bytes, and a retried part is counted once.
  return redis.eval<long long>(kRegisterPartLua, {partsKey(upload_id), bytesKey(upload_id)},
                               {std::to_string(part_number), std::to_string(part_count), std::to_string(size), checksum,
                                std::to_string(kManifestTtlSeconds)});
}

// The registered parts, by part number.
std::vector<Part> readParts(const std::string& upload_id) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall(partsKey(upload_id));
  std::vector<Part> parts;
  for (const auto& [number, value] : raw) {
    const auto at = value.find(':');
    parts.push_back(Part{std::stoi(number), std::stoll(value.substr(0, at)), value.substr(at + 1)});
  }
  std::sort(parts.begin(), parts.end(), [](const Part& a, const Part& b) { return a.part_number < b.part_number; });
  return parts;
}

// The bytes of the registered parts.
long long uploadedBytes(const std::string& upload_id) {
  const auto value = redis.get(bytesKey(upload_id));
  return value ? std::stoll(*value) : 0;
}
`,
    },
  },
  harness: {
    python: `PARTS = "upload:u-1:parts"
COUNTER = "upload:u-1:bytes"


def _snapshot(ctx):
    """(bytes of the parts in the hash, the counter) as another client reads them right now."""
    sizes = [int(value.split(":", 1)[0]) for value in ctx.redis.hgetall(PARTS).values()]
    return sum(sizes), int(ctx.redis.get(COUNTER) or 0)


def check_once(ctx):
    m = ctx.load("state")
    first = m.register_part("u-1", 1, 3, 5, "c1")
    assert first == 1, f"registering part 1 answered {first!r}, expected 1"
    again = m.register_part("u-1", 1, 3, 5, "c1")
    assert again == 0, f"re-sending part 1 answered {again!r}, expected 0: the part is already registered"
    assert m.uploaded_bytes("u-1") == 5, f"one 5-byte part sent twice is counted as {m.uploaded_bytes('u-1')} bytes: a re-sent part must not be counted again"
    assert m.register_part("u-1", 2, 3, 5, "c2") == 1, "a new part 2 must answer 1"
    parts = m.read_parts("u-1")
    assert parts == [{"part_number": 1, "size": 5, "checksum": "c1"}, {"part_number": 2, "size": 5, "checksum": "c2"}], f"read_parts gives {parts}"
    assert m.uploaded_bytes("u-1") == 10, f"two 5-byte parts are counted as {m.uploaded_bytes('u-1')} bytes"


def check_range(ctx):
    m = ctx.load("state")
    for number in (0, 4, -1):
        got = m.register_part("u-1", number, 3, 5, "cx")
        assert got == -1, f"part {number} of a 3-part upload answered {got!r}, expected -1: it is outside 1..part_count"
    assert ctx.redis.exists(PARTS, COUNTER) == 0, f"a refused part number left {sorted(ctx.redis.keys('upload:u-1*'))} in Redis: nothing may be written"
    assert m.register_part("u-1", 3, 3, 5, "c3") == 1, "the last part (3 of 3) is in range and must answer 1"


def check_atomic(ctx):
    m = ctx.load("state")
    m.register_part("u-1", 1, 3, 5, "c1")
    seen = []

    def other_server():
        seen.append(_snapshot(ctx))
        return m.register_part("u-1", 2, 3, 5, "c2")  # the same retried part, through another server

    rival = ctx.redis_after(PARTS, other_server)
    ctx.redis_after(COUNTER, lambda: seen.append(_snapshot(ctx)))
    mine = m.register_part("u-1", 2, 3, 5, "c2")
    assert rival.fired, "register_part never touched upload:u-1:parts"
    if rival.error is not None:
        raise rival.error
    for parts, counted in seen:
        assert parts == counted, f"a reader between two of register_part's commands saw parts of {parts} bytes and a counter of {counted}: the hash and the counter must change in one step"
    assert sorted([mine, rival.result]) == [0, 1], f"two registrations of part 2 at once answered {mine!r} and {rival.result!r}: exactly one of them registers it"
    assert m.uploaded_bytes("u-1") == 10, f"after part 2 was registered twice at once the counter holds {m.uploaded_bytes('u-1')} bytes, expected 10"


def check_ttl(ctx):
    m = ctx.load("state")
    m.register_part("u-1", 1, 3, 5, "c1")
    for key in (PARTS, COUNTER):
        ttl = ctx.redis.ttl(key)
        assert 86000 <= ttl <= 86400, f"{key} has TTL {ttl} after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own"
    ctx.clock.advance(12 * 3600)
    m.register_part("u-1", 2, 3, 5, "c2")
    assert ctx.redis.ttl(PARTS) > 86000, f"a registration 12 hours later left {PARTS} with TTL {ctx.redis.ttl(PARTS)}: the manifest lives 24 hours after its last registration"
    ctx.clock.advance(86401)
    assert ctx.redis.exists(PARTS, COUNTER) == 0, f"24 hours after the last registration Redis still holds {sorted(ctx.redis.keys('upload:u-1*'))}"
`,
    typescript: `const PARTS = 'upload:u-1:parts';
const COUNTER = 'upload:u-1:bytes';

/** [bytes of the parts in the hash, the counter] as another client reads them right now. */
function snapshot(ctx): [number, number] {
  const raw = ctx.redis.hgetall(PARTS) as Record<string, string>;
  const parts = Object.values(raw).reduce((sum, value) => sum + Number(value.split(':')[0]), 0);
  return [parts, Number(ctx.redis.get(COUNTER) ?? 0)];
}

export async function check_once(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.registerPart('u-1', 1, 3, 5, 'c1'), 1, 'registering part 1 must answer 1');
  const again = await m.registerPart('u-1', 1, 3, 5, 'c1');
  assert.equal(again, 0, \`re-sending part 1 answered \${again}, expected 0: the part is already registered\`);
  assert.equal(await m.uploadedBytes('u-1'), 5, \`one 5-byte part sent twice is counted as \${await m.uploadedBytes('u-1')} bytes: a re-sent part must not be counted again\`);
  assert.equal(await m.registerPart('u-1', 2, 3, 5, 'c2'), 1, 'a new part 2 must answer 1');
  const parts = await m.readParts('u-1');
  assert.deepStrictEqual(parts, [{part_number: 1, size: 5, checksum: 'c1'}, {part_number: 2, size: 5, checksum: 'c2'}], \`readParts gives \${JSON.stringify(parts)}\`);
  assert.equal(await m.uploadedBytes('u-1'), 10, 'two 5-byte parts must be counted as 10 bytes');
}

export async function check_range(ctx) {
  const m = ctx.load('state');
  for (const n of [0, 4, -1]) {
    const got = await m.registerPart('u-1', n, 3, 5, 'cx');
    assert.equal(got, -1, \`part \${n} of a 3-part upload answered \${got}, expected -1: it is outside 1..partCount\`);
  }
  assert.equal(ctx.redis.exists(PARTS, COUNTER), 0, \`a refused part number left \${JSON.stringify(ctx.redis.keys('upload:u-1*'))} in Redis: nothing may be written\`);
  assert.equal(await m.registerPart('u-1', 3, 3, 5, 'c3'), 1, 'the last part (3 of 3) is in range and must answer 1');
}

export async function check_atomic(ctx) {
  const m = ctx.load('state');
  await m.registerPart('u-1', 1, 3, 5, 'c1');
  const seen: [number, number][] = [];
  const rival = ctx.redisAfter(PARTS, () => {
    seen.push(snapshot(ctx));
    return m.registerPart('u-1', 2, 3, 5, 'c2'); // the same retried part, through another server
  });
  ctx.redisAfter(COUNTER, () => seen.push(snapshot(ctx)));
  const mine = await m.registerPart('u-1', 2, 3, 5, 'c2');
  assert(rival.fired, 'registerPart never touched upload:u-1:parts');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  for (const [parts, counted] of seen) {
    assert.equal(parts, counted, \`a reader between two of registerPart's commands saw parts of \${parts} bytes and a counter of \${counted}: the hash and the counter must change in one step\`);
  }
  assert.deepStrictEqual([mine, theirs].sort(), [0, 1], \`two registrations of part 2 at once answered \${mine} and \${theirs}: exactly one of them registers it\`);
  assert.equal(await m.uploadedBytes('u-1'), 10, \`after part 2 was registered twice at once the counter holds \${await m.uploadedBytes('u-1')} bytes, expected 10\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('state');
  await m.registerPart('u-1', 1, 3, 5, 'c1');
  for (const key of [PARTS, COUNTER]) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 86000 && ttl <= 86400, \`\${key} has TTL \${ttl} after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own\`);
  }
  ctx.clock.advance(12 * 3600);
  await m.registerPart('u-1', 2, 3, 5, 'c2');
  assert(ctx.redis.ttl(PARTS) > 86000, \`a registration 12 hours later left \${PARTS} with TTL \${ctx.redis.ttl(PARTS)}: the manifest lives 24 hours after its last registration\`);
  ctx.clock.advance(86401);
  assert.equal(ctx.redis.exists(PARTS, COUNTER), 0, \`24 hours after the last registration Redis still holds \${JSON.stringify(ctx.redis.keys('upload:u-1*'))}\`);
}
`,
    go: `package main

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	partsHash  = "upload:u-1:parts"
	counterKey = "upload:u-1:bytes"
)

var stateBg = context.Background()

// snapshot is [bytes of the parts in the hash, the counter] as another client reads them right now.
func snapshot(ctx *harness.Ctx) [2]int64 {
	var parts int64
	for _, value := range ctx.Redis.HGetAll(partsHash) {
		size, _, _ := strings.Cut(value, ":")
		n, _ := strconv.ParseInt(size, 10, 64)
		parts += n
	}
	raw, _ := ctx.Redis.Get(counterKey)
	counted, _ := strconv.ParseInt(raw, 10, 64)
	return [2]int64{parts, counted}
}

func mustRegister(ctx *harness.Ctx, n, count int, checksum string) int64 {
	got, err := registerPart(stateBg, "u-1", n, count, 5, checksum)
	ctx.NoError(err, "registerPart(u-1, %d, %d, 5, %s)", n, count, checksum)
	return got
}

func counted(ctx *harness.Ctx) int64 {
	n, err := uploadedBytes(stateBg, "u-1")
	ctx.NoError(err, "uploadedBytes(u-1)")
	return n
}

func CheckOnce(ctx *harness.Ctx) {
	ctx.Equal(mustRegister(ctx, 1, 3, "c1"), int64(1), "registering part 1")
	ctx.Equal(mustRegister(ctx, 1, 3, "c1"), int64(0), "re-sending part 1 must answer 0 (the part is already registered)")
	ctx.Equal(counted(ctx), int64(5), "one 5-byte part sent twice must be counted once; the counted bytes")
	ctx.Equal(mustRegister(ctx, 2, 3, "c2"), int64(1), "a new part 2")
	parts, err := readParts(stateBg, "u-1")
	ctx.NoError(err, "readParts(u-1)")
	ctx.Equal(parts, []Part{{PartNumber: 1, Size: 5, Checksum: "c1"}, {PartNumber: 2, Size: 5, Checksum: "c2"}}, "readParts")
	ctx.Equal(counted(ctx), int64(10), "two 5-byte parts; the counted bytes")
}

func CheckRange(ctx *harness.Ctx) {
	for _, n := range []int{0, 4, -1} {
		ctx.Equal(mustRegister(ctx, n, 3, "cx"), int64(-1), "part %d of a 3-part upload is outside 1..partCount", n)
	}
	ctx.Equal(ctx.Redis.Exists(partsHash, counterKey), int64(0), "a refused part number must write nothing (Redis holds %q); the keys", ctx.Redis.Keys("upload:u-1*"))
	ctx.Equal(mustRegister(ctx, 3, 3, "c3"), int64(1), "the last part (3 of 3) is in range")
}

func CheckAtomic(ctx *harness.Ctx) {
	mustRegister(ctx, 1, 3, "c1")
	var seen [][2]int64
	rival := ctx.Redis.After(partsHash, func() any {
		seen = append(seen, snapshot(ctx))
		got, err := registerPart(stateBg, "u-1", 2, 3, 5, "c2") // the same retried part, through another server
		ctx.NoError(err, "the other server's registerPart")
		return got
	})
	ctx.Redis.After(counterKey, func() any {
		seen = append(seen, snapshot(ctx))
		return nil
	})
	mine := mustRegister(ctx, 2, 3, "c2")
	ctx.Assert(rival.Fired, "registerPart never touched upload:u-1:parts")
	ctx.Assert(rival.Err == nil, "the other server's registerPart failed: %v", rival.Err)
	for _, s := range seen {
		ctx.Assert(s[0] == s[1], "a reader between two of registerPart's commands saw parts of %d bytes and a counter of %d: the hash and the counter must change in one step", s[0], s[1])
	}
	theirs, _ := rival.Result.(int64)
	results := []int64{mine, theirs}
	sort.Slice(results, func(i, j int) bool { return results[i] < results[j] })
	ctx.Equal(results, []int64{0, 1}, "two registrations of part 2 at once: exactly one of them registers it; the answers")
	ctx.Equal(counted(ctx), int64(10), "after part 2 was registered twice at once; the counted bytes")
}

func CheckTtl(ctx *harness.Ctx) {
	mustRegister(ctx, 1, 3, "c1")
	for _, key := range []string{partsHash, counterKey} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 86000 && ttl <= 86400, "%s has TTL %d after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own", key, ttl)
	}
	ctx.Clock.Advance(12 * 3600)
	mustRegister(ctx, 2, 3, "c2")
	ctx.Assert(ctx.Redis.TTL(partsHash) > 86000, "a registration 12 hours later left %s with TTL %d: the manifest lives 24 hours after its last registration", partsHash, ctx.Redis.TTL(partsHash))
	ctx.Clock.Advance(86401)
	ctx.Equal(ctx.Redis.Exists(partsHash, counterKey), int64(0), "24 hours after the last registration Redis still holds %q; the keys", ctx.Redis.Keys("upload:u-1*"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kParts = "upload:u-1:parts";
const std::string kCounter = "upload:u-1:bytes";

// (bytes of the parts in the hash, the counter) as another client reads them right now.
std::pair<long long, long long> snapshot(harness::Ctx& ctx) {
  long long parts = 0;
  for (const auto& [number, value] : ctx.Redis.HGetAll(kParts)) parts += std::stoll(value.substr(0, value.find(':')));
  const auto raw = ctx.Redis.Get(kCounter);
  return {parts, raw ? std::stoll(*raw) : 0};
}

struct Rival {
  bool fired = false;
  long long result = -9;
  std::optional<std::string> err;
};

}  // namespace

void CheckOnce(harness::Ctx& ctx) {
  ctx.Equal(registerPart("u-1", 1, 3, 5, "c1"), 1LL, "registering part 1");
  ctx.Equal(registerPart("u-1", 1, 3, 5, "c1"), 0LL, "re-sending part 1 must answer 0 (the part is already registered)");
  ctx.Equal(uploadedBytes("u-1"), 5LL, "one 5-byte part sent twice must be counted once; the counted bytes");
  ctx.Equal(registerPart("u-1", 2, 3, 5, "c2"), 1LL, "a new part 2");
  const auto parts = readParts("u-1");
  ctx.Assert(parts.size() == 2 && parts[0].part_number == 1 && parts[0].size == 5 && parts[0].checksum == "c1" && parts[1].part_number == 2 &&
                 parts[1].checksum == "c2",
             "readParts gives %d parts, expected parts 1 (5, c1) and 2 (5, c2)", parts.size());
  ctx.Equal(uploadedBytes("u-1"), 10LL, "two 5-byte parts; the counted bytes");
}

void CheckRange(harness::Ctx& ctx) {
  for (const int n : {0, 4, -1}) ctx.Equal(registerPart("u-1", n, 3, 5, "cx"), -1LL, "part %d of a 3-part upload is outside 1..part_count", n);
  ctx.Equal(ctx.Redis.Exists(kParts, kCounter), 0LL, "a refused part number must write nothing (Redis holds %q); the keys", ctx.Redis.Keys("upload:u-1*"));
  ctx.Equal(registerPart("u-1", 3, 3, 5, "c3"), 1LL, "the last part (3 of 3) is in range");
}

void CheckAtomic(harness::Ctx& ctx) {
  registerPart("u-1", 1, 3, 5, "c1");
  auto seen = std::make_shared<std::vector<std::pair<long long, long long>>>();
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(kParts, [&ctx, seen, rival] {
    rival->fired = true;
    seen->push_back(snapshot(ctx));
    try {
      rival->result = registerPart("u-1", 2, 3, 5, "c2");  // the same retried part, through another server
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  ctx.Redis.After(kCounter, [&ctx, seen] { seen->push_back(snapshot(ctx)); });
  const long long mine = registerPart("u-1", 2, 3, 5, "c2");
  ctx.Assert(rival->fired, "registerPart never touched upload:u-1:parts");
  ctx.Assert(!rival->err, "the other server's registerPart failed: %s", rival->err.value_or(""));
  for (const auto& [parts, counted] : *seen) {
    ctx.Assert(parts == counted, "a reader between two of registerPart's commands saw parts of %d bytes and a counter of %d: the hash and the counter must change in one step", parts, counted);
  }
  ctx.Assert(std::min(mine, rival->result) == 0 && std::max(mine, rival->result) == 1, "two registrations of part 2 at once answered %d and %d: exactly one of them registers it", mine, rival->result);
  ctx.Equal(uploadedBytes("u-1"), 10LL, "after part 2 was registered twice at once; the counted bytes");
}

void CheckTtl(harness::Ctx& ctx) {
  registerPart("u-1", 1, 3, 5, "c1");
  for (const std::string& key : {kParts, kCounter}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 86000 && ttl <= 86400, "%s has TTL %d after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own", key, ttl);
  }
  ctx.Clock.Advance(12 * 3600);
  registerPart("u-1", 2, 3, 5, "c2");
  ctx.Assert(ctx.Redis.TTL(kParts) > 86000, "a registration 12 hours later left %s with TTL %d: the manifest lives 24 hours after its last registration", kParts, ctx.Redis.TTL(kParts));
  ctx.Clock.Advance(86401);
  ctx.Equal(ctx.Redis.Exists(kParts, kCounter), 0LL, "24 hours after the last registration Redis still holds %q; the keys", ctx.Redis.Keys("upload:u-1*"));
}
`,
  },
  hints: [
    'Register part 1, then register it again: the byte count doubles. Part 0 and part 4 of a three-part upload are registered too, and the keys of an upload nobody finished never leave Redis.',
    'HSET overwrites and INCRBY adds whatever happened before, and they are two commands: a reader or a second server can land between them. Nothing compares the number with part_count or sets a TTL.',
    'One Lua script: return -1 when `n < 1 or n > part_count`; `HSETNX` the entry, return 0 when it existed; else `INCRBY` the counter, `EXPIRE` both keys with `MANIFEST_TTL_S`, return 1. Call it through `register_script`.',
  ],
  debrief: `The manifest is the server's memory of what it holds, and a resume is only as good as that memory, so a part has to be counted exactly once however many times the client sends it. HSETNX gives the deduplication; the script around it gives the atomicity, because the existence check, the entry and the counter must be one step for both a second writer and a reader. Refreshing the TTL on every registration keeps an active upload alive while an abandoned one disappears a day after its last part. Production services record which server stored each part, keep the TTL beside the upload record so the two expire together, and sweep the object store for parts whose manifest expired.`,
};
