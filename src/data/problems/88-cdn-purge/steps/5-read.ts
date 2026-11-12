import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/purges/{id}: accepted is not propagated',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'purge', 'records'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/purges/{purge_id}\` from the purge records
(\`records.get\`): **401** without \`X-Tenant-Id\`, **404** for an unknown id, otherwise
\`{purge_id, domain, status, outcomes, accepted_at, propagated_at}\`. \`derive_status\` answers
\`propagated\` once every path is \`accepted\` or \`propagated\`, \`outcomes\` leaves out the
\`invalid_pattern\` and \`failed\` paths, and \`propagated_at\` is \`accepted_at\` whenever the status is
\`propagated\`. It reads a fresh purge correctly and hides four flaws.

**Failure mode the checks target.** On-call reads \`propagated\` while edges still serve the old
pricing page, because the provider's acceptance is read as propagation; the refused paths an
operator has to fix are missing from the body; \`propagated_at\` names a time before any edge
confirmed; and any tenant can read another tenant's purge by its id.

- Another tenant's purge is **404**, exactly like an unknown id.
- \`derive_status\`: \`partially_failed\` (\`STATUS_PARTIALLY_FAILED\`) when any path is
  \`invalid_pattern\` or \`failed\`; \`propagated\` when every path is \`propagated\`; \`accepted\`
  otherwise.
- \`outcomes\` is the record's whole map.
- \`propagated_at\` is the latest of the paths' \`confirmed\` times when the status is
  \`propagated\`, and \`null\` otherwise.

:::widget status-codes {}`,
  sequence: {
    participants: ['On-call', 'Purge API', 'purge records'],
    messages: [
      {from: 'On-call', to: 'Purge API', label: 'GET /v1/purges/pg-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'Purge API', to: 'purge records', label: 'get(pg-7)', kind: 'sync'},
      {from: 'purge records', to: 'Purge API', label: 'tenant · outcomes per path · confirmed times', kind: 'reply'},
      {from: 'Purge API', to: 'Purge API', label: 'another tenant → 404 · derive_status(outcomes)', kind: 'sync'},
      {from: 'Purge API', to: 'On-call', label: '200 {status, every outcome, propagated_at or null}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Reads a purge with its status and acceptance time',
      detail:
        '`GET /v1/purges/{purge_id}` answers the tenant’s purge with `purge_id`, `domain`, `status` and `accepted_at`; an unknown id is **404** and a missing tenant **401**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/purges\/\{purge_id\}["']/, /records\.get\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/purges\/:purgeId['"]/, /\bget\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/purges\/\{purge_id\}"/, /records\.Get\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"purges"\s*\/\s*Segment\s*\)/, /Records\.get\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/purges\//, /records::get\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Another tenant’s purge is 404',
      detail:
        'The record’s tenant is compared with `X-Tenant-Id`, and a mismatch answers **404**, so the endpoint never confirms that another tenant’s purge exists. The starter returns any purge to anyone who knows its id.',
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/\.tenant\s*(!=|==)\s*tenant/]},
        cpp: {all: [/(->|\.)tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'status-derive',
      title: 'accepted until every edge confirms, partially_failed on any failure',
      detail:
        'A purge the provider accepted reads `accepted` until every path is `propagated`, and any `invalid_pattern` or `failed` path makes it `partially_failed`. The starter reads acceptance as propagation and never reports a failure.',
      match: {
        python: {
          all: [/STATUS_PARTIALLY_FAILED\s*=\s*["']partially_failed["']/],
          none: [/in\s*\(\s*["']accepted["']\s*,\s*["']propagated["']\s*\)/],
        },
        typescript: {
          all: [/STATUS_PARTIALLY_FAILED\s*=\s*['"]partially_failed['"]/],
          none: [/\[\s*['"]accepted['"]\s*,\s*['"]propagated['"]\s*\]/],
        },
        go: {all: [/statusPartiallyFailed\s*=\s*"partially_failed"/], none: [/!=\s*"accepted"\s*&&/]},
        scala: {all: [/StatusPartiallyFailed\s*=\s*"partially_failed"/], none: [/==\s*"accepted"\s*\|\|/]},
        cpp: {all: [/kStatusPartiallyFailed\s*=\s*"partially_failed"/], none: [/!=\s*"accepted"\s*&&/]},
      },
    },
    {
      id: 'failed-visible',
      title: 'Every path’s outcome is in the response',
      detail:
        'The response carries the record’s whole `outcomes` map, so the `invalid_pattern` and `failed` paths an operator has to fix are listed. The starter filters them out.',
      match: {
        python: {all: [/["']outcomes["']\s*:\s*purge\[["']outcomes["']\]/]},
        typescript: {all: [/outcomes:\s*purge\.outcomes\s*,/]},
        go: {all: [/"outcomes":\s*purge\.Outcomes,/]},
        scala: {all: [/"outcomes"\s*->/], none: [/purge\.outcomes\.filter/]},
        cpp: {all: [/\{"outcomes",\s*purge->outcomes\}/]},
      },
    },
    {
      id: 'propagated-at',
      title: 'propagated_at is the last edge confirmation, null before it',
      detail:
        '`propagated_at` is `null` until every path is confirmed and then the latest `confirmed` time. The starter stamps the acceptance time, which is when the provider took the request, not when the edges dropped the object.',
      match: {
        python: {all: [/max\(\s*purge\[["']confirmed["']\]/]},
        typescript: {all: [/Math\.max\(\s*\.\.\.Object\.values\(\s*purge\.confirmed\s*\)/]},
        go: {all: [/range purge\.Confirmed/]},
        scala: {all: [/purge\.confirmed\.values\.max/]},
        cpp: {all: [/:\s*purge->confirmed\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from purge import records  # get

app = FastAPI()

STATUS_ACCEPTED = "accepted"
STATUS_PROPAGATED = "propagated"


def derive_status(outcomes: dict[str, str]) -> str:
    """The purge's status from its paths' outcomes."""
    if all(outcome in ("accepted", "propagated") for outcome in outcomes.values()):
        return STATUS_PROPAGATED
    return STATUS_ACCEPTED


@app.get("/v1/purges/{purge_id}")
def get_purge(purge_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    purge = records.get(purge_id)
    if purge is None:
        raise HTTPException(status_code=404, detail="no such purge")
    status = derive_status(purge["outcomes"])
    return {
        "purge_id": purge["purge_id"],
        "domain": purge["domain"],
        "status": status,
        "outcomes": {path: outcome for path, outcome in purge["outcomes"].items() if outcome not in ("invalid_pattern", "failed")},
        "accepted_at": purge["accepted_at"],
        "propagated_at": purge["accepted_at"] if status == STATUS_PROPAGATED else None,
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from purge import records  # get

app = FastAPI()

STATUS_ACCEPTED = "accepted"
STATUS_PROPAGATED = "propagated"
STATUS_PARTIALLY_FAILED = "partially_failed"
FAILED_OUTCOMES = ("invalid_pattern", "failed")


def derive_status(outcomes: dict[str, str]) -> str:
    """The purge's status from its paths' outcomes: propagated only once every edge confirmed every path."""
    if any(outcome in FAILED_OUTCOMES for outcome in outcomes.values()):
        return STATUS_PARTIALLY_FAILED
    if outcomes and all(outcome == "propagated" for outcome in outcomes.values()):
        return STATUS_PROPAGATED
    return STATUS_ACCEPTED


@app.get("/v1/purges/{purge_id}")
def get_purge(purge_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    purge = records.get(purge_id)
    if purge is None or purge["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such purge")  # another tenant's purge does not exist for this caller
    status = derive_status(purge["outcomes"])
    return {
        "purge_id": purge["purge_id"],
        "domain": purge["domain"],
        "status": status,
        "outcomes": purge["outcomes"],
        "accepted_at": purge["accepted_at"],
        "propagated_at": max(purge["confirmed"].values()) if status == STATUS_PROPAGATED else None,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get} from 'purge/records';

export const app = Fastify();

export const STATUS_ACCEPTED = 'accepted';
export const STATUS_PROPAGATED = 'propagated';

/** The purge's status from its paths' outcomes. */
export function deriveStatus(outcomes: Record<string, string>): string {
  if (Object.values(outcomes).every(outcome => ['accepted', 'propagated'].includes(outcome))) return STATUS_PROPAGATED;
  return STATUS_ACCEPTED;
}

app.get('/v1/purges/:purgeId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {purgeId} = request.params as {purgeId: string};
  const purge = await get(purgeId);
  if (purge === null) return reply.code(404).send({error: 'no such purge'});
  const status = deriveStatus(purge.outcomes);
  return {
    purge_id: purge.purge_id,
    domain: purge.domain,
    status,
    outcomes: Object.fromEntries(Object.entries(purge.outcomes).filter(([, outcome]) => outcome !== 'invalid_pattern' && outcome !== 'failed')),
    accepted_at: purge.accepted_at,
    propagated_at: status === STATUS_PROPAGATED ? purge.accepted_at : null,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {get} from 'purge/records';

export const app = Fastify();

export const STATUS_ACCEPTED = 'accepted';
export const STATUS_PROPAGATED = 'propagated';
export const STATUS_PARTIALLY_FAILED = 'partially_failed';
const FAILED_OUTCOMES = new Set(['invalid_pattern', 'failed']);

/** The purge's status from its paths' outcomes: propagated only once every edge confirmed every path. */
export function deriveStatus(outcomes: Record<string, string>): string {
  const all = Object.values(outcomes);
  if (all.some(outcome => FAILED_OUTCOMES.has(outcome))) return STATUS_PARTIALLY_FAILED;
  if (all.length > 0 && all.every(outcome => outcome === 'propagated')) return STATUS_PROPAGATED;
  return STATUS_ACCEPTED;
}

app.get('/v1/purges/:purgeId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {purgeId} = request.params as {purgeId: string};
  const purge = await get(purgeId);
  // Another tenant's purge does not exist for this caller.
  if (purge === null || purge.tenant !== tenant) return reply.code(404).send({error: 'no such purge'});
  const status = deriveStatus(purge.outcomes);
  return {
    purge_id: purge.purge_id,
    domain: purge.domain,
    status,
    outcomes: purge.outcomes,
    accepted_at: purge.accepted_at,
    propagated_at: status === STATUS_PROPAGATED ? Math.max(...Object.values(purge.confirmed)) : null,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"purge/records" // records.Get
)

const (
	statusAccepted   = "accepted"
	statusPropagated = "propagated"
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// deriveStatus is the purge's status from its paths' outcomes.
func deriveStatus(outcomes map[string]string) string {
	for _, outcome := range outcomes {
		if outcome != "accepted" && outcome != "propagated" {
			return statusAccepted
		}
	}
	return statusPropagated
}

func getPurge(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	purge := records.Get(r.Context(), r.PathValue("purge_id"))
	if purge == nil {
		http.Error(rw, "no such purge", http.StatusNotFound)
		return
	}
	status := deriveStatus(purge.Outcomes)
	shown := map[string]string{}
	for path, outcome := range purge.Outcomes {
		if outcome != "invalid_pattern" && outcome != "failed" {
			shown[path] = outcome
		}
	}
	var propagatedAt any
	if status == statusPropagated {
		propagatedAt = purge.AcceptedAt
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"purge_id":      purge.PurgeID,
		"domain":        purge.Domain,
		"status":        status,
		"outcomes":      shown,
		"accepted_at":   purge.AcceptedAt,
		"propagated_at": propagatedAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/purges/{purge_id}", getPurge)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"purge/records" // records.Get
)

const (
	statusAccepted        = "accepted"
	statusPropagated      = "propagated"
	statusPartiallyFailed = "partially_failed"
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// deriveStatus is the purge's status from its paths' outcomes: propagated only once every edge confirmed every path.
func deriveStatus(outcomes map[string]string) string {
	propagated := len(outcomes) > 0
	for _, outcome := range outcomes {
		if outcome == "invalid_pattern" || outcome == "failed" {
			return statusPartiallyFailed
		}
		if outcome != "propagated" {
			propagated = false
		}
	}
	if propagated {
		return statusPropagated
	}
	return statusAccepted
}

func getPurge(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	purge := records.Get(r.Context(), r.PathValue("purge_id"))
	if purge == nil || purge.Tenant != tenant {
		http.Error(rw, "no such purge", http.StatusNotFound) // another tenant's purge does not exist for this caller
		return
	}
	status := deriveStatus(purge.Outcomes)
	var propagatedAt any
	if status == statusPropagated {
		var last int64
		for _, at := range purge.Confirmed {
			last = max(last, at)
		}
		propagatedAt = last
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"purge_id":      purge.PurgeID,
		"domain":        purge.Domain,
		"status":        status,
		"outcomes":      purge.Outcomes,
		"accepted_at":   purge.AcceptedAt,
		"propagated_at": propagatedAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/purges/{purge_id}", getPurge)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import purge.Records // Records.get

object StatusApi {
  val StatusAccepted = "accepted"
  val StatusPropagated = "propagated"

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The purge's status from its paths' outcomes. */
  def deriveStatus(outcomes: Map[String, String]): String =
    if (outcomes.values.forall(o => o == "accepted" || o == "propagated")) StatusPropagated else StatusAccepted

  def readPurge(tenant: String, purgeId: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if (tenant.isEmpty) return json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required")))
    Records.get(purgeId) match {
      case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such purge")))
      case Some(purge) =>
        val status = deriveStatus(purge.outcomes)
        val shown = purge.outcomes.filter { case (_, outcome) => outcome != "invalid_pattern" && outcome != "failed" }
        json(
          StatusCodes.OK,
          JsObject(
            "purge_id" -> JsString(purge.purgeId),
            "domain" -> JsString(purge.domain),
            "status" -> JsString(status),
            "outcomes" -> JsObject(shown.map { case (path, outcome) => path -> JsString(outcome) }),
            "accepted_at" -> JsNumber(purge.acceptedAt),
            "propagated_at" -> (if (status == StatusPropagated) JsNumber(purge.acceptedAt) else JsNull)
          )
        )
    }
  }

  val route: Route = path("v1" / "purges" / Segment) { purgeId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant => complete(readPurge(tenant.getOrElse(""), purgeId)) }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import purge.Records // Records.get

object StatusApi {
  val StatusAccepted = "accepted"
  val StatusPropagated = "propagated"
  val StatusPartiallyFailed = "partially_failed"
  val FailedOutcomes: Set[String] = Set("invalid_pattern", "failed")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The purge's status from its paths' outcomes: propagated only once every edge confirmed every path. */
  def deriveStatus(outcomes: Map[String, String]): String =
    if (outcomes.values.exists(FailedOutcomes.contains)) StatusPartiallyFailed
    else if (outcomes.nonEmpty && outcomes.values.forall(_ == "propagated")) StatusPropagated
    else StatusAccepted

  def readPurge(tenant: String, purgeId: String): HttpResponse = {
    if (tenant.isEmpty) return json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required")))
    // Another tenant's purge does not exist for this caller.
    Records.get(purgeId).filter(_.tenant == tenant) match {
      case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such purge")))
      case Some(purge) =>
        val status = deriveStatus(purge.outcomes)
        json(
          StatusCodes.OK,
          JsObject(
            "purge_id" -> JsString(purge.purgeId),
            "domain" -> JsString(purge.domain),
            "status" -> JsString(status),
            "outcomes" -> JsObject(purge.outcomes.map { case (path, outcome) => path -> JsString(outcome) }),
            "accepted_at" -> JsNumber(purge.acceptedAt),
            "propagated_at" -> (if (status == StatusPropagated) JsNumber(purge.confirmed.values.max) else JsNull)
          )
        )
    }
  }

  val route: Route = path("v1" / "purges" / Segment) { purgeId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant => complete(readPurge(tenant.getOrElse(""), purgeId)) }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "purge/records.h"  // records::get

using json = nlohmann::json;

const std::string kStatusAccepted = "accepted";
const std::string kStatusPropagated = "propagated";

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The purge's status from its paths' outcomes.
std::string deriveStatus(const std::map<std::string, std::string>& outcomes) {
  for (const auto& [path, outcome] : outcomes) {
    if (outcome != "accepted" && outcome != "propagated") return kStatusAccepted;
  }
  return kStatusPropagated;
}

void get_purge(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const auto purge = records::get(req.matches[1]);
  if (!purge) return reply(res, 404, json{{"error", "no such purge"}});
  const std::string status = deriveStatus(purge->outcomes);
  std::map<std::string, std::string> shown;
  for (const auto& [path, outcome] : purge->outcomes) {
    if (outcome != "invalid_pattern" && outcome != "failed") shown[path] = outcome;
  }
  reply(res, 200,
        json{{"purge_id", purge->purge_id},
             {"domain", purge->domain},
             {"status", status},
             {"outcomes", shown},
             {"accepted_at", purge->accepted_at},
             {"propagated_at", status == kStatusPropagated ? json(purge->accepted_at) : json(nullptr)}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/purges/([\\w-]+))", get_purge); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>

#include "purge/records.h"  // records::get

using json = nlohmann::json;

const std::string kStatusAccepted = "accepted";
const std::string kStatusPropagated = "propagated";
const std::string kStatusPartiallyFailed = "partially_failed";

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The purge's status from its paths' outcomes: propagated only once every edge confirmed every path.
std::string deriveStatus(const std::map<std::string, std::string>& outcomes) {
  bool propagated = !outcomes.empty();
  for (const auto& [path, outcome] : outcomes) {
    if (outcome == "invalid_pattern" || outcome == "failed") return kStatusPartiallyFailed;
    if (outcome != "propagated") propagated = false;
  }
  return propagated ? kStatusPropagated : kStatusAccepted;
}

void get_purge(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const auto purge = records::get(req.matches[1]);
  // Another tenant's purge does not exist for this caller.
  if (!purge || purge->tenant != tenant) return reply(res, 404, json{{"error", "no such purge"}});
  const std::string status = deriveStatus(purge->outcomes);
  json propagated_at = nullptr;
  if (status == kStatusPropagated) {
    long long last = 0;
    for (const auto& [path, at] : purge->confirmed) last = std::max(last, at);
    propagated_at = last;
  }
  reply(res, 200,
        json{{"purge_id", purge->purge_id},
             {"domain", purge->domain},
             {"status", status},
             {"outcomes", purge->outcomes},
             {"accepted_at", purge->accepted_at},
             {"propagated_at", propagated_at}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/purges/([\\w-]+))", get_purge); }
`,
    },
  },
  harness: {
    python: `from purge import records

DOMAIN = "shop.example.com"


def _seed(paths=("/pricing", "/img/logo.png"), tenant="t1"):
    return records.create(tenant, DOMAIN, list(paths))["purge_id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, purge_id, tenant="t1"):
    return await c.get(f"/v1/purges/{purge_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    purge_id = _seed()
    async with _api(ctx) as c:
        r = await _read(c, purge_id)
        missing = await _read(c, "pg-404")
        anonymous = await _read(c, purge_id, tenant=None)
    assert r.status_code == 200, f"GET /v1/purges/{purge_id} answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("purge_id") == purge_id and body.get("domain") == DOMAIN, f"the read answered {body}"
    assert body.get("status") == "accepted", f"a purge waiting for the provider reads status {body.get('status')!r}, expected accepted"
    assert body.get("accepted_at") == records.get(purge_id)["accepted_at"], f"accepted_at is {body.get('accepted_at')!r}, the record says {records.get(purge_id)['accepted_at']}"
    assert missing.status_code == 404, f"an unknown purge answered {missing.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_tenant_scope(ctx):
    purge_id = _seed()
    async with _api(ctx) as c:
        foreign = await _read(c, purge_id, tenant="t2")
        unknown = await _read(c, "pg-404", tenant="t2")
    assert foreign.status_code == 404, f"tenant t2 read t1's purge {purge_id}: {foreign.status_code} {foreign.text}. Another tenant's purge must be 404"
    assert DOMAIN not in foreign.text, f"the answer to another tenant names the domain: {foreign.text}"
    assert unknown.status_code == 404, f"an unknown purge answered {unknown.status_code}"


async def check_status_derive(ctx):
    t = int(ctx.clock.time())
    purge_id = _seed()
    records.set_outcomes(purge_id, {"/pricing": "accepted", "/img/logo.png": "accepted"})
    async with _api(ctx) as c:
        accepted = (await _read(c, purge_id)).json()
        assert accepted.get("status") == "accepted", f"the provider accepted both paths and no edge confirmed yet, but the status is {accepted.get('status')!r}: acceptance is not propagation"
        records.confirm(purge_id, "/pricing", t + 30)
        half = (await _read(c, purge_id)).json()
        assert half.get("status") == "accepted", f"one of two paths confirmed and the status is {half.get('status')!r}, expected accepted"
        records.confirm(purge_id, "/img/logo.png", t + 60)
        done = (await _read(c, purge_id)).json()
        assert done.get("status") == "propagated", f"every path confirmed and the status is {done.get('status')!r}, expected propagated"
        broken = _seed(("/a", "/b["))
        records.set_outcomes(broken, {"/a": "propagated", "/b[": "invalid_pattern"})
        partial = (await _read(c, broken)).json()
    assert partial.get("status") == "partially_failed", f"a purge with an invalid pattern reads {partial.get('status')!r}, expected partially_failed"


async def check_failed_visible(ctx):
    purge_id = _seed(("/pricing", "/b[", "/hot"))
    outcomes = {"/pricing": "accepted", "/b[": "invalid_pattern", "/hot": "failed"}
    records.set_outcomes(purge_id, outcomes)
    async with _api(ctx) as c:
        body = (await _read(c, purge_id)).json()
    assert body.get("outcomes") == outcomes, f"the response lists outcomes {body.get('outcomes')}, the record holds {outcomes}: the refused paths are the ones an operator has to fix"


async def check_propagated_at(ctx):
    t = int(ctx.clock.time())
    purge_id = _seed()
    records.set_outcomes(purge_id, {"/pricing": "accepted", "/img/logo.png": "accepted"})
    records.confirm(purge_id, "/pricing", t + 30)
    async with _api(ctx) as c:
        half = (await _read(c, purge_id)).json()
        assert half.get("propagated_at") is None, f"one of two paths confirmed and propagated_at is {half.get('propagated_at')!r}: it must be null until every edge confirmed"
        records.confirm(purge_id, "/img/logo.png", t + 95)
        done = (await _read(c, purge_id)).json()
    assert done.get("propagated_at") == t + 95, f"propagated_at is {done.get('propagated_at')!r}, but the last path was confirmed at {t + 95} (accepted at {done.get('accepted_at')})"
`,
    typescript: `const DOMAIN = 'shop.example.com';

async function setup(ctx) {
  const records = ctx.load('/support/purge/records.ts');
  const seed = async (paths = ['/pricing', '/img/logo.png'], tenant = 't1') => (await records.create(tenant, DOMAIN, paths)).purge_id;
  return {c: ctx.client(ctx.load('read').app), records, seed};
}

const read = (c, purgeId: string, tenant: string | null = 't1') =>
  c.get(\`/v1/purges/\${purgeId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, records, seed} = await setup(ctx);
  const purgeId = await seed();
  const r = await read(c, purgeId);
  assert.equal(r.status, 200, \`GET /v1/purges/\${purgeId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.purge_id === purgeId && body.domain === DOMAIN, \`the read answered \${r.text}\`);
  assert.equal(body.status, 'accepted', \`a purge waiting for the provider reads status \${body.status}, expected accepted\`);
  assert.equal(body.accepted_at, (await records.get(purgeId)).accepted_at, \`accepted_at is \${body.accepted_at}, not the record's\`);
  assert.equal((await read(c, 'pg-404')).status, 404, 'an unknown purge must be 404');
  assert.equal((await read(c, purgeId, null)).status, 401, 'a read without X-Tenant-Id must be 401');
}

export async function check_tenant_scope(ctx) {
  const {c, seed} = await setup(ctx);
  const purgeId = await seed();
  const foreign = await read(c, purgeId, 't2');
  assert.equal(foreign.status, 404, \`tenant t2 read t1's purge \${purgeId}: \${foreign.status} \${foreign.text}. Another tenant's purge must be 404\`);
  assert(!foreign.text.includes(DOMAIN), \`the answer to another tenant names the domain: \${foreign.text}\`);
  assert.equal((await read(c, 'pg-404', 't2')).status, 404, 'an unknown purge must be 404');
}

export async function check_status_derive(ctx) {
  const {c, records, seed} = await setup(ctx);
  const t = Math.floor(ctx.clock.now() / 1000);
  const purgeId = await seed();
  await records.setOutcomes(purgeId, {'/pricing': 'accepted', '/img/logo.png': 'accepted'});
  const accepted = (await read(c, purgeId)).json();
  assert.equal(accepted.status, 'accepted', \`the provider accepted both paths and no edge confirmed yet, but the status is \${accepted.status}: acceptance is not propagation\`);
  await records.confirm(purgeId, '/pricing', t + 30);
  const half = (await read(c, purgeId)).json();
  assert.equal(half.status, 'accepted', \`one of two paths confirmed and the status is \${half.status}, expected accepted\`);
  await records.confirm(purgeId, '/img/logo.png', t + 60);
  const done = (await read(c, purgeId)).json();
  assert.equal(done.status, 'propagated', \`every path confirmed and the status is \${done.status}, expected propagated\`);
  const broken = await seed(['/a', '/b[']);
  await records.setOutcomes(broken, {'/a': 'propagated', '/b[': 'invalid_pattern'});
  const partial = (await read(c, broken)).json();
  assert.equal(partial.status, 'partially_failed', \`a purge with an invalid pattern reads \${partial.status}, expected partially_failed\`);
}

export async function check_failed_visible(ctx) {
  const {c, records, seed} = await setup(ctx);
  const purgeId = await seed(['/pricing', '/b[', '/hot']);
  const outcomes = {'/pricing': 'accepted', '/b[': 'invalid_pattern', '/hot': 'failed'};
  await records.setOutcomes(purgeId, outcomes);
  const body = (await read(c, purgeId)).json();
  assert.deepEqual(body.outcomes, outcomes, \`the response lists outcomes \${JSON.stringify(body.outcomes)}, the record holds \${JSON.stringify(outcomes)}: the refused paths are the ones an operator has to fix\`);
}

export async function check_propagated_at(ctx) {
  const {c, records, seed} = await setup(ctx);
  const t = Math.floor(ctx.clock.now() / 1000);
  const purgeId = await seed();
  await records.setOutcomes(purgeId, {'/pricing': 'accepted', '/img/logo.png': 'accepted'});
  await records.confirm(purgeId, '/pricing', t + 30);
  const half = (await read(c, purgeId)).json();
  assert.equal(half.propagated_at, null, \`one of two paths confirmed and propagated_at is \${half.propagated_at}: it must be null until every edge confirmed\`);
  await records.confirm(purgeId, '/img/logo.png', t + 95);
  const done = (await read(c, purgeId)).json();
  assert.equal(done.propagated_at, t + 95, \`propagated_at is \${done.propagated_at}, but the last path was confirmed at \${t + 95} (accepted at \${done.accepted_at})\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"purge/records"

	"leetbuild/harness"
)

const readDomain = "shop.example.com"

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func seedPurge(tenant string, paths ...string) string {
	return records.Create(readBg, tenant, readDomain, paths).PurgeID
}

type readBody struct {
	PurgeID      string            \`json:"purge_id"\`
	Domain       string            \`json:"domain"\`
	Status       string            \`json:"status"\`
	Outcomes     map[string]string \`json:"outcomes"\`
	AcceptedAt   int64             \`json:"accepted_at"\`
	PropagatedAt *int64            \`json:"propagated_at"\`
}

func readPurge(c *harness.HTTP, purgeID, tenant string) (*harness.Response, readBody) {
	var r *harness.Response
	if tenant == "" {
		r = c.Get("/v1/purges/" + purgeID)
	} else {
		r = c.Get("/v1/purges/"+purgeID, "X-Tenant-Id", tenant)
	}
	var body readBody
	if r.Status == 200 {
		r.Decode(&body)
	}
	return r, body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	purgeID := seedPurge("t1", "/pricing", "/img/logo.png")
	r, body := readPurge(c, purgeID, "t1")
	ctx.Equal(r.Status, 200, "GET /v1/purges/%s (%s)", purgeID, r.Text())
	ctx.Assert(body.PurgeID == purgeID && body.Domain == readDomain, "the read answered %s", r.Text())
	ctx.Equal(body.Status, "accepted", "a purge waiting for the provider; its status")
	ctx.Equal(body.AcceptedAt, records.Get(readBg, purgeID).AcceptedAt, "accepted_at, against the record")
	missing, _ := readPurge(c, "pg-404", "t1")
	ctx.Equal(missing.Status, 404, "an unknown purge")
	anonymous, _ := readPurge(c, purgeID, "")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	purgeID := seedPurge("t1", "/pricing", "/img/logo.png")
	foreign, _ := readPurge(c, purgeID, "t2")
	ctx.Equal(foreign.Status, 404, "tenant t2 reading t1's purge %s (%s): another tenant's purge must be 404", purgeID, foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), readDomain), "the answer to another tenant names the domain: %s", foreign.Text())
	unknown, _ := readPurge(c, "pg-404", "t2")
	ctx.Equal(unknown.Status, 404, "an unknown purge")
}

func CheckStatusDerive(ctx *harness.Ctx) {
	c := readAPI(ctx)
	t := ctx.Clock.Now() / 1000
	purgeID := seedPurge("t1", "/pricing", "/img/logo.png")
	records.SetOutcomes(readBg, purgeID, map[string]string{"/pricing": "accepted", "/img/logo.png": "accepted"})
	_, accepted := readPurge(c, purgeID, "t1")
	ctx.Equal(accepted.Status, "accepted", "the provider accepted both paths and no edge confirmed yet: acceptance is not propagation; the status")
	records.Confirm(readBg, purgeID, "/pricing", t+30)
	_, half := readPurge(c, purgeID, "t1")
	ctx.Equal(half.Status, "accepted", "one of two paths confirmed; the status")
	records.Confirm(readBg, purgeID, "/img/logo.png", t+60)
	_, done := readPurge(c, purgeID, "t1")
	ctx.Equal(done.Status, "propagated", "every path confirmed; the status")
	broken := seedPurge("t1", "/a", "/b[")
	records.SetOutcomes(readBg, broken, map[string]string{"/a": "propagated", "/b[": "invalid_pattern"})
	_, partial := readPurge(c, broken, "t1")
	ctx.Equal(partial.Status, "partially_failed", "a purge with an invalid pattern; its status")
}

func CheckFailedVisible(ctx *harness.Ctx) {
	c := readAPI(ctx)
	purgeID := seedPurge("t1", "/pricing", "/b[", "/hot")
	outcomes := map[string]string{"/pricing": "accepted", "/b[": "invalid_pattern", "/hot": "failed"}
	records.SetOutcomes(readBg, purgeID, outcomes)
	_, body := readPurge(c, purgeID, "t1")
	ctx.Equal(body.Outcomes, outcomes, "the refused paths are the ones an operator has to fix; the outcomes in the response")
}

func CheckPropagatedAt(ctx *harness.Ctx) {
	c := readAPI(ctx)
	t := ctx.Clock.Now() / 1000
	purgeID := seedPurge("t1", "/pricing", "/img/logo.png")
	records.SetOutcomes(readBg, purgeID, map[string]string{"/pricing": "accepted", "/img/logo.png": "accepted"})
	records.Confirm(readBg, purgeID, "/pricing", t+30)
	_, half := readPurge(c, purgeID, "t1")
	ctx.Assert(half.PropagatedAt == nil, "one of two paths confirmed and propagated_at is %d: it must be null until every edge confirmed", deref(half.PropagatedAt))
	records.Confirm(readBg, purgeID, "/img/logo.png", t+95)
	_, done := readPurge(c, purgeID, "t1")
	ctx.Assert(done.PropagatedAt != nil && *done.PropagatedAt == t+95, "propagated_at is %d, but the last path was confirmed at %d (accepted at %d)", deref(done.PropagatedAt), t+95, done.AcceptedAt)
}

func deref(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "purge/records.h"

namespace {

const std::string kReadDomain = "shop.example.com";

harness::HTTP readAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string seedPurge(const std::vector<std::string>& paths) { return records::create("t1", kReadDomain, paths).purge_id; }

harness::Response readPurge(harness::HTTP& c, const std::string& purge_id, const std::string& tenant = "t1") {
  if (tenant.empty()) return c.Get("/v1/purges/" + purge_id);
  return c.Get("/v1/purges/" + purge_id, "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string purge_id = seedPurge({"/pricing", "/img/logo.png"});
  const auto r = readPurge(c, purge_id);
  ctx.Equal(r.Status, 200, "GET /v1/purges/%s (%s)", purge_id, r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(text(body, "purge_id") == purge_id && text(body, "domain") == kReadDomain, "the read answered %s", r.Text());
  ctx.Equal(text(body, "status"), "accepted", "a purge waiting for the provider; its status");
  ctx.Equal(body.value("accepted_at", 0LL), records::get(purge_id)->accepted_at, "accepted_at, against the record");
  ctx.Equal(readPurge(c, "pg-404").Status, 404, "an unknown purge");
  ctx.Equal(readPurge(c, purge_id, "").Status, 401, "a read without X-Tenant-Id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string purge_id = seedPurge({"/pricing", "/img/logo.png"});
  const auto foreign = readPurge(c, purge_id, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 reading t1's purge %s (%s): another tenant's purge must be 404", purge_id, foreign.Text());
  ctx.Assert(foreign.Text().find(kReadDomain) == std::string::npos, "the answer to another tenant names the domain: %s", foreign.Text());
  ctx.Equal(readPurge(c, "pg-404", "t2").Status, 404, "an unknown purge");
}

void CheckStatusDerive(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const long long t = ctx.Clock.Now() / 1000;
  const std::string purge_id = seedPurge({"/pricing", "/img/logo.png"});
  records::setOutcomes(purge_id, {{"/pricing", "accepted"}, {"/img/logo.png", "accepted"}});
  ctx.Equal(text(bodyOf(readPurge(c, purge_id)), "status"), "accepted", "the provider accepted both paths and no edge confirmed yet: acceptance is not propagation; the status");
  records::confirm(purge_id, "/pricing", t + 30);
  ctx.Equal(text(bodyOf(readPurge(c, purge_id)), "status"), "accepted", "one of two paths confirmed; the status");
  records::confirm(purge_id, "/img/logo.png", t + 60);
  ctx.Equal(text(bodyOf(readPurge(c, purge_id)), "status"), "propagated", "every path confirmed; the status");
  const std::string broken = seedPurge({"/a", "/b["});
  records::setOutcomes(broken, {{"/a", "propagated"}, {"/b[", "invalid_pattern"}});
  ctx.Equal(text(bodyOf(readPurge(c, broken)), "status"), "partially_failed", "a purge with an invalid pattern; its status");
}

void CheckFailedVisible(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string purge_id = seedPurge({"/pricing", "/b[", "/hot"});
  const std::map<std::string, std::string> outcomes = {{"/pricing", "accepted"}, {"/b[", "invalid_pattern"}, {"/hot", "failed"}};
  records::setOutcomes(purge_id, outcomes);
  const auto body = bodyOf(readPurge(c, purge_id));
  ctx.Equal(body.is_object() && body.contains("outcomes") ? body["outcomes"] : nlohmann::json(), nlohmann::json(outcomes),
            "the refused paths are the ones an operator has to fix; the outcomes in the response");
}

void CheckPropagatedAt(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const long long t = ctx.Clock.Now() / 1000;
  const std::string purge_id = seedPurge({"/pricing", "/img/logo.png"});
  records::setOutcomes(purge_id, {{"/pricing", "accepted"}, {"/img/logo.png", "accepted"}});
  records::confirm(purge_id, "/pricing", t + 30);
  const auto half = bodyOf(readPurge(c, purge_id));
  ctx.Assert(half.is_object() && half.contains("propagated_at") && half["propagated_at"].is_null(), "one of two paths confirmed and propagated_at is %s: it must be null until every edge confirmed",
             half.is_object() && half.contains("propagated_at") ? half["propagated_at"].dump() : "missing");
  records::confirm(purge_id, "/img/logo.png", t + 95);
  const auto done = bodyOf(readPurge(c, purge_id));
  const long long at = done.is_object() && done.contains("propagated_at") && done["propagated_at"].is_number() ? done["propagated_at"].get<long long>() : 0;
  ctx.Assert(at == t + 95, "propagated_at is %d, but the last path was confirmed at %d (accepted at %d)", at, t + 95, done.value("accepted_at", 0LL));
}
`,
  },
  hints: [
    'On-call reads `propagated` minutes before the edges confirm, the paths the provider refused are missing from the body, and another tenant’s token reads the purge by its id.',
    '`derive_status` treats `accepted` like `propagated` and has no failure branch; the body filters out the failed paths; `propagated_at` copies `accepted_at`; and the lookup never compares the record’s tenant.',
    'Answer 404 when `purge["tenant"] != tenant`; `derive_status`: any `invalid_pattern`/`failed` → `STATUS_PARTIALLY_FAILED`, all `propagated` → `STATUS_PROPAGATED`, else `STATUS_ACCEPTED`; return `purge["outcomes"]` whole; `propagated_at = max(purge["confirmed"].values())` only when propagated.',
  ],
  debrief: `A status endpoint may only state what the system can prove, so every field is derived from per-path evidence: \`propagated\` needs a confirmation for every path, one refused path is enough for \`partially_failed\`, and \`propagated_at\` is the moment the last edge confirmed, not the moment the provider took the request. Answering 404 for another tenant's purge keeps the endpoint from confirming that an id exists, which matters because purge ids leak into logs and tickets. What this step leaves out: per-POP propagation detail for a path that is slow on one continent, an alert when a purge stays \`accepted\` past the propagation target, and caching the read itself, which would reintroduce the staleness this endpoint exists to expose.`,
};
