import type {Step} from '@/lib/types';

export const pullReadStep: Step = {
  id: 'read',
  concept: 'http',
  file: 'read',
  title: 'GET /v1/sync/pull: deltas that are stable and complete',
  focus: ['device', 'sync', 'revisions', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it returns changes for a
device, the demo client renders them, and the watermark makes it look like a proper sync protocol.
Two of its three answers are lies, and both of them make a device believe it is caught up when it is
not. Find them, fix them, and prove the fix.

Implement \`GET /v1/sync/pull?cursor={revision}\`:

- The device is authenticated by the \`X-Device-Id\` header (**401** when missing); \`cursor\` is the
  last revision the device holds and defaults to **0**.
- Return the changes **after** that cursor, ordered by revision, **capped at 1000 entries**
  (\`MAX_DELTA_ENTRIES\`). The cap is not a page size the client can ignore: it is the point at which
  the device must come back.
- The response is \`{entries, watermark, next_cursor, has_more}\`. **The watermark covers exactly the
  entries returned** — it is the revision of the last entry, or the device's own cursor when nothing
  was returned. It is never the newest write in the system: a device that hit the cap and is told
  "you are at the newest revision" skips everything it did not receive, forever.
- **\`has_more\` is true when the cap was reached**, and \`next_cursor\` is the cursor that resumes
  exactly where this response stopped. A full page is not an error; it is an instruction to pull
  again.
- **Pagination is cursor-based, not offset-based.** \`offset\` counts rows in a table that is being
  written to, so a concurrent change shifts every later page: the device duplicates one change and
  skips another. A cursor names a revision, and rows are ordered by revision, so the same cursor
  always resumes at the same place.

**Failure mode the checks target.** Returning the latest write as the watermark after a partial page
tells a device it is synced when it is missing entries — silent data loss with no error anywhere.
Offset pagination makes the returned set depend on writes that happen *after* the request: a device
resuming from an offset can skip a change forever. Both bugs are invisible in a demo with one device
and no concurrent writers.`,
  sequence: {
    participants: ['Device', 'Sync Engine', 'revisions'],
    messages: [
      {from: 'Device', to: 'Sync Engine', label: 'GET /v1/sync/pull?cursor=412 · X-Device-Id', kind: 'sync'},
      {
        from: 'Sync Engine',
        to: 'revisions',
        label: 'changes_after(start_after=412, limit=MAX_DELTA_ENTRIES)',
        kind: 'sync',
      },
      {from: 'revisions', to: 'Sync Engine', label: 'entries ≤ 1000, ordered by revision', kind: 'reply'},
      {
        from: 'Sync Engine',
        to: 'Sync Engine',
        label: 'watermark = last returned revision (or the cursor)',
        kind: 'sync',
      },
      {from: 'Sync Engine', to: 'Device', label: '200 {entries, watermark, next_cursor, has_more}', kind: 'reply'},
      {from: 'Device', to: 'Sync Engine', label: 'pull again from next_cursor while has_more', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/sync/pull',
      detail: 'Register the pull route on `GET /v1/sync/pull`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/sync\/pull["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/sync\/pull['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/sync\/pull"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sync"\s*\/\s*"pull"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/sync\/pull"/]},
      },
    },
    {
      id: 'watermark-covers-returned',
      title: 'The watermark covers exactly the returned entries',
      detail:
        'The watermark is derived from the entries actually returned (`covered_watermark(entries, cursor)`), falling back to the device’s cursor when the page is empty — never the newest write in the system. The draft answers with the latest revision regardless of what it returned.',
      match: {
        python: {all: [/covered_watermark\(/, /"watermark"/], none: [/latest_revision/]},
        typescript: {all: [/coveredWatermark\(/, /watermark/], none: [/latestRevision/]},
        go: {all: [/coveredWatermark\(/, /"watermark"/], none: [/LatestRevision/]},
        scala: {all: [/coveredWatermark\(/, /"watermark"/], none: [/latestRevision/]},
        cpp: {all: [/coveredWatermark\(/, /"watermark"/], none: [/latestRevision/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Paginates by cursor, never by offset',
      detail:
        'The query is expressed as "changes after this revision" (`start_after` / `startAfter`), so a concurrent write cannot shift the next page. The draft paginates by `offset`, which duplicates or skips changes while writes are happening.',
      match: {
        python: {all: [/start_after/], none: [/\boffset\b/]},
        typescript: {all: [/startAfter/], none: [/\boffset\b/]},
        go: {all: [/startAfter/], none: [/\boffset\b/]},
        scala: {all: [/startAfter/], none: [/\boffset\b/]},
        cpp: {all: [/startAfter/], none: [/\boffset\b/]},
      },
    },
    {
      id: 'page-cap',
      title: 'Caps the page at 1000 entries',
      detail:
        'The store is asked for at most `MAX_DELTA_ENTRIES` (1000) entries, and the constant is what the handler passes to the query. The draft has an unrelated page constant and no cap contract.',
      match: {
        python: {all: [/MAX_DELTA_ENTRIES\s*=\s*1000/, /changes_after\(cursor, MAX_DELTA_ENTRIES\)/]},
        typescript: {all: [/MAX_DELTA_ENTRIES\s*=\s*1000/, /startAfter:\s*cursor, limit: MAX_DELTA_ENTRIES/]},
        go: {all: [/maxDeltaEntries\s*=\s*1000/, /changesAfter\(r\.Context\(\), cursor, maxDeltaEntries\)/]},
        scala: {all: [/MaxDeltaEntries\s*=\s*1000/, /changesAfter\(startAfter = cursor, limit = MaxDeltaEntries\)/]},
        cpp: {all: [/kMaxDeltaEntries\s*=\s*1000/, /changesAfter\(cursor, kMaxDeltaEntries\)/]},
      },
    },
    {
      id: 'cap-resumable',
      title: 'A full page returns a resumable cursor',
      detail:
        'Reaching the cap sets `has_more` and returns the `next_cursor` that resumes exactly where this response stopped, so the device pulls again instead of skipping. The draft returns no cursor and no flag, so a capped device silently stops.',
      match: {
        python: {all: [/next_cursor/, /has_more/, /len\(entries\)\s*==\s*MAX_DELTA_ENTRIES/]},
        typescript: {all: [/next_cursor/, /has_more/, /entries\.length === MAX_DELTA_ENTRIES/]},
        go: {all: [/next_cursor/, /has_more/, /len\(entries\) == maxDeltaEntries/]},
        scala: {all: [/next_cursor/, /has_more/, /entries\.size == MaxDeltaEntries/]},
        cpp: {all: [/next_cursor/, /has_more/, /entries\.size\(\) == kMaxDeltaEntries/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

DEFAULT_PAGE = 1000


class RevisionStore:
    def page(self, offset: int, limit: int) -> list[dict]:
        """Changes ordered by revision, starting at an offset."""
        raise NotImplementedError

    def latest_revision(self) -> int:
        """The newest revision written for any document."""
        raise NotImplementedError


store = RevisionStore()


@app.get("/v1/sync/pull")
def pull(cursor: int = 0, device: str = Header(alias="X-Device-Id")) -> JSONResponse:
    # TODO: cap the page at 1000 entries with a resumable cursor, answer with a watermark that
    # covers exactly the entries returned instead of the latest write, and paginate by cursor
    # instead of by offset.
    entries = store.page(offset=cursor, limit=DEFAULT_PAGE)
    return JSONResponse(
        {"entries": entries, "watermark": store.latest_revision()},
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_DELTA_ENTRIES = 1000


class RevisionStore:
    def changes_after(self, start_after: int, limit: int) -> list[dict]:
        """Changes with revision > start_after, ordered by revision, at most limit of them."""
        raise NotImplementedError


store = RevisionStore()


def covered_watermark(entries: list[dict], cursor: int) -> int:
    """The watermark a device may adopt: exactly the entries it was just sent, no more."""
    if not entries:
        return cursor
    return entries[-1]["revision"]


@app.get("/v1/sync/pull")
def pull(
    cursor: int = 0,
    device: str | None = Header(default=None, alias="X-Device-Id"),
) -> JSONResponse:
    if device is None or device == "":
        raise HTTPException(status_code=401, detail="missing X-Device-Id")
    if cursor < 0:
        raise HTTPException(status_code=400, detail="cursor must not be negative")

    entries = store.changes_after(cursor, MAX_DELTA_ENTRIES)
    next_cursor = covered_watermark(entries, cursor)
    return JSONResponse(
        {
            "entries": entries,
            "watermark": next_cursor,
            "next_cursor": next_cursor,
            "has_more": len(entries) == MAX_DELTA_ENTRIES,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/sync/pull: a model-generated draft that answers with the newest revision. */
import Fastify from 'fastify';

import {store} from './revisions';

export const app = Fastify();

const DEFAULT_PAGE = 1000;

app.get('/v1/sync/pull', async (request, reply) => {
  // TODO: cap the page at 1000 entries with a resumable cursor, answer with a watermark that
  // covers exactly the entries returned instead of the latest write, and paginate by cursor
  // instead of by offset.
  const cursor = Number((request.query as {cursor?: string}).cursor ?? 0);
  const entries = await store.page(cursor, DEFAULT_PAGE);
  return reply.code(200).send({entries, watermark: await store.latestRevision()});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/sync/pull: deltas after a cursor, capped, with a watermark that covers them. */
import Fastify from 'fastify';

import {store} from './revisions';

export const app = Fastify();

const MAX_DELTA_ENTRIES = 1000;

function coveredWatermark(entries: Array<{revision: number}>, cursor: number): number {
  // The watermark a device may adopt: exactly the entries it was just sent, no more.
  return entries.length === 0 ? cursor : entries[entries.length - 1].revision;
}

app.get('/v1/sync/pull', async (request, reply) => {
  const device = request.headers['x-device-id'];
  if (typeof device !== 'string' || device === '')
    return reply.code(401).send({error: 'missing X-Device-Id'});

  const cursor = Number((request.query as {cursor?: string}).cursor ?? 0);
  if (!Number.isInteger(cursor) || cursor < 0)
    return reply.code(400).send({error: 'cursor must be a non-negative integer'});

  const entries = await store.changesAfter({startAfter: cursor, limit: MAX_DELTA_ENTRIES});
  const next_cursor = coveredWatermark(entries, cursor);
  return reply.code(200).send({
    entries,
    watermark: next_cursor,
    next_cursor,
    has_more: entries.length === MAX_DELTA_ENTRIES,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const defaultPage = 1000

type Entry struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
}

type RevisionStore struct{}

func (s *RevisionStore) Page(ctx context.Context, offset int64, limit int) ([]Entry, error) {
	return nil, nil
}

func (s *RevisionStore) LatestRevision(ctx context.Context) (int64, error) {
	return 0, nil
}

var store = &RevisionStore{}

func pull(rw http.ResponseWriter, r *http.Request) {
	// TODO: cap the page at 1000 entries with a resumable cursor, answer with a watermark that
	// covers exactly the entries returned instead of the latest write, and paginate by cursor
	// instead of by offset.
	entries, _ := store.Page(r.Context(), 0, defaultPage)
	watermark, _ := store.LatestRevision(r.Context())
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{"entries": entries, "watermark": watermark})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sync/pull", pull)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

const maxDeltaEntries = 1000

type Entry struct {
	DocID       string \`json:"doc_id"\`
	Revision    int64  \`json:"revision"\`
	ContentHash string \`json:"content_hash"\`
}

type RevisionStore struct{}

func (s *RevisionStore) changesAfter(ctx context.Context, startAfter int64, limit int) ([]Entry, error) {
	return nil, nil
}

var store = &RevisionStore{}

// coveredWatermark is the revision a device may adopt: exactly the entries it was just sent. A
// device that stopped at the cap must not be told it is caught up with the newest write.
func coveredWatermark(entries []Entry, cursor int64) int64 {
	if len(entries) == 0 {
		return cursor
	}
	return entries[len(entries)-1].Revision
}

func pull(rw http.ResponseWriter, r *http.Request) {
	device := r.Header.Get("X-Device-Id")
	if device == "" {
		http.Error(rw, \`{"error":"missing X-Device-Id"}\`, http.StatusUnauthorized)
		return
	}
	cursor := int64(0)
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			http.Error(rw, \`{"error":"cursor must be a non-negative integer"}\`, http.StatusBadRequest)
			return
		}
		cursor = parsed
	}
	entries, err := store.changesAfter(r.Context(), cursor, maxDeltaEntries)
	if err != nil {
		http.Error(rw, \`{"error":"TRY_AGAIN"}\`, http.StatusServiceUnavailable)
		return
	}
	nextCursor := coveredWatermark(entries, cursor)
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"entries":     entries,
		"watermark":   nextCursor,
		"next_cursor": nextCursor,
		"has_more":    len(entries) == maxDeltaEntries,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sync/pull", pull)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object PullApi {
  implicit val system: ActorSystem = ActorSystem("sync-engine")
  val DefaultPage = 1000
  val store = RevisionStore.open()

  val route: Route =
    path("v1" / "sync" / "pull") {
      get {
        parameter("cursor".as[Long].?) { cursorOpt =>
          // TODO: cap the page at 1000 entries with a resumable cursor, answer with a watermark
          // that covers exactly the entries returned instead of the latest write, and paginate by
          // cursor instead of by offset.
          val cursor = cursorOpt.getOrElse(0L)
          val entries = store.page(offset = cursor, limit = DefaultPage)
          complete(StatusCodes.OK, s"""{"entries":$entries,"watermark":\${store.latestRevision()}}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Entry(doc_id: String, revision: Long, content_hash: String)

object PullApi {
  implicit val system: ActorSystem = ActorSystem("sync-engine")
  implicit val entryFormat: RootJsonFormat[Entry] = jsonFormat3(Entry)

  val MaxDeltaEntries = 1000
  val store = RevisionStore.open()

  // The watermark a device may adopt: exactly the entries it was just sent, never the newest write.
  def coveredWatermark(entries: List[Entry], cursor: Long): Long =
    entries.lastOption.map(_.revision).getOrElse(cursor)

  val route: Route =
    path("v1" / "sync" / "pull") {
      get {
        optionalHeaderValueByName("X-Device-Id") { deviceOpt =>
          parameter("cursor".as[Long].?) { cursorOpt =>
            val cursor = cursorOpt.getOrElse(0L)
            if (!deviceOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Device-Id"}""")
            } else {
              val entries = store.changesAfter(startAfter = cursor, limit = MaxDeltaEntries)
              val nextCursor = coveredWatermark(entries, cursor)
              complete(
                StatusCodes.OK,
                s"""{"entries":\${entries.toJson.compactPrint},"watermark":$nextCursor,"next_cursor":$nextCursor,"has_more":\${entries.size == MaxDeltaEntries}}"""
              )
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

constexpr int kDefaultPage = 1000;

struct RevisionStore {
  json page(long long offset, int limit);
  long long latestRevision();
};

RevisionStore store;

int main() {
  httplib::Server svr;

  svr.Get("/v1/sync/pull", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: cap the page at 1000 entries with a resumable cursor, answer with a watermark that
    // covers exactly the entries returned instead of the latest write, and paginate by cursor
    // instead of by offset.
    const std::string raw = req.get_param_value("cursor");
    const long long cursor = raw.empty() ? 0 : std::stoll(raw);
    const auto entries = store.page(cursor, kDefaultPage);
    res.status = 200;
    res.set_content(
        json{{"entries", entries}, {"watermark", store.latestRevision()}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxDeltaEntries = 1000;

struct Entry {
  std::string docId;
  long long revision;
  std::string contentHash;
};

struct RevisionStore {
  std::vector<Entry> changesAfter(long long startAfter, int limit);
};

RevisionStore store;

// The watermark a device may adopt: exactly the entries it was just sent, never the newest write.
long long coveredWatermark(const std::vector<Entry>& entries, long long cursor) {
  if (entries.empty()) return cursor;
  return entries.back().revision;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/sync/pull", [](const httplib::Request& req, httplib::Response& res) {
    const auto device = req.get_header_value("X-Device-Id");
    if (device.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Device-Id"})", "application/json");
      return;
    }
    const std::string raw = req.get_param_value("cursor");
    const long long cursor = raw.empty() ? 0 : std::stoll(raw);
    if (cursor < 0) {
      res.status = 400;
      res.set_content(R"({"error":"cursor must be a non-negative integer"})", "application/json");
      return;
    }
    const auto entries = store.changesAfter(cursor, kMaxDeltaEntries);
    const long long nextCursor = coveredWatermark(entries, cursor);
    json body = {
        {"entries", json::array()},
        {"watermark", nextCursor},
        {"next_cursor", nextCursor},
        {"has_more", entries.size() == kMaxDeltaEntries},
    };
    for (const auto& entry : entries) {
      body["entries"].push_back(
          json{{"doc_id", entry.docId}, {"revision", entry.revision}, {"content_hash", entry.contentHash}});
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The watermark is not "how far the system has got", it is "how far *this device* has been brought". Build it from the page you are returning: the revision of the last entry, or the device\'s own cursor when the page is empty. Anything else lets a device that stopped at the cap claim to be caught up.',
    'A full page is a resumable state, not a success: return `has_more` and a `next_cursor` equal to the watermark you just computed, so the client pulls again from exactly the last entry it received. Without those two fields, a capped device has no way to know it stopped early.',
    'Pagination by `offset` reads a table that is being appended to: a write between two pages shifts every later row, so the client skips or duplicates changes. Query by revision instead — "changes after this cursor, ordered by revision, at most N" — and the same cursor always names the same point in the stream.',
  ],
  debrief: `The interview question is "what makes a sync response safe to act on?" A device trusts the answer enough to discard its local notion of "not yet synced", so two things must be true. The watermark has to describe the entries actually returned: it is the device's new position, and a position beyond the page it received marks unreceived changes as synced — a silent, permanent hole in the client. And the page boundary has to be a cursor: offsets are positions in a result set that changes under you, so a device resuming from an offset can be handed a page whose rows shifted, duplicating one change and skipping its neighbour. The cap completes the trio: it exists to bound the response, and it must come with has_more and next_cursor so the client resumes rather than stops. Real systems add per-device concurrency limits, a snapshot path for cursors older than the compaction horizon, and an ordering guarantee that the entries are strictly increasing in revision so a client can validate the page it got.`,
};
