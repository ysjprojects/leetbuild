import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/clusters/{id}: members, evidence and the pairs held for review',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'review'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/clusters/{id}\` from the cluster store
(\`clusters.load\`, provided: the tenant, the seed record, the scored pairs \`{"a", "b", "score",
"key_type"}\` and the merge history). It loads the cluster by id, answers 404 when there is none,
grows the members from the seed over every pair with \`linked(seed, pairs)\`, and answers
\`{"cluster_id", "members"}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A guessed id returns another tenant's records; one weak pair
pulls two unrelated groups into a single cluster; an operator sees the members with nothing to say
why they are there, or how the cluster formed.

- The tenant is the \`X-Tenant-Id\` header (**401** without it); a cluster of another tenant is
  **404**, the same answer as no cluster.
- Only a pair scoring at least **\`MIN_MERGE_CONFIDENCE\` = 0.85** links two members. A weaker pair
  touching a member goes to \`review\` (the review queue's list) and bridges nothing.
- The answer is \`{"cluster_id", "members"}\` (sorted) plus \`evidence\`, every strong pair between
  members as stored, \`review\`, the weak pairs as stored, and \`history\`, the merge actions oldest
  first.`,
  sequence: {
    participants: ['Client', 'Dedupe API', 'Redis', 'Review queue'],
    messages: [
      {from: 'Client', to: 'Dedupe API', label: 'GET /v1/clusters/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Dedupe API', to: 'Redis', label: 'load cluster · pairs · history', kind: 'sync'},
      {from: 'Redis', to: 'Dedupe API', label: 'cluster of some tenant · none', kind: 'reply'},
      {from: 'Dedupe API', to: 'Dedupe API', label: "another tenant's → 404 · link pairs ≥ 0.85 only", kind: 'sync'},
      {from: 'Dedupe API', to: 'Review queue', label: 'weak pairs under review', kind: 'async'},
      {from: 'Dedupe API', to: 'Client', label: '200 {members, evidence, review, history}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/clusters/{id}',
      detail:
        'Register the cluster read on `GET /v1/clusters/{id}`: a cluster linked by strong pairs answers its id and its members.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/clusters\/\{[^}]+\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/clusters\/:\w+['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/clusters\/\{\w+\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"clusters"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/clusters\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's cluster",
      detail:
        'The tenant comes from `X-Tenant-Id` (**401** without it) and a cluster whose tenant differs is **404**, the same answer as no cluster. The starter answers any cluster by id.',
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*cluster\[["']tenant["']\]/, /\b401\b/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant|tenant\s*!==\s*cluster\.tenant/, /code\(\s*401\s*\)/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/\.tenant\s*[!=]=\s*tenant/, /Unauthorized/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/, /\b401\b/]},
      },
    },
    {
      id: 'weak-pair',
      title: 'Links members over strong pairs only',
      detail:
        'A pair below `MIN_MERGE_CONFIDENCE` (0.85) bridges nothing: A–B at 0.97 and B–C at 0.62 is the cluster {A, B} with B–C under `review`. The starter links over every pair and pulls C, and whatever C links to, in.',
      match: {
        python: {all: [/MIN_MERGE_CONFIDENCE\s*=\s*0?\.85\b/, /(>=|<)\s*MIN_MERGE_CONFIDENCE/]},
        typescript: {all: [/MIN_MERGE_CONFIDENCE\s*=\s*0?\.85\b/, /(>=|<)\s*MIN_MERGE_CONFIDENCE/]},
        go: {all: [/minMergeConfidence\s*=\s*0?\.85\b/, /(>=|<)\s*minMergeConfidence/]},
        scala: {all: [/MinMergeConfidence\s*=\s*0?\.85\b/, /(>=|<)\s*MinMergeConfidence/]},
        cpp: {all: [/kMinMergeConfidence\s*=\s*0?\.85\b/, /(>=|<)\s*kMinMergeConfidence/]},
      },
    },
    {
      id: 'evidence',
      title: 'Answers the evidence and the pairs held for review',
      detail:
        '`evidence` lists every strong pair between members as stored (both ids, the score, the key type) and `review` the weak pairs, so an operator can see why each member is there. The starter answers the members alone.',
      match: {
        python: {all: [/["']evidence["']\s*:/, /["']review["']\s*:/]},
        typescript: {all: [/\bevidence\b/, /\breview\b/]},
        go: {all: [/"evidence"/, /"review"/]},
        scala: {all: [/"evidence"/, /"review"/]},
        cpp: {all: [/"evidence"/, /"review"/]},
      },
    },
    {
      id: 'history',
      title: 'Answers the merge history',
      detail:
        '`history` is the merge actions as stored, oldest first, so a merge can be traced and undone. The starter leaves it out.',
      match: {
        python: {all: [/["']history["']\s*:/]},
        typescript: {all: [/\bhistory\b/]},
        go: {all: [/"history"/]},
        scala: {all: [/"history"/]},
        cpp: {all: [/"history"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from dedupe import clusters  # clusters.load

app = FastAPI()


def linked(seed: str, pairs: list[dict]) -> set[str]:
    """Every record the pairs connect to the seed, directly or through other records."""
    members = {seed}
    grew = True
    while grew:
        grew = False
        for pair in pairs:
            if (pair["a"] in members) != (pair["b"] in members):
                members |= {pair["a"], pair["b"]}
                grew = True
    return members


@app.get("/v1/clusters/{cluster_id}")
def read_cluster(cluster_id: str, request: Request):
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    cluster = clusters.load(cluster_id)
    if cluster is None:
        return JSONResponse({"error": "no such cluster"}, status_code=404)
    members = linked(cluster["seed"], cluster["pairs"])
    return {"cluster_id": cluster_id, "members": sorted(members)}
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from dedupe import clusters  # clusters.load

app = FastAPI()

MIN_MERGE_CONFIDENCE = 0.85


def linked(seed: str, pairs: list[dict]) -> set[str]:
    """Every record the pairs connect to the seed, directly or through other records."""
    members = {seed}
    grew = True
    while grew:
        grew = False
        for pair in pairs:
            if (pair["a"] in members) != (pair["b"] in members):
                members |= {pair["a"], pair["b"]}
                grew = True
    return members


@app.get("/v1/clusters/{cluster_id}")
def read_cluster(cluster_id: str, request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    cluster = clusters.load(cluster_id)
    # Another tenant's cluster does not exist for this caller: the same 404 as a missing one.
    if cluster is None or cluster["tenant"] != tenant:
        return JSONResponse({"error": "no such cluster"}, status_code=404)
    strong = [p for p in cluster["pairs"] if p["score"] >= MIN_MERGE_CONFIDENCE]
    # Only strong pairs link: a weak pair waits for a reviewer instead of bridging two groups.
    members = linked(cluster["seed"], strong)
    return {
        "cluster_id": cluster_id,
        "members": sorted(members),
        "evidence": [p for p in strong if p["a"] in members and p["b"] in members],
        "review": [p for p in cluster["pairs"] if p["score"] < MIN_MERGE_CONFIDENCE and (p["a"] in members or p["b"] in members)],
        "history": cluster["history"],
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Pair, load} from 'dedupe/clusters';

export const app = Fastify();

/** Every record the pairs connect to the seed, directly or through other records. */
export function linked(seed: string, pairs: Pair[]): Set<string> {
  const members = new Set([seed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pair of pairs) {
      if (members.has(pair.a) !== members.has(pair.b)) {
        members.add(pair.a);
        members.add(pair.b);
        grew = true;
      }
    }
  }
  return members;
}

app.get('/v1/clusters/:clusterId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {clusterId} = request.params as {clusterId: string};
  const cluster = await load(clusterId);
  if (cluster === null) return reply.code(404).send({error: 'no such cluster'});
  const members = linked(cluster.seed, cluster.pairs);
  return {cluster_id: clusterId, members: [...members].sort()};
});
`,
      solution: `import Fastify from 'fastify';

import {type Pair, load} from 'dedupe/clusters';

export const app = Fastify();

export const MIN_MERGE_CONFIDENCE = 0.85;

/** Every record the pairs connect to the seed, directly or through other records. */
export function linked(seed: string, pairs: Pair[]): Set<string> {
  const members = new Set([seed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pair of pairs) {
      if (members.has(pair.a) !== members.has(pair.b)) {
        members.add(pair.a);
        members.add(pair.b);
        grew = true;
      }
    }
  }
  return members;
}

app.get('/v1/clusters/:clusterId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {clusterId} = request.params as {clusterId: string};
  const cluster = await load(clusterId);
  // Another tenant's cluster does not exist for this caller: the same 404 as a missing one.
  if (cluster === null || cluster.tenant !== tenant) return reply.code(404).send({error: 'no such cluster'});
  const strong = cluster.pairs.filter(p => p.score >= MIN_MERGE_CONFIDENCE);
  // Only strong pairs link: a weak pair waits for a reviewer instead of bridging two groups.
  const members = linked(cluster.seed, strong);
  const evidence = strong.filter(p => members.has(p.a) && members.has(p.b));
  const review = cluster.pairs.filter(p => p.score < MIN_MERGE_CONFIDENCE && (members.has(p.a) || members.has(p.b)));
  return {cluster_id: clusterId, members: [...members].sort(), evidence, review, history: cluster.history};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"dedupe/clusters" // clusters.Load
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// linked is every record the pairs connect to the seed, directly or through other records, sorted.
func linked(seed string, pairs []clusters.Pair) []string {
	members := map[string]bool{seed: true}
	for grew := true; grew; {
		grew = false
		for _, p := range pairs {
			if members[p.A] != members[p.B] {
				members[p.A], members[p.B] = true, true
				grew = true
			}
		}
	}
	out := make([]string, 0, len(members))
	for id := range members {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func readCluster(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	clusterID := r.PathValue("id")
	cluster, err := clusters.Load(r.Context(), clusterID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if cluster == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such cluster"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"cluster_id": clusterID, "members": linked(cluster.Seed, cluster.Pairs)})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/clusters/{id}", readCluster)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"sort"

	"dedupe/clusters" // clusters.Load
)

const minMergeConfidence = 0.85

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// linked is every record the pairs connect to the seed, directly or through other records, sorted.
func linked(seed string, pairs []clusters.Pair) []string {
	members := map[string]bool{seed: true}
	for grew := true; grew; {
		grew = false
		for _, p := range pairs {
			if members[p.A] != members[p.B] {
				members[p.A], members[p.B] = true, true
				grew = true
			}
		}
	}
	out := make([]string, 0, len(members))
	for id := range members {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func readCluster(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	clusterID := r.PathValue("id")
	cluster, err := clusters.Load(r.Context(), clusterID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	// Another tenant's cluster does not exist for this caller: the same 404 as a missing one.
	if cluster == nil || cluster.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such cluster"})
		return
	}
	strong := []clusters.Pair{}
	for _, p := range cluster.Pairs {
		if p.Score >= minMergeConfidence {
			strong = append(strong, p)
		}
	}
	// Only strong pairs link: a weak pair waits for a reviewer instead of bridging two groups.
	members := linked(cluster.Seed, strong)
	evidence, review := []clusters.Pair{}, []clusters.Pair{}
	for _, p := range cluster.Pairs {
		a, b := slices.Contains(members, p.A), slices.Contains(members, p.B)
		if p.Score >= minMergeConfidence && a && b {
			evidence = append(evidence, p)
		} else if p.Score < minMergeConfidence && (a || b) {
			review = append(review, p)
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"cluster_id": clusterID,
		"members":    members,
		"evidence":   evidence,
		"review":     review,
		"history":    cluster.History,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/clusters/{id}", readCluster)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import dedupe.Clusters // Clusters.load

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(pair: JsObject, name: String): String = pair.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Every record the pairs connect to the seed, directly or through other records. */
  def linked(seed: String, pairs: Seq[JsObject]): Set[String] = {
    var members = Set(seed)
    var grew = true
    while (grew) {
      grew = false
      for (pair <- pairs) {
        val (a, b) = (text(pair, "a"), text(pair, "b"))
        if (members.contains(a) != members.contains(b)) {
          members ++= Set(a, b)
          grew = true
        }
      }
    }
    members
  }

  val route: Route = path("v1" / "clusters" / Segment) { clusterId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Clusters.load(clusterId) match {
        case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such cluster"))))
        case Some(cluster) =>
          val members = linked(cluster.seed, cluster.pairs)
          complete(json(StatusCodes.OK, JsObject("cluster_id" -> JsString(clusterId), "members" -> JsArray(members.toVector.sorted.map(JsString(_))))))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import dedupe.Clusters // Clusters.load

object Read {
  val MinMergeConfidence = 0.85

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(pair: JsObject, name: String): String = pair.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def score(pair: JsObject): Double = pair.fields.get("score").collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0)

  /** Every record the pairs connect to the seed, directly or through other records. */
  def linked(seed: String, pairs: Seq[JsObject]): Set[String] = {
    var members = Set(seed)
    var grew = true
    while (grew) {
      grew = false
      for (pair <- pairs) {
        val (a, b) = (text(pair, "a"), text(pair, "b"))
        if (members.contains(a) != members.contains(b)) {
          members ++= Set(a, b)
          grew = true
        }
      }
    }
    members
  }

  val route: Route = path("v1" / "clusters" / Segment) { clusterId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          // Another tenant's cluster does not exist for this caller: the same 404 as a missing one.
          Clusters.load(clusterId).filter(_.tenant == tenant) match {
            case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such cluster"))))
            case Some(cluster) =>
              val (strong, weak) = cluster.pairs.partition(p => score(p) >= MinMergeConfidence)
              // Only strong pairs link: a weak pair waits for a reviewer instead of bridging two groups.
              val members = linked(cluster.seed, strong)
              val evidence = strong.filter(p => members.contains(text(p, "a")) && members.contains(text(p, "b")))
              val review = weak.filter(p => members.contains(text(p, "a")) || members.contains(text(p, "b")))
              complete(json(StatusCodes.OK, JsObject(
                "cluster_id" -> JsString(clusterId),
                "members" -> JsArray(members.toVector.sorted.map(JsString(_))),
                "evidence" -> JsArray(evidence.toVector),
                "review" -> JsArray(review.toVector),
                "history" -> JsArray(cluster.history.toVector)
              )))
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

#include <set>
#include <string>
#include <vector>

#include "dedupe/clusters.h"  // clusters::load

using json = nlohmann::json;

// Every record the pairs connect to the seed, directly or through other records.
std::set<std::string> linked(const std::string& seed, const std::vector<json>& pairs) {
  std::set<std::string> members = {seed};
  for (bool grew = true; grew;) {
    grew = false;
    for (const json& pair : pairs) {
      const std::string a = pair.value("a", ""), b = pair.value("b", "");
      if (members.count(a) != members.count(b)) {
        members.insert(a);
        members.insert(b);
        grew = true;
      }
    }
  }
  return members;
}

void read_cluster(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string cluster_id = req.matches[1];
  const auto cluster = clusters::load(cluster_id);
  if (!cluster) {
    res.status = 404;
    res.set_content(json{{"error", "no such cluster"}}.dump(), "application/json");
    return;
  }
  const std::set<std::string> members = linked(cluster->seed, cluster->pairs);
  res.set_content(json{{"cluster_id", cluster_id}, {"members", members}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/clusters/([\\w-]+))", read_cluster); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "dedupe/clusters.h"  // clusters::load

using json = nlohmann::json;

constexpr double kMinMergeConfidence = 0.85;

// Every record the pairs connect to the seed, directly or through other records.
std::set<std::string> linked(const std::string& seed, const std::vector<json>& pairs) {
  std::set<std::string> members = {seed};
  for (bool grew = true; grew;) {
    grew = false;
    for (const json& pair : pairs) {
      const std::string a = pair.value("a", ""), b = pair.value("b", "");
      if (members.count(a) != members.count(b)) {
        members.insert(a);
        members.insert(b);
        grew = true;
      }
    }
  }
  return members;
}

void read_cluster(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "X-Tenant-Id is required"}}.dump(), "application/json");
    return;
  }
  const std::string cluster_id = req.matches[1];
  const auto cluster = clusters::load(cluster_id);
  // Another tenant's cluster does not exist for this caller: the same 404 as a missing one.
  if (!cluster || cluster->tenant != tenant) {
    res.status = 404;
    res.set_content(json{{"error", "no such cluster"}}.dump(), "application/json");
    return;
  }
  std::vector<json> strong;
  for (const json& pair : cluster->pairs) {
    if (pair.value("score", 0.0) >= kMinMergeConfidence) strong.push_back(pair);
  }
  // Only strong pairs link: a weak pair waits for a reviewer instead of bridging two groups.
  const std::set<std::string> members = linked(cluster->seed, strong);
  json evidence = json::array(), review = json::array();
  for (const json& pair : cluster->pairs) {
    const bool a = members.count(pair.value("a", "")) > 0, b = members.count(pair.value("b", "")) > 0;
    if (pair.value("score", 0.0) >= kMinMergeConfidence && a && b) evidence.push_back(pair);
    if (pair.value("score", 0.0) < kMinMergeConfidence && (a || b)) review.push_back(pair);
  }
  const json body = {{"cluster_id", cluster_id}, {"members", members}, {"evidence", evidence}, {"review", review}, {"history", cluster->history}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/clusters/([\\w-]+))", read_cluster); }
`,
    },
  },
  harness: {
    python: `from dedupe import clusters

STRONG = {"a": "r-1", "b": "r-2", "score": 0.97, "key_type": "email_hash"}
WEAK = {"a": "r-2", "b": "r-3", "score": 0.62, "key_type": "fuzzy"}
BEYOND = {"a": "r-3", "b": "r-4", "score": 0.95, "key_type": "phone_hash"}
HISTORY = [
    {"at": "2026-11-02T09:00:00Z", "action": "merge", "a": "r-1", "b": "r-2", "by": "matcher"},
    {"at": "2026-11-02T09:05:00Z", "action": "hold", "a": "r-2", "b": "r-3", "by": "matcher"},
]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, cluster_id, tenant="acme"):
    headers = {} if tenant is None else {"X-Tenant-Id": tenant}
    return await c.get(f"/v1/clusters/{cluster_id}", headers=headers)


async def check_route(ctx):
    cluster_id = clusters.create("acme", "r-1", [STRONG], HISTORY[:1])
    async with _api(ctx) as c:
        r = await _get(c, cluster_id)
    assert r.status_code == 200, f"GET /v1/clusters/{cluster_id} answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("cluster_id") == cluster_id and body.get("members") == ["r-1", "r-2"], f"a cluster of r-1 and r-2 linked at 0.97 answered {body}"


async def check_tenant_scope(ctx):
    foreign = clusters.create("globex", "r-8", [{"a": "r-8", "b": "r-9", "score": 0.99, "key_type": "email_hash"}], [])
    async with _api(ctx) as c:
        r = await _get(c, foreign, tenant="acme")
        assert r.status_code == 404, f"acme reading globex's cluster {foreign} answered {r.status_code} {r.text}: a guessed id must not return another tenant's records. Expected 404"
        assert "r-8" not in r.text and "r-9" not in r.text, f"the 404 carries globex's records: {r.text}"
        r = await _get(c, "c-404", tenant="acme")
        assert r.status_code == 404, f"a cluster that does not exist answered {r.status_code}, expected 404"
        own = clusters.create("acme", "r-1", [STRONG], [])
        r = await _get(c, own, tenant=None)
        assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code} {r.text}, expected 401"
        r = await _get(c, own, tenant="acme")
    assert r.status_code == 200, f"acme reading its own cluster answered {r.status_code}: {r.text}"


async def check_weak_pair(ctx):
    cluster_id = clusters.create("acme", "r-1", [STRONG, WEAK, BEYOND], HISTORY)
    async with _api(ctx) as c:
        r = await _get(c, cluster_id)
    assert r.status_code == 200, f"the read answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("members") == ["r-1", "r-2"], f"r-1–r-2 scores 0.97 and r-2–r-3 only 0.62, and the cluster's members are {body.get('members')}: a pair below MIN_MERGE_CONFIDENCE = 0.85 bridged r-3 and r-4 in. Expected [r-1, r-2]"
    assert body.get("review") == [WEAK], f"the weak pair must wait under review, the answer has review = {body.get('review')}"


async def check_evidence(ctx):
    cluster_id = clusters.create("acme", "r-1", [STRONG, WEAK, BEYOND], HISTORY)
    async with _api(ctx) as c:
        r = await _get(c, cluster_id)
    body = r.json()
    assert "evidence" in body, f"the cluster answered {body}: no evidence, so nobody can see why r-2 is a member"
    assert body["evidence"] == [STRONG], f"the evidence is {body['evidence']}, expected the one strong pair between members as stored: {[STRONG]}"
    assert body.get("review") == [WEAK], f"review is {body.get('review')}, expected the weak pair {WEAK}"


async def check_history(ctx):
    cluster_id = clusters.create("acme", "r-1", [STRONG, WEAK], HISTORY)
    async with _api(ctx) as c:
        r = await _get(c, cluster_id)
    body = r.json()
    assert body.get("history") == HISTORY, f"the cluster answered history = {body.get('history')}, expected the stored merge actions oldest first: {HISTORY}"
`,
    typescript: `const STRONG = {a: 'r-1', b: 'r-2', score: 0.97, key_type: 'email_hash'};
const WEAK = {a: 'r-2', b: 'r-3', score: 0.62, key_type: 'fuzzy'};
const BEYOND = {a: 'r-3', b: 'r-4', score: 0.95, key_type: 'phone_hash'};
const HISTORY = [
  {at: '2026-11-02T09:00:00Z', action: 'merge', a: 'r-1', b: 'r-2', by: 'matcher'},
  {at: '2026-11-02T09:05:00Z', action: 'hold', a: 'r-2', b: 'r-3', by: 'matcher'},
];

function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), clusters: ctx.load('/support/dedupe/clusters.ts')};
}

const read = (c, clusterId: string, tenant: string | null = 'acme') =>
  c.get(\`/v1/clusters/\${clusterId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function check_route(ctx) {
  const {c, clusters} = api(ctx);
  const clusterId = await clusters.create('acme', 'r-1', [STRONG], HISTORY.slice(0, 1));
  const r = await read(c, clusterId);
  assert.equal(r.status, 200, \`GET /v1/clusters/\${clusterId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.cluster_id === clusterId && same(body.members, ['r-1', 'r-2']), \`a cluster of r-1 and r-2 linked at 0.97 answered \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, clusters} = api(ctx);
  const foreign = await clusters.create('globex', 'r-8', [{a: 'r-8', b: 'r-9', score: 0.99, key_type: 'email_hash'}], []);
  let r = await read(c, foreign, 'acme');
  assert.equal(r.status, 404, \`acme reading globex's cluster \${foreign} answered \${r.status} \${r.text}: a guessed id must not return another tenant's records. Expected 404\`);
  assert(!r.text.includes('r-8') && !r.text.includes('r-9'), \`the 404 carries globex's records: \${r.text}\`);
  r = await read(c, 'c-404', 'acme');
  assert.equal(r.status, 404, \`a cluster that does not exist answered \${r.status}, expected 404\`);
  const own = await clusters.create('acme', 'r-1', [STRONG], []);
  r = await read(c, own, null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status} \${r.text}, expected 401\`);
  r = await read(c, own, 'acme');
  assert.equal(r.status, 200, \`acme reading its own cluster answered \${r.status}: \${r.text}\`);
}

export async function check_weak_pair(ctx) {
  const {c, clusters} = api(ctx);
  const clusterId = await clusters.create('acme', 'r-1', [STRONG, WEAK, BEYOND], HISTORY);
  const r = await read(c, clusterId);
  assert.equal(r.status, 200, \`the read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(same(body.members, ['r-1', 'r-2']), \`r-1–r-2 scores 0.97 and r-2–r-3 only 0.62, and the cluster's members are \${JSON.stringify(body.members)}: a pair below MIN_MERGE_CONFIDENCE = 0.85 bridged r-3 and r-4 in. Expected [r-1, r-2]\`);
  assert(same(body.review, [WEAK]), \`the weak pair must wait under review, the answer has review = \${JSON.stringify(body.review)}\`);
}

export async function check_evidence(ctx) {
  const {c, clusters} = api(ctx);
  const clusterId = await clusters.create('acme', 'r-1', [STRONG, WEAK, BEYOND], HISTORY);
  const body = (await read(c, clusterId)).json();
  assert(body.evidence !== undefined, \`the cluster answered \${JSON.stringify(body)}: no evidence, so nobody can see why r-2 is a member\`);
  assert(same(body.evidence, [STRONG]), \`the evidence is \${JSON.stringify(body.evidence)}, expected the one strong pair between members as stored: \${JSON.stringify([STRONG])}\`);
  assert(same(body.review, [WEAK]), \`review is \${JSON.stringify(body.review)}, expected the weak pair \${JSON.stringify(WEAK)}\`);
}

export async function check_history(ctx) {
  const {c, clusters} = api(ctx);
  const clusterId = await clusters.create('acme', 'r-1', [STRONG, WEAK], HISTORY);
  const body = (await read(c, clusterId)).json();
  assert(same(body.history, HISTORY), \`the cluster answered history = \${JSON.stringify(body.history)}, expected the stored merge actions oldest first: \${JSON.stringify(HISTORY)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"dedupe/clusters"

	"leetbuild/harness"
)

var (
	strongPair = clusters.Pair{A: "r-1", B: "r-2", Score: 0.97, KeyType: "email_hash"}
	weakPair   = clusters.Pair{A: "r-2", B: "r-3", Score: 0.62, KeyType: "fuzzy"}
	beyondPair = clusters.Pair{A: "r-3", B: "r-4", Score: 0.95, KeyType: "phone_hash"}
	history    = []clusters.HistoryEntry{
		{At: "2026-11-02T09:00:00Z", Action: "merge", A: "r-1", B: "r-2", By: "matcher"},
		{At: "2026-11-02T09:05:00Z", Action: "hold", A: "r-2", B: "r-3", By: "matcher"},
	}
)

type clusterReply struct {
	ClusterID string                  \`json:"cluster_id"\`
	Members   []string                \`json:"members"\`
	Evidence  []clusters.Pair         \`json:"evidence"\`
	Review    []clusters.Pair         \`json:"review"\`
	History   []clusters.HistoryEntry \`json:"history"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func seedCluster(ctx *harness.Ctx, tenant, seed string, pairs []clusters.Pair, hist []clusters.HistoryEntry) string {
	id, err := clusters.Create(context.Background(), tenant, seed, pairs, hist)
	ctx.NoError(err, "seeding the cluster store")
	return id
}

func read(c *harness.HTTP, clusterID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/clusters/" + clusterID)
	}
	return c.Get("/v1/clusters/"+clusterID, "X-Tenant-Id", tenant)
}

func decode(ctx *harness.Ctx, r *harness.Response) (clusterReply, map[string]any) {
	var body clusterReply
	var fields map[string]any
	ctx.NoError(json.Unmarshal([]byte(r.Text()), &body), "the cluster must be JSON (%s)", r.Text())
	json.Unmarshal([]byte(r.Text()), &fields)
	return body, fields
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	id := seedCluster(ctx, "acme", "r-1", []clusters.Pair{strongPair}, history[:1])
	r := read(c, id, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/clusters/%s (%s)", id, r.Text())
	body, _ := decode(ctx, r)
	ctx.Assert(body.ClusterID == id && strings.Join(body.Members, ",") == "r-1,r-2", "a cluster of r-1 and r-2 linked at 0.97 answered %s", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	foreign := seedCluster(ctx, "globex", "r-8", []clusters.Pair{{A: "r-8", B: "r-9", Score: 0.99, KeyType: "email_hash"}}, nil)
	r := read(c, foreign, "acme")
	ctx.Assert(r.Status == 404, "acme reading globex's cluster %s answered %d %s: a guessed id must not return another tenant's records. Expected 404", foreign, r.Status, r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "r-8") && !strings.Contains(r.Text(), "r-9"), "the 404 carries globex's records: %s", r.Text())
	r = read(c, "c-404", "acme")
	ctx.Equal(r.Status, 404, "a cluster that does not exist; the status")
	own := seedCluster(ctx, "acme", "r-1", []clusters.Pair{strongPair}, nil)
	r = read(c, own, "")
	ctx.Equal(r.Status, 401, "a read without X-Tenant-Id (%s); the status", r.Text())
	r = read(c, own, "acme")
	ctx.Equal(r.Status, 200, "acme reading its own cluster (%s); the status", r.Text())
}

func CheckWeakPair(ctx *harness.Ctx) {
	c := api(ctx)
	id := seedCluster(ctx, "acme", "r-1", []clusters.Pair{strongPair, weakPair, beyondPair}, history)
	r := read(c, id, "acme")
	ctx.Equal(r.Status, 200, "the read (%s)", r.Text())
	body, _ := decode(ctx, r)
	ctx.Assert(strings.Join(body.Members, ",") == "r-1,r-2", "r-1–r-2 scores 0.97 and r-2–r-3 only 0.62, and the cluster's members are %q: a pair below minMergeConfidence = 0.85 bridged r-3 and r-4 in. Expected [r-1 r-2]", body.Members)
	ctx.Equal(body.Review, []clusters.Pair{weakPair}, "the weak pair must wait under review; review")
}

func CheckEvidence(ctx *harness.Ctx) {
	c := api(ctx)
	id := seedCluster(ctx, "acme", "r-1", []clusters.Pair{strongPair, weakPair, beyondPair}, history)
	r := read(c, id, "acme")
	body, fields := decode(ctx, r)
	_, has := fields["evidence"]
	ctx.Assert(has, "the cluster answered %s: no evidence, so nobody can see why r-2 is a member", r.Text())
	ctx.Equal(body.Evidence, []clusters.Pair{strongPair}, "the evidence must be the one strong pair between members as stored")
	ctx.Equal(body.Review, []clusters.Pair{weakPair}, "review must hold the weak pair")
}

func CheckHistory(ctx *harness.Ctx) {
	c := api(ctx)
	id := seedCluster(ctx, "acme", "r-1", []clusters.Pair{strongPair, weakPair}, history)
	r := read(c, id, "acme")
	body, _ := decode(ctx, r)
	ctx.Equal(body.History, history, "the cluster's history must be the stored merge actions, oldest first")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "dedupe/clusters.h"

namespace {

const nlohmann::json kStrong = {{"a", "r-1"}, {"b", "r-2"}, {"score", 0.97}, {"key_type", "email_hash"}};
const nlohmann::json kWeak = {{"a", "r-2"}, {"b", "r-3"}, {"score", 0.62}, {"key_type", "fuzzy"}};
const nlohmann::json kBeyond = {{"a", "r-3"}, {"b", "r-4"}, {"score", 0.95}, {"key_type", "phone_hash"}};
const std::vector<nlohmann::json> kHistory = {
    {{"at", "2026-11-02T09:00:00Z"}, {"action", "merge"}, {"a", "r-1"}, {"b", "r-2"}, {"by", "matcher"}},
    {{"at", "2026-11-02T09:05:00Z"}, {"action", "hold"}, {"a", "r-2"}, {"b", "r-3"}, {"by", "matcher"}},
};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response read(harness::HTTP& c, const std::string& cluster_id, const std::string& tenant = "acme") {
  if (tenant.empty()) return c.Get("/v1/clusters/" + cluster_id);
  return c.Get("/v1/clusters/" + cluster_id, "X-Tenant-Id", tenant);
}

nlohmann::json body(const harness::Response& r) {
  const auto parsed = nlohmann::json::parse(r.Text(), nullptr, false);
  return parsed.is_object() ? parsed : nlohmann::json::object();
}

nlohmann::json field(const nlohmann::json& j, const std::string& name) { return j.contains(name) ? j[name] : nlohmann::json(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = clusters::create("acme", "r-1", {kStrong}, {kHistory[0]});
  const auto r = read(c, id);
  ctx.Equal(r.Status, 200, "GET /v1/clusters/%s (%s)", id, r.Text());
  const auto b = body(r);
  ctx.Assert(field(b, "cluster_id") == id && field(b, "members") == nlohmann::json{"r-1", "r-2"}, "a cluster of r-1 and r-2 linked at 0.97 answered %s", r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string foreign = clusters::create("globex", "r-8", {{{"a", "r-8"}, {"b", "r-9"}, {"score", 0.99}, {"key_type", "email_hash"}}}, {});
  auto r = read(c, foreign, "acme");
  ctx.Assert(r.Status == 404, "acme reading globex's cluster %s answered %d %s: a guessed id must not return another tenant's records. Expected 404", foreign, r.Status, r.Text());
  ctx.Assert(r.Text().find("r-8") == std::string::npos && r.Text().find("r-9") == std::string::npos, "the 404 carries globex's records: %s", r.Text());
  r = read(c, "c-404", "acme");
  ctx.Equal(r.Status, 404, "a cluster that does not exist; the status");
  const std::string own = clusters::create("acme", "r-1", {kStrong}, {});
  r = read(c, own, "");
  ctx.Equal(r.Status, 401, "a read without X-Tenant-Id (%s); the status", r.Text());
  r = read(c, own, "acme");
  ctx.Equal(r.Status, 200, "acme reading its own cluster (%s); the status", r.Text());
}

void CheckWeakPair(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = clusters::create("acme", "r-1", {kStrong, kWeak, kBeyond}, kHistory);
  const auto r = read(c, id);
  ctx.Equal(r.Status, 200, "the read (%s)", r.Text());
  const auto b = body(r);
  ctx.Assert(field(b, "members") == nlohmann::json{"r-1", "r-2"},
             "r-1–r-2 scores 0.97 and r-2–r-3 only 0.62, and the cluster's members are %s: a pair below kMinMergeConfidence = 0.85 bridged r-3 and r-4 in. Expected [r-1, r-2]",
             field(b, "members").dump());
  ctx.Equal(field(b, "review"), nlohmann::json::array({kWeak}), "the weak pair must wait under review; review");
}

void CheckEvidence(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = clusters::create("acme", "r-1", {kStrong, kWeak, kBeyond}, kHistory);
  const auto r = read(c, id);
  const auto b = body(r);
  ctx.Assert(b.contains("evidence"), "the cluster answered %s: no evidence, so nobody can see why r-2 is a member", r.Text());
  ctx.Equal(field(b, "evidence"), nlohmann::json::array({kStrong}), "the evidence must be the one strong pair between members as stored");
  ctx.Equal(field(b, "review"), nlohmann::json::array({kWeak}), "review must hold the weak pair");
}

void CheckHistory(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = clusters::create("acme", "r-1", {kStrong, kWeak}, kHistory);
  const auto b = body(read(c, id));
  ctx.Equal(field(b, "history"), nlohmann::json(kHistory), "the cluster's history must be the stored merge actions, oldest first");
}
`,
  },
  hints: [
    "An operator opens a cluster and finds four records where two belong; nothing in the answer says which pair put them there. A colleague's guessed id returns another tenant's cluster.",
    "`linked` grows the members over every pair, so a 0.62 fuzzy link counts like a 0.97 email match and pulls in all it reaches. The handler does not compare the cluster's tenant with the caller's, and answers members only.",
    'Read `X-Tenant-Id` (401), answer 404 when `cluster["tenant"] != tenant`, call `linked` with the pairs scoring at least `MIN_MERGE_CONFIDENCE`, and answer `evidence` (strong pairs between members), `review` (weak pairs touching them) and `history`.',
  ],
  debrief: `Transitive closure has no idea of weakness: each link looks acceptable on its own, and the cluster rests on its weakest one. Filtering pairs by score before growing the members, and listing the weak ones under review, makes the cluster a claim backed by evidence a reader can check, which is why the evidence and the history are part of the answer: a merge nobody can explain is a merge nobody can undo. The 404 for another tenant's cluster is the same answer as a missing one, so an id reveals nothing. Production entity-resolution systems keep the weakest link's score on every cluster, as Zingg's \`Z_MINSCORE\` does, and route clusters below a floor to a review queue instead of a golden record.`,
};
