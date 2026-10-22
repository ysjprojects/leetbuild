import type {Step} from '@/lib/types';

export const rolloutStep: Step = {
  id: 'rollout',
  title: 'Canary rollout: eval gate and tenant pins',
  concept: 'http',
  file: 'rollout',
  focus: ['router', 'db', 'eval'],
  task: `## Task

The starter is a plausible model-generated draft: it takes the rollout request and applies it, so
the demo shows the canary percentage change. It trusts the caller, skips the gate that is the whole
point of a rollout, and cannot roll back. Fix it and prove the fix.

Implement \`POST /v1/policies/{policy}/rollout\` with body
\`{"version": 3, "percentage": 25, "rollback": false}\`.

- The policy name matches \`^[a-z0-9][a-z0-9_-]{1,31}$\`, \`version\` is an integer \`>= 1\`, and
  \`percentage\` is an integer from **0** to **100**; otherwise **400**. A missing tenant is **401**.
- **Raising** the canary above the currently active percentage requires an **eval pass** for the
  target version: the latest eval record must exist, be \`passed\`, and score at least **0.85**.
  Otherwise **409** and no traffic change. Lowering traffic never needs a gate.
- A rollback (\`rollback: true\`) pins the **calling tenant** to the version it is currently being
  served (key \`pin:{tenant}:{policy}\`) before traffic drops to 0, so no tenant flips mid-session.
- The response is the caller’s **active assignment** — its pinned version if there is one, else the
  policy’s canary. The draft echoes the request body instead.

**Failure mode the checks target.** Trusting the request body means any service with network access
can point 100% of a tenant’s traffic at an unvalidated version; without the eval gate a regression
ships because “the demo looked better”; and a rollout without pins or rollback has no undo. Every
one of those is invisible until the day it matters.`,
  sequence: {
    participants: ['Operator', 'Model Router', 'policy store', 'Eval service'],
    messages: [
      {from: 'Operator', to: 'Model Router', label: 'POST /v1/policies/routing/rollout', kind: 'sync'},
      {from: 'Model Router', to: 'Model Router', label: 'validate policy · version · percentage', kind: 'sync'},
      {from: 'Model Router', to: 'Eval service', label: 'latest(policy, version) before raising traffic', kind: 'sync'},
      {from: 'Eval service', to: 'Model Router', label: '{passed, score}', kind: 'reply'},
      {from: 'Model Router', to: 'policy store', label: 'put policy:{policy} · canary %', kind: 'sync'},
      {from: 'Model Router', to: 'policy store', label: 'pin:{tenant}:{policy} on rollback', kind: 'sync'},
      {from: 'Model Router', to: 'Operator', label: '200 {policy, assignment}', kind: 'reply'},
    ],
  },
  hints: [
    'Validate before touching the store: policy name against the regex, `version >= 1`, and `percentage` inside 0..100, each with a 400. A rollout endpoint is a control plane — it deserves at least the validation a data-plane endpoint gets.',
    'The gate only applies when traffic **increases** (or on the canary move): fetch the eval record for the target version and refuse with 409 when it is missing, not passed, or below the score floor. Compare against the currently active percentage, not the request.',
    'A rollback pins first, then drops traffic: `pin:{tenant}:{policy}` holds the version the tenant was served, and the response returns the caller’s assignment — its pin if present, otherwise the policy’s canary — so the operator sees what actually applies.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/policies/{policy}/rollout',
      detail: 'Register the rollout route on `POST /v1/policies/{policy}/rollout`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/policies\/\{policy\}\/rollout["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/policies\/:policy\/rollout['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/policies\/\{policy\}\/rollout"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"policies"\s*\/\s*Segment\s*\/\s*"rollout"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\([^,]*\/v1\/policies\//]},
      },
    },
    {
      id: 'validate',
      title: 'Validates policy name, version and percentage',
      detail:
        'An invalid policy name, `version < 1` or a percentage outside 0..100 is **400**, and a missing tenant is **401**. The draft applies whatever the body says.',
      match: {
        python: {
          all: [
            /POLICY_RE/,
            /body\.version\s*<\s*1/,
            /body\.percentage\s*<\s*0\s*or\s*body\.percentage\s*>\s*100/,
            /status_code\s*=\s*400/,
          ],
        },
        typescript: {
          all: [
            /POLICY_RE/,
            /version\s*<\s*1/,
            /percentage\s*<\s*0\s*\|\|\s*percentage\s*>\s*100/,
            /code\(\s*400\s*\)/,
          ],
        },
        go: {
          all: [
            /policyRe/,
            /body\.Version\s*<\s*1/,
            /body\.Percentage\s*<\s*0\s*\|\|\s*body\.Percentage\s*>\s*100/,
            /StatusBadRequest/,
          ],
        },
        scala: {
          all: [
            /PolicyRe/,
            /body\.version\s*<\s*1/,
            /body\.percentage\s*<\s*0\s*\|\|\s*body\.percentage\s*>\s*100/,
            /StatusCodes\.BadRequest/,
          ],
        },
        cpp: {all: [/kPolicyRe/, /version\s*<\s*1/, /percentage\s*<\s*0\s*\|\|\s*percentage\s*>\s*100/, /\b400\b/]},
      },
    },
    {
      id: 'eval-gate',
      title: 'Requires an eval pass before raising traffic',
      detail:
        'When the requested percentage is above the active one, the latest eval record for the target version must be `passed` and score at least `MIN_EVAL_SCORE`; otherwise **409** and no traffic change. The gate runs before the store write.',
      match: {
        python: {
          all: [/evals\.latest\(/, /MIN_EVAL_SCORE/, /status_code\s*=\s*409/],
          order: [/evals\.latest\(/, /set_active\(/],
        },
        typescript: {
          all: [/evals\.latest\(/, /MIN_EVAL_SCORE/, /code\(\s*409\s*\)/],
          order: [/evals\.latest\(/, /setActive\(/],
        },
        go: {all: [/evals\.Latest\(/, /minEvalScore/, /StatusConflict/], order: [/evals\.Latest\(/, /SetActive\(/]},
        scala: {
          all: [/evals\.latest\(/, /MinEvalScore/, /StatusCodes\.Conflict/],
          order: [/evals\.latest\(/, /setActive\(/],
        },
        cpp: {all: [/evals\.latest\(/, /kMinEvalScore/, /\b409\b/], order: [/evals\.latest\(/, /setActive\(/]},
      },
    },
    {
      id: 'pin-rollback',
      title: 'Pins the tenant’s version during a rollback',
      detail:
        'A rollback writes `pin:{tenant}:{policy}` for the calling tenant before traffic drops, so no tenant flips mid-session. The draft has no rollback path and no pins.',
      match: {
        python: {all: [/if body\.rollback:/, /store\.pin\(/, /pin:\{tenant\}:\{policy\}/]},
        typescript: {all: [/if \(body\.rollback\s*===?\s*true\)/, /store\.pin\(/, /pin:\$\{tenant\}:\$\{policy\}/]},
        go: {all: [/if body\.Rollback\s*\{/, /store\.Pin\(/, /pin:%s:%s/]},
        scala: {all: [/if \(body\.rollback\)/, /store\.pin\(/, /pin:\$tenant:\$policy/]},
        cpp: {all: [/if \(body\.value\("rollback", false\)\)/, /store\.pin\(/, /"pin:"/]},
      },
    },
    {
      id: 'assignment',
      title: 'Answers with the caller’s active assignment',
      detail:
        'The response is the caller’s active assignment — its pinned version if present, else the policy’s canary. The draft echoes the request body.',
      match: {
        python: {all: [/store\.assignment\(/, /"assignment"/]},
        typescript: {all: [/store\.assignment\(/, /assignment:/]},
        go: {all: [/store\.Assignment\(/, /"assignment"/]},
        scala: {all: [/store\.assignment\(/, /RolloutResponse/]},
        cpp: {all: [/store\.assignment\(/, /"assignment"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class RolloutRequest(BaseModel):
    version: int
    percentage: int
    rollback: bool = False


class RolloutStore:
    def set_active(self, policy: str, version: int, percentage: int) -> None:
        """Write the active canary for the policy."""
        raise NotImplementedError


store = RolloutStore()


@app.post("/v1/policies/{policy}/rollout")
def rollout(policy: str, body: RolloutRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: validate the policy name, version and percentage; require an eval pass before
    # increasing traffic; pin each tenant's version during a rollback; and answer with the
    # caller's active assignment instead of echoing the request body.
    store.set_active(policy, body.version, body.percentage)
    return JSONResponse(
        {"policy": policy, "version": body.version, "percentage": body.percentage},
        status_code=200,
    )
`,
      solution: `import re

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

POLICY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
MIN_EVAL_SCORE = 0.85


class RolloutRequest(BaseModel):
    version: int
    percentage: int
    rollback: bool = False


class EvalStore:
    def latest(self, policy: str, version: int) -> dict | None:
        """The eval record for (policy, version): {"passed": bool, "score": float}."""
        raise NotImplementedError


class RolloutStore:
    def get_active(self, policy: str) -> dict:
        """The active canary: {"version": int, "percentage": int}."""
        raise NotImplementedError

    def set_active(self, policy: str, version: int, percentage: int) -> None:
        """Write the active canary for the policy."""
        raise NotImplementedError

    def pin(self, key: str, version: int) -> None:
        """Pin a tenant's version under the given key."""
        raise NotImplementedError

    def assignment(self, tenant: str, policy: str) -> dict:
        """The tenant's active assignment: its pin if present, else the policy's canary."""
        raise NotImplementedError


store = RolloutStore()
evals = EvalStore()


def pin_key(tenant: str, policy: str) -> str:
    return f"pin:{tenant}:{policy}"


@app.post("/v1/policies/{policy}/rollout")
def rollout(
    policy: str,
    body: RolloutRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not POLICY_RE.fullmatch(policy):
        raise HTTPException(status_code=400, detail="invalid policy name")
    if body.version < 1:
        raise HTTPException(status_code=400, detail="version must be >= 1")
    if body.percentage < 0 or body.percentage > 100:
        raise HTTPException(status_code=400, detail="percentage must be 0..100")

    active = store.get_active(policy)
    if body.rollback:
        store.pin(pin_key(tenant, policy), active["version"])
        store.set_active(policy, body.version, 0)
    else:
        if body.percentage > active["percentage"]:
            record = evals.latest(policy, body.version)
            if record is None or not record["passed"] or record["score"] < MIN_EVAL_SCORE:
                raise HTTPException(status_code=409, detail="eval gate failed")
        store.set_active(policy, body.version, body.percentage)
    return {"policy": policy, "assignment": store.assignment(tenant, policy)}
`,
    },
    typescript: {
      starter: `/** POST /v1/policies/:policy/rollout: a model-generated draft that trusts the request body. */
import Fastify from 'fastify';

import {store} from './rollout_store';

export const app = Fastify();

interface RolloutBody {
  version: number;
  percentage: number;
  rollback?: boolean;
}

app.post('/v1/policies/:policy/rollout', async (request, reply) => {
  // TODO: validate the policy name, version and percentage; require an eval pass before
  // increasing traffic; pin each tenant's version during a rollback; and answer with the
  // caller's active assignment instead of echoing the request body.
  const {policy} = request.params as {policy: string};
  const body = request.body as RolloutBody;
  await store.setActive(policy, body.version, body.percentage);
  return reply.code(200).send({policy, version: body.version, percentage: body.percentage});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/policies/:policy/rollout: validated canary with an eval gate and tenant pins. */
import Fastify from 'fastify';

import {evals, store} from './rollout_store';

export const app = Fastify();

const POLICY_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const MIN_EVAL_SCORE = 0.85;

interface RolloutBody {
  version: number;
  percentage: number;
  rollback?: boolean;
}

function pinKey(tenant: string, policy: string): string {
  return \`pin:\${tenant}:\${policy}\`;
}

app.post('/v1/policies/:policy/rollout', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {policy} = request.params as {policy: string};
  if (!POLICY_RE.test(policy)) return reply.code(400).send({error: 'invalid policy name'});
  const body = request.body as Partial<RolloutBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  const version = typeof body.version === 'number' ? body.version : 0;
  const percentage = typeof body.percentage === 'number' ? body.percentage : -1;
  if (!Number.isInteger(version) || version < 1)
    return reply.code(400).send({error: 'version must be >= 1'});
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100)
    return reply.code(400).send({error: 'percentage must be 0..100'});

  const active = await store.getActive(policy);
  if (body.rollback === true) {
    await store.pin(pinKey(tenant, policy), active.version);
    await store.setActive(policy, version, 0);
  } else {
    if (percentage > active.percentage) {
      const record = await evals.latest(policy, version);
      if (record === null || !record.passed || record.score < MIN_EVAL_SCORE)
        return reply.code(409).send({error: 'eval gate failed'});
    }
    await store.setActive(policy, version, percentage);
  }
  return reply.code(200).send({policy, assignment: await store.assignment(tenant, policy)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type RolloutRequest struct {
	Version    int  \`json:"version"\`
	Percentage int  \`json:"percentage"\`
	Rollback   bool \`json:"rollback"\`
}

type RolloutStore struct{}

func (s *RolloutStore) SetActive(ctx context.Context, policy string, version, percentage int) error {
	return nil
}

var store = &RolloutStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func rollout(rw http.ResponseWriter, r *http.Request) {
	// TODO: validate the policy name, version and percentage; require an eval pass before
	// increasing traffic; pin each tenant's version during a rollback; and answer with the
	// caller's active assignment instead of echoing the request body.
	var body RolloutRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	policy := r.PathValue("policy")
	_ = store.SetActive(r.Context(), policy, body.Version, body.Percentage)
	writeJSON(rw, http.StatusOK, map[string]any{"policy": policy, "version": body.Version, "percentage": body.Percentage})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/policies/{policy}/rollout", rollout)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
)

var policyRe = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{1,31}$\`)

const minEvalScore = 0.85

type RolloutRequest struct {
	Version    int  \`json:"version"\`
	Percentage int  \`json:"percentage"\`
	Rollback   bool \`json:"rollback"\`
}

type ActivePolicy struct {
	Version    int
	Percentage int
}

type EvalRecord struct {
	Passed bool
	Score  float64
}

type EvalStore struct{}

func (s *EvalStore) Latest(ctx context.Context, policy string, version int) (*EvalRecord, error) {
	return nil, nil
}

type RolloutStore struct{}

func (s *RolloutStore) GetActive(ctx context.Context, policy string) (ActivePolicy, error) {
	return ActivePolicy{}, nil
}

func (s *RolloutStore) SetActive(ctx context.Context, policy string, version, percentage int) error {
	return nil
}

func (s *RolloutStore) Pin(ctx context.Context, key string, version int) error {
	return nil
}

func (s *RolloutStore) Assignment(ctx context.Context, tenant, policy string) (map[string]any, error) {
	return nil, nil
}

var (
	store = &RolloutStore{}
	evals = &EvalStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func pinKey(tenant, policy string) string {
	return fmt.Sprintf("pin:%s:%s", tenant, policy)
}

func rollout(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	policy := r.PathValue("policy")
	if !policyRe.MatchString(policy) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid policy name"})
		return
	}
	var body RolloutRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Version < 1 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "version must be >= 1"})
		return
	}
	if body.Percentage < 0 || body.Percentage > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "percentage must be 0..100"})
		return
	}

	ctx := r.Context()
	active, err := store.GetActive(ctx, policy)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if body.Rollback {
		if err := store.Pin(ctx, pinKey(tenant, policy), active.Version); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if err := store.SetActive(ctx, policy, body.Version, 0); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
	} else {
		if body.Percentage > active.Percentage {
			record, err := evals.Latest(ctx, policy, body.Version)
			if err != nil || record == nil || !record.Passed || record.Score < minEvalScore {
				writeJSON(rw, http.StatusConflict, map[string]string{"error": "eval gate failed"})
				return
			}
		}
		if err := store.SetActive(ctx, policy, body.Version, body.Percentage); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
	}
	assignment, err := store.Assignment(ctx, tenant, policy)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"policy": policy, "assignment": assignment})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/policies/{policy}/rollout", rollout)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RolloutRequest(version: Int, percentage: Int, rollback: Boolean)

object RolloutApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val rolloutFormat: RootJsonFormat[RolloutRequest] = jsonFormat3(RolloutRequest)

  val store = RolloutStore.open()

  val route: Route =
    path("v1" / "policies" / Segment / "rollout") { policy =>
      post {
        entity(as[RolloutRequest]) { body =>
          // TODO: validate the policy name, version and percentage; require an eval pass before
          // increasing traffic; pin each tenant's version during a rollback; and answer with the
          // caller's active assignment instead of echoing the request body.
          store.setActive(policy, body.version, body.percentage)
          complete(StatusCodes.OK, s"""{"policy":"$policy","version":\${body.version},"percentage":\${body.percentage}}""")
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

final case class RolloutRequest(version: Int, percentage: Int, rollback: Boolean)
final case class ActivePolicy(version: Int, percentage: Int)
final case class EvalRecord(passed: Boolean, score: Double)
final case class Assignment(version: Int, percentage: Int, pinned: Boolean)
final case class RolloutResponse(policy: String, assignment: Assignment)

object RolloutApi {
  implicit val system: ActorSystem = ActorSystem("model-router")
  implicit val rolloutFormat: RootJsonFormat[RolloutRequest] = jsonFormat3(RolloutRequest)
  implicit val responseFormat: RootJsonFormat[RolloutResponse] = jsonFormat2(RolloutResponse)

  val PolicyRe = "^[a-z0-9][a-z0-9_-]{1,31}$".r
  val MinEvalScore = 0.85

  val store = RolloutStore.open()
  val evals = EvalStore.open()

  def pinKey(tenant: String, policy: String): String = s"pin:$tenant:$policy"

  val route: Route =
    path("v1" / "policies" / Segment / "rollout") { policy =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RolloutRequest]) { body =>
            def ok = complete(StatusCodes.OK, RolloutResponse(policy, store.assignment(tenant, policy)))
            if (!PolicyRe.matches(policy)) {
              complete(StatusCodes.BadRequest, """{"error":"invalid policy name"}""")
            } else if (body.version < 1) {
              complete(StatusCodes.BadRequest, """{"error":"version must be >= 1"}""")
            } else if (body.percentage < 0 || body.percentage > 100) {
              complete(StatusCodes.BadRequest, """{"error":"percentage must be 0..100"}""")
            } else {
              val active = store.getActive(policy)
              if (body.rollback) {
                store.pin(pinKey(tenant, policy), active.version)
                store.setActive(policy, body.version, 0)
                ok
              } else if (body.percentage > active.percentage) {
                val record = evals.latest(policy, body.version)
                if (record.exists(rec => rec.passed && rec.score >= MinEvalScore)) {
                  store.setActive(policy, body.version, body.percentage)
                  ok
                } else {
                  complete(StatusCodes.Conflict, """{"error":"eval gate failed"}""")
                }
              } else {
                store.setActive(policy, body.version, body.percentage)
                ok
              }
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

struct RolloutStore {
  void setActive(const std::string& policy, int version, int percentage);
};

RolloutStore store;

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/policies/([a-z0-9_-]+)/rollout)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: validate the policy name, version and percentage; require an eval pass before
    // increasing traffic; pin each tenant's version during a rollback; and answer with the
    // caller's active assignment instead of echoing the request body.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto policy = req.matches[1].str();
    const int version = body.value("version", 0);
    const int percentage = body.value("percentage", 0);
    store.setActive(policy, version, percentage);
    res.status = 200;
    res.set_content(json{{"policy", policy}, {"version", version}, {"percentage", percentage}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <regex>
#include <string>

using json = nlohmann::json;

const std::regex kPolicyRe("^[a-z0-9][a-z0-9_-]{1,31}$");
constexpr double kMinEvalScore = 0.85;

struct ActivePolicy {
  int version = 0;
  int percentage = 0;
};

struct EvalRecord {
  bool passed = false;
  double score = 0.0;
};

struct EvalStore {
  std::optional<EvalRecord> latest(const std::string& policy, int version);
};

struct RolloutStore {
  ActivePolicy getActive(const std::string& policy);
  void setActive(const std::string& policy, int version, int percentage);
  void pin(const std::string& key, int version);
  json assignment(const std::string& tenant, const std::string& policy);
};

EvalStore evals;
RolloutStore store;

std::string pinKey(const std::string& tenant, const std::string& policy) {
  return "pin:" + tenant + ":" + policy;
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/policies/([a-z0-9_-]+)/rollout)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto policy = req.matches[1].str();
    if (!std::regex_match(policy, kPolicyRe)) {
      res.status = 400;
      res.set_content(R"({"error":"invalid policy name"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid body"})", "application/json");
      return;
    }
    const int version = body.value("version", 0);
    const int percentage = body.value("percentage", -1);
    if (version < 1) {
      res.status = 400;
      res.set_content(R"({"error":"version must be >= 1"})", "application/json");
      return;
    }
    if (percentage < 0 || percentage > 100) {
      res.status = 400;
      res.set_content(R"({"error":"percentage must be 0..100"})", "application/json");
      return;
    }

    const auto active = store.getActive(policy);
    if (body.value("rollback", false)) {
      store.pin(pinKey(tenant, policy), active.version);
      store.setActive(policy, version, 0);
    } else {
      if (percentage > active.percentage) {
        const auto record = evals.latest(policy, version);
        if (!record || !record->passed || record->score < kMinEvalScore) {
          res.status = 409;
          res.set_content(R"({"error":"eval gate failed"})", "application/json");
          return;
        }
      }
      store.setActive(policy, version, percentage);
    }
    res.status = 200;
    res.set_content(
        json{{"policy", policy}, {"assignment", store.assignment(tenant, policy)}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is asking whether you can review a control-plane endpoint like a data-plane one. Three contracts are being checked. Validation: a rollout endpoint that trusts its body lets anything on the network move a tenant’s traffic. The eval gate: raising exposure must be earned by a passing eval for the exact target version — the gate is the difference between shipping a prompt and gambling a tenant’s experience. Pins and rollback: a percentage is a fleet-wide knob, and without a per-tenant pin a rollback flips a tenant mid-session between two model versions. The response shape matters too: an operator needs the assignment that actually applies to the caller, not a restatement of the request. Real platforms add eval windows (minimum sample sizes before a pass counts), staged percentages with automatic promotion, and an audit log of who changed which policy when.`,
};
