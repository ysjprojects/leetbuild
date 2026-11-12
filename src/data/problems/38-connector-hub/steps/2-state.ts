import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A Redis sync cursor that survives quiet weeks and rebalances',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'idempotent-requests'],
  file: 'state',
  focus: ['hub', 'redis'],
  task: `## Task

**Starting point.** The starter is the sync ledger every later step relies on:
\`commit_page(connector_id, page_token, next_cursor)\` checks \`page:{id}:{page_token}\` with
\`EXISTS\`, then sets that claim and \`cursor:{id}\` with a 24-hour TTL and answers
\`{applied, cursor}\`; \`load_cursor(connector_id)\` reads the checkpoint back. It serves the demo
and hides three flaws.

**Failure mode the checks target.** A connector that stays quiet over a long weekend restarts from
the vendor's first page and re-bills three months of history. Two workers that both fetched one
page after a rebalance both apply it. And a worker that replays an old page is told to continue
from the cursor it passed in, so it fetches a page it already applied.

- The cursor and the claim are durable: no TTL on either key.
- One Lua script (\`EVAL\`, \`register_script\`, \`defineCommand\`, \`NewScript\`) claims the page with
  \`SET … NX\` and moves the cursor only when the claim was fresh; nothing is decided from a read made
  in an earlier round trip.
- A page already claimed changes nothing and answers \`applied: false\` with the cursor the ledger
  holds, read inside the same script.`,
  sequence: {
    participants: ['Sync worker', 'Redis', 'Second worker'],
    messages: [
      {from: 'Sync worker', to: 'Redis', label: 'EVAL commit · SET page:c-1:t1 1 NX', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'claim fresh → SET cursor:c-1 t2', kind: 'sync'},
      {from: 'Redis', to: 'Sync worker', label: "{'1', 't2'}", kind: 'reply'},
      {from: 'Second worker', to: 'Redis', label: 'EVAL commit · same page after a rebalance', kind: 'sync'},
      {from: 'Redis', to: 'Second worker', label: "{'0', 't2'} · nothing applied twice", kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'durable-cursor',
      title: 'Keeps the cursor and the claim without a TTL',
      detail:
        "The checkpoint and the page claim are written without an expiry; a cursor that expires after a quiet day sends the next sync back to the vendor's first page.",
      match: {
        python: {all: [/cursor_key\(/], none: [/\bex\s*=/, /\bexpire\(/i, /setex/i, /['"]EX['"]/]},
        typescript: {all: [/cursorKey\(/], none: [/['"]EX['"]/, /\bexpire\(/i, /setex/i]},
        go: {all: [/cursorKey\(/], none: [/time\.Hour/, /\.Expire\(/, /SetEX\(/i]},
        scala: {all: [/cursorKey\(/], none: [/\.ex\(/, /setex/i, /\.expire\(/]},
        cpp: {all: [/cursorKey\(/], none: [/chrono::(seconds|hours|minutes)/, /\.expire\(/, /setex/i]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims the page and moves the cursor in one script',
      detail:
        'The page claim (`SET … NX`) and the cursor move run in one Lua script, so a second worker committing the same page lands before or after the whole commit; an `EXISTS` followed by two `SET`s lets both workers apply the page.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /['"]NX['"]/], none: [/\.exists\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /['"]NX['"]/], none: [/\.exists\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /['"]NX['"]/], none: [/\.Exists\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /['"]NX['"]/], none: [/\.exists\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /['"]NX['"]/], none: [/\.exists\(/]},
      },
    },
    {
      id: 'replay-cursor',
      title: 'Answers a replayed page with the cursor the ledger holds',
      detail:
        'When the claim exists the script returns `0` with `GET KEYS[2]`, the cursor the ledger holds, so a worker that replayed an old page continues from the checkpoint rather than from the cursor it passed in.',
      match: {
        python: {all: [/redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[2\]/]},
        typescript: {all: [/redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[2\]/]},
        go: {all: [/redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[2\]/]},
        scala: {all: [/redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[2\]/]},
        cpp: {all: [/redis\.call\(\s*['"]GET['"]\s*,\s*KEYS\[2\]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURSOR_TTL_S = 86_400


def cursor_key(connector_id: str) -> str:
    return f"cursor:{connector_id}"


def page_key(connector_id: str, page_token: str) -> str:
    return f"page:{connector_id}:{page_token}"


def load_cursor(connector_id: str) -> str | None:
    """The checkpoint the connector's next sync starts from, or None before its first page."""
    return r.get(cursor_key(connector_id))


def commit_page(connector_id: str, page_token: str, next_cursor: str) -> dict:
    """Record the page fetched with page_token as applied and move the cursor to next_cursor: {applied, cursor}."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if r.exists(page_key(connector_id, page_token)):
        return {"applied": False, "cursor": next_cursor}
    r.set(page_key(connector_id, page_token), "1", ex=CURSOR_TTL_S)
    r.set(cursor_key(connector_id), next_cursor, ex=CURSOR_TTL_S)
    return {"applied": True, "cursor": next_cursor}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] the page claim, KEYS[2] the cursor, ARGV[1] the next cursor. Neither key expires.
COMMIT_LUA = """
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
"""
commit = r.register_script(COMMIT_LUA)


def cursor_key(connector_id: str) -> str:
    return f"cursor:{connector_id}"


def page_key(connector_id: str, page_token: str) -> str:
    return f"page:{connector_id}:{page_token}"


def load_cursor(connector_id: str) -> str | None:
    """The checkpoint the connector's next sync starts from, or None before its first page."""
    return r.get(cursor_key(connector_id))


def commit_page(connector_id: str, page_token: str, next_cursor: str) -> dict:
    """Record the page fetched with page_token as applied and move the cursor to next_cursor: {applied, cursor}."""
    # The claim and the move happen in one step on the server: no other commit can land between them.
    applied, cursor = commit(keys=[page_key(connector_id, page_token), cursor_key(connector_id)], args=[next_cursor])
    return {"applied": applied == "1", "cursor": cursor}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const CURSOR_TTL_S = 86_400;

export interface Commit {
  applied: boolean;
  cursor: string;
}

export const cursorKey = (connectorId: string): string => \`cursor:\${connectorId}\`;
export const pageKey = (connectorId: string, pageToken: string): string => \`page:\${connectorId}:\${pageToken}\`;

/** The checkpoint the connector's next sync starts from, or null before its first page. */
export async function loadCursor(connectorId: string): Promise<string | null> {
  return redis.get(cursorKey(connectorId));
}

/** Record the page fetched with pageToken as applied and move the cursor to nextCursor. */
export async function commitPage(connectorId: string, pageToken: string, nextCursor: string): Promise<Commit> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if ((await redis.exists(pageKey(connectorId, pageToken))) === 1) return {applied: false, cursor: nextCursor};
  await redis.set(pageKey(connectorId, pageToken), '1', 'EX', CURSOR_TTL_S);
  await redis.set(cursorKey(connectorId), nextCursor, 'EX', CURSOR_TTL_S);
  return {applied: true, cursor: nextCursor};
}
`,
      solution: `import Redis from 'ioredis';

/** KEYS[1] the page claim, KEYS[2] the cursor, ARGV[1] the next cursor. Neither key expires. */
export const COMMIT_LUA = \`
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
\`;

interface LedgerRedis extends Redis {
  commitPageScript(pageKey: string, cursorKey: string, nextCursor: string): Promise<[string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('commitPageScript', {numberOfKeys: 2, lua: COMMIT_LUA});

export interface Commit {
  applied: boolean;
  cursor: string;
}

export const cursorKey = (connectorId: string): string => \`cursor:\${connectorId}\`;
export const pageKey = (connectorId: string, pageToken: string): string => \`page:\${connectorId}:\${pageToken}\`;

/** The checkpoint the connector's next sync starts from, or null before its first page. */
export async function loadCursor(connectorId: string): Promise<string | null> {
  return redis.get(cursorKey(connectorId));
}

/** Record the page fetched with pageToken as applied and move the cursor to nextCursor. */
export async function commitPage(connectorId: string, pageToken: string, nextCursor: string): Promise<Commit> {
  // The claim and the move happen in one step on the server: no other commit can land between them.
  const [applied, cursor] = await redis.commitPageScript(pageKey(connectorId, pageToken), cursorKey(connectorId), nextCursor);
  return {applied: applied === '1', cursor};
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

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const cursorTTL = 24 * time.Hour

// Commit is what a page commit did: whether the page was applied, and the cursor to continue from.
type Commit struct {
	Applied bool   \`json:"applied"\`
	Cursor  string \`json:"cursor"\`
}

func cursorKey(connectorID string) string { return "cursor:" + connectorID }

func pageKey(connectorID, pageToken string) string { return "page:" + connectorID + ":" + pageToken }

// loadCursor is the checkpoint the connector's next sync starts from ("" before its first page).
func loadCursor(ctx context.Context, connectorID string) (string, error) {
	cursor, err := rdb.Get(ctx, cursorKey(connectorID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return cursor, err
}

// commitPage records the page fetched with pageToken as applied and moves the cursor to nextCursor.
func commitPage(ctx context.Context, connectorID, pageToken, nextCursor string) (Commit, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	seen, err := rdb.Exists(ctx, pageKey(connectorID, pageToken)).Result()
	if err != nil {
		return Commit{}, err
	}
	if seen == 1 {
		return Commit{Applied: false, Cursor: nextCursor}, nil
	}
	if err := rdb.Set(ctx, pageKey(connectorID, pageToken), "1", cursorTTL).Err(); err != nil {
		return Commit{}, err
	}
	if err := rdb.Set(ctx, cursorKey(connectorID), nextCursor, cursorTTL).Err(); err != nil {
		return Commit{}, err
	}
	return Commit{Applied: true, Cursor: nextCursor}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commitScript: KEYS[1] the page claim, KEYS[2] the cursor, ARGV[1] the next cursor. Neither key expires.
var commitScript = redis.NewScript(\`
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
\`)

// Commit is what a page commit did: whether the page was applied, and the cursor to continue from.
type Commit struct {
	Applied bool   \`json:"applied"\`
	Cursor  string \`json:"cursor"\`
}

func cursorKey(connectorID string) string { return "cursor:" + connectorID }

func pageKey(connectorID, pageToken string) string { return "page:" + connectorID + ":" + pageToken }

// loadCursor is the checkpoint the connector's next sync starts from ("" before its first page).
func loadCursor(ctx context.Context, connectorID string) (string, error) {
	cursor, err := rdb.Get(ctx, cursorKey(connectorID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return cursor, err
}

// commitPage records the page fetched with pageToken as applied and moves the cursor to nextCursor.
func commitPage(ctx context.Context, connectorID, pageToken, nextCursor string) (Commit, error) {
	// The claim and the move happen in one step on the server: no other commit can land between them.
	reply, err := commitScript.Run(ctx, rdb, []string{pageKey(connectorID, pageToken), cursorKey(connectorID)}, nextCursor).StringSlice()
	if err != nil {
		return Commit{}, err
	}
	return Commit{Applied: reply[0] == "1", Cursor: reply[1]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object State {
  /** What a page commit did: whether the page was applied, and the cursor to continue from. */
  final case class Commit(applied: Boolean, cursor: String)

  val jedis = new JedisPooled("redis", 6379)

  val CursorTtlSeconds = 86400L

  def cursorKey(connectorId: String): String = s"cursor:$connectorId"
  def pageKey(connectorId: String, pageToken: String): String = s"page:$connectorId:$pageToken"

  /** The checkpoint the connector's next sync starts from, if it has one. */
  def loadCursor(connectorId: String): Option[String] = Option(jedis.get(cursorKey(connectorId)))

  /** Record the page fetched with pageToken as applied and move the cursor to nextCursor. */
  def commitPage(connectorId: String, pageToken: String, nextCursor: String): Commit = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if (jedis.exists(pageKey(connectorId, pageToken))) Commit(applied = false, nextCursor)
    else {
      jedis.set(pageKey(connectorId, pageToken), "1", SetParams.setParams().ex(CursorTtlSeconds))
      jedis.set(cursorKey(connectorId), nextCursor, SetParams.setParams().ex(CursorTtlSeconds))
      Commit(applied = true, nextCursor)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  /** What a page commit did: whether the page was applied, and the cursor to continue from. */
  final case class Commit(applied: Boolean, cursor: String)

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] the page claim, KEYS[2] the cursor, ARGV[1] the next cursor. Neither key expires. */
  val CommitLua: String =
    """if redis.call('SET', KEYS[1], '1', 'NX') then
      |  redis.call('SET', KEYS[2], ARGV[1])
      |  return {'1', ARGV[1]}
      |end
      |return {'0', redis.call('GET', KEYS[2]) or ''}
      |""".stripMargin

  def cursorKey(connectorId: String): String = s"cursor:$connectorId"
  def pageKey(connectorId: String, pageToken: String): String = s"page:$connectorId:$pageToken"

  /** The checkpoint the connector's next sync starts from, if it has one. */
  def loadCursor(connectorId: String): Option[String] = Option(jedis.get(cursorKey(connectorId)))

  /** Record the page fetched with pageToken as applied and move the cursor to nextCursor. */
  def commitPage(connectorId: String, pageToken: String, nextCursor: String): Commit = {
    // The claim and the move happen in one step on the server: no other commit can land between them.
    val keys = List(pageKey(connectorId, pageToken), cursorKey(connectorId)).asJava
    val reply = jedis.eval(CommitLua, keys, List(nextCursor).asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(String.valueOf)
    Commit(reply.head == "1", reply(1))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

const std::chrono::seconds kCursorTtl{86400};

// What a page commit did: whether the page was applied, and the cursor to continue from.
struct Commit {
  bool applied = false;
  std::string cursor;
};

std::string cursorKey(const std::string& connector_id) { return "cursor:" + connector_id; }

std::string pageKey(const std::string& connector_id, const std::string& page_token) { return "page:" + connector_id + ":" + page_token; }

// The checkpoint the connector's next sync starts from, or none before its first page.
std::optional<std::string> loadCursor(const std::string& connector_id) {
  const auto cursor = redis.get(cursorKey(connector_id));
  if (!cursor) return std::nullopt;
  return *cursor;
}

// Record the page fetched with page_token as applied and move the cursor to next_cursor.
Commit commitPage(const std::string& connector_id, const std::string& page_token, const std::string& next_cursor) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (redis.exists(pageKey(connector_id, page_token)) == 1) return Commit{false, next_cursor};
  redis.set(pageKey(connector_id, page_token), "1", kCursorTtl);
  redis.set(cursorKey(connector_id), next_cursor, kCursorTtl);
  return Commit{true, next_cursor};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] the page claim, KEYS[2] the cursor, ARGV[1] the next cursor. Neither key expires.
const std::string kCommitLua = R"lua(
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('SET', KEYS[2], ARGV[1])
  return {'1', ARGV[1]}
end
return {'0', redis.call('GET', KEYS[2]) or ''}
)lua";

// What a page commit did: whether the page was applied, and the cursor to continue from.
struct Commit {
  bool applied = false;
  std::string cursor;
};

std::string cursorKey(const std::string& connector_id) { return "cursor:" + connector_id; }

std::string pageKey(const std::string& connector_id, const std::string& page_token) { return "page:" + connector_id + ":" + page_token; }

// The checkpoint the connector's next sync starts from, or none before its first page.
std::optional<std::string> loadCursor(const std::string& connector_id) {
  const auto cursor = redis.get(cursorKey(connector_id));
  if (!cursor) return std::nullopt;
  return *cursor;
}

// Record the page fetched with page_token as applied and move the cursor to next_cursor.
Commit commitPage(const std::string& connector_id, const std::string& page_token, const std::string& next_cursor) {
  // The claim and the move happen in one step on the server: no other commit can land between them.
  std::vector<std::string> reply;
  redis.eval(kCommitLua, {pageKey(connector_id, page_token), cursorKey(connector_id)}, {next_cursor}, std::back_inserter(reply));
  return Commit{reply.at(0) == "1", reply.at(1)};
}
`,
    },
  },
  harness: {
    python: `DAY = 86_400


def _settled(probe, what):
    assert probe.fired, f"commit_page never touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_durable_cursor(ctx):
    m = ctx.load("state")
    first = m.commit_page("c-1", "t0", "t1")
    assert first == {"applied": True, "cursor": "t1"}, f"the first commit of page t0 answered {first}, expected applied with cursor t1"
    for key in ("cursor:c-1", "page:c-1:t0"):
        ttl = ctx.redis.ttl(key)
        assert ttl == -1, f"{key} has a TTL of {ttl} s (-2: missing): a checkpoint is not a cache, nothing can rebuild it but a full replay of the vendor"
    ctx.clock.advance(3 * DAY)
    assert m.load_cursor("c-1") == "t1", f"three quiet days later load_cursor gives {m.load_cursor('c-1')!r}: the next sync would restart from the vendor's first page"
    again = m.commit_page("c-1", "t0", "t1")
    assert again["applied"] is False, "three days later a re-fetch of page t0 was applied again: its claim expired"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    m.commit_page("c-1", "t0", "t1")
    # A second worker fetched page t1 too (a rebalance) and commits it while this worker is committing it.
    rival = ctx.redis_after("page:c-1:t1", lambda: m.commit_page("c-1", "t1", "t2"))
    mine = m.commit_page("c-1", "t1", "t2")
    theirs = _settled(rival, "page:c-1:t1")
    applied = [mine["applied"], theirs["applied"]]
    assert applied.count(True) == 1, f"two workers committing page t1 at once report applied {applied}: the page's records were applied {applied.count(True)} times. The claim and the move must be one script"
    loser = theirs if mine["applied"] else mine
    assert loser["cursor"] == "t2", f"the worker that lost the claim was told to continue from {loser['cursor']!r} while the winner moved the cursor to t2: it read the ledger between the claim and the move"
    assert m.load_cursor("c-1") == "t2", f"the cursor is {m.load_cursor('c-1')!r} after page t1, expected t2"


def check_replay_cursor(ctx):
    m = ctx.load("state")
    m.commit_page("c-1", "t0", "t1")
    m.commit_page("c-1", "t1", "t2")
    replay = m.commit_page("c-1", "t0", "t1")
    assert replay["applied"] is False, f"a replay of page t0 answered {replay}: it was applied twice"
    assert replay["cursor"] == "t2", f"a replay of page t0 answered cursor {replay['cursor']!r}: the worker would fetch from there and re-read page t1. A page already claimed answers the cursor the ledger holds (t2)"
    assert m.load_cursor("c-1") == "t2", f"a replayed page moved the cursor to {m.load_cursor('c-1')!r}, expected t2"
`,
    typescript: `const DAY = 86_400;

async function settled(probe, what: string) {
  assert(probe.fired, \`commitPage never touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_durable_cursor(ctx) {
  const m = ctx.load('state');
  const first = await m.commitPage('c-1', 't0', 't1');
  assert.deepStrictEqual(first, {applied: true, cursor: 't1'}, \`the first commit of page t0 answered \${JSON.stringify(first)}, expected applied with cursor t1\`);
  for (const key of ['cursor:c-1', 'page:c-1:t0']) {
    const ttl = ctx.redis.ttl(key);
    assert.equal(ttl, -1, \`\${key} has a TTL of \${ttl} s (-2: missing): a checkpoint is not a cache, nothing can rebuild it but a full replay of the vendor\`);
  }
  ctx.clock.advance(3 * DAY);
  assert.equal(await m.loadCursor('c-1'), 't1', "three quiet days later loadCursor must still give t1, or the next sync restarts from the vendor's first page");
  const again = await m.commitPage('c-1', 't0', 't1');
  assert.equal(again.applied, false, 'three days later a re-fetch of page t0 was applied again: its claim expired');
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  await m.commitPage('c-1', 't0', 't1');
  // A second worker fetched page t1 too (a rebalance) and commits it while this worker is committing it.
  const rival = ctx.redisAfter('page:c-1:t1', () => m.commitPage('c-1', 't1', 't2'));
  const mine = await m.commitPage('c-1', 't1', 't2');
  const theirs = await settled(rival, 'page:c-1:t1');
  const applied = [mine.applied, theirs.applied];
  assert.equal(applied.filter(Boolean).length, 1, \`two workers committing page t1 at once report applied \${JSON.stringify(applied)}: the page's records were applied more than once. The claim and the move must be one script\`);
  const loser = mine.applied ? theirs : mine;
  assert.equal(loser.cursor, 't2', \`the worker that lost the claim was told to continue from \${JSON.stringify(loser.cursor)} while the winner moved the cursor to t2: it read the ledger between the claim and the move\`);
  assert.equal(await m.loadCursor('c-1'), 't2', 'the cursor after page t1 must be t2');
}

export async function check_replay_cursor(ctx) {
  const m = ctx.load('state');
  await m.commitPage('c-1', 't0', 't1');
  await m.commitPage('c-1', 't1', 't2');
  const replay = await m.commitPage('c-1', 't0', 't1');
  assert.equal(replay.applied, false, \`a replay of page t0 answered \${JSON.stringify(replay)}: it was applied twice\`);
  assert.equal(replay.cursor, 't2', \`a replay of page t0 answered cursor \${JSON.stringify(replay.cursor)}: the worker would fetch from there and re-read page t1. A page already claimed answers the cursor the ledger holds (t2)\`);
  assert.equal(await m.loadCursor('c-1'), 't2', 'a replayed page must leave the cursor at t2');
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

var stateBg = context.Background()

func mustCommit(ctx *harness.Ctx, token, next string) Commit {
	result, err := commitPage(stateBg, "c-1", token, next)
	ctx.NoError(err, "commitPage(c-1, %s, %s) failed", token, next)
	return result
}

func mustLoad(ctx *harness.Ctx) string {
	cursor, err := loadCursor(stateBg, "c-1")
	ctx.NoError(err, "loadCursor(c-1) failed")
	return cursor
}

func CheckDurableCursor(ctx *harness.Ctx) {
	first := mustCommit(ctx, "t0", "t1")
	ctx.Equal(first, Commit{Applied: true, Cursor: "t1"}, "the first commit of page t0")
	for _, key := range []string{"cursor:c-1", "page:c-1:t0"} {
		ctx.Equal(ctx.Redis.TTL(key), int64(-1), "%s must have no TTL (-2: missing): a checkpoint is not a cache, nothing can rebuild it but a full replay of the vendor; its TTL", key)
	}
	ctx.Clock.Advance(3 * 86400)
	ctx.Equal(mustLoad(ctx), "t1", "three quiet days later loadCursor (or the next sync restarts from the vendor's first page)")
	again := mustCommit(ctx, "t0", "t1")
	ctx.Equal(again.Applied, false, "three days later a re-fetch of page t0 must not apply again (its claim expired); applied")
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	mustCommit(ctx, "t0", "t1")
	// A second worker fetched page t1 too (a rebalance) and commits it while this worker is committing it.
	rival := ctx.Redis.After("page:c-1:t1", func() any {
		result, err := commitPage(stateBg, "c-1", "t1", "t2")
		ctx.NoError(err, "the second worker's commitPage failed")
		return result
	})
	mine := mustCommit(ctx, "t1", "t2")
	ctx.Assert(rival.Fired, "commitPage never touched page:c-1:t1")
	ctx.Assert(rival.Err == nil, "the second worker's commitPage failed: %v", rival.Err)
	theirs, _ := rival.Result.(Commit)
	ctx.Assert(mine.Applied != theirs.Applied, "two workers committing page t1 at once report applied %v and %v: the page's records were applied twice (or not at all). The claim and the move must be one script", mine.Applied, theirs.Applied)
	loser := mine
	if mine.Applied {
		loser = theirs
	}
	ctx.Equal(loser.Cursor, "t2", "the worker that lost the claim must continue from the cursor the winner wrote (reading the ledger between the claim and the move gives the old one); its cursor")
	ctx.Equal(mustLoad(ctx), "t2", "the cursor after page t1")
}

func CheckReplayCursor(ctx *harness.Ctx) {
	mustCommit(ctx, "t0", "t1")
	mustCommit(ctx, "t1", "t2")
	replay := mustCommit(ctx, "t0", "t1")
	ctx.Equal(replay.Applied, false, "a replay of page t0 must not apply again; applied")
	ctx.Equal(replay.Cursor, "t2", "a replay of page t0 must answer the cursor the ledger holds, or the worker fetches from the cursor it passed in and re-reads page t1; the cursor")
	ctx.Equal(mustLoad(ctx), "t2", "a replayed page must leave the cursor")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

struct Rival {
  bool fired = false;
  Commit result;
  std::optional<std::string> err;
};

std::string loaded() { return loadCursor("c-1").value_or("(none)"); }

}  // namespace

void CheckDurableCursor(harness::Ctx& ctx) {
  const Commit first = commitPage("c-1", "t0", "t1");
  ctx.Assert(first.applied && first.cursor == "t1", "the first commit of page t0 answered applied %t cursor %q, expected applied with cursor t1", first.applied, first.cursor);
  for (const std::string key : {"cursor:c-1", "page:c-1:t0"}) {
    ctx.Equal(ctx.Redis.TTL(key), -1LL, "%s must have no TTL (-2: missing): a checkpoint is not a cache, nothing can rebuild it but a full replay of the vendor; its TTL", key);
  }
  ctx.Clock.Advance(3 * 86400);
  ctx.Equal(loaded(), "t1", "three quiet days later loadCursor (or the next sync restarts from the vendor's first page)");
  ctx.Equal(commitPage("c-1", "t0", "t1").applied, false, "three days later a re-fetch of page t0 must not apply again (its claim expired); applied");
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  commitPage("c-1", "t0", "t1");
  // A second worker fetched page t1 too (a rebalance) and commits it while this worker is committing it.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After("page:c-1:t1", [rival] {
    rival->fired = true;
    try {
      rival->result = commitPage("c-1", "t1", "t2");
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const Commit mine = commitPage("c-1", "t1", "t2");
  ctx.Assert(rival->fired, "commitPage never touched page:c-1:t1");
  ctx.Assert(!rival->err, "the second worker's commitPage threw: %s", rival->err.value_or(""));
  ctx.Assert(mine.applied != rival->result.applied,
             "two workers committing page t1 at once report applied %t and %t: the page's records were applied twice (or not at all). The claim and the move must be one script",
             mine.applied, rival->result.applied);
  const Commit& loser = mine.applied ? rival->result : mine;
  ctx.Equal(loser.cursor, "t2", "the worker that lost the claim must continue from the cursor the winner wrote (reading the ledger between the claim and the move gives the old one); its cursor");
  ctx.Equal(loaded(), "t2", "the cursor after page t1");
}

void CheckReplayCursor(harness::Ctx& ctx) {
  commitPage("c-1", "t0", "t1");
  commitPage("c-1", "t1", "t2");
  const Commit replay = commitPage("c-1", "t0", "t1");
  ctx.Equal(replay.applied, false, "a replay of page t0 must not apply again; applied");
  ctx.Equal(replay.cursor, "t2", "a replay of page t0 must answer the cursor the ledger holds, or the worker fetches from the cursor it passed in and re-reads page t1; the cursor");
  ctx.Equal(loaded(), "t2", "a replayed page must leave the cursor");
}
`,
  },
  hints: [
    "Commit a page, let three days of virtual time pass and load the cursor: it is gone. Replay an old page and the answer tells the worker to continue from that page's own next cursor.",
    "Both SETs carry a 24-hour TTL, so the checkpoint behaves like a cache. The EXISTS check and the two SETs are three round trips: a second worker can pass the same check in between, and the duplicate branch echoes the caller's cursor.",
    "Replace the body with one script: `if redis.call('SET', KEYS[1], '1', 'NX') then SET KEYS[2] ARGV[1]; return {'1', ARGV[1]} end; return {'0', GET KEYS[2]}`, with no TTL anywhere, and map the reply to `{applied, cursor}`.",
  ],
  debrief: `The commit is one script because the two facts it guards, "this page is applied at most once" and "the cursor is past only applied pages", cannot hold across round trips that another worker can interleave. Inside Redis the claim is the idempotence token and the reply is read in the same step, so a loser learns where the winner left the cursor. The TTL went because a checkpoint is the only record of how far the sync got: when it expires, nothing tells the worker where to resume. What this step leaves unbounded is the set of claims: production ledgers trim claims far behind the cursor with a compaction job, since a per-key expiry would reopen them.`,
};
