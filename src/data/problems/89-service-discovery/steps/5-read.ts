import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/services/{name}/instances: routable, explained, gated',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['router', 'discovery', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/services/{service}/instances\`, the read every router
makes before it picks a backend: it walks \`instances.members(service)\`, skips an instance whose
verdict is \`NOT_SERVING\`, returns every other member merged with its record as \`instances\`, and an
empty \`excluded\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller that reaches the port enumerates every backend; a
router asking for a mistyped service gets a healthy-looking empty list and drains its traffic; a
member whose record lapsed is returned with no address; and an instance nobody has probed yet is
routed to, while on-call cannot see why checkout is down to two instances.

- The caller presents \`X-Scope\`, a comma-separated list that contains \`INTERNAL_SCOPE\`
  (\`discovery.internal\`); otherwise **403**.
- A service with no deployment (\`registry.deployment_cidr\` is None) is **404**.
- \`instances\` holds only members with a live record and a \`SERVING\` verdict, each with
  \`instance_id\`, \`address\`, \`port\`, \`metadata_version\` and \`last_heartbeat\`.
- Every other member is in \`excluded\` as \`{"instance_id", "reason"}\`: \`expired\` (no record),
  \`unhealthy\` (\`NOT_SERVING\`) or \`unprobed\` (no verdict yet).`,
  sequence: {
    participants: ['Router', 'Discovery API', 'deployment registry', 'Redis'],
    messages: [
      {
        from: 'Router',
        to: 'Discovery API',
        label: 'GET /v1/services/checkout/instances · X-Scope: discovery.internal',
        kind: 'sync',
      },
      {from: 'Discovery API', to: 'Router', label: '403 without the internal scope', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'deployment registry',
        label: 'deployment_cidr(checkout) · 404 when none',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Redis',
        label: 'SMEMBERS sd:members:checkout · HGETALL each record · GET sd:probe:checkout:{id}',
        kind: 'sync',
      },
      {
        from: 'Discovery API',
        to: 'Router',
        label: '200 {instances: [SERVING, live], excluded: [{reason: expired · unhealthy · unprobed}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'scope',
      title: 'Listing instances requires the internal scope',
      detail:
        '`X-Scope` is split on commas and must contain `INTERNAL_SCOPE`; anything else answers **403**. The starter serves the full target list to any caller that can reach the port.',
      match: {
        python: {all: [/INTERNAL_SCOPE/, /status_code=403/, /\.split\(\s*["'],["']\s*\)/]},
        typescript: {all: [/INTERNAL_SCOPE/, /code\(403\)/, /\.split\(\s*['"],['"]\s*\)/]},
        go: {all: [/internalScope/, /StatusForbidden/, /strings\.Split\(/]},
        scala: {all: [/InternalScope/, /Forbidden/, /\.split\(\s*","\s*\)/]},
        cpp: {all: [/kInternalScope/, /\b403\b/, /','/]},
      },
    },
    {
      id: 'unknown-service',
      title: 'An unknown service is 404, not an empty list',
      detail:
        'A service with no deployment (`deployment_cidr` is None) answers **404**; a deployed service with no members answers 200 with an empty list. The starter answers 200 and an empty list for a typo.',
      match: {
        python: {all: [/registry\.deployment_cidr\(/, /status_code=404/]},
        typescript: {all: [/registry\.deploymentCidr\(/, /code\(404\)/]},
        go: {all: [/registry\.DeploymentCIDR\(/, /StatusNotFound/]},
        scala: {all: [/Registry\.deploymentCidr\(/, /NotFound/]},
        cpp: {all: [/registry::deploymentCidr\(/, /\b404\b/]},
      },
    },
    {
      id: 'expired',
      title: 'A member whose record lapsed is excluded as expired',
      detail:
        'A member with no live record (`lookup` is None) goes into `excluded` with reason `expired`, never into `instances`. The starter merges a missing record into an empty entry and returns it with no address.',
      match: {
        python: {all: [/["']expired["']/]},
        typescript: {all: [/['"]expired['"]/]},
        go: {all: [/"expired"/]},
        scala: {all: [/"expired"/]},
        cpp: {all: [/"expired"/]},
      },
    },
    {
      id: 'healthy-only',
      title: 'Only SERVING instances are routable, and every exclusion has a reason',
      detail:
        'An instance is routable only with a `SERVING` verdict; `NOT_SERVING` is excluded as `unhealthy` and a missing verdict as `unprobed`. The starter routes to unprobed instances and drops the unhealthy ones without saying so.',
      match: {
        python: {all: [/!=\s*["']SERVING["']|==\s*["']SERVING["']/, /["']unhealthy["']/, /["']unprobed["']/]},
        typescript: {all: [/!==\s*['"]SERVING['"]|===\s*['"]SERVING['"]/, /['"]unhealthy['"]/, /['"]unprobed['"]/]},
        go: {all: [/!=\s*"SERVING"|==\s*"SERVING"/, /"unhealthy"/, /"unprobed"/]},
        scala: {all: [/Some\("SERVING"\)|==\s*"SERVING"|contains\("SERVING"\)/, /"unhealthy"/, /"unprobed"/]},
        cpp: {all: [/!=\s*"SERVING"|==\s*"SERVING"/, /"unhealthy"/, /"unprobed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request

from discovery import instances  # members, lookup, verdict
from discovery import registry  # deployment_cidr

app = FastAPI()


@app.get("/v1/services/{service}/instances")
def list_instances(service: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    found = []
    for instance_id in instances.members(service):
        if instances.verdict(service, instance_id) == "NOT_SERVING":
            continue
        found.append({"instance_id": instance_id, **(instances.lookup(service, instance_id) or {})})
    return {"service": service, "instances": found, "excluded": []}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from discovery import instances  # members, lookup, verdict
from discovery import registry  # deployment_cidr

app = FastAPI()

INTERNAL_SCOPE = "discovery.internal"


@app.get("/v1/services/{service}/instances")
def list_instances(service: str, request: Request) -> dict:
    scopes = {scope.strip() for scope in request.headers.get("x-scope", "").split(",")}
    if INTERNAL_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail=f"listing instances needs the {INTERNAL_SCOPE} scope")
    if registry.deployment_cidr(service) is None:
        raise HTTPException(status_code=404, detail=f"no deployment for service {service}")
    routable, excluded = [], []
    for instance_id in instances.members(service):
        instance = instances.lookup(service, instance_id)
        if instance is None:
            excluded.append({"instance_id": instance_id, "reason": "expired"})  # the sweep has not announced it yet
            continue
        verdict = instances.verdict(service, instance_id)
        if verdict != "SERVING":
            excluded.append({"instance_id": instance_id, "reason": "unhealthy" if verdict == "NOT_SERVING" else "unprobed"})
            continue
        routable.append({"instance_id": instance_id, **instance})
    return {"service": service, "instances": routable, "excluded": excluded}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as instances from 'discovery/instances'; // members, lookup, verdict
import * as registry from 'discovery/registry'; // deploymentCidr

export const app = Fastify();

app.get('/v1/services/:service/instances', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {service} = request.params as {service: string};
  const found: Record<string, unknown>[] = [];
  for (const instanceId of await instances.members(service)) {
    if ((await instances.verdict(service, instanceId)) === 'NOT_SERVING') continue;
    found.push({instance_id: instanceId, ...(await instances.lookup(service, instanceId))});
  }
  return {service, instances: found, excluded: []};
});
`,
      solution: `import Fastify from 'fastify';

import * as instances from 'discovery/instances'; // members, lookup, verdict
import * as registry from 'discovery/registry'; // deploymentCidr

export const app = Fastify();

export const INTERNAL_SCOPE = 'discovery.internal';

app.get('/v1/services/:service/instances', async (request, reply) => {
  const {service} = request.params as {service: string};
  const header = request.headers['x-scope'];
  const scopes = (typeof header === 'string' ? header : '').split(',').map(scope => scope.trim());
  if (!scopes.includes(INTERNAL_SCOPE)) return reply.code(403).send({error: \`listing instances needs the \${INTERNAL_SCOPE} scope\`});
  if ((await registry.deploymentCidr(service)) === null) return reply.code(404).send({error: \`no deployment for service \${service}\`});
  const routable: Record<string, unknown>[] = [];
  const excluded: {instance_id: string; reason: string}[] = [];
  for (const instanceId of await instances.members(service)) {
    const instance = await instances.lookup(service, instanceId);
    if (instance === null) {
      excluded.push({instance_id: instanceId, reason: 'expired'}); // the sweep has not announced it yet
      continue;
    }
    const verdict = await instances.verdict(service, instanceId);
    if (verdict !== 'SERVING') {
      excluded.push({instance_id: instanceId, reason: verdict === 'NOT_SERVING' ? 'unhealthy' : 'unprobed'});
      continue;
    }
    routable.push({instance_id: instanceId, ...instance});
  }
  return {service, instances: routable, excluded};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"discovery/instances" // instances.Members, Lookup, Verdict
	"discovery/registry"  // registry.DeploymentCIDR
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func listInstances(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ctx := r.Context()
	service := r.PathValue("service")
	ids, err := instances.Members(ctx, service)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	found := []map[string]any{}
	for _, id := range ids {
		if verdict, _ := instances.Verdict(ctx, service, id); verdict == "NOT_SERVING" {
			continue
		}
		entry := map[string]any{"instance_id": id}
		if inst, _ := instances.Lookup(ctx, service, id); inst != nil {
			entry["address"], entry["port"], entry["heartbeat_interval"] = inst.Address, inst.Port, inst.HeartbeatInterval
			entry["metadata_version"], entry["last_heartbeat"] = inst.MetadataVersion, inst.LastHeartbeat
		}
		found = append(found, entry)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "instances": found, "excluded": []any{}})
}

func routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/services/{service}/instances", listInstances)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"discovery/instances" // instances.Members, Lookup, Verdict
	"discovery/registry"  // registry.DeploymentCIDR
)

const internalScope = "discovery.internal"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func hasScope(header, scope string) bool {
	for _, s := range strings.Split(header, ",") {
		if strings.TrimSpace(s) == scope {
			return true
		}
	}
	return false
}

func listInstances(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	service := r.PathValue("service")
	if !hasScope(r.Header.Get("X-Scope"), internalScope) {
		http.Error(rw, "listing instances needs the "+internalScope+" scope", http.StatusForbidden)
		return
	}
	_, deployed, err := registry.DeploymentCIDR(ctx, service)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !deployed {
		http.Error(rw, "no deployment for service "+service, http.StatusNotFound)
		return
	}
	ids, err := instances.Members(ctx, service)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	routable := []map[string]any{}
	excluded := []map[string]string{}
	for _, id := range ids {
		inst, err := instances.Lookup(ctx, service, id)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if inst == nil {
			excluded = append(excluded, map[string]string{"instance_id": id, "reason": "expired"}) // the sweep has not announced it yet
			continue
		}
		verdict, err := instances.Verdict(ctx, service, id)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if verdict != "SERVING" {
			reason := "unprobed"
			if verdict == "NOT_SERVING" {
				reason = "unhealthy"
			}
			excluded = append(excluded, map[string]string{"instance_id": id, "reason": reason})
			continue
		}
		routable = append(routable, map[string]any{
			"instance_id": id, "address": inst.Address, "port": inst.Port, "heartbeat_interval": inst.HeartbeatInterval,
			"metadata_version": inst.MetadataVersion, "last_heartbeat": inst.LastHeartbeat,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "instances": routable, "excluded": excluded})
}

func routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/services/{service}/instances", listInstances)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import discovery.{Instances, Registry} // Instances.members, lookup, verdict · Registry.deploymentCidr

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def instanceJson(instanceId: String, i: Instances.Instance): JsObject = JsObject(
    "instance_id" -> JsString(instanceId), "address" -> JsString(i.address), "port" -> JsNumber(i.port),
    "heartbeat_interval" -> JsNumber(i.heartbeatInterval), "metadata_version" -> JsNumber(i.metadataVersion),
    "last_heartbeat" -> JsNumber(i.lastHeartbeat))

  val route: Route = path("v1" / "services" / Segment / "instances") { service =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      val found = Instances.members(service).filterNot(id => Instances.verdict(service, id).contains("NOT_SERVING")).map { id =>
        Instances.lookup(service, id).map(instanceJson(id, _)).getOrElse(JsObject("instance_id" -> JsString(id)))
      }
      complete(json(StatusCodes.OK, JsObject("service" -> JsString(service), "instances" -> JsArray(found.toVector), "excluded" -> JsArray())))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import discovery.{Instances, Registry} // Instances.members, lookup, verdict · Registry.deploymentCidr

object Read {
  val InternalScope = "discovery.internal"

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def instanceJson(instanceId: String, i: Instances.Instance): JsObject = JsObject(
    "instance_id" -> JsString(instanceId), "address" -> JsString(i.address), "port" -> JsNumber(i.port),
    "heartbeat_interval" -> JsNumber(i.heartbeatInterval), "metadata_version" -> JsNumber(i.metadataVersion),
    "last_heartbeat" -> JsNumber(i.lastHeartbeat))

  private def exclusion(instanceId: String, reason: String): JsObject =
    JsObject("instance_id" -> JsString(instanceId), "reason" -> JsString(reason))

  val route: Route = path("v1" / "services" / Segment / "instances") { service =>
    get {
      optionalHeaderValueByName("X-Scope") { header =>
        if (!header.getOrElse("").split(",").map(_.trim).contains(InternalScope))
          complete(StatusCodes.Forbidden -> s"listing instances needs the $InternalScope scope")
        else if (Registry.deploymentCidr(service).isEmpty) complete(StatusCodes.NotFound -> s"no deployment for service $service")
        else {
          val (routable, excluded) = Instances.members(service).foldLeft((Vector.empty[JsObject], Vector.empty[JsObject])) {
            case ((ok, out), id) =>
              Instances.lookup(service, id) match {
                case None => (ok, out :+ exclusion(id, "expired")) // the sweep has not announced it yet
                case Some(instance) =>
                  Instances.verdict(service, id) match {
                    case Some("SERVING")     => (ok :+ instanceJson(id, instance), out)
                    case Some("NOT_SERVING") => (ok, out :+ exclusion(id, "unhealthy"))
                    case _                   => (ok, out :+ exclusion(id, "unprobed"))
                  }
              }
          }
          complete(json(StatusCodes.OK, JsObject("service" -> JsString(service), "instances" -> JsArray(routable), "excluded" -> JsArray(excluded))))
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

#include "discovery/instances.h"  // instances::members, lookup, verdict
#include "discovery/registry.h"   // registry::deploymentCidr

using json = nlohmann::json;

json instanceJson(const std::string& instance_id, const instances::Instance& i) {
  return json{{"instance_id", instance_id}, {"address", i.address}, {"port", i.port}, {"heartbeat_interval", i.heartbeat_interval},
              {"metadata_version", i.metadata_version}, {"last_heartbeat", i.last_heartbeat}};
}

void list_instances(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string service = req.matches[1];
  json found = json::array();
  for (const std::string& instance_id : instances::members(service)) {
    if (instances::verdict(service, instance_id) == "NOT_SERVING") continue;
    const auto instance = instances::lookup(service, instance_id);
    found.push_back(instance ? instanceJson(instance_id, *instance) : json{{"instance_id", instance_id}});
  }
  res.set_content(json{{"service", service}, {"instances", found}, {"excluded", json::array()}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/services/([\\w-]+)/instances)", list_instances); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "discovery/instances.h"  // instances::members, lookup, verdict
#include "discovery/registry.h"   // registry::deploymentCidr

using json = nlohmann::json;

const std::string kInternalScope = "discovery.internal";

json instanceJson(const std::string& instance_id, const instances::Instance& i) {
  return json{{"instance_id", instance_id}, {"address", i.address}, {"port", i.port}, {"heartbeat_interval", i.heartbeat_interval},
              {"metadata_version", i.metadata_version}, {"last_heartbeat", i.last_heartbeat}};
}

bool hasScope(const std::string& header, const std::string& scope) {
  size_t start = 0;
  while (start <= header.size()) {
    const size_t comma = header.find(',', start);
    std::string item = header.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    item.erase(0, item.find_first_not_of(' '));
    item.erase(item.find_last_not_of(' ') + 1);
    if (item == scope) return true;
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return false;
}

void refuse(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(json{{"error", reason}}.dump(), "application/json");
}

void list_instances(const httplib::Request& req, httplib::Response& res) {
  const std::string service = req.matches[1];
  if (!hasScope(req.get_header_value("X-Scope"), kInternalScope)) return refuse(res, 403, "listing instances needs the " + kInternalScope + " scope");
  if (!registry::deploymentCidr(service)) return refuse(res, 404, "no deployment for service " + service);
  json routable = json::array();
  json excluded = json::array();
  for (const std::string& instance_id : instances::members(service)) {
    const auto instance = instances::lookup(service, instance_id);
    if (!instance) {
      excluded.push_back(json{{"instance_id", instance_id}, {"reason", "expired"}});  // the sweep has not announced it yet
      continue;
    }
    const auto verdict = instances::verdict(service, instance_id);
    if (verdict != "SERVING") {
      excluded.push_back(json{{"instance_id", instance_id}, {"reason", verdict == "NOT_SERVING" ? "unhealthy" : "unprobed"}});
      continue;
    }
    routable.push_back(instanceJson(instance_id, *instance));
  }
  res.set_content(json{{"service", service}, {"instances", routable}, {"excluded", excluded}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/services/([\\w-]+)/instances)", list_instances); }
`,
    },
  },
  harness: {
    python: `from discovery import instances, registry

INTERNAL = {"X-Scope": "metrics.read, discovery.internal"}


def _api(ctx):
    registry.define_service("checkout", "10.4.0.0/16")
    registry.define_service("payments", "10.9.0.0/16")
    return ctx.client(ctx.load("read").app)


def _fleet(ctx):
    """checkout-1 SERVING, checkout-2 NOT_SERVING, checkout-3 never probed, checkout-4's record lapsed before the sweep ran."""
    for n in range(1, 5):
        instances.register_instance("checkout", f"checkout-{n}", f"10.4.2.{n}", 8080, 5, 7)
    ctx.redis.set("sd:probe:checkout:checkout-1", "SERVING", ex=5)
    ctx.redis.set("sd:probe:checkout:checkout-2", "NOT_SERVING", ex=5)
    ctx.redis.set("sd:probe:checkout:checkout-4", "SERVING", ex=5)
    ctx.redis.delete("sd:checkout:checkout-4")


async def _listing(c):
    r = await c.get("/v1/services/checkout/instances", headers=INTERNAL)
    assert r.status_code == 200, f"GET /v1/services/checkout/instances with the internal scope answered {r.status_code}: {r.text}"
    body = r.json()
    return body, [i.get("instance_id") for i in body.get("instances", [])], {e.get("instance_id"): e.get("reason") for e in body.get("excluded", [])}


async def check_scope(ctx):
    _fleet(ctx)
    async with _api(ctx) as c:
        for headers, why in (({}, "no X-Scope"), ({"X-Scope": "metrics.read"}, "X-Scope metrics.read"), ({"X-Scope": "discovery.internal.readonly"}, "X-Scope discovery.internal.readonly")):
            r = await c.get("/v1/services/checkout/instances", headers=headers)
            assert r.status_code == 403, f"a caller with {why} listed checkout's instances ({r.status_code}): the list is a set of targets, gated behind discovery.internal"
        r = await c.get("/v1/services/checkout/instances", headers=INTERNAL)
    assert r.status_code == 200, f"a caller whose X-Scope list contains discovery.internal answered {r.status_code}: {r.text}"


async def check_unknown_service(ctx):
    async with _api(ctx) as c:
        r = await c.get("/v1/services/checkuot/instances", headers=INTERNAL)
        assert r.status_code == 404, f"a mistyped service name answered {r.status_code} {r.text}, expected 404: an empty 200 looks like a healthy service with no capacity"
        r = await c.get("/v1/services/payments/instances", headers=INTERNAL)
    assert r.status_code == 200 and r.json().get("instances") == [], f"payments is deployed with no instances and answered {r.status_code} {r.text}, expected 200 with an empty list"


async def check_expired(ctx):
    _fleet(ctx)
    async with _api(ctx) as c:
        body, routed, excluded = await _listing(c)
    assert "checkout-4" not in routed, f"checkout-4's record lapsed and it was returned as routable: {body['instances']}. A router would dial an instance with no address"
    assert excluded.get("checkout-4") == "expired", f"checkout-4 has no record and excluded holds {excluded}, expected checkout-4 with reason expired"
    for entry in body.get("instances", []):
        assert entry.get("address"), f"an instance came back without an address: {entry}"


async def check_healthy_only(ctx):
    _fleet(ctx)
    async with _api(ctx) as c:
        body, routed, excluded = await _listing(c)
    assert routed == ["checkout-1"], f"the routable instances are {routed}, expected only checkout-1: checkout-2 is NOT_SERVING and checkout-3 was never probed"
    entry = body["instances"][0]
    assert entry.get("address") == "10.4.2.1" and entry.get("port") == 8080 and entry.get("metadata_version") == 7 and isinstance(entry.get("last_heartbeat"), int), f"checkout-1 came back as {entry}, expected its address, port, metadata_version and last_heartbeat"
    assert excluded.get("checkout-2") == "unhealthy", f"checkout-2 answered NOT_SERVING and excluded holds {excluded}, expected it with reason unhealthy"
    assert excluded.get("checkout-3") == "unprobed", f"checkout-3 has no verdict yet and excluded holds {excluded}, expected it with reason unprobed"
`,
    typescript: `const INTERNAL = {'X-Scope': 'metrics.read, discovery.internal'};

function api(ctx) {
  ctx.redis.set('sd:deploy:checkout', '10.4.0.0/16');
  ctx.redis.set('sd:deploy:payments', '10.9.0.0/16');
  return ctx.client(ctx.load('read').app);
}

/** checkout-1 SERVING, checkout-2 NOT_SERVING, checkout-3 never probed, checkout-4's record lapsed before the sweep ran. */
async function fleet(ctx) {
  const instances = ctx.load('/support/discovery/instances.ts');
  for (let n = 1; n <= 4; n++) await instances.registerInstance('checkout', 'checkout-' + n, '10.4.2.' + n, 8080, 5, 7);
  ctx.redis.set('sd:probe:checkout:checkout-1', 'SERVING', 'EX', 5);
  ctx.redis.set('sd:probe:checkout:checkout-2', 'NOT_SERVING', 'EX', 5);
  ctx.redis.set('sd:probe:checkout:checkout-4', 'SERVING', 'EX', 5);
  ctx.redis.del('sd:checkout:checkout-4');
}

async function listing(c) {
  const r = await c.get('/v1/services/checkout/instances', {headers: INTERNAL});
  assert.equal(r.status, 200, \`GET /v1/services/checkout/instances with the internal scope answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const routed = (body.instances ?? []).map(i => i.instance_id);
  const excluded = Object.fromEntries((body.excluded ?? []).map(e => [e.instance_id, e.reason]));
  return {body, routed, excluded};
}

export async function check_scope(ctx) {
  await fleet(ctx);
  const c = api(ctx);
  const cases: [Record<string, string>, string][] = [
    [{}, 'no X-Scope'],
    [{'X-Scope': 'metrics.read'}, 'X-Scope metrics.read'],
    [{'X-Scope': 'discovery.internal.readonly'}, 'X-Scope discovery.internal.readonly'],
  ];
  for (const [headers, why] of cases) {
    const r = await c.get('/v1/services/checkout/instances', {headers});
    assert.equal(r.status, 403, \`a caller with \${why} listed checkout's instances (\${r.status}): the list is a set of targets, gated behind discovery.internal\`);
  }
  const r = await c.get('/v1/services/checkout/instances', {headers: INTERNAL});
  assert.equal(r.status, 200, \`a caller whose X-Scope list contains discovery.internal answered \${r.status}: \${r.text}\`);
}

export async function check_unknown_service(ctx) {
  const c = api(ctx);
  let r = await c.get('/v1/services/checkuot/instances', {headers: INTERNAL});
  assert.equal(r.status, 404, \`a mistyped service name answered \${r.status} \${r.text}, expected 404: an empty 200 looks like a healthy service with no capacity\`);
  r = await c.get('/v1/services/payments/instances', {headers: INTERNAL});
  assert(r.status === 200 && JSON.stringify(r.json().instances) === '[]', \`payments is deployed with no instances and answered \${r.status} \${r.text}, expected 200 with an empty list\`);
}

export async function check_expired(ctx) {
  await fleet(ctx);
  const {body, routed, excluded} = await listing(api(ctx));
  assert(!routed.includes('checkout-4'), \`checkout-4's record lapsed and it was returned as routable: \${JSON.stringify(body.instances)}. A router would dial an instance with no address\`);
  assert.equal(excluded['checkout-4'], 'expired', \`checkout-4 has no record and excluded holds \${JSON.stringify(excluded)}, expected checkout-4 with reason expired\`);
  for (const entry of body.instances ?? []) assert(entry.address, \`an instance came back without an address: \${JSON.stringify(entry)}\`);
}

export async function check_healthy_only(ctx) {
  await fleet(ctx);
  const {body, routed, excluded} = await listing(api(ctx));
  assert.deepEqual(routed, ['checkout-1'], \`the routable instances are \${JSON.stringify(routed)}, expected only checkout-1: checkout-2 is NOT_SERVING and checkout-3 was never probed\`);
  const entry = body.instances[0];
  assert(entry.address === '10.4.2.1' && entry.port === 8080 && entry.metadata_version === 7 && Number.isInteger(entry.last_heartbeat), \`checkout-1 came back as \${JSON.stringify(entry)}, expected its address, port, metadata_version and last_heartbeat\`);
  assert.equal(excluded['checkout-2'], 'unhealthy', \`checkout-2 answered NOT_SERVING and excluded holds \${JSON.stringify(excluded)}, expected it with reason unhealthy\`);
  assert.equal(excluded['checkout-3'], 'unprobed', \`checkout-3 has no verdict yet and excluded holds \${JSON.stringify(excluded)}, expected it with reason unprobed\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"discovery/instances"

	"leetbuild/harness"
)

type listingBody struct {
	Instances []map[string]any  \`json:"instances"\`
	Excluded  []map[string]string \`json:"excluded"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Set("sd:deploy:checkout", "10.4.0.0/16")
	ctx.Redis.Set("sd:deploy:payments", "10.9.0.0/16")
	mux := http.NewServeMux()
	routes(mux)
	return ctx.HTTP(mux)
}

// fleet: checkout-1 SERVING, checkout-2 NOT_SERVING, checkout-3 never probed, checkout-4's record lapsed before the sweep ran.
func fleet(ctx *harness.Ctx) {
	for n := 1; n <= 4; n++ {
		_, err := instances.RegisterInstance(context.Background(), "checkout", fmt.Sprintf("checkout-%d", n), fmt.Sprintf("10.4.2.%d", n), 8080, 5, 7)
		ctx.NoError(err, "registering checkout-%d", n)
	}
	ctx.Redis.Set("sd:probe:checkout:checkout-1", "SERVING", "EX", 5)
	ctx.Redis.Set("sd:probe:checkout:checkout-2", "NOT_SERVING", "EX", 5)
	ctx.Redis.Set("sd:probe:checkout:checkout-4", "SERVING", "EX", 5)
	ctx.Redis.Del("sd:checkout:checkout-4")
}

func listing(ctx *harness.Ctx, c *harness.HTTP) (listingBody, []string, map[string]string) {
	r := c.Get("/v1/services/checkout/instances", "X-Scope", "metrics.read, discovery.internal")
	ctx.Equal(r.Status, 200, "GET /v1/services/checkout/instances with the internal scope (%s)", r.Text())
	var body listingBody
	r.Decode(&body)
	routed := []string{}
	for _, i := range body.Instances {
		id, _ := i["instance_id"].(string)
		routed = append(routed, id)
	}
	excluded := map[string]string{}
	for _, e := range body.Excluded {
		excluded[e["instance_id"]] = e["reason"]
	}
	return body, routed, excluded
}

func CheckScope(ctx *harness.Ctx) {
	fleet(ctx)
	c := api(ctx)
	r := c.Get("/v1/services/checkout/instances")
	ctx.Equal(r.Status, 403, "a caller with no X-Scope listed checkout's instances: the list is a set of targets, gated behind discovery.internal")
	for _, scope := range []string{"metrics.read", "discovery.internal.readonly"} {
		r = c.Get("/v1/services/checkout/instances", "X-Scope", scope)
		ctx.Equal(r.Status, 403, "a caller with X-Scope %s listed checkout's instances: the list is a set of targets, gated behind discovery.internal", scope)
	}
	r = c.Get("/v1/services/checkout/instances", "X-Scope", "metrics.read, discovery.internal")
	ctx.Equal(r.Status, 200, "a caller whose X-Scope list contains discovery.internal (%s)", r.Text())
}

func CheckUnknownService(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Get("/v1/services/checkuot/instances", "X-Scope", "discovery.internal")
	ctx.Equal(r.Status, 404, "a mistyped service name (an empty 200 looks like a healthy service with no capacity)")
	r = c.Get("/v1/services/payments/instances", "X-Scope", "discovery.internal")
	var body listingBody
	if r.Status == 200 {
		r.Decode(&body)
	}
	ctx.Assert(r.Status == 200 && body.Instances != nil && len(body.Instances) == 0, "payments is deployed with no instances and answered %d %s, expected 200 with an empty list", r.Status, r.Text())
}

func CheckExpired(ctx *harness.Ctx) {
	fleet(ctx)
	body, routed, excluded := listing(ctx, api(ctx))
	for _, id := range routed {
		ctx.Assert(id != "checkout-4", "checkout-4's record lapsed and it was returned as routable: %v. A router would dial an instance with no address", body.Instances)
	}
	ctx.Equal(excluded["checkout-4"], "expired", "checkout-4 has no record (excluded holds %v); its reason", excluded)
	for _, entry := range body.Instances {
		address, _ := entry["address"].(string)
		ctx.Assert(address != "", "an instance came back without an address: %v", entry)
	}
}

func CheckHealthyOnly(ctx *harness.Ctx) {
	fleet(ctx)
	body, routed, excluded := listing(ctx, api(ctx))
	ctx.Equal(routed, []string{"checkout-1"}, "the routable instances (checkout-2 is NOT_SERVING and checkout-3 was never probed)")
	entry := body.Instances[0]
	_, stamped := entry["last_heartbeat"].(float64)
	ctx.Assert(entry["address"] == "10.4.2.1" && entry["port"] == float64(8080) && entry["metadata_version"] == float64(7) && stamped, "checkout-1 came back as %v, expected its address, port, metadata_version and last_heartbeat", entry)
	ctx.Equal(excluded["checkout-2"], "unhealthy", "checkout-2 answered NOT_SERVING (excluded holds %v); its reason", excluded)
	ctx.Equal(excluded["checkout-3"], "unprobed", "checkout-3 has no verdict yet (excluded holds %v); its reason", excluded)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "discovery/instances.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Set("sd:deploy:checkout", "10.4.0.0/16");
  ctx.Redis.Set("sd:deploy:payments", "10.9.0.0/16");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// checkout-1 SERVING, checkout-2 NOT_SERVING, checkout-3 never probed, checkout-4's record lapsed before the sweep ran.
void fleet(harness::Ctx& ctx) {
  for (int n = 1; n <= 4; n++) {
    instances::registerInstance("checkout", "checkout-" + std::to_string(n), "10.4.2." + std::to_string(n), 8080, 5, 7);
  }
  ctx.Redis.Set("sd:probe:checkout:checkout-1", "SERVING", "EX", 5);
  ctx.Redis.Set("sd:probe:checkout:checkout-2", "NOT_SERVING", "EX", 5);
  ctx.Redis.Set("sd:probe:checkout:checkout-4", "SERVING", "EX", 5);
  ctx.Redis.Del("sd:checkout:checkout-4");
}

struct Listing {
  nlohmann::json body;
  std::vector<std::string> routed;
  std::map<std::string, std::string> excluded;
};

Listing listing(harness::Ctx& ctx, harness::HTTP c) {
  const auto r = c.Get("/v1/services/checkout/instances", "X-Scope", "metrics.read, discovery.internal");
  ctx.Equal(r.Status, 200, "GET /v1/services/checkout/instances with the internal scope (%s)", r.Text());
  Listing out{nlohmann::json::parse(r.Text(), nullptr, false), {}, {}};
  ctx.Assert(out.body.is_object(), "the listing is not a JSON object: %s", r.Text());
  for (const auto& i : out.body.value("instances", nlohmann::json::array())) out.routed.push_back(i.value("instance_id", ""));
  for (const auto& e : out.body.value("excluded", nlohmann::json::array())) out.excluded[e.value("instance_id", "")] = e.value("reason", "");
  return out;
}

std::string reasonOf(const Listing& l, const std::string& instance_id) {
  const auto it = l.excluded.find(instance_id);
  return it == l.excluded.end() ? "" : it->second;
}

}  // namespace

void CheckScope(harness::Ctx& ctx) {
  fleet(ctx);
  auto c = api(ctx);
  auto r = c.Get("/v1/services/checkout/instances");
  ctx.Equal(r.Status, 403, "a caller with no X-Scope listed checkout's instances: the list is a set of targets, gated behind discovery.internal");
  for (const std::string scope : {"metrics.read", "discovery.internal.readonly"}) {
    r = c.Get("/v1/services/checkout/instances", "X-Scope", scope);
    ctx.Equal(r.Status, 403, "a caller with X-Scope %s listed checkout's instances: the list is a set of targets, gated behind discovery.internal", scope);
  }
  r = c.Get("/v1/services/checkout/instances", "X-Scope", "metrics.read, discovery.internal");
  ctx.Equal(r.Status, 200, "a caller whose X-Scope list contains discovery.internal (%s)", r.Text());
}

void CheckUnknownService(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Get("/v1/services/checkuot/instances", "X-Scope", "discovery.internal");
  ctx.Equal(r.Status, 404, "a mistyped service name (an empty 200 looks like a healthy service with no capacity)");
  r = c.Get("/v1/services/payments/instances", "X-Scope", "discovery.internal");
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(r.Status == 200 && body.is_object() && body.value("instances", nlohmann::json()) == nlohmann::json::array(),
             "payments is deployed with no instances and answered %d %s, expected 200 with an empty list", r.Status, r.Text());
}

void CheckExpired(harness::Ctx& ctx) {
  fleet(ctx);
  const Listing l = listing(ctx, api(ctx));
  for (const auto& id : l.routed) {
    ctx.Assert(id != "checkout-4", "checkout-4's record lapsed and it was returned as routable: %s. A router would dial an instance with no address", l.body.dump());
  }
  ctx.Equal(reasonOf(l, "checkout-4"), "expired", "checkout-4 has no record; its reason in excluded");
  for (const auto& entry : l.body.value("instances", nlohmann::json::array())) {
    ctx.Assert(!entry.value("address", "").empty(), "an instance came back without an address: %s", entry.dump());
  }
}

void CheckHealthyOnly(harness::Ctx& ctx) {
  fleet(ctx);
  const Listing l = listing(ctx, api(ctx));
  ctx.Equal(l.routed, {"checkout-1"}, "the routable instances (checkout-2 is NOT_SERVING and checkout-3 was never probed)");
  const auto& entry = l.body["instances"][0];
  ctx.Assert(entry.value("address", "") == "10.4.2.1" && entry.value("port", 0L) == 8080 && entry.value("metadata_version", 0L) == 7 &&
                 entry.contains("last_heartbeat") && entry["last_heartbeat"].is_number_integer(),
             "checkout-1 came back as %s, expected its address, port, metadata_version and last_heartbeat", entry.dump());
  ctx.Equal(reasonOf(l, "checkout-2"), "unhealthy", "checkout-2 answered NOT_SERVING; its reason in excluded");
  ctx.Equal(reasonOf(l, "checkout-3"), "unprobed", "checkout-3 has no verdict yet; its reason in excluded");
}
`,
  },
  hints: [
    'Call the endpoint from any pod without credentials and you get every checkout backend; ask for checkuot and the router drains to an empty list; checkout-4, dead a minute ago, is listed without an address.',
    'The handler never reads X-Scope or asks the registry whether the service exists. It merges each member with `lookup(...) or {}`, so a lapsed record becomes an empty entry, and only an explicit NOT_SERVING is skipped, silently.',
    'Split `X-Scope` on commas and require `INTERNAL_SCOPE` (403); `deployment_cidr` None → 404; per member: no record → `expired`, `NOT_SERVING` → `unhealthy`, no verdict → `unprobed`, `SERVING` → `instances`.',
  ],
  debrief: `The read is where the earlier steps pay off or leak: the record's TTL, the probe's verdict and the members set are three separate facts, and the answer has to combine them rather than trust any one. Listing every exclusion with its reason lets on-call tell an expiry from a failed probe from an instance nobody has asked yet, and lets a router alarm when its routable set shrinks. The scope gate exists because a membership list is a list of targets, and the 404 exists because an empty success looks like a healthy service with zero capacity. Production discovery APIs add blocking queries: a router passes the index it last saw and the call returns when membership changes, instead of polling the full list.`,
};
