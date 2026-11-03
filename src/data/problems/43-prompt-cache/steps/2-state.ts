import type {Step} from '@/lib/types';

export const cacheStateStep: Step = {
  id: 'state',
  title: 'Redis entries: one conditional fill that dies with its version',
  concept: 'redis',
  file: 'cache',
  focus: ['cache', 'redis'],
  task: `## Task

**Starting point.** The starter's \`cache\` module holds the entries. \`lookup(key)\` GETs the JSON record
under \`pc:{tenant}:{version}:{digest}\` (None on a miss) and resets the key's expiry on a hit;
\`fill(key, record)\` GETs the key, answers the stored record if there is one, and otherwise SETs its own
record and answers that. The demo fills and reads back. It hides 3 flaws.

**Failure mode the checks target.** Two replicas miss on one prefix at the same moment, both call the
model and both fill. With a read before the write, the slower fill overwrites the faster one, and two
callers leave with different completions for one key. Expiry is the other half: an entry belongs to its
prompt version and must die with it, however often it is read.

- \`fill\` is one \`SET key value NX EX VERSION_TTL_S\` (\`pcache/config\`). When NX refuses the write,
  \`fill\` answers the record that is stored, not its own.
- A filled entry expires \`VERSION_TTL_S\` (six hours) after the fill.
- \`lookup\` reads and leaves the TTL alone.
- Records stay JSON: \`{tenant, version, completion, tokens}\`.`,
  sequence: {
    participants: ['Replica A', 'Redis', 'Replica B'],
    messages: [
      {from: 'Replica A', to: 'Redis', label: 'SET pc:t1:7:{digest} record NX EX 21600', kind: 'sync'},
      {from: 'Redis', to: 'Replica A', label: 'OK: A is the entry', kind: 'reply'},
      {from: 'Replica B', to: 'Redis', label: 'SET pc:t1:7:{digest} record NX EX 21600', kind: 'sync'},
      {from: 'Redis', to: 'Replica B', label: 'nil: an entry exists', kind: 'reply'},
      {from: 'Replica B', to: 'Redis', label: 'GET pc:t1:7:{digest}', kind: 'sync'},
      {from: 'Redis', to: 'Replica B', label: "A's record: both callers get one answer", kind: 'reply'},
    ],
  },
  hints: [
    'Two users who ask the same question at the same moment get different answers, and the cache keeps the second one; entries for a retired prompt version are still served days later.',
    "`fill` reads and then writes, so another replica's fill lands between the two and is overwritten. The write sets no expiry, and `lookup`'s EXPIRE restarts the clock on every hit.",
    "Fill with `r.set(key, value, nx=True, ex=VERSION_TTL_S)` (or your client's NX and EX form); when it answers false, GET and return the stored record. Delete the EXPIRE in `lookup`.",
  ],
  checks: [
    {
      id: 'round-trip',
      title: 'A fill can be read back',
      detail:
        'An empty cache answers no record; a fill answers its record, stores it as JSON under the key, and a lookup returns it.',
      match: {
        python: {all: [/def lookup\(/, /def fill\(/]},
        typescript: {all: [/export async function lookup\(/, /export async function fill\(/]},
        go: {all: [/func lookup\(/, /func fill\(/]},
        scala: {all: [/def lookup\(/, /def fill\(/]},
        cpp: {all: [/std::optional<record::Record> lookup\(/, /record::Record fill\(/]},
      },
    },
    {
      id: 'first-writer-wins',
      title: 'A concurrent fill cannot overwrite the winner',
      detail:
        "Another replica's fill lands between the starter's read and its write; the entry must stay the first writer's and the losing fill must answer it. The starter reads, then writes unconditionally, and answers its own record.",
      match: {
        python: {all: [/nx\s*=\s*True/]},
        typescript: {all: [/['"]NX['"]/]},
        go: {all: [/SetNX\(|Mode:\s*"NX"/]},
        scala: {all: [/\.nx\(\)/]},
        cpp: {all: [/UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'version-ttl',
      title: 'The fill sets the version lifetime',
      detail:
        'A filled entry expires VERSION_TTL_S (six hours) after the fill, set by the fill itself. The starter writes it without an expiry.',
      match: {
        python: {all: [/ex\s*=\s*VERSION_TTL_S/]},
        typescript: {all: [/['"]EX['"],\s*VERSION_TTL_S/]},
        go: {all: [/SetNX\([^\n]*VersionTTLSeconds|TTL:\s*config\.VersionTTLSeconds/]},
        scala: {all: [/\.ex\(\s*Config\.VersionTtlSeconds\s*\)/]},
        cpp: {all: [/redis\(\)\.set\([^;]*kVersionTtlSeconds/]},
      },
    },
    {
      id: 'hit-keeps-ttl',
      title: 'A hit leaves the expiry alone',
      detail:
        'An entry two minutes from the end of its version still has at most two minutes after a hit. The starter runs EXPIRE on every hit, so a popular entry outlives its version.',
      match: {
        python: {none: [/\.expire\(|getex\(/]},
        typescript: {none: [/\.expire\(|getex\(/i]},
        go: {none: [/\.Expire\(|GetEx\(/]},
        scala: {none: [/\.expire\(|getEx\(/]},
        cpp: {none: [/\.expire\(|getex\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from pcache.config import VERSION_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def lookup(key: str) -> dict | None:
    """The entry under key, None on a miss."""
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    raw = r.get(key)
    if raw is None:
        return None
    r.expire(key, VERSION_TTL_S)
    return json.loads(raw)


def fill(key: str, record: dict) -> dict:
    """Store a completion under key; returns the record the cache now holds."""
    stored = r.get(key)
    if stored is not None:
        return json.loads(stored)
    r.set(key, json.dumps(record))
    return record
`,
      solution: `import json

import redis

from pcache.config import VERSION_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def lookup(key: str) -> dict | None:
    """The entry under key, None on a miss. A hit leaves the TTL alone: the entry dies with its version."""
    raw = r.get(key)
    return None if raw is None else json.loads(raw)


def fill(key: str, record: dict) -> dict:
    """Store a completion under key unless one is there; returns the record the cache now holds."""
    if r.set(key, json.dumps(record), nx=True, ex=VERSION_TTL_S):
        return record
    stored = r.get(key)  # another replica filled first: serve its answer
    return json.loads(stored) if stored is not None else record
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {VERSION_TTL_S} from 'pcache/config';
import type {CacheRecord} from 'pcache/record';

const redis = new Redis({host: 'redis', port: 6379});

/** The entry under key, null on a miss. */
export async function lookup(key: string): Promise<CacheRecord | null> {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(key);
  if (raw === null) return null;
  await redis.expire(key, VERSION_TTL_S);
  return JSON.parse(raw) as CacheRecord;
}

/** Store a completion under key; resolves to the record the cache now holds. */
export async function fill(key: string, record: CacheRecord): Promise<CacheRecord> {
  const stored = await redis.get(key);
  if (stored !== null) return JSON.parse(stored) as CacheRecord;
  await redis.set(key, JSON.stringify(record));
  return record;
}
`,
      solution: `import Redis from 'ioredis';

import {VERSION_TTL_S} from 'pcache/config';
import type {CacheRecord} from 'pcache/record';

const redis = new Redis({host: 'redis', port: 6379});

/** The entry under key, null on a miss. A hit leaves the TTL alone: the entry dies with its version. */
export async function lookup(key: string): Promise<CacheRecord | null> {
  const raw = await redis.get(key);
  return raw === null ? null : (JSON.parse(raw) as CacheRecord);
}

/** Store a completion under key unless one is there; resolves to the record the cache now holds. */
export async function fill(key: string, record: CacheRecord): Promise<CacheRecord> {
  const won = await redis.set(key, JSON.stringify(record), 'EX', VERSION_TTL_S, 'NX');
  if (won === 'OK') return record;
  return (await lookup(key)) ?? record; // another replica filled first: serve its answer
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"pcache/config" // config.VersionTTLSeconds — provided
	"pcache/record" // record.Record — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// lookup is the entry under key, nil on a miss.
func lookup(ctx context.Context, key string) (*record.Record, error) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	raw, err := rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rdb.Expire(ctx, key, config.VersionTTLSeconds*time.Second)
	var rec record.Record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// fill stores a completion under key; it returns the record the cache now holds.
func fill(ctx context.Context, key string, rec record.Record) (record.Record, error) {
	if raw, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var stored record.Record
		if json.Unmarshal(raw, &stored) == nil {
			return stored, nil
		}
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return rec, err
	}
	if err := rdb.Set(ctx, key, raw, 0).Err(); err != nil {
		return rec, err
	}
	return rec, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"pcache/config" // config.VersionTTLSeconds — provided
	"pcache/record" // record.Record — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// lookup is the entry under key, nil on a miss. A hit leaves the TTL alone: the entry dies with its version.
func lookup(ctx context.Context, key string) (*record.Record, error) {
	raw, err := rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec record.Record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// fill stores a completion under key unless one is there; it returns the record the cache now holds.
func fill(ctx context.Context, key string, rec record.Record) (record.Record, error) {
	raw, err := json.Marshal(rec)
	if err != nil {
		return rec, err
	}
	won, err := rdb.SetNX(ctx, key, raw, config.VersionTTLSeconds*time.Second).Result()
	if err != nil {
		return rec, err
	}
	if won {
		return rec, nil
	}
	stored, err := lookup(ctx, key) // another replica filled first: serve its answer
	if err != nil || stored == nil {
		return rec, err
	}
	return *stored, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import pcache.{CacheRecord, Config}

object EntryCache {
  private val jedis = new JedisPooled("redis", 6379)

  /** The entry under key, None on a miss. */
  def lookup(key: String): Option[CacheRecord] = {
    // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    val raw = Option(jedis.get(key))
    raw.foreach(_ => jedis.expire(key, Config.VersionTtlSeconds))
    raw.map(CacheRecord.decode)
  }

  /** Store a completion under key; returns the record the cache now holds. */
  def fill(key: String, record: CacheRecord): CacheRecord =
    Option(jedis.get(key)) match {
      case Some(stored) => CacheRecord.decode(stored)
      case None =>
        jedis.set(key, CacheRecord.encode(record))
        record
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import pcache.{CacheRecord, Config}

object EntryCache {
  private val jedis = new JedisPooled("redis", 6379)

  /** The entry under key, None on a miss. A hit leaves the TTL alone: the entry dies with its version. */
  def lookup(key: String): Option[CacheRecord] = Option(jedis.get(key)).map(CacheRecord.decode)

  /** Store a completion under key unless one is there; returns the record the cache now holds. */
  def fill(key: String, record: CacheRecord): CacheRecord = {
    val won = jedis.set(key, CacheRecord.encode(record), SetParams.setParams().nx().ex(Config.VersionTtlSeconds))
    if (won != null) record
    else lookup(key).getOrElse(record) // another replica filled first: serve its answer
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <optional>
#include <string>

#include "pcache/config.h"  // config::redis(), config::kVersionTtlSeconds — provided
#include "pcache/record.h"  // record::Record, record::encode, record::decode — provided

// The entry under key, nothing on a miss.
std::optional<record::Record> lookup(const std::string& key) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const auto raw = config::redis().get(key);
  if (!raw) return std::nullopt;
  config::redis().expire(key, std::chrono::seconds(config::kVersionTtlSeconds));
  return record::decode(*raw);
}

// Store a completion under key; returns the record the cache now holds.
record::Record fill(const std::string& key, const record::Record& rec) {
  if (const auto stored = config::redis().get(key)) return record::decode(*stored);
  config::redis().set(key, record::encode(rec));
  return rec;
}
`,
      solution: `#include <chrono>
#include <optional>
#include <string>

#include "pcache/config.h"  // config::redis(), config::kVersionTtlSeconds — provided
#include "pcache/record.h"  // record::Record, record::encode, record::decode — provided

// The entry under key, nothing on a miss. A hit leaves the TTL alone: the entry dies with its version.
std::optional<record::Record> lookup(const std::string& key) {
  const auto raw = config::redis().get(key);
  if (!raw) return std::nullopt;
  return record::decode(*raw);
}

// Store a completion under key unless one is there; returns the record the cache now holds.
record::Record fill(const std::string& key, const record::Record& rec) {
  const bool won = config::redis().set(key, record::encode(rec), std::chrono::seconds(config::kVersionTtlSeconds),
                                       sw::redis::UpdateType::NOT_EXIST);
  if (won) return rec;
  const auto stored = lookup(key);  // another replica filled first: serve its answer
  return stored ? *stored : rec;
}
`,
    },
  },
  harness: {
    python: `import json

KEY = "pc:t1:7:" + "a" * 64
OTHER = "pc:t1:7:" + "c" * 64
TTL = 6 * 3600


def _record(completion="Answer: hello"):
    return {"tenant": "t1", "version": 7, "completion": completion, "tokens": 3}


def _stored(ctx, key):
    raw = ctx.redis.get(key)
    assert raw is not None, f"nothing is stored under {key}"
    return json.loads(raw)


def check_round_trip(ctx):
    m = ctx.load("cache")
    assert m.lookup(KEY) is None, f"an empty cache must answer None, got {m.lookup(KEY)!r}"
    first = m.fill(KEY, _record())
    assert first == _record(), f"the first fill must return its own record, got {first!r}"
    assert _stored(ctx, KEY) == _record(), f"the entry under {KEY} must be the record's JSON, got {ctx.redis.get(KEY)!r}"
    assert m.lookup(KEY) == _record(), f"a lookup after the fill must return the record, got {m.lookup(KEY)!r}"


def check_first_writer_wins(ctx):
    m = ctx.load("cache")
    rival = _record("Answer from replica B")
    # Replica B misses on the same prefix and fills (with SET NX EX) the moment this fill first touches the key.
    probe = ctx.redis_after(KEY, lambda: bool(ctx.redis.set(KEY, json.dumps(rival), nx=True, ex=TTL)))
    returned = m.fill(KEY, _record("Answer from replica A"))
    assert probe.fired, f"fill never touched {KEY}"
    stored = _stored(ctx, KEY)
    if probe.result:
        assert stored == rival, f"replica B filled {KEY} between this fill's read and its write, and this fill overwrote it with {stored.get('completion')!r}: two callers now hold different answers for one key. The fill must be one SET NX"
        assert returned == rival, f"this fill lost the race and answered its own completion {returned.get('completion')!r}: the loser must answer the stored record"
    else:
        assert stored == returned == _record("Answer from replica A"), f"this fill won the race: the entry and the answer must both be its record, got entry {stored!r} and answer {returned!r}"
    ctx.redis.set(OTHER, json.dumps(rival), ex=TTL)
    late = m.fill(OTHER, _record("late answer"))
    assert late == rival and _stored(ctx, OTHER) == rival, f"a fill over an existing entry must leave it and answer it, got {late!r}"


def check_version_ttl(ctx):
    m = ctx.load("cache")
    m.fill(KEY, _record())
    ttl = ctx.redis.ttl(KEY)
    assert ttl != -1, f"the entry under {KEY} has no expiry: it outlives its prompt version and keeps serving a retired template"
    assert TTL - 5 <= ttl <= TTL, f"the entry expires in {ttl} s, expected VERSION_TTL_S = {TTL} s set by the fill"


def check_hit_keeps_ttl(ctx):
    m = ctx.load("cache")
    ctx.redis.set(KEY, json.dumps(_record()), ex=120)  # two minutes before its version retires
    assert m.lookup(KEY) == _record(), "a lookup must return the stored record"
    ttl = ctx.redis.ttl(KEY)
    assert 0 < ttl <= 120, f"a hit moved the entry's expiry to {ttl} s: an entry must die with its prompt version, however often it is read"
`,
    typescript: `const KEY = 'pc:t1:7:' + 'a'.repeat(64);
const OTHER = 'pc:t1:7:' + 'c'.repeat(64);
const TTL = 6 * 3600;

const rec = (completion = 'Answer: hello') => ({tenant: 't1', version: 7, completion, tokens: 3});

function stored(ctx, key: string) {
  const raw = ctx.redis.get(key);
  assert(raw !== null, \`nothing is stored under \${key}\`);
  return JSON.parse(raw);
}

export async function check_round_trip(ctx) {
  const m = ctx.load('cache');
  assert.equal(await m.lookup(KEY), null, 'an empty cache must answer null');
  const first = await m.fill(KEY, rec());
  assert.deepEqual(first, rec(), \`the first fill must return its own record, got \${JSON.stringify(first)}\`);
  assert.deepEqual(stored(ctx, KEY), rec(), \`the entry under \${KEY} must be the record's JSON, got \${ctx.redis.get(KEY)}\`);
  assert.deepEqual(await m.lookup(KEY), rec(), 'a lookup after the fill must return the record');
}

export async function check_first_writer_wins(ctx) {
  const m = ctx.load('cache');
  const rival = rec('Answer from replica B');
  // Replica B misses on the same prefix and fills (with SET NX EX) the moment this fill first touches the key.
  const probe = ctx.redisAfter(KEY, () => ctx.redis.set(KEY, JSON.stringify(rival), 'EX', TTL, 'NX') === 'OK');
  const returned = await m.fill(KEY, rec('Answer from replica A'));
  assert(probe.fired, \`fill never touched \${KEY}\`);
  const now = stored(ctx, KEY);
  if (probe.result) {
    assert.deepEqual(now, rival, \`replica B filled \${KEY} between this fill's read and its write, and this fill overwrote it with \${JSON.stringify(now.completion)}: two callers now hold different answers for one key. The fill must be one SET NX\`);
    assert.deepEqual(returned, rival, \`this fill lost the race and answered its own completion \${JSON.stringify(returned.completion)}: the loser must answer the stored record\`);
  } else {
    assert(JSON.stringify(now) === JSON.stringify(returned) && JSON.stringify(returned) === JSON.stringify(rec('Answer from replica A')), \`this fill won the race: the entry and the answer must both be its record, got entry \${JSON.stringify(now)} and answer \${JSON.stringify(returned)}\`);
  }
  ctx.redis.set(OTHER, JSON.stringify(rival), 'EX', TTL);
  const late = await m.fill(OTHER, rec('late answer'));
  assert(JSON.stringify(late) === JSON.stringify(rival) && JSON.stringify(stored(ctx, OTHER)) === JSON.stringify(rival), \`a fill over an existing entry must leave it and answer it, got \${JSON.stringify(late)}\`);
}

export async function check_version_ttl(ctx) {
  const m = ctx.load('cache');
  await m.fill(KEY, rec());
  const ttl = ctx.redis.ttl(KEY);
  assert(ttl !== -1, \`the entry under \${KEY} has no expiry: it outlives its prompt version and keeps serving a retired template\`);
  assert(TTL - 5 <= ttl && ttl <= TTL, \`the entry expires in \${ttl} s, expected VERSION_TTL_S = \${TTL} s set by the fill\`);
}

export async function check_hit_keeps_ttl(ctx) {
  const m = ctx.load('cache');
  ctx.redis.set(KEY, JSON.stringify(rec()), 'EX', 120); // two minutes before its version retires
  assert.deepEqual(await m.lookup(KEY), rec(), 'a lookup must return the stored record');
  const ttl = ctx.redis.ttl(KEY);
  assert(0 < ttl && ttl <= 120, \`a hit moved the entry's expiry to \${ttl} s: an entry must die with its prompt version, however often it is read\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"pcache/record"

	"leetbuild/harness"
)

var (
	stateKey   = "pc:t1:7:" + strings.Repeat("a", 64)
	stateOther = "pc:t1:7:" + strings.Repeat("c", 64)
)

const stateTTL = 6 * 3600

func stateRecord(completion string) record.Record {
	return record.Record{Tenant: "t1", Version: 7, Completion: completion, Tokens: 3}
}

func stateJSON(rec record.Record) string {
	raw, _ := json.Marshal(rec)
	return string(raw)
}

func stateStored(ctx *harness.Ctx, key string) record.Record {
	raw, ok := ctx.Redis.Get(key)
	ctx.Assert(ok, "nothing is stored under %s", key)
	var rec record.Record
	ctx.NoError(json.Unmarshal([]byte(raw), &rec), "the entry under %s is a record's JSON (%s)", key, raw)
	return rec
}

func CheckRoundTrip(ctx *harness.Ctx) {
	bg := context.Background()
	empty, err := lookup(bg, stateKey)
	ctx.NoError(err, "lookup on an empty cache")
	ctx.Assert(empty == nil, "an empty cache must answer nil, got %+v", empty)
	first, err := fill(bg, stateKey, stateRecord("Answer: hello"))
	ctx.NoError(err, "fill")
	ctx.Equal(first, stateRecord("Answer: hello"), "the first fill must return its own record")
	ctx.Equal(stateStored(ctx, stateKey), stateRecord("Answer: hello"), "the entry under %s", stateKey)
	again, err := lookup(bg, stateKey)
	ctx.NoError(err, "lookup after the fill")
	ctx.Assert(again != nil && *again == stateRecord("Answer: hello"), "a lookup after the fill must return the record, got %+v", again)
}

func CheckFirstWriterWins(ctx *harness.Ctx) {
	bg := context.Background()
	rival := stateRecord("Answer from replica B")
	// Replica B misses on the same prefix and fills (with SET NX EX) the moment this fill first touches the key.
	rivalWon := false
	probe := ctx.Redis.After(stateKey, func() any {
		rivalWon = ctx.Redis.Set(stateKey, stateJSON(rival), "EX", stateTTL, "NX")
		return rivalWon
	})
	returned, err := fill(bg, stateKey, stateRecord("Answer from replica A"))
	ctx.NoError(err, "fill")
	ctx.Assert(probe.Fired, "fill never touched %s", stateKey)
	now := stateStored(ctx, stateKey)
	if rivalWon {
		ctx.Assert(now == rival, "replica B filled %s between this fill's read and its write, and this fill overwrote it with %q: two callers now hold different answers for one key. The fill must be one SET NX", stateKey, now.Completion)
		ctx.Assert(returned == rival, "this fill lost the race and answered its own completion %q: the loser must answer the stored record", returned.Completion)
	} else {
		ctx.Assert(now == returned && returned == stateRecord("Answer from replica A"), "this fill won the race: the entry and the answer must both be its record, got entry %+v and answer %+v", now, returned)
	}
	ctx.Redis.Set(stateOther, stateJSON(rival), "EX", stateTTL)
	late, err := fill(bg, stateOther, stateRecord("late answer"))
	ctx.NoError(err, "fill over an existing entry")
	ctx.Assert(late == rival && stateStored(ctx, stateOther) == rival, "a fill over an existing entry must leave it and answer it, got %+v", late)
}

func CheckVersionTtl(ctx *harness.Ctx) {
	_, err := fill(context.Background(), stateKey, stateRecord("Answer: hello"))
	ctx.NoError(err, "fill")
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Assert(ttl != -1, "the entry under %s has no expiry: it outlives its prompt version and keeps serving a retired template", stateKey)
	ctx.Assert(stateTTL-5 <= ttl && ttl <= stateTTL, "the entry expires in %d s, expected VERSION_TTL_S = %d s set by the fill", ttl, stateTTL)
}

func CheckHitKeepsTtl(ctx *harness.Ctx) {
	ctx.Redis.Set(stateKey, stateJSON(stateRecord("Answer: hello")), "EX", 120) // two minutes before its version retires
	hit, err := lookup(context.Background(), stateKey)
	ctx.NoError(err, "lookup")
	ctx.Assert(hit != nil && *hit == stateRecord("Answer: hello"), "a lookup must return the stored record, got %+v", hit)
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Assert(0 < ttl && ttl <= 120, "a hit moved the entry's expiry to %d s: an entry must die with its prompt version, however often it is read", ttl)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kKey = "pc:t1:7:" + std::string(64, 'a');
const std::string kOther = "pc:t1:7:" + std::string(64, 'c');
constexpr long long kTtl = 6 * 3600;

record::Record stateRecord(const std::string& completion) { return {"t1", 7, completion, 3}; }

bool same(const record::Record& a, const record::Record& b) {
  return a.tenant == b.tenant && a.version == b.version && a.completion == b.completion && a.tokens == b.tokens;
}

record::Record stored(harness::Ctx& ctx, const std::string& key) {
  const auto raw = ctx.Redis.Get(key);
  ctx.Assert(raw.has_value(), "nothing is stored under %s", key);
  return record::decode(*raw);
}

}  // namespace

void CheckRoundTrip(harness::Ctx& ctx) {
  ctx.Assert(!lookup(kKey).has_value(), "an empty cache must answer nothing");
  const record::Record first = fill(kKey, stateRecord("Answer: hello"));
  ctx.Assert(same(first, stateRecord("Answer: hello")), "the first fill must return its own record, got completion %q", first.completion);
  ctx.Assert(same(stored(ctx, kKey), stateRecord("Answer: hello")), "the entry under %s must be the record's JSON, got %s", kKey, ctx.Redis.Get(kKey).value_or(""));
  const auto again = lookup(kKey);
  ctx.Assert(again.has_value() && same(*again, stateRecord("Answer: hello")), "a lookup after the fill must return the record");
}

void CheckFirstWriterWins(harness::Ctx& ctx) {
  const record::Record rival = stateRecord("Answer from replica B");
  // Replica B misses on the same prefix and fills (with SET NX EX) the moment this fill first touches the key.
  bool fired = false;
  bool rivalWon = false;
  ctx.Redis.After(kKey, [&] {
    fired = true;
    rivalWon = ctx.Redis.Set(kKey, record::encode(rival), "EX", kTtl, "NX");
  });
  const record::Record returned = fill(kKey, stateRecord("Answer from replica A"));
  ctx.Assert(fired, "fill never touched %s", kKey);
  const record::Record now = stored(ctx, kKey);
  if (rivalWon) {
    ctx.Assert(same(now, rival), "replica B filled %s between this fill's read and its write, and this fill overwrote it with %q: two callers now hold different answers for one key. The fill must be one SET NX", kKey, now.completion);
    ctx.Assert(same(returned, rival), "this fill lost the race and answered its own completion %q: the loser must answer the stored record", returned.completion);
  } else {
    ctx.Assert(same(now, returned) && same(returned, stateRecord("Answer from replica A")), "this fill won the race: the entry and the answer must both be its record, got entry %q and answer %q", now.completion, returned.completion);
  }
  ctx.Redis.Set(kOther, record::encode(rival), "EX", kTtl);
  const record::Record late = fill(kOther, stateRecord("late answer"));
  ctx.Assert(same(late, rival) && same(stored(ctx, kOther), rival), "a fill over an existing entry must leave it and answer it, got %q", late.completion);
}

void CheckVersionTtl(harness::Ctx& ctx) {
  fill(kKey, stateRecord("Answer: hello"));
  const long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(ttl != -1, "the entry under %s has no expiry: it outlives its prompt version and keeps serving a retired template", kKey);
  ctx.Assert(kTtl - 5 <= ttl && ttl <= kTtl, "the entry expires in %d s, expected VERSION_TTL_S = %d s set by the fill", ttl, kTtl);
}

void CheckHitKeepsTtl(harness::Ctx& ctx) {
  ctx.Redis.Set(kKey, record::encode(stateRecord("Answer: hello")), "EX", 120);  // two minutes before its version retires
  const auto hit = lookup(kKey);
  ctx.Assert(hit.has_value() && same(*hit, stateRecord("Answer: hello")), "a lookup must return the stored record");
  const long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(0 < ttl && ttl <= 120, "a hit moved the entry's expiry to %d s: an entry must die with its prompt version, however often it is read", ttl);
}
`,
  },
  debrief: `\`SET NX EX\` turns the fill into one decision the server takes alone: either this replica's answer becomes the entry, or the replica learns which answer did and serves that. Reading first and writing second opens a window every concurrent miss can fall into, and the cost is two callers holding different completions for one key. The TTL belongs to the fill because an entry lives as long as its prompt version, not as long as it is popular; sliding expiry keeps a retired template alive exactly where it is used most. Production caches also coalesce concurrent misses behind a short lock, so N callers make one model call instead of N, and add jitter to TTLs so a version's entries do not all expire in the same second.`,
};
