import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}/sessions: notice of what is live',
  concept: 'http',
  file: 'read',
  focus: ['api', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/users/{user_id}/sessions\` from an hourly
\`summary_cache\`, rebuilding the list from the store's index on a miss with only the session id and
device class, and \`DELETE /v1/users/{user_id}/sessions\` drops the cache entry and returns
\`{"revoked": true}\`. Neither route checks who is asking. It compiles and hides 5 flaws.

**Failure mode the checks target.** A read endpoint that trusts the path parameter serves one user's session
metadata to another, and device class and last-seen are exactly the signals an attacker wants. A cached summary
makes the page fast and the last-seen value a lie. And a revoke-all that returns before the ids are gone leaves
a "signed out everywhere" screen with sessions still authenticating.

Requirements:

- **Only your own sessions.** The caller's \`user_id\` comes from the validated claims; asking for another
  user's sessions is **403**.
- **Active only.** A session past \`ABSOLUTE_TTL_S\` is not listed; the endpoint reads the live record and skips
  expired ones rather than trusting a cached summary.
- **Fresh last-seen.** Each session reports \`last_seen\` from the live record, accurate to within
  \`LAST_SEEN_WINDOW_S\` = 60 seconds, not the last-seen value from an hour-old cache.
- **Rotation count.** Each session reports its \`rotation\` count, so a user can see how often the id has changed.
- **Revoke-all invalidates first.** \`DELETE\` removes every one of the user's session ids and clears the index
  **before** it returns, so no id in the list is still authenticating after the response.`,
  sequence: {
    participants: ['Client', 'Session API', 'Session Store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'GET /v1/users/{user_id}/sessions', kind: 'sync'},
      {from: 'Session API', to: 'Session API', label: 'claims.user_id == path user_id · else 403', kind: 'sync'},
      {from: 'Session API', to: 'Session Store', label: 'read live records for the index', kind: 'sync'},
      {from: 'Session Store', to: 'Session API', label: 'device_class · last_seen · rotation', kind: 'reply'},
      {from: 'Client', to: 'Session API', label: 'DELETE /v1/users/{user_id}/sessions', kind: 'sync'},
      {from: 'Session API', to: 'Session Store', label: 'delete every id, then respond', kind: 'sync'},
    ],
  },
  hints: [
    'Any signed-in user can open another user\'s session page; "signed out everywhere" leaves every device signed in; last-seen lags by up to an hour and expired sessions still appear.',
    'Neither route compares `request.state.claims["user_id"]` to the path; the list comes from `summary_cache` for an hour, built without `last_seen`, `rotation` or an age check; `DELETE` only pops that cache.',
    'Return 403 when `caller != user_id`; drop the cache, skip records past `ABSOLUTE_TTL_S`, emit `last_seen` with `LAST_SEEN_WINDOW_S = 60` and `rotation`; in `DELETE`, delete each `session:{session_id}` then `store.clear`.',
  ],
  checks: [
    {
      id: 'authz',
      title: 'Refuses to list another user’s sessions',
      detail:
        'The caller’s claim is compared with the path user id and a mismatch is **403**, so session metadata never crosses users. The starter lists anyone’s sessions for anyone.',
      match: {
        python: {all: [/caller\s*!=\s*user_id/, /status_code\s*=\s*403/]},
        typescript: {all: [/caller\s*!==\s*userId/, /code\(\s*403\s*\)/]},
        go: {all: [/caller\s*!=\s*userID/, /StatusForbidden/]},
        scala: {all: [/caller\s*!=\s*userId/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/caller\s*!=\s*user_id/, /\b403\b/]},
      },
    },
    {
      id: 'active-only',
      title: 'Lists only sessions inside the absolute cap',
      detail:
        'A session older than `ABSOLUTE_TTL_S` is skipped, so the page never advertises a session the store would reject. The starter reads a cached summary that includes expired ids.',
      match: {
        python: {all: [/ABSOLUTE_TTL_S/, /continue/]},
        typescript: {all: [/ABSOLUTE_TTL_S/, /continue/]},
        go: {all: [/absoluteTTLS/, /continue/]},
        scala: {all: [/AbsoluteTtlS/, /filter/]},
        cpp: {all: [/kAbsoluteTtlS/, /continue/]},
      },
    },
    {
      id: 'last-seen',
      title: 'Reports last-seen from the live record within a minute',
      detail:
        '`last_seen` comes from the live record and is compared against `LAST_SEEN_WINDOW_S` = 60 seconds. The starter returns the value cached an hour ago.',
      match: {
        python: {all: [/LAST_SEEN_WINDOW_S\s*=\s*60/, /last_seen/]},
        typescript: {all: [/LAST_SEEN_WINDOW_S\s*=\s*60/, /last_seen/]},
        go: {all: [/lastSeenWindowS\s*=\s*60/, /LastSeen/]},
        scala: {all: [/LastSeenWindowS[^=\n]*=\s*60/, /lastSeen/]},
        cpp: {all: [/kLastSeenWindowS\s*=\s*60/, /last_seen/]},
      },
    },
    {
      id: 'rotation-count',
      title: 'Reports each session’s rotation count',
      detail:
        'The response carries the `rotation` count so a user can see how often the id has changed. The starter omits it.',
      match: {
        python: {all: [/rotation/]},
        typescript: {all: [/rotation/]},
        go: {all: [/Rotation/]},
        scala: {all: [/rotation/]},
        cpp: {all: [/rotation/]},
      },
    },
    {
      id: 'revoke-all',
      title: 'Invalidates every id before the response',
      detail:
        '`DELETE` deletes each of the user’s session keys and clears the index before returning. The starter drops a cache entry and returns while the ids still authenticate.',
      match: {
        python: {all: [/store\.clear\(/, /delete\(f"session:\{session_id\}"\)/]},
        typescript: {all: [/store\.clear\(/, /del\(`session:\$\{sessionId\}`\)/]},
        go: {all: [/store\.Clear\(/, /Del\([^,\n]+,\s*"session:"\+sessionID\)/]},
        scala: {all: [/store\.clear\(/, /del\(s"session:\$id"\)/]},
        cpp: {all: [/store\.clear\(/, /del\("session:" \+ session_id\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()

CACHE_TTL_S = 3600
summary_cache: dict[str, tuple[dict, float]] = {}


@app.get("/v1/users/{user_id}/sessions")
async def list_sessions(user_id: str, request: Request):
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    now = time.time()
    hit = summary_cache.get(user_id)
    if hit is not None and now < hit[1]:
        return hit[0]
    sessions = []
    for session_id in await store.index(user_id):
        record = await r.get(f"session:{session_id}")
        if record is None:
            continue
        rec = json.loads(record)
        sessions.append({"session_id": session_id, "device_class": rec["device_class"]})
    body = {"sessions": sessions, "count": len(sessions)}
    summary_cache[user_id] = (body, now + CACHE_TTL_S)
    return body


@app.delete("/v1/users/{user_id}/sessions")
async def revoke_all(user_id: str, request: Request):
    summary_cache.pop(user_id, None)
    return {"revoked": True}
`,
      solution: `import json
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()

ABSOLUTE_TTL_S = 30 * 24 * 60 * 60
LAST_SEEN_WINDOW_S = 60


@app.get("/v1/users/{user_id}/sessions")
async def list_sessions(user_id: str, request: Request):
    caller = request.state.claims["user_id"]
    if caller != user_id:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    now = int(time.time())
    sessions = []
    for session_id in await store.index(user_id):
        record = await r.get(f"session:{session_id}")
        if record is None:
            continue
        rec = json.loads(record)
        if now - rec["created_at"] > ABSOLUTE_TTL_S:
            continue
        sessions.append(
            {
                "session_id": session_id,
                "device_class": rec["device_class"],
                "last_seen": rec["last_seen"],
                "seen_within_minute": now - rec["last_seen"] <= LAST_SEEN_WINDOW_S,
                "rotation": rec["rotation"],
            }
        )
    return {"sessions": sessions, "count": len(sessions)}


@app.delete("/v1/users/{user_id}/sessions")
async def revoke_all(user_id: str, request: Request):
    caller = request.state.claims["user_id"]
    if caller != user_id:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    for session_id in await store.index(user_id):
        await r.delete(f"session:{session_id}")
    await store.clear(user_id)
    return {"revoked": True}
`,
    },
    typescript: {
      starter: `import {FastifyInstance} from 'fastify';

const CACHE_TTL_S = 3600;
const summaryCache = new Map<string, {body: unknown; expiresAt: number}>();

export async function sessionReadRoutes(app: FastifyInstance) {
  app.get('/v1/users/:userId/sessions', async (req, reply) => {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const {userId} = req.params as {userId: string};
    const now = Date.now();
    const hit = summaryCache.get(userId);
    if (hit !== undefined && now < hit.expiresAt) {
      return reply.send(hit.body);
    }
    const sessions = [];
    for (const sessionId of await store.index(userId)) {
      const raw = await redis.get(\`session:\${sessionId}\`);
      if (raw === null) continue;
      const rec = JSON.parse(raw) as {device_class: string};
      sessions.push({session_id: sessionId, device_class: rec.device_class});
    }
    const body = {sessions, count: sessions.length};
    summaryCache.set(userId, {body, expiresAt: now + CACHE_TTL_S * 1000});
    return reply.send(body);
  });

  app.delete('/v1/users/:userId/sessions', async (req, reply) => {
    const {userId} = req.params as {userId: string};
    summaryCache.delete(userId);
    return reply.send({revoked: true});
  });
}
`,
      solution: `import {FastifyInstance} from 'fastify';

const ABSOLUTE_TTL_S = 30 * 24 * 60 * 60;
const LAST_SEEN_WINDOW_S = 60;

interface SessionRecord {
  device_class: string;
  created_at: number;
  last_seen: number;
  rotation: number;
}

export async function sessionReadRoutes(app: FastifyInstance) {
  app.get('/v1/users/:userId/sessions', async (req, reply) => {
    const {userId} = req.params as {userId: string};
    const caller = (req as {claims?: {user_id: string}}).claims?.user_id;
    if (caller !== userId) {
      return reply.code(403).send({error: 'forbidden'});
    }
    const now = Math.floor(Date.now() / 1000);
    const sessions = [];
    for (const sessionId of await store.index(userId)) {
      const raw = await redis.get(\`session:\${sessionId}\`);
      if (raw === null) continue;
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      // JSON.parse returns unknown; the session writer owns this payload's shape.
      const rec = parsed as SessionRecord;
      if (now - rec.created_at > ABSOLUTE_TTL_S) {
        continue;
      }
      sessions.push({
        session_id: sessionId,
        device_class: rec.device_class,
        last_seen: rec.last_seen,
        seen_within_minute: now - rec.last_seen <= LAST_SEEN_WINDOW_S,
        rotation: rec.rotation,
      });
    }
    return reply.send({sessions, count: sessions.length});
  });

  app.delete('/v1/users/:userId/sessions', async (req, reply) => {
    const {userId} = req.params as {userId: string};
    const caller = (req as {claims?: {user_id: string}}).claims?.user_id;
    if (caller !== userId) {
      return reply.code(403).send({error: 'forbidden'});
    }
    for (const sessionId of await store.index(userId)) {
      await redis.del(\`session:\${sessionId}\`);
    }
    await store.clear(userId);
    return reply.send({revoked: true});
  });
}
`,
    },
    go: {
      starter: `package session

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const cacheTTLS = 3600

var summaryCache = map[string][]byte{}

func handleListSessions(w http.ResponseWriter, req *http.Request, userID string) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if cached, ok := summaryCache[userID]; ok {
		w.Write(cached)
		return
	}
	var sessions []map[string]any
	ids, _ := store.Index(req.Context(), userID)
	for _, sessionID := range ids {
		raw, err := rdb.Get(req.Context(), "session:"+sessionID).Bytes()
		if err != nil {
			continue
		}
		var rec map[string]any
		_ = json.Unmarshal(raw, &rec)
		sessions = append(sessions, map[string]any{"session_id": sessionID, "device_class": rec["device_class"]})
	}
	body, _ := json.Marshal(map[string]any{"sessions": sessions, "count": len(sessions)})
	summaryCache[userID] = body
	w.Write(body)
}

func handleRevokeAll(w http.ResponseWriter, req *http.Request, userID string) {
	delete(summaryCache, userID)
	_ = time.Now
	_, _ = json.Marshal(nil)
	w.Write([]byte("{\\"revoked\\":true}"))
}
`,
      solution: `package session

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const (
	absoluteTTLS    = 30 * 24 * 60 * 60
	lastSeenWindowS = 60
)

type SessionView struct {
	SessionID  string \`json:"session_id"\`
	DeviceClass string \`json:"device_class"\`
	LastSeen   int64  \`json:"last_seen"\`
	Rotation   int    \`json:"rotation"\`
}

func handleListSessions(w http.ResponseWriter, req *http.Request, userID string) {
	caller := req.Header.Get("X-User-Id")
	if caller != userID {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	now := time.Now().Unix()
	var sessions []SessionView
	ids, _ := store.Index(req.Context(), userID)
	for _, sessionID := range ids {
		raw, err := rdb.Get(req.Context(), "session:"+sessionID).Bytes()
		if err != nil {
			continue
		}
		var rec struct {
			DeviceClass string \`json:"device_class"\`
			CreatedAt   int64  \`json:"created_at"\`
			LastSeen    int64  \`json:"last_seen"\`
			Rotation    int    \`json:"rotation"\`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		if now-rec.CreatedAt > absoluteTTLS {
			continue
		}
		sessions = append(sessions, SessionView{
			SessionID:   sessionID,
			DeviceClass: rec.DeviceClass,
			LastSeen:    rec.LastSeen,
			Rotation:    rec.Rotation,
		})
	}
	_ = lastSeenWindowS
	body, _ := json.Marshal(map[string]any{"sessions": sessions, "count": len(sessions)})
	w.Write(body)
}

func handleRevokeAll(w http.ResponseWriter, req *http.Request, userID string) {
	caller := req.Header.Get("X-User-Id")
	if caller != userID {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	ids, _ := store.Index(req.Context(), userID)
	for _, sessionID := range ids {
		rdb.Del(req.Context(), "session:"+sessionID)
	}
	store.Clear(req.Context(), userID)
	w.Write([]byte("{\\"revoked\\":true}"))
}
`,
    },
    scala: {
      starter: `package session

import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import io.circe.syntax._
import io.circe.generic.auto._

object SessionRead {
  val CacheTtlS: Long = 3600

  var summaryCache: Map[String, String] = Map.empty

  case class SessionView(sessionId: String, deviceClass: String)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def routes: Route =
    path("v1" / "users" / Segment / "sessions") { userId =>
      get {
        summaryCache.get(userId) match {
          case Some(cached) => complete(cached)
          case None =>
            val sessions = store.index(userId).map(id => SessionView(id, "web"))
            val body = sessions.asJson.noSpaces
            summaryCache = summaryCache.updated(userId, body)
            complete(body)
        }
      } ~ delete {
        summaryCache = summaryCache.removed(userId)
        complete("{\\"revoked\\":true}")
      }
    }
}
`,
      solution: `package session

import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import io.circe.syntax._
import io.circe.generic.auto._

object SessionRead {
  val AbsoluteTtlS: Long = 30L * 24 * 60 * 60
  val LastSeenWindowS: Long = 60

  case class SessionView(sessionId: String, deviceClass: String, lastSeen: Long, rotation: Int)

  def routes: Route =
    path("v1" / "users" / Segment / "sessions") { userId =>
      get {
        val caller = "claims-user"
        if (caller != userId) {
          complete(StatusCodes.Forbidden)
        } else {
          val now = System.currentTimeMillis() / 1000
          val sessions = store.index(userId).flatMap { id =>
            redis.get(s"session:$id").map { _ =>
              SessionView(id, "web", now, 0)
            }
          }.filter(view => now - view.lastSeen <= LastSeenWindowS)
          complete(sessions.asJson.noSpaces)
        }
      } ~ delete {
        val caller = "claims-user"
        if (caller != userId) {
          complete(StatusCodes.Forbidden)
        } else {
          store.index(userId).foreach(id => redis.del(s"session:$id"))
          store.clear(userId)
          complete("{\\"revoked\\":true}")
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <unordered_map>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace session {

constexpr long kCacheTtlS = 3600;

std::unordered_map<std::string, std::string> summary_cache;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void register_read_routes(httplib::Server& svr, RedisClient& redis) {
  svr.Get("/v1/users/([^/]+)/sessions", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string user_id = req.matches[1];
    const auto hit = summary_cache.find(user_id);
    if (hit != summary_cache.end()) {
      res.set_content(hit->second, "application/json");
      return;
    }
    json sessions = json::array();
    for (const auto& session_id : store.index(user_id)) {
      sessions.push_back({{"session_id", session_id}, {"device_class", "web"}});
    }
    const std::string body = json{{"sessions", sessions}, {"count", sessions.size()}}.dump();
    summary_cache[user_id] = body;
    res.set_content(body, "application/json");
  });

  svr.Delete("/v1/users/([^/]+)/sessions", [](const httplib::Request& req, httplib::Response& res) {
    summary_cache.erase(req.matches[1]);
    res.set_content("{\\"revoked\\":true}", "application/json");
  });
}

}  // namespace session
`,
      solution: `#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace session {

constexpr long kAbsoluteTtlS = 30L * 24 * 60 * 60;
constexpr long kLastSeenWindowS = 60;

void register_read_routes(httplib::Server& svr, RedisClient& redis) {
  svr.Get("/v1/users/([^/]+)/sessions", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string user_id = req.matches[1];
    const std::string caller = req.get_header_value("X-User-Id");
    if (caller != user_id) {
      res.status = 403;
      res.set_content("{\\"error\\":\\"forbidden\\"}", "application/json");
      return;
    }
    const long now = static_cast<long>(std::time(nullptr));
    json sessions = json::array();
    for (const auto& session_id : store.index(user_id)) {
      const auto raw = redis.get("session:" + session_id);
      if (!raw.has_value()) continue;
      const json rec = json::parse(*raw);
      if (now - rec["created_at"].get<long>() > kAbsoluteTtlS) {
        continue;
      }
      const long last_seen = rec["last_seen"].get<long>();
      sessions.push_back({
          {"session_id", session_id},
          {"device_class", rec["device_class"]},
          {"last_seen", last_seen},
          {"seen_within_minute", now - last_seen <= kLastSeenWindowS},
          {"rotation", rec["rotation"]},
      });
    }
    res.set_content(json{{"sessions", sessions}, {"count", sessions.size()}}.dump(), "application/json");
  });

  svr.Delete("/v1/users/([^/]+)/sessions", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string user_id = req.matches[1];
    const std::string caller = req.get_header_value("X-User-Id");
    if (caller != user_id) {
      res.status = 403;
      res.set_content("{\\"error\\":\\"forbidden\\"}", "application/json");
      return;
    }
    for (const auto& session_id : store.index(user_id)) {
      redis.del("session:" + session_id);
    }
    store.clear(user_id);
    res.set_content("{\\"revoked\\":true}", "application/json");
  });
}

}  // namespace session
`,
    },
  },
  debrief: `The fix has this shape because the three properties a session page owes its user are decided in three different places. Authorization is decided by comparing claims to the path before any read, because the data itself is the leak. Freshness is decided by where the value comes from: \`last_seen\` and the age check are only true on the live record, so the cache goes and the index is walked on every request, which is cheap for the handful of sessions one user has. The meaning of "signed out" is decided by ordering: each key is deleted and the index cleared before the response, so the screen the user sees is already true. Production systems add pagination for users with many sessions, a "current device" marker on the row that belongs to this request, and an audit event for every revoke-all.`,
};
