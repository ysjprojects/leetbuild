import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis sync cursors that survive restarts',
  concept: 'redis',
  file: 'state',
  focus: ['hub', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a page finishes, the cursor moves and the next run
resumes from the right place. It survives exactly one demo. Find the flaws, fix them, and prove the
fix.

Implement \`commit_page\` — the call a sync worker makes when one page has been fetched **and
processed** — and \`load_cursor\`, the read the next run starts from:

- The cursor is a **durable checkpoint per connector**, not a cache: key
  \`connector:{connector_id}:cursor\`, written with a plain \`SET\` and **no TTL at all**. A connector
  that goes quiet for a week must resume where it stopped, not replay three months of the vendor's
  history.
- A page is identified by \`(connector_id, page_token)\` and gets its **own claim key**:
  \`page:{connector_id}:{page_token}\`. A re-fetch of a page — after a crash, a retry or a rebalance —
  must not apply it twice.
- The claim and the cursor move happen in **one atomic Lua \`EVAL\`**: \`SET … NX\` on the page key
  first, and the \`SET\` of the new cursor only when the claim actually succeeded. The draft writes
  the cursor **before** it claims the page, so a crash between the fetch and the write skips a page
  and the bare \`SET\` race loses a cursor move under concurrency.
- Return \`{applied, cursor}\`: \`applied\` is false for a page that was already committed, and
  \`cursor\` is the checkpoint the caller can log. A worker that decides "already seen" from a
  client-side read is exactly the race the draft has.

**Failure mode the checks target.** The TTL is the silent one: \`EX\` 86 400 looks like hygiene, and
it means a quiet connector silently restarts from the beginning of history tomorrow, re-fetching and
re-billing pages the platform has already processed. The write-order is the loud one: advancing the
cursor before the page is committed turns any crash into skipped data, which is worse than a
re-fetch because nothing will ever notice.`,
  sequence: {
    participants: ['Sync worker', 'Redis', 'Second worker'],
    messages: [
      {from: 'Sync worker', to: 'Redis', label: 'EVAL SET page:conn-1:p-42 · NX', kind: 'sync'},
      {from: 'Redis', to: 'Sync worker', label: '1 · claim is fresh', kind: 'reply'},
      {from: 'Sync worker', to: 'Redis', label: 'EVAL SET connector:conn-1:cursor p-43', kind: 'sync'},
      {from: 'Redis', to: 'Sync worker', label: '{1, p-43}', kind: 'reply'},
      {from: 'Second worker', to: 'Redis', label: 'EVAL same page after a crash', kind: 'sync'},
      {from: 'Redis', to: 'Second worker', label: '{0, p-43} · page re-fetched, cursor unchanged', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cursor-read',
      title: 'Reads the connector cursor',
      detail: "Keep `load_cursor` as the single read of the connector's checkpoint.",
      match: {
        python: {all: [/def load_cursor\(/]},
        typescript: {all: [/loadCursor\(/]},
        go: {all: [/func loadCursor\(/]},
        scala: {all: [/def loadCursor\(/]},
        cpp: {all: [/load_?[Cc]ursor\(/]},
      },
    },
    {
      id: 'atomic-advance',
      title: 'Claims the page and moves the cursor in one atomic script',
      detail:
        'A single `EVAL`/`NewScript` does both the page claim and the cursor `SET`. The draft issues two independent client calls, so a crash between them leaves the cursor ahead of the last processed page.',
      match: {
        python: {all: [/CURSOR_LUA/, /\.eval\(/]},
        typescript: {all: [/CURSOR_LUA/, /\.eval\(/]},
        go: {all: [/cursorScript/, /\.Run\(/]},
        scala: {all: [/CursorLua/, /\.eval\(/]},
        cpp: {all: [/kCursorLua/, /\.eval</]},
      },
    },
    {
      id: 'durable-cursor',
      title: 'Never expires the cursor',
      detail:
        'The cursor key is written without a TTL — no `ex=`, no `EX`, no `setex`, no `time.Hour`, no `chrono::hours`. The draft gives it 24 hours, so a connector that syncs less often than daily silently restarts from the beginning of its history.',
      match: {
        python: {all: [/SET/], none: [/\bex\s*=/, /EXPIRE/]},
        typescript: {all: [/SET/], none: [/['"]EX['"]/, /expire\(/]},
        go: {all: [/SET/], none: [/Expire\(/, /time\.Hour/]},
        scala: {all: [/SET/], none: [/setex|SETEX/, /expire\(/]},
        cpp: {all: [/SET/], none: [/chrono::hours|chrono::minutes/, /EXPIRE/]},
      },
    },
    {
      id: 'page-dedupe',
      title: 'Claims each page under its own key',
      detail:
        'The page claim key is `page:{connector_id}:{page_token}` and is taken with `SET … NX`, so re-fetching a page after a crash changes nothing. The draft has no per-page key at all.',
      match: {
        python: {all: [/page:/, /'NX'/]},
        typescript: {all: [/page:/, /'NX'/]},
        go: {all: [/page:/, /'NX'/]},
        scala: {all: [/page:/, /'NX'/]},
        cpp: {all: [/page:/, /'NX'/]},
      },
    },
    {
      id: 'claim-before-move',
      title: 'Moves the cursor only after the page is claimed',
      detail:
        'Inside the script the `SET … NX` claim is evaluated before the cursor `SET` (`KEYS[2]`), and the move only happens when the claim succeeded. Landing the cursor first skips the page that a crash interrupted.',
      match: {
        python: {order: [/'NX'/, /KEYS\[2\]/]},
        typescript: {order: [/'NX'/, /KEYS\[2\]/]},
        go: {order: [/'NX'/, /KEYS\[2\]/]},
        scala: {order: [/'NX'/, /KEYS\[2\]/]},
        cpp: {order: [/'NX'/, /KEYS\[2\]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURSOR_TTL_S = 86_400


class PageCommit(BaseModel):
    connector_id: str
    page_token: str
    next_cursor: str


def load_cursor(connector_id: str) -> str | None:
    """The checkpoint the next sync run starts from."""
    return r.get(f"connector:{connector_id}:cursor")


def commit_page(commit: PageCommit) -> dict:
    # TODO: the draft stores the cursor with a 24-hour TTL and moves it before the page is
    # committed, so a quiet connector restarts from the beginning of history and an interrupted run
    # skips a page. Claim the page and move the cursor in one atomic script, with no TTL.
    r.set(f"connector:{commit.connector_id}:cursor", commit.next_cursor, ex=CURSOR_TTL_S)
    r.set(f"page:{commit.connector_id}:{commit.page_token}", "1", ex=CURSOR_TTL_S)
    return {"applied": True, "cursor": commit.next_cursor}
`,
      solution: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Claim the page first, then move the cursor. Both keys are durable: no TTL, ever.
CURSOR_LUA = """
local fresh = redis.call('SET', KEYS[1], '1', 'NX')
if not fresh then
  return {0, redis.call('GET', KEYS[2]) or ''}
end
redis.call('SET', KEYS[2], ARGV[1])
return {1, ARGV[1]}
"""


class PageCommit(BaseModel):
    connector_id: str
    page_token: str
    next_cursor: str


def cursor_key(connector_id: str) -> str:
    """The durable checkpoint for one connector."""
    return f"connector:{connector_id}:cursor"


def page_key(connector_id: str, page_token: str) -> str:
    """The claim for one page: a re-fetch after a crash finds its own key."""
    return f"page:{connector_id}:{page_token}"


def load_cursor(connector_id: str) -> str | None:
    """The checkpoint the next sync run starts from."""
    return r.get(cursor_key(connector_id))


def commit_page(commit: PageCommit) -> dict:
    applied, cursor = r.eval(
        CURSOR_LUA,
        2,
        page_key(commit.connector_id, commit.page_token),
        cursor_key(commit.connector_id),
        commit.next_cursor,
    )
    return {"applied": bool(applied), "cursor": cursor}
`,
    },
    typescript: {
      starter: `/** commitPage: a model-generated draft that expires the cursor and moves it too early. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');
const CURSOR_TTL_S = 86_400;

interface PageCommit {
  connector_id: string;
  page_token: string;
  next_cursor: string;
}

interface CommitResult {
  applied: boolean;
  cursor: string;
}

export async function loadCursor(connectorId: string): Promise<string | null> {
  return r.get(\`connector:\${connectorId}:cursor\`);
}

export async function commitPage(commit: PageCommit): Promise<CommitResult> {
  // TODO: the draft stores the cursor with a 24-hour TTL and moves it before the page is committed,
  // so a quiet connector restarts from the beginning of history and an interrupted run skips a
  // page. Claim the page and move the cursor in one atomic script, with no TTL.
  await r.set(\`connector:\${commit.connector_id}:cursor\`, commit.next_cursor, 'EX', CURSOR_TTL_S);
  await r.set(\`page:\${commit.connector_id}:\${commit.page_token}\`, '1', 'EX', CURSOR_TTL_S);
  return {applied: true, cursor: commit.next_cursor};
}
`,
      solution: `/** commitPage: one atomic script claims the page, then moves a cursor that never expires. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

// KEYS[1] = page claim, KEYS[2] = connector cursor, ARGV[1] = next cursor. No TTL on either key.
const CURSOR_LUA = \`
local fresh = redis.call('SET', KEYS[1], '1', 'NX')
if not fresh then
  return {0, redis.call('GET', KEYS[2]) or ''}
end
redis.call('SET', KEYS[2], ARGV[1])
return {1, ARGV[1]}
\`;

interface PageCommit {
  connector_id: string;
  page_token: string;
  next_cursor: string;
}

interface CommitResult {
  applied: boolean;
  cursor: string;
}

export async function loadCursor(connectorId: string): Promise<string | null> {
  return r.get(\`connector:\${connectorId}:cursor\`);
}

export async function commitPage(commit: PageCommit): Promise<CommitResult> {
  const pageClaim = \`page:\${commit.connector_id}:\${commit.page_token}\`;
  const cursorKey = \`connector:\${commit.connector_id}:cursor\`;
  const reply = (await r.eval(CURSOR_LUA, 2, pageClaim, cursorKey, commit.next_cursor)) as [
    number,
    string,
  ];
  return {applied: reply[0] === 1, cursor: reply[1]};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const CursorTTLS = 86400

var rdb *redis.Client

type PageCommit struct {
	ConnectorID string \`json:"connector_id"\`
	PageToken   string \`json:"page_token"\`
	NextCursor  string \`json:"next_cursor"\`
}

type CommitResult struct {
	Applied bool
	Cursor  string
}

func loadCursor(ctx context.Context, connectorID string) (string, error) {
	return rdb.Get(ctx, fmt.Sprintf("connector:%s:cursor", connectorID)).Result()
}

func commitPage(ctx context.Context, commit PageCommit) (CommitResult, error) {
	// TODO: the draft stores the cursor with a 24-hour TTL and moves it before the page is
	// committed, so a quiet connector restarts from the beginning of history and an interrupted run
	// skips a page. Claim the page and move the cursor in one atomic script, with no TTL.
	key := fmt.Sprintf("connector:%s:cursor", commit.ConnectorID)
	if err := rdb.Set(ctx, key, commit.NextCursor, 24*time.Hour).Err(); err != nil {
		return CommitResult{}, err
	}
	claim := fmt.Sprintf("page:%s:%s", commit.ConnectorID, commit.PageToken)
	rdb.Set(ctx, claim, "1", time.Duration(CursorTTLS)*time.Second)
	return CommitResult{Applied: true, Cursor: commit.NextCursor}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// KEYS[1] = page claim, KEYS[2] = connector cursor, ARGV[1] = next cursor. Neither key expires.
var cursorScript = redis.NewScript(\`
local fresh = redis.call('SET', KEYS[1], '1', 'NX')
if not fresh then
  return {0, redis.call('GET', KEYS[2]) or ''}
end
redis.call('SET', KEYS[2], ARGV[1])
return {1, ARGV[1]}
\`)

type PageCommit struct {
	ConnectorID string \`json:"connector_id"\`
	PageToken   string \`json:"page_token"\`
	NextCursor  string \`json:"next_cursor"\`
}

type CommitResult struct {
	Applied bool
	Cursor  string
}

func loadCursor(ctx context.Context, connectorID string) (string, error) {
	return rdb.Get(ctx, fmt.Sprintf("connector:%s:cursor", connectorID)).Result()
}

func commitPage(ctx context.Context, commit PageCommit) (CommitResult, error) {
	pageKey := fmt.Sprintf("page:%s:%s", commit.ConnectorID, commit.PageToken)
	cursorKey := fmt.Sprintf("connector:%s:cursor", commit.ConnectorID)
	reply, err := cursorScript.Run(ctx, rdb, []string{pageKey, cursorKey}, commit.NextCursor).Slice()
	if err != nil {
		return CommitResult{}, err
	}
	applied, _ := reply[0].(int64)
	cursor, _ := reply[1].(string)
	return CommitResult{Applied: applied == 1, Cursor: cursor}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final case class PageCommit(connector_id: String, page_token: String, next_cursor: String)
final case class CommitResult(applied: Boolean, cursor: String)

object CursorStore {
  val CursorTtlS = 86400
  val r = new Jedis("redis", 6379)

  def loadCursor(connectorId: String): Option[String] = Option(r.get(s"connector:$connectorId:cursor"))

  def commitPage(commit: PageCommit): CommitResult = {
    // TODO: the draft stores the cursor with a 24-hour TTL and moves it before the page is
    // committed, so a quiet connector restarts from the beginning of history and an interrupted run
    // skips a page. Claim the page and move the cursor in one atomic script, with no TTL.
    r.setex(s"connector:\${commit.connector_id}:cursor", CursorTtlS, commit.next_cursor)
    r.setex(s"page:\${commit.connector_id}:\${commit.page_token}", CursorTtlS, "1")
    CommitResult(applied = true, cursor = commit.next_cursor)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

final case class PageCommit(connector_id: String, page_token: String, next_cursor: String)
final case class CommitResult(applied: Boolean, cursor: String)

object CursorStore {
  val r = new Jedis("redis", 6379)

  // KEYS[1] = page claim, KEYS[2] = connector cursor, ARGV[1] = next cursor. Neither key expires.
  val CursorLua =
    """
      |local fresh = redis.call('SET', KEYS[1], '1', 'NX')
      |if not fresh then
      |  return {0, redis.call('GET', KEYS[2]) or ''}
      |end
      |redis.call('SET', KEYS[2], ARGV[1])
      |return {1, ARGV[1]}
      |""".stripMargin

  def loadCursor(connectorId: String): Option[String] = Option(r.get(s"connector:$connectorId:cursor"))

  def commitPage(commit: PageCommit): CommitResult = {
    val pageKey = s"page:\${commit.connector_id}:\${commit.page_token}"
    val cursorKey = s"connector:\${commit.connector_id}:cursor"
    val reply = r
      .eval(CursorLua, 2, pageKey, cursorKey, commit.next_cursor)
      .asInstanceOf[java.util.List[Any]]
    CommitResult(applied = reply.get(0) == 1L, cursor = reply.get(1).toString)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

struct PageCommit {
  std::string connector_id;
  std::string page_token;
  std::string next_cursor;
};

struct CommitResult {
  bool applied;
  std::string cursor;
};

std::string cursorKey(const std::string& connectorId) {
  return "connector:" + connectorId + ":cursor";
}

std::string loadCursor(sw::redis::Redis& redis, const std::string& connectorId) {
  auto value = redis.get(cursorKey(connectorId));
  return value ? *value : std::string();
}

CommitResult commitPage(sw::redis::Redis& redis, const PageCommit& commit) {
  // TODO: the draft stores the cursor with a 24-hour TTL and moves it before the page is committed,
  // so a quiet connector restarts from the beginning of history and an interrupted run skips a
  // page. Claim the page and move the cursor in one atomic script, with no TTL.
  redis.set(cursorKey(commit.connector_id), commit.next_cursor, std::chrono::hours(24));
  redis.set("page:" + commit.connector_id + ":" + commit.page_token, "1", std::chrono::hours(24));
  return {true, commit.next_cursor};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

// KEYS[1] = page claim, KEYS[2] = connector cursor, ARGV[1] = next cursor. Neither key expires.
const char* kCursorLua = R"LUA(
local fresh = redis.call('SET', KEYS[1], '1', 'NX')
if not fresh then
  return 0
end
redis.call('SET', KEYS[2], ARGV[1])
return 1
)LUA";

struct PageCommit {
  std::string connector_id;
  std::string page_token;
  std::string next_cursor;
};

struct CommitResult {
  bool applied;
  std::string cursor;
};

std::string cursorKey(const std::string& connectorId) {
  return "connector:" + connectorId + ":cursor";
}

std::string pageKey(const std::string& connectorId, const std::string& pageToken) {
  return "page:" + connectorId + ":" + pageToken;
}

std::string loadCursor(sw::redis::Redis& redis, const std::string& connectorId) {
  auto value = redis.get(cursorKey(connectorId));
  return value ? *value : std::string();
}

CommitResult commitPage(sw::redis::Redis& redis, const PageCommit& commit) {
  const auto applied = redis.eval<long long>(
      kCursorLua,
      {pageKey(commit.connector_id, commit.page_token), cursorKey(commit.connector_id)},
      {commit.next_cursor});
  return {applied == 1, commit.next_cursor};
}
`,
    },
  },
  hints: [
    'The cursor is a checkpoint, not a cache: `SET connector:{id}:cursor <token>` with no `EX`, no `ex=`, no `setex`. If you want hygiene for the page claims, do it in a separate compaction job — a TTL on the cursor itself is the bug the incident came from.',
    'Everything that decides the result runs inside the script: `SET page:{connector}:{page_token} 1 NX` claims the page, and only when that returns true does the script `SET` the cursor and return the new position. Read nothing on the client before the script, because the client read is where the race lives.',
    'Return `{applied, cursor}` from the script and hand it straight back: `applied = false` tells the worker the page was already committed, so it skips its side effects instead of re-applying them, and the cursor it reports is the one the script actually wrote.',
  ],
  debrief: `The interview question is the difference between a cache and a checkpoint, plus the write order that makes it safe. A TTL on the cursor is invisible in the demo and catastrophic in production: the connector simply stops advancing for a day, and the next sync reprocesses months of history, which costs the vendor's rate limit and can double-apply downstream effects. Moving the cursor before the page is committed is the second half — a crash then skips data silently, and nothing in the system can tell that a page was missed. One Lua script fixes both: the page claim is the idempotence token, the cursor moves only after it, and neither key expires. Real hubs keep a monotonically increasing sequence number alongside the cursor so out-of-order commits are rejected, a bounded page-claim set with a compaction job instead of per-key TTLs, and a durable "last committed page" row so a cursor can be rebuilt from the vendor's API.`,
};
