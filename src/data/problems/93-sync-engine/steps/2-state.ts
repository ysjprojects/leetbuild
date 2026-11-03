import type {Step} from '@/lib/types';

export const cursorStateStep: Step = {
  id: 'state',
  concept: 'redis',
  file: 'state',
  title: 'Redis per-device cursors with a monotonic watermark',
  focus: ['sync', 'redis'],
  task: `## Task

**Starting point.** The starter keeps a cursor per device under \`cursor:{device}\` in Redis, a
watermark under a literal \`"watermark"\` key, and in \`push\` commits the cursor, applies the batch,
then writes the watermark with a plain \`SET\`. It compiles, a happy-path client resumes exactly where
it stopped, and it hides five flaws. They only show on a crash, a replay or a quiet week.

**Failure mode the checks target.** A worker dies between the cursor write and the apply, and the
device is told "you already sent this" while its batch was never applied. A laptop closed for eight
days comes back to an expired cursor. Two concurrent pushes leave the watermark moving backwards.

- Each device has its own cursor key (\`cursor:{device}\`); the watermark lives under
  \`WATERMARK_KEY\`.
- The cursor advances only after its batch is applied (\`apply_batch\`, then \`commit_cursor\`), so a
  crash in between replays the batch instead of losing it.
- A cursor does not expire.
- The cursor does not move backwards: the advance is a compare-and-set (\`CURSOR_LUA\`) that keeps the
  higher value.
- The server watermark only moves forward under concurrent advances (\`WATERMARK_LUA\`).`,
  sequence: {
    participants: ['Sync Engine', 'revisions', 'Redis'],
    messages: [
      {from: 'Sync Engine', to: 'revisions', label: 'apply_batch(device, changes)', kind: 'sync'},
      {from: 'revisions', to: 'Sync Engine', label: '{applied, conflicts, revision}', kind: 'reply'},
      {from: 'Sync Engine', to: 'Redis', label: 'EVAL cursor · KEYS[cursor:{device}] ARGV[revision]', kind: 'sync'},
      {from: 'Redis', to: 'Sync Engine', label: 'cursor (never lower, never expiring)', kind: 'reply'},
      {from: 'Sync Engine', to: 'Redis', label: 'EVAL watermark · KEYS[watermark] ARGV[revision]', kind: 'sync'},
      {from: 'Redis', to: 'Sync Engine', label: 'watermark (monotonic)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cursor-after-apply',
      title: 'Advances the cursor after the batch is applied',
      detail:
        'The batch is applied first and the cursor is committed second; a crash between them replays the batch instead of losing it. The starter commits the cursor before `apply_batch` runs.',
      match: {
        python: {order: [/apply_batch\(device, changes\)/, /commit_cursor\(device, revision\)/]},
        typescript: {order: [/applyBatch\(device, changes\)/, /commitCursor\(device, revision\)/]},
        go: {order: [/applyBatch\(ctx, device, changes\)/, /commitCursor\(ctx, device, revision\)/]},
        scala: {order: [/applyBatch\(device, changes\)/, /commitCursor\(device, revision\)/]},
        cpp: {order: [/applyBatch\(device, changes\)/, /commitCursor\(redis, device, revision\)/]},
      },
    },
    {
      id: 'cursor-monotonic',
      title: 'Advances the cursor with one compare-and-set script',
      detail:
        'The cursor advance is a Lua script (`CURSOR_LUA`) that keeps the higher revision, so a replayed or out-of-order batch cannot move a device backwards. The starter writes the value it was given with a plain `SET`.',
      match: {
        python: {all: [/CURSOR_LUA/, /\.eval\(/, /SET/]},
        typescript: {all: [/CURSOR_LUA/, /\.eval\(/, /SET/]},
        go: {all: [/cursorScript/, /\.Run\(/, /SET/]},
        scala: {all: [/CursorLua/, /\.eval\(/, /SET/]},
        cpp: {all: [/kCursorLua/, /\.eval</, /SET/]},
      },
    },
    {
      id: 'cursor-no-ttl',
      title: 'Cursors never expire',
      detail:
        'The cursor key is written without an expiry, so a device idle for a week comes back to the cursor it left. The starter stores the cursor with a one-week TTL.',
      match: {
        python: {all: [/cursor_key\(device\)/], none: [/cursor[^\n]*\bex\s*=/]},
        typescript: {all: [/cursorKey\(device\)/], none: [/cursorKey\(device\)[^\n]*'EX'/]},
        go: {all: [/cursorKey\(device\)/], none: [/cursorTTL/]},
        scala: {all: [/cursorKey\(device\)/], none: [/CursorTtlSeconds/]},
        cpp: {all: [/cursorKey\(device\)/], none: [/kCursorTtlSeconds/]},
      },
    },
    {
      id: 'watermark-monotonic',
      title: 'The server watermark only moves forward',
      detail:
        'The watermark advance is one atomic script (`WATERMARK_LUA`) that ignores a lower revision, so two concurrent advances cannot move it backwards. The starter overwrites the key with whatever the last write carried.',
      match: {
        python: {all: [/WATERMARK_LUA/, /\.eval\(/, /SET/]},
        typescript: {all: [/WATERMARK_LUA/, /\.eval\(/, /SET/]},
        go: {all: [/watermarkScript/, /\.Run\(/, /SET/]},
        scala: {all: [/WatermarkLua/, /\.eval\(/, /SET/]},
        cpp: {all: [/kWatermarkLua/, /\.eval</, /SET/]},
      },
    },
    {
      id: 'device-key-watermark-key',
      title: 'One cursor key per device, one shared watermark key',
      detail:
        'The cursor is keyed by the device (`cursor:{device}`) and the watermark is a single well-known key named by `WATERMARK_KEY`. The starter spells the watermark key as a bare string literal.',
      match: {
        python: {all: [/cursor:\{device\}/, /WATERMARK_KEY/]},
        typescript: {all: [/'cursor:'/, /WATERMARK_KEY/]},
        go: {all: [/"cursor:"/, /watermarkKey/]},
        scala: {all: [/cursor:\$device/, /WatermarkKey/]},
        cpp: {all: [/"cursor:"/, /kWatermarkKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURSOR_TTL_S = 7 * 24 * 3600


def cursor_key(device: str) -> str:
    return f"cursor:{device}"


def apply_batch(device: str, changes: list[dict]) -> dict:
    """Apply one batch and return {applied, statuses, revision}."""
    raise NotImplementedError


def commit_cursor(device: str, revision: int) -> int:
    """Advance the device's cursor to the revision of the batch it just sent."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    r.set(cursor_key(device), revision, ex=CURSOR_TTL_S)
    return revision


def watermark() -> int:
    """The watermark a device compares against its cursor to detect gaps."""
    return int(r.get("watermark") or 0)


def push(device: str, changes: list[dict], revision: int) -> dict:
    cursor = commit_cursor(device, revision)
    outcome = apply_batch(device, changes)
    r.set("watermark", revision)
    return {"applied": outcome["applied"], "cursor": cursor, "watermark": watermark()}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WATERMARK_KEY = "watermark"

CURSOR_LUA = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  current = next_revision
end
return current
"""

WATERMARK_LUA = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  return next_revision
end
return current
"""


def cursor_key(device: str) -> str:
    return f"cursor:{device}"


def apply_batch(device: str, changes: list[dict]) -> dict:
    """Apply one batch and return {applied, statuses, revision}."""
    raise NotImplementedError


def commit_cursor(device: str, revision: int) -> int:
    """Advance the device's cursor, never backwards and without any expiry."""
    # No TTL on purpose: a cursor is the device's receipt. Expiring it makes a device that was
    # closed for a week resync from zero and take a full snapshot on its next pull.
    return int(r.eval(CURSOR_LUA, 1, cursor_key(device), revision))


def advance_watermark(revision: int) -> int:
    """Move the server watermark forward atomically; a lower revision is ignored."""
    return int(r.eval(WATERMARK_LUA, 1, WATERMARK_KEY, revision))


def watermark() -> int:
    """The watermark a device compares against its cursor to detect gaps."""
    return int(r.get(WATERMARK_KEY) or 0)


def push(device: str, changes: list[dict], revision: int) -> dict:
    # The cursor is a receipt: it may only move once the batch it names is durable.
    outcome = apply_batch(device, changes)
    cursor = commit_cursor(device, revision)
    mark = advance_watermark(outcome["revision"])
    return {"applied": outcome["applied"], "cursor": cursor, "watermark": mark}
`,
    },
    typescript: {
      starter: `/** Cursors and the server watermark: a version that writes the receipt first. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const CURSOR_TTL_S = 7 * 24 * 3600;

export function cursorKey(device: string): string {
  return 'cursor:' + device;
}

export async function applyBatch(
  device: string,
  changes: unknown[],
): Promise<{applied: string[]; revision: number}> {
  throw new Error('not implemented');
}

export async function commitCursor(device: string, revision: number): Promise<number> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await r.set(cursorKey(device), String(revision), 'EX', CURSOR_TTL_S);
  return revision;
}

export async function watermark(): Promise<number> {
  return Number((await r.get('watermark')) ?? 0);
}

export async function push(device: string, changes: unknown[], revision: number): Promise<unknown> {
  const cursor = await commitCursor(device, revision);
  const outcome = await applyBatch(device, changes);
  await r.set('watermark', String(revision));
  return {applied: outcome.applied, cursor, watermark: await watermark()};
}
`,
      solution: `/** Cursors and the server watermark: the receipt follows the apply, and only moves forward. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const WATERMARK_KEY = 'watermark';

const CURSOR_LUA = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  current = next_revision
end
return current
\`;

const WATERMARK_LUA = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  return next_revision
end
return current
\`;

export function cursorKey(device: string): string {
  return 'cursor:' + device;
}

export async function applyBatch(
  device: string,
  changes: unknown[],
): Promise<{applied: string[]; revision: number}> {
  throw new Error('not implemented');
}

export async function commitCursor(device: string, revision: number): Promise<number> {
  // No expiry: the cursor is the device's receipt. Expire it and a device that was closed for a
  // week resyncs from zero, paying for a full snapshot every time it wakes up.
  return Number(await r.eval(CURSOR_LUA, 1, cursorKey(device), String(revision)));
}

export async function advanceWatermark(revision: number): Promise<number> {
  return Number(await r.eval(WATERMARK_LUA, 1, WATERMARK_KEY, String(revision)));
}

export async function watermark(): Promise<number> {
  return Number((await r.get(WATERMARK_KEY)) ?? 0);
}

export async function push(device: string, changes: unknown[], revision: number): Promise<unknown> {
  const outcome = await applyBatch(device, changes);
  const cursor = await commitCursor(device, revision);
  const mark = await advanceWatermark(outcome.revision);
  return {applied: outcome.applied, cursor, watermark: mark};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const cursorTTL = 7 * 24 * time.Hour

var rdb *redis.Client

func cursorKey(device string) string {
	return "cursor:" + device
}

func applyBatch(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	return nil, nil
}

func commitCursor(ctx context.Context, device string, revision int64) (int64, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	return revision, rdb.Set(ctx, cursorKey(device), revision, cursorTTL).Err()
}

func watermark(ctx context.Context) int64 {
	value, _ := rdb.Get(ctx, "watermark").Int64()
	return value
}

func push(ctx context.Context, device string, changes []Change, revision int64) (map[string]any, error) {
	cursor, err := commitCursor(ctx, device, revision)
	if err != nil {
		return nil, err
	}
	outcome, err := applyBatch(ctx, device, changes)
	if err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, "watermark", revision, 0).Err(); err != nil {
		return nil, err
	}
	return map[string]any{"applied": outcome["applied"], "cursor": cursor, "watermark": watermark(ctx)}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const watermarkKey = "watermark"

var rdb *redis.Client

var cursorScript = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  current = next_revision
end
return current
\`)

var watermarkScript = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  return next_revision
end
return current
\`)

func cursorKey(device string) string {
	return "cursor:" + device
}

func applyBatch(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	return nil, nil
}

func commitCursor(ctx context.Context, device string, revision int64) (int64, error) {
	// No expiry: a cursor is the receipt a device resumes from. Expiring it makes a device that
	// was closed for a week resync from zero on its next pull.
	return cursorScript.Run(ctx, rdb, []string{cursorKey(device)}, revision).Int64()
}

func advanceWatermark(ctx context.Context, revision int64) (int64, error) {
	return watermarkScript.Run(ctx, rdb, []string{watermarkKey}, revision).Int64()
}

func watermark(ctx context.Context) int64 {
	value, _ := rdb.Get(ctx, watermarkKey).Int64()
	return value
}

func push(ctx context.Context, device string, changes []Change, revision int64) (map[string]any, error) {
	// The cursor follows the apply: a crash between the two replays the batch instead of losing it.
	outcome, err := applyBatch(ctx, device, changes)
	if err != nil {
		return nil, err
	}
	cursor, err := commitCursor(ctx, device, revision)
	if err != nil {
		return nil, err
	}
	mark, err := advanceWatermark(ctx, revision)
	if err != nil {
		return nil, err
	}
	return map[string]any{"applied": outcome["applied"], "cursor": cursor, "watermark": mark}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object CursorStore {
  val CursorTtlSeconds = 7L * 24 * 60 * 60
  val jedis = new Jedis("redis", 6379)

  def cursorKey(device: String): String = s"cursor:$device"

  def applyBatch(device: String, changes: List[Change]): BatchOutcome = ???

  def commitCursor(device: String, revision: Long): Long = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    jedis.setex(cursorKey(device), CursorTtlSeconds, revision.toString)
    revision
  }

  def watermark(): Long = Option(jedis.get("watermark")).map(_.toLong).getOrElse(0L)

  def push(device: String, changes: List[Change], revision: Long): Map[String, Any] = {
    val cursor = commitCursor(device, revision)
    val outcome = applyBatch(device, changes)
    jedis.set("watermark", revision.toString)
    Map("applied" -> outcome.applied, "cursor" -> cursor, "watermark" -> watermark())
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object CursorStore {
  val WatermarkKey = "watermark"
  val jedis = new Jedis("redis", 6379)

  val CursorLua =
    """
      |local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local next_revision = tonumber(ARGV[1])
      |if next_revision > current then
      |  redis.call('SET', KEYS[1], next_revision)
      |  current = next_revision
      |end
      |return current
      |""".stripMargin

  val WatermarkLua =
    """
      |local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local next_revision = tonumber(ARGV[1])
      |if next_revision > current then
      |  redis.call('SET', KEYS[1], next_revision)
      |  return next_revision
      |end
      |return current
      |""".stripMargin

  def cursorKey(device: String): String = s"cursor:$device"

  def applyBatch(device: String, changes: List[Change]): BatchOutcome = ???

  def commitCursor(device: String, revision: Long): Long = {
    // No expiry: a cursor is the receipt a device resumes from. Expire it and a device that was
    // closed for a week resyncs from zero, paying for a full snapshot every time it wakes up.
    jedis.eval(CursorLua, 1, cursorKey(device), revision.toString).asInstanceOf[java.lang.Long].longValue()
  }

  def advanceWatermark(revision: Long): Long =
    jedis.eval(WatermarkLua, 1, WatermarkKey, revision.toString).asInstanceOf[java.lang.Long].longValue()

  def watermark(): Long = Option(jedis.get(WatermarkKey)).map(_.toLong).getOrElse(0L)

  def push(device: String, changes: List[Change], revision: Long): Map[String, Any] = {
    val outcome = applyBatch(device, changes)
    val cursor = commitCursor(device, revision)
    val mark = advanceWatermark(outcome.revision)
    Map("applied" -> outcome.applied, "cursor" -> cursor, "watermark" -> mark)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

constexpr long long kCursorTtlSeconds = 7 * 24 * 60 * 60;

std::string cursorKey(const std::string& device) {
  return "cursor:" + device;
}

json applyBatch(const std::string& device, const json& changes);

long long commitCursor(sw::redis::Redis& redis, const std::string& device, long long revision) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  redis.setex(cursorKey(device), kCursorTtlSeconds, std::to_string(revision));
  return revision;
}

long long watermark(sw::redis::Redis& redis) {
  auto value = redis.get("watermark");
  return value ? std::stoll(*value) : 0;
}

json push(sw::redis::Redis& redis, const std::string& device, const json& changes, long long revision) {
  const auto cursor = commitCursor(redis, device, revision);
  const auto outcome = applyBatch(device, changes);
  redis.set("watermark", std::to_string(revision));
  return json{{"applied", outcome["applied"]}, {"cursor", cursor}, {"watermark", watermark(redis)}};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kWatermarkKey = "watermark";

const char* kCursorLua = R"LUA(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  current = next_revision
end
return current
)LUA";

const char* kWatermarkLua = R"LUA(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next_revision = tonumber(ARGV[1])
if next_revision > current then
  redis.call('SET', KEYS[1], next_revision)
  return next_revision
end
return current
)LUA";

std::string cursorKey(const std::string& device) {
  return "cursor:" + device;
}

json applyBatch(const std::string& device, const json& changes);

long long commitCursor(sw::redis::Redis& redis, const std::string& device, long long revision) {
  // No expiry: a cursor is the receipt a device resumes from, and an expired one means a full
  // snapshot every time a device comes back from a week away.
  return redis.eval<long long>(kCursorLua, {cursorKey(device)}, {revision});
}

long long advanceWatermark(sw::redis::Redis& redis, long long revision) {
  return redis.eval<long long>(kWatermarkLua, {kWatermarkKey}, {revision});
}

long long watermark(sw::redis::Redis& redis) {
  auto value = redis.get(kWatermarkKey);
  return value ? std::stoll(*value) : 0;
}

json push(sw::redis::Redis& redis, const std::string& device, const json& changes, long long revision) {
  // The cursor is a receipt, so it moves after the batch it names is durable.
  const auto outcome = applyBatch(device, changes);
  const auto cursor = commitCursor(redis, device, revision);
  const auto mark = advanceWatermark(redis, revision);
  return json{{"applied", outcome["applied"]}, {"cursor", cursor}, {"watermark", mark}};
}
`,
    },
  },
  hints: [
    'A user edits on the train, the worker restarts mid-push, and the phone reports "up to date" while the document on the server does not have the edits. Nothing was logged.',
    '`push` writes the cursor before `apply_batch`, so the receipt exists for work that never happened. The key also carries `ex=CURSOR_TTL_S`, and `r.set("watermark", ...)` lets the slower of two writers win.',
    'Reorder to `apply_batch` then `commit_cursor`, drop the TTL, and make both advances a Lua compare-and-set (`CURSOR_LUA`, `WATERMARK_LUA` via `r.eval`) that only `SET`s a higher value; name the key with `WATERMARK_KEY`.',
  ],
  debrief: `A cursor is a receipt for work the server has durably done, which is why the fix is an ordering rather than a new data structure: apply, then commit. With that order a crash leaves a device that retries a batch the apply can deduplicate; the other order leaves a device whose own batch is skipped forever. The expiry goes for the same reason: a cursor exists to survive an idle week. Both advances become a Lua compare-and-set because two writers racing on a plain SET end on whichever landed last, and a watermark every device compares against must not go backwards.

Production cursor stores also record the batch id with the cursor, keep a per-document high-water mark, and add a snapshot path for a device whose cursor is older than the retention window.`,
};
