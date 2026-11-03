import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/sessions/{id}/context: the newest turns within budget, cached per tenant and turn',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/sessions/{id}/context\` with the bearer key: it
returns the body cached under \`context:{session_id}\` when there is one; otherwise it reads
\`summaries.latest_summary\` and \`buffer.recent_turns\`, keeps turns from the oldest while they fit
in \`MAX_CONTEXT_TOKENS\` = 6000, caches \`{session_id, summary, turns, tokens}\` for 60 s and returns
it (404 for a session with no turns). It serves the demo and hides four flaws.

**Failure mode the checks target.** A long conversation's context ends 20 turns before the user's
last question; with a summary the model receives more than 6000 tokens; a read right after an
append misses the new turn; and tenant B, reading its own session \`s-1\`, gets tenant A's cached
conversation.

- Keep the **newest** turns: walk from the newest, stop at the first one that does not fit, and
  return the kept turns oldest first.
- The summary counts against the budget: \`count_tokens\` of the summary plus the kept turns is at
  most 6000, and \`tokens\` reports that sum.
- Cache under \`context:{tenant}:{session_id}:{latest_turn_id}\` (\`sessions.latest_turn_id\`) for 60 s,
  so a new turn or another tenant is another entry.`,
  sequence: {
    participants: ['Chat client', 'Memory API', 'Redis'],
    messages: [
      {from: 'Chat client', to: 'Memory API', label: 'GET /v1/sessions/s-1/context · Bearer key', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'latest_turn_id → t-50 · GET context:t1:s-1:t-50', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'miss: latest_summary · recent_turns', kind: 'sync'},
      {from: 'Memory API', to: 'Memory API', label: 'summary tokens + newest turns ≤ 6000', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'SET context:t1:s-1:t-50 EX 60', kind: 'sync'},
      {from: 'Memory API', to: 'Chat client', label: '200 {summary, turns: [{turn_id, …}], tokens}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'context-route',
      title: 'Serves the summary and the turns with their ids',
      detail:
        'Register `GET /v1/sessions/{id}/context`: an authenticated read answers the latest summary and the turns oldest first, each with its `turn_id`; no key is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/sessions\/\{session_id\}\/context["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/sessions\/:sessionId\/context['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/sessions\/\{id\}\/context"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sessions"\s*\/\s*Segment\s*\/\s*"context"\s*\)/]},
        cpp: {all: [/svr\.Get\([^\n]*\/v1\/sessions\/[^\n]*\/context/]},
      },
    },
    {
      id: 'newest-kept',
      title: 'Drops the oldest turns, not the newest',
      detail:
        'The budget is spent from the newest turn backwards and the kept turns are returned oldest first; the starter walks from the oldest, so a long conversation loses the turns the model is answering.',
      match: {
        python: {all: [/reversed\(|\[::-1\]/], none: [/for turn in turns:/]},
        typescript: {all: [/\.reverse\(\)/], none: [/for \(const turn of turns\)/]},
        go: {all: [/turns\[\w+\s*-\s*1\]|:= len\(turns\)\s*-\s*1/], none: [/range turns/]},
        scala: {all: [/turns\.reverseIterator|turns\.reverse\b/], none: [/turns\.iterator/]},
        cpp: {all: [/turns\.rbegin\(\)/], none: [/for \(const (auto|sessions::Turn)& turn : turns\)/]},
      },
    },
    {
      id: 'summary-in-budget',
      title: 'Counts the summary against the 6000 tokens',
      detail:
        'The summary is part of the prompt: its `count_tokens` is spent before any turn, and `tokens` reports the summary plus the kept turns; the starter budgets the turns alone.',
      match: {
        python: {all: [/count_tokens\(\s*summary\[/]},
        typescript: {all: [/countTokens\(\s*summary\.text\s*\)/]},
        go: {all: [/CountTokens\(\s*summary\.Text\s*\)/]},
        scala: {all: [/Sessions\.countTokens\(\s*\w+\.text\s*\)/]},
        cpp: {all: [/countTokens\(\s*summary->text\s*\)/]},
      },
    },
    {
      id: 'fresh-cache',
      title: 'Keys the cache by the latest turn',
      detail:
        'The cache key ends with `sessions.latest_turn_id`, so an append changes the key and the next read assembles the new context; the starter keeps one entry per session for 60 s.',
      match: {
        python: {all: [/sessions\.latest_turn_id\(/, /context:[^\n]*\{latest\w*\}/]},
        typescript: {all: [/latestTurnId\(/, /context:[^\n]*\$\{latest\w*\}/]},
        go: {all: [/sessions\.LatestTurnID\(/, /sessionID\s*\+\s*":"\s*\+\s*latest/]},
        scala: {all: [/Sessions\.latestTurnId\(/, /s"context:[^"\n]*\$\{?latest/]},
        cpp: {all: [/sessions::latestTurnId\(/, /session_id\s*\+\s*":"\s*\+\s*latest/]},
      },
    },
    {
      id: 'tenant-cache',
      title: 'Keys the cache by tenant',
      detail:
        "The cache key starts with the tenant (`context:{tenant}:…`), so two tenants that both have a session `s-1` read their own contexts; the starter's `context:{session_id}` serves whichever tenant read first.",
      match: {
        python: {all: [/context:\{tenant\}:/], none: [/f["']context:\{session_id\}/]},
        typescript: {all: [/context:\$\{tenant\}:/], none: [/`context:\$\{sessionId\}/]},
        go: {all: [/"context:"\s*\+\s*tenant/], none: [/"context:"\s*\+\s*sessionID/]},
        scala: {all: [/s"context:\$tenant:/], none: [/s"context:\$sessionId/]},
        cpp: {all: [/"context:"\s*\+\s*\*?tenant/], none: [/"context:"\s*\+\s*session_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException, Request

from memory import buffer, sessions, summaries  # recent_turns; tenant_for_key, latest_turn_id, count_tokens; latest_summary

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_CONTEXT_TOKENS = 6000
CACHE_TTL_S = 60


@app.get("/v1/sessions/{session_id}/context")
def read_context(session_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = sessions.tenant_for_key(request.headers.get("authorization", "").removeprefix("Bearer "))
    if tenant is None:
        raise HTTPException(status_code=401, detail="a valid API key is required")
    key = f"context:{session_id}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    summary = summaries.latest_summary(tenant, session_id)
    turns = buffer.recent_turns(tenant, session_id)
    if not turns:
        raise HTTPException(status_code=404, detail="no such session")
    kept, used = [], 0
    for turn in turns:
        if used + turn["tokens"] > MAX_CONTEXT_TOKENS:
            break
        kept.append(turn)
        used += turn["tokens"]
    body = {"session_id": session_id, "summary": summary["text"] if summary else None, "turns": kept, "tokens": used}
    r.set(key, json.dumps(body), ex=CACHE_TTL_S)
    return body
`,
      solution: `import json

import redis
from fastapi import FastAPI, HTTPException, Request

from memory import buffer, sessions, summaries  # recent_turns; tenant_for_key, latest_turn_id, count_tokens; latest_summary

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_CONTEXT_TOKENS = 6000
CACHE_TTL_S = 60


@app.get("/v1/sessions/{session_id}/context")
def read_context(session_id: str, request: Request) -> dict:
    tenant = sessions.tenant_for_key(request.headers.get("authorization", "").removeprefix("Bearer "))
    if tenant is None:
        raise HTTPException(status_code=401, detail="a valid API key is required")
    # The key names the tenant and the newest turn: another tenant, or a new turn, is another entry.
    latest = sessions.latest_turn_id(tenant, session_id)
    key = f"context:{tenant}:{session_id}:{latest}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    summary = summaries.latest_summary(tenant, session_id)
    turns = buffer.recent_turns(tenant, session_id)
    if not turns:
        raise HTTPException(status_code=404, detail="no such session")
    # The summary is part of the prompt: it pays from the same budget, first.
    kept, used = [], sessions.count_tokens(summary["text"]) if summary else 0
    for turn in reversed(turns):  # newest first: when the budget runs out, the oldest are left behind
        if used + turn["tokens"] > MAX_CONTEXT_TOKENS:
            break
        kept.append(turn)
        used += turn["tokens"]
    kept.reverse()
    body = {"session_id": session_id, "summary": summary["text"] if summary else None, "turns": kept, "tokens": used}
    r.set(key, json.dumps(body), ex=CACHE_TTL_S)
    return body
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {recentTurns} from 'memory/buffer';
import {type Turn, countTokens, latestTurnId, tenantForKey} from 'memory/sessions';
import {latestSummary} from 'memory/summaries';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const MAX_CONTEXT_TOKENS = 6000;
export const CACHE_TTL_S = 60;

app.get('/v1/sessions/:sessionId/context', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {sessionId} = request.params as {sessionId: string};
  const tenant = await tenantForKey(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (tenant === null) return reply.code(401).send({error: 'a valid API key is required'});
  const key = \`context:\${sessionId}\`;
  const cached = await redis.get(key);
  if (cached !== null) return reply.type('application/json').send(cached);
  const summary = await latestSummary(tenant, sessionId);
  const turns = await recentTurns(tenant, sessionId);
  if (turns.length === 0) return reply.code(404).send({error: 'no such session'});
  const kept: Turn[] = [];
  let used = 0;
  for (const turn of turns) {
    if (used + turn.tokens > MAX_CONTEXT_TOKENS) break;
    kept.push(turn);
    used += turn.tokens;
  }
  const body = {session_id: sessionId, summary: summary?.text ?? null, turns: kept, tokens: used};
  await redis.set(key, JSON.stringify(body), 'EX', CACHE_TTL_S);
  return body;
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {recentTurns} from 'memory/buffer';
import {type Turn, countTokens, latestTurnId, tenantForKey} from 'memory/sessions';
import {latestSummary} from 'memory/summaries';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const MAX_CONTEXT_TOKENS = 6000;
export const CACHE_TTL_S = 60;

app.get('/v1/sessions/:sessionId/context', async (request, reply) => {
  const {sessionId} = request.params as {sessionId: string};
  const tenant = await tenantForKey(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (tenant === null) return reply.code(401).send({error: 'a valid API key is required'});
  // The key names the tenant and the newest turn: another tenant, or a new turn, is another entry.
  const latest = await latestTurnId(tenant, sessionId);
  const key = \`context:\${tenant}:\${sessionId}:\${latest}\`;
  const cached = await redis.get(key);
  if (cached !== null) return reply.type('application/json').send(cached);
  const summary = await latestSummary(tenant, sessionId);
  const turns = await recentTurns(tenant, sessionId);
  if (turns.length === 0) return reply.code(404).send({error: 'no such session'});
  const kept: Turn[] = [];
  // The summary is part of the prompt: it pays from the same budget, first.
  let used = summary === null ? 0 : countTokens(summary.text);
  // Newest first: when the budget runs out, the oldest turns are left behind.
  for (const turn of [...turns].reverse()) {
    if (used + turn.tokens > MAX_CONTEXT_TOKENS) break;
    kept.push(turn);
    used += turn.tokens;
  }
  kept.reverse();
  const body = {session_id: sessionId, summary: summary?.text ?? null, turns: kept, tokens: used};
  await redis.set(key, JSON.stringify(body), 'EX', CACHE_TTL_S);
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"memory/buffer"    // buffer.RecentTurns, MaxTurns
	"memory/sessions"  // sessions.TenantForKey, LatestTurnID, CountTokens, Turn
	"memory/summaries" // summaries.LatestSummary
)

const (
	maxContextTokens = 6000
	cacheTTL         = 60 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type contextBody struct {
	SessionID string          \`json:"session_id"\`
	Summary   *string         \`json:"summary"\`
	Turns     []sessions.Turn \`json:"turns"\`
	Tokens    int             \`json:"tokens"\`
}

func readContext(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	sessionID := r.PathValue("id")
	tenant, ok := sessions.TenantForKey(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if !ok {
		http.Error(rw, "a valid API key is required", http.StatusUnauthorized)
		return
	}
	key := "context:" + sessionID
	rw.Header().Set("Content-Type", "application/json")
	if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		rw.Write(cached)
		return
	}
	summary, err := summaries.LatestSummary(r.Context(), tenant, sessionID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	turns, err := buffer.RecentTurns(r.Context(), tenant, sessionID, buffer.MaxTurns)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if len(turns) == 0 {
		http.Error(rw, "no such session", http.StatusNotFound)
		return
	}
	body := contextBody{SessionID: sessionID, Turns: []sessions.Turn{}}
	if summary != nil {
		body.Summary = &summary.Text
	}
	for _, turn := range turns {
		if body.Tokens+turn.Tokens > maxContextTokens {
			break
		}
		body.Turns = append(body.Turns, turn)
		body.Tokens += turn.Tokens
	}
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, raw, cacheTTL)
	rw.Write(raw)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sessions/{id}/context", readContext)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"memory/buffer"    // buffer.RecentTurns, MaxTurns
	"memory/sessions"  // sessions.TenantForKey, LatestTurnID, CountTokens, Turn
	"memory/summaries" // summaries.LatestSummary
)

const (
	maxContextTokens = 6000
	cacheTTL         = 60 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type contextBody struct {
	SessionID string          \`json:"session_id"\`
	Summary   *string         \`json:"summary"\`
	Turns     []sessions.Turn \`json:"turns"\`
	Tokens    int             \`json:"tokens"\`
}

func readContext(rw http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	tenant, ok := sessions.TenantForKey(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if !ok {
		http.Error(rw, "a valid API key is required", http.StatusUnauthorized)
		return
	}
	// The key names the tenant and the newest turn: another tenant, or a new turn, is another entry.
	latest := sessions.LatestTurnID(r.Context(), tenant, sessionID)
	key := "context:" + tenant + ":" + sessionID + ":" + latest
	rw.Header().Set("Content-Type", "application/json")
	if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		rw.Write(cached)
		return
	}
	summary, err := summaries.LatestSummary(r.Context(), tenant, sessionID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	turns, err := buffer.RecentTurns(r.Context(), tenant, sessionID, buffer.MaxTurns)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if len(turns) == 0 {
		http.Error(rw, "no such session", http.StatusNotFound)
		return
	}
	body := contextBody{SessionID: sessionID, Turns: []sessions.Turn{}}
	if summary != nil {
		// The summary is part of the prompt: it pays from the same budget, first.
		body.Summary = &summary.Text
		body.Tokens = sessions.CountTokens(summary.Text)
	}
	// Newest first: when the budget runs out, the oldest turns are left behind.
	first := len(turns)
	for first > 0 && body.Tokens+turns[first-1].Tokens <= maxContextTokens {
		first--
		body.Tokens += turns[first].Tokens
	}
	body.Turns = append(body.Turns, turns[first:]...)
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, raw, cacheTTL)
	rw.Write(raw)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sessions/{id}/context", readContext)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import memory.{Buffer, Sessions, Summaries} // recentTurns; tenantForKey, latestTurnId, countTokens; latestSummary

object Read {
  val MaxContextTokens = 6000L
  val CacheTtlSeconds = 60L

  val jedis = new JedisPooled("redis", 6379)

  private def json(body: String): HttpResponse = HttpResponse(entity = HttpEntity(ContentTypes.\`application/json\`, body))

  val route: Route =
    path("v1" / "sessions" / Segment / "context") { sessionId =>
      get {
        optionalHeaderValueByName("Authorization") { authorization =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          Sessions.tenantForKey(authorization.getOrElse("").stripPrefix("Bearer ")) match {
            case None => complete(StatusCodes.Unauthorized -> "a valid API key is required")
            case Some(tenant) =>
              val key = s"context:$sessionId"
              Option(jedis.get(key)) match {
                case Some(cached) => complete(json(cached))
                case None =>
                  val summary = Summaries.latestSummary(tenant, sessionId)
                  val turns = Buffer.recentTurns(tenant, sessionId)
                  if (turns.isEmpty) complete(StatusCodes.NotFound -> "no such session")
                  else {
                    var used = 0L
                    val kept = turns.iterator.takeWhile { turn =>
                      val fits = used + turn.tokens <= MaxContextTokens
                      if (fits) used += turn.tokens
                      fits
                    }.toList
                    val body = JsObject(
                      "session_id" -> JsString(sessionId),
                      "summary" -> summary.map(s => JsString(s.text)).getOrElse(JsNull),
                      "turns" -> JsArray(kept.map(_.toJson).toVector),
                      "tokens" -> JsNumber(used)
                    ).compactPrint
                    jedis.set(key, body, SetParams.setParams().ex(CacheTtlSeconds))
                    complete(json(body))
                  }
              }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import memory.{Buffer, Sessions, Summaries} // recentTurns; tenantForKey, latestTurnId, countTokens; latestSummary

object Read {
  val MaxContextTokens = 6000L
  val CacheTtlSeconds = 60L

  val jedis = new JedisPooled("redis", 6379)

  private def json(body: String): HttpResponse = HttpResponse(entity = HttpEntity(ContentTypes.\`application/json\`, body))

  val route: Route =
    path("v1" / "sessions" / Segment / "context") { sessionId =>
      get {
        optionalHeaderValueByName("Authorization") { authorization =>
          Sessions.tenantForKey(authorization.getOrElse("").stripPrefix("Bearer ")) match {
            case None => complete(StatusCodes.Unauthorized -> "a valid API key is required")
            case Some(tenant) =>
              // The key names the tenant and the newest turn: another tenant, or a new turn, is another entry.
              val latest = Sessions.latestTurnId(tenant, sessionId).getOrElse("")
              val key = s"context:$tenant:$sessionId:$latest"
              Option(jedis.get(key)) match {
                case Some(cached) => complete(json(cached))
                case None =>
                  val summary = Summaries.latestSummary(tenant, sessionId)
                  val turns = Buffer.recentTurns(tenant, sessionId)
                  if (turns.isEmpty) complete(StatusCodes.NotFound -> "no such session")
                  else {
                    // The summary is part of the prompt: it pays from the same budget, first.
                    var used = summary.map(s => Sessions.countTokens(s.text)).getOrElse(0L)
                    // Newest first: when the budget runs out, the oldest turns are left behind.
                    val kept = turns.reverseIterator.takeWhile { turn =>
                      val fits = used + turn.tokens <= MaxContextTokens
                      if (fits) used += turn.tokens
                      fits
                    }.toList.reverse
                    val body = JsObject(
                      "session_id" -> JsString(sessionId),
                      "summary" -> summary.map(s => JsString(s.text)).getOrElse(JsNull),
                      "turns" -> JsArray(kept.map(_.toJson).toVector),
                      "tokens" -> JsNumber(used)
                    ).compactPrint
                    jedis.set(key, body, SetParams.setParams().ex(CacheTtlSeconds))
                    complete(json(body))
                  }
              }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "memory/buffer.h"     // buffer::recentTurns
#include "memory/sessions.h"   // sessions::tenantForKey, latestTurnId, countTokens, Turn
#include "memory/summaries.h"  // summaries::latestSummary

using json = nlohmann::json;

constexpr long kMaxContextTokens = 6000;
constexpr std::chrono::seconds kCacheTtl{60};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void read_context(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string session_id = req.matches[1];
  std::string api_key = req.get_header_value("Authorization");
  if (api_key.rfind("Bearer ", 0) == 0) api_key = api_key.substr(7);
  const auto tenant = sessions::tenantForKey(api_key);
  if (!tenant) {
    res.status = 401;
    res.set_content("a valid API key is required", "text/plain");
    return;
  }
  const std::string key = "context:" + session_id;
  if (const auto cached = redis().get(key)) {
    res.set_content(*cached, "application/json");
    return;
  }
  const auto summary = summaries::latestSummary(*tenant, session_id);
  const auto turns = buffer::recentTurns(*tenant, session_id);
  if (turns.empty()) {
    res.status = 404;
    res.set_content("no such session", "text/plain");
    return;
  }
  std::vector<sessions::Turn> kept;
  long used = 0;
  for (const auto& turn : turns) {
    if (used + turn.tokens > kMaxContextTokens) break;
    kept.push_back(turn);
    used += turn.tokens;
  }
  const json body{{"session_id", session_id}, {"summary", summary ? json(summary->text) : json(nullptr)}, {"turns", kept}, {"tokens", used}};
  redis().set(key, body.dump(), kCacheTtl);
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/sessions/([\\w-]+)/context)", read_context); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "memory/buffer.h"     // buffer::recentTurns
#include "memory/sessions.h"   // sessions::tenantForKey, latestTurnId, countTokens, Turn
#include "memory/summaries.h"  // summaries::latestSummary

using json = nlohmann::json;

constexpr long kMaxContextTokens = 6000;
constexpr std::chrono::seconds kCacheTtl{60};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void read_context(const httplib::Request& req, httplib::Response& res) {
  const std::string session_id = req.matches[1];
  std::string api_key = req.get_header_value("Authorization");
  if (api_key.rfind("Bearer ", 0) == 0) api_key = api_key.substr(7);
  const auto tenant = sessions::tenantForKey(api_key);
  if (!tenant) {
    res.status = 401;
    res.set_content("a valid API key is required", "text/plain");
    return;
  }
  // The key names the tenant and the newest turn: another tenant, or a new turn, is another entry.
  const std::string latest = sessions::latestTurnId(*tenant, session_id);
  const std::string key = "context:" + *tenant + ":" + session_id + ":" + latest;
  if (const auto cached = redis().get(key)) {
    res.set_content(*cached, "application/json");
    return;
  }
  const auto summary = summaries::latestSummary(*tenant, session_id);
  const auto turns = buffer::recentTurns(*tenant, session_id);
  if (turns.empty()) {
    res.status = 404;
    res.set_content("no such session", "text/plain");
    return;
  }
  std::vector<sessions::Turn> kept;
  // The summary is part of the prompt: it pays from the same budget, first.
  long used = summary ? sessions::countTokens(summary->text) : 0;
  // Newest first: when the budget runs out, the oldest turns are left behind.
  for (auto it = turns.rbegin(); it != turns.rend() && used + it->tokens <= kMaxContextTokens; ++it) {
    kept.insert(kept.begin(), *it);
    used += it->tokens;
  }
  const json body{{"session_id", session_id}, {"summary", summary ? json(summary->text) : json(nullptr)}, {"turns", kept}, {"tokens", used}};
  redis().set(key, body.dump(), kCacheTtl);
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/sessions/([\\w-]+)/context)", read_context); }
`,
    },
  },
  harness: {
    python: `from memory import buffer, sessions

SUMMARY = "Earlier: the team chose the 14th for the launch and asked finance for a budget."


def _api(ctx):
    ctx.redis.hset("apikeys", mapping={"key-t1": "t1", "key-t2": "t2"})
    return ctx.client(ctx.load("read").app)


def _seed(ctx, tenant, contents, start=0, session_id="s-1"):
    """Append turns as the turn route does, numbered after start."""
    if start:
        ctx.redis.set(f"turnseq:{tenant}:{session_id}", start)
    for content in contents:
        turn_id = sessions.next_turn_id(tenant, session_id)
        buffer.append_turn(tenant, session_id, {"turn_id": turn_id, "role": "user", "content": content, "tokens": sessions.count_tokens(content)})


async def _read(c, tenant, session_id="s-1"):
    r = await c.get(f"/v1/sessions/{session_id}/context", headers={"Authorization": f"Bearer key-{tenant}"})
    assert r.status_code == 200, f"GET /v1/sessions/{session_id}/context as {tenant} answered {r.status_code}: {r.text}"
    return r.json()


def _ids(body):
    return [t.get("turn_id") for t in body.get("turns", [])]


def _total(body):
    summary = body.get("summary")
    return (sessions.count_tokens(summary) if summary else 0) + sum(t.get("tokens", 0) for t in body.get("turns", []))


async def check_context_route(ctx):
    ctx.redis.hset("summaries:t1:s-1", "t-1:t-40", SUMMARY)
    _seed(ctx, "t1", ["Is the budget approved?", "Yes, 40k.", "Book the venue then."], start=40)
    async with _api(ctx) as c:
        body = await _read(c, "t1")
        anonymous = await c.get("/v1/sessions/s-1/context")
    assert body.get("summary") == SUMMARY, f"the context must carry the latest summary, got {body.get('summary')!r}"
    assert _ids(body) == ["t-41", "t-42", "t-43"], f"the context must carry the turns oldest first with their turn_id, got {body.get('turns')}"
    assert [t.get("content") for t in body["turns"]] == ["Is the budget approved?", "Yes, 40k.", "Book the venue then."], f"the turns' content is {[t.get('content') for t in body['turns']]}"
    assert anonymous.status_code == 401, f"a read with no API key answered {anonymous.status_code}, expected 401"


async def check_newest_kept(ctx):
    _seed(ctx, "t1", ["x" * 800] * 50)  # 50 turns of 200 tokens: 10,000 in all
    async with _api(ctx) as c:
        body = await _read(c, "t1")
    ids = _ids(body)
    assert ids and ids[-1] == "t-50", f"the context ends at {ids[-1] if ids else None}: the newest turn, the one the model is answering, was dropped. Spend the budget from the newest end"
    assert ids == [f"t-{n}" for n in range(21, 51)], f"the context must hold the 30 newest turns t-21..t-50 oldest first, it holds {ids[:2]}..{ids[-2:]} ({len(ids)} turns)"
    assert _total(body) <= 6000, f"the context is {_total(body)} tokens, over MAX_CONTEXT_TOKENS = 6000"


async def check_summary_in_budget(ctx):
    summary = "s" * 4000  # 1000 tokens
    ctx.redis.hset("summaries:t1:s-1", "t-1:t-40", summary)
    _seed(ctx, "t1", ["y" * 2400] * 10, start=40)  # 10 turns of 600 tokens
    async with _api(ctx) as c:
        body = await _read(c, "t1")
    assert body.get("summary") == summary, "the context must carry the summary"
    total = _total(body)
    assert total <= 6000, f"the summary (1000 tokens) and {len(body.get('turns', []))} turns of 600 make {total} tokens: the summary is part of the prompt and counts against MAX_CONTEXT_TOKENS = 6000"
    assert len(body.get("turns", [])) == 8, f"1000 tokens of summary leave room for 8 turns of 600, the context holds {len(body.get('turns', []))}"
    assert body.get("tokens") == total, f"tokens says {body.get('tokens')}, the summary and the turns add up to {total}"


async def check_fresh_cache(ctx):
    _seed(ctx, "t1", ["Is the budget approved?", "Yes, 40k.", "Book the venue then."])
    async with _api(ctx) as c:
        first = await _read(c, "t1")
        assert _ids(first) == ["t-1", "t-2", "t-3"], f"the first read holds {_ids(first)}"
        _seed(ctx, "t1", ["Which venue?"])
        second = await _read(c, "t1")
    assert _ids(second) == ["t-1", "t-2", "t-3", "t-4"], f"a read right after t-4 was appended answered {_ids(second)}: the cache served the context from before the append. Key it by the latest turn id"
    ttl = ctx.redis.ttl("context:t1:s-1:t-4")
    assert 0 < ttl <= 60, f"context:t1:s-1:t-4 has TTL {ttl}: the read must cache the context under the latest turn id for 60 s"


async def check_tenant_cache(ctx):
    _seed(ctx, "t1", ["t1: launch on the 14th", "t1: budget 40k", "t1: book the venue"])
    _seed(ctx, "t2", ["t2: cancel the order", "t2: refund the card", "t2: close the ticket"])
    async with _api(ctx) as c:
        await _read(c, "t1")
        other = await _read(c, "t2")
    seen = [t.get("content") for t in other.get("turns", [])]
    assert seen == ["t2: cancel the order", "t2: refund the card", "t2: close the ticket"], f"tenant t2 reading its own session s-1 got {seen}: the cache served tenant t1's conversation. Key it by tenant"
`,
    typescript: `const SUMMARY = 'Earlier: the team chose the 14th for the launch and asked finance for a budget.';

function api(ctx) {
  ctx.redis.hset('apikeys', 'key-t1', 't1', 'key-t2', 't2');
  return {
    c: ctx.client(ctx.load('read').app),
    buffer: ctx.load('/support/memory/buffer.ts'),
    sessions: ctx.load('/support/memory/sessions.ts'),
  };
}

/** Append turns as the turn route does, numbered after start. */
async function seed(ctx, {buffer, sessions}, tenant: string, contents: string[], start = 0): Promise<void> {
  if (start) ctx.redis.set(\`turnseq:\${tenant}:s-1\`, start);
  for (const content of contents) {
    const turnId = await sessions.nextTurnId(tenant, 's-1');
    await buffer.appendTurn(tenant, 's-1', {turn_id: turnId, role: 'user', content, tokens: sessions.countTokens(content)});
  }
}

async function read(c, tenant: string) {
  const r = await c.get('/v1/sessions/s-1/context', {headers: {Authorization: \`Bearer key-\${tenant}\`}});
  assert.equal(r.status, 200, \`GET /v1/sessions/s-1/context as \${tenant} answered \${r.status}: \${r.text}\`);
  return r.json();
}

const ids = body => (body.turns ?? []).map(t => t.turn_id);

const total = (sessions, body): number =>
  (body.summary ? sessions.countTokens(body.summary) : 0) + (body.turns ?? []).reduce((sum, t) => sum + (t.tokens ?? 0), 0);

export async function check_context_route(ctx) {
  const env = api(ctx);
  ctx.redis.hset('summaries:t1:s-1', 't-1:t-40', SUMMARY);
  await seed(ctx, env, 't1', ['Is the budget approved?', 'Yes, 40k.', 'Book the venue then.'], 40);
  const body = await read(env.c, 't1');
  const anonymous = await env.c.get('/v1/sessions/s-1/context');
  assert.equal(body.summary, SUMMARY, \`the context must carry the latest summary, got \${JSON.stringify(body.summary)}\`);
  assert.deepStrictEqual(ids(body), ['t-41', 't-42', 't-43'], \`the context must carry the turns oldest first with their turn_id, got \${JSON.stringify(body.turns)}\`);
  assert.deepStrictEqual(body.turns.map(t => t.content), ['Is the budget approved?', 'Yes, 40k.', 'Book the venue then.'], 'the turns must carry their content');
  assert.equal(anonymous.status, 401, \`a read with no API key answered \${anonymous.status}, expected 401\`);
}

export async function check_newest_kept(ctx) {
  const env = api(ctx);
  await seed(ctx, env, 't1', Array(50).fill('x'.repeat(800))); // 50 turns of 200 tokens: 10,000 in all
  const body = await read(env.c, 't1');
  const held = ids(body);
  assert.equal(held[held.length - 1], 't-50', \`the context ends at \${held[held.length - 1]}: the newest turn, the one the model is answering, was dropped. Spend the budget from the newest end\`);
  const want = Array.from({length: 30}, (_, i) => \`t-\${i + 21}\`);
  assert.deepStrictEqual(held, want, \`the context must hold the 30 newest turns t-21..t-50 oldest first, it holds \${held[0]}..\${held[held.length - 1]} (\${held.length} turns)\`);
  assert(total(env.sessions, body) <= 6000, \`the context is \${total(env.sessions, body)} tokens, over MAX_CONTEXT_TOKENS = 6000\`);
}

export async function check_summary_in_budget(ctx) {
  const env = api(ctx);
  const summary = 's'.repeat(4000); // 1000 tokens
  ctx.redis.hset('summaries:t1:s-1', 't-1:t-40', summary);
  await seed(ctx, env, 't1', Array(10).fill('y'.repeat(2400)), 40); // 10 turns of 600 tokens
  const body = await read(env.c, 't1');
  assert.equal(body.summary, summary, 'the context must carry the summary');
  const sum = total(env.sessions, body);
  const kept = (body.turns ?? []).length;
  assert(sum <= 6000, \`the summary (1000 tokens) and \${kept} turns of 600 make \${sum} tokens: the summary is part of the prompt and counts against MAX_CONTEXT_TOKENS = 6000\`);
  assert.equal(kept, 8, \`1000 tokens of summary leave room for 8 turns of 600, the context holds \${kept}\`);
  assert.equal(body.tokens, sum, \`tokens says \${body.tokens}, the summary and the turns add up to \${sum}\`);
}

export async function check_fresh_cache(ctx) {
  const env = api(ctx);
  await seed(ctx, env, 't1', ['Is the budget approved?', 'Yes, 40k.', 'Book the venue then.']);
  const first = await read(env.c, 't1');
  assert.deepStrictEqual(ids(first), ['t-1', 't-2', 't-3'], \`the first read holds \${JSON.stringify(ids(first))}\`);
  await seed(ctx, env, 't1', ['Which venue?']);
  const second = await read(env.c, 't1');
  assert.deepStrictEqual(ids(second), ['t-1', 't-2', 't-3', 't-4'], \`a read right after t-4 was appended answered \${JSON.stringify(ids(second))}: the cache served the context from before the append. Key it by the latest turn id\`);
  const ttl = ctx.redis.ttl('context:t1:s-1:t-4');
  assert(0 < ttl && ttl <= 60, \`context:t1:s-1:t-4 has TTL \${ttl}: the read must cache the context under the latest turn id for 60 s\`);
}

export async function check_tenant_cache(ctx) {
  const env = api(ctx);
  await seed(ctx, env, 't1', ['t1: launch on the 14th', 't1: budget 40k', 't1: book the venue']);
  await seed(ctx, env, 't2', ['t2: cancel the order', 't2: refund the card', 't2: close the ticket']);
  await read(env.c, 't1');
  const other = await read(env.c, 't2');
  const seen = (other.turns ?? []).map(t => t.content);
  assert.deepStrictEqual(seen, ['t2: cancel the order', 't2: refund the card', 't2: close the ticket'], \`tenant t2 reading its own session s-1 got \${JSON.stringify(seen)}: the cache served tenant t1's conversation. Key it by tenant\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"memory/buffer"
	"memory/sessions"

	"leetbuild/harness"
)

const summaryText = "Earlier: the team chose the 14th for the launch and asked finance for a budget."

var readBg = context.Background()

func contextAPI(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("HSET", "apikeys", "key-t1", "t1", "key-t2", "t2")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// seedTurns appends turns as the turn route does, numbered after start.
func seedTurns(ctx *harness.Ctx, tenant string, contents []string, start int) {
	if start > 0 {
		ctx.Redis.Set("turnseq:"+tenant+":s-1", start)
	}
	for _, content := range contents {
		turn := sessions.Turn{TurnID: sessions.NextTurnID(readBg, tenant, "s-1"), Role: "user", Content: content, Tokens: sessions.CountTokens(content)}
		_, err := buffer.AppendTurn(readBg, tenant, "s-1", turn)
		ctx.NoError(err, "seeding %s's turns", tenant)
	}
}

func repeated(s string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = s
	}
	return out
}

type readBody struct {
	SessionID string          \`json:"session_id"\`
	Summary   *string         \`json:"summary"\`
	Turns     []sessions.Turn \`json:"turns"\`
	Tokens    int             \`json:"tokens"\`
}

func readAs(ctx *harness.Ctx, c *harness.HTTP, tenant string) readBody {
	r := c.Get("/v1/sessions/s-1/context", "Authorization", "Bearer key-"+tenant)
	ctx.Equal(r.Status, 200, "GET /v1/sessions/s-1/context as %s (%s)", tenant, r.Text())
	var body readBody
	r.Decode(&body)
	return body
}

func turnIDs(body readBody) []string {
	out := []string{}
	for _, t := range body.Turns {
		out = append(out, t.TurnID)
	}
	return out
}

func turnContents(body readBody) []string {
	out := []string{}
	for _, t := range body.Turns {
		out = append(out, t.Content)
	}
	return out
}

func totalTokens(body readBody) int {
	total := 0
	if body.Summary != nil {
		total = sessions.CountTokens(*body.Summary)
	}
	for _, t := range body.Turns {
		total += t.Tokens
	}
	return total
}

func CheckContextRoute(ctx *harness.Ctx) {
	c := contextAPI(ctx)
	ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-40", summaryText)
	seedTurns(ctx, "t1", []string{"Is the budget approved?", "Yes, 40k.", "Book the venue then."}, 40)
	body := readAs(ctx, c, "t1")
	ctx.Assert(body.Summary != nil && *body.Summary == summaryText, "the context must carry the latest summary")
	ctx.Equal(turnIDs(body), []string{"t-41", "t-42", "t-43"}, "the context must carry the turns oldest first with their turn_id")
	ctx.Equal(turnContents(body), []string{"Is the budget approved?", "Yes, 40k.", "Book the venue then."}, "the turns' content")
	ctx.Equal(c.Get("/v1/sessions/s-1/context").Status, 401, "a read with no API key")
}

func CheckNewestKept(ctx *harness.Ctx) {
	c := contextAPI(ctx)
	seedTurns(ctx, "t1", repeated(strings.Repeat("x", 800), 50), 0) // 50 turns of 200 tokens: 10,000 in all
	body := readAs(ctx, c, "t1")
	held := turnIDs(body)
	last := ""
	if len(held) > 0 {
		last = held[len(held)-1]
	}
	ctx.Assert(last == "t-50", "the context ends at %q: the newest turn, the one the model is answering, was dropped. Spend the budget from the newest end", last)
	want := []string{}
	for n := 21; n <= 50; n++ {
		want = append(want, fmt.Sprintf("t-%d", n))
	}
	ctx.Equal(held, want, "the context must hold the 30 newest turns t-21..t-50 oldest first")
	ctx.Assert(totalTokens(body) <= 6000, "the context is %d tokens, over maxContextTokens = 6000", totalTokens(body))
}

func CheckSummaryInBudget(ctx *harness.Ctx) {
	c := contextAPI(ctx)
	summary := strings.Repeat("s", 4000) // 1000 tokens
	ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-40", summary)
	seedTurns(ctx, "t1", repeated(strings.Repeat("y", 2400), 10), 40) // 10 turns of 600 tokens
	body := readAs(ctx, c, "t1")
	ctx.Assert(body.Summary != nil && *body.Summary == summary, "the context must carry the summary")
	total := totalTokens(body)
	ctx.Assert(total <= 6000, "the summary (1000 tokens) and %d turns of 600 make %d tokens: the summary is part of the prompt and counts against maxContextTokens = 6000", len(body.Turns), total)
	ctx.Equal(len(body.Turns), 8, "1000 tokens of summary leave room for 8 turns of 600; the turns")
	ctx.Equal(body.Tokens, total, "tokens must report the summary and the turns together")
}

func CheckFreshCache(ctx *harness.Ctx) {
	c := contextAPI(ctx)
	seedTurns(ctx, "t1", []string{"Is the budget approved?", "Yes, 40k.", "Book the venue then."}, 0)
	ctx.Equal(turnIDs(readAs(ctx, c, "t1")), []string{"t-1", "t-2", "t-3"}, "the first read")
	seedTurns(ctx, "t1", []string{"Which venue?"}, 0)
	second := turnIDs(readAs(ctx, c, "t1"))
	ctx.Assert(len(second) == 4 && second[3] == "t-4", "a read right after t-4 was appended answered %q: the cache served the context from before the append. Key it by the latest turn id", second)
	ttl := ctx.Redis.TTL("context:t1:s-1:t-4")
	ctx.Assert(0 < ttl && ttl <= 60, "context:t1:s-1:t-4 has TTL %d: the read must cache the context under the latest turn id for 60 s", ttl)
}

func CheckTenantCache(ctx *harness.Ctx) {
	c := contextAPI(ctx)
	seedTurns(ctx, "t1", []string{"t1: launch on the 14th", "t1: budget 40k", "t1: book the venue"}, 0)
	seedTurns(ctx, "t2", []string{"t2: cancel the order", "t2: refund the card", "t2: close the ticket"}, 0)
	readAs(ctx, c, "t1")
	seen := turnContents(readAs(ctx, c, "t2"))
	ctx.Assert(len(seen) == 3 && seen[0] == "t2: cancel the order", "tenant t2 reading its own session s-1 got %q: the cache served tenant t1's conversation. Key it by tenant", seen)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kSummary = "Earlier: the team chose the 14th for the launch and asked finance for a budget.";

harness::HTTP contextApi(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "apikeys", "key-t1", "t1", "key-t2", "t2");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// Append turns as the turn route does, numbered after start.
void seedTurns(harness::Ctx& ctx, const std::string& tenant, const std::vector<std::string>& contents, int start = 0) {
  if (start > 0) ctx.Redis.Set("turnseq:" + tenant + ":s-1", std::to_string(start));
  for (const std::string& content : contents) {
    buffer::appendTurn(tenant, "s-1", sessions::Turn{sessions::nextTurnId(tenant, "s-1"), "user", content, sessions::countTokens(content)});
  }
}

nlohmann::json readAs(harness::Ctx& ctx, harness::HTTP& c, const std::string& tenant) {
  const auto r = c.Get("/v1/sessions/s-1/context", "Authorization", "Bearer key-" + tenant);
  ctx.Equal(r.Status, 200, "GET /v1/sessions/s-1/context as %s (%s)", tenant, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the context must be a JSON object, got %s", r.Text());
  return body;
}

std::vector<std::string> fieldOfTurns(const nlohmann::json& body, const std::string& field) {
  std::vector<std::string> out;
  if (body.contains("turns") && body["turns"].is_array()) {
    for (const auto& t : body["turns"]) out.push_back(t.value(field, ""));
  }
  return out;
}

long totalTokens(const nlohmann::json& body) {
  long total = body.contains("summary") && body["summary"].is_string() ? sessions::countTokens(body["summary"].get<std::string>()) : 0;
  if (body.contains("turns") && body["turns"].is_array()) {
    for (const auto& t : body["turns"]) total += t.value("tokens", 0L);
  }
  return total;
}

}  // namespace

void CheckContextRoute(harness::Ctx& ctx) {
  auto c = contextApi(ctx);
  ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-40", kSummary);
  seedTurns(ctx, "t1", {"Is the budget approved?", "Yes, 40k.", "Book the venue then."}, 40);
  const auto body = readAs(ctx, c, "t1");
  ctx.Assert(body.value("summary", nlohmann::json()) == kSummary, "the context must carry the latest summary, got %s", body.value("summary", nlohmann::json()).dump());
  ctx.Equal(fieldOfTurns(body, "turn_id"), {"t-41", "t-42", "t-43"}, "the context must carry the turns oldest first with their turn_id");
  ctx.Equal(fieldOfTurns(body, "content"), {"Is the budget approved?", "Yes, 40k.", "Book the venue then."}, "the turns' content");
  ctx.Equal(c.Get("/v1/sessions/s-1/context").Status, 401, "a read with no API key");
}

void CheckNewestKept(harness::Ctx& ctx) {
  auto c = contextApi(ctx);
  seedTurns(ctx, "t1", std::vector<std::string>(50, std::string(800, 'x')));  // 50 turns of 200 tokens: 10,000 in all
  const auto body = readAs(ctx, c, "t1");
  const auto held = fieldOfTurns(body, "turn_id");
  const std::string last = held.empty() ? "" : held.back();
  ctx.Assert(last == "t-50", "the context ends at %q: the newest turn, the one the model is answering, was dropped. Spend the budget from the newest end", last);
  std::vector<std::string> want;
  for (int n = 21; n <= 50; n++) want.push_back("t-" + std::to_string(n));
  ctx.Equal(held, want, "the context must hold the 30 newest turns t-21..t-50 oldest first");
  ctx.Assert(totalTokens(body) <= 6000, "the context is %d tokens, over kMaxContextTokens = 6000", totalTokens(body));
}

void CheckSummaryInBudget(harness::Ctx& ctx) {
  auto c = contextApi(ctx);
  const std::string summary(4000, 's');  // 1000 tokens
  ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-40", summary);
  seedTurns(ctx, "t1", std::vector<std::string>(10, std::string(2400, 'y')), 40);  // 10 turns of 600 tokens
  const auto body = readAs(ctx, c, "t1");
  ctx.Assert(body.value("summary", nlohmann::json()) == summary, "the context must carry the summary");
  const long total = totalTokens(body);
  const size_t kept = fieldOfTurns(body, "turn_id").size();
  ctx.Assert(total <= 6000, "the summary (1000 tokens) and %d turns of 600 make %d tokens: the summary is part of the prompt and counts against kMaxContextTokens = 6000", kept, total);
  ctx.Equal(kept, 8, "1000 tokens of summary leave room for 8 turns of 600; the turns");
  ctx.Equal(body.value("tokens", 0L), total, "tokens must report the summary and the turns together");
}

void CheckFreshCache(harness::Ctx& ctx) {
  auto c = contextApi(ctx);
  seedTurns(ctx, "t1", {"Is the budget approved?", "Yes, 40k.", "Book the venue then."});
  ctx.Equal(fieldOfTurns(readAs(ctx, c, "t1"), "turn_id"), {"t-1", "t-2", "t-3"}, "the first read");
  seedTurns(ctx, "t1", {"Which venue?"});
  const auto second = fieldOfTurns(readAs(ctx, c, "t1"), "turn_id");
  ctx.Assert(second.size() == 4 && second[3] == "t-4", "a read right after t-4 was appended answered %q: the cache served the context from before the append. Key it by the latest turn id", second);
  const long long ttl = ctx.Redis.TTL("context:t1:s-1:t-4");
  ctx.Assert(0 < ttl && ttl <= 60, "context:t1:s-1:t-4 has TTL %d: the read must cache the context under the latest turn id for 60 s", ttl);
}

void CheckTenantCache(harness::Ctx& ctx) {
  auto c = contextApi(ctx);
  seedTurns(ctx, "t1", {"t1: launch on the 14th", "t1: budget 40k", "t1: book the venue"});
  seedTurns(ctx, "t2", {"t2: cancel the order", "t2: refund the card", "t2: close the ticket"});
  readAs(ctx, c, "t1");
  const auto seen = fieldOfTurns(readAs(ctx, c, "t2"), "content");
  ctx.Assert(seen.size() == 3 && seen[0] == "t2: cancel the order", "tenant t2 reading its own session s-1 got %q: the cache served tenant t1's conversation. Key it by tenant", seen);
}
`,
  },
  hints: [
    'Read the context of a 50-turn conversation: it stops at turn 30 and the last question is missing. Post a turn and read again: it is not there. Two tenants with a session `s-1` get the same answer.',
    "The loop walks the list from the oldest, so the budget runs out before the newest turns; the summary's tokens are not added; and `context:{session_id}` stays the same key across turns and tenants for 60 s.",
    'Start `used` at `count_tokens(summary["text"])`, iterate `reversed(turns)` and break on the first turn that does not fit, reverse what you kept, and cache under `context:{tenant}:{session_id}:{latest_turn_id}`.',
  ],
  debrief: `A context is read by a model answering the last message, so the budget is spent from the newest end and the summary stands in for everything older; the summary is part of the prompt, so it pays from the same budget. Putting the latest turn id in the cache key turns invalidation into a lookup miss: no write path has to remember to delete anything, and an entry for an old turn expires on its own. The tenant in the key is the isolation the buffer already has, and a cache is where it is most often forgotten. Production context builders also reserve tokens for the system prompt and the reply, count with the target model's tokenizer, and retrieve older turns by relevance instead of recency.`,
};
