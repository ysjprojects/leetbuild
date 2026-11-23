import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A Redis part manifest that registers each part once',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
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
        'Registering a part that is already in the hash answers 0 and leaves the hash and the byte counter alone, even when it comes with another size or checksum (`HSETNX`, or `HEXISTS` before writing); the starter overwrites the entry and adds the size again.',
      match: {
        python: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
        typescript: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
        go: {all: [/HSETNX|HEXISTS|HSetNX|HExists/]},
        cpp: {all: [/HSETNX|HEXISTS|hsetnx|hexists/]},
      },
    },
    {
      id: 'range',
      title: 'Refuses a part number outside 1..part_count',
      detail:
        'A part number below 1 or above `part_count` answers -1 and writes nothing, the bounds compared as numbers (part 10 of 12 is in range); the starter registers any number, so a client bug leaves entries no object will ever hold.',
      match: {
        python: {all: [/return\s+-1\b/]},
        typescript: {all: [/return\s+-1\b/]},
        go: {all: [/return\s+-1\b/]},
        cpp: {all: [/return\s+-1\b/]},
      },
    },
    {
      id: 'atomic',
      title: 'Registers a part in one Lua script',
      detail:
        'The check, the hash write and the counter run in one script (`register_script`/`eval`, `defineCommand`, `NewScript`, `redis.eval`), so a reader between two commands cannot see a part without its bytes and a second server cannot count the same part; nothing writes the hash or the counter outside it.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCRBY/], none: [/\br\.(hset|hsetnx|incrby)\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCRBY/], none: [/redis\.(hset|hsetnx|incrby)\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /INCRBY/], none: [/\.(HSet|HSetNX|IncrBy)\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /INCRBY/], none: [/redis\.(hset|hsetnx|incrby)\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'An abandoned manifest expires after 24 hours',
      detail:
        'The script itself sets `EXPIRE` on both keys with `MANIFEST_TTL_S` (24 hours), so neither key is ever without its TTL and a manifest lives 24 hours past its last registration; the starter sets no expiry and abandoned uploads stay in Redis.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /MANIFEST_TTL_S/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /MANIFEST_TTL_S/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/i, /manifestTTL/]},
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
    other = m.register_part("u-1", 1, 3, 7, "c9")
    assert other == 0, f"re-sending part 1 with another size and checksum answered {other!r}, expected 0: the part is already registered"
    assert m.uploaded_bytes("u-1") == 5, f"one 5-byte part sent three times is counted as {m.uploaded_bytes('u-1')} bytes: a re-sent part must not be counted again"
    assert m.register_part("u-1", 2, 3, 5, "c2") == 1, "a new part 2 must answer 1"
    parts = m.read_parts("u-1")
    assert parts == [{"part_number": 1, "size": 5, "checksum": "c1"}, {"part_number": 2, "size": 5, "checksum": "c2"}], f"read_parts gives {parts}, expected part 1 as first registered (5, c1): a re-sent part changes nothing"
    assert m.uploaded_bytes("u-1") == 10, f"two 5-byte parts are counted as {m.uploaded_bytes('u-1')} bytes"


def check_range(ctx):
    m = ctx.load("state")
    for number in (0, 4, -1):
        got = m.register_part("u-1", number, 3, 5, "cx")
        assert got == -1, f"part {number} of a 3-part upload answered {got!r}, expected -1: it is outside 1..part_count"
    assert ctx.redis.exists(PARTS, COUNTER) == 0, f"a refused part number left {sorted(ctx.redis.keys('upload:u-1*'))} in Redis: nothing may be written"
    assert m.register_part("u-1", 3, 3, 5, "c3") == 1, "the last part (3 of 3) is in range and must answer 1"
    for number, expected in ((2, 1), (10, 1), (12, 1), (13, -1)):
        got = m.register_part("u-2", number, 12, 5, f"c{number}")
        assert got == expected, f"part {number} of a 12-part upload answered {got!r}, expected {expected}: the range compares numbers, not strings"


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
    first = ctx.redis_after(PARTS, lambda: (ctx.redis.ttl(PARTS), ctx.redis.ttl(COUNTER)))
    m.register_part("u-1", 1, 3, 5, "c1")
    assert first.fired, "register_part never touched upload:u-1:parts"
    for key, ttl in zip((PARTS, COUNTER), first.result):
        assert 86000 <= ttl <= 86400, f"right after the registration wrote it, {key} had TTL {ttl}, expected 24 hours (86400 s) set in the same script: an abandoned upload must leave Redis on its own"
    for key in (PARTS, COUNTER):
        ttl = ctx.redis.ttl(key)
        assert 86000 <= ttl <= 86400, f"{key} has TTL {ttl} after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own"
    ctx.clock.advance(12 * 3600)
    m.register_part("u-1", 2, 3, 5, "c2")
    for key in (PARTS, COUNTER):
        assert ctx.redis.ttl(key) > 86000, f"a registration 12 hours later left {key} with TTL {ctx.redis.ttl(key)}: the manifest lives 24 hours after its last registration"
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
  const other = await m.registerPart('u-1', 1, 3, 7, 'c9');
  assert.equal(other, 0, \`re-sending part 1 with another size and checksum answered \${other}, expected 0: the part is already registered\`);
  assert.equal(await m.uploadedBytes('u-1'), 5, \`one 5-byte part sent three times is counted as \${await m.uploadedBytes('u-1')} bytes: a re-sent part must not be counted again\`);
  assert.equal(await m.registerPart('u-1', 2, 3, 5, 'c2'), 1, 'a new part 2 must answer 1');
  const parts = await m.readParts('u-1');
  assert.deepStrictEqual(parts, [{part_number: 1, size: 5, checksum: 'c1'}, {part_number: 2, size: 5, checksum: 'c2'}], \`readParts gives \${JSON.stringify(parts)}, expected part 1 as first registered (5, c1): a re-sent part changes nothing\`);
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
  for (const [n, expected] of [[2, 1], [10, 1], [12, 1], [13, -1]]) {
    const got = await m.registerPart('u-2', n, 12, 5, \`c\${n}\`);
    assert.equal(got, expected, \`part \${n} of a 12-part upload answered \${got}, expected \${expected}: the range compares numbers, not strings\`);
  }
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
  const first = ctx.redisAfter(PARTS, () => [ctx.redis.ttl(PARTS), ctx.redis.ttl(COUNTER)]);
  await m.registerPart('u-1', 1, 3, 5, 'c1');
  assert(first.fired, 'registerPart never touched upload:u-1:parts');
  const ttls = (await first.result) as number[];
  [PARTS, COUNTER].forEach((key, i) => {
    assert(ttls[i] >= 86000 && ttls[i] <= 86400, \`right after the registration wrote it, \${key} had TTL \${ttls[i]}, expected 24 hours (86400 s) set in the same script: an abandoned upload must leave Redis on its own\`);
  });
  for (const key of [PARTS, COUNTER]) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl >= 86000 && ttl <= 86400, \`\${key} has TTL \${ttl} after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own\`);
  }
  ctx.clock.advance(12 * 3600);
  await m.registerPart('u-1', 2, 3, 5, 'c2');
  for (const key of [PARTS, COUNTER]) {
    assert(ctx.redis.ttl(key) > 86000, \`a registration 12 hours later left \${key} with TTL \${ctx.redis.ttl(key)}: the manifest lives 24 hours after its last registration\`);
  }
  ctx.clock.advance(86401);
  assert.equal(ctx.redis.exists(PARTS, COUNTER), 0, \`24 hours after the last registration Redis still holds \${JSON.stringify(ctx.redis.keys('upload:u-1*'))}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	hPartsHash  = "upload:u-1:parts"
	hCounterKey = "upload:u-1:bytes"
)

var hStateBg = context.Background()

// hSnapshot is [bytes of the parts in the hash, the counter] as another client reads them right now.
func hSnapshot(ctx *harness.Ctx) [2]int64 {
	var parts int64
	for _, value := range ctx.Redis.HGetAll(hPartsHash) {
		size, _, _ := strings.Cut(value, ":")
		n, _ := strconv.ParseInt(size, 10, 64)
		parts += n
	}
	raw, _ := ctx.Redis.Get(hCounterKey)
	hCounted, _ := strconv.ParseInt(raw, 10, 64)
	return [2]int64{parts, hCounted}
}

func hMustRegister(ctx *harness.Ctx, n, count int, checksum string) int64 {
	got, err := registerPart(hStateBg, "u-1", n, count, 5, checksum)
	ctx.NoError(err, "registerPart(u-1, %d, %d, 5, %s)", n, count, checksum)
	return got
}

func hCounted(ctx *harness.Ctx) int64 {
	n, err := uploadedBytes(hStateBg, "u-1")
	ctx.NoError(err, "uploadedBytes(u-1)")
	return n
}

func CheckOnce(ctx *harness.Ctx) {
	ctx.Equal(hMustRegister(ctx, 1, 3, "c1"), int64(1), "registering part 1")
	ctx.Equal(hMustRegister(ctx, 1, 3, "c1"), int64(0), "re-sending part 1 must answer 0 (the part is already registered)")
	other, err := registerPart(hStateBg, "u-1", 1, 3, 7, "c9")
	ctx.NoError(err, "registerPart(u-1, 1, 3, 7, c9)")
	ctx.Equal(other, int64(0), "re-sending part 1 with another size and checksum must answer 0 (the part is already registered)")
	ctx.Equal(hCounted(ctx), int64(5), "one 5-byte part sent three times must be counted once; the counted bytes")
	ctx.Equal(hMustRegister(ctx, 2, 3, "c2"), int64(1), "a new part 2")
	parts, err := readParts(hStateBg, "u-1")
	ctx.NoError(err, "readParts(u-1)")
	ctx.Equal(parts, []Part{{PartNumber: 1, Size: 5, Checksum: "c1"}, {PartNumber: 2, Size: 5, Checksum: "c2"}}, "readParts (part 1 as first registered, 5 and c1: a re-sent part changes nothing)")
	ctx.Equal(hCounted(ctx), int64(10), "two 5-byte parts; the counted bytes")
}

func CheckRange(ctx *harness.Ctx) {
	for _, n := range []int{0, 4, -1} {
		ctx.Equal(hMustRegister(ctx, n, 3, "cx"), int64(-1), "part %d of a 3-part upload is outside 1..partCount", n)
	}
	ctx.Equal(ctx.Redis.Exists(hPartsHash, hCounterKey), int64(0), "a refused part number must write nothing (Redis holds %q); the keys", ctx.Redis.Keys("upload:u-1*"))
	ctx.Equal(hMustRegister(ctx, 3, 3, "c3"), int64(1), "the last part (3 of 3) is in range")
	for _, tc := range [][2]int{{2, 1}, {10, 1}, {12, 1}, {13, -1}} {
		got, err := registerPart(hStateBg, "u-2", tc[0], 12, 5, fmt.Sprintf("c%d", tc[0]))
		ctx.NoError(err, "registerPart(u-2, %d, 12)", tc[0])
		ctx.Equal(got, int64(tc[1]), "part %d of a 12-part upload (the range compares numbers, not strings)", tc[0])
	}
}

func CheckAtomic(ctx *harness.Ctx) {
	hMustRegister(ctx, 1, 3, "c1")
	var seen [][2]int64
	rival := ctx.Redis.After(hPartsHash, func() any {
		seen = append(seen, hSnapshot(ctx))
		got, err := registerPart(hStateBg, "u-1", 2, 3, 5, "c2") // the same retried part, through another server
		ctx.NoError(err, "the other server's registerPart")
		return got
	})
	ctx.Redis.After(hCounterKey, func() any {
		seen = append(seen, hSnapshot(ctx))
		return nil
	})
	mine := hMustRegister(ctx, 2, 3, "c2")
	ctx.Assert(rival.Fired, "registerPart never touched upload:u-1:parts")
	ctx.Assert(rival.Err == nil, "the other server's registerPart failed: %v", rival.Err)
	for _, s := range seen {
		ctx.Assert(s[0] == s[1], "a reader between two of registerPart's commands saw parts of %d bytes and a counter of %d: the hash and the counter must change in one step", s[0], s[1])
	}
	theirs, _ := rival.Result.(int64)
	results := []int64{mine, theirs}
	sort.Slice(results, func(i, j int) bool { return results[i] < results[j] })
	ctx.Equal(results, []int64{0, 1}, "two registrations of part 2 at once: exactly one of them registers it; the answers")
	ctx.Equal(hCounted(ctx), int64(10), "after part 2 was registered twice at once; the counted bytes")
}

func CheckTtl(ctx *harness.Ctx) {
	first := ctx.Redis.After(hPartsHash, func() any {
		return [2]int64{ctx.Redis.TTL(hPartsHash), ctx.Redis.TTL(hCounterKey)}
	})
	hMustRegister(ctx, 1, 3, "c1")
	ctx.Assert(first.Fired, "registerPart never touched upload:u-1:parts")
	ttls, _ := first.Result.([2]int64)
	for i, key := range []string{hPartsHash, hCounterKey} {
		ctx.Assert(ttls[i] >= 86000 && ttls[i] <= 86400, "right after the registration wrote it, %s had TTL %d, expected 24 hours (86400 s) set in the same script: an abandoned upload must leave Redis on its own", key, ttls[i])
	}
	for _, key := range []string{hPartsHash, hCounterKey} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 86000 && ttl <= 86400, "%s has TTL %d after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own", key, ttl)
	}
	ctx.Clock.Advance(12 * 3600)
	hMustRegister(ctx, 2, 3, "c2")
	for _, key := range []string{hPartsHash, hCounterKey} {
		ctx.Assert(ctx.Redis.TTL(key) > 86000, "a registration 12 hours later left %s with TTL %d: the manifest lives 24 hours after its last registration", key, ctx.Redis.TTL(key))
	}
	ctx.Clock.Advance(86401)
	ctx.Equal(ctx.Redis.Exists(hPartsHash, hCounterKey), int64(0), "24 hours after the last registration Redis still holds %q; the keys", ctx.Redis.Keys("upload:u-1*"))
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

const std::string kHarnessParts = "upload:u-1:parts";
const std::string kHarnessCounter = "upload:u-1:bytes";

// (bytes of the parts in the hash, the counter) as another client reads them right now.
std::pair<long long, long long> hSnapshot(harness::Ctx& ctx) {
  long long parts = 0;
  for (const auto& [number, value] : ctx.Redis.HGetAll(kHarnessParts)) parts += std::stoll(value.substr(0, value.find(':')));
  const auto raw = ctx.Redis.Get(kHarnessCounter);
  return {parts, raw ? std::stoll(*raw) : 0};
}

struct HRival {
  bool fired = false;
  long long result = -9;
  std::optional<std::string> err;
};

}  // namespace

void CheckOnce(harness::Ctx& ctx) {
  ctx.Equal(registerPart("u-1", 1, 3, 5, "c1"), 1LL, "registering part 1");
  ctx.Equal(registerPart("u-1", 1, 3, 5, "c1"), 0LL, "re-sending part 1 must answer 0 (the part is already registered)");
  ctx.Equal(registerPart("u-1", 1, 3, 7, "c9"), 0LL, "re-sending part 1 with another size and checksum must answer 0 (the part is already registered)");
  ctx.Equal(uploadedBytes("u-1"), 5LL, "one 5-byte part sent three times must be counted once; the counted bytes");
  ctx.Equal(registerPart("u-1", 2, 3, 5, "c2"), 1LL, "a new part 2");
  const auto parts = readParts("u-1");
  ctx.Assert(parts.size() == 2 && parts[0].part_number == 1 && parts[0].size == 5 && parts[0].checksum == "c1" && parts[1].part_number == 2 &&
                 parts[1].checksum == "c2",
             "readParts gives %d parts, expected parts 1 (5, c1, as first registered: a re-sent part changes nothing) and 2 (5, c2)", parts.size());
  ctx.Equal(uploadedBytes("u-1"), 10LL, "two 5-byte parts; the counted bytes");
}

void CheckRange(harness::Ctx& ctx) {
  for (const int n : {0, 4, -1}) ctx.Equal(registerPart("u-1", n, 3, 5, "cx"), -1LL, "part %d of a 3-part upload is outside 1..part_count", n);
  ctx.Equal(ctx.Redis.Exists(kHarnessParts, kHarnessCounter), 0LL, "a refused part number must write nothing (Redis holds %q); the keys", ctx.Redis.Keys("upload:u-1*"));
  ctx.Equal(registerPart("u-1", 3, 3, 5, "c3"), 1LL, "the last part (3 of 3) is in range");
  for (const auto& [n, expected] : std::vector<std::pair<int, long long>>{{2, 1}, {10, 1}, {12, 1}, {13, -1}}) {
    ctx.Equal(registerPart("u-2", n, 12, 5, "c" + std::to_string(n)), expected, "part %d of a 12-part upload (the range compares numbers, not strings)", n);
  }
}

void CheckAtomic(harness::Ctx& ctx) {
  registerPart("u-1", 1, 3, 5, "c1");
  auto seen = std::make_shared<std::vector<std::pair<long long, long long>>>();
  auto rival = std::make_shared<HRival>();
  ctx.Redis.After(kHarnessParts, [&ctx, seen, rival] {
    rival->fired = true;
    seen->push_back(hSnapshot(ctx));
    try {
      rival->result = registerPart("u-1", 2, 3, 5, "c2");  // the same retried part, through another server
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  ctx.Redis.After(kHarnessCounter, [&ctx, seen] { seen->push_back(hSnapshot(ctx)); });
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
  auto first = std::make_shared<std::vector<long long>>();
  ctx.Redis.After(kHarnessParts, [&ctx, first] {
    first->push_back(ctx.Redis.TTL(kHarnessParts));
    first->push_back(ctx.Redis.TTL(kHarnessCounter));
  });
  registerPart("u-1", 1, 3, 5, "c1");
  ctx.Assert(first->size() == 2, "registerPart never touched upload:u-1:parts");
  const std::vector<std::string> keys = {kHarnessParts, kHarnessCounter};
  for (size_t i = 0; i < keys.size(); i++) {
    ctx.Assert((*first)[i] >= 86000 && (*first)[i] <= 86400,
               "right after the registration wrote it, %s had TTL %d, expected 24 hours (86400 s) set in the same script: an abandoned upload must leave Redis on its own", keys[i], (*first)[i]);
  }
  for (const std::string& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl >= 86000 && ttl <= 86400, "%s has TTL %d after a registration, expected 24 hours (86400 s): an abandoned upload must leave Redis on its own", key, ttl);
  }
  ctx.Clock.Advance(12 * 3600);
  registerPart("u-1", 2, 3, 5, "c2");
  for (const std::string& key : keys) {
    ctx.Assert(ctx.Redis.TTL(key) > 86000, "a registration 12 hours later left %s with TTL %d: the manifest lives 24 hours after its last registration", key, ctx.Redis.TTL(key));
  }
  ctx.Clock.Advance(86401);
  ctx.Equal(ctx.Redis.Exists(kHarnessParts, kHarnessCounter), 0LL, "24 hours after the last registration Redis still holds %q; the keys", ctx.Redis.Keys("upload:u-1*"));
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
