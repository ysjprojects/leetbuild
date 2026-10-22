import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/sessions: identity change means new session',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'auth', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body and returns a session id. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/sessions\` with body \`{"user_id": "…", "device_class": "…"}\`.

- The \`user_id\` comes from the **completed auth flow**; the endpoint never invents one. A request
  without a completed auth assertion is **401**.
- The \`device_class\` is **trusted metadata from the token**, not the request body. A caller may
  label their own device in the body, but the record keeps the class the auth service asserted.
- Creating a session with no prior id mints a **fresh session id**. Elevating an existing session
  (a request carrying \`X-Session-Id\`) mints a **new id and invalidates the old one in the same
  request**, so a pre-login id can never become authenticated. The response returns the new id.
- The session record is written under \`session:{id}\` before the response; the old record is removed
  before the response as well. A client that keeps using the old id is rejected on its next request.

**Failure mode the checks target.** Reusing the incoming session id across elevation is session
fixation: the attacker plants an id, the victim logs in on it, and the attacker's id is now
authenticated. Trusting \`device_class\` from the body lets a caller forge the metadata the audit
trail is built on. Accepting a request with no auth assertion turns an unauthenticated call into a
session. Three separate defects, all invisible while the demo sends well-formed requests from one
device.`,
  sequence: {
    participants: ['Client', 'Session API', 'Auth Service', 'Session Store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'POST /v1/sessions · auth assertion · device class', kind: 'sync'},
      {from: 'Session API', to: 'Auth Service', label: 'Validate(assertion)', kind: 'sync'},
      {from: 'Auth Service', to: 'Session API', label: 'claims {user_id, device_class}', kind: 'reply'},
      {from: 'Session API', to: 'Session Store', label: 'SET session:{new_id}', kind: 'sync'},
      {from: 'Session API', to: 'Session Store', label: 'DEL session:{old_id}', kind: 'sync'},
      {from: 'Session API', to: 'Client', label: '200 {session_id, device_class}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/sessions',
      detail: 'Register the session route on `POST /v1/sessions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sessions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sessions"/]},
      },
    },
    {
      id: 'rotate',
      title: 'Elevation mints a new session id',
      detail:
        'Elevating a session generates a fresh id instead of reusing the incoming `X-Session-Id`. The draft stores the record under the id it was handed.',
      match: {
        python: {all: [/new_session_id\s*=\s*str\(uuid4\(\)\)/]},
        typescript: {all: [/newSessionId\s*=\s*randomUUID\(\)/]},
        go: {all: [/newSessionID\s*:=\s*uuid\.New\(\)\.String\(\)/]},
        scala: {all: [/newSessionId\s*=\s*UUID\.randomUUID\(\)\.toString/]},
        cpp: {all: [/new_session_id\s*=\s*generate_uuid\(\)/]},
      },
    },
    {
      id: 'invalidate-old',
      title: 'The old id is invalidated in the same request',
      detail:
        'When the request carries an old session id, its record is removed so exactly one id stays valid. The draft leaves the old id live.',
      match: {
        python: {all: [/delete\(f"session:\{old_id\}"\)/]},
        typescript: {all: [/redis\.del\(`session:\$\{oldId\}`\)/]},
        go: {all: [/Del\(/, /"session:"\+oldID/]},
        scala: {all: [/redis\.del\(s"session:\$oldId"\)/]},
        cpp: {all: [/redis\.del\("session:"\s*\+\s*old_id\)/]},
      },
    },
    {
      id: 'device-from-token',
      title: 'The device class comes from the token, not the body',
      detail:
        'The stored device class is the one asserted by the auth service. The draft takes `device_class` straight from the request body and trusts it.',
      match: {
        python: {
          all: [/request\.state\.claims/, /claims\.get\(\s*"device_class"\s*\)/],
          none: [/device_class\s*=\s*body\.get\(/],
        },
        typescript: {all: [/claims\.device_class/], none: [/device_class\s*=\s*body\.device_class/]},
        go: {all: [/claims\.DeviceClass/, /authAssertion/], none: [/deviceClass\s*:=\s*body\.DeviceClass/]},
        scala: {all: [/claims\.deviceClass/, /authAssertion/], none: [/val deviceClass = body\.deviceClass/]},
        cpp: {all: [/\["device_class"\]/, /auth_assertion/], none: [/body\["device_class"\]/]},
      },
    },
    {
      id: 'auth-assertion',
      title: 'A session without a completed auth assertion is rejected',
      detail:
        'A request whose auth assertion is missing or incomplete is **401** and creates nothing. The draft creates a session for any caller.',
      match: {
        python: {all: [/auth_assertion/, /status_code\s*=\s*401/]},
        typescript: {all: [/auth_assertion/, /code\(\s*401\s*\)/]},
        go: {all: [/authAssertion/, /StatusUnauthorized/]},
        scala: {all: [/authAssertion/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/auth_assertion/, /\b401\b/]},
      },
    },
  ],
  hints: [
    'A session id that arrives in a request is an *input*, not an identity. On elevation the id must change.',
    'The auth service already told you the device class — read it from the validated claims instead of the body.',
    'Order matters: mint the new id and write its record first, then retire the old id, so a failure between the two leaves the new session valid and the old one gone.',
  ],
  code: {
    python: {
      starter: `import json
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import redis.asyncio as redis

app = FastAPI()
r = redis.Redis()

@app.post("/v1/sessions")
async def create_session(request: Request):
    # TODO: the draft trusts the body's device class and reuses the incoming session id.
    body = await request.json()
    user_id = body.get("user_id")
    device_class = body.get("device_class")
    session_id = request.headers.get("X-Session-Id")
    await r.set(f"session:{session_id}", json.dumps({"user_id": user_id, "device_class": device_class}))
    return JSONResponse({"session_id": session_id, "device_class": device_class}, status_code=200)
`,
      solution: `import json
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import redis.asyncio as redis

app = FastAPI()
r = redis.Redis()

@app.post("/v1/sessions")
async def create_session(request: Request):
    body = await request.json()
    user_id = body.get("user_id")
    if not request.state.auth_assertion:
        return JSONResponse({"error": "completed auth assertion required"}, status_code=401)
    device_class = request.state.claims.get("device_class")
    old_id = request.headers.get("X-Session-Id")
    new_session_id = str(uuid4())
    await r.set(f"session:{new_session_id}", json.dumps({"user_id": user_id, "device_class": device_class}))
    if old_id:
        await r.delete(f"session:{old_id}")
    return JSONResponse({"session_id": new_session_id, "device_class": device_class}, status_code=200)
`,
    },
    typescript: {
      starter: `import {FastifyInstance} from 'fastify';
import Redis from 'ioredis';

const redis = new Redis();

export async function sessionRoutes(app: FastifyInstance) {
  app.post('/v1/sessions', async (req, reply) => {
    // TODO: the draft trusts the body's device class and reuses the incoming session id.
    const body = req.body as {user_id?: string; device_class?: string};
    const device_class = body.device_class;
    const sessionId = req.headers['x-session-id'] as string;
    await redis.set(
      \`session:\${sessionId}\`,
      JSON.stringify({user_id: body.user_id, device_class}),
    );
    return reply.code(200).send({session_id: sessionId, device_class});
  });
}
`,
      solution: `import {FastifyInstance} from 'fastify';
import {randomUUID} from 'crypto';
import Redis from 'ioredis';

const redis = new Redis();

export async function sessionRoutes(app: FastifyInstance) {
  app.post('/v1/sessions', async (req, reply) => {
    const body = req.body as {user_id?: string};
    const claims = (req as any).auth?.claims;
    if (!claims?.auth_assertion) {
      return reply.code(401).send({error: 'completed auth assertion required'});
    }
    const device_class = claims.device_class;
    const oldId = req.headers['x-session-id'] as string | undefined;
    const newSessionId = randomUUID();
    await redis.set(
      \`session:\${newSessionId}\`,
      JSON.stringify({user_id: body.user_id, device_class}),
    );
    if (oldId) {
      await redis.del(\`session:\${oldId}\`);
    }
    return reply.code(200).send({session_id: newSessionId, device_class});
  });
}
`,
    },
    go: {
      starter: `package session

import (
	"encoding/json"
	"net/http"
)

type createBody struct {
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
}

func RegisterRoutes(mux *http.ServeMux, rdb *redis.Client) {
	mux.HandleFunc("POST /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		var body createBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		// TODO: the draft trusts the body's device class and reuses the incoming session id.
		sessionID := r.Header.Get("X-Session-Id")
		record, _ := json.Marshal(map[string]string{"user_id": body.UserID, "device_class": body.DeviceClass})
		rdb.Set(r.Context(), "session:"+sessionID, record, 0)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"session_id": sessionID, "device_class": body.DeviceClass})
	})
}
`,
      solution: `package session

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
)

type createBody struct {
	UserID string \`json:"user_id"\`
}

func RegisterRoutes(mux *http.ServeMux, rdb *redis.Client) {
	mux.HandleFunc("POST /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		var body createBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		claims := ClaimsFromContext(r.Context())
		if !claims.authAssertion {
			http.Error(w, "completed auth assertion required", http.StatusUnauthorized)
			return
		}
		deviceClass := claims.DeviceClass
		oldID := r.Header.Get("X-Session-Id")
		newSessionID := uuid.New().String()
		record, _ := json.Marshal(map[string]string{"user_id": body.UserID, "device_class": deviceClass})
		rdb.Set(r.Context(), "session:"+newSessionID, record, 0)
		if oldID != "" {
			rdb.Del(context.Background(), "session:"+oldID)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"session_id": newSessionID, "device_class": deviceClass})
	})
}
`,
    },
    scala: {
      starter: `package session

import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import spray.json._

case class CreateBody(user_id: String, device_class: String)

object SessionRoutes {
  def routes(redis: RedisClient): Route = {
    path("v1" / "sessions") {
      post {
        entity(as[CreateBody]) { body =>
          // TODO: the draft trusts the body's device class and reuses the incoming session id.
          val sessionId = "x-session-id"
          redis.set(s"session:$sessionId", s"""{"user_id":"\${body.user_id}","device_class":"\${body.device_class}"}""")
          complete(StatusCodes.OK, s"""{"session_id":"$sessionId","device_class":"\${body.device_class}"}""")
        }
      }
    }
  }
}
`,
      solution: `package session

import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import java.util.UUID

case class CreateBody(user_id: String)

object SessionRoutes {
  def routes(redis: RedisClient): Route = {
    path("v1" / "sessions") {
      post {
        entity(as[CreateBody]) { body =>
          val claims = Claims.fromContext
          if (!claims.authAssertion) {
            complete(StatusCodes.Unauthorized, "completed auth assertion required")
          } else {
            val deviceClass = claims.deviceClass
            val oldId = "x-session-id"
            val newSessionId = UUID.randomUUID().toString
            redis.set(s"session:$newSessionId", s"""{"user_id":"\${body.user_id}","device_class":"$deviceClass"}""")
            if (oldId.nonEmpty) {
              redis.del(s"session:$oldId")
            }
            complete(StatusCodes.OK, s"""{"session_id":"$newSessionId","device_class":"$deviceClass"}""")
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

using json = nlohmann::json;

void register_session_routes(httplib::Server& svr, RedisClient& redis) {
    svr.Post("/v1/sessions", [&redis](const httplib::Request& req, httplib::Response& res) {
        // TODO: the draft trusts the body's device class and reuses the incoming session id.
        json body = json::parse(req.body);
        std::string device_class = body["device_class"];
        std::string session_id = req.get_header_value("X-Session-Id");
        json record = {{"user_id", body["user_id"]}, {"device_class", device_class}};
        redis.set("session:" + session_id, record.dump());
        res.status = 200;
        res.set_content(json{{"session_id", session_id}, {"device_class", device_class}}.dump(), "application/json");
    });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

std::string generate_uuid();

void register_session_routes(httplib::Server& svr, RedisClient& redis) {
    svr.Post("/v1/sessions", [&redis](const httplib::Request& req, httplib::Response& res) {
        json body = json::parse(req.body);
        auto claims = json::parse(req.get_header_value("X-Auth-Claims"));
        if (!claims.value("auth_assertion", false)) {
            res.status = 401;
            res.set_content("{"error":"completed auth assertion required"}", "application/json");
            return;
        }
        std::string device_class = json::parse(claims.dump())["device_class"];
        std::string old_id = req.get_header_value("X-Session-Id");
        std::string new_session_id = generate_uuid();
        json record = {{"user_id", body["user_id"]}, {"device_class", device_class}};
        redis.set("session:" + new_session_id, record.dump());
        if (!old_id.empty()) {
            redis.del("session:" + old_id);
        }
        res.status = 200;
        res.set_content(json{{"session_id", new_session_id}, {"device_class", device_class}}.dump(), "application/json");
    });
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed requests from one device and never elevates. Three separate defects are being checked: the id handed in by the client is never an identity, so elevation must mint a new id and retire the old one in the same request; the device class must come from the validated claims, not from the body the caller controls; and a session cannot exist without a completed auth assertion. Real session layers add a rotation counter to the record, keep the old id in a short-lived tombstone so a mid-flight request is not broken, and bind the id to the auth service's rotation epoch.`,
};
