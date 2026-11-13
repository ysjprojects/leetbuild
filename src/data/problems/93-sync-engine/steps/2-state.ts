import type {Step} from '@/lib/types';

export const applyStateStep: Step = {
  id: 'state',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  title: 'One Lua apply: compare the base, take a server-wide revision',
  focus: ['sync', 'redis'],
  task: `## Task

**Starting point.** The starter is \`apply_change(doc_id, base_revision, content_hash, body, device)\`,
the apply every other step calls. It reads the head's revision (\`HGET doc:{id} revision\`), answers
\`{"status": "conflict", "revision": current}\` when that is not the base, and otherwise writes
revision \`current + 1\` into the head, keeps it under \`doc:{id}:r{n}\` and scores the document in
\`changes\`. It applies the demo pushes and hides three flaws.

**Failure mode the checks target.** A laptop and a phone push edits of the same revision a moment
apart and both are applied, so one edit vanishes. Two documents get the same revision, and a device
whose pull cursor sits on it never sees the second. Two devices that saved the same file conflict
with each other, and a device pushing back the body it just pulled mints a revision every round trip.

- The compare and every write run in **one Lua script** (\`register_script\`/\`eval\`), so no other
  client's command lands between them.
- Revisions come from **\`INCR rev:seq\`** (\`store.REVISION_KEY\`), server-wide and inside the
  script that writes them, so the change log orders every document and \`rev:seq\` moves only when
  a revision is written. Every revision is kept under \`doc:{id}:r{n}\`.
- A body whose hash equals the head's \`content_hash\` is **\`unchanged\`** whatever the base: no
  new revision, answered with the head's revision.
- Return \`{"status": "applied" | "unchanged" | "conflict", "revision"}\`: the new revision, or the
  head's when nothing was written.`,
  sequence: {
    participants: ['syncd', 'Redis'],
    messages: [
      {from: 'syncd', to: 'Redis', label: 'EVAL apply doc:{id} rev:seq changes · base, hash, body', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'same hash → unchanged · base ≠ revision → conflict', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'INCR rev:seq · HSET head · HSET doc:{id}:r{n} · ZADD changes', kind: 'sync'},
      {from: 'Redis', to: 'syncd', label: '{1, n} applied · {2, head} unchanged · {0, head} conflict', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-apply',
      title: 'Compares the base and writes in one script',
      detail:
        'The read of the head revision and the writes run in one Lua script (`register_script`/`defineCommand`/`NewScript`/`eval`); a separate `HGET` then `HSET` lets a second push of the same base land in between, and both apply.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/\br\.hget\(/, /\br\.hset\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/redis\.hget\(/, /redis\.hset\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/rdb\.HGet\(/, /rdb\.HSet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/jedis\.hget\(/, /jedis\.hset\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/redis\.hget\(/, /redis\.hset\(/],
        },
      },
    },
    {
      id: 'global-revision',
      title: 'Takes every revision from INCR rev:seq',
      detail:
        'The script takes the next revision with `INCR` on `rev:seq`, server-wide, and writes it in the same step, so no revision is committed after a higher one and `doc:{id}:r{n}` keeps every one. `current + 1` numbers each document on its own, so two documents share revisions and a cursor skips one of them.',
      match: {
        python: {all: [/redis\.call\(\s*['"]INCR['"]/], none: [/current\s*\+\s*1/]},
        typescript: {all: [/redis\.call\(\s*['"]INCR['"]/], none: [/current\s*\+\s*1/]},
        go: {all: [/redis\.call\(\s*['"]INCR['"]/], none: [/current\s*\+\s*1/]},
        scala: {all: [/redis\.call\(\s*['"]INCR['"]/], none: [/current\s*\+\s*1/]},
        cpp: {all: [/redis\.call\(\s*['"]INCR['"]/], none: [/current\s*\+\s*1/]},
      },
    },
    {
      id: 'same-content',
      title: 'A body the head already has is unchanged, not a new revision or a conflict',
      detail:
        'Before the base is compared, the script compares the change’s hash (`ARGV[3]`) with the head’s `content_hash` and answers `unchanged` at the head’s revision when they match, without moving `rev:seq`.',
      match: {
        python: {all: [/==\s*ARGV\[3\]|ARGV\[3\]\s*==/, /unchanged/]},
        typescript: {all: [/==\s*ARGV\[3\]|ARGV\[3\]\s*==/, /unchanged/]},
        go: {all: [/==\s*ARGV\[3\]|ARGV\[3\]\s*==/, /unchanged/]},
        scala: {all: [/==\s*ARGV\[3\]|ARGV\[3\]\s*==/, /unchanged/]},
        cpp: {all: [/==\s*ARGV\[3\]|ARGV\[3\]\s*==/, /unchanged/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from docsync import store  # doc_key, history_key, REVISION_KEY, CHANGES_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def apply_change(doc_id: str, base_revision: int, content_hash: str, body: str, device: str) -> dict:
    """Apply the change only against the revision the device edited: {"status", "revision"}."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    current = int(r.hget(store.doc_key(doc_id), "revision") or 0)
    if current != base_revision:
        return {"status": "conflict", "revision": current}
    revision = current + 1
    r.hset(store.doc_key(doc_id), mapping={"doc_id": doc_id, "revision": revision, "content_hash": content_hash, "body": body, "device": device})
    r.hset(store.history_key(doc_id, revision), mapping={"content_hash": content_hash, "body": body})
    r.zadd(store.CHANGES_KEY, {doc_id: revision})
    return {"status": "applied", "revision": revision}
`,
      solution: `import redis

from docsync import store  # doc_key, history_key, REVISION_KEY, CHANGES_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: doc:{id}, rev:seq, changes. ARGV: doc_id, base_revision, content_hash, body, device.
APPLY_LUA = """
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}
"""
apply_script = r.register_script(APPLY_LUA)

STATUSES = ("conflict", "applied", "unchanged")


def apply_change(doc_id: str, base_revision: int, content_hash: str, body: str, device: str) -> dict:
    """Apply the change only against the revision the device edited: {"status", "revision"}."""
    # One script: the compare, the next revision and every write run with no command in between.
    code, revision = apply_script(keys=[store.doc_key(doc_id), store.REVISION_KEY, store.CHANGES_KEY], args=[doc_id, base_revision, content_hash, body, device])
    return {"status": STATUSES[int(code)], "revision": int(revision)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {CHANGES_KEY, type Outcome, REVISION_KEY, docKey, historyKey} from 'docsync/store';

const redis = new Redis({host: 'redis', port: 6379});

/** Apply the change only against the revision the device edited. */
export async function applyChange(docId: string, baseRevision: number, contentHash: string, body: string, device: string): Promise<Outcome> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const current = Number((await redis.hget(docKey(docId), 'revision')) ?? 0);
  if (current !== baseRevision) return {status: 'conflict', revision: current};
  const revision = current + 1;
  await redis.hset(docKey(docId), {doc_id: docId, revision, content_hash: contentHash, body, device});
  await redis.hset(historyKey(docId, revision), {content_hash: contentHash, body});
  await redis.zadd(CHANGES_KEY, revision, docId);
  return {status: 'applied', revision};
}
`,
      solution: `import Redis from 'ioredis';

import {CHANGES_KEY, type Outcome, REVISION_KEY, docKey, historyKey} from 'docsync/store';

// KEYS: doc:{id}, rev:seq, changes. ARGV: doc_id, base_revision, content_hash, body, device.
export const APPLY_LUA = \`
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}
\`;

interface ApplyRedis extends Redis {
  applyChange(docKey: string, revisionKey: string, changesKey: string, ...args: (string | number)[]): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ApplyRedis;
redis.defineCommand('applyChange', {numberOfKeys: 3, lua: APPLY_LUA});

const STATUSES = ['conflict', 'applied', 'unchanged'];

/** Apply the change only against the revision the device edited. */
export async function applyChange(docId: string, baseRevision: number, contentHash: string, body: string, device: string): Promise<Outcome> {
  // One script: the compare, the next revision and every write run with no command in between.
  const [code, revision] = await redis.applyChange(docKey(docId), REVISION_KEY, CHANGES_KEY, docId, baseRevision, contentHash, body, device);
  return {status: STATUSES[Number(code)], revision: Number(revision)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"docsync/store" // store.DocKey, HistoryKey, RevisionKey, ChangesKey, Outcome
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// applyChange applies the change only against the revision the device edited.
func applyChange(ctx context.Context, docID string, baseRevision int64, contentHash, body, device string) (store.Outcome, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	current, _ := strconv.ParseInt(rdb.HGet(ctx, store.DocKey(docID), "revision").Val(), 10, 64)
	if current != baseRevision {
		return store.Outcome{Status: "conflict", Revision: current}, nil
	}
	revision := current + 1
	if err := rdb.HSet(ctx, store.DocKey(docID), map[string]any{"doc_id": docID, "revision": revision, "content_hash": contentHash, "body": body, "device": device}).Err(); err != nil {
		return store.Outcome{}, err
	}
	rdb.HSet(ctx, store.HistoryKey(docID, revision), map[string]any{"content_hash": contentHash, "body": body})
	rdb.ZAdd(ctx, store.ChangesKey, redis.Z{Score: float64(revision), Member: docID})
	return store.Outcome{Status: "applied", Revision: revision}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"docsync/store" // store.DocKey, HistoryKey, RevisionKey, ChangesKey, Outcome
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: doc:{id}, rev:seq, changes. ARGV: doc_id, base_revision, content_hash, body, device.
const applyLua = \`
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}
\`

var (
	applyScript = redis.NewScript(applyLua)
	statuses    = []string{"conflict", "applied", "unchanged"}
)

// applyChange applies the change only against the revision the device edited.
func applyChange(ctx context.Context, docID string, baseRevision int64, contentHash, body, device string) (store.Outcome, error) {
	// One script: the compare, the next revision and every write run with no command in between.
	keys := []string{store.DocKey(docID), store.RevisionKey, store.ChangesKey}
	reply, err := applyScript.Run(ctx, rdb, keys, docID, baseRevision, contentHash, body, device).Int64Slice()
	if err != nil {
		return store.Outcome{}, err
	}
	return store.Outcome{Status: statuses[reply[0]], Revision: reply[1]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import docsync.Store // Store.docKey, historyKey, RevisionKey, ChangesKey, Outcome

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Apply the change only against the revision the device edited. */
  def applyChange(docId: String, baseRevision: Long, contentHash: String, body: String, device: String): Store.Outcome = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val current = Option(jedis.hget(Store.docKey(docId), "revision")).map(_.toLong).getOrElse(0L)
    if (current != baseRevision) Store.Outcome("conflict", current)
    else {
      val revision = current + 1
      jedis.hset(Store.docKey(docId), Map("doc_id" -> docId, "revision" -> revision.toString, "content_hash" -> contentHash, "body" -> body, "device" -> device).asJava)
      jedis.hset(Store.historyKey(docId, revision), Map("content_hash" -> contentHash, "body" -> body).asJava)
      jedis.zadd(Store.ChangesKey, revision.toDouble, docId)
      Store.Outcome("applied", revision)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import docsync.Store // Store.docKey, historyKey, RevisionKey, ChangesKey, Outcome

object State {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS: doc:{id}, rev:seq, changes. ARGV: doc_id, base_revision, content_hash, body, device.
  val ApplyLua: String = """
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}
"""

  private val Statuses = Vector("conflict", "applied", "unchanged")

  /** Apply the change only against the revision the device edited. */
  def applyChange(docId: String, baseRevision: Long, contentHash: String, body: String, device: String): Store.Outcome = {
    // One script: the compare, the next revision and every write run with no command in between.
    val keys = List(Store.docKey(docId), Store.RevisionKey, Store.ChangesKey).asJava
    val args = List(docId, baseRevision.toString, contentHash, body, device).asJava
    val reply = jedis.eval(ApplyLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]]
    Store.Outcome(Statuses(reply.get(0).toInt), reply.get(1).longValue)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "docsync/store.h"  // store::docKey, historyKey, kRevisionKey, kChangesKey, Outcome

sw::redis::Redis redis("tcp://redis:6379");

// Apply the change only against the revision the device edited.
store::Outcome applyChange(const std::string& doc_id, long long base_revision, const std::string& content_hash, const std::string& body,
                           const std::string& device) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto raw = redis.hget(store::docKey(doc_id), "revision");
  const long long current = raw ? std::stoll(*raw) : 0;
  if (current != base_revision) return store::Outcome{"conflict", current};
  const long long revision = current + 1;
  redis.hset(store::docKey(doc_id), {{"doc_id", doc_id}, {"revision", std::to_string(revision)}, {"content_hash", content_hash}, {"body", body}, {"device", device}});
  redis.hset(store::historyKey(doc_id, revision), {{"content_hash", content_hash}, {"body", body}});
  redis.zadd(store::kChangesKey, doc_id, static_cast<double>(revision));
  return store::Outcome{"applied", revision};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "docsync/store.h"  // store::docKey, historyKey, kRevisionKey, kChangesKey, Outcome

sw::redis::Redis redis("tcp://redis:6379");

// KEYS: doc:{id}, rev:seq, changes. ARGV: doc_id, base_revision, content_hash, body, device.
const std::string kApplyLua = R"(
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if redis.call('HGET', KEYS[1], 'content_hash') == ARGV[3] then return {2, current} end
if current ~= tonumber(ARGV[2]) then return {0, current} end
local revision = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'doc_id', ARGV[1], 'revision', tostring(revision), 'content_hash', ARGV[3], 'body', ARGV[4], 'device', ARGV[5])
redis.call('HSET', KEYS[1] .. ':r' .. revision, 'content_hash', ARGV[3], 'body', ARGV[4])
redis.call('ZADD', KEYS[3], revision, ARGV[1])
return {1, revision}
)";

// Apply the change only against the revision the device edited.
store::Outcome applyChange(const std::string& doc_id, long long base_revision, const std::string& content_hash, const std::string& body,
                           const std::string& device) {
  // One script: the compare, the next revision and every write run with no command in between.
  const std::vector<std::string> keys = {store::docKey(doc_id), store::kRevisionKey, store::kChangesKey};
  const std::vector<std::string> args = {doc_id, std::to_string(base_revision), content_hash, body, device};
  std::vector<long long> reply;
  redis.eval(kApplyLua, keys.begin(), keys.end(), args.begin(), args.end(), std::back_inserter(reply));
  static const char* kStatuses[] = {"conflict", "applied", "unchanged"};
  return store::Outcome{kStatuses[reply.at(0)], reply.at(1)};
}
`,
    },
  },
  harness: {
    python: `from docsync import store


def _apply(m, doc_id, base, body, device="laptop"):
    return m.apply_change(doc_id, base, store.content_hash(body), body, device)


def check_atomic_apply(ctx):
    m = ctx.load("state")
    first = _apply(m, "d-1", 0, "draft agenda")
    assert first == {"status": "applied", "revision": 1}, f"the first apply of d-1 answered {first}, expected applied at revision 1"
    # The phone's edit of revision 1 lands while the laptop's edit of revision 1 is being applied.
    rival = ctx.redis_after("doc:d-1", lambda: _apply(m, "d-1", 1, "agenda: budget", "phone"))
    mine = _apply(m, "d-1", 1, "agenda: offsite", "laptop")
    assert rival.fired, "the apply never touched doc:d-1"
    if rival.error is not None:
        raise rival.error
    theirs = rival.result
    statuses = sorted([theirs["status"], mine["status"]])
    assert statuses == ["applied", "conflict"], f"two edits of revision 1 landed together and were answered {theirs} (phone) and {mine} (laptop): exactly one may apply, the other is a conflict. Run the compare and the writes in one script"
    winner = "agenda: budget" if theirs["status"] == "applied" else "agenda: offsite"
    head = store.head("d-1")
    assert head["body"] == winner, f"d-1 reads {head['body']!r}, expected the applied edit {winner!r}"


def check_global_revision(ctx):
    m = ctx.load("state")
    a = _apply(m, "d-1", 0, "groceries")
    b = _apply(m, "d-2", 0, "call the plumber")
    c = _apply(m, "d-1", a["revision"], "groceries: milk")
    revisions = [a["revision"], b["revision"], c["revision"]]
    assert revisions == [1, 2, 3], f"three applies across two documents got revisions {revisions}: when d-2 shares a revision with d-1, a device whose cursor is on it never sees one of them. Take every revision from INCR rev:seq"
    assert ctx.redis.get("rev:seq") == "3", f"rev:seq is {ctx.redis.get('rev:seq')!r} after three applies, expected '3'"
    log = ctx.redis.zrange("changes", 0, -1, withscores=True)
    assert log == [("d-2", 2.0), ("d-1", 3.0)], f"the change log holds {log}, expected d-2 at 2 and d-1 at 3"
    kept = [ctx.redis.hget(f"doc:d-1:r{n}", "body") for n in (1, 3)]
    assert kept == ["groceries", "groceries: milk"], f"doc:d-1:r1 and doc:d-1:r3 hold bodies {kept}: keep every revision under doc:{{id}}:r{{n}}, a merge reads the base a device edited from it"
    assert ctx.redis.hget("doc:d-1:r3", "content_hash") == store.content_hash("groceries: milk"), "doc:d-1:r3 must keep the revision's content_hash"
    # Another worker applies d-3 right after this apply takes rev:seq.
    rival = ctx.redis_after("rev:seq", lambda: (_apply(m, "d-3", 0, "concert tickets", "phone"), ctx.redis.zscore("changes", "d-2")))
    mine = _apply(m, "d-2", b["revision"], "call the plumber at 9")
    assert rival.fired, "the apply never touched rev:seq"
    if rival.error is not None:
        raise rival.error
    theirs, seen = rival.result
    assert seen == mine["revision"] and theirs["revision"] > mine["revision"], f"d-3 committed revision {theirs['revision']} while d-2's revision {mine['revision']} was not yet in the change log (d-2 scored {seen}): a device pulling from cursor {theirs['revision']} never sees d-2. Take the revision inside the script that writes it"


def check_same_content(ctx):
    m = ctx.load("state")
    first = _apply(m, "d-1", 0, "flight AF123, seat 14C", "laptop")
    # The phone saved the same confirmation before it heard of the laptop's revision.
    twin = _apply(m, "d-1", 0, "flight AF123, seat 14C", "phone")
    assert twin == {"status": "unchanged", "revision": first["revision"]}, f"the phone pushed the body the head already has (base 0) and got {twin}: identical edits converge. Answer unchanged at the head's revision"
    echo = _apply(m, "d-1", first["revision"], "flight AF123, seat 14C", "laptop")
    assert echo == {"status": "unchanged", "revision": first["revision"]}, f"the laptop pushed back the body it just wrote and got {echo}: an echo must not mint a revision every device downloads again"
    assert store.head("d-1")["revision"] == first["revision"], f"d-1 moved to revision {store.head('d-1')['revision']} without a change of content"
    assert ctx.redis.get("rev:seq") == str(first["revision"]), f"rev:seq is {ctx.redis.get('rev:seq')!r} after one applied revision and two unchanged pushes: rev:seq moves only when a revision is written"
    changed = _apply(m, "d-1", first["revision"], "flight AF123, seat 15A")
    assert changed["status"] == "applied" and changed["revision"] > first["revision"], f"a real edit after the echoes must apply, got {changed}"
`,
    typescript: `function state(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/docsync/store.ts')};
}

const apply = (m, store, docId: string, base: number, body: string, device = 'laptop') => m.applyChange(docId, base, store.contentHash(body), body, device);

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_atomic_apply(ctx) {
  const {m, store} = state(ctx);
  const first = await apply(m, store, 'd-1', 0, 'draft agenda');
  assert.deepStrictEqual(first, {status: 'applied', revision: 1}, \`the first apply of d-1 answered \${JSON.stringify(first)}, expected applied at revision 1\`);
  // The phone's edit of revision 1 lands while the laptop's edit of revision 1 is being applied.
  const rival = ctx.redisAfter('doc:d-1', () => apply(m, store, 'd-1', 1, 'agenda: budget', 'phone'));
  const mine = await apply(m, store, 'd-1', 1, 'agenda: offsite', 'laptop');
  const theirs = await settled(rival, 'doc:d-1');
  const statuses = [theirs.status, mine.status].sort();
  assert.deepStrictEqual(statuses, ['applied', 'conflict'], \`two edits of revision 1 landed together and were answered \${JSON.stringify(theirs)} (phone) and \${JSON.stringify(mine)} (laptop): exactly one may apply, the other is a conflict. Run the compare and the writes in one script\`);
  const winner = theirs.status === 'applied' ? 'agenda: budget' : 'agenda: offsite';
  const head = await store.head('d-1');
  assert.equal(head.body, winner, \`d-1 reads \${JSON.stringify(head.body)}, expected the applied edit\`);
}

export async function check_global_revision(ctx) {
  const {m, store} = state(ctx);
  const a = await apply(m, store, 'd-1', 0, 'groceries');
  const b = await apply(m, store, 'd-2', 0, 'call the plumber');
  const c = await apply(m, store, 'd-1', a.revision, 'groceries: milk');
  const revisions = [a.revision, b.revision, c.revision];
  assert.deepStrictEqual(revisions, [1, 2, 3], \`three applies across two documents got revisions \${JSON.stringify(revisions)}: when d-2 shares a revision with d-1, a device whose cursor is on it never sees one of them. Take every revision from INCR rev:seq\`);
  assert.equal(ctx.redis.get('rev:seq'), '3', \`rev:seq is \${JSON.stringify(ctx.redis.get('rev:seq'))} after three applies, expected '3'\`);
  const log = ctx.redis.zrange('changes', 0, -1, 'WITHSCORES');
  assert.deepStrictEqual(log, ['d-2', '2', 'd-1', '3'], \`the change log holds \${JSON.stringify(log)}, expected d-2 at 2 and d-1 at 3\`);
  const kept = [ctx.redis.hget('doc:d-1:r1', 'body'), ctx.redis.hget('doc:d-1:r3', 'body')];
  assert.deepStrictEqual(kept, ['groceries', 'groceries: milk'], \`doc:d-1:r1 and doc:d-1:r3 hold bodies \${JSON.stringify(kept)}: keep every revision under doc:{id}:r{n}, a merge reads the base a device edited from it\`);
  assert.equal(ctx.redis.hget('doc:d-1:r3', 'content_hash'), store.contentHash('groceries: milk'), "doc:d-1:r3 must keep the revision's content_hash");
  // Another worker applies d-3 right after this apply takes rev:seq.
  const rival = ctx.redisAfter('rev:seq', async () => {
    const theirs = await apply(m, store, 'd-3', 0, 'concert tickets', 'phone');
    return {theirs, seen: ctx.redis.zscore('changes', 'd-2')};
  });
  const mine = await apply(m, store, 'd-2', b.revision, 'call the plumber at 9');
  const {theirs, seen} = await settled(rival, 'rev:seq');
  assert(Number(seen) === mine.revision && theirs.revision > mine.revision, \`d-3 committed revision \${theirs.revision} while d-2's revision \${mine.revision} was not yet in the change log (d-2 scored \${seen}): a device pulling from cursor \${theirs.revision} never sees d-2. Take the revision inside the script that writes it\`);
}

export async function check_same_content(ctx) {
  const {m, store} = state(ctx);
  const first = await apply(m, store, 'd-1', 0, 'flight AF123, seat 14C', 'laptop');
  // The phone saved the same confirmation before it heard of the laptop's revision.
  const twin = await apply(m, store, 'd-1', 0, 'flight AF123, seat 14C', 'phone');
  assert.deepStrictEqual(twin, {status: 'unchanged', revision: first.revision}, \`the phone pushed the body the head already has (base 0) and got \${JSON.stringify(twin)}: identical edits converge. Answer unchanged at the head's revision\`);
  const echo = await apply(m, store, 'd-1', first.revision, 'flight AF123, seat 14C', 'laptop');
  assert.deepStrictEqual(echo, {status: 'unchanged', revision: first.revision}, \`the laptop pushed back the body it just wrote and got \${JSON.stringify(echo)}: an echo must not mint a revision every device downloads again\`);
  assert.equal((await store.head('d-1')).revision, first.revision, 'd-1 moved to a new revision without a change of content');
  assert.equal(ctx.redis.get('rev:seq'), String(first.revision), \`rev:seq is \${JSON.stringify(ctx.redis.get('rev:seq'))} after one applied revision and two unchanged pushes: rev:seq moves only when a revision is written\`);
  const changed = await apply(m, store, 'd-1', first.revision, 'flight AF123, seat 15A');
  assert(changed.status === 'applied' && changed.revision > first.revision, \`a real edit after the echoes must apply, got \${JSON.stringify(changed)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"docsync/store"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateApply(ctx *harness.Ctx, docID string, base int64, body, device string) store.Outcome {
	outcome, err := applyChange(stateBg, docID, base, store.ContentHash(body), body, device)
	ctx.NoError(err, "applyChange(%s, %d) failed", docID, base)
	return outcome
}

func CheckAtomicApply(ctx *harness.Ctx) {
	first := stateApply(ctx, "d-1", 0, "draft agenda", "laptop")
	ctx.Equal(first, store.Outcome{Status: "applied", Revision: 1}, "the first apply of d-1")
	// The phone's edit of revision 1 lands while the laptop's edit of revision 1 is being applied.
	rival := ctx.Redis.After("doc:d-1", func() any {
		outcome, err := applyChange(stateBg, "d-1", 1, store.ContentHash("agenda: budget"), "agenda: budget", "phone")
		if err != nil {
			panic(err)
		}
		return outcome
	})
	mine := stateApply(ctx, "d-1", 1, "agenda: offsite", "laptop")
	ctx.Assert(rival.Fired, "the apply never touched doc:d-1")
	ctx.Assert(rival.Err == nil, "the phone's apply failed: %v", rival.Err)
	theirs, _ := rival.Result.(store.Outcome)
	applied := (theirs.Status == "applied") != (mine.Status == "applied")
	ctx.Assert(applied && (theirs.Status == "conflict" || mine.Status == "conflict"),
		"two edits of revision 1 landed together and were answered %+v (phone) and %+v (laptop): exactly one may apply, the other is a conflict. Run the compare and the writes in one script", theirs, mine)
	winner := "agenda: offsite"
	if theirs.Status == "applied" {
		winner = "agenda: budget"
	}
	ctx.Equal(store.Head(stateBg, "d-1").Body, winner, "d-1 must hold the applied edit; its body")
}

func CheckGlobalRevision(ctx *harness.Ctx) {
	a := stateApply(ctx, "d-1", 0, "groceries", "laptop")
	b := stateApply(ctx, "d-2", 0, "call the plumber", "laptop")
	c := stateApply(ctx, "d-1", a.Revision, "groceries: milk", "laptop")
	revisions := []int64{a.Revision, b.Revision, c.Revision}
	ctx.Equal(revisions, []int64{1, 2, 3}, "three applies across two documents: when d-2 shares a revision with d-1, a device whose cursor is on it never sees one of them. Take every revision from INCR rev:seq; the revisions")
	seq, _ := ctx.Redis.Get("rev:seq")
	ctx.Equal(seq, "3", "rev:seq after three applies")
	ctx.Equal(ctx.Redis.ZRangeWithScores("changes", 0, -1), []harness.Z{{Member: "d-2", Score: 2}, {Member: "d-1", Score: 3}}, "the change log (d-2 at 2, d-1 at 3)")
	r1, _ := ctx.Redis.HGet("doc:d-1:r1", "body")
	r3, _ := ctx.Redis.HGet("doc:d-1:r3", "body")
	ctx.Equal([]string{r1, r3}, []string{"groceries", "groceries: milk"}, "keep every revision under doc:{id}:r{n}, a merge reads the base a device edited from it; the bodies of doc:d-1:r1 and doc:d-1:r3")
	r3Hash, _ := ctx.Redis.HGet("doc:d-1:r3", "content_hash")
	ctx.Equal(r3Hash, store.ContentHash("groceries: milk"), "doc:d-1:r3 must keep the revision's content_hash; its content_hash")
	// Another worker applies d-3 right after this apply takes rev:seq.
	type rivalResult struct {
		theirs store.Outcome
		seen   float64
	}
	rival := ctx.Redis.After("rev:seq", func() any {
		theirs, err := applyChange(stateBg, "d-3", 0, store.ContentHash("concert tickets"), "concert tickets", "phone")
		if err != nil {
			panic(err)
		}
		seen, _ := ctx.Redis.ZScore("changes", "d-2")
		return rivalResult{theirs, seen}
	})
	mine := stateApply(ctx, "d-2", b.Revision, "call the plumber at 9", "laptop")
	ctx.Assert(rival.Fired, "the apply never touched rev:seq")
	ctx.Assert(rival.Err == nil, "d-3's apply failed: %v", rival.Err)
	got, _ := rival.Result.(rivalResult)
	ctx.Assert(got.seen == float64(mine.Revision) && got.theirs.Revision > mine.Revision,
		"d-3 committed revision %d while d-2's revision %d was not yet in the change log (d-2 scored %v): a device pulling from cursor %d never sees d-2. Take the revision inside the script that writes it",
		got.theirs.Revision, mine.Revision, got.seen, got.theirs.Revision)
}

func CheckSameContent(ctx *harness.Ctx) {
	first := stateApply(ctx, "d-1", 0, "flight AF123, seat 14C", "laptop")
	// The phone saved the same confirmation before it heard of the laptop's revision.
	twin := stateApply(ctx, "d-1", 0, "flight AF123, seat 14C", "phone")
	ctx.Equal(twin, store.Outcome{Status: "unchanged", Revision: first.Revision}, "the phone pushed the body the head already has (base 0): identical edits converge, answered unchanged at the head's revision")
	echo := stateApply(ctx, "d-1", first.Revision, "flight AF123, seat 14C", "laptop")
	ctx.Equal(echo, store.Outcome{Status: "unchanged", Revision: first.Revision}, "the laptop pushed back the body it just wrote: an echo must not mint a revision every device downloads again")
	ctx.Equal(store.Head(stateBg, "d-1").Revision, first.Revision, "d-1 must stay at its revision without a change of content; its revision")
	seq, _ := ctx.Redis.Get("rev:seq")
	ctx.Equal(seq, fmt.Sprint(first.Revision), "rev:seq moves only when a revision is written; rev:seq after one applied revision and two unchanged pushes")
	changed := stateApply(ctx, "d-1", first.Revision, "flight AF123, seat 15A", "laptop")
	ctx.Assert(changed.Status == "applied" && changed.Revision > first.Revision, "a real edit after the echoes must apply, got %+v", changed)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>

#include "docsync/store.h"

namespace {

store::Outcome stateApply(const std::string& doc_id, long long base, const std::string& body, const std::string& device = "laptop") {
  return applyChange(doc_id, base, store::contentHash(body), body, device);
}

std::string outcomeText(const store::Outcome& o) { return o.status + " at " + std::to_string(o.revision); }

}  // namespace

void CheckAtomicApply(harness::Ctx& ctx) {
  const store::Outcome first = stateApply("d-1", 0, "draft agenda");
  ctx.Assert(first.status == "applied" && first.revision == 1, "the first apply of d-1 answered %s, expected applied at revision 1", outcomeText(first));
  // The phone's edit of revision 1 lands while the laptop's edit of revision 1 is being applied.
  std::optional<store::Outcome> theirs;
  std::optional<std::string> failed;
  ctx.Redis.After("doc:d-1", [&] {
    try {
      theirs = stateApply("d-1", 1, "agenda: budget", "phone");
    } catch (const std::exception& e) {
      failed = e.what();
    }
  });
  const store::Outcome mine = stateApply("d-1", 1, "agenda: offsite", "laptop");
  ctx.Assert(!failed, "the phone's apply failed: %s", failed.value_or(""));
  ctx.Assert(theirs.has_value(), "the apply never touched doc:d-1");
  const bool one = (theirs->status == "applied") != (mine.status == "applied");
  ctx.Assert(one && (theirs->status == "conflict" || mine.status == "conflict"),
             "two edits of revision 1 landed together and were answered %s (phone) and %s (laptop): exactly one may apply, the other is a conflict. Run the compare and the writes in one script",
             outcomeText(*theirs), outcomeText(mine));
  const std::string winner = theirs->status == "applied" ? "agenda: budget" : "agenda: offsite";
  ctx.Equal(store::head("d-1")->body, winner, "d-1 must hold the applied edit; its body");
}

void CheckGlobalRevision(harness::Ctx& ctx) {
  const store::Outcome a = stateApply("d-1", 0, "groceries");
  const store::Outcome b = stateApply("d-2", 0, "call the plumber");
  const store::Outcome c = stateApply("d-1", a.revision, "groceries: milk");
  ctx.Assert(a.revision == 1 && b.revision == 2 && c.revision == 3,
             "three applies across two documents got revisions %d, %d, %d: when d-2 shares a revision with d-1, a device whose cursor is on it never sees one of them. Take every revision from INCR rev:seq",
             a.revision, b.revision, c.revision);
  ctx.Equal(ctx.Redis.Get("rev:seq"), std::optional<std::string>("3"), "rev:seq after three applies");
  const auto log = ctx.Redis.ZRangeWithScores("changes", 0, -1);
  ctx.Assert(log.size() == 2 && log[0].Member == "d-2" && log[0].Score == 2 && log[1].Member == "d-1" && log[1].Score == 3,
             "the change log must hold d-2 at 2 and d-1 at 3, got %v", log);
  ctx.Assert(ctx.Redis.HGet("doc:d-1:r1", "body") == std::optional<std::string>("groceries") && ctx.Redis.HGet("doc:d-1:r3", "body") == std::optional<std::string>("groceries: milk"),
             "doc:d-1:r1 and doc:d-1:r3 must hold the bodies of revisions 1 and 3: keep every revision under doc:{id}:r{n}, a merge reads the base a device edited from it");
  ctx.Equal(ctx.Redis.HGet("doc:d-1:r3", "content_hash"), std::optional<std::string>(store::contentHash("groceries: milk")), "doc:d-1:r3 must keep the revision's content_hash; its content_hash");
  // Another worker applies d-3 right after this apply takes rev:seq.
  std::optional<store::Outcome> theirs;
  std::optional<double> seen;
  std::optional<std::string> failed;
  ctx.Redis.After("rev:seq", [&] {
    try {
      theirs = stateApply("d-3", 0, "concert tickets", "phone");
      seen = ctx.Redis.ZScore("changes", "d-2");
    } catch (const std::exception& e) {
      failed = e.what();
    }
  });
  const store::Outcome mine = stateApply("d-2", b.revision, "call the plumber at 9");
  ctx.Assert(!failed, "d-3's apply failed: %s", failed.value_or(""));
  ctx.Assert(theirs.has_value(), "the apply never touched rev:seq");
  ctx.Assert(seen == std::optional<double>(static_cast<double>(mine.revision)) && theirs->revision > mine.revision,
             "d-3 committed revision %d while d-2's revision %d was not yet in the change log (d-2 scored %v): a device pulling from cursor %d never sees d-2. Take the revision inside the script that writes it",
             theirs->revision, mine.revision, seen.value_or(0), theirs->revision);
}

void CheckSameContent(harness::Ctx& ctx) {
  const store::Outcome first = stateApply("d-1", 0, "flight AF123, seat 14C", "laptop");
  // The phone saved the same confirmation before it heard of the laptop's revision.
  const store::Outcome twin = stateApply("d-1", 0, "flight AF123, seat 14C", "phone");
  ctx.Assert(twin.status == "unchanged" && twin.revision == first.revision,
             "the phone pushed the body the head already has (base 0) and got %s: identical edits converge. Answer unchanged at the head's revision", outcomeText(twin));
  const store::Outcome echo = stateApply("d-1", first.revision, "flight AF123, seat 14C", "laptop");
  ctx.Assert(echo.status == "unchanged" && echo.revision == first.revision,
             "the laptop pushed back the body it just wrote and got %s: an echo must not mint a revision every device downloads again", outcomeText(echo));
  ctx.Equal(store::head("d-1")->revision, first.revision, "d-1 must stay at its revision without a change of content; its revision");
  ctx.Equal(ctx.Redis.Get("rev:seq"), std::optional<std::string>(std::to_string(first.revision)), "rev:seq moves only when a revision is written; rev:seq after one applied revision and two unchanged pushes");
  const store::Outcome changed = stateApply("d-1", first.revision, "flight AF123, seat 15A");
  ctx.Assert(changed.status == "applied" && changed.revision > first.revision, "a real edit after the echoes must apply, got %s", outcomeText(changed));
}
`,
  },
  hints: [
    'Fire two pushes of the same base at once: both answer applied and one edit is gone. Create two documents: both are at revision 1. Push back an unchanged body: the revision climbs anyway.',
    'The `HGET` and the `HSET`s are separate commands, so another push can land between them. `current + 1` numbers each document on its own, and nothing looks at `content_hash` before a revision is minted.',
    'Move the logic into one Lua script: compare `ARGV[3]` with the head’s `content_hash` (`{2, current}`), the base with the revision (`{0, current}`), then `INCR rev:seq`, `HSET` head and `doc:{id}:r{n}`, `ZADD changes`.',
  ],
  debrief: `Redis runs a script without interleaving another client's command, so putting the compare and every write inside one script turns check-then-write into a single step, and the only answer a racing push can get is a conflict. A server-wide revision makes the change log a total order, which is what lets a pull cursor be a single number. Comparing content before the base is what keeps identical edits and echoes from becoming conflicts or churn, since the base says what a device saw while the hash says what it wants. A larger system shards documents across Redis nodes with hash tags, keeps the counter per shard with a shard-qualified cursor, and trims kept revisions once every device has pulled past them.`,
};
