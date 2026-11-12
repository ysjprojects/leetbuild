/**
 * Hand-written support modules the iot-hub steps import but no step builds: the `iothub` package.
 * `commands` is the command store (one Redis hash per (device, idempotency id), the delivery queue,
 * the per-device rate windows), `shadow` the device shadow of step 2 as later steps use it
 * (`update_desired`, `apply_report`, `read_shadow`), `registry` which tenant owns a device, `outbox`
 * the list a relay republishes from. The five languages keep the same keys, so a harness reads one
 * layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'iothub/__init__.py': '',
  'iothub/commands.py': `"""
The command store (provided): a command is the Redis hash command:{device_id}:{idempotency_id} with
command_id, device_id, action, params (a JSON object), state, expires_at_ms (the end of its validity
window in milliseconds since the epoch, 0 when none was recorded) and ack_required ("1" or "0").
device:{device_id}:queue lists the command ids handed to the delivery worker, oldest first, and
rate:{device_id}:{window} counts a device's commands in one rate window. A command is a dict with
params a dict, expires_at_ms an int and ack_required a bool.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def command_key(device_id: str, idempotency_id: str) -> str:
    return f"command:{device_id}:{idempotency_id}"


def queue_key(device_id: str) -> str:
    return f"device:{device_id}:queue"


def new_command_id() -> str:
    """A fresh command id: cmd-1, cmd-2, …"""
    return f"cmd-{r.incr('command:seq')}"


def lookup(device_id: str, idempotency_id: str) -> dict | None:
    """The command recorded under (device_id, idempotency_id), or None."""
    raw = r.hgetall(command_key(device_id, idempotency_id))
    if not raw:
        return None
    return {
        "command_id": raw["command_id"],
        "device_id": raw["device_id"],
        "action": raw["action"],
        "params": json.loads(raw.get("params") or "{}"),
        "state": raw["state"],
        "expires_at_ms": int(raw.get("expires_at_ms") or 0),
        "ack_required": raw.get("ack_required") == "1",
    }


def record(device_id: str, idempotency_id: str, command: dict) -> None:
    """Store the command under (device_id, idempotency_id)."""
    r.hset(
        command_key(device_id, idempotency_id),
        mapping={
            "command_id": command["command_id"],
            "device_id": command["device_id"],
            "action": command["action"],
            "params": json.dumps(command.get("params", {})),
            "state": command["state"],
            "expires_at_ms": int(command.get("expires_at_ms", 0)),
            "ack_required": "1" if command.get("ack_required", True) else "0",
        },
    )


def enqueue(device_id: str, command_id: str) -> None:
    """Hand the command to the delivery worker: from here on it will be sent to the device."""
    r.rpush(queue_key(device_id), command_id)


def count_in_window(device_id: str, window_s: int) -> int:
    """Count one command of the device in the current window of window_s seconds; the window's total so far."""
    key = f"rate:{device_id}:{int(time.time()) // window_s}"
    count = r.incr(key)
    if count == 1:
        r.expire(key, window_s * 2)
    return count
`,
  'iothub/shadow.py': `"""
The device shadow (provided; step 2 builds the same three functions). shadow:{device_id}:desired and
shadow:{device_id}:reported are the two documents, hashes of field to value; shadow:{device_id}
holds desired_version (one more per operator update) and reported_version (the version of the last
report the device sent). update_desired merges a patch into the desired document and returns the new
desired_version; apply_report replaces the reported document only when the report is newer than the
stored one, in one Lua script, and says whether it did; read_shadow returns both documents and both
versions.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

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
    """Merge patch into the desired document; the new desired_version."""
    r.hset(desired_key(device_id), mapping=patch)
    return r.hincrby(shadow_key(device_id), "desired_version", 1)


def apply_report(device_id: str, reported: dict[str, str], version: int) -> bool:
    """The device's whole reported state at version; ignored unless newer than the stored report."""
    args = [version]
    for field, value in reported.items():
        args += [field, value]
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
  'iothub/registry.py': `"""
The device registry (provided): device:{device_id} is a hash whose owner field is the tenant the
device belongs to. A device that was never registered has no owner.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def enroll(device_id: str, tenant: str) -> None:
    r.hset(f"device:{device_id}", "owner", tenant)


def owner(device_id: str) -> str | None:
    """The tenant that owns the device, or None for an unknown device."""
    return r.hget(f"device:{device_id}", "owner")
`,
  'iothub/outbox.py': `"""
The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
publishes once the broker takes records again.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'iothub/commands.ts': `/**
 * The command store (provided): a command is the Redis hash command:{device_id}:{idempotency_id}
 * with command_id, device_id, action, params (a JSON object), state, expires_at_ms (the end of its
 * validity window in milliseconds since the epoch, 0 or absent when none was recorded) and
 * ack_required ("1" or "0"). device:{device_id}:queue lists the command ids handed to the delivery
 * worker, oldest first, and rate:{device_id}:{window} counts a device's commands in one rate window.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Command {
  command_id: string;
  device_id: string;
  action: string;
  params: Record<string, string>;
  state: string;
  expires_at_ms?: number;
  ack_required: boolean;
}

export const commandKey = (deviceId: string, idempotencyId: string): string => \`command:\${deviceId}:\${idempotencyId}\`;
export const queueKey = (deviceId: string): string => \`device:\${deviceId}:queue\`;

/** A fresh command id: cmd-1, cmd-2, … */
export async function newCommandId(): Promise<string> {
  return \`cmd-\${await redis.incr('command:seq')}\`;
}

/** The command recorded under (deviceId, idempotencyId), or null. */
export async function lookup(deviceId: string, idempotencyId: string): Promise<Command | null> {
  const raw = await redis.hgetall(commandKey(deviceId, idempotencyId));
  if (Object.keys(raw).length === 0) return null;
  return {
    command_id: raw.command_id,
    device_id: raw.device_id,
    action: raw.action,
    params: JSON.parse(raw.params || '{}') as Record<string, string>,
    state: raw.state,
    expires_at_ms: Number(raw.expires_at_ms || 0),
    ack_required: raw.ack_required === '1',
  };
}

/** Store the command under (deviceId, idempotencyId). */
export async function record(deviceId: string, idempotencyId: string, command: Command): Promise<void> {
  await redis.hset(commandKey(deviceId, idempotencyId), {
    command_id: command.command_id,
    device_id: command.device_id,
    action: command.action,
    params: JSON.stringify(command.params ?? {}),
    state: command.state,
    expires_at_ms: String(command.expires_at_ms ?? 0),
    ack_required: command.ack_required ? '1' : '0',
  });
}

/** Hand the command to the delivery worker: from here on it will be sent to the device. */
export async function enqueue(deviceId: string, commandId: string): Promise<void> {
  await redis.rpush(queueKey(deviceId), commandId);
}

/** Count one command of the device in the current window of windowS seconds; the window's total so far. */
export async function countInWindow(deviceId: string, windowS: number): Promise<number> {
  const key = \`rate:\${deviceId}:\${Math.floor(Date.now() / 1000 / windowS)}\`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowS * 2);
  return count;
}
`,
  'iothub/shadow.ts': `/**
 * The device shadow (provided; step 2 builds the same three functions). shadow:{device_id}:desired
 * and shadow:{device_id}:reported are the two documents, hashes of field to value;
 * shadow:{device_id} holds desired_version (one more per operator update) and reported_version (the
 * version of the last report the device sent). updateDesired merges a patch into the desired
 * document and returns the new desired_version; applyReport replaces the reported document only
 * when the report is newer than the stored one, in one Lua script, and says whether it did;
 * readShadow returns both documents and both versions.
 */
import Redis from 'ioredis';

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

/** Merge patch into the desired document; the new desired_version. */
export async function updateDesired(deviceId: string, patch: Record<string, string>): Promise<number> {
  await redis.hset(desiredKey(deviceId), patch);
  return redis.hincrby(shadowKey(deviceId), 'desired_version', 1);
}

/** The device's whole reported state at version; ignored unless newer than the stored report. */
export async function applyReport(deviceId: string, reported: Record<string, string>, version: number): Promise<boolean> {
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
  'iothub/registry.ts': `/**
 * The device registry (provided): device:{device_id} is a hash whose owner field is the tenant the
 * device belongs to. A device that was never registered has no owner.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function enroll(deviceId: string, tenant: string): Promise<void> {
  await redis.hset(\`device:\${deviceId}\`, 'owner', tenant);
}

/** The tenant that owns the device, or null for an unknown device. */
export async function owner(deviceId: string): Promise<string | null> {
  return redis.hget(\`device:\${deviceId}\`, 'owner');
}
`,
  'iothub/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
 * publishes once the broker takes records again.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'iothub/commands/commands.go': `// Package commands is the command store (provided): a command is the Redis hash
// command:{device_id}:{idempotency_id} with command_id, device_id, action, params (a JSON object),
// state, expires_at_ms (the end of its validity window in milliseconds since the epoch, 0 when none
// was recorded) and ack_required ("1" or "0"). device:{device_id}:queue lists the command ids
// handed to the delivery worker, oldest first, and rate:{device_id}:{window} counts a device's
// commands in one rate window.
package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Command is one command to a device, as the API answers with it.
type Command struct {
	CommandID   string            \`json:"command_id"\`
	DeviceID    string            \`json:"device_id"\`
	Action      string            \`json:"action"\`
	Params      map[string]string \`json:"params"\`
	State       string            \`json:"state"\`
	ExpiresAtMs int64             \`json:"expires_at_ms"\`
	AckRequired bool              \`json:"ack_required"\`
}

// CommandKey is the hash a command is recorded in.
func CommandKey(deviceID, idempotencyID string) string {
	return "command:" + deviceID + ":" + idempotencyID
}

// QueueKey lists the command ids handed to the delivery worker for a device.
func QueueKey(deviceID string) string { return "device:" + deviceID + ":queue" }

// NewCommandID is a fresh command id: cmd-1, cmd-2, …
func NewCommandID(ctx context.Context) string {
	return fmt.Sprintf("cmd-%d", rdb.Incr(ctx, "command:seq").Val())
}

// Lookup is the command recorded under (deviceID, idempotencyID), or nil.
func Lookup(ctx context.Context, deviceID, idempotencyID string) (*Command, error) {
	raw, err := rdb.HGetAll(ctx, CommandKey(deviceID, idempotencyID)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	c := &Command{CommandID: raw["command_id"], DeviceID: raw["device_id"], Action: raw["action"], State: raw["state"], AckRequired: raw["ack_required"] == "1"}
	json.Unmarshal([]byte(raw["params"]), &c.Params)
	if c.Params == nil {
		c.Params = map[string]string{}
	}
	c.ExpiresAtMs, _ = strconv.ParseInt(raw["expires_at_ms"], 10, 64)
	return c, nil
}

// Record stores the command under (deviceID, idempotencyID).
func Record(ctx context.Context, deviceID, idempotencyID string, c *Command) error {
	params := c.Params
	if params == nil {
		params = map[string]string{}
	}
	raw, _ := json.Marshal(params)
	ack := "0"
	if c.AckRequired {
		ack = "1"
	}
	return rdb.HSet(ctx, CommandKey(deviceID, idempotencyID), map[string]any{
		"command_id":    c.CommandID,
		"device_id":     c.DeviceID,
		"action":        c.Action,
		"params":        string(raw),
		"state":         c.State,
		"expires_at_ms": strconv.FormatInt(c.ExpiresAtMs, 10),
		"ack_required":  ack,
	}).Err()
}

// Enqueue hands the command to the delivery worker: from here on it will be sent to the device.
func Enqueue(ctx context.Context, deviceID, commandID string) error {
	return rdb.RPush(ctx, QueueKey(deviceID), commandID).Err()
}

// CountInWindow counts one command of the device in the current window of windowS seconds and
// returns the window's total so far.
func CountInWindow(ctx context.Context, deviceID string, windowS int64) (int64, error) {
	key := fmt.Sprintf("rate:%s:%d", deviceID, time.Now().Unix()/windowS)
	count, err := rdb.Incr(ctx, key).Result()
	if err == nil && count == 1 {
		rdb.Expire(ctx, key, time.Duration(windowS*2)*time.Second)
	}
	return count, err
}
`,
  'iothub/shadow/shadow.go': `// Package shadow is the device shadow (provided; step 2 builds the same three functions).
// shadow:{device_id}:desired and shadow:{device_id}:reported are the two documents, hashes of field
// to value; shadow:{device_id} holds desired_version (one more per operator update) and
// reported_version (the version of the last report the device sent). UpdateDesired merges a patch
// into the desired document and returns the new desired_version; ApplyReport replaces the reported
// document only when the report is newer than the stored one, in one Lua script, and says whether it
// did; ReadShadow returns both documents and both versions.
package shadow

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ReportScript keeps a report only when it is newer than the stored one.
var ReportScript = redis.NewScript(\`
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

func ShadowKey(deviceID string) string   { return "shadow:" + deviceID }
func DesiredKey(deviceID string) string  { return "shadow:" + deviceID + ":desired" }
func ReportedKey(deviceID string) string { return "shadow:" + deviceID + ":reported" }

// UpdateDesired merges patch into the desired document and returns the new desired_version.
func UpdateDesired(ctx context.Context, deviceID string, patch map[string]string) (int64, error) {
	if err := rdb.HSet(ctx, DesiredKey(deviceID), patch).Err(); err != nil {
		return 0, err
	}
	return rdb.HIncrBy(ctx, ShadowKey(deviceID), "desired_version", 1).Result()
}

// ApplyReport takes the device's whole reported state at version; it is ignored unless newer than
// the stored report.
func ApplyReport(ctx context.Context, deviceID string, reported map[string]string, version int64) (bool, error) {
	args := []any{version}
	for field, value := range reported {
		args = append(args, field, value)
	}
	kept, err := ReportScript.Run(ctx, rdb, []string{ShadowKey(deviceID), ReportedKey(deviceID)}, args...).Int64()
	return kept == 1, err
}

// ReadShadow is both documents and both versions.
func ReadShadow(ctx context.Context, deviceID string) (*Shadow, error) {
	versions, err := rdb.HGetAll(ctx, ShadowKey(deviceID)).Result()
	if err != nil {
		return nil, err
	}
	s := &Shadow{Desired: rdb.HGetAll(ctx, DesiredKey(deviceID)).Val(), Reported: rdb.HGetAll(ctx, ReportedKey(deviceID)).Val()}
	s.DesiredVersion, _ = strconv.ParseInt(versions["desired_version"], 10, 64)
	s.ReportedVersion, _ = strconv.ParseInt(versions["reported_version"], 10, 64)
	return s, nil
}
`,
  'iothub/registry/registry.go': `// Package registry is the device registry (provided): device:{device_id} is a hash whose owner
// field is the tenant the device belongs to. A device that was never registered has no owner.
package registry

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Enroll records the tenant that owns the device.
func Enroll(ctx context.Context, deviceID, tenant string) error {
	return rdb.HSet(ctx, "device:"+deviceID, "owner", tenant).Err()
}

// Owner is the tenant that owns the device; false for an unknown device.
func Owner(ctx context.Context, deviceID string) (string, bool) {
	tenant, err := rdb.HGet(ctx, "device:"+deviceID, "owner").Result()
	return tenant, err == nil
}
`,
  'iothub/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox of JSON rows {"topic", "key",
// "payload"} that a relay publishes once the broker takes records again.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert queues a record for the relay to publish later.
func Insert(ctx context.Context, topic, key string, payload any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'iothub/commands.h': `// The command store (provided): a command is the Redis hash command:{device_id}:{idempotency_id}
// with command_id, device_id, action, params (a JSON object), state, expires_at_ms (the end of its
// validity window in milliseconds since the epoch, 0 when none was recorded) and ack_required ("1"
// or "0"). device:{device_id}:queue lists the command ids handed to the delivery worker, oldest
// first, and rate:{device_id}:{window} counts a device's commands in one rate window.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>

namespace commands {

struct Command {
  std::string command_id;
  std::string device_id;
  std::string action;
  std::map<std::string, std::string> params;
  std::string state;
  long long expires_at_ms = 0;
  bool ack_required = true;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string commandKey(const std::string& device_id, const std::string& idempotency_id) {
  return "command:" + device_id + ":" + idempotency_id;
}

inline std::string queueKey(const std::string& device_id) { return "device:" + device_id + ":queue"; }

// The command as the API answers with it.
inline nlohmann::json toJson(const Command& c) {
  return nlohmann::json{{"command_id", c.command_id}, {"device_id", c.device_id}, {"action", c.action},
                        {"params", c.params},         {"state", c.state},         {"expires_at_ms", c.expires_at_ms},
                        {"ack_required", c.ack_required}};
}

// A fresh command id: cmd-1, cmd-2, …
inline std::string newCommandId() { return "cmd-" + std::to_string(redis().incr("command:seq")); }

// The command recorded under (device_id, idempotency_id), or none.
inline std::optional<Command> lookup(const std::string& device_id, const std::string& idempotency_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(commandKey(device_id, idempotency_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Command c;
  c.command_id = text("command_id");
  c.device_id = text("device_id");
  c.action = text("action");
  if (!text("params").empty()) c.params = nlohmann::json::parse(text("params")).get<std::map<std::string, std::string>>();
  c.state = text("state");
  c.expires_at_ms = text("expires_at_ms").empty() ? 0 : std::stoll(text("expires_at_ms"));
  c.ack_required = text("ack_required") == "1";
  return c;
}

// Store the command under (device_id, idempotency_id).
inline void record(const std::string& device_id, const std::string& idempotency_id, const Command& c) {
  redis().hset(commandKey(device_id, idempotency_id), {{"command_id", c.command_id},
                                                       {"device_id", c.device_id},
                                                       {"action", c.action},
                                                       {"params", nlohmann::json(c.params).dump()},
                                                       {"state", c.state},
                                                       {"expires_at_ms", std::to_string(c.expires_at_ms)},
                                                       {"ack_required", c.ack_required ? "1" : "0"}});
}

// Hand the command to the delivery worker: from here on it will be sent to the device.
inline void enqueue(const std::string& device_id, const std::string& command_id) {
  redis().rpush(queueKey(device_id), command_id);
}

// Count one command of the device in the current window of window_s seconds; the window's total so far.
inline long long countInWindow(const std::string& device_id, long long window_s) {
  const long long now_s =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = "rate:" + device_id + ":" + std::to_string(now_s / window_s);
  const long long count = redis().incr(key);
  if (count == 1) redis().expire(key, window_s * 2);
  return count;
}

}  // namespace commands
`,
  'iothub/shadow.h': `// The device shadow (provided; step 2 builds the same three functions). shadow:{device_id}:desired
// and shadow:{device_id}:reported are the two documents, hashes of field to value;
// shadow:{device_id} holds desired_version (one more per operator update) and reported_version (the
// version of the last report the device sent). updateDesired merges a patch into the desired
// document and returns the new desired_version; applyReport replaces the reported document only
// when the report is newer than the stored one, in one Lua script, and says whether it did;
// readShadow returns both documents and both versions.
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <unordered_map>
#include <vector>

namespace shadow {

struct Shadow {
  std::map<std::string, std::string> desired;
  std::map<std::string, std::string> reported;
  long long desired_version = 0;
  long long reported_version = 0;
};

inline const std::string kReportLua = R"lua(
local stored = tonumber(redis.call('HGET', KEYS[1], 'reported_version') or '0')
if tonumber(ARGV[1]) <= stored then return 0 end
redis.call('DEL', KEYS[2])
for i = 2, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'reported_version', ARGV[1])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string shadowKey(const std::string& device_id) { return "shadow:" + device_id; }
inline std::string desiredKey(const std::string& device_id) { return "shadow:" + device_id + ":desired"; }
inline std::string reportedKey(const std::string& device_id) { return "shadow:" + device_id + ":reported"; }

// Merge patch into the desired document; the new desired_version.
inline long long updateDesired(const std::string& device_id, const std::map<std::string, std::string>& patch) {
  redis().hset(desiredKey(device_id), patch.begin(), patch.end());
  return redis().hincrby(shadowKey(device_id), "desired_version", 1);
}

// The device's whole reported state at version; ignored unless newer than the stored report.
inline bool applyReport(const std::string& device_id, const std::map<std::string, std::string>& reported, long long version) {
  std::vector<std::string> args = {std::to_string(version)};
  for (const auto& [field, value] : reported) {
    args.push_back(field);
    args.push_back(value);
  }
  return redis().eval<long long>(kReportLua, {shadowKey(device_id), reportedKey(device_id)}, args) == 1;
}

// Both documents and both versions.
inline Shadow readShadow(const std::string& device_id) {
  const std::unordered_map<std::string, std::string> versions = redis().hgetall(shadowKey(device_id));
  const std::unordered_map<std::string, std::string> desired = redis().hgetall(desiredKey(device_id));
  const std::unordered_map<std::string, std::string> reported = redis().hgetall(reportedKey(device_id));
  Shadow s;
  s.desired = std::map<std::string, std::string>(desired.begin(), desired.end());
  s.reported = std::map<std::string, std::string>(reported.begin(), reported.end());
  s.desired_version = versions.count("desired_version") ? std::stoll(versions.at("desired_version")) : 0;
  s.reported_version = versions.count("reported_version") ? std::stoll(versions.at("reported_version")) : 0;
  return s;
}

}  // namespace shadow
`,
  'iothub/registry.h': `// The device registry (provided): device:{device_id} is a hash whose owner field is the tenant the
// device belongs to. A device that was never registered has no owner.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace registry {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline void enroll(const std::string& device_id, const std::string& tenant) {
  redis().hset("device:" + device_id, "owner", tenant);
}

// The tenant that owns the device, or none for an unknown device.
inline std::optional<std::string> owner(const std::string& device_id) {
  const auto tenant = redis().hget("device:" + device_id, "owner");
  if (!tenant) return std::nullopt;
  return std::string(*tenant);
}

}  // namespace registry
`,
  'iothub/outbox.h': `// The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a
// relay publishes once the broker takes records again.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('iothub', 'Commands')]: `package iothub

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/** One command to a device; expiresAtMs is 0 when no validity window was recorded. */
final case class Command(
    commandId: String,
    deviceId: String,
    action: String,
    params: Map[String, String],
    state: String,
    ackRequired: Boolean,
    expiresAtMs: Long = 0L)

/**
 * The command store (provided): a command is the Redis hash command:{device_id}:{idempotency_id}
 * with command_id, device_id, action, params (a JSON object), state, expires_at_ms (the end of its
 * validity window in milliseconds since the epoch, 0 when none was recorded) and ack_required ("1"
 * or "0"). device:{device_id}:queue lists the command ids handed to the delivery worker, oldest
 * first, and rate:{device_id}:{window} counts a device's commands in one rate window.
 */
object Commands {
  val jedis = new JedisPooled("redis", 6379)

  def commandKey(deviceId: String, idempotencyId: String): String = s"command:$deviceId:$idempotencyId"
  def queueKey(deviceId: String): String = s"device:$deviceId:queue"

  /** The command as the API answers with it. */
  def toJson(c: Command): JsObject = JsObject(
    "command_id" -> JsString(c.commandId),
    "device_id" -> JsString(c.deviceId),
    "action" -> JsString(c.action),
    "params" -> JsObject(c.params.map { case (k, v) => k -> JsString(v) }),
    "state" -> JsString(c.state),
    "expires_at_ms" -> JsNumber(c.expiresAtMs),
    "ack_required" -> JsBoolean(c.ackRequired))

  /** A fresh command id: cmd-1, cmd-2, … */
  def newCommandId(): String = s"cmd-\${jedis.incr("command:seq")}"

  /** The command recorded under (deviceId, idempotencyId), if any. */
  def lookup(deviceId: String, idempotencyId: String): Option[Command] = {
    val raw = jedis.hgetAll(commandKey(deviceId, idempotencyId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      val params = raw.get("params").filter(_.nonEmpty).map(_.parseJson.asJsObject.fields.collect { case (k, JsString(v)) => k -> v }).getOrElse(Map.empty[String, String])
      Some(Command(raw("command_id"), raw("device_id"), raw("action"), params, raw("state"), raw.get("ack_required").contains("1"),
        raw.get("expires_at_ms").filter(_.nonEmpty).map(_.toLong).getOrElse(0L)))
    }
  }

  /** Store the command under (deviceId, idempotencyId). */
  def record(deviceId: String, idempotencyId: String, c: Command): Unit =
    jedis.hset(commandKey(deviceId, idempotencyId), Map(
      "command_id" -> c.commandId,
      "device_id" -> c.deviceId,
      "action" -> c.action,
      "params" -> JsObject(c.params.map { case (k, v) => k -> JsString(v) }).compactPrint,
      "state" -> c.state,
      "expires_at_ms" -> c.expiresAtMs.toString,
      "ack_required" -> (if (c.ackRequired) "1" else "0")).asJava)

  /** Hand the command to the delivery worker: from here on it will be sent to the device. */
  def enqueue(deviceId: String, commandId: String): Unit = jedis.rpush(queueKey(deviceId), commandId)

  /** Count one command of the device in the current window of windowS seconds; the window's total so far. */
  def countInWindow(deviceId: String, windowS: Long): Long = {
    val key = s"rate:$deviceId:\${System.currentTimeMillis() / 1000 / windowS}"
    val count = jedis.incr(key)
    if (count == 1L) jedis.expire(key, windowS * 2)
    count
  }
}
`,
  [scalaPath('iothub', 'Shadow')]: `package iothub

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** Both documents and both versions of one device. */
final case class DeviceShadow(desired: Map[String, String], reported: Map[String, String], desiredVersion: Long, reportedVersion: Long)

/**
 * The device shadow (provided; step 2 builds the same three functions). shadow:{device_id}:desired
 * and shadow:{device_id}:reported are the two documents, hashes of field to value;
 * shadow:{device_id} holds desired_version (one more per operator update) and reported_version (the
 * version of the last report the device sent). updateDesired merges a patch into the desired
 * document and returns the new desired_version; applyReport replaces the reported document only
 * when the report is newer than the stored one, in one Lua script, and says whether it did;
 * readShadow returns both documents and both versions.
 */
object Shadow {
  val jedis = new JedisPooled("redis", 6379)

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

  /** Merge patch into the desired document; the new desired_version. */
  def updateDesired(deviceId: String, patch: Map[String, String]): Long = {
    jedis.hset(desiredKey(deviceId), patch.asJava)
    jedis.hincrBy(shadowKey(deviceId), "desired_version", 1L)
  }

  /** The device's whole reported state at version; ignored unless newer than the stored report. */
  def applyReport(deviceId: String, reported: Map[String, String], version: Long): Boolean = {
    val args = version.toString :: reported.toList.flatMap { case (field, value) => List(field, value) }
    jedis.eval(ReportLua, List(shadowKey(deviceId), reportedKey(deviceId)).asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Both documents and both versions. */
  def readShadow(deviceId: String): DeviceShadow = {
    val versions = jedis.hgetAll(shadowKey(deviceId)).asScala
    DeviceShadow(
      jedis.hgetAll(desiredKey(deviceId)).asScala.toMap,
      jedis.hgetAll(reportedKey(deviceId)).asScala.toMap,
      versions.get("desired_version").map(_.toLong).getOrElse(0L),
      versions.get("reported_version").map(_.toLong).getOrElse(0L))
  }
}
`,
  [scalaPath('iothub', 'Registry')]: `package iothub

import redis.clients.jedis.JedisPooled

/**
 * The device registry (provided): device:{device_id} is a hash whose owner field is the tenant the
 * device belongs to. A device that was never registered has no owner.
 */
object Registry {
  val jedis = new JedisPooled("redis", 6379)

  def enroll(deviceId: String, tenant: String): Unit = jedis.hset(s"device:$deviceId", "owner", tenant)

  /** The tenant that owns the device, or None for an unknown device. */
  def owner(deviceId: String): Option[String] = Option(jedis.hget(s"device:$deviceId", "owner"))
}
`,
  [scalaPath('iothub', 'Outbox')]: `package iothub

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
 * publishes once the broker takes records again.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  def insert(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
