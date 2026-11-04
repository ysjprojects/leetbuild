import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis: one versioned snapshot, per-flag bucketing',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'sdk'],
  task: `## Task

**Starting point.** The starter is the evaluation engine every request reads:
\`publish_snapshot(snapshot)\` writes each flag of \`{"version": n, "flags": {key: {default, rules,
rollout, salt, killed}}}\` under its own \`flags:rule:{key}\` and then \`flags:version\`;
\`read_snapshot()\` and \`evaluate(flag_key, attrs)\` read them back; \`bucket(flag_key, user_id, salt)\`
places a user in 0 to 99. It serves the demo and hides three flaws.

**Failure mode the checks target.** A request that lands during a ten-flag rollout gets the new
checkout with the old payments rules and a version that matches neither. A publisher that was slow
turns a rollout back to an older version. Users in one flag's 25% tail sit in every flag's tail.

- The whole snapshot is **one JSON document** under \`flags:snapshot\`; \`read_snapshot\` is one GET and
  \`evaluate\` reads the snapshot once. A flag dropped from a version is gone with it.
- \`publish_snapshot\` is **one Lua script** over \`KEYS = [flags:snapshot, flags:snapshot:version]\`,
  \`ARGV = [document, version]\`: it replaces both only when \`ARGV[2]\` is newer than the stored
  version, and the function returns whether it did.
- \`bucket\` is \`fnv1a32(f"{salt}.{flag_key}.{user_id}") % 100\` (\`flags.hashing\`), so every flag
  splits users on its own.`,
  sequence: {
    participants: ['flagsvc', 'Redis', 'Evaluation'],
    messages: [
      {from: 'flagsvc', to: 'Redis', label: 'EVAL swap flags:snapshot flags:snapshot:version {doc} 42', kind: 'sync'},
      {from: 'Redis', to: 'flagsvc', label: '1 replaced · 0 a version ≥ 42 is already there', kind: 'reply'},
      {from: 'Evaluation', to: 'Redis', label: 'GET flags:snapshot', kind: 'sync'},
      {from: 'Redis', to: 'Evaluation', label: 'one whole rule set, version 42', kind: 'reply'},
      {from: 'Evaluation', to: 'Evaluation', label: 'bucket = fnv1a32("salt.flag.user") % 100', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'one-snapshot',
      title: 'Reads and writes the rule set as one document',
      detail:
        'The snapshot lives under `flags:snapshot` as one value, read with one GET; no per-flag `flags:rule:{key}` keys, which a reader sees half-updated and which outlive the version that dropped the flag.',
      match: {
        python: {all: [/flags:snapshot/], none: [/flags:rule:/]},
        typescript: {all: [/flags:snapshot/], none: [/flags:rule:/]},
        go: {all: [/flags:snapshot/], none: [/flags:rule:/]},
        scala: {all: [/flags:snapshot/], none: [/flags:rule:/]},
        cpp: {all: [/flags:snapshot/], none: [/flags:rule:/]},
      },
    },
    {
      id: 'newer-only',
      title: 'Only a newer version replaces the snapshot',
      detail:
        'The swap is one Lua script (`register_script`/`defineCommand`/`NewScript`/`eval`) that compares the stored version with `ARGV[2]` (`tonumber`) before writing; a plain SET lets a late publisher put an older rule set back.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /tonumber\(/, /ARGV\[2\]/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /tonumber\(/, /ARGV\[2\]/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /tonumber\(/, /ARGV\[2\]/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /tonumber\(/, /ARGV\[2\]/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /tonumber\(/, /ARGV\[2\]/]},
      },
    },
    {
      id: 'bucket-per-flag',
      title: 'Buckets by salt, flag key and user',
      detail:
        '`bucket` hashes the flag key with the salt and the user id, so two flags with the same salt split users independently; the starter hashes only the salt and the user.',
      match: {
        python: {all: [/def bucket(?:(?!\ndef )[\s\S])*?fnv1a32\([^\n]*flag_key/]},
        typescript: {all: [/function bucket(?:(?!\n(?:export )?(?:async )?function )[\s\S])*?fnv1a32\([^\n]*flagKey/]},
        go: {all: [/func bucket(?:(?!\n\})[\s\S])*?Fnv1a32\([^\n]*flagKey/]},
        scala: {all: [/def bucket(?:(?!\n {2}(?:private )?def )[\s\S])*?fnv1a32\([^\n]*flagKey/]},
        cpp: {all: [/int bucket\((?:(?!\n\})[\s\S])*?fnv1a32\([^\n]*flag_key/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from flags.hashing import fnv1a32
from flags.registry import rule_matches

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def publish_snapshot(snapshot: dict) -> bool:
    """Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    for key, flag in snapshot["flags"].items():
        r.set(f"flags:rule:{key}", json.dumps(flag))
    r.set("flags:version", snapshot["version"])
    return True


def read_snapshot() -> dict | None:
    """The whole rule set."""
    version = r.get("flags:version")
    if version is None:
        return None
    flags = {key.removeprefix("flags:rule:"): json.loads(r.get(key)) for key in r.keys("flags:rule:*")}
    return {"version": int(version), "flags": flags}


def bucket(flag_key: str, user_id: str, salt: str) -> int:
    return fnv1a32(f"{salt}.{user_id}") % 100


def _decide(flag_key: str, flag: dict, attrs: dict, version: int) -> dict:
    b = bucket(flag_key, attrs.get("user_id", ""), flag["salt"])
    if flag.get("killed"):
        value, reason = flag["default"], "killed"
    elif not all(rule_matches(rule, attrs) for rule in flag["rules"]):
        value, reason = flag["default"], "no-match"
    elif b < flag["rollout"]:
        value, reason = True, "in-rollout"
    else:
        value, reason = flag["default"], "out-of-rollout"
    return {"flag_key": flag_key, "value": value, "reason": reason, "bucket": b, "version": version}


def evaluate(flag_key: str, attrs: dict) -> dict | None:
    """The decision for the user with these attributes (user_id among them), or None for an unknown flag."""
    version = r.get("flags:version")
    raw = r.get(f"flags:rule:{flag_key}")
    if version is None or raw is None:
        return None
    return _decide(flag_key, json.loads(raw), attrs, int(version))
`,
      solution: `import json

import redis

from flags.hashing import fnv1a32
from flags.registry import rule_matches

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SNAPSHOT_KEY = "flags:snapshot"
VERSION_KEY = "flags:snapshot:version"
# Replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
SWAP_LUA = """
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
"""
swap = r.register_script(SWAP_LUA)


def publish_snapshot(snapshot: dict) -> bool:
    """Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read."""
    return swap(keys=[SNAPSHOT_KEY, VERSION_KEY], args=[json.dumps(snapshot), snapshot["version"]]) == 1


def read_snapshot() -> dict | None:
    """The whole rule set."""
    raw = r.get(SNAPSHOT_KEY)
    return json.loads(raw) if raw else None


def bucket(flag_key: str, user_id: str, salt: str) -> int:
    return fnv1a32(f"{salt}.{flag_key}.{user_id}") % 100


def _decide(flag_key: str, flag: dict, attrs: dict, version: int) -> dict:
    b = bucket(flag_key, attrs.get("user_id", ""), flag["salt"])
    if flag.get("killed"):
        value, reason = flag["default"], "killed"
    elif not all(rule_matches(rule, attrs) for rule in flag["rules"]):
        value, reason = flag["default"], "no-match"
    elif b < flag["rollout"]:
        value, reason = True, "in-rollout"
    else:
        value, reason = flag["default"], "out-of-rollout"
    return {"flag_key": flag_key, "value": value, "reason": reason, "bucket": b, "version": version}


def evaluate(flag_key: str, attrs: dict) -> dict | None:
    """The decision for the user with these attributes (user_id among them), or None for an unknown flag."""
    snapshot = read_snapshot()  # one read: the flag and the version come from the same rule set
    flag = None if snapshot is None else snapshot["flags"].get(flag_key)
    if flag is None:
        return None
    return _decide(flag_key, flag, attrs, snapshot["version"])
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {fnv1a32} from 'flags/hashing';
import {type Rule, ruleMatches} from 'flags/registry';

const redis = new Redis({host: 'redis', port: 6379});

export interface Flag {
  default: boolean;
  rules: Rule[];
  rollout: number;
  salt: string;
  killed: boolean;
}

export interface Snapshot {
  version: number;
  flags: Record<string, Flag>;
}

export interface Decision {
  flag_key: string;
  value: boolean;
  reason: string;
  bucket: number;
  version: number;
}

/** Make snapshot the one evaluations read. */
export async function publishSnapshot(snapshot: Snapshot): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  for (const [key, flag] of Object.entries(snapshot.flags)) await redis.set(\`flags:rule:\${key}\`, JSON.stringify(flag));
  await redis.set('flags:version', snapshot.version);
  return true;
}

/** The whole rule set. */
export async function readSnapshot(): Promise<Snapshot | null> {
  const version = await redis.get('flags:version');
  if (version === null) return null;
  const flags: Record<string, Flag> = {};
  for (const key of await redis.keys('flags:rule:*')) flags[key.slice('flags:rule:'.length)] = JSON.parse((await redis.get(key)) ?? '{}') as Flag;
  return {version: Number(version), flags};
}

export function bucket(flagKey: string, userId: string, salt: string): number {
  return fnv1a32(\`\${salt}.\${userId}\`) % 100;
}

function decide(flagKey: string, flag: Flag, attrs: Record<string, string>, version: number): Decision {
  const b = bucket(flagKey, attrs.user_id ?? '', flag.salt);
  let value = flag.default;
  let reason = 'out-of-rollout';
  if (flag.killed) reason = 'killed';
  else if (!flag.rules.every(rule => ruleMatches(rule, attrs))) reason = 'no-match';
  else if (b < flag.rollout) [value, reason] = [true, 'in-rollout'];
  return {flag_key: flagKey, value, reason, bucket: b, version};
}

/** The decision for the user with these attributes (user_id among them), or null for an unknown flag. */
export async function evaluate(flagKey: string, attrs: Record<string, string>): Promise<Decision | null> {
  const version = await redis.get('flags:version');
  const raw = await redis.get(\`flags:rule:\${flagKey}\`);
  if (version === null || raw === null) return null;
  return decide(flagKey, JSON.parse(raw) as Flag, attrs, Number(version));
}
`,
      solution: `import Redis from 'ioredis';

import {fnv1a32} from 'flags/hashing';
import {type Rule, ruleMatches} from 'flags/registry';

export interface Flag {
  default: boolean;
  rules: Rule[];
  rollout: number;
  salt: string;
  killed: boolean;
}

export interface Snapshot {
  version: number;
  flags: Record<string, Flag>;
}

export interface Decision {
  flag_key: string;
  value: boolean;
  reason: string;
  bucket: number;
  version: number;
}

export const SNAPSHOT_KEY = 'flags:snapshot';
export const VERSION_KEY = 'flags:snapshot:version';
// Replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
export const SWAP_LUA = \`
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
\`;

interface SwapRedis extends Redis {
  swapSnapshot(snapshotKey: string, versionKey: string, doc: string, version: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapSnapshot', {numberOfKeys: 2, lua: SWAP_LUA});

/** Make snapshot the one evaluations read. */
export async function publishSnapshot(snapshot: Snapshot): Promise<boolean> {
  return (await redis.swapSnapshot(SNAPSHOT_KEY, VERSION_KEY, JSON.stringify(snapshot), snapshot.version)) === 1;
}

/** The whole rule set. */
export async function readSnapshot(): Promise<Snapshot | null> {
  const raw = await redis.get(SNAPSHOT_KEY);
  return raw === null ? null : (JSON.parse(raw) as Snapshot);
}

export function bucket(flagKey: string, userId: string, salt: string): number {
  return fnv1a32(\`\${salt}.\${flagKey}.\${userId}\`) % 100;
}

function decide(flagKey: string, flag: Flag, attrs: Record<string, string>, version: number): Decision {
  const b = bucket(flagKey, attrs.user_id ?? '', flag.salt);
  let value = flag.default;
  let reason = 'out-of-rollout';
  if (flag.killed) reason = 'killed';
  else if (!flag.rules.every(rule => ruleMatches(rule, attrs))) reason = 'no-match';
  else if (b < flag.rollout) [value, reason] = [true, 'in-rollout'];
  return {flag_key: flagKey, value, reason, bucket: b, version};
}

/** The decision for the user with these attributes (user_id among them), or null for an unknown flag. */
export async function evaluate(flagKey: string, attrs: Record<string, string>): Promise<Decision | null> {
  const snapshot = await readSnapshot(); // one read: the flag and the version come from the same rule set
  if (snapshot === null || !Object.hasOwn(snapshot.flags, flagKey)) return null;
  return decide(flagKey, snapshot.flags[flagKey], attrs, snapshot.version);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/redis/go-redis/v9"

	"flags/hashing"  // hashing.Fnv1a32
	"flags/registry" // registry.Rule, RuleMatches
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Flag is one flag as evaluations see it.
type Flag struct {
	Default bool            \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
	Salt    string          \`json:"salt"\`
	Killed  bool            \`json:"killed"\`
}

// Snapshot is the whole rule set at one version.
type Snapshot struct {
	Version int64           \`json:"version"\`
	Flags   map[string]Flag \`json:"flags"\`
}

// Decision is what one evaluation served.
type Decision struct {
	FlagKey string \`json:"flag_key"\`
	Value   bool   \`json:"value"\`
	Reason  string \`json:"reason"\`
	Bucket  int    \`json:"bucket"\`
	Version int64  \`json:"version"\`
}

// publishSnapshot makes s the snapshot evaluations read.
func publishSnapshot(ctx context.Context, s Snapshot) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	for key, flag := range s.Flags {
		raw, _ := json.Marshal(flag)
		if err := rdb.Set(ctx, "flags:rule:"+key, raw, 0).Err(); err != nil {
			return false, err
		}
	}
	return true, rdb.Set(ctx, "flags:version", s.Version, 0).Err()
}

// readSnapshot is the whole rule set (nil when none was published).
func readSnapshot(ctx context.Context) (*Snapshot, error) {
	version, err := rdb.Get(ctx, "flags:version").Int64()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	keys, err := rdb.Keys(ctx, "flags:rule:*").Result()
	if err != nil {
		return nil, err
	}
	s := &Snapshot{Version: version, Flags: map[string]Flag{}}
	for _, key := range keys {
		var flag Flag
		raw, _ := rdb.Get(ctx, key).Result()
		json.Unmarshal([]byte(raw), &flag)
		s.Flags[strings.TrimPrefix(key, "flags:rule:")] = flag
	}
	return s, nil
}

// bucket places a user in 0..99 for one flag.
func bucket(flagKey, userID, salt string) int {
	return int(hashing.Fnv1a32(salt+"."+userID) % 100)
}

func decide(flagKey string, flag Flag, attrs map[string]string, version int64) *Decision {
	d := &Decision{FlagKey: flagKey, Value: flag.Default, Reason: "out-of-rollout", Bucket: bucket(flagKey, attrs["user_id"], flag.Salt), Version: version}
	matched := true
	for _, rule := range flag.Rules {
		matched = matched && registry.RuleMatches(rule, attrs)
	}
	switch {
	case flag.Killed:
		d.Reason = "killed"
	case !matched:
		d.Reason = "no-match"
	case d.Bucket < flag.Rollout:
		d.Value, d.Reason = true, "in-rollout"
	}
	return d
}

// evaluate is the decision for the user with these attributes (user_id among them); nil for an unknown flag.
func evaluate(ctx context.Context, flagKey string, attrs map[string]string) (*Decision, error) {
	version, err := rdb.Get(ctx, "flags:version").Int64()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	raw, err := rdb.Get(ctx, "flags:rule:"+flagKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var flag Flag
	if err := json.Unmarshal([]byte(raw), &flag); err != nil {
		return nil, err
	}
	return decide(flagKey, flag, attrs, version), nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"flags/hashing"  // hashing.Fnv1a32
	"flags/registry" // registry.Rule, RuleMatches
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Flag is one flag as evaluations see it.
type Flag struct {
	Default bool            \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
	Salt    string          \`json:"salt"\`
	Killed  bool            \`json:"killed"\`
}

// Snapshot is the whole rule set at one version.
type Snapshot struct {
	Version int64           \`json:"version"\`
	Flags   map[string]Flag \`json:"flags"\`
}

// Decision is what one evaluation served.
type Decision struct {
	FlagKey string \`json:"flag_key"\`
	Value   bool   \`json:"value"\`
	Reason  string \`json:"reason"\`
	Bucket  int    \`json:"bucket"\`
	Version int64  \`json:"version"\`
}

const (
	snapshotKey = "flags:snapshot"
	versionKey  = "flags:snapshot:version"
)

// swapSnapshot replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
var swapSnapshot = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
\`)

// publishSnapshot makes s the snapshot evaluations read.
func publishSnapshot(ctx context.Context, s Snapshot) (bool, error) {
	raw, _ := json.Marshal(s)
	moved, err := swapSnapshot.Run(ctx, rdb, []string{snapshotKey, versionKey}, string(raw), s.Version).Int64()
	return moved == 1, err
}

// readSnapshot is the whole rule set (nil when none was published).
func readSnapshot(ctx context.Context) (*Snapshot, error) {
	raw, err := rdb.Get(ctx, snapshotKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s Snapshot
	return &s, json.Unmarshal([]byte(raw), &s)
}

// bucket places a user in 0..99 for one flag.
func bucket(flagKey, userID, salt string) int {
	return int(hashing.Fnv1a32(salt+"."+flagKey+"."+userID) % 100)
}

func decide(flagKey string, flag Flag, attrs map[string]string, version int64) *Decision {
	d := &Decision{FlagKey: flagKey, Value: flag.Default, Reason: "out-of-rollout", Bucket: bucket(flagKey, attrs["user_id"], flag.Salt), Version: version}
	matched := true
	for _, rule := range flag.Rules {
		matched = matched && registry.RuleMatches(rule, attrs)
	}
	switch {
	case flag.Killed:
		d.Reason = "killed"
	case !matched:
		d.Reason = "no-match"
	case d.Bucket < flag.Rollout:
		d.Value, d.Reason = true, "in-rollout"
	}
	return d
}

// evaluate is the decision for the user with these attributes (user_id among them); nil for an unknown flag.
func evaluate(ctx context.Context, flagKey string, attrs map[string]string) (*Decision, error) {
	s, err := readSnapshot(ctx) // one read: the flag and the version come from the same rule set
	if err != nil || s == nil {
		return nil, err
	}
	flag, known := s.Flags[flagKey]
	if !known {
		return nil, nil
	}
	return decide(flagKey, flag, attrs, s.Version), nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import flags.{Hashing, Registry} // Hashing.fnv1a32; Registry.ruleMatches

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read. */
  def publishSnapshot(snapshot: JsObject): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    snapshot.fields("flags").asJsObject.fields.foreach { case (key, flag) => jedis.set(s"flags:rule:$key", flag.compactPrint) }
    jedis.set("flags:version", snapshot.fields("version").toString)
    true
  }

  /** The whole rule set. */
  def readSnapshot(): Option[JsObject] =
    Option(jedis.get("flags:version")).map { version =>
      val flags = jedis.keys("flags:rule:*").asScala.toSeq.map(key => key.stripPrefix("flags:rule:") -> jedis.get(key).parseJson)
      JsObject("version" -> JsNumber(version.toLong), "flags" -> JsObject(flags.toMap))
    }

  def bucket(flagKey: String, userId: String, salt: String): Int = (Hashing.fnv1a32(s"$salt.$userId") % 100).toInt

  private def decide(flagKey: String, flag: Map[String, JsValue], attrs: Map[String, String], version: JsValue): JsObject = {
    val default = flag.get("default").contains(JsTrue)
    val salt = flag.get("salt").collect { case JsString(s) => s }.getOrElse(flagKey)
    val rollout = flag.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
    val rules = flag.get("rules").collect { case JsArray(rs) => rs.map(_.asJsObject) }.getOrElse(Vector.empty)
    val b = bucket(flagKey, attrs.getOrElse("user_id", ""), salt)
    val (value, reason) =
      if (flag.get("killed").contains(JsTrue)) (default, "killed")
      else if (!rules.forall(Registry.ruleMatches(_, attrs))) (default, "no-match")
      else if (b < rollout) (true, "in-rollout")
      else (default, "out-of-rollout")
    JsObject("flag_key" -> JsString(flagKey), "value" -> JsBoolean(value), "reason" -> JsString(reason), "bucket" -> JsNumber(b), "version" -> version)
  }

  /** The decision for the user with these attributes (user_id among them), or None for an unknown flag. */
  def evaluate(flagKey: String, attrs: Map[String, String]): Option[JsObject] =
    for {
      version <- Option(jedis.get("flags:version"))
      raw <- Option(jedis.get(s"flags:rule:$flagKey"))
    } yield decide(flagKey, raw.parseJson.asJsObject.fields, attrs, JsNumber(version.toLong))
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import flags.{Hashing, Registry} // Hashing.fnv1a32; Registry.ruleMatches

object State {
  val jedis = new JedisPooled("redis", 6379)

  val SnapshotKey = "flags:snapshot"
  val VersionKey = "flags:snapshot:version"
  // Replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
  val SwapLua: String =
    """local current = tonumber(redis.call('GET', KEYS[2]) or '0')
      |if current >= tonumber(ARGV[2]) then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('SET', KEYS[2], ARGV[2])
      |return 1
      |""".stripMargin

  /** Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read. */
  def publishSnapshot(snapshot: JsObject): Boolean = {
    val version = snapshot.fields("version").asInstanceOf[JsNumber].value.toLong
    jedis.eval(SwapLua, List(SnapshotKey, VersionKey).asJava, List(snapshot.compactPrint, version.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** The whole rule set. */
  def readSnapshot(): Option[JsObject] = Option(jedis.get(SnapshotKey)).map(_.parseJson.asJsObject)

  def bucket(flagKey: String, userId: String, salt: String): Int = (Hashing.fnv1a32(s"$salt.$flagKey.$userId") % 100).toInt

  private def decide(flagKey: String, flag: Map[String, JsValue], attrs: Map[String, String], version: JsValue): JsObject = {
    val default = flag.get("default").contains(JsTrue)
    val salt = flag.get("salt").collect { case JsString(s) => s }.getOrElse(flagKey)
    val rollout = flag.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
    val rules = flag.get("rules").collect { case JsArray(rs) => rs.map(_.asJsObject) }.getOrElse(Vector.empty)
    val b = bucket(flagKey, attrs.getOrElse("user_id", ""), salt)
    val (value, reason) =
      if (flag.get("killed").contains(JsTrue)) (default, "killed")
      else if (!rules.forall(Registry.ruleMatches(_, attrs))) (default, "no-match")
      else if (b < rollout) (true, "in-rollout")
      else (default, "out-of-rollout")
    JsObject("flag_key" -> JsString(flagKey), "value" -> JsBoolean(value), "reason" -> JsString(reason), "bucket" -> JsNumber(b), "version" -> version)
  }

  /** The decision for the user with these attributes (user_id among them), or None for an unknown flag. */
  def evaluate(flagKey: String, attrs: Map[String, String]): Option[JsObject] =
    // One read: the flag and the version come from the same rule set.
    readSnapshot().flatMap { snapshot =>
      snapshot.fields("flags").asJsObject.fields.get(flagKey).map(flag => decide(flagKey, flag.asJsObject.fields, attrs, snapshot.fields("version")))
    }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "flags/hashing.h"   // hashing::fnv1a32
#include "flags/registry.h"  // registry::ruleMatches

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read.
bool publishSnapshot(const json& snapshot) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  for (const auto& item : snapshot.at("flags").items()) redis.set("flags:rule:" + item.key(), item.value().dump());
  redis.set("flags:version", std::to_string(snapshot.at("version").get<long long>()));
  return true;
}

// The whole rule set.
std::optional<json> readSnapshot() {
  const auto version = redis.get("flags:version");
  if (!version) return std::nullopt;
  std::vector<std::string> keys;
  redis.keys("flags:rule:*", std::back_inserter(keys));
  json flags = json::object();
  for (const std::string& key : keys) {
    const auto raw = redis.get(key);
    if (raw) flags[key.substr(std::string("flags:rule:").size())] = json::parse(*raw);
  }
  return json{{"version", std::stoll(*version)}, {"flags", flags}};
}

int bucket(const std::string& flag_key, const std::string& user_id, const std::string& salt) {
  return static_cast<int>(hashing::fnv1a32(salt + "." + user_id) % 100);
}

json decide(const std::string& flag_key, const json& flag, const std::map<std::string, std::string>& attrs, long long version) {
  const auto user = attrs.find("user_id");
  const int b = bucket(flag_key, user == attrs.end() ? "" : user->second, flag.value("salt", flag_key));
  bool matched = true;
  for (const auto& rule : flag.value("rules", json::array())) matched = matched && registry::ruleMatches(rule, attrs);
  bool value = flag.value("default", false);
  std::string reason = "out-of-rollout";
  if (flag.value("killed", false)) {
    reason = "killed";
  } else if (!matched) {
    reason = "no-match";
  } else if (b < flag.value("rollout", 0)) {
    value = true;
    reason = "in-rollout";
  }
  return json{{"flag_key", flag_key}, {"value", value}, {"reason", reason}, {"bucket", b}, {"version", version}};
}

// The decision for the user with these attributes (user_id among them), or none for an unknown flag.
std::optional<json> evaluate(const std::string& flag_key, const std::map<std::string, std::string>& attrs) {
  const auto version = redis.get("flags:version");
  const auto raw = redis.get("flags:rule:" + flag_key);
  if (!version || !raw) return std::nullopt;
  return decide(flag_key, json::parse(*raw), attrs, std::stoll(*version));
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>

#include "flags/hashing.h"   // hashing::fnv1a32
#include "flags/registry.h"  // registry::ruleMatches

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kSnapshotKey = "flags:snapshot";
const std::string kVersionKey = "flags:snapshot:version";
// Replaces the snapshot (ARGV[1]) and its version (ARGV[2]) only when that version is newer.
const std::string kSwapLua = R"lua(
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1
)lua";

// Make snapshot ({"version": n, "flags": {key: {default, rules, rollout, salt, killed}}}) the one evaluations read.
bool publishSnapshot(const json& snapshot) {
  const std::string version = std::to_string(snapshot.at("version").get<long long>());
  return redis.eval<long long>(kSwapLua, {kSnapshotKey, kVersionKey}, {snapshot.dump(), version}) == 1;
}

// The whole rule set.
std::optional<json> readSnapshot() {
  const auto raw = redis.get(kSnapshotKey);
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}

int bucket(const std::string& flag_key, const std::string& user_id, const std::string& salt) {
  return static_cast<int>(hashing::fnv1a32(salt + "." + flag_key + "." + user_id) % 100);
}

json decide(const std::string& flag_key, const json& flag, const std::map<std::string, std::string>& attrs, long long version) {
  const auto user = attrs.find("user_id");
  const int b = bucket(flag_key, user == attrs.end() ? "" : user->second, flag.value("salt", flag_key));
  bool matched = true;
  for (const auto& rule : flag.value("rules", json::array())) matched = matched && registry::ruleMatches(rule, attrs);
  bool value = flag.value("default", false);
  std::string reason = "out-of-rollout";
  if (flag.value("killed", false)) {
    reason = "killed";
  } else if (!matched) {
    reason = "no-match";
  } else if (b < flag.value("rollout", 0)) {
    value = true;
    reason = "in-rollout";
  }
  return json{{"flag_key", flag_key}, {"value", value}, {"reason", reason}, {"bucket", b}, {"version", version}};
}

// The decision for the user with these attributes (user_id among them), or none for an unknown flag.
std::optional<json> evaluate(const std::string& flag_key, const std::map<std::string, std::string>& attrs) {
  const auto snapshot = readSnapshot();  // one read: the flag and the version come from the same rule set
  if (!snapshot || !snapshot->at("flags").contains(flag_key)) return std::nullopt;
  return decide(flag_key, snapshot->at("flags").at(flag_key), attrs, snapshot->at("version").get<long long>());
}
`,
    },
  },
  harness: {
    python: `from flags.hashing import fnv1a32

USER = {"user_id": "u-7", "country": "US"}
USERS = [f"u-{i}" for i in range(400)]


def _flag(rollout, salt="2026"):
    return {"default": False, "rules": [], "rollout": rollout, "salt": salt, "killed": False}


V1 = {"version": 1, "flags": {"checkout": _flag(0), "payments": _flag(0)}}
V2 = {"version": 2, "flags": {"checkout": _flag(100), "payments": _flag(100)}}


def _pair(m):
    return [m.evaluate("checkout", USER), m.evaluate("payments", USER)]


def _consistent(pair, when):
    assert None not in pair, f"a read {when} found no flag: {pair}"
    versions = sorted({d["version"] for d in pair})
    assert len(versions) == 1, f"a read {when} evaluated checkout and payments against versions {versions}: one request saw two rule sets"
    for d in pair:
        assert d["value"] is (d["version"] == 2), f"a read {when} answered {d}: version {d['version']} with the other version's rollout. The rule set was torn between two writes"


def check_one_snapshot(ctx):
    m = ctx.load("state")
    assert m.publish_snapshot(V1) is True, "the first snapshot must be applied"
    # A request lands while version 2 is being written: it must see one whole rule set.
    probes = [ctx.redis_after(key, lambda: _pair(m)) for key in ("flags:rule:checkout", "flags:snapshot")]
    assert m.publish_snapshot(V2) is True, "version 2 over version 1 must be applied"
    for probe in probes:
        if probe.fired:
            if probe.error is not None:
                raise probe.error
            _consistent(probe.result, "during the publish of version 2")
    after = _pair(m)
    _consistent(after, "after the publish")
    assert after[0]["version"] == 2, f"after publishing version 2 evaluate answers {after[0]}"
    v3 = {"version": 3, "flags": {"checkout": _flag(100)}}
    assert m.publish_snapshot(v3) is True, "version 3 must be applied"
    assert m.evaluate("payments", USER) is None, f"payments is not in version 3, yet it still evaluates to {m.evaluate('payments', USER)}: per-flag keys outlive the snapshot that dropped them"
    assert m.read_snapshot() == v3, f"read_snapshot gives {m.read_snapshot()}, expected version 3 exactly"


def check_newer_only(ctx):
    m = ctx.load("state")
    assert m.publish_snapshot(V2) is True, "the first snapshot must be applied"
    late = m.publish_snapshot(V1)
    assert late is False, "a publisher that was slow applied version 1 over version 2 (publish_snapshot answered True): the rollout went back. Only a newer version may replace the snapshot"
    assert m.read_snapshot() == V2, f"after the late version 1 the snapshot is {m.read_snapshot()}, expected version 2"
    d = m.evaluate("checkout", USER)
    assert d is not None and d["version"] == 2 and d["value"] is True, f"after the late version 1 evaluate answers {d}, expected version 2 in the rollout"
    v3 = {"version": 3, "flags": {"checkout": _flag(0), "payments": _flag(0)}}
    assert m.publish_snapshot(v3) is True, "a newer version (3) must be applied"
    assert m.evaluate("checkout", USER)["version"] == 3, f"after version 3 evaluate answers {m.evaluate('checkout', USER)}"


def check_bucket_per_flag(ctx):
    m = ctx.load("state")
    checkout = {u for u in USERS if m.bucket("checkout", u, "2026") < 50}
    payments = {u for u in USERS if m.bucket("payments", u, "2026") < 50}
    overlap = len(checkout & payments)
    assert overlap < 0.8 * min(len(checkout), len(payments)), f"at 50% each, checkout and payments (same salt) share {overlap} of their {len(checkout)} and {len(payments)} users: the same people are in every rollout. Hash the flag key too"
    for user in USERS[:20]:
        b = m.bucket("checkout", user, "2026")
        assert 0 <= b < 100 and b == m.bucket("checkout", user, "2026"), f"bucket(checkout, {user}, 2026) answered {b}, then {m.bucket('checkout', user, '2026')}: a bucket is a stable number in 0..99"
    want = fnv1a32("2026.checkout.u-7") % 100
    assert m.bucket("checkout", "u-7", "2026") == want, f"bucket(checkout, u-7, 2026) is {m.bucket('checkout', 'u-7', '2026')}, expected fnv1a32(\\"2026.checkout.u-7\\") % 100 = {want}"
    m.publish_snapshot({"version": 1, "flags": {"checkout": _flag(50), "payments": _flag(50)}})
    for user in USERS[:40]:
        d = m.evaluate("checkout", {"user_id": user})
        b = m.bucket("checkout", user, "2026")
        assert d["bucket"] == b and d["value"] is (b < 50), f"evaluate(checkout, {user}) answered {d}, but the user's bucket is {b} at a 50% rollout"
`,
    typescript: `const USER = {user_id: 'u-7', country: 'US'};
const USERS = Array.from({length: 400}, (_, i) => \`u-\${i}\`);

const flag = (rollout: number, salt = '2026') => ({default: false, rules: [], rollout, salt, killed: false});

const V1 = {version: 1, flags: {checkout: flag(0), payments: flag(0)}};
const V2 = {version: 2, flags: {checkout: flag(100), payments: flag(100)}};

const pair = m => Promise.all([m.evaluate('checkout', USER), m.evaluate('payments', USER)]);

function consistent(seen, when: string): void {
  assert(!seen.includes(null), \`a read \${when} found no flag: \${JSON.stringify(seen)}\`);
  const versions = [...new Set(seen.map(d => d.version))];
  assert.equal(versions.length, 1, \`a read \${when} evaluated checkout and payments against versions \${JSON.stringify(versions)}: one request saw two rule sets\`);
  for (const d of seen) assert.equal(d.value, d.version === 2, \`a read \${when} answered \${JSON.stringify(d)}: version \${d.version} with the other version's rollout. The rule set was torn between two writes\`);
}

export async function check_one_snapshot(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.publishSnapshot(V1), true, 'the first snapshot must be applied');
  // A request lands while version 2 is being written: it must see one whole rule set.
  const probes = ['flags:rule:checkout', 'flags:snapshot'].map(key => ctx.redisAfter(key, () => pair(m)));
  assert.equal(await m.publishSnapshot(V2), true, 'version 2 over version 1 must be applied');
  for (const probe of probes) {
    if (!probe.fired) continue;
    if (probe.error !== undefined) throw probe.error;
    consistent(await probe.result, 'during the publish of version 2');
  }
  const after = await pair(m);
  consistent(after, 'after the publish');
  assert.equal(after[0].version, 2, \`after publishing version 2 evaluate answers \${JSON.stringify(after[0])}\`);
  const v3 = {version: 3, flags: {checkout: flag(100)}};
  assert.equal(await m.publishSnapshot(v3), true, 'version 3 must be applied');
  const stale = await m.evaluate('payments', USER);
  assert.equal(stale, null, \`payments is not in version 3, yet it still evaluates to \${JSON.stringify(stale)}: per-flag keys outlive the snapshot that dropped them\`);
  assert.deepStrictEqual(await m.readSnapshot(), v3, 'readSnapshot must give version 3 exactly');
}

export async function check_newer_only(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.publishSnapshot(V2), true, 'the first snapshot must be applied');
  const late = await m.publishSnapshot(V1);
  assert.equal(late, false, 'a publisher that was slow applied version 1 over version 2 (publishSnapshot answered true): the rollout went back. Only a newer version may replace the snapshot');
  assert.deepStrictEqual(await m.readSnapshot(), V2, 'after the late version 1 the snapshot must still be version 2');
  const d = await m.evaluate('checkout', USER);
  assert(d !== null && d.version === 2 && d.value === true, \`after the late version 1 evaluate answers \${JSON.stringify(d)}, expected version 2 in the rollout\`);
  const v3 = {version: 3, flags: {checkout: flag(0), payments: flag(0)}};
  assert.equal(await m.publishSnapshot(v3), true, 'a newer version (3) must be applied');
  assert.equal((await m.evaluate('checkout', USER)).version, 3, 'after version 3 evaluate must answer version 3');
}

export async function check_bucket_per_flag(ctx) {
  const m = ctx.load('state');
  const {fnv1a32} = ctx.load('/support/flags/hashing.ts');
  const checkout = new Set(USERS.filter(u => m.bucket('checkout', u, '2026') < 50));
  const payments = new Set(USERS.filter(u => m.bucket('payments', u, '2026') < 50));
  const overlap = [...checkout].filter(u => payments.has(u)).length;
  assert(overlap < 0.8 * Math.min(checkout.size, payments.size), \`at 50% each, checkout and payments (same salt) share \${overlap} of their \${checkout.size} and \${payments.size} users: the same people are in every rollout. Hash the flag key too\`);
  for (const user of USERS.slice(0, 20)) {
    const b = m.bucket('checkout', user, '2026');
    assert(Number.isInteger(b) && b >= 0 && b < 100 && b === m.bucket('checkout', user, '2026'), \`bucket(checkout, \${user}, 2026) answered \${b}: a bucket is a stable integer in 0..99\`);
  }
  const want = fnv1a32('2026.checkout.u-7') % 100;
  assert.equal(m.bucket('checkout', 'u-7', '2026'), want, \`bucket(checkout, u-7, 2026) must be fnv1a32("2026.checkout.u-7") % 100 = \${want}\`);
  await m.publishSnapshot({version: 1, flags: {checkout: flag(50), payments: flag(50)}});
  for (const user of USERS.slice(0, 40)) {
    const d = await m.evaluate('checkout', {user_id: user});
    const b = m.bucket('checkout', user, '2026');
    assert(d.bucket === b && d.value === b < 50, \`evaluate(checkout, \${user}) answered \${JSON.stringify(d)}, but the user's bucket is \${b} at a 50% rollout\`);
  }
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"flags/hashing"

	"leetbuild/harness"
)

var (
	stateBg   = context.Background()
	stateUser = map[string]string{"user_id": "u-7", "country": "US"}
)

func stateFlag(rollout int) Flag {
	return Flag{Default: false, Rollout: rollout, Salt: "2026"}
}

func stateSnap(version int64, rollout int, keys ...string) Snapshot {
	s := Snapshot{Version: version, Flags: map[string]Flag{}}
	for _, k := range keys {
		s.Flags[k] = stateFlag(rollout)
	}
	return s
}

func statePublish(ctx *harness.Ctx, s Snapshot) bool {
	moved, err := publishSnapshot(stateBg, s)
	ctx.NoError(err, "publishSnapshot(version %d) failed", s.Version)
	return moved
}

func stateEval(ctx *harness.Ctx, key string, attrs map[string]string) *Decision {
	d, err := evaluate(stateBg, key, attrs)
	ctx.NoError(err, "evaluate(%s) failed", key)
	return d
}

type statePair struct {
	decisions []*Decision
	err       error
}

func stateRead() statePair {
	var out statePair
	for _, key := range []string{"checkout", "payments"} {
		d, err := evaluate(stateBg, key, stateUser)
		if err != nil {
			out.err = err
		}
		out.decisions = append(out.decisions, d)
	}
	return out
}

func stateConsistent(ctx *harness.Ctx, p statePair, when string) {
	ctx.NoError(p.err, "a read %s failed", when)
	ctx.Assert(p.decisions[0] != nil && p.decisions[1] != nil, "a read %s found no flag: %+v", when, p.decisions)
	a, b := p.decisions[0], p.decisions[1]
	ctx.Assert(a.Version == b.Version, "a read %s evaluated checkout and payments against versions %d and %d: one request saw two rule sets", when, a.Version, b.Version)
	for _, d := range p.decisions {
		ctx.Assert(d.Value == (d.Version == 2), "a read %s answered %+v: version %d with the other version's rollout. The rule set was torn between two writes", when, *d, d.Version)
	}
}

func CheckOneSnapshot(ctx *harness.Ctx) {
	ctx.Equal(statePublish(ctx, stateSnap(1, 0, "checkout", "payments")), true, "the first snapshot must be applied; applied")
	// A request lands while version 2 is being written: it must see one whole rule set.
	var seen []statePair
	for _, key := range []string{"flags:rule:checkout", "flags:snapshot"} {
		ctx.Redis.After(key, func() any {
			seen = append(seen, stateRead())
			return nil
		})
	}
	ctx.Equal(statePublish(ctx, stateSnap(2, 100, "checkout", "payments")), true, "version 2 over version 1 must be applied; applied")
	for _, p := range seen {
		stateConsistent(ctx, p, "during the publish of version 2")
	}
	after := stateRead()
	stateConsistent(ctx, after, "after the publish")
	ctx.Equal(after.decisions[0].Version, int64(2), "after publishing version 2, the version evaluate answers")
	ctx.Equal(statePublish(ctx, stateSnap(3, 100, "checkout")), true, "version 3 must be applied; applied")
	stale := stateEval(ctx, "payments", stateUser)
	ctx.Assert(stale == nil, "payments is not in version 3, yet it still evaluates to %+v: per-flag keys outlive the snapshot that dropped them", stale)
	s, err := readSnapshot(stateBg)
	ctx.NoError(err, "readSnapshot failed")
	ctx.Assert(s != nil && s.Version == 3 && len(s.Flags) == 1, "readSnapshot gives %+v, expected version 3 with checkout only", s)
}

func CheckNewerOnly(ctx *harness.Ctx) {
	ctx.Equal(statePublish(ctx, stateSnap(2, 100, "checkout", "payments")), true, "the first snapshot must be applied; applied")
	late := statePublish(ctx, stateSnap(1, 0, "checkout", "payments"))
	ctx.Equal(late, false, "a publisher that was slow applied version 1 over version 2: the rollout went back. Only a newer version may replace the snapshot; applied")
	s, err := readSnapshot(stateBg)
	ctx.NoError(err, "readSnapshot failed")
	ctx.Assert(s != nil && s.Version == 2, "after the late version 1 the snapshot is %+v, expected version 2", s)
	d := stateEval(ctx, "checkout", stateUser)
	ctx.Assert(d != nil && d.Version == 2 && d.Value, "after the late version 1 evaluate answers %+v, expected version 2 in the rollout", d)
	ctx.Equal(statePublish(ctx, stateSnap(3, 0, "checkout", "payments")), true, "a newer version (3) must be applied; applied")
	ctx.Equal(stateEval(ctx, "checkout", stateUser).Version, int64(3), "after version 3, the version evaluate answers")
}

func CheckBucketPerFlag(ctx *harness.Ctx) {
	inCheckout, inPayments, overlap := 0, 0, 0
	for i := 0; i < 400; i++ {
		user := fmt.Sprintf("u-%d", i)
		a := bucket("checkout", user, "2026") < 50
		b := bucket("payments", user, "2026") < 50
		if a {
			inCheckout++
		}
		if b {
			inPayments++
		}
		if a && b {
			overlap++
		}
	}
	smaller := inCheckout
	if inPayments < smaller {
		smaller = inPayments
	}
	ctx.Assert(float64(overlap) < 0.8*float64(smaller), "at 50%% each, checkout and payments (same salt) share %d of their %d and %d users: the same people are in every rollout. Hash the flag key too", overlap, inCheckout, inPayments)
	for i := 0; i < 20; i++ {
		user := fmt.Sprintf("u-%d", i)
		b := bucket("checkout", user, "2026")
		ctx.Assert(b >= 0 && b < 100 && b == bucket("checkout", user, "2026"), "bucket(checkout, %s, 2026) answered %d: a bucket is a stable number in 0..99", user, b)
	}
	want := int(hashing.Fnv1a32("2026.checkout.u-7") % 100)
	ctx.Equal(bucket("checkout", "u-7", "2026"), want, "bucket(checkout, u-7, 2026) must be Fnv1a32(\\"2026.checkout.u-7\\") %% 100")
	statePublish(ctx, stateSnap(1, 50, "checkout", "payments"))
	for i := 0; i < 40; i++ {
		user := fmt.Sprintf("u-%d", i)
		d := stateEval(ctx, "checkout", map[string]string{"user_id": user})
		b := bucket("checkout", user, "2026")
		ctx.Assert(d != nil && d.Bucket == b && d.Value == (b < 50), "evaluate(checkout, %s) answered %+v, but the user's bucket is %d at a 50%% rollout", user, d, b)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "flags/hashing.h"

namespace {

const std::map<std::string, std::string> kStateUser = {{"user_id", "u-7"}, {"country", "US"}};

nlohmann::json stateSnap(long long version, int rollout, const std::vector<std::string>& keys) {
  nlohmann::json flags = nlohmann::json::object();
  for (const auto& k : keys) flags[k] = {{"default", false}, {"rules", nlohmann::json::array()}, {"rollout", rollout}, {"salt", "2026"}, {"killed", false}};
  return {{"version", version}, {"flags", flags}};
}

struct StatePair {
  std::vector<std::optional<nlohmann::json>> decisions;
  std::string error;
};

StatePair stateRead() {
  StatePair out;
  try {
    out.decisions.push_back(evaluate("checkout", kStateUser));
    out.decisions.push_back(evaluate("payments", kStateUser));
  } catch (const std::exception& e) {
    out.error = e.what();
  }
  return out;
}

void stateConsistent(harness::Ctx& ctx, const StatePair& p, const std::string& when) {
  ctx.Assert(p.error.empty(), "a read %s threw: %s", when, p.error);
  ctx.Assert(p.decisions.size() == 2 && p.decisions[0] && p.decisions[1], "a read %s found no flag", when);
  const long long a = p.decisions[0]->value("version", 0LL);
  const long long b = p.decisions[1]->value("version", 0LL);
  ctx.Assert(a == b, "a read %s evaluated checkout and payments against versions %d and %d: one request saw two rule sets", when, a, b);
  for (const auto& d : p.decisions) {
    ctx.Assert(d->value("value", false) == (d->value("version", 0LL) == 2), "a read %s answered %s: a version with the other version's rollout. The rule set was torn between two writes", when, d->dump());
  }
}

}  // namespace

void CheckOneSnapshot(harness::Ctx& ctx) {
  ctx.Equal(publishSnapshot(stateSnap(1, 0, {"checkout", "payments"})), true, "the first snapshot must be applied; applied");
  // A request lands while version 2 is being written: it must see one whole rule set.
  auto seen = std::make_shared<std::vector<StatePair>>();
  for (const std::string key : {"flags:rule:checkout", "flags:snapshot"}) ctx.Redis.After(key, [seen] { seen->push_back(stateRead()); });
  ctx.Equal(publishSnapshot(stateSnap(2, 100, {"checkout", "payments"})), true, "version 2 over version 1 must be applied; applied");
  for (const auto& p : *seen) stateConsistent(ctx, p, "during the publish of version 2");
  const StatePair after = stateRead();
  stateConsistent(ctx, after, "after the publish");
  ctx.Equal(after.decisions[0]->value("version", 0LL), 2LL, "after publishing version 2, the version evaluate answers");
  ctx.Equal(publishSnapshot(stateSnap(3, 100, {"checkout"})), true, "version 3 must be applied; applied");
  const auto stale = evaluate("payments", kStateUser);
  ctx.Assert(!stale, "payments is not in version 3, yet it still evaluates to %s: per-flag keys outlive the snapshot that dropped them", stale ? stale->dump() : "");
  const auto s = readSnapshot();
  ctx.Assert(s && *s == stateSnap(3, 100, {"checkout"}), "readSnapshot gives %s, expected version 3 exactly", s ? s->dump() : "nothing");
}

void CheckNewerOnly(harness::Ctx& ctx) {
  ctx.Equal(publishSnapshot(stateSnap(2, 100, {"checkout", "payments"})), true, "the first snapshot must be applied; applied");
  const bool late = publishSnapshot(stateSnap(1, 0, {"checkout", "payments"}));
  ctx.Equal(late, false, "a publisher that was slow applied version 1 over version 2: the rollout went back. Only a newer version may replace the snapshot; applied");
  const auto s = readSnapshot();
  ctx.Assert(s && *s == stateSnap(2, 100, {"checkout", "payments"}), "after the late version 1 the snapshot is %s, expected version 2", s ? s->dump() : "nothing");
  const auto d = evaluate("checkout", kStateUser);
  ctx.Assert(d && d->value("version", 0LL) == 2 && d->value("value", false), "after the late version 1 evaluate answers %s, expected version 2 in the rollout", d ? d->dump() : "nothing");
  ctx.Equal(publishSnapshot(stateSnap(3, 0, {"checkout", "payments"})), true, "a newer version (3) must be applied; applied");
  ctx.Equal(evaluate("checkout", kStateUser)->value("version", 0LL), 3LL, "after version 3, the version evaluate answers");
}

void CheckBucketPerFlag(harness::Ctx& ctx) {
  int in_checkout = 0, in_payments = 0, overlap = 0;
  for (int i = 0; i < 400; i++) {
    const std::string user = "u-" + std::to_string(i);
    const bool a = bucket("checkout", user, "2026") < 50;
    const bool b = bucket("payments", user, "2026") < 50;
    in_checkout += a;
    in_payments += b;
    overlap += a && b;
  }
  ctx.Assert(overlap < 0.8 * std::min(in_checkout, in_payments), "at 50%% each, checkout and payments (same salt) share %d of their %d and %d users: the same people are in every rollout. Hash the flag key too", overlap, in_checkout, in_payments);
  for (int i = 0; i < 20; i++) {
    const std::string user = "u-" + std::to_string(i);
    const int b = bucket("checkout", user, "2026");
    ctx.Assert(b >= 0 && b < 100 && b == bucket("checkout", user, "2026"), "bucket(checkout, %s, 2026) answered %d: a bucket is a stable number in 0..99", user, b);
  }
  const int want = static_cast<int>(hashing::fnv1a32("2026.checkout.u-7") % 100);
  ctx.Equal(bucket("checkout", "u-7", "2026"), want, "bucket(checkout, u-7, 2026) must be fnv1a32(\\"2026.checkout.u-7\\") %% 100");
  publishSnapshot(stateSnap(1, 50, {"checkout", "payments"}));
  for (int i = 0; i < 40; i++) {
    const std::string user = "u-" + std::to_string(i);
    const auto d = evaluate("checkout", {{"user_id", user}});
    const int b = bucket("checkout", user, "2026");
    ctx.Assert(d && d->value("bucket", -1) == b && d->value("value", false) == (b < 50), "evaluate(checkout, %s) answered %s, but the user's bucket is %d at a 50%% rollout", user, d ? d->dump() : "nothing", b);
  }
}
`,
  },
  hints: [
    "Publish a ten-flag change while a request evaluates two flags: one answers the new rollout, the other the old, both stamped with the old version. A slow publisher puts last week's rollout back.",
    'Each flag is its own SET, so a reader between two SETs sees half a version; nothing compares versions before writing; the hash input has no flag key, so equal salts give equal splits.',
    'SET the whole JSON under `flags:snapshot` in one Lua script that returns 0 unless `ARGV[2]` beats `tonumber(GET flags:snapshot:version)`; read with one GET; hash `"{salt}.{flag_key}.{user_id}"`.',
  ],
  debrief: `Redis is atomic per command, not across keys, so the cheapest way to make a reader see one rule set is to make the rule set one value: a single GET returns the old document or the new one, and a dropped flag disappears with the version that dropped it. The version guard lives in the same script as the write because a check followed by a SET leaves a gap another publisher can land in. Hashing the flag key gives each flag its own split, the property Unleash gets from its per-flag \`groupId\`. Production engines keep the snapshot in process memory, refresh it on a version change, and keep earlier versions so a bad rollout can be reverted by number.`,
};
