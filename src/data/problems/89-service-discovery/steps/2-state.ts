import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Heartbeats that renew metadata and expiry in one script',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['discovery', 'redis', 'reaper'],
  task: `## Task

**Starting point.** The starter is the heartbeat every registered instance sends each
\`heartbeat_interval\` seconds: \`heartbeat(service, instance_id, address, port, metadata_version,
heartbeat_interval)\` checks that \`sd:{service}:{instance_id}\` exists (\`gone\` otherwise, and the
agent re-registers), \`HSET\`s the address, port, version, interval and \`last_heartbeat\`, then
\`EXPIRE\`s the key after \`TTL_SECONDS\` and answers \`renewed\`. It serves the demo and hides three
flaws.

**Failure mode the checks target.** A heartbeat that lands as the record lapses writes it back after
the sweep announced the instance expired, so the agent heartbeats into a record no read lists; a
lagging replica's older \`metadata_version\` rolls a rollout back; and the expiry ignores the interval
the instance just promised.

- The existence check, the version comparison, the write and the expiry run as one Lua script
  (\`register_script\`), so nothing lands between them.
- A \`metadata_version\` below the stored one answers \`stale\` and writes nothing; an equal or higher
  one renews.
- The expiry is \`TTL_INTERVALS * heartbeat_interval\` seconds from this heartbeat
  (\`instances.TTL_INTERVALS\`).`,
  sequence: {
    participants: ['Instance', 'Discovery API', 'Redis'],
    messages: [
      {from: 'Instance', to: 'Discovery API', label: 'heartbeat checkout-3 · version 14 · interval 5', kind: 'sync'},
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'EVALSHA renew sd:checkout:checkout-3 · 10.4.2.7 8080 14 5 now 15',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Redis',
        label: 'HGET version · nil → gone · 14 < stored → stale · HSET · EXPIRE 15',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Discovery API', label: 'renewed · stale · gone', kind: 'reply'},
      {from: 'Discovery API', to: 'Instance', label: 'renewed · stale (stop) · gone (re-register)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-renew',
      title: 'Existence, write and expiry are one script',
      detail:
        'The renewal runs in one Lua script (`register_script`, `defineCommand`, `NewScript`, `eval`) that reads the record, writes it and sets its `EXPIRE`; there is no client-side `EXISTS`, `HSET` or `EXPIRE` on the path. The starter sends three commands, so a record that lapses between them is written back.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/r\.exists\(/, /r\.expire\(/, /r\.hset\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.exists\(/, /redis\.expire\(/, /redis\.hset\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/rdb\.Exists\(/, /rdb\.Expire\(/, /rdb\.HSet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/jedis\.exists\(/, /jedis\.expire\(/, /jedis\.hset\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.exists\(/, /redis\.expire\(/, /redis\.hset\(/],
        },
      },
    },
    {
      id: 'version-guard',
      title: 'An older metadata version is refused',
      detail:
        'Inside the script the incoming `metadata_version` is compared with the stored one (`tonumber`), and a lower one returns `stale` without writing. The starter overwrites the version with whatever arrives.',
      match: {
        python: {all: [/tonumber\(/, /return\s+['"]stale['"]/]},
        typescript: {all: [/tonumber\(/, /return\s+['"]stale['"]/]},
        go: {all: [/tonumber\(/, /return\s+['"]stale['"]/]},
        scala: {all: [/tonumber\(/, /return\s+['"]stale['"]/]},
        cpp: {all: [/tonumber\(/, /return\s+['"]stale['"]/]},
      },
    },
    {
      id: 'expiry-derived',
      title: 'The expiry is three of the promised intervals',
      detail:
        'The TTL the script sets is `TTL_INTERVALS * heartbeat_interval` from the same heartbeat, not a constant: a constant declares a fast-heartbeating instance dead late and a slow one dead early.',
      match: {
        python: {all: [/TTL_INTERVALS\s*\*\s*heartbeat_interval/], none: [/TTL_SECONDS/]},
        typescript: {all: [/TTL_INTERVALS\s*\*\s*heartbeatInterval/], none: [/TTL_SECONDS/]},
        go: {all: [/TTLIntervals\s*\*\s*heartbeatInterval/], none: [/ttlSeconds/]},
        scala: {all: [/TtlIntervals\s*\*\s*heartbeatInterval/], none: [/TtlSeconds/]},
        cpp: {all: [/kTtlIntervals\s*\*\s*heartbeat_interval/], none: [/kTtlSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from discovery import instances  # record_key, members_key, TTL_INTERVALS

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_SECONDS = 30


def heartbeat(service: str, instance_id: str, address: str, port: int, metadata_version: int, heartbeat_interval: int) -> str:
    """Renew a registered instance: renewed, or gone when its record lapsed (the agent re-registers)."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    key = instances.record_key(service, instance_id)
    if not r.exists(key):
        return "gone"
    r.hset(key, mapping={
        "address": address,
        "port": port,
        "metadata_version": metadata_version,
        "heartbeat_interval": heartbeat_interval,
        "last_heartbeat": int(time.time()),
    })
    r.expire(key, TTL_SECONDS)
    return "renewed"
`,
      solution: `import time

import redis

from discovery import instances  # record_key, members_key, TTL_INTERVALS

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] the record; ARGV address, port, metadata_version, heartbeat_interval, now, ttl.
# Only registration creates a record: a lapsed one stays gone, and versions only move forward.
RENEW_LUA = """
local stored = redis.call('HGET', KEYS[1], 'metadata_version')
if not stored then return 'gone' end
if tonumber(ARGV[3]) < tonumber(stored) then return 'stale' end
redis.call('HSET', KEYS[1], 'address', ARGV[1], 'port', ARGV[2], 'metadata_version', ARGV[3],
  'heartbeat_interval', ARGV[4], 'last_heartbeat', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 'renewed'
"""
renew = r.register_script(RENEW_LUA)


def heartbeat(service: str, instance_id: str, address: str, port: int, metadata_version: int, heartbeat_interval: int) -> str:
    """Renew a registered instance: renewed, stale (an older metadata_version, nothing written) or gone (re-register)."""
    ttl = instances.TTL_INTERVALS * heartbeat_interval
    return renew(
        keys=[instances.record_key(service, instance_id)],
        args=[address, port, metadata_version, heartbeat_interval, int(time.time()), ttl],
    )
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // recordKey, membersKey, TTL_INTERVALS

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_SECONDS = 30;

/** Renew a registered instance: renewed, or gone when its record lapsed (the agent re-registers). */
export async function heartbeat(
  service: string,
  instanceId: string,
  address: string,
  port: number,
  metadataVersion: number,
  heartbeatInterval: number,
): Promise<string> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const key = instances.recordKey(service, instanceId);
  if ((await redis.exists(key)) === 0) return 'gone';
  await redis.hset(key, {
    address,
    port: String(port),
    metadata_version: String(metadataVersion),
    heartbeat_interval: String(heartbeatInterval),
    last_heartbeat: String(Math.floor(Date.now() / 1000)),
  });
  await redis.expire(key, TTL_SECONDS);
  return 'renewed';
}
`,
      solution: `import Redis from 'ioredis';

import * as instances from 'discovery/instances'; // recordKey, membersKey, TTL_INTERVALS

// KEYS[1] the record; ARGV address, port, metadata_version, heartbeat_interval, now, ttl.
// Only registration creates a record: a lapsed one stays gone, and versions only move forward.
export const RENEW_LUA = \`
local stored = redis.call('HGET', KEYS[1], 'metadata_version')
if not stored then return 'gone' end
if tonumber(ARGV[3]) < tonumber(stored) then return 'stale' end
redis.call('HSET', KEYS[1], 'address', ARGV[1], 'port', ARGV[2], 'metadata_version', ARGV[3],
  'heartbeat_interval', ARGV[4], 'last_heartbeat', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 'renewed'
\`;

interface RenewRedis extends Redis {
  renew(key: string, ...args: (string | number)[]): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as RenewRedis;
redis.defineCommand('renew', {numberOfKeys: 1, lua: RENEW_LUA});

/** Renew a registered instance: renewed, stale (an older metadata_version, nothing written) or gone (re-register). */
export async function heartbeat(
  service: string,
  instanceId: string,
  address: string,
  port: number,
  metadataVersion: number,
  heartbeatInterval: number,
): Promise<string> {
  const ttl = instances.TTL_INTERVALS * heartbeatInterval;
  const now = Math.floor(Date.now() / 1000);
  return redis.renew(instances.recordKey(service, instanceId), address, port, metadataVersion, heartbeatInterval, now, ttl);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.RecordKey, MembersKey, TTLIntervals
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttlSeconds = 30 * time.Second

// heartbeat renews a registered instance: "renewed", or "gone" when its record lapsed (the agent re-registers).
func heartbeat(ctx context.Context, service, instanceID, address string, port, metadataVersion, heartbeatInterval int) (string, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	key := instances.RecordKey(service, instanceID)
	n, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		return "", err
	}
	if n == 0 {
		return "gone", nil
	}
	err = rdb.HSet(ctx, key, map[string]any{
		"address":            address,
		"port":               port,
		"metadata_version":   metadataVersion,
		"heartbeat_interval": heartbeatInterval,
		"last_heartbeat":     time.Now().Unix(),
	}).Err()
	if err != nil {
		return "", err
	}
	return "renewed", rdb.Expire(ctx, key, ttlSeconds).Err()
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.RecordKey, MembersKey, TTLIntervals
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// renewScript: KEYS[1] the record; ARGV address, port, metadata_version, heartbeat_interval, now, ttl.
// Only registration creates a record: a lapsed one stays gone, and versions only move forward.
var renewScript = redis.NewScript(\`
local stored = redis.call('HGET', KEYS[1], 'metadata_version')
if not stored then return 'gone' end
if tonumber(ARGV[3]) < tonumber(stored) then return 'stale' end
redis.call('HSET', KEYS[1], 'address', ARGV[1], 'port', ARGV[2], 'metadata_version', ARGV[3],
  'heartbeat_interval', ARGV[4], 'last_heartbeat', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 'renewed'
\`)

// heartbeat renews a registered instance: "renewed", "stale" (an older metadata_version, nothing written) or "gone" (re-register).
func heartbeat(ctx context.Context, service, instanceID, address string, port, metadataVersion, heartbeatInterval int) (string, error) {
	ttl := instances.TTLIntervals * heartbeatInterval
	key := instances.RecordKey(service, instanceID)
	return renewScript.Run(ctx, rdb, []string{key}, address, port, metadataVersion, heartbeatInterval, time.Now().Unix(), ttl).Text()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import discovery.Instances // Instances.recordKey, membersKey, TtlIntervals

object State {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 30L

  /** Renew a registered instance: renewed, or gone when its record lapsed (the agent re-registers). */
  def heartbeat(service: String, instanceId: String, address: String, port: Int, metadataVersion: Long, heartbeatInterval: Int): String = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val key = Instances.recordKey(service, instanceId)
    if (!jedis.exists(key)) "gone"
    else {
      jedis.hset(key, Map(
        "address" -> address, "port" -> port.toString, "metadata_version" -> metadataVersion.toString,
        "heartbeat_interval" -> heartbeatInterval.toString, "last_heartbeat" -> (System.currentTimeMillis() / 1000).toString).asJava)
      jedis.expire(key, TtlSeconds)
      "renewed"
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import discovery.Instances // Instances.recordKey, membersKey, TtlIntervals

object State {
  val jedis = new JedisPooled("redis", 6379)

  /**
   * KEYS[1] the record; ARGV address, port, metadata_version, heartbeat_interval, now, ttl.
   * Only registration creates a record: a lapsed one stays gone, and versions only move forward.
   */
  val RenewLua: String =
    """local stored = redis.call('HGET', KEYS[1], 'metadata_version')
      |if not stored then return 'gone' end
      |if tonumber(ARGV[3]) < tonumber(stored) then return 'stale' end
      |redis.call('HSET', KEYS[1], 'address', ARGV[1], 'port', ARGV[2], 'metadata_version', ARGV[3],
      |  'heartbeat_interval', ARGV[4], 'last_heartbeat', ARGV[5])
      |redis.call('EXPIRE', KEYS[1], ARGV[6])
      |return 'renewed'
      |""".stripMargin

  /** Renew a registered instance: renewed, stale (an older metadata_version, nothing written) or gone (re-register). */
  def heartbeat(service: String, instanceId: String, address: String, port: Int, metadataVersion: Long, heartbeatInterval: Int): String = {
    val ttl = Instances.TtlIntervals * heartbeatInterval
    val args = List(address, port.toString, metadataVersion.toString, heartbeatInterval.toString, (System.currentTimeMillis() / 1000).toString, ttl.toString)
    jedis.eval(RenewLua, List(Instances.recordKey(service, instanceId)).asJava, args.asJava).asInstanceOf[String]
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>

#include "discovery/instances.h"  // instances::recordKey, membersKey, kTtlIntervals, nowSeconds

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtlSeconds{30};

// Renew a registered instance: "renewed", or "gone" when its record lapsed (the agent re-registers).
std::string heartbeat(const std::string& service, const std::string& instance_id, const std::string& address, long port,
                      long metadata_version, long heartbeat_interval) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string key = instances::recordKey(service, instance_id);
  if (redis.exists(key) == 0) return "gone";
  const std::unordered_map<std::string, std::string> fields = {
      {"address", address},
      {"port", std::to_string(port)},
      {"metadata_version", std::to_string(metadata_version)},
      {"heartbeat_interval", std::to_string(heartbeat_interval)},
      {"last_heartbeat", std::to_string(instances::nowSeconds())}};
  redis.hset(key, fields.begin(), fields.end());
  redis.expire(key, kTtlSeconds);
  return "renewed";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "discovery/instances.h"  // instances::recordKey, membersKey, kTtlIntervals, nowSeconds

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] the record; ARGV address, port, metadata_version, heartbeat_interval, now, ttl.
// Only registration creates a record: a lapsed one stays gone, and versions only move forward.
const std::string kRenewLua = R"lua(
local stored = redis.call('HGET', KEYS[1], 'metadata_version')
if not stored then return 'gone' end
if tonumber(ARGV[3]) < tonumber(stored) then return 'stale' end
redis.call('HSET', KEYS[1], 'address', ARGV[1], 'port', ARGV[2], 'metadata_version', ARGV[3],
  'heartbeat_interval', ARGV[4], 'last_heartbeat', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 'renewed'
)lua";

// Renew a registered instance: "renewed", "stale" (an older metadata_version, nothing written) or "gone" (re-register).
std::string heartbeat(const std::string& service, const std::string& instance_id, const std::string& address, long port,
                      long metadata_version, long heartbeat_interval) {
  const long ttl = instances::kTtlIntervals * heartbeat_interval;
  const std::string result = redis.eval<std::string>(
      kRenewLua, {instances::recordKey(service, instance_id)},
      {address, std::to_string(port), std::to_string(metadata_version), std::to_string(heartbeat_interval),
       std::to_string(instances::nowSeconds()), std::to_string(ttl)});
  return result;
}
`,
    },
  },
  harness: {
    python: `from discovery import instances

KEY = "sd:checkout:checkout-3"


def _registered(ctx, version=13, interval=5):
    m = ctx.load("state")
    instances.register_instance("checkout", "checkout-3", "10.4.2.7", 8080, interval, version)
    return m


def _settled(probe, what):
    assert probe.fired, f"the heartbeat never touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_atomic_renew(ctx):
    m = _registered(ctx)

    def lapse():  # the record expires and the sweep drops the member, right as the heartbeat lands
        ctx.redis.delete(KEY)
        ctx.redis.srem("sd:members:checkout", "checkout-3")

    probe = ctx.redis_after(KEY, lapse)
    first = m.heartbeat("checkout", "checkout-3", "10.4.2.7", 8080, 13, 5)
    _settled(probe, KEY)
    assert first in ("gone", "renewed"), f"the heartbeat answered {first!r}"
    assert ctx.redis.exists(KEY) == 0, f"the record lapsed while the heartbeat was renewing it, and the heartbeat wrote it back ({ctx.redis.hgetall(KEY)}): an instance outside sd:members:checkout that no read lists. The existence check and the write must be one script"
    again = m.heartbeat("checkout", "checkout-3", "10.4.2.7", 8080, 13, 5)
    assert again == "gone", f"a heartbeat for a lapsed record answered {again!r}, expected gone so the agent re-registers"
    assert ctx.redis.exists(KEY) == 0, f"a heartbeat recreated the lapsed record {ctx.redis.hgetall(KEY)}: only registration may create one"
    instances.register_instance("checkout", "checkout-3", "10.4.2.7", 8080, 5, 13)
    renewed = m.heartbeat("checkout", "checkout-3", "10.4.2.8", 8081, 13, 5)
    assert renewed == "renewed", f"a heartbeat for a live record answered {renewed!r}, expected renewed"
    record = ctx.redis.hgetall(KEY)
    assert record.get("address") == "10.4.2.8" and record.get("port") == "8081", f"the renewal must write the new address and port, the record is {record}"


def check_version_guard(ctx):
    m = _registered(ctx, version=13)
    stale = m.heartbeat("checkout", "checkout-3", "10.4.9.9", 8080, 12, 5)
    assert stale == "stale", f"a heartbeat with metadata_version 12 under a stored 13 answered {stale!r}, expected stale"
    record = ctx.redis.hgetall(KEY)
    assert record.get("metadata_version") == "13" and record.get("address") == "10.4.2.7", f"a lagging replica's version 12 rolled the record back to {record}"
    same = m.heartbeat("checkout", "checkout-3", "10.4.2.7", 8080, 13, 5)
    assert same == "renewed", f"a heartbeat with the stored version 13 answered {same!r}, expected renewed"
    # Version 15 lands while the version 14 heartbeat is in flight: the record must end at 15.
    rival = ctx.redis_after(KEY, lambda: m.heartbeat("checkout", "checkout-3", "10.4.3.3", 8080, 15, 5))
    m.heartbeat("checkout", "checkout-3", "10.4.2.8", 8080, 14, 5)
    _settled(rival, KEY)
    record = ctx.redis.hgetall(KEY)
    assert record.get("metadata_version") == "15" and record.get("address") == "10.4.3.3", f"version 15 landed while version 14 was in flight and the record ends at {record}: the comparison and the write must be one script"


def check_expiry_derived(ctx):
    m = _registered(ctx, interval=5)
    assert m.heartbeat("checkout", "checkout-3", "10.4.2.7", 8080, 13, 2) == "renewed", "a heartbeat for a live record must renew it"
    ttl = ctx.redis.ttl(KEY)
    assert 5 <= ttl <= 6, f"after a heartbeat promising a 2 s interval the record's TTL is {ttl}, expected 3 x 2 = 6 s"
    assert ctx.redis.hget(KEY, "heartbeat_interval") == "2", "the record must store the interval the heartbeat promised"
    ctx.clock.advance(7)
    assert ctx.redis.exists(KEY) == 0, "7 s after a heartbeat promising 2 s intervals the record is still there: three missed heartbeats must expire it"
    instances.register_instance("checkout", "checkout-3", "10.4.2.7", 8080, 5, 13)
    m.heartbeat("checkout", "checkout-3", "10.4.2.7", 8080, 13, 20)
    ttl = ctx.redis.ttl(KEY)
    assert 59 <= ttl <= 60, f"after a heartbeat promising a 20 s interval the record's TTL is {ttl}, expected 3 x 20 = 60 s"
`,
    typescript: `const KEY = 'sd:checkout:checkout-3';

async function registered(ctx, version = 13, interval = 5) {
  const m = ctx.load('state');
  const instances = ctx.load('/support/discovery/instances.ts');
  await instances.registerInstance('checkout', 'checkout-3', '10.4.2.7', 8080, interval, version);
  return {m, instances};
}

async function settled(probe, what: string) {
  assert(probe.fired, \`the heartbeat never touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_atomic_renew(ctx) {
  const {m, instances} = await registered(ctx);
  // The record expires and the sweep drops the member, right as the heartbeat lands.
  const probe = ctx.redisAfter(KEY, () => {
    ctx.redis.del(KEY);
    ctx.redis.srem('sd:members:checkout', 'checkout-3');
  });
  const first = await m.heartbeat('checkout', 'checkout-3', '10.4.2.7', 8080, 13, 5);
  await settled(probe, KEY);
  assert(first === 'gone' || first === 'renewed', \`the heartbeat answered \${JSON.stringify(first)}\`);
  assert.equal(ctx.redis.exists(KEY), 0, \`the record lapsed while the heartbeat was renewing it, and the heartbeat wrote it back (\${JSON.stringify(ctx.redis.hgetall(KEY))}): an instance outside sd:members:checkout that no read lists. The existence check and the write must be one script\`);
  const again = await m.heartbeat('checkout', 'checkout-3', '10.4.2.7', 8080, 13, 5);
  assert.equal(again, 'gone', \`a heartbeat for a lapsed record answered \${JSON.stringify(again)}, expected gone so the agent re-registers\`);
  assert.equal(ctx.redis.exists(KEY), 0, 'a heartbeat recreated the lapsed record: only registration may create one');
  await instances.registerInstance('checkout', 'checkout-3', '10.4.2.7', 8080, 5, 13);
  const renewed = await m.heartbeat('checkout', 'checkout-3', '10.4.2.8', 8081, 13, 5);
  assert.equal(renewed, 'renewed', \`a heartbeat for a live record answered \${JSON.stringify(renewed)}, expected renewed\`);
  const record = ctx.redis.hgetall(KEY);
  assert(record.address === '10.4.2.8' && record.port === '8081', \`the renewal must write the new address and port, the record is \${JSON.stringify(record)}\`);
}

export async function check_version_guard(ctx) {
  const {m} = await registered(ctx, 13);
  const stale = await m.heartbeat('checkout', 'checkout-3', '10.4.9.9', 8080, 12, 5);
  assert.equal(stale, 'stale', \`a heartbeat with metadata_version 12 under a stored 13 answered \${JSON.stringify(stale)}, expected stale\`);
  let record = ctx.redis.hgetall(KEY);
  assert(record.metadata_version === '13' && record.address === '10.4.2.7', \`a lagging replica's version 12 rolled the record back to \${JSON.stringify(record)}\`);
  const same = await m.heartbeat('checkout', 'checkout-3', '10.4.2.7', 8080, 13, 5);
  assert.equal(same, 'renewed', \`a heartbeat with the stored version 13 answered \${JSON.stringify(same)}, expected renewed\`);
  // Version 15 lands while the version 14 heartbeat is in flight: the record must end at 15.
  const rival = ctx.redisAfter(KEY, () => m.heartbeat('checkout', 'checkout-3', '10.4.3.3', 8080, 15, 5));
  await m.heartbeat('checkout', 'checkout-3', '10.4.2.8', 8080, 14, 5);
  await settled(rival, KEY);
  record = ctx.redis.hgetall(KEY);
  assert(record.metadata_version === '15' && record.address === '10.4.3.3', \`version 15 landed while version 14 was in flight and the record ends at \${JSON.stringify(record)}: the comparison and the write must be one script\`);
}

export async function check_expiry_derived(ctx) {
  const {m, instances} = await registered(ctx, 13, 5);
  assert.equal(await m.heartbeat('checkout', 'checkout-3', '10.4.2.7', 8080, 13, 2), 'renewed', 'a heartbeat for a live record must renew it');
  let ttl = ctx.redis.ttl(KEY);
  assert(5 <= ttl && ttl <= 6, \`after a heartbeat promising a 2 s interval the record's TTL is \${ttl}, expected 3 x 2 = 6 s\`);
  assert.equal(ctx.redis.hget(KEY, 'heartbeat_interval'), '2', 'the record must store the interval the heartbeat promised');
  ctx.clock.advance(7);
  assert.equal(ctx.redis.exists(KEY), 0, '7 s after a heartbeat promising 2 s intervals the record is still there: three missed heartbeats must expire it');
  await instances.registerInstance('checkout', 'checkout-3', '10.4.2.7', 8080, 5, 13);
  await m.heartbeat('checkout', 'checkout-3', '10.4.2.7', 8080, 13, 20);
  ttl = ctx.redis.ttl(KEY);
  assert(59 <= ttl && ttl <= 60, \`after a heartbeat promising a 20 s interval the record's TTL is \${ttl}, expected 3 x 20 = 60 s\`);
}
`,
    go: `package main

import (
	"context"

	"discovery/instances"

	"leetbuild/harness"
)

const stateKey = "sd:checkout:checkout-3"

var stateBg = context.Background()

func registered(ctx *harness.Ctx, version, interval int) {
	_, err := instances.RegisterInstance(stateBg, "checkout", "checkout-3", "10.4.2.7", 8080, interval, version)
	ctx.NoError(err, "registering checkout-3")
}

func beat(ctx *harness.Ctx, address string, port, version, interval int) string {
	result, err := heartbeat(stateBg, "checkout", "checkout-3", address, port, version, interval)
	ctx.NoError(err, "heartbeat(checkout, checkout-3, %s, %d, %d, %d) failed", address, port, version, interval)
	return result
}

func CheckAtomicRenew(ctx *harness.Ctx) {
	registered(ctx, 13, 5)
	// The record expires and the sweep drops the member, right as the heartbeat lands.
	probe := ctx.Redis.After(stateKey, func() any {
		ctx.Redis.Del(stateKey)
		ctx.Redis.Do("SREM", "sd:members:checkout", "checkout-3")
		return nil
	})
	first := beat(ctx, "10.4.2.7", 8080, 13, 5)
	ctx.Assert(probe.Fired, "the heartbeat never touched %s", stateKey)
	ctx.Assert(first == "gone" || first == "renewed", "the heartbeat answered %q", first)
	ctx.Equal(ctx.Redis.Exists(stateKey), 0, "the record lapsed while the heartbeat was renewing it, and the heartbeat wrote it back (%v): an instance outside sd:members:checkout that no read lists. The existence check and the write must be one script; exists", ctx.Redis.HGetAll(stateKey))
	ctx.Equal(beat(ctx, "10.4.2.7", 8080, 13, 5), "gone", "a heartbeat for a lapsed record must answer gone so the agent re-registers")
	ctx.Equal(ctx.Redis.Exists(stateKey), 0, "a heartbeat recreated the lapsed record: only registration may create one; exists")
	registered(ctx, 13, 5)
	ctx.Equal(beat(ctx, "10.4.2.8", 8081, 13, 5), "renewed", "a heartbeat for a live record")
	record := ctx.Redis.HGetAll(stateKey)
	ctx.Assert(record["address"] == "10.4.2.8" && record["port"] == "8081", "the renewal must write the new address and port, the record is %v", record)
}

func CheckVersionGuard(ctx *harness.Ctx) {
	registered(ctx, 13, 5)
	ctx.Equal(beat(ctx, "10.4.9.9", 8080, 12, 5), "stale", "a heartbeat with metadata_version 12 under a stored 13")
	record := ctx.Redis.HGetAll(stateKey)
	ctx.Assert(record["metadata_version"] == "13" && record["address"] == "10.4.2.7", "a lagging replica's version 12 rolled the record back to %v", record)
	ctx.Equal(beat(ctx, "10.4.2.7", 8080, 13, 5), "renewed", "a heartbeat with the stored version 13")
	// Version 15 lands while the version 14 heartbeat is in flight: the record must end at 15.
	rival := ctx.Redis.After(stateKey, func() any {
		result, err := heartbeat(stateBg, "checkout", "checkout-3", "10.4.3.3", 8080, 15, 5)
		ctx.NoError(err, "the rival heartbeat failed")
		return result
	})
	beat(ctx, "10.4.2.8", 8080, 14, 5)
	ctx.Assert(rival.Fired, "the heartbeat never touched %s", stateKey)
	ctx.Assert(rival.Err == nil, "the rival heartbeat failed: %v", rival.Err)
	record = ctx.Redis.HGetAll(stateKey)
	ctx.Assert(record["metadata_version"] == "15" && record["address"] == "10.4.3.3", "version 15 landed while version 14 was in flight and the record ends at %v: the comparison and the write must be one script", record)
}

func CheckExpiryDerived(ctx *harness.Ctx) {
	registered(ctx, 13, 5)
	ctx.Equal(beat(ctx, "10.4.2.7", 8080, 13, 2), "renewed", "a heartbeat for a live record")
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Assert(5 <= ttl && ttl <= 6, "after a heartbeat promising a 2 s interval the record's TTL is %d, expected 3 x 2 = 6 s", ttl)
	interval, _ := ctx.Redis.HGet(stateKey, "heartbeat_interval")
	ctx.Equal(interval, "2", "the record must store the interval the heartbeat promised")
	ctx.Clock.Advance(7)
	ctx.Equal(ctx.Redis.Exists(stateKey), 0, "7 s after a heartbeat promising 2 s intervals the record must be gone (three missed heartbeats); exists")
	registered(ctx, 13, 5)
	beat(ctx, "10.4.2.7", 8080, 13, 20)
	ttl = ctx.Redis.TTL(stateKey)
	ctx.Assert(59 <= ttl && ttl <= 60, "after a heartbeat promising a 20 s interval the record's TTL is %d, expected 3 x 20 = 60 s", ttl)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "discovery/instances.h"

namespace {

const std::string kKey = "sd:checkout:checkout-3";

void registered(long version, long interval) { instances::registerInstance("checkout", "checkout-3", "10.4.2.7", 8080, interval, version); }

std::string beat(const std::string& address, long port, long version, long interval) {
  return heartbeat("checkout", "checkout-3", address, port, version, interval);
}

std::string field(harness::Ctx& ctx, const std::string& name) { return ctx.Redis.HGet(kKey, name).value_or(""); }

std::string shown(harness::Ctx& ctx) {
  std::string out;
  for (const auto& [name, value] : ctx.Redis.HGetAll(kKey)) out += name + "=" + value + " ";
  return out;
}

}  // namespace

void CheckAtomicRenew(harness::Ctx& ctx) {
  registered(13, 5);
  bool fired = false;
  // The record expires and the sweep drops the member, right as the heartbeat lands.
  ctx.Redis.After(kKey, [&] {
    fired = true;
    ctx.Redis.Del(kKey);
    ctx.Redis.Do("SREM", "sd:members:checkout", "checkout-3");
  });
  const std::string first = beat("10.4.2.7", 8080, 13, 5);
  ctx.Assert(fired, "the heartbeat never touched %s", kKey);
  ctx.Assert(first == "gone" || first == "renewed", "the heartbeat answered %q", first);
  ctx.Equal(ctx.Redis.Exists(kKey), 0, "the record lapsed while the heartbeat was renewing it, and the heartbeat wrote it back (%s): an instance outside sd:members:checkout that no read lists. The existence check and the write must be one script; exists", shown(ctx));
  ctx.Equal(beat("10.4.2.7", 8080, 13, 5), "gone", "a heartbeat for a lapsed record must answer gone so the agent re-registers");
  ctx.Equal(ctx.Redis.Exists(kKey), 0, "a heartbeat recreated the lapsed record: only registration may create one; exists");
  registered(13, 5);
  ctx.Equal(beat("10.4.2.8", 8081, 13, 5), "renewed", "a heartbeat for a live record");
  ctx.Assert(field(ctx, "address") == "10.4.2.8" && field(ctx, "port") == "8081", "the renewal must write the new address and port, the record is %s", shown(ctx));
}

void CheckVersionGuard(harness::Ctx& ctx) {
  registered(13, 5);
  ctx.Equal(beat("10.4.9.9", 8080, 12, 5), "stale", "a heartbeat with metadata_version 12 under a stored 13");
  ctx.Assert(field(ctx, "metadata_version") == "13" && field(ctx, "address") == "10.4.2.7", "a lagging replica's version 12 rolled the record back to %s", shown(ctx));
  ctx.Equal(beat("10.4.2.7", 8080, 13, 5), "renewed", "a heartbeat with the stored version 13");
  // Version 15 lands while the version 14 heartbeat is in flight: the record must end at 15.
  auto fired = std::make_shared<bool>(false);
  auto err = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After(kKey, [fired, err] {
    *fired = true;
    try {
      heartbeat("checkout", "checkout-3", "10.4.3.3", 8080, 15, 5);
    } catch (const std::exception& e) {
      *err = e.what();
    }
  });
  beat("10.4.2.8", 8080, 14, 5);
  ctx.Assert(*fired, "the heartbeat never touched %s", kKey);
  ctx.Assert(!*err, "the rival heartbeat failed: %s", err->value_or(""));
  ctx.Assert(field(ctx, "metadata_version") == "15" && field(ctx, "address") == "10.4.3.3", "version 15 landed while version 14 was in flight and the record ends at %s: the comparison and the write must be one script", shown(ctx));
}

void CheckExpiryDerived(harness::Ctx& ctx) {
  registered(13, 5);
  ctx.Equal(beat("10.4.2.7", 8080, 13, 2), "renewed", "a heartbeat for a live record");
  long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(5 <= ttl && ttl <= 6, "after a heartbeat promising a 2 s interval the record's TTL is %d, expected 3 x 2 = 6 s", ttl);
  ctx.Equal(field(ctx, "heartbeat_interval"), "2", "the record must store the interval the heartbeat promised");
  ctx.Clock.Advance(7);
  ctx.Equal(ctx.Redis.Exists(kKey), 0, "7 s after a heartbeat promising 2 s intervals the record must be gone (three missed heartbeats); exists");
  registered(13, 5);
  beat("10.4.2.7", 8080, 13, 20);
  ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(59 <= ttl && ttl <= 60, "after a heartbeat promising a 20 s interval the record's TTL is %d, expected 3 x 20 = 60 s", ttl);
}
`,
  },
  hints: [
    "An instance that came back from a long GC pause heartbeats renewed for hours while no router lists it, and a replica still on yesterday's build flips metadata_version back after a rollout.",
    'EXISTS, HSET and EXPIRE are three commands: the record can lapse and the sweep drop the member between the first two, and HSET recreates the hash. Nothing compares versions, and the TTL is a constant.',
    'One `register_script`: HGET `metadata_version` (nil → `gone`), `tonumber(ARGV[3])` below it → `stale`, else HSET the fields and EXPIRE `TTL_INTERVALS * heartbeat_interval` seconds; return `renewed`.',
  ],
  debrief: `The script is the unit of truth: existence, version and expiry are one decision, so it runs where nothing can interleave. Answering \`gone\` instead of recreating the record keeps the members set and the records in agreement, because only registration adds a member. The version comparison makes heartbeats monotonic per identity, which is what lets a rollout survive a replica that lags. Deriving the TTL from the interval in the same request keeps the failure detector proportional: a 2 s heartbeat is declared dead after 6 s, a 20 s one after a minute. Production registries stamp the heartbeat with the server's clock (Redis \`TIME\`) so a skewed host cannot claim freshness it does not have.`,
};
