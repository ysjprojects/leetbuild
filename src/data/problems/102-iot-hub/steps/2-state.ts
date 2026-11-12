import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis shadow with desired and reported versions kept apart',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['hub', 'redis', 'device'],
  task: `## Task

**Starting point.** The starter is the shadow store the operator side and the device side share:
\`update_desired(device_id, patch)\` writes an operator's patch as the desired document
(\`shadow:{id}:desired\`) and bumps a \`version\` field in \`shadow:{id}\`;
\`apply_report(device_id, reported, version)\` reads that \`version\` and, when the device's version is
newer, writes \`shadow:{id}:reported\` and the new version; \`read_shadow(device_id)\` returns both
documents with that one version on both sides. It serves the demo and hides three flaws.

**Failure mode the checks target.** An operator who sets the setpoint loses the mode set an hour
earlier; after two operator updates the device's next report is refused as stale; and two hub
instances handling two reports of one device at once can leave the older report stored.

- \`update_desired\` merges the patch into the desired hash and returns \`desired_version\`, which
  counts operator updates only.
- \`reported_version\` in \`shadow:{id}\` is the version of the device's last kept report;
  \`read_shadow\` returns \`{desired, reported, desired_version, reported_version}\`.
- \`apply_report\` reads \`reported_version\`, compares and replaces the reported document in **one Lua
  script** (\`REPORT_LUA\`), keeping a report only when it is newer.`,
  sequence: {
    participants: ['Operator side', 'Redis', 'Device side'],
    messages: [
      {
        from: 'Operator side',
        to: 'Redis',
        label: 'HSET shadow:{id}:desired patch · HINCRBY desired_version',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Operator side', label: 'desired_version 3', kind: 'reply'},
      {from: 'Device side', to: 'Redis', label: 'EVAL REPORT_LUA · version 8', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HGET reported_version · 8 > 7 → DEL + HSET reported', kind: 'sync'},
      {from: 'Redis', to: 'Device side', label: '1 kept · 0 not newer', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'desired-merge',
      title: 'An operator patch merges into the desired document',
      detail:
        "`update_desired` writes the patch's fields into `shadow:{id}:desired` and leaves the others; the starter deletes the hash first, so every patch replaces the whole document.",
      match: {
        python: {all: [/def update_desired\(/, /\.hset\(\s*desired_key\(/], none: [/\.delete\(\s*desired_key\(/]},
        typescript: {all: [/function updateDesired\(/, /\.hset\(\s*desiredKey\(/], none: [/\.del\(\s*desiredKey\(/]},
        go: {all: [/func updateDesired\(/, /\.HSet\([^\n]*desiredKey\(/], none: [/\.Del\([^\n]*desiredKey\(/]},
        scala: {all: [/def updateDesired\(/, /\.hset\(\s*desiredKey\(/], none: [/\.del\(\s*desiredKey\(/]},
        cpp: {all: [/updateDesired\(/, /\.hset\(\s*desiredKey\(/], none: [/\.del\(\s*desiredKey\(/]},
      },
    },
    {
      id: 'own-versions',
      title: 'Desired and reported keep their own versions',
      detail:
        "`desired_version` counts operator updates and `reported_version` is the device's own report version, two fields of `shadow:{id}`; the starter shares one `version`, so operator updates make the device's next report look stale.",
      match: {
        python: {all: [/["']desired_version["']/, /["']reported_version["']/], none: [/["']version["']/]},
        typescript: {all: [/["']desired_version["']/, /["']reported_version["']/], none: [/["']version["']/]},
        go: {all: [/["']desired_version["']/, /["']reported_version["']/], none: [/["']version["']/]},
        scala: {all: [/["']desired_version["']/, /["']reported_version["']/], none: [/["']version["']/]},
        cpp: {all: [/["']desired_version["']/, /["']reported_version["']/], none: [/["']version["']/]},
      },
    },
    {
      id: 'report-atomic',
      title: 'A report is compared and written in one script',
      detail:
        'The read of `reported_version`, the comparison and the write of the reported document run in one Lua script, so a newer report landing between them cannot be overwritten; the starter reads with `HGET` from the app and writes afterwards.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/def apply_report(?:(?!\ndef )[\s\S])*?\.hget\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/function applyReport(?:(?!\nexport )[\s\S])*?\.hget\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/func applyReport(?:(?!\n\})[\s\S])*?\.HGet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/def applyReport(?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?\.hget\(/],
        },
        cpp: {
          all: [/\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/bool applyReport(?:(?!\n\})[\s\S])*?\.hget\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def shadow_key(device_id: str) -> str:
    return f"shadow:{device_id}"


def desired_key(device_id: str) -> str:
    return f"shadow:{device_id}:desired"


def reported_key(device_id: str) -> str:
    return f"shadow:{device_id}:reported"


def update_desired(device_id: str, patch: dict[str, str]) -> int:
    """Apply an operator's patch to the desired document; the new desired version."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    r.delete(desired_key(device_id))
    r.hset(desired_key(device_id), mapping=patch)
    return r.hincrby(shadow_key(device_id), "version", 1)


def apply_report(device_id: str, reported: dict[str, str], version: int) -> bool:
    """The device's whole reported state at version; ignored unless newer than the stored report."""
    stored = int(r.hget(shadow_key(device_id), "version") or 0)
    if version <= stored:
        return False
    r.delete(reported_key(device_id))
    r.hset(reported_key(device_id), mapping=reported)
    r.hset(shadow_key(device_id), "version", version)
    return True


def read_shadow(device_id: str) -> dict:
    """{desired, reported, desired_version, reported_version}."""
    version = int(r.hget(shadow_key(device_id), "version") or 0)
    return {
        "desired": r.hgetall(desired_key(device_id)),
        "reported": r.hgetall(reported_key(device_id)),
        "desired_version": version,
        "reported_version": version,
    }
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] shadow:{id}, KEYS[2] shadow:{id}:reported; ARGV[1] the report's version, then field, value pairs.
REPORT_LUA = """
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
if tonumber(ARGV[1]) <= stored then return 0 end
redis.call('DEL', KEYS[2])
for i = 2, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
return 1
"""
report_script = r.register_script(REPORT_LUA)


def shadow_key(device_id: str) -> str:
    return f"shadow:{device_id}"


def desired_key(device_id: str) -> str:
    return f"shadow:{device_id}:desired"


def reported_key(device_id: str) -> str:
    return f"shadow:{device_id}:reported"


def update_desired(device_id: str, patch: dict[str, str]) -> int:
    """Apply an operator's patch to the desired document; the new desired version."""
    # A patch names the fields that change; the rest of the operator's document stays.
    r.hset(desired_key(device_id), mapping=patch)
    return r.hincrby(shadow_key(device_id), "desired_version", 1)


def apply_report(device_id: str, reported: dict[str, str], version: int) -> bool:
    """The device's whole reported state at version; ignored unless newer than the stored report."""
    args = [version]
    for field, value in reported.items():
        args += [field, value]
    # Read, compare and write in one script: no other report can land in between.
    return report_script(keys=[shadow_key(device_id), reported_key(device_id)], args=args) == 1


def read_shadow(device_id: str) -> dict:
    """{desired, reported, desired_version, reported_version}."""
    versions = r.hgetall(shadow_key(device_id))
    return {
        "desired": r.hgetall(desired_key(device_id)),
        "reported": r.hgetall(reported_key(device_id)),
        "desired_version": int(versions.get("desired_version", 0)),
        "reported_version": int(versions.get("reported_version", 0)),
    }
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface DeviceShadow {
  desired: Record<string, string>;
  reported: Record<string, string>;
  desired_version: number;
  reported_version: number;
}

export const shadowKey = (deviceId: string): string => \`shadow:\${deviceId}\`;
export const desiredKey = (deviceId: string): string => \`shadow:\${deviceId}:desired\`;
export const reportedKey = (deviceId: string): string => \`shadow:\${deviceId}:reported\`;

/** Apply an operator's patch to the desired document; the new desired version. */
export async function updateDesired(deviceId: string, patch: Record<string, string>): Promise<number> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  await redis.del(desiredKey(deviceId));
  await redis.hset(desiredKey(deviceId), patch);
  return redis.hincrby(shadowKey(deviceId), 'version', 1);
}

/** The device's whole reported state at version; ignored unless newer than the stored report. */
export async function applyReport(deviceId: string, reported: Record<string, string>, version: number): Promise<boolean> {
  const stored = Number((await redis.hget(shadowKey(deviceId), 'version')) ?? 0);
  if (version <= stored) return false;
  await redis.del(reportedKey(deviceId));
  await redis.hset(reportedKey(deviceId), reported);
  await redis.hset(shadowKey(deviceId), 'version', String(version));
  return true;
}

/** Both documents and both versions. */
export async function readShadow(deviceId: string): Promise<DeviceShadow> {
  const version = Number((await redis.hget(shadowKey(deviceId), 'version')) ?? 0);
  return {
    desired: await redis.hgetall(desiredKey(deviceId)),
    reported: await redis.hgetall(reportedKey(deviceId)),
    desired_version: version,
    reported_version: version,
  };
}
`,
      solution: `import Redis from 'ioredis';

/** KEYS[1] shadow:{id}, KEYS[2] shadow:{id}:reported; ARGV[1] the report's version, then field, value pairs. */
export const REPORT_LUA = \`
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
if tonumber(ARGV[1]) <= stored then return 0 end
redis.call('DEL', KEYS[2])
for i = 2, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
return 1
\`;

interface ShadowRedis extends Redis {
  reportShadow(shadowKey: string, reportedKey: string, ...args: string[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ShadowRedis;
redis.defineCommand('reportShadow', {numberOfKeys: 2, lua: REPORT_LUA});

export interface DeviceShadow {
  desired: Record<string, string>;
  reported: Record<string, string>;
  desired_version: number;
  reported_version: number;
}

export const shadowKey = (deviceId: string): string => \`shadow:\${deviceId}\`;
export const desiredKey = (deviceId: string): string => \`shadow:\${deviceId}:desired\`;
export const reportedKey = (deviceId: string): string => \`shadow:\${deviceId}:reported\`;

/** Apply an operator's patch to the desired document; the new desired version. */
export async function updateDesired(deviceId: string, patch: Record<string, string>): Promise<number> {
  // A patch names the fields that change; the rest of the operator's document stays.
  await redis.hset(desiredKey(deviceId), patch);
  return redis.hincrby(shadowKey(deviceId), 'desired_version', 1);
}

/** The device's whole reported state at version; ignored unless newer than the stored report. */
export async function applyReport(deviceId: string, reported: Record<string, string>, version: number): Promise<boolean> {
  // Read, compare and write in one script: no other report can land in between.
  const args = [String(version), ...Object.entries(reported).flat()];
  return (await redis.reportShadow(shadowKey(deviceId), reportedKey(deviceId), ...args)) === 1;
}

/** Both documents and both versions. */
export async function readShadow(deviceId: string): Promise<DeviceShadow> {
  const versions = await redis.hgetall(shadowKey(deviceId));
  return {
    desired: await redis.hgetall(desiredKey(deviceId)),
    reported: await redis.hgetall(reportedKey(deviceId)),
    desired_version: Number(versions.desired_version ?? 0),
    reported_version: Number(versions.reported_version ?? 0),
  };
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

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Shadow is both documents and both versions of one device.
type Shadow struct {
	Desired         map[string]string \`json:"desired"\`
	Reported        map[string]string \`json:"reported"\`
	DesiredVersion  int64             \`json:"desired_version"\`
	ReportedVersion int64             \`json:"reported_version"\`
}

func shadowKey(deviceID string) string   { return "shadow:" + deviceID }
func desiredKey(deviceID string) string  { return "shadow:" + deviceID + ":desired" }
func reportedKey(deviceID string) string { return "shadow:" + deviceID + ":reported" }

// updateDesired applies an operator's patch to the desired document and returns the new desired version.
func updateDesired(ctx context.Context, deviceID string, patch map[string]string) (int64, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	rdb.Del(ctx, desiredKey(deviceID))
	if err := rdb.HSet(ctx, desiredKey(deviceID), patch).Err(); err != nil {
		return 0, err
	}
	return rdb.HIncrBy(ctx, shadowKey(deviceID), "version", 1).Result()
}

// applyReport takes the device's whole reported state at version; it is ignored unless newer than
// the stored report.
func applyReport(ctx context.Context, deviceID string, reported map[string]string, version int64) (bool, error) {
	stored, _ := strconv.ParseInt(rdb.HGet(ctx, shadowKey(deviceID), "version").Val(), 10, 64)
	if version <= stored {
		return false, nil
	}
	rdb.Del(ctx, reportedKey(deviceID))
	if err := rdb.HSet(ctx, reportedKey(deviceID), reported).Err(); err != nil {
		return false, err
	}
	return true, rdb.HSet(ctx, shadowKey(deviceID), "version", version).Err()
}

// readShadow is both documents and both versions.
func readShadow(ctx context.Context, deviceID string) (*Shadow, error) {
	version, _ := strconv.ParseInt(rdb.HGet(ctx, shadowKey(deviceID), "version").Val(), 10, 64)
	return &Shadow{
		Desired:         rdb.HGetAll(ctx, desiredKey(deviceID)).Val(),
		Reported:        rdb.HGetAll(ctx, reportedKey(deviceID)).Val(),
		DesiredVersion:  version,
		ReportedVersion: version,
	}, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reportScript: KEYS[1] shadow:{id}, KEYS[2] shadow:{id}:reported; ARGV[1] the report's version,
// then field, value pairs.
var reportScript = redis.NewScript(\`
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
if tonumber(ARGV[1]) <= stored then return 0 end
redis.call('DEL', KEYS[2])
for i = 2, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
return 1
\`)

// Shadow is both documents and both versions of one device.
type Shadow struct {
	Desired         map[string]string \`json:"desired"\`
	Reported        map[string]string \`json:"reported"\`
	DesiredVersion  int64             \`json:"desired_version"\`
	ReportedVersion int64             \`json:"reported_version"\`
}

func shadowKey(deviceID string) string   { return "shadow:" + deviceID }
func desiredKey(deviceID string) string  { return "shadow:" + deviceID + ":desired" }
func reportedKey(deviceID string) string { return "shadow:" + deviceID + ":reported" }

// updateDesired applies an operator's patch to the desired document and returns the new desired version.
func updateDesired(ctx context.Context, deviceID string, patch map[string]string) (int64, error) {
	// A patch names the fields that change; the rest of the operator's document stays.
	if err := rdb.HSet(ctx, desiredKey(deviceID), patch).Err(); err != nil {
		return 0, err
	}
	return rdb.HIncrBy(ctx, shadowKey(deviceID), "desired_version", 1).Result()
}

// applyReport takes the device's whole reported state at version; it is ignored unless newer than
// the stored report.
func applyReport(ctx context.Context, deviceID string, reported map[string]string, version int64) (bool, error) {
	args := []any{version}
	for field, value := range reported {
		args = append(args, field, value)
	}
	// Read, compare and write in one script: no other report can land in between.
	kept, err := reportScript.Run(ctx, rdb, []string{shadowKey(deviceID), reportedKey(deviceID)}, args...).Int64()
	return kept == 1, err
}

// readShadow is both documents and both versions.
func readShadow(ctx context.Context, deviceID string) (*Shadow, error) {
	versions, err := rdb.HGetAll(ctx, shadowKey(deviceID)).Result()
	if err != nil {
		return nil, err
	}
	s := &Shadow{Desired: rdb.HGetAll(ctx, desiredKey(deviceID)).Val(), Reported: rdb.HGetAll(ctx, reportedKey(deviceID)).Val()}
	s.DesiredVersion, _ = strconv.ParseInt(versions["desired_version"], 10, 64)
	s.ReportedVersion, _ = strconv.ParseInt(versions["reported_version"], 10, 64)
	return s, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object ShadowState {
  /** Both documents and both versions of one device. */
  final case class ShadowView(desired: Map[String, String], reported: Map[String, String], desiredVersion: Long, reportedVersion: Long)

  val jedis = new JedisPooled("redis", 6379)

  def shadowKey(deviceId: String): String = s"shadow:$deviceId"
  def desiredKey(deviceId: String): String = s"shadow:$deviceId:desired"
  def reportedKey(deviceId: String): String = s"shadow:$deviceId:reported"

  /** Apply an operator's patch to the desired document; the new desired version. */
  def updateDesired(deviceId: String, patch: Map[String, String]): Long = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    jedis.del(desiredKey(deviceId))
    jedis.hset(desiredKey(deviceId), patch.asJava)
    jedis.hincrBy(shadowKey(deviceId), "version", 1L)
  }

  /** The device's whole reported state at version; ignored unless newer than the stored report. */
  def applyReport(deviceId: String, reported: Map[String, String], version: Long): Boolean = {
    val stored = Option(jedis.hget(shadowKey(deviceId), "version")).map(_.toLong).getOrElse(0L)
    if (version <= stored) false
    else {
      jedis.del(reportedKey(deviceId))
      jedis.hset(reportedKey(deviceId), reported.asJava)
      jedis.hset(shadowKey(deviceId), "version", version.toString)
      true
    }
  }

  /** Both documents and both versions. */
  def readShadow(deviceId: String): ShadowView = {
    val version = Option(jedis.hget(shadowKey(deviceId), "version")).map(_.toLong).getOrElse(0L)
    ShadowView(jedis.hgetAll(desiredKey(deviceId)).asScala.toMap, jedis.hgetAll(reportedKey(deviceId)).asScala.toMap, version, version)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object ShadowState {
  /** Both documents and both versions of one device. */
  final case class ShadowView(desired: Map[String, String], reported: Map[String, String], desiredVersion: Long, reportedVersion: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] shadow:{id}, KEYS[2] shadow:{id}:reported; ARGV[1] the report's version, then field, value pairs. */
  val ReportLua: String =
    """local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
      |if tonumber(ARGV[1]) <= stored then return 0 end
      |redis.call('DEL', KEYS[2])
      |for i = 2, #ARGV, 2 do
      |  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
      |end
      |redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
      |return 1
      |""".stripMargin

  def shadowKey(deviceId: String): String = s"shadow:$deviceId"
  def desiredKey(deviceId: String): String = s"shadow:$deviceId:desired"
  def reportedKey(deviceId: String): String = s"shadow:$deviceId:reported"

  /** Apply an operator's patch to the desired document; the new desired version. */
  def updateDesired(deviceId: String, patch: Map[String, String]): Long = {
    // A patch names the fields that change; the rest of the operator's document stays.
    jedis.hset(desiredKey(deviceId), patch.asJava)
    jedis.hincrBy(shadowKey(deviceId), "desired_version", 1L)
  }

  /** The device's whole reported state at version; ignored unless newer than the stored report. */
  def applyReport(deviceId: String, reported: Map[String, String], version: Long): Boolean = {
    // Read, compare and write in one script: no other report can land in between.
    val args = version.toString :: reported.toList.flatMap { case (field, value) => List(field, value) }
    jedis.eval(ReportLua, List(shadowKey(deviceId), reportedKey(deviceId)).asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Both documents and both versions. */
  def readShadow(deviceId: String): ShadowView = {
    val versions = jedis.hgetAll(shadowKey(deviceId)).asScala
    ShadowView(
      jedis.hgetAll(desiredKey(deviceId)).asScala.toMap,
      jedis.hgetAll(reportedKey(deviceId)).asScala.toMap,
      versions.get("desired_version").map(_.toLong).getOrElse(0L),
      versions.get("reported_version").map(_.toLong).getOrElse(0L))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <unordered_map>

sw::redis::Redis redis("tcp://redis:6379");

// Both documents and both versions of one device.
struct DeviceShadow {
  std::map<std::string, std::string> desired;
  std::map<std::string, std::string> reported;
  long long desired_version = 0;
  long long reported_version = 0;
};

std::string shadowKey(const std::string& device_id) { return "shadow:" + device_id; }
std::string desiredKey(const std::string& device_id) { return "shadow:" + device_id + ":desired"; }
std::string reportedKey(const std::string& device_id) { return "shadow:" + device_id + ":reported"; }

std::map<std::string, std::string> hashAt(const std::string& key) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall(key);
  return std::map<std::string, std::string>(raw.begin(), raw.end());
}

// Apply an operator's patch to the desired document; the new desired version.
long long updateDesired(const std::string& device_id, const std::map<std::string, std::string>& patch) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  redis.del(desiredKey(device_id));
  redis.hset(desiredKey(device_id), patch.begin(), patch.end());
  return redis.hincrby(shadowKey(device_id), "version", 1);
}

// The device's whole reported state at version; ignored unless newer than the stored report.
bool applyReport(const std::string& device_id, const std::map<std::string, std::string>& reported, long long version) {
  const auto stored = redis.hget(shadowKey(device_id), "version");
  if (stored && version <= std::stoll(*stored)) return false;
  redis.del(reportedKey(device_id));
  redis.hset(reportedKey(device_id), reported.begin(), reported.end());
  redis.hset(shadowKey(device_id), "version", std::to_string(version));
  return true;
}

// Both documents and both versions.
DeviceShadow readShadow(const std::string& device_id) {
  const auto version = redis.hget(shadowKey(device_id), "version");
  DeviceShadow s;
  s.desired = hashAt(desiredKey(device_id));
  s.reported = hashAt(reportedKey(device_id));
  s.desired_version = s.reported_version = version ? std::stoll(*version) : 0;
  return s;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] shadow:{id}, KEYS[2] shadow:{id}:reported; ARGV[1] the report's version, then field, value pairs.
const std::string kReportLua = R"lua(
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
if tonumber(ARGV[1]) <= stored then return 0 end
redis.call('DEL', KEYS[2])
for i = 2, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
return 1
)lua";

// Both documents and both versions of one device.
struct DeviceShadow {
  std::map<std::string, std::string> desired;
  std::map<std::string, std::string> reported;
  long long desired_version = 0;
  long long reported_version = 0;
};

std::string shadowKey(const std::string& device_id) { return "shadow:" + device_id; }
std::string desiredKey(const std::string& device_id) { return "shadow:" + device_id + ":desired"; }
std::string reportedKey(const std::string& device_id) { return "shadow:" + device_id + ":reported"; }

std::map<std::string, std::string> hashAt(const std::string& key) {
  const std::unordered_map<std::string, std::string> raw = redis.hgetall(key);
  return std::map<std::string, std::string>(raw.begin(), raw.end());
}

// Apply an operator's patch to the desired document; the new desired version.
long long updateDesired(const std::string& device_id, const std::map<std::string, std::string>& patch) {
  // A patch names the fields that change; the rest of the operator's document stays.
  redis.hset(desiredKey(device_id), patch.begin(), patch.end());
  return redis.hincrby(shadowKey(device_id), "desired_version", 1);
}

// The device's whole reported state at version; ignored unless newer than the stored report.
bool applyReport(const std::string& device_id, const std::map<std::string, std::string>& reported, long long version) {
  std::vector<std::string> args = {std::to_string(version)};
  for (const auto& [field, value] : reported) {
    args.push_back(field);
    args.push_back(value);
  }
  // Read, compare and write in one script: no other report can land in between.
  return redis.eval<long long>(kReportLua, {shadowKey(device_id), reportedKey(device_id)}, args) == 1;
}

// Both documents and both versions.
DeviceShadow readShadow(const std::string& device_id) {
  const std::map<std::string, std::string> versions = hashAt(shadowKey(device_id));
  DeviceShadow s;
  s.desired = hashAt(desiredKey(device_id));
  s.reported = hashAt(reportedKey(device_id));
  s.desired_version = versions.count("desired_version") ? std::stoll(versions.at("desired_version")) : 0;
  s.reported_version = versions.count("reported_version") ? std::stoll(versions.at("reported_version")) : 0;
  return s;
}
`,
    },
  },
  harness: {
    python: `THERMO = "thermo-3"


def check_desired_merge(ctx):
    m = ctx.load("state")
    m.update_desired(THERMO, {"mode": "eco"})
    m.update_desired(THERMO, {"setpoint": "21"})
    desired = ctx.redis.hgetall(f"shadow:{THERMO}:desired")
    assert desired == {"mode": "eco", "setpoint": "21"}, f"after the patches mode=eco and setpoint=21 the desired document is {desired}: a patch merges into the document, it does not replace it"
    m.update_desired(THERMO, {"mode": "comfort"})
    desired = ctx.redis.hgetall(f"shadow:{THERMO}:desired")
    assert desired == {"mode": "comfort", "setpoint": "21"}, f"after a third patch mode=comfort the desired document is {desired}, expected mode comfort and setpoint 21"
    assert m.read_shadow(THERMO)["desired"] == desired, f"read_shadow answered desired {m.read_shadow(THERMO)['desired']}, the store holds {desired}"


def check_own_versions(ctx):
    m = ctx.load("state")
    assert m.apply_report(THERMO, {"mode": "normal"}, 10) is True, "the device's first report (version 10) must be kept"
    first = m.update_desired(THERMO, {"mode": "eco"})
    second = m.update_desired(THERMO, {"setpoint": "21"})
    assert (first, second) == (1, 2), f"two operator updates answered desired versions {first} and {second}, expected 1 and 2: the desired document counts its own updates, not the device's reports"
    assert m.apply_report(THERMO, {"mode": "eco", "setpoint": "21"}, 11) is True, "the device's report 11, newer than its report 10, was refused: operator updates must not move the version the device's reports are compared with"
    versions = ctx.redis.hgetall(f"shadow:{THERMO}")
    assert versions.get("desired_version") == "2" and versions.get("reported_version") == "11", f"shadow:{THERMO} holds {versions}, expected desired_version 2 and reported_version 11"
    shadow = m.read_shadow(THERMO)
    assert (shadow["desired_version"], shadow["reported_version"]) == (2, 11), f"read_shadow answered desired_version {shadow['desired_version']} and reported_version {shadow['reported_version']}, expected 2 and 11"


def check_report_atomic(ctx):
    m = ctx.load("state")
    assert m.apply_report(THERMO, {"mode": "v7"}, 7) is True, "the device's first report (version 7) must be kept"
    assert m.apply_report(THERMO, {"mode": "v6"}, 6) is False, "a report of version 6 after version 7 must be refused"
    assert ctx.redis.hgetall(f"shadow:{THERMO}:reported") == {"mode": "v7"}, f"a refused report changed the reported document to {ctx.redis.hgetall(f'shadow:{THERMO}:reported')}"

    def report_9_lands():
        # The device's next report, handled by another hub instance in the middle of this one.
        ctx.redis.delete(f"shadow:{THERMO}:reported")
        ctx.redis.hset(f"shadow:{THERMO}:reported", mapping={"mode": "v9"})
        ctx.redis.hset(f"shadow:{THERMO}", "reported_version", 9)

    probe = ctx.redis_after(f"shadow:{THERMO}", report_9_lands)
    m.apply_report(THERMO, {"mode": "v8"}, 8)
    assert probe.fired, f"apply_report never touched shadow:{THERMO}"
    reported = ctx.redis.hgetall(f"shadow:{THERMO}:reported")
    version = ctx.redis.hget(f"shadow:{THERMO}", "reported_version")
    assert reported == {"mode": "v9"} and version == "9", f"report 9 landed on another instance while report 8 was being applied, and the shadow now holds {reported} at reported_version {version}: the read, the comparison and the write must be one script, or an older report overwrites a newer one"
`,
    typescript: `const THERMO = 'thermo-3';

export async function check_desired_merge(ctx) {
  const m = ctx.load('state');
  await m.updateDesired(THERMO, {mode: 'eco'});
  await m.updateDesired(THERMO, {setpoint: '21'});
  let desired = ctx.redis.hgetall(\`shadow:\${THERMO}:desired\`);
  assert.deepEqual(desired, {mode: 'eco', setpoint: '21'}, \`after the patches mode=eco and setpoint=21 the desired document is \${JSON.stringify(desired)}: a patch merges into the document, it does not replace it\`);
  await m.updateDesired(THERMO, {mode: 'comfort'});
  desired = ctx.redis.hgetall(\`shadow:\${THERMO}:desired\`);
  assert.deepEqual(desired, {mode: 'comfort', setpoint: '21'}, \`after a third patch mode=comfort the desired document is \${JSON.stringify(desired)}, expected mode comfort and setpoint 21\`);
  assert.deepEqual((await m.readShadow(THERMO)).desired, desired, 'readShadow must answer the stored desired document');
}

export async function check_own_versions(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.applyReport(THERMO, {mode: 'normal'}, 10), true, "the device's first report (version 10) must be kept");
  const first = await m.updateDesired(THERMO, {mode: 'eco'});
  const second = await m.updateDesired(THERMO, {setpoint: '21'});
  assert(first === 1 && second === 2, \`two operator updates answered desired versions \${first} and \${second}, expected 1 and 2: the desired document counts its own updates, not the device's reports\`);
  assert.equal(await m.applyReport(THERMO, {mode: 'eco', setpoint: '21'}, 11), true, "the device's report 11, newer than its report 10, was refused: operator updates must not move the version the device's reports are compared with");
  const versions = ctx.redis.hgetall(\`shadow:\${THERMO}\`);
  assert(versions.desired_version === '2' && versions.reported_version === '11', \`shadow:\${THERMO} holds \${JSON.stringify(versions)}, expected desired_version 2 and reported_version 11\`);
  const shadow = await m.readShadow(THERMO);
  assert(shadow.desired_version === 2 && shadow.reported_version === 11, \`readShadow answered desired_version \${shadow.desired_version} and reported_version \${shadow.reported_version}, expected 2 and 11\`);
}

export async function check_report_atomic(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.applyReport(THERMO, {mode: 'v7'}, 7), true, "the device's first report (version 7) must be kept");
  assert.equal(await m.applyReport(THERMO, {mode: 'v6'}, 6), false, 'a report of version 6 after version 7 must be refused');
  assert.deepEqual(ctx.redis.hgetall(\`shadow:\${THERMO}:reported\`), {mode: 'v7'}, 'a refused report must leave the reported document alone');
  // The device's next report, handled by another hub instance in the middle of this one.
  const probe = ctx.redisAfter(\`shadow:\${THERMO}\`, () => {
    ctx.redis.del(\`shadow:\${THERMO}:reported\`);
    ctx.redis.hset(\`shadow:\${THERMO}:reported\`, {mode: 'v9'});
    ctx.redis.hset(\`shadow:\${THERMO}\`, 'reported_version', '9');
  });
  await m.applyReport(THERMO, {mode: 'v8'}, 8);
  assert(probe.fired, \`applyReport never touched shadow:\${THERMO}\`);
  const reported = ctx.redis.hgetall(\`shadow:\${THERMO}:reported\`);
  const version = ctx.redis.hget(\`shadow:\${THERMO}\`, 'reported_version');
  assert(reported.mode === 'v9' && Object.keys(reported).length === 1 && version === '9', \`report 9 landed on another instance while report 8 was being applied, and the shadow now holds \${JSON.stringify(reported)} at reported_version \${version}: the read, the comparison and the write must be one script, or an older report overwrites a newer one\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const thermo = "thermo-3"

var stateBg = context.Background()

func CheckDesiredMerge(ctx *harness.Ctx) {
	_, err := updateDesired(stateBg, thermo, map[string]string{"mode": "eco"})
	ctx.NoError(err, "updateDesired")
	updateDesired(stateBg, thermo, map[string]string{"setpoint": "21"})
	ctx.Equal(ctx.Redis.HGetAll("shadow:"+thermo+":desired"), map[string]string{"mode": "eco", "setpoint": "21"}, "after the patches mode=eco and setpoint=21 the desired document (a patch merges into the document, it does not replace it)")
	updateDesired(stateBg, thermo, map[string]string{"mode": "comfort"})
	desired := ctx.Redis.HGetAll("shadow:" + thermo + ":desired")
	ctx.Equal(desired, map[string]string{"mode": "comfort", "setpoint": "21"}, "after a third patch mode=comfort the desired document")
	shadow, err := readShadow(stateBg, thermo)
	ctx.NoError(err, "readShadow")
	ctx.Equal(shadow.Desired, desired, "readShadow must answer the stored desired document")
}

func CheckOwnVersions(ctx *harness.Ctx) {
	kept, err := applyReport(stateBg, thermo, map[string]string{"mode": "normal"}, 10)
	ctx.NoError(err, "applyReport")
	ctx.Equal(kept, true, "the device's first report (version 10) must be kept")
	first, _ := updateDesired(stateBg, thermo, map[string]string{"mode": "eco"})
	second, _ := updateDesired(stateBg, thermo, map[string]string{"setpoint": "21"})
	ctx.Assert(first == 1 && second == 2, "two operator updates answered desired versions %d and %d, expected 1 and 2: the desired document counts its own updates, not the device's reports", first, second)
	kept, _ = applyReport(stateBg, thermo, map[string]string{"mode": "eco", "setpoint": "21"}, 11)
	ctx.Equal(kept, true, "the device's report 11, newer than its report 10, must be kept (operator updates must not move the version the device's reports are compared with)")
	versions := ctx.Redis.HGetAll("shadow:" + thermo)
	ctx.Assert(versions["desired_version"] == "2" && versions["reported_version"] == "11", "shadow:%s holds %v, expected desired_version 2 and reported_version 11", thermo, versions)
	shadow, err := readShadow(stateBg, thermo)
	ctx.NoError(err, "readShadow")
	ctx.Assert(shadow.DesiredVersion == 2 && shadow.ReportedVersion == 11, "readShadow answered desired_version %d and reported_version %d, expected 2 and 11", shadow.DesiredVersion, shadow.ReportedVersion)
}

func CheckReportAtomic(ctx *harness.Ctx) {
	kept, err := applyReport(stateBg, thermo, map[string]string{"mode": "v7"}, 7)
	ctx.NoError(err, "applyReport")
	ctx.Equal(kept, true, "the device's first report (version 7) must be kept")
	kept, _ = applyReport(stateBg, thermo, map[string]string{"mode": "v6"}, 6)
	ctx.Equal(kept, false, "a report of version 6 after version 7 must be refused")
	ctx.Equal(ctx.Redis.HGetAll("shadow:"+thermo+":reported"), map[string]string{"mode": "v7"}, "a refused report must leave the reported document alone")
	// The device's next report, handled by another hub instance in the middle of this one.
	probe := ctx.Redis.After("shadow:"+thermo, func() any {
		ctx.Redis.Del("shadow:" + thermo + ":reported")
		ctx.Redis.Do("HSET", "shadow:"+thermo+":reported", "mode", "v9")
		ctx.Redis.Do("HSET", "shadow:"+thermo, "reported_version", "9")
		return nil
	})
	applyReport(stateBg, thermo, map[string]string{"mode": "v8"}, 8)
	ctx.Assert(probe.Fired, "applyReport never touched shadow:%s", thermo)
	reported := ctx.Redis.HGetAll("shadow:" + thermo + ":reported")
	version, _ := ctx.Redis.HGet("shadow:"+thermo, "reported_version")
	ctx.Assert(len(reported) == 1 && reported["mode"] == "v9" && version == "9", "report 9 landed on another instance while report 8 was being applied, and the shadow now holds %v at reported_version %s: the read, the comparison and the write must be one script, or an older report overwrites a newer one", reported, version)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>

namespace {

const std::string kThermo = "thermo-3";

using Doc = std::map<std::string, std::string>;

}  // namespace

void CheckDesiredMerge(harness::Ctx& ctx) {
  updateDesired(kThermo, {{"mode", "eco"}});
  updateDesired(kThermo, {{"setpoint", "21"}});
  ctx.Equal(ctx.Redis.HGetAll("shadow:" + kThermo + ":desired"), Doc{{"mode", "eco"}, {"setpoint", "21"}},
            "after the patches mode=eco and setpoint=21 the desired document (a patch merges into the document, it does not replace it)");
  updateDesired(kThermo, {{"mode", "comfort"}});
  const auto desired = ctx.Redis.HGetAll("shadow:" + kThermo + ":desired");
  ctx.Equal(desired, Doc{{"mode", "comfort"}, {"setpoint", "21"}}, "after a third patch mode=comfort the desired document");
  ctx.Equal(readShadow(kThermo).desired, desired, "readShadow must answer the stored desired document");
}

void CheckOwnVersions(harness::Ctx& ctx) {
  ctx.Equal(applyReport(kThermo, {{"mode", "normal"}}, 10), true, "the device's first report (version 10) must be kept");
  const long long first = updateDesired(kThermo, {{"mode", "eco"}});
  const long long second = updateDesired(kThermo, {{"setpoint", "21"}});
  ctx.Assert(first == 1 && second == 2,
             "two operator updates answered desired versions %d and %d, expected 1 and 2: the desired document counts its own updates, not the device's reports", first, second);
  ctx.Equal(applyReport(kThermo, {{"mode", "eco"}, {"setpoint", "21"}}, 11), true,
            "the device's report 11, newer than its report 10, must be kept (operator updates must not move the version the device's reports are compared with)");
  auto versions = ctx.Redis.HGetAll("shadow:" + kThermo);
  ctx.Assert(versions["desired_version"] == "2" && versions["reported_version"] == "11", "shadow:%s holds desired_version %q and reported_version %q, expected 2 and 11",
             kThermo, versions["desired_version"], versions["reported_version"]);
  const auto shadow = readShadow(kThermo);
  ctx.Assert(shadow.desired_version == 2 && shadow.reported_version == 11, "readShadow answered desired_version %d and reported_version %d, expected 2 and 11",
             shadow.desired_version, shadow.reported_version);
}

void CheckReportAtomic(harness::Ctx& ctx) {
  ctx.Equal(applyReport(kThermo, {{"mode", "v7"}}, 7), true, "the device's first report (version 7) must be kept");
  ctx.Equal(applyReport(kThermo, {{"mode", "v6"}}, 6), false, "a report of version 6 after version 7 must be refused");
  ctx.Equal(ctx.Redis.HGetAll("shadow:" + kThermo + ":reported"), Doc{{"mode", "v7"}}, "a refused report must leave the reported document alone");
  // The device's next report, handled by another hub instance in the middle of this one.
  bool fired = false;
  ctx.Redis.After("shadow:" + kThermo, [&ctx, &fired] {
    fired = true;
    ctx.Redis.Del("shadow:" + kThermo + ":reported");
    ctx.Redis.Do("HSET", "shadow:" + kThermo + ":reported", "mode", "v9");
    ctx.Redis.Do("HSET", "shadow:" + kThermo, "reported_version", "9");
  });
  applyReport(kThermo, {{"mode", "v8"}}, 8);
  ctx.Assert(fired, "applyReport never touched shadow:%s", kThermo);
  const auto reported = ctx.Redis.HGetAll("shadow:" + kThermo + ":reported");
  const std::string version = ctx.Redis.HGet("shadow:" + kThermo, "reported_version").value_or("");
  ctx.Assert(reported == Doc{{"mode", "v9"}} && version == "9",
             "report 9 landed on another instance while report 8 was being applied, and the shadow now holds mode %q at reported_version %q: the read, the comparison and the write must be one script, or an older report overwrites a newer one",
             reported.count("mode") ? reported.at("mode") : std::string(), version);
}
`,
  },
  hints: [
    "Patch the mode, then the setpoint: the mode is gone from the desired document. Update desired twice after a device report of version 10, and the device's report 11 is refused.",
    "`update_desired` deletes the hash before writing the patch, and both writers move the one `version` field, so operator updates push it past the device's own numbering. The report reads with `HGET` and writes later: another instance can land in between.",
    'Drop the `DEL` in `update_desired` and `HINCRBY desired_version`. In `REPORT_LUA`: `HGET reported_version`, return 0 unless `ARGV[1]` is greater, else `DEL` and `HSET` the reported hash and set `reported_version`; call it through `register_script`.',
  ],
  debrief: `Two writers get two counters: the operator and the device never share a numbering, so each version only says how many of that side's changes the shadow holds. A patch is what an operator means by an update, which is why the desired write merges, while the device knows its whole state and replaces its document. The comparison sits in the same script as the write because Redis runs a script without interleaving other clients, and nothing else stops an older report from landing after a newer one. AWS IoT keeps one version for the whole document and refuses an update that names a stale one; a production hub also records when each field last changed and lets a device report only the fields that moved.`,
};
