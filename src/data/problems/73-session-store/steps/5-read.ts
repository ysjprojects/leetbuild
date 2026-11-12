import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}/sessions: your own live sessions, and sign out everywhere',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves the session page. \`GET /v1/users/{user_id}/sessions\`
authenticates the caller by \`X-Session-Id\` (\`touch_session\` from \`sessions.state\`, **401** when
it is not live), then answers \`{user_id, sessions: [{session_id, device_class, last_seen, rotation,
current}]}\` for every id in the user's set, from a per-user summary cached for an hour.
\`DELETE /v1/users/{user_id}/sessions\` (sign out everywhere) reads the set, deletes it and answers
\`{revoked: n}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Any signed-in user reads another user's devices and can sign them
out. The page lists sessions that expired long ago and a last-seen time from an hour back. "Sign out
everywhere" leaves every device signed in, and a login that lands while it runs survives where no
page shows it.

- The caller's session must belong to the user in the path; otherwise **403**, on both routes.
- List only ids whose session still reads (\`store.read_session\`).
- Read the records on every request: \`last_seen\` within a minute of the truth.
- Revoke-all deletes every \`session:{id}\` in the set, then the set, in one Lua script: a login
  landing meanwhile is either revoked or still listed.`,
  sequence: {
    participants: ['Client', 'Session API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'GET /v1/users/{id}/sessions · X-Session-Id', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Redis',
        label: 'touch_session(caller) → 401 / 403 unless the user matches',
        kind: 'sync',
      },
      {
        from: 'Session API',
        to: 'Redis',
        label: 'SMEMBERS user:{id}:sessions · HGETALL each, skip the gone',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Client', label: '200 {sessions: [device_class, last_seen, rotation]}', kind: 'reply'},
      {from: 'Client', to: 'Session API', label: 'DELETE /v1/users/{id}/sessions', kind: 'sync'},
      {from: 'Session API', to: 'Redis', label: 'EVAL: SMEMBERS · DEL session:{each} · DEL set', kind: 'sync'},
      {from: 'Session API', to: 'Client', label: '200 {revoked: n}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'authz',
      title: "Refuses another user's sessions",
      detail:
        "A caller signed in as u-1 gets **403** for u-2's page and for u-2's sign-out-everywhere, which leaves u-2's sessions live. The starter checks only that the caller is signed in.",
      match: {
        python: {all: [/\b403\b/]},
        typescript: {all: [/\b403\b/]},
        go: {all: [/StatusForbidden|\b403\b/]},
        scala: {all: [/Forbidden/]},
        cpp: {all: [/\b403\b/]},
      },
    },
    {
      id: 'active-only',
      title: 'Lists only sessions that still exist',
      detail:
        "A session idle past its 15 minutes has expired, but its id stays in the user's set: the page must not list it. The starter turns a missing record into an entry.",
      match: {
        python: {none: [/read_session\([^)]*\)\s*or\s*\{\}/]},
        typescript: {none: [/record\?\./]},
        go: {none: [/record = &store\.Session\{\}/]},
        scala: {none: [/getOrElse\(JsNull\)/]},
        cpp: {none: [/value_or\(store::Session\{\}\)/]},
      },
    },
    {
      id: 'last-seen',
      title: 'Last-seen is read on every request',
      detail:
        "Five minutes after the first listing, the caller's own `last_seen` in the next listing is within 60 s of now. The starter serves the hour-long summary.",
      match: {
        python: {all: [/last_seen/], none: [/summary_cache/]},
        typescript: {all: [/last_seen/], none: [/summaryCache/]},
        go: {all: [/"last_seen"/], none: [/summaryCache/]},
        scala: {all: [/"last_seen"/], none: [/summaryCache/]},
        cpp: {all: [/"last_seen"/], none: [/summary_cache/]},
      },
    },
    {
      id: 'revoke-all',
      title: 'Sign out everywhere ends every session',
      detail:
        "After `DELETE` none of the user's sessions reads, the set is gone and the caller's own id answers 401. The starter deletes the set and leaves every session live.",
      match: {
        python: {all: [/'session:'\s*\.\.\s*id|store\.retire_session\(/]},
        typescript: {all: [/'session:'\s*\.\.\s*id|retireSession\(/]},
        go: {all: [/'session:'\s*\.\.\s*id|store\.RetireSession\(/]},
        scala: {all: [/'session:'\s*\.\.\s*id|Store\.retireSession\(/]},
        cpp: {all: [/'session:'\s*\.\.\s*id|store::retireSession\(/]},
      },
    },
    {
      id: 'revoke-race',
      title: 'A login during sign-out is revoked or listed',
      detail:
        'A login for the same user lands right after sign-out-everywhere first touches the set; afterwards that session is either gone or still in the set, never live and unlisted. The starter reads the set and deletes it in two commands.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/],
          none: [/def revoke_all(?:(?!\ndef |\n@app)[\s\S])*?\br\.delete\(/],
        },
        typescript: {all: [/defineCommand\(|\.eval\(/], none: [/app\.delete\((?:(?!\n\}\);)[\s\S])*?redis\.del\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/func revokeAll\((?:(?!\n\})[\s\S])*?rdb\.Del\(/]},
        scala: {all: [/jedis\.eval\(/], none: [/jedis\.del\(Store\.userKey/]},
        cpp: {all: [/\.eval</], none: [/redis\(\)\.del\(store::userKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from sessions import store  # user_key, user_sessions, read_session, retire_session
from sessions.state import touch_session

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUMMARY_TTL_S = 3600
# user_id -> (the listing, when it stops being served)
summary_cache: dict[str, tuple[dict, float]] = {}


def caller(request: Request) -> dict:
    """The live session making the request; 401 when there is none."""
    me = touch_session(request.headers.get("x-session-id", ""))
    if me is None:
        raise HTTPException(status_code=401, detail="no live session")
    return me


@app.get("/v1/users/{user_id}/sessions")
def list_sessions(user_id: str, request: Request) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    me = caller(request)
    now = time.time()
    hit = summary_cache.get(user_id)
    if hit is not None and now < hit[1]:
        return hit[0]
    sessions = []
    for session_id in store.user_sessions(user_id):
        record = store.read_session(session_id) or {}
        sessions.append(
            {
                "session_id": session_id,
                "device_class": record.get("device_class"),
                "last_seen": record.get("last_seen"),
                "rotation": record.get("rotation", 0),
                "current": session_id == me["session_id"],
            }
        )
    body = {"user_id": user_id, "sessions": sessions}
    summary_cache[user_id] = (body, now + SUMMARY_TTL_S)
    return body


@app.delete("/v1/users/{user_id}/sessions")
def revoke_all(user_id: str, request: Request) -> dict:
    caller(request)
    ids = store.user_sessions(user_id)
    r.delete(store.user_key(user_id))
    summary_cache.pop(user_id, None)
    return {"revoked": len(ids)}
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException, Request

from sessions import store  # user_key, user_sessions, read_session, retire_session
from sessions.state import touch_session

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: the user's set. Every session in it and the set itself, with nothing landing in between.
REVOKE_ALL_LUA = """
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
redis.call('DEL', KEYS[1])
return #ids
"""
revoke_script = r.register_script(REVOKE_ALL_LUA)


def caller(request: Request, user_id: str) -> dict:
    """The live session making the request, if it is the path's user's; 401 or 403 otherwise."""
    me = touch_session(request.headers.get("x-session-id", ""))
    if me is None:
        raise HTTPException(status_code=401, detail="no live session")
    # The path names whose page is asked for; the session says who is asking.
    if me["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="these sessions are not yours")
    return me


@app.get("/v1/users/{user_id}/sessions")
def list_sessions(user_id: str, request: Request) -> dict:
    me = caller(request, user_id)
    sessions = []
    for session_id in store.user_sessions(user_id):
        record = store.read_session(session_id)
        if record is None:
            continue  # expired: its id outlives it in the set
        sessions.append(
            {
                "session_id": session_id,
                "device_class": record["device_class"],
                "last_seen": record["last_seen"],
                "rotation": record["rotation"],
                "current": session_id == me["session_id"],
            }
        )
    return {"user_id": user_id, "sessions": sessions}


@app.delete("/v1/users/{user_id}/sessions")
def revoke_all(user_id: str, request: Request) -> dict:
    caller(request, user_id)
    return {"revoked": revoke_script(keys=[store.user_key(user_id)])}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {touchSession} from 'sessions/state';
import {readSession, retireSession, userKey, userSessions} from 'sessions/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const SUMMARY_TTL_S = 3600;
/** user id → the listing and when it stops being served (ms). */
const summaryCache = new Map<string, {body: Record<string, unknown>; expires: number}>();

app.get('/v1/users/:userId/sessions', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {userId} = request.params as {userId: string};
  const me = await touchSession(String(request.headers['x-session-id'] ?? ''));
  if (me === null) return reply.code(401).send({error: 'no live session'});
  const now = Date.now();
  const hit = summaryCache.get(userId);
  if (hit !== undefined && now < hit.expires) return hit.body;
  const sessions = [];
  for (const sessionId of await userSessions(userId)) {
    const record = await readSession(sessionId);
    sessions.push({
      session_id: sessionId,
      device_class: record?.device_class ?? null,
      last_seen: record?.last_seen ?? null,
      rotation: record?.rotation ?? 0,
      current: sessionId === me.session_id,
    });
  }
  const body = {user_id: userId, sessions};
  summaryCache.set(userId, {body, expires: now + SUMMARY_TTL_S * 1000});
  return body;
});

app.delete('/v1/users/:userId/sessions', async (request, reply) => {
  const {userId} = request.params as {userId: string};
  const me = await touchSession(String(request.headers['x-session-id'] ?? ''));
  if (me === null) return reply.code(401).send({error: 'no live session'});
  const ids = await userSessions(userId);
  await redis.del(userKey(userId));
  summaryCache.delete(userId);
  return {revoked: ids.length};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {touchSession} from 'sessions/state';
import {readSession, retireSession, userKey, userSessions} from 'sessions/store';

export const app = Fastify();

/** KEYS: the user's set. Every session in it and the set itself, with nothing landing in between. */
export const REVOKE_ALL_LUA = \`
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
redis.call('DEL', KEYS[1])
return #ids
\`;

interface RevokeRedis extends Redis {
  revokeAll(usersKey: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as RevokeRedis;
redis.defineCommand('revokeAll', {numberOfKeys: 1, lua: REVOKE_ALL_LUA});

app.get('/v1/users/:userId/sessions', async (request, reply) => {
  const {userId} = request.params as {userId: string};
  const me = await touchSession(String(request.headers['x-session-id'] ?? ''));
  if (me === null) return reply.code(401).send({error: 'no live session'});
  // The path names whose page is asked for; the session says who is asking.
  if (me.user_id !== userId) return reply.code(403).send({error: 'these sessions are not yours'});
  const sessions = [];
  for (const sessionId of await userSessions(userId)) {
    const record = await readSession(sessionId);
    if (record === null) continue; // expired: its id outlives it in the set
    sessions.push({
      session_id: sessionId,
      device_class: record.device_class,
      last_seen: record.last_seen,
      rotation: record.rotation,
      current: sessionId === me.session_id,
    });
  }
  return {user_id: userId, sessions};
});

app.delete('/v1/users/:userId/sessions', async (request, reply) => {
  const {userId} = request.params as {userId: string};
  const me = await touchSession(String(request.headers['x-session-id'] ?? ''));
  if (me === null) return reply.code(401).send({error: 'no live session'});
  if (me.user_id !== userId) return reply.code(403).send({error: 'these sessions are not yours'});
  return {revoked: await redis.revokeAll(userKey(userId))};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"sessions/state" // state.TouchSession
	"sessions/store" // store.Session, UserKey, UserSessions, ReadSession, RetireSession
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const summaryTTL = time.Hour

type summary struct {
	body    map[string]any
	expires time.Time
}

// summaryCache holds user id → the listing and when it stops being served.
var summaryCache = map[string]summary{}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// caller is the live session making the request, or nil.
func caller(r *http.Request) *store.Session {
	me, _ := state.TouchSession(r.Context(), r.Header.Get("X-Session-Id"))
	return me
}

func listSessions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	userID := r.PathValue("id")
	me := caller(r)
	if me == nil {
		http.Error(rw, "no live session", http.StatusUnauthorized)
		return
	}
	now := time.Now()
	if hit, ok := summaryCache[userID]; ok && now.Before(hit.expires) {
		writeJSON(rw, http.StatusOK, hit.body)
		return
	}
	sessions := []map[string]any{}
	for _, sessionID := range store.UserSessions(r.Context(), userID) {
		record := store.ReadSession(r.Context(), sessionID)
		if record == nil {
			record = &store.Session{}
		}
		sessions = append(sessions, map[string]any{"session_id": sessionID, "device_class": record.DeviceClass, "last_seen": record.LastSeen,
			"rotation": record.Rotation, "current": sessionID == me.SessionID})
	}
	body := map[string]any{"user_id": userID, "sessions": sessions}
	summaryCache[userID] = summary{body: body, expires: now.Add(summaryTTL)}
	writeJSON(rw, http.StatusOK, body)
}

func revokeAll(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if caller(r) == nil {
		http.Error(rw, "no live session", http.StatusUnauthorized)
		return
	}
	ids := store.UserSessions(r.Context(), userID)
	rdb.Del(r.Context(), store.UserKey(userID))
	delete(summaryCache, userID)
	writeJSON(rw, http.StatusOK, map[string]int{"revoked": len(ids)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{id}/sessions", listSessions)
	mux.HandleFunc("DELETE /v1/users/{id}/sessions", revokeAll)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"sessions/state" // state.TouchSession
	"sessions/store" // store.Session, UserKey, UserSessions, ReadSession, RetireSession
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// revokeAllScript: KEYS the user's set. Every session in it and the set itself, with nothing landing in between.
var revokeAllScript = redis.NewScript(\`
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
redis.call('DEL', KEYS[1])
return #ids
\`)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// authorize is the live session making the request if it is the path's user's; otherwise it answers 401 or 403 and returns nil.
func authorize(rw http.ResponseWriter, r *http.Request, userID string) *store.Session {
	me, err := state.TouchSession(r.Context(), r.Header.Get("X-Session-Id"))
	if err != nil || me == nil {
		http.Error(rw, "no live session", http.StatusUnauthorized)
		return nil
	}
	// The path names whose page is asked for; the session says who is asking.
	if me.UserID != userID {
		http.Error(rw, "these sessions are not yours", http.StatusForbidden)
		return nil
	}
	return me
}

func listSessions(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	me := authorize(rw, r, userID)
	if me == nil {
		return
	}
	sessions := []map[string]any{}
	for _, sessionID := range store.UserSessions(r.Context(), userID) {
		record := store.ReadSession(r.Context(), sessionID)
		if record == nil {
			continue // expired: its id outlives it in the set
		}
		sessions = append(sessions, map[string]any{"session_id": sessionID, "device_class": record.DeviceClass, "last_seen": record.LastSeen,
			"rotation": record.Rotation, "current": sessionID == me.SessionID})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"user_id": userID, "sessions": sessions})
}

func revokeAll(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if authorize(rw, r, userID) == nil {
		return
	}
	revoked, err := revokeAllScript.Run(r.Context(), rdb, []string{store.UserKey(userID)}).Int64()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]int64{"revoked": revoked})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{id}/sessions", listSessions)
	mux.HandleFunc("DELETE /v1/users/{id}/sessions", revokeAll)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import sessions.{State, Store} // State.touchSession; Store.userKey, userSessions, readSession, retireSession

object SessionsRead {
  val SummaryTtlS = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  /** user id → the listing and when it stops being served (ms). */
  private val summaryCache = scala.collection.concurrent.TrieMap.empty[String, (JsObject, Long)]

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def listing(userId: String, me: Store.Session): JsObject = {
    val sessions = Store.userSessions(userId).map { id =>
      val record = Store.readSession(id)
      JsObject(
        "session_id" -> JsString(id),
        "device_class" -> record.map(r => JsString(r.deviceClass)).getOrElse(JsNull),
        "last_seen" -> record.map(r => JsNumber(r.lastSeen)).getOrElse(JsNull),
        "rotation" -> JsNumber(record.map(_.rotation).getOrElse(0L)),
        "current" -> JsBoolean(id == me.sessionId))
    }
    JsObject("user_id" -> JsString(userId), "sessions" -> JsArray(sessions.toVector))
  }

  val route: Route = path("v1" / "users" / Segment / "sessions") { userId =>
    optionalHeaderValueByName("X-Session-Id") { sessionId =>
      // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
      State.touchSession(sessionId.getOrElse("")) match {
        case None => complete(StatusCodes.Unauthorized -> "no live session")
        case Some(me) =>
          concat(
            get {
              val now = System.currentTimeMillis()
              val body = summaryCache.get(userId).filter(_._2 > now).map(_._1).getOrElse {
                val fresh = listing(userId, me)
                summaryCache.put(userId, (fresh, now + SummaryTtlS * 1000))
                fresh
              }
              complete(json(body))
            },
            delete {
              val ids = Store.userSessions(userId)
              jedis.del(Store.userKey(userId))
              summaryCache.remove(userId)
              complete(json(JsObject("revoked" -> JsNumber(ids.size))))
            },
          )
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import sessions.{State, Store} // State.touchSession; Store.userKey, userSessions, readSession, retireSession

object SessionsRead {
  private val jedis = new JedisPooled("redis", 6379)

  /** KEYS: the user's set. Every session in it and the set itself, with nothing landing in between. */
  val RevokeAllLua: String =
    """local ids = redis.call('SMEMBERS', KEYS[1])
      |for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
      |redis.call('DEL', KEYS[1])
      |return #ids
      |""".stripMargin

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def listing(userId: String, me: Store.Session): JsObject = {
    // An expired session's id outlives it in the set: list only what still reads.
    val sessions = Store.userSessions(userId).flatMap(Store.readSession).map { record =>
      JsObject(
        "session_id" -> JsString(record.sessionId),
        "device_class" -> JsString(record.deviceClass),
        "last_seen" -> JsNumber(record.lastSeen),
        "rotation" -> JsNumber(record.rotation),
        "current" -> JsBoolean(record.sessionId == me.sessionId))
    }
    JsObject("user_id" -> JsString(userId), "sessions" -> JsArray(sessions.toVector))
  }

  val route: Route = path("v1" / "users" / Segment / "sessions") { userId =>
    optionalHeaderValueByName("X-Session-Id") { sessionId =>
      State.touchSession(sessionId.getOrElse("")) match {
        case None => complete(StatusCodes.Unauthorized -> "no live session")
        // The path names whose page is asked for; the session says who is asking.
        case Some(me) if me.userId != userId => complete(StatusCodes.Forbidden -> "these sessions are not yours")
        case Some(me) =>
          concat(
            get {
              complete(json(listing(userId, me)))
            },
            delete {
              val revoked = jedis.eval(RevokeAllLua, List(Store.userKey(userId)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long]
              complete(json(JsObject("revoked" -> JsNumber(revoked.longValue))))
            },
          )
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <string>

#include "sessions/state.h"  // state::touchSession
#include "sessions/store.h"  // store::Session, redis, userKey, userSessions, readSession, retireSession

using json = nlohmann::json;

constexpr std::chrono::seconds kSummaryTtl{3600};

struct Summary {
  json body;
  std::chrono::system_clock::time_point expires;
};

// user id → the listing and when it stops being served.
std::map<std::string, Summary> summary_cache;

void list_sessions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string user_id = req.matches[1];
  const auto me = state::touchSession(req.get_header_value("X-Session-Id"));
  if (!me) {
    res.status = 401;
    res.set_content("no live session", "text/plain");
    return;
  }
  const auto now = std::chrono::system_clock::now();
  const auto hit = summary_cache.find(user_id);
  if (hit != summary_cache.end() && now < hit->second.expires) {
    res.set_content(hit->second.body.dump(), "application/json");
    return;
  }
  json sessions = json::array();
  for (const std::string& session_id : store::userSessions(user_id)) {
    const store::Session record = store::readSession(session_id).value_or(store::Session{});
    sessions.push_back(json{{"session_id", session_id}, {"device_class", record.device_class}, {"last_seen", record.last_seen},
                            {"rotation", record.rotation}, {"current", session_id == me->session_id}});
  }
  const json body = {{"user_id", user_id}, {"sessions", sessions}};
  summary_cache[user_id] = Summary{body, now + kSummaryTtl};
  res.set_content(body.dump(), "application/json");
}

void revoke_all(const httplib::Request& req, httplib::Response& res) {
  const std::string user_id = req.matches[1];
  if (!state::touchSession(req.get_header_value("X-Session-Id"))) {
    res.status = 401;
    res.set_content("no live session", "text/plain");
    return;
  }
  const auto ids = store::userSessions(user_id);
  store::redis().del(store::userKey(user_id));
  summary_cache.erase(user_id);
  res.set_content(json{{"revoked", ids.size()}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/users/([\\w-]+)/sessions)", list_sessions);
  svr.Delete(R"(/v1/users/([\\w-]+)/sessions)", revoke_all);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "sessions/state.h"  // state::touchSession
#include "sessions/store.h"  // store::Session, redis, userKey, userSessions, readSession, retireSession

using json = nlohmann::json;

// KEYS: the user's set. Every session in it and the set itself, with nothing landing in between.
const std::string kRevokeAllLua = R"lua(
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', 'session:' .. id) end
redis.call('DEL', KEYS[1])
return #ids
)lua";

// The live session making the request if it is the path's user's; otherwise answers 401 or 403 and returns none.
std::optional<store::Session> authorize(const httplib::Request& req, httplib::Response& res, const std::string& user_id) {
  const auto me = state::touchSession(req.get_header_value("X-Session-Id"));
  if (!me) {
    res.status = 401;
    res.set_content("no live session", "text/plain");
    return std::nullopt;
  }
  // The path names whose page is asked for; the session says who is asking.
  if (me->user_id != user_id) {
    res.status = 403;
    res.set_content("these sessions are not yours", "text/plain");
    return std::nullopt;
  }
  return me;
}

void list_sessions(const httplib::Request& req, httplib::Response& res) {
  const std::string user_id = req.matches[1];
  const auto me = authorize(req, res, user_id);
  if (!me) return;
  json sessions = json::array();
  for (const std::string& session_id : store::userSessions(user_id)) {
    const auto record = store::readSession(session_id);
    if (!record) continue;  // expired: its id outlives it in the set
    sessions.push_back(json{{"session_id", session_id}, {"device_class", record->device_class}, {"last_seen", record->last_seen},
                            {"rotation", record->rotation}, {"current", session_id == me->session_id}});
  }
  res.set_content(json{{"user_id", user_id}, {"sessions", sessions}}.dump(), "application/json");
}

void revoke_all(const httplib::Request& req, httplib::Response& res) {
  const std::string user_id = req.matches[1];
  if (!authorize(req, res, user_id)) return;
  const long long revoked = store::redis().eval<long long>(kRevokeAllLua, {store::userKey(user_id)}, {});
  res.set_content(json{{"revoked", revoked}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/users/([\\w-]+)/sessions)", list_sessions);
  svr.Delete(R"(/v1/users/([\\w-]+)/sessions)", revoke_all);
}
`,
    },
  },
  harness: {
    python: `from sessions import store
from sessions.state import touch_session

ME = {"X-Session-Id": "s-1"}


def _api(ctx):
    store.put_session("s-1", "u-1", "mobile", "tok-1")
    store.put_session("s-2", "u-1", "desktop", "tok-2")
    store.put_session("s-9", "u-2", "mobile", "tok-9")
    return ctx.client(ctx.load("read").app)


async def _list(c, user_id="u-1"):
    r = await c.get(f"/v1/users/{user_id}/sessions", headers=ME)
    assert r.status_code == 200, f"GET /v1/users/{user_id}/sessions as {user_id}'s own session answered {r.status_code}: {r.text}"
    return {s["session_id"]: s for s in r.json().get("sessions", [])}


async def check_authz(ctx):
    async with _api(ctx) as c:
        mine = await _list(c)
        assert sorted(mine) == ["s-1", "s-2"], f"u-1's page lists {sorted(mine)}, expected s-1 and s-2"
        anonymous = await c.get("/v1/users/u-1/sessions")
        assert anonymous.status_code == 401, f"a request without a session answered {anonymous.status_code}, expected 401"
        theirs = await c.get("/v1/users/u-2/sessions", headers=ME)
        assert theirs.status_code == 403, f"u-1 asking for u-2's sessions got {theirs.status_code}: {theirs.text}. The path names whose page; the session says who asks: 403"
        signout = await c.delete("/v1/users/u-2/sessions", headers=ME)
        assert signout.status_code == 403, f"u-1 signing u-2 out everywhere got {signout.status_code}, expected 403"
    assert store.read_session("s-9") is not None, "u-1 signed u-2's session s-9 out"


async def check_active_only(ctx):
    async with _api(ctx) as c:
        ctx.clock.advance(600)
        touch_session("s-1")
        ctx.clock.advance(600)  # s-2 has been idle 20 minutes: expired, its id still in the set
        listed = await _list(c)
    assert sorted(listed) == ["s-1"], f"u-1's page lists {sorted(listed)} ({list(listed.values())}): s-2 expired 5 minutes ago and must not be listed"


async def check_last_seen(ctx):
    async with _api(ctx) as c:
        await _list(c)
        ctx.clock.advance(300)
        listed = await _list(c)
    now = int(ctx.clock.time())
    seen = listed.get("s-1", {}).get("last_seen")
    assert isinstance(seen, int) and now - seen <= 60, f"the caller's own session shows last_seen {seen}, {now - (seen or 0)} s before now: the page must read the records, not an hour-old summary"


async def check_revoke_all(ctx):
    async with _api(ctx) as c:
        r = await c.delete("/v1/users/u-1/sessions", headers=ME)
        assert r.status_code == 200 and r.json().get("revoked") == 2, f"sign out everywhere answered {r.status_code} {r.text}, expected 200 {{revoked: 2}}"
        live = [s for s in ("s-1", "s-2") if store.read_session(s) is not None]
        assert not live, f"after sign out everywhere the sessions {live} still read: every device is still signed in"
        assert store.user_sessions("u-1") == [], f"u-1's set still holds {store.user_sessions('u-1')}"
        again = await c.get("/v1/users/u-1/sessions", headers=ME)
    assert again.status_code == 401, f"the revoked caller's own id answered {again.status_code}, expected 401"
    assert store.read_session("s-9") is not None, "u-2's session must survive u-1's sign out"


async def check_revoke_race(ctx):
    def login():
        """Another tab of u-1 logs in right now: the session and its set entry, as put_session writes them."""
        ctx.redis.hset("session:s-3", mapping={"user_id": "u-1", "device_class": "tablet", "token_hash": "h", "created_at": int(ctx.clock.time()), "last_seen": int(ctx.clock.time()), "rotation": 0})
        ctx.redis.expire("session:s-3", store.SLIDING_TTL_S)
        ctx.redis.sadd("user:u-1:sessions", "s-3")

    async with _api(ctx) as c:
        probe = ctx.redis_after("user:u-1:sessions", login)
        r = await c.delete("/v1/users/u-1/sessions", headers=ME)
    assert r.status_code == 200, f"sign out everywhere answered {r.status_code}: {r.text}"
    assert probe.fired, "sign out everywhere never touched user:u-1:sessions"
    live = ctx.redis.exists("session:s-3") == 1
    listed = ctx.redis.sismember("user:u-1:sessions", "s-3")
    assert not live or listed, "a login landed between reading u-1's set and deleting it: session s-3 is live but no longer in the set, so no page lists it and no sign-out reaches it. Read the set and delete in one script"
`,
    typescript: `const ME = {'X-Session-Id': 's-1'};

async function api(ctx) {
  const store = ctx.load('/support/sessions/store.ts');
  await store.putSession('s-1', 'u-1', 'mobile', 'tok-1');
  await store.putSession('s-2', 'u-1', 'desktop', 'tok-2');
  await store.putSession('s-9', 'u-2', 'mobile', 'tok-9');
  return {c: ctx.client(ctx.load('read').app), store, state: ctx.load('/support/sessions/state.ts')};
}

async function list(c, userId = 'u-1') {
  const r = await c.get(\`/v1/users/\${userId}/sessions\`, {headers: ME});
  assert.equal(r.status, 200, \`GET /v1/users/\${userId}/sessions as \${userId}'s own session answered \${r.status}: \${r.text}\`);
  return Object.fromEntries((r.json().sessions ?? []).map(s => [s.session_id, s]));
}

export async function check_authz(ctx) {
  const {c, store} = await api(ctx);
  const mine = await list(c);
  assert.deepEqual(Object.keys(mine).sort(), ['s-1', 's-2'], \`u-1's page lists \${JSON.stringify(Object.keys(mine))}, expected s-1 and s-2\`);
  const anonymous = await c.get('/v1/users/u-1/sessions');
  assert.equal(anonymous.status, 401, \`a request without a session answered \${anonymous.status}, expected 401\`);
  const theirs = await c.get('/v1/users/u-2/sessions', {headers: ME});
  assert.equal(theirs.status, 403, \`u-1 asking for u-2's sessions got \${theirs.status}: \${theirs.text}. The path names whose page; the session says who asks: 403\`);
  const signout = await c.delete('/v1/users/u-2/sessions', {headers: ME});
  assert.equal(signout.status, 403, \`u-1 signing u-2 out everywhere got \${signout.status}, expected 403\`);
  assert((await store.readSession('s-9')) !== null, "u-1 signed u-2's session s-9 out");
}

export async function check_active_only(ctx) {
  const {c, state} = await api(ctx);
  ctx.clock.advance(600);
  await state.touchSession('s-1');
  ctx.clock.advance(600); // s-2 has been idle 20 minutes: expired, its id still in the set
  const listed = await list(c);
  assert.deepEqual(Object.keys(listed), ['s-1'], \`u-1's page lists \${JSON.stringify(Object.values(listed))}: s-2 expired 5 minutes ago and must not be listed\`);
}

export async function check_last_seen(ctx) {
  const {c} = await api(ctx);
  await list(c);
  ctx.clock.advance(300);
  const listed = await list(c);
  const now = Math.floor(ctx.clock.now() / 1000);
  const seen = listed['s-1']?.last_seen;
  assert(typeof seen === 'number' && now - seen <= 60, \`the caller's own session shows last_seen \${seen}, \${now - (seen ?? 0)} s before now: the page must read the records, not an hour-old summary\`);
}

export async function check_revoke_all(ctx) {
  const {c, store} = await api(ctx);
  const r = await c.delete('/v1/users/u-1/sessions', {headers: ME});
  assert(r.status === 200 && r.json().revoked === 2, \`sign out everywhere answered \${r.status} \${r.text}, expected 200 {revoked: 2}\`);
  const live = [];
  for (const id of ['s-1', 's-2']) if ((await store.readSession(id)) !== null) live.push(id);
  assert.deepEqual(live, [], \`after sign out everywhere the sessions \${JSON.stringify(live)} still read: every device is still signed in\`);
  assert.deepEqual(await store.userSessions('u-1'), [], "u-1's set must be gone");
  const again = await c.get('/v1/users/u-1/sessions', {headers: ME});
  assert.equal(again.status, 401, \`the revoked caller's own id answered \${again.status}, expected 401\`);
  assert((await store.readSession('s-9')) !== null, "u-2's session must survive u-1's sign out");
}

export async function check_revoke_race(ctx) {
  const {c} = await api(ctx);
  const now = String(Math.floor(ctx.clock.now() / 1000));
  // Another tab of u-1 logs in right now: the session and its set entry, as putSession writes them.
  const probe = ctx.redisAfter('user:u-1:sessions', () => {
    ctx.redis.hset('session:s-3', 'user_id', 'u-1', 'device_class', 'tablet', 'token_hash', 'h', 'created_at', now, 'last_seen', now, 'rotation', '0');
    ctx.redis.expire('session:s-3', 900);
    ctx.redis.sadd('user:u-1:sessions', 's-3');
  });
  const r = await c.delete('/v1/users/u-1/sessions', {headers: ME});
  assert.equal(r.status, 200, \`sign out everywhere answered \${r.status}: \${r.text}\`);
  assert(probe.fired, 'sign out everywhere never touched user:u-1:sessions');
  const live = ctx.redis.exists('session:s-3') === 1;
  const listed = ctx.redis.sismember('user:u-1:sessions', 's-3') === 1;
  assert(!live || listed, "a login landed between reading u-1's set and deleting it: session s-3 is live but no longer in the set, so no page lists it and no sign-out reaches it. Read the set and delete in one script");
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"

	"sessions/state"
	"sessions/store"

	"leetbuild/harness"
)

var bg = context.Background()

type listed struct {
	SessionID   string \`json:"session_id"\`
	DeviceClass string \`json:"device_class"\`
	LastSeen    int64  \`json:"last_seen"\`
	Rotation    int64  \`json:"rotation"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.NoError(store.PutSession(bg, "s-1", "u-1", "mobile", "tok-1"), "PutSession")
	ctx.NoError(store.PutSession(bg, "s-2", "u-1", "desktop", "tok-2"), "PutSession")
	ctx.NoError(store.PutSession(bg, "s-9", "u-2", "mobile", "tok-9"), "PutSession")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func list(ctx *harness.Ctx, c *harness.HTTP) map[string]listed {
	r := c.Get("/v1/users/u-1/sessions", "X-Session-Id", "s-1")
	ctx.Equal(r.Status, 200, "GET /v1/users/u-1/sessions as u-1's own session (%s)", r.Text())
	var body struct {
		Sessions []listed \`json:"sessions"\`
	}
	r.Decode(&body)
	out := map[string]listed{}
	for _, s := range body.Sessions {
		out[s.SessionID] = s
	}
	return out
}

func ids(m map[string]listed) []string {
	out := []string{}
	for id := range m {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func CheckAuthz(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Equal(ids(list(ctx, c)), []string{"s-1", "s-2"}, "u-1's page")
	ctx.Equal(c.Get("/v1/users/u-1/sessions").Status, 401, "a request without a session")
	theirs := c.Get("/v1/users/u-2/sessions", "X-Session-Id", "s-1")
	ctx.Equal(theirs.Status, 403, "u-1 asking for u-2's sessions (%s): the path names whose page, the session says who asks", theirs.Text())
	ctx.Equal(c.Delete("/v1/users/u-2/sessions", "X-Session-Id", "s-1").Status, 403, "u-1 signing u-2 out everywhere")
	ctx.Assert(store.ReadSession(bg, "s-9") != nil, "u-1 signed u-2's session s-9 out")
}

func CheckActiveOnly(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Clock.Advance(600)
	_, err := state.TouchSession(bg, "s-1")
	ctx.NoError(err, "TouchSession")
	ctx.Clock.Advance(600) // s-2 has been idle 20 minutes: expired, its id still in the set
	page := list(ctx, c)
	ctx.Equal(ids(page), []string{"s-1"}, "s-2 expired 5 minutes ago and must not be listed (%v); u-1's page", page)
}

func CheckLastSeen(ctx *harness.Ctx) {
	c := api(ctx)
	list(ctx, c)
	ctx.Clock.Advance(300)
	seen := list(ctx, c)["s-1"].LastSeen
	now := ctx.Clock.Now() / 1000
	ctx.Assert(now-seen <= 60, "the caller's own session shows last_seen %d, %d s before now: the page must read the records, not an hour-old summary", seen, now-seen)
}

func CheckRevokeAll(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Delete("/v1/users/u-1/sessions", "X-Session-Id", "s-1")
	var body struct {
		Revoked int \`json:"revoked"\`
	}
	r.Decode(&body)
	ctx.Assert(r.Status == 200 && body.Revoked == 2, "sign out everywhere answered %d %s, expected 200 {revoked: 2}", r.Status, r.Text())
	for _, id := range []string{"s-1", "s-2"} {
		ctx.Assert(store.ReadSession(bg, id) == nil, "after sign out everywhere the session %s still reads: every device is still signed in", id)
	}
	ctx.Equal(len(store.UserSessions(bg, "u-1")), 0, "u-1's set must be gone; its ids")
	ctx.Equal(c.Get("/v1/users/u-1/sessions", "X-Session-Id", "s-1").Status, 401, "the revoked caller's own id")
	ctx.Assert(store.ReadSession(bg, "s-9") != nil, "u-2's session must survive u-1's sign out")
}

func CheckRevokeRace(ctx *harness.Ctx) {
	c := api(ctx)
	now := ctx.Clock.Now() / 1000
	// Another tab of u-1 logs in right now: the session and its set entry, as PutSession writes them.
	probe := ctx.Redis.After("user:u-1:sessions", func() any {
		ctx.Redis.Do("HSET", "session:s-3", "user_id", "u-1", "device_class", "tablet", "token_hash", "h", "created_at", now, "last_seen", now, "rotation", 0)
		ctx.Redis.Do("EXPIRE", "session:s-3", 900)
		ctx.Redis.Do("SADD", "user:u-1:sessions", "s-3")
		return nil
	})
	r := c.Delete("/v1/users/u-1/sessions", "X-Session-Id", "s-1")
	ctx.Equal(r.Status, 200, "sign out everywhere (%s)", r.Text())
	ctx.Assert(probe.Fired, "sign out everywhere never touched user:u-1:sessions")
	live := ctx.Redis.Exists("session:s-3") == 1
	ctx.Assert(!live || ctx.Redis.SIsMember("user:u-1:sessions", "s-3"), "a login landed between reading u-1's set and deleting it: session s-3 is live but no longer in the set, so no page lists it and no sign-out reaches it. Read the set and delete in one script")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "sessions/state.h"
#include "sessions/store.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  store::putSession("s-1", "u-1", "mobile", "tok-1");
  store::putSession("s-2", "u-1", "desktop", "tok-2");
  store::putSession("s-9", "u-2", "mobile", "tok-9");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::map<std::string, nlohmann::json> list(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Get("/v1/users/u-1/sessions", "X-Session-Id", "s-1");
  ctx.Equal(r.Status, 200, "GET /v1/users/u-1/sessions as u-1's own session (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  std::map<std::string, nlohmann::json> out;
  if (body.is_object() && body.contains("sessions") && body["sessions"].is_array()) {
    for (const auto& s : body["sessions"]) out[s.value("session_id", "")] = s;
  }
  return out;
}

std::vector<std::string> ids(const std::map<std::string, nlohmann::json>& m) {
  std::vector<std::string> out;
  for (const auto& [id, _] : m) out.push_back(id);
  return out;
}

}  // namespace

void CheckAuthz(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(ids(list(ctx, c)), {"s-1", "s-2"}, "u-1's page");
  ctx.Equal(c.Get("/v1/users/u-1/sessions").Status, 401, "a request without a session");
  const auto theirs = c.Get("/v1/users/u-2/sessions", "X-Session-Id", "s-1");
  ctx.Equal(theirs.Status, 403, "u-1 asking for u-2's sessions (%s): the path names whose page, the session says who asks", theirs.Text());
  ctx.Equal(c.Delete("/v1/users/u-2/sessions", "X-Session-Id", "s-1").Status, 403, "u-1 signing u-2 out everywhere");
  ctx.Assert(store::readSession("s-9").has_value(), "u-1 signed u-2's session s-9 out");
}

void CheckActiveOnly(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Clock.Advance(600);
  state::touchSession("s-1");
  ctx.Clock.Advance(600);  // s-2 has been idle 20 minutes: expired, its id still in the set
  ctx.Equal(ids(list(ctx, c)), {"s-1"}, "s-2 expired 5 minutes ago and must not be listed; u-1's page");
}

void CheckLastSeen(harness::Ctx& ctx) {
  auto c = api(ctx);
  list(ctx, c);
  ctx.Clock.Advance(300);
  const auto page = list(ctx, c);
  const long long seen = page.count("s-1") && page.at("s-1")["last_seen"].is_number() ? page.at("s-1")["last_seen"].get<long long>() : 0;
  const long long now = ctx.Clock.Now() / 1000;
  ctx.Assert(now - seen <= 60, "the caller's own session shows last_seen %d, %d s before now: the page must read the records, not an hour-old summary", seen, now - seen);
}

void CheckRevokeAll(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Delete("/v1/users/u-1/sessions", "X-Session-Id", "s-1");
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(r.Status == 200 && body.is_object() && body.value("revoked", 0) == 2, "sign out everywhere answered %d %s, expected 200 {revoked: 2}", r.Status, r.Text());
  for (const std::string id : {"s-1", "s-2"}) {
    ctx.Assert(!store::readSession(id).has_value(), "after sign out everywhere the session %s still reads: every device is still signed in", id);
  }
  ctx.Equal(store::userSessions("u-1").size(), 0, "u-1's set must be gone; its ids");
  ctx.Equal(c.Get("/v1/users/u-1/sessions", "X-Session-Id", "s-1").Status, 401, "the revoked caller's own id");
  ctx.Assert(store::readSession("s-9").has_value(), "u-2's session must survive u-1's sign out");
}

void CheckRevokeRace(harness::Ctx& ctx) {
  auto c = api(ctx);
  const long long now = ctx.Clock.Now() / 1000;
  bool fired = false;
  // Another tab of u-1 logs in right now: the session and its set entry, as putSession writes them.
  ctx.Redis.After("user:u-1:sessions", [&] {
    fired = true;
    ctx.Redis.Do("HSET", "session:s-3", "user_id", "u-1", "device_class", "tablet", "token_hash", "h", "created_at", now, "last_seen", now, "rotation", 0);
    ctx.Redis.Do("EXPIRE", "session:s-3", 900);
    ctx.Redis.Do("SADD", "user:u-1:sessions", "s-3");
  });
  const auto r = c.Delete("/v1/users/u-1/sessions", "X-Session-Id", "s-1");
  ctx.Equal(r.Status, 200, "sign out everywhere (%s)", r.Text());
  ctx.Assert(fired, "sign out everywhere never touched user:u-1:sessions");
  const bool live = ctx.Redis.Exists("session:s-3") == 1;
  ctx.Assert(!live || ctx.Redis.SIsMember("user:u-1:sessions", "s-3"),
             "a login landed between reading u-1's set and deleting it: session s-3 is live but no longer in the set, so no page lists it and no sign-out reaches it. Read the set and delete in one script");
}
`,
  },
  hints: [
    "Sign in as u-1 and open u-2's session page: it loads. Let a laptop sit idle past fifteen minutes: the page still lists it. Press sign out everywhere, then use the phone again: it is still signed in.",
    "Neither route compares the caller's `user_id` with the path; the listing turns a missing record into an entry and is cached for an hour; sign-out deletes the set but no session, reading it in one command and deleting it in another.",
    '403 unless `me["user_id"] == user_id`; drop `summary_cache` and `continue` past ids whose `read_session` is `None`; for sign-out run one Lua script: `SMEMBERS`, `DEL \'session:\' .. id` for each, then `DEL` the set.',
  ],
  debrief: `The session page is security UI, so the path parameter is a request, not an identity: the caller's own session says whose page this is, and a mismatch is 403 before anything is read. A cached listing is wrong in exactly the fields users check (which devices, when last seen), and the set is an index that lags expiry, so each id is confirmed against its record. Sign-out is one script because its read and its deletes must see the same set: in two steps, a login landing between them leaves a live session that nobody can list or revoke. Production systems also prune dead ids from the set, show a coarse location and client name beside the device class, and push the revocation to every service that caches sessions.`,
};
