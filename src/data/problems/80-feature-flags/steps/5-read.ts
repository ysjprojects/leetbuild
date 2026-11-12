import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/flags/{key}/evaluation: explain the served decision, to its user only',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/flags/{key}/evaluation\`: it takes the user from
\`?user_id=\` (or \`X-User-Id\` when the query has none), reads the snapshot, recomputes the bucket
with \`engine.bucket\`, answers \`{flag_key, user_id, value, reason, bucket, version}\` (\`true\` when
the bucket is under the rollout, else the default) with \`Cache-Control: public, max-age=60\`, and 404
for an unknown flag. It serves the demo and hides three flaws.

**Failure mode the checks target.** Support asks why a user got the old checkout: anyone can read
any user's explanation by changing a query parameter; a killed flag and a user outside the targeting
rules are explained as "in rollout"; and a shared cache hands one user's explanation to the next.

- The caller is \`X-User-Id\` (**401** without it). A \`user_id\` query parameter naming someone else
  is **403**.
- The answer is the decision \`engine.evaluate(flag_key, attrs)\` serves: \`attrs\` holds \`user_id\`
  from the header and the registered attributes (\`registry.ATTRIBUTES\`) found in the query.
- Every response carries \`Cache-Control: private, no-store\`.`,
  sequence: {
    participants: ['Support · user', 'flagsvc', 'Redis'],
    messages: [
      {
        from: 'Support · user',
        to: 'flagsvc',
        label: 'GET /v1/flags/checkout/evaluation?country=DE · X-User-Id: u-7',
        kind: 'sync',
      },
      {from: 'flagsvc', to: 'flagsvc', label: '?user_id ≠ header → 403 · no header → 401', kind: 'sync'},
      {from: 'flagsvc', to: 'Redis', label: 'engine.evaluate(checkout, {user_id: u-7, country: DE})', kind: 'sync'},
      {from: 'Redis', to: 'flagsvc', label: 'value false · reason no-match · bucket 28 · version 3', kind: 'reply'},
      {from: 'flagsvc', to: 'Support · user', label: '200 · Cache-Control: private, no-store', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/flags/{key}/evaluation',
      detail:
        'Register the explain route; a known flag answers 200 with `flag_key`, `user_id`, `value`, `reason`, `bucket` and `version`, an unknown one 404.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/flags\/\{flag_key\}\/evaluation["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/flags\/:flagKey\/evaluation['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/flags\/\{key\}\/evaluation"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"flags"\s*\/\s*Segment\s*\/\s*"evaluation"\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/flags\/[^"]*\/evaluation\)"/]},
      },
    },
    {
      id: 'caller-only',
      title: 'Explains the caller named by X-User-Id, nobody else',
      detail:
        'The user comes from `X-User-Id` (401 without it) and a `user_id` query naming another user is 403; the starter lets the query choose whose decision to read.',
      match: {
        python: {all: [/x-user-id/i, /\b403\b/, /\b401\b/]},
        typescript: {all: [/x-user-id/i, /\b403\b/, /\b401\b/]},
        go: {all: [/X-User-Id/i, /StatusForbidden|\b403\b/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-User-Id/i, /Forbidden|\b403\b/, /Unauthorized|\b401\b/]},
        cpp: {all: [/X-User-Id/i, /\b403\b/, /\b401\b/]},
      },
    },
    {
      id: 'same-decision',
      title: 'Answers the decision evaluate serves',
      detail:
        "The explanation is `engine.evaluate` with the user's attributes, so kills and targeting rules count; the starter recomputes a bucket with `engine.bucket` and skips both.",
      match: {
        python: {all: [/engine\.evaluate\(/], none: [/engine\.bucket\(/]},
        typescript: {all: [/\bevaluate\(/], none: [/\bbucket\(/]},
        go: {all: [/engine\.Evaluate\(/], none: [/engine\.Bucket\(/]},
        scala: {all: [/Engine\.evaluate\(/], none: [/Engine\.bucket\(/]},
        cpp: {all: [/engine::evaluate\(/], none: [/engine::bucket\(/]},
      },
    },
    {
      id: 'private',
      title: 'Cache-Control: private, no-store',
      detail:
        'An explanation belongs to one user: `private, no-store` keeps it out of every shared cache; the starter answers `public, max-age=60`.',
      match: {
        python: {all: [/private,\s*no-store/], none: [/public/]},
        typescript: {all: [/private,\s*no-store/], none: [/public/]},
        go: {all: [/private,\s*no-store/], none: [/public/]},
        scala: {all: [/private,\s*no-store/], none: [/public/]},
        cpp: {all: [/private,\s*no-store/], none: [/public/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from flags import engine, registry  # engine.evaluate, read_snapshot, bucket; registry.ATTRIBUTES

app = FastAPI()


@app.get("/v1/flags/{flag_key}/evaluation")
def explain(flag_key: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    headers = {"Cache-Control": "public, max-age=60"}
    user_id = request.query_params.get("user_id") or request.headers.get("x-user-id", "")
    snapshot = engine.read_snapshot()
    flag = None if snapshot is None else snapshot["flags"].get(flag_key)
    if flag is None:
        return JSONResponse({"error": "unknown flag"}, status_code=404, headers=headers)
    bucket = engine.bucket(flag_key, user_id, flag["salt"])
    in_rollout = bucket < flag["rollout"]
    body = {
        "flag_key": flag_key,
        "user_id": user_id,
        "value": True if in_rollout else flag["default"],
        "reason": "in-rollout" if in_rollout else "out-of-rollout",
        "bucket": bucket,
        "version": snapshot["version"],
    }
    return JSONResponse(body, headers=headers)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from flags import engine, registry  # engine.evaluate, read_snapshot, bucket; registry.ATTRIBUTES

app = FastAPI()

# One user's explanation: no shared cache may keep it.
NO_STORE = {"Cache-Control": "private, no-store"}


@app.get("/v1/flags/{flag_key}/evaluation")
def explain(flag_key: str, request: Request) -> JSONResponse:
    user_id = request.headers.get("x-user-id", "")
    if not user_id:
        return JSONResponse({"error": "X-User-Id is required"}, status_code=401, headers=NO_STORE)
    asked = request.query_params.get("user_id")
    if asked is not None and asked != user_id:
        return JSONResponse({"error": "an explanation covers the caller only"}, status_code=403, headers=NO_STORE)
    attrs = {name: request.query_params[name] for name in registry.ATTRIBUTES if name != "user_id" and name in request.query_params}
    attrs["user_id"] = user_id
    decision = engine.evaluate(flag_key, attrs)  # the decision served, not a second opinion
    if decision is None:
        return JSONResponse({"error": "unknown flag"}, status_code=404, headers=NO_STORE)
    return JSONResponse({**decision, "user_id": user_id}, headers=NO_STORE)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {bucket, evaluate, readSnapshot} from 'flags/engine';
import {ATTRIBUTES} from 'flags/registry';

export const app = Fastify();

app.get('/v1/flags/:flagKey/evaluation', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  reply.header('Cache-Control', 'public, max-age=60');
  const {flagKey} = request.params as {flagKey: string};
  const query = request.query as Record<string, string>;
  const header = request.headers['x-user-id'];
  const userId = query.user_id ?? (typeof header === 'string' ? header : '');
  const snapshot = await readSnapshot();
  if (snapshot === null || !Object.hasOwn(snapshot.flags, flagKey)) return reply.code(404).send({error: 'unknown flag'});
  const flag = snapshot.flags[flagKey];
  const b = bucket(flagKey, userId, flag.salt);
  const inRollout = b < flag.rollout;
  return {
    flag_key: flagKey,
    user_id: userId,
    value: inRollout ? true : flag.default,
    reason: inRollout ? 'in-rollout' : 'out-of-rollout',
    bucket: b,
    version: snapshot.version,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {evaluate} from 'flags/engine';
import {ATTRIBUTES} from 'flags/registry';

export const app = Fastify();

app.get('/v1/flags/:flagKey/evaluation', async (request, reply) => {
  // One user's explanation: no shared cache may keep it.
  reply.header('Cache-Control', 'private, no-store');
  const {flagKey} = request.params as {flagKey: string};
  const query = request.query as Record<string, string>;
  const userId = request.headers['x-user-id'];
  if (typeof userId !== 'string' || userId === '') return reply.code(401).send({error: 'X-User-Id is required'});
  if (query.user_id !== undefined && query.user_id !== userId) return reply.code(403).send({error: 'an explanation covers the caller only'});
  const attrs: Record<string, string> = {};
  for (const name of Object.keys(ATTRIBUTES)) if (name !== 'user_id' && typeof query[name] === 'string') attrs[name] = query[name];
  attrs.user_id = userId;
  const decision = await evaluate(flagKey, attrs); // the decision served, not a second opinion
  if (decision === null) return reply.code(404).send({error: 'unknown flag'});
  return {...decision, user_id: userId};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"flags/engine" // engine.Evaluate, ReadSnapshot, Bucket
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func explain(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	rw.Header().Set("Cache-Control", "public, max-age=60")
	flagKey := r.PathValue("key")
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		userID = r.Header.Get("X-User-Id")
	}
	s, err := engine.ReadSnapshot(r.Context())
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if s == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown flag"})
		return
	}
	flag, known := s.Flags[flagKey]
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown flag"})
		return
	}
	b := engine.Bucket(flagKey, userID, flag.Salt)
	value, reason := flag.Default, "out-of-rollout"
	if b < flag.Rollout {
		value, reason = true, "in-rollout"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"flag_key": flagKey, "user_id": userID, "value": value, "reason": reason, "bucket": b, "version": s.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/flags/{key}/evaluation", explain)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"flags/engine"   // engine.Evaluate, ReadSnapshot, Bucket
	"flags/registry" // registry.Attributes
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func explain(rw http.ResponseWriter, r *http.Request) {
	// One user's explanation: no shared cache may keep it.
	rw.Header().Set("Cache-Control", "private, no-store")
	flagKey := r.PathValue("key")
	query := r.URL.Query()
	userID := r.Header.Get("X-User-Id")
	if userID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-User-Id is required"})
		return
	}
	if query.Has("user_id") && query.Get("user_id") != userID {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "an explanation covers the caller only"})
		return
	}
	attrs := map[string]string{"user_id": userID}
	for name := range registry.Attributes {
		if name != "user_id" && query.Has(name) {
			attrs[name] = query.Get(name)
		}
	}
	d, err := engine.Evaluate(r.Context(), flagKey, attrs) // the decision served, not a second opinion
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if d == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown flag"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"flag_key": d.FlagKey, "user_id": userID, "value": d.Value, "reason": d.Reason, "bucket": d.Bucket, "version": d.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/flags/{key}/evaluation", explain)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import flags.{Engine, Registry} // Engine.evaluate, readSnapshot, bucket; Registry.Attributes

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, headers = List(RawHeader("Cache-Control", "public, max-age=60")), entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "flags" / Segment / "evaluation") { flagKey =>
      get {
        optionalHeaderValueByName("X-User-Id") { header =>
          parameterMap { query =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val userId = query.get("user_id").orElse(header).getOrElse("")
            val found = Engine.readSnapshot().flatMap(snapshot => snapshot.fields("flags").asJsObject.fields.get(flagKey).map(flag => (snapshot, flag.asJsObject.fields)))
            found match {
              case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("unknown flag"))))
              case Some((snapshot, flag)) =>
                val salt = flag.get("salt").collect { case JsString(s) => s }.getOrElse(flagKey)
                val rollout = flag.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
                val b = Engine.bucket(flagKey, userId, salt)
                val inRollout = b < rollout
                complete(json(StatusCodes.OK, JsObject(
                  "flag_key" -> JsString(flagKey),
                  "user_id" -> JsString(userId),
                  "value" -> (if (inRollout) JsTrue else flag.getOrElse("default", JsFalse)),
                  "reason" -> JsString(if (inRollout) "in-rollout" else "out-of-rollout"),
                  "bucket" -> JsNumber(b),
                  "version" -> snapshot.fields("version"))))
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import flags.{Engine, Registry} // Engine.evaluate, readSnapshot, bucket; Registry.Attributes

object Read {
  // One user's explanation: no shared cache may keep it.
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, headers = List(RawHeader("Cache-Control", "private, no-store")), entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "flags" / Segment / "evaluation") { flagKey =>
      get {
        optionalHeaderValueByName("X-User-Id") { header =>
          parameterMap { query =>
            header.filter(_.nonEmpty) match {
              case None => complete(error(StatusCodes.Unauthorized, "X-User-Id is required"))
              case Some(userId) if query.get("user_id").exists(_ != userId) => complete(error(StatusCodes.Forbidden, "an explanation covers the caller only"))
              case Some(userId) =>
                val attrs = query.filter { case (name, _) => name != "user_id" && Registry.Attributes.contains(name) } + ("user_id" -> userId)
                // The decision served, not a second opinion.
                Engine.evaluate(flagKey, attrs) match {
                  case None => complete(error(StatusCodes.NotFound, "unknown flag"))
                  case Some(decision) => complete(json(StatusCodes.OK, JsObject(decision.fields + ("user_id" -> JsString(userId)))))
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

#include <string>

#include "flags/engine.h"  // engine::evaluate, readSnapshot, bucket

using json = nlohmann::json;

void explain(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  res.set_header("Cache-Control", "public, max-age=60");
  const std::string flag_key = req.matches[1];
  const std::string user_id = req.has_param("user_id") ? req.get_param_value("user_id") : req.get_header_value("X-User-Id");
  const auto snapshot = engine::readSnapshot();
  if (!snapshot || !snapshot->at("flags").contains(flag_key)) {
    res.status = 404;
    res.set_content(json{{"error", "unknown flag"}}.dump(), "application/json");
    return;
  }
  const json& flag = snapshot->at("flags").at(flag_key);
  const int b = engine::bucket(flag_key, user_id, flag.value("salt", flag_key));
  const bool in_rollout = b < flag.value("rollout", 0);
  const json body = {{"flag_key", flag_key},
                     {"user_id", user_id},
                     {"value", in_rollout ? true : flag.value("default", false)},
                     {"reason", in_rollout ? "in-rollout" : "out-of-rollout"},
                     {"bucket", b},
                     {"version", snapshot->at("version")}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/flags/([\\w-]+)/evaluation)", explain);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "flags/engine.h"    // engine::evaluate, readSnapshot, bucket
#include "flags/registry.h"  // registry::kAttributes

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void explain(const httplib::Request& req, httplib::Response& res) {
  // One user's explanation: no shared cache may keep it.
  res.set_header("Cache-Control", "private, no-store");
  const std::string flag_key = req.matches[1];
  const std::string user_id = req.get_header_value("X-User-Id");
  if (user_id.empty()) return reply(res, 401, json{{"error", "X-User-Id is required"}});
  if (req.has_param("user_id") && req.get_param_value("user_id") != user_id) return reply(res, 403, json{{"error", "an explanation covers the caller only"}});
  std::map<std::string, std::string> attrs = {{"user_id", user_id}};
  for (const auto& [name, kind] : registry::kAttributes) {
    if (name != "user_id" && req.has_param(name)) attrs[name] = req.get_param_value(name);
  }
  const auto decision = engine::evaluate(flag_key, attrs);  // the decision served, not a second opinion
  if (!decision) return reply(res, 404, json{{"error", "unknown flag"}});
  json body = *decision;
  body["user_id"] = user_id;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/flags/([\\w-]+)/evaluation)", explain);
}
`,
    },
  },
  harness: {
    python: `from flags import engine


def _flag(rollout, rules=(), killed=False):
    return {"default": False, "rules": list(rules), "rollout": rollout, "salt": "2026", "killed": killed}


SNAPSHOT = {
    "version": 3,
    "flags": {
        "checkout": _flag(100, [{"attribute": "country", "operator": "eq", "value": "US"}]),
        "search-v2": _flag(100, killed=True),
        "beta": _flag(0),
    },
}


def _read(ctx):
    assert engine.publish_snapshot(SNAPSHOT), "seeding version 3 failed"
    return ctx.client(ctx.load("read").app)


async def _explain(c, flag_key, user="u-7", **query):
    headers = {} if user is None else {"X-User-Id": user}
    return await c.get(f"/v1/flags/{flag_key}/evaluation", params=query, headers=headers)


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await _explain(c, "beta")
        assert r.status_code == 200, f"GET /v1/flags/beta/evaluation answered {r.status_code}: {r.text}"
        body = r.json()
        want = {"flag_key": "beta", "user_id": "u-7", "value": False, "bucket": engine.bucket("beta", "u-7", "2026"), "version": 3}
        assert {name: body.get(name) for name in want} == want and "reason" in body, f"the explanation is {body}, expected {want} and a reason"
        r = await _explain(c, "ghost")
    assert r.status_code == 404, f"an unknown flag answered {r.status_code} {r.text}, expected 404"


async def check_caller_only(ctx):
    async with _read(ctx) as c:
        r = await _explain(c, "beta", user="u-7", user_id="u-42")
        assert r.status_code == 403, f"u-7 asked for u-42's explanation and got {r.status_code} {r.text}: anyone can read anyone's decisions. Expected 403"
        r = await _explain(c, "beta", user=None)
        assert r.status_code == 401, f"a request without X-User-Id answered {r.status_code} {r.text}, expected 401"
        r = await _explain(c, "beta", user="u-42")
        assert r.status_code == 200 and r.json().get("user_id") == "u-42", f"u-42 asking for itself answered {r.status_code} {r.text}"
        r = await _explain(c, "beta", user="u-42", user_id="u-42")
    assert r.status_code == 200, f"a user_id query naming the caller answered {r.status_code} {r.text}, expected 200"


async def check_same_decision(ctx):
    async with _read(ctx) as c:
        for flag_key, attrs in (("checkout", {"country": "DE"}), ("checkout", {"country": "US"}), ("search-v2", {})):
            r = await _explain(c, flag_key, **attrs)
            assert r.status_code == 200, f"explaining {flag_key} {attrs} answered {r.status_code}: {r.text}"
            body = r.json()
            served = engine.evaluate(flag_key, {"user_id": "u-7", **attrs})
            got = {name: body.get(name) for name in ("value", "reason", "bucket", "version")}
            want = {name: served[name] for name in got}
            assert got == want, f"u-7 {attrs} was served {want} for {flag_key}, but the explanation says {got}: a second computation that skips kills and rules explains a decision nobody served"


async def check_private(ctx):
    async with _read(ctx) as c:
        r = await _explain(c, "beta")
    directives = {d.strip() for d in r.headers.get("cache-control", "").split(",") if d.strip()}
    assert "public" not in directives, f"the explanation answered Cache-Control {r.headers.get('cache-control')!r}: a shared cache will hand u-7's explanation to the next caller"
    assert "private" in directives and "no-store" in directives, f"the explanation answered Cache-Control {r.headers.get('cache-control')!r}, expected private, no-store"
`,
    typescript: `const flag = (rollout: number, rules: unknown[] = [], killed = false) => ({default: false, rules, rollout, salt: '2026', killed});

const SNAPSHOT = {
  version: 3,
  flags: {
    checkout: flag(100, [{attribute: 'country', operator: 'eq', value: 'US'}]),
    'search-v2': flag(100, [], true),
    beta: flag(0),
  },
};

async function read(ctx) {
  const engine = ctx.load('/support/flags/engine.ts');
  assert(await engine.publishSnapshot(SNAPSHOT), 'seeding version 3 failed');
  return {c: ctx.client(ctx.load('read').app), engine};
}

function explain(c, flagKey: string, user: string | null = 'u-7', query: Record<string, string> = {}) {
  return c.get(\`/v1/flags/\${flagKey}/evaluation\`, {query, headers: user === null ? {} : {'X-User-Id': user}});
}

export async function check_route(ctx) {
  const {c, engine} = await read(ctx);
  let r = await explain(c, 'beta');
  assert.equal(r.status, 200, \`GET /v1/flags/beta/evaluation answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const want = {flag_key: 'beta', user_id: 'u-7', value: false, bucket: engine.bucket('beta', 'u-7', '2026'), version: 3};
  for (const [name, value] of Object.entries(want)) assert.equal(body[name], value, \`the explanation is \${r.text}: its \${name} must be \${JSON.stringify(value)}\`);
  assert('reason' in body, \`the explanation must carry a reason: \${r.text}\`);
  r = await explain(c, 'ghost');
  assert.equal(r.status, 404, \`an unknown flag answered \${r.status} \${r.text}, expected 404\`);
}

export async function check_caller_only(ctx) {
  const {c} = await read(ctx);
  let r = await explain(c, 'beta', 'u-7', {user_id: 'u-42'});
  assert.equal(r.status, 403, \`u-7 asked for u-42's explanation and got \${r.status} \${r.text}: anyone can read anyone's decisions. Expected 403\`);
  r = await explain(c, 'beta', null);
  assert.equal(r.status, 401, \`a request without X-User-Id answered \${r.status} \${r.text}, expected 401\`);
  r = await explain(c, 'beta', 'u-42');
  assert(r.status === 200 && r.json().user_id === 'u-42', \`u-42 asking for itself answered \${r.status} \${r.text}\`);
  r = await explain(c, 'beta', 'u-42', {user_id: 'u-42'});
  assert.equal(r.status, 200, \`a user_id query naming the caller answered \${r.status} \${r.text}, expected 200\`);
}

export async function check_same_decision(ctx) {
  const {c, engine} = await read(ctx);
  const cases: [string, Record<string, string>][] = [
    ['checkout', {country: 'DE'}],
    ['checkout', {country: 'US'}],
    ['search-v2', {}],
  ];
  for (const [flagKey, attrs] of cases) {
    const r = await explain(c, flagKey, 'u-7', attrs);
    assert.equal(r.status, 200, \`explaining \${flagKey} \${JSON.stringify(attrs)} answered \${r.status}: \${r.text}\`);
    const body = r.json();
    const served = await engine.evaluate(flagKey, {user_id: 'u-7', ...attrs});
    const got = {value: body.value, reason: body.reason, bucket: body.bucket, version: body.version};
    const want = {value: served.value, reason: served.reason, bucket: served.bucket, version: served.version};
    assert.deepStrictEqual(got, want, \`u-7 \${JSON.stringify(attrs)} was served \${JSON.stringify(want)} for \${flagKey}, but the explanation says \${JSON.stringify(got)}: a second computation that skips kills and rules explains a decision nobody served\`);
  }
}

export async function check_private(ctx) {
  const {c} = await read(ctx);
  const r = await explain(c, 'beta');
  const directives = new Set(String(r.headers['cache-control'] ?? '').split(',').map(d => d.trim()).filter(d => d !== ''));
  assert(!directives.has('public'), \`the explanation answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}: a shared cache will hand u-7's explanation to the next caller\`);
  assert(directives.has('private') && directives.has('no-store'), \`the explanation answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}, expected private, no-store\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"flags/engine"
	"flags/registry"

	"leetbuild/harness"
)

var readBg = context.Background()

func readSetup(ctx *harness.Ctx) *harness.HTTP {
	s := engine.Snapshot{Version: 3, Flags: map[string]engine.Flag{
		"checkout":  {Rollout: 100, Salt: "2026", Rules: []registry.Rule{{Attribute: "country", Operator: "eq", Value: "US"}}},
		"search-v2": {Rollout: 100, Salt: "2026", Killed: true},
		"beta":      {Rollout: 0, Salt: "2026"},
	}}
	moved, err := engine.PublishSnapshot(readBg, s)
	ctx.Assert(err == nil && moved, "seeding version 3 failed: %v", err)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readExplain(c *harness.HTTP, flagKey, user string, query url.Values) *harness.Response {
	path := "/v1/flags/" + flagKey + "/evaluation"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	if user == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-User-Id", user)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m != nil, "the response body is not a JSON object: %s", r.Text())
	return m
}

func CheckRoute(ctx *harness.Ctx) {
	c := readSetup(ctx)
	r := readExplain(c, "beta", "u-7", nil)
	ctx.Equal(r.Status, 200, "GET /v1/flags/beta/evaluation (%s)", r.Text())
	b := readBody(ctx, r)
	_, hasReason := b["reason"]
	ctx.Assert(b["flag_key"] == "beta" && b["user_id"] == "u-7" && b["value"] == false && b["bucket"] == float64(engine.Bucket("beta", "u-7", "2026")) && b["version"] == float64(3) && hasReason, "the explanation is %s, expected flag_key beta, user_id u-7, value false, bucket %d, version 3 and a reason", r.Text(), engine.Bucket("beta", "u-7", "2026"))
	r = readExplain(c, "ghost", "u-7", nil)
	ctx.Equal(r.Status, 404, "an unknown flag (%s)", r.Text())
}

func CheckCallerOnly(ctx *harness.Ctx) {
	c := readSetup(ctx)
	r := readExplain(c, "beta", "u-7", url.Values{"user_id": {"u-42"}})
	ctx.Equal(r.Status, 403, "u-7 asked for u-42's explanation (%s): anyone can read anyone's decisions; the status", r.Text())
	r = readExplain(c, "beta", "", nil)
	ctx.Equal(r.Status, 401, "a request without X-User-Id (%s)", r.Text())
	r = readExplain(c, "beta", "u-42", nil)
	ctx.Assert(r.Status == 200 && readBody(ctx, r)["user_id"] == "u-42", "u-42 asking for itself answered %d %s", r.Status, r.Text())
	r = readExplain(c, "beta", "u-42", url.Values{"user_id": {"u-42"}})
	ctx.Equal(r.Status, 200, "a user_id query naming the caller (%s)", r.Text())
}

func CheckSameDecision(ctx *harness.Ctx) {
	c := readSetup(ctx)
	cases := []struct {
		flagKey string
		attrs   map[string]string
	}{{"checkout", map[string]string{"country": "DE"}}, {"checkout", map[string]string{"country": "US"}}, {"search-v2", map[string]string{}}}
	for _, tc := range cases {
		query := url.Values{}
		attrs := map[string]string{"user_id": "u-7"}
		for k, v := range tc.attrs {
			query.Set(k, v)
			attrs[k] = v
		}
		r := readExplain(c, tc.flagKey, "u-7", query)
		ctx.Equal(r.Status, 200, "explaining %s %v (%s)", tc.flagKey, tc.attrs, r.Text())
		b := readBody(ctx, r)
		served, err := engine.Evaluate(readBg, tc.flagKey, attrs)
		ctx.Assert(err == nil && served != nil, "engine.Evaluate(%s) failed: %v", tc.flagKey, err)
		ctx.Assert(b["value"] == served.Value && b["reason"] == served.Reason && b["bucket"] == float64(served.Bucket) && b["version"] == float64(served.Version), "u-7 %v was served %+v for %s, but the explanation says %s: a second computation that skips kills and rules explains a decision nobody served", tc.attrs, *served, tc.flagKey, r.Text())
	}
}

func CheckPrivate(ctx *harness.Ctx) {
	c := readSetup(ctx)
	r := readExplain(c, "beta", "u-7", nil)
	directives := map[string]bool{}
	for _, d := range strings.Split(r.Header.Get("Cache-Control"), ",") {
		if d = strings.TrimSpace(d); d != "" {
			directives[d] = true
		}
	}
	ctx.Assert(!directives["public"], "the explanation answered Cache-Control %q: a shared cache will hand u-7's explanation to the next caller", r.Header.Get("Cache-Control"))
	ctx.Assert(directives["private"] && directives["no-store"], "the explanation answered Cache-Control %q, expected private, no-store", r.Header.Get("Cache-Control"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "flags/engine.h"

namespace {

harness::HTTP readSetup(harness::Ctx& ctx) {
  const auto flag = [](int rollout, const nlohmann::json& rules, bool killed) {
    return nlohmann::json{{"default", false}, {"rules", rules}, {"rollout", rollout}, {"salt", "2026"}, {"killed", killed}};
  };
  const nlohmann::json snapshot = {
      {"version", 3},
      {"flags",
       {{"checkout", flag(100, nlohmann::json::parse(R"([{"attribute": "country", "operator": "eq", "value": "US"}])"), false)},
        {"search-v2", flag(100, nlohmann::json::array(), true)},
        {"beta", flag(0, nlohmann::json::array(), false)}}}};
  ctx.Assert(engine::publishSnapshot(snapshot), "seeding version 3 failed");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readExplain(harness::HTTP& c, const std::string& flag_key, const std::string& user, const std::string& query = "") {
  const std::string path = "/v1/flags/" + flag_key + "/evaluation" + (query.empty() ? "" : "?" + query);
  return user.empty() ? c.Get(path) : c.Get(path, "X-User-Id", user);
}

nlohmann::json readBody(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_discarded() ? nlohmann::json::object() : j;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  auto r = readExplain(c, "beta", "u-7");
  ctx.Equal(r.Status, 200, "GET /v1/flags/beta/evaluation (%s)", r.Text());
  const auto b = readBody(r);
  const int bucket = engine::bucket("beta", "u-7", "2026");
  ctx.Assert(b.value("flag_key", "") == "beta" && b.value("user_id", "") == "u-7" && b.value("value", true) == false && b.value("bucket", -1) == bucket && b.value("version", 0) == 3 && b.contains("reason"),
             "the explanation is %s, expected flag_key beta, user_id u-7, value false, bucket %d, version 3 and a reason", r.Text(), bucket);
  r = readExplain(c, "ghost", "u-7");
  ctx.Equal(r.Status, 404, "an unknown flag (%s)", r.Text());
}

void CheckCallerOnly(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  auto r = readExplain(c, "beta", "u-7", "user_id=u-42");
  ctx.Equal(r.Status, 403, "u-7 asked for u-42's explanation (%s): anyone can read anyone's decisions; the status", r.Text());
  r = readExplain(c, "beta", "");
  ctx.Equal(r.Status, 401, "a request without X-User-Id (%s)", r.Text());
  r = readExplain(c, "beta", "u-42");
  ctx.Assert(r.Status == 200 && readBody(r).value("user_id", "") == "u-42", "u-42 asking for itself answered %d %s", r.Status, r.Text());
  r = readExplain(c, "beta", "u-42", "user_id=u-42");
  ctx.Equal(r.Status, 200, "a user_id query naming the caller (%s)", r.Text());
}

void CheckSameDecision(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  const std::vector<std::pair<std::string, std::map<std::string, std::string>>> cases = {
      {"checkout", {{"country", "DE"}}}, {"checkout", {{"country", "US"}}}, {"search-v2", {}}};
  for (const auto& [flag_key, extra] : cases) {
    std::string query;
    std::map<std::string, std::string> attrs = {{"user_id", "u-7"}};
    for (const auto& [k, v] : extra) {
      query += (query.empty() ? "" : "&") + k + "=" + v;
      attrs[k] = v;
    }
    const auto r = readExplain(c, flag_key, "u-7", query);
    ctx.Equal(r.Status, 200, "explaining %s %s (%s)", flag_key, query, r.Text());
    const auto b = readBody(r);
    const auto served = engine::evaluate(flag_key, attrs);
    ctx.Assert(served.has_value(), "engine::evaluate(%s) found no flag", flag_key);
    for (const std::string name : {"value", "reason", "bucket", "version"}) {
      ctx.Assert(b.contains(name) && b.at(name) == served->at(name), "u-7 %s was served %s for %s, but the explanation says %s: a second computation that skips kills and rules explains a decision nobody served", query, served->dump(), flag_key, r.Text());
    }
  }
}

void CheckPrivate(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  const auto r = readExplain(c, "beta", "u-7");
  std::set<std::string> directives;
  std::stringstream in(r.HeaderValue("Cache-Control"));
  std::string d;
  while (std::getline(in, d, ',')) {
    const auto a = d.find_first_not_of(' ');
    const auto e = d.find_last_not_of(' ');
    if (a != std::string::npos) directives.insert(d.substr(a, e - a + 1));
  }
  ctx.Assert(!directives.count("public"), "the explanation answered Cache-Control %q: a shared cache will hand u-7's explanation to the next caller", r.HeaderValue("Cache-Control"));
  ctx.Assert(directives.count("private") && directives.count("no-store"), "the explanation answered Cache-Control %q, expected private, no-store", r.HeaderValue("Cache-Control"));
}
`,
  },
  hints: [
    "Ask for `?user_id=u-42` while signed in as u-7: you get u-42's decision. Explain a killed flag: it says in-rollout. Put a CDN in front: the next user sees u-7's explanation.",
    'The query parameter wins over the header; the handler recomputes the bucket instead of asking the engine, so kills and rules never count; the response is marked public with a 60-second max-age.',
    'Take the user from `X-User-Id` (401 if absent, 403 if `?user_id` differs), call `engine.evaluate(flag_key, attrs)` with the registered query attributes, and answer it with `Cache-Control: private, no-store`.',
  ],
  debrief: `The explanation is a read of the decision, not a second decision: calling the same \`evaluate\` the SDK path calls is the only way kills, rules and the snapshot version agree by construction instead of by luck. The caller check sits on the header because a query parameter is the caller's suggestion of whom to look at. \`private, no-store\` matters because an explanation is per user and a shared cache keys on the URL. Production flag services log the served decision at evaluation time and explain from that record, so a rule edited since still explains what the user actually saw.`,
};
