import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/clusters/{id}: transitive merges with evidence',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store', 'review'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the cluster read. It
compiles, it returns a cluster, and it hides three production flaws. Review it like the service
owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/clusters/{id}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The cluster is scoped to the caller's tenant: a cluster that belongs to another tenant is **404**,
  never a partial or redacted answer.
- The response returns the member records, the **merge evidence per pair**, and the **merge history**.
- A cluster may not be presented as merged when one of its links relies on a pair **below the
  confidence floor**: such a pair must be routed to the review queue instead of silently bridging
  two clusters. Three records where A–B is strong and B–C is weak must not put A and C in one cluster
  without review.

**Failure mode the checks target.** The draft unions transitively on any pair, so one weak link
collapses unrelated records into one cluster. It hides the evidence and the history, so the operator
cannot see why the cluster exists. And it does not check the tenant, so a guessed cluster id returns
another tenant's records.`,
  sequence: {
    participants: ['Client', 'Dedupe API', 'record store', 'Review queue'],
    messages: [
      {from: 'Client', to: 'Dedupe API', label: 'GET /v1/clusters/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Dedupe API', to: 'record store', label: 'load cluster · members · evidence', kind: 'sync'},
      {from: 'record store', to: 'Dedupe API', label: 'cluster / none', kind: 'reply'},
      {from: 'Dedupe API', to: 'Dedupe API', label: 'scope to tenant · keep weak pairs', kind: 'sync'},
      {from: 'Dedupe API', to: 'Review queue', label: 'enqueue weak pair', kind: 'async'},
      {from: 'Dedupe API', to: 'Client', label: '200 {members, evidence, history} / 404', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/clusters/{id}',
      detail: 'Register the cluster read on `GET /v1/clusters/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/clusters\/\{[^}]+\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/clusters\/:[A-Za-z]+['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/clusters\/"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"clusters"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\^\/v1\/clusters\/\(\[\^\/\]\+\)\$\)"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the read to the tenant',
      detail:
        "The cluster is looked up inside the caller's tenant scope and a foreign cluster is **404**. The draft returns any cluster by id, so a guessed id leaks another tenant's records.",
      match: {
        python: {all: [/tenant_scope\(/], none: [/global_?similarity/i]},
        typescript: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        go: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        scala: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        cpp: {all: [/tenant_scope\(/], none: [/global_?similarity/i]},
      },
    },
    {
      id: 'evidence',
      title: 'Returns the merge evidence per pair',
      detail:
        'The response carries an `evidence` entry for every link in the cluster. The draft returns members only and hides why they were merged.',
      match: {
        python: {all: [/evidence/]},
        typescript: {all: [/evidence/]},
        go: {all: [/evidence/]},
        scala: {all: [/evidence/]},
        cpp: {all: [/evidence/]},
      },
    },
    {
      id: 'weak-pair',
      title: 'Refuses to bridge clusters on a weak pair',
      detail:
        'A pair below the confidence floor is not unioned silently; the cluster is held for review instead. The draft unions transitively on any pair.',
      match: {
        python: {
          all: [/(?:<|<=)\s*MIN_MERGE_CONFIDENCE/],
          none: [/def\s+union_find\(/],
        },
        typescript: {
          all: [/[<(]=?\s*MIN_MERGE_CONFIDENCE/],
          none: [/function\s+unionFind\(/],
        },
        go: {
          all: [/[<(]=?\s*minMergeConfidence/],
          none: [/func\s+unionFind\(/],
        },
        scala: {all: [/[<(]=?\s*MinMergeConfidence/]},
        cpp: {
          all: [/[<(]=?\s*kMinMergeConfidence/],
          none: [/union_find|unionFind/],
        },
      },
    },
    {
      id: 'history',
      title: 'Returns the merge history',
      detail:
        'The response carries the `history` of merges that built the cluster. The draft hides it, so an operator cannot see how the cluster formed.',
      match: {
        python: {all: [/history/]},
        typescript: {all: [/history/]},
        go: {all: [/history/]},
        scala: {all: [/history/]},
        cpp: {all: [/history/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MIN_MERGE_CONFIDENCE = 0.8


def union_find(clusters: list[dict]) -> list[list[str]]:
    """Union records transitively on any pair."""
    parent = {record: record for cluster in clusters for record in cluster["members"]}

    def find(node):
        while parent[node] != node:
            node = parent[node]
        return node

    for cluster in clusters:
        for member in cluster["pairs"]:
            left, right = find(member[0]), find(member[1])
            if left != right:
                parent[left] = right
    groups = {}
    for record in parent:
        groups.setdefault(find(record), []).append(record)
    return list(groups.values())


@app.get("/v1/clusters/{cluster_id}")
def read_cluster(cluster_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft unions transitively on any weak pair, hides the evidence and the merge
    # history, and returns a cluster without checking the tenant. Review all three.
    cluster = cluster_store.load(cluster_id)
    if cluster is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(
        {
            "cluster_id": cluster_id,
            "members": union_find(cluster["clusters"]),
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MIN_MERGE_CONFIDENCE = 0.8


def tenant_scope(tenant: str) -> str:
    """Namespace for one tenant's clusters; never shared across tenants."""
    return f"t:{tenant}"


@app.get("/v1/clusters/{cluster_id}")
def read_cluster(cluster_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    cluster = cluster_store.load(tenant_scope(tenant), cluster_id)
    if cluster is None:
        # A cluster outside the caller's tenant is not found, never partially returned.
        return JSONResponse({"error": "not found"}, status_code=404)
    if cluster["confidence"] < MIN_MERGE_CONFIDENCE:
        # A weak link cannot bridge clusters silently; hold the pair for review.
        review_queue.enqueue(tenant_scope(tenant), cluster_id)
        return JSONResponse(
            {
                "cluster_id": cluster_id,
                "members": cluster["members"],
                "evidence": cluster["evidence"],
                "history": cluster["history"],
                "held_for_review": True,
            },
            status_code=200,
        )
    return JSONResponse(
        {
            "cluster_id": cluster_id,
            "members": cluster["members"],
            "evidence": cluster["evidence"],
            "history": cluster["history"],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify({logger: true});

const MIN_MERGE_CONFIDENCE = 0.8;

interface Cluster {
  members: string[];
  pairs: [string, string][];
}

function unionFind(clusters: Cluster[]): string[][] {
  const parent: Record<string, string> = {};
  for (const cluster of clusters) for (const member of cluster.members) parent[member] = member;
  const find = (node: string): string => (parent[node] === node ? node : find(parent[node]));
  for (const cluster of clusters)
    for (const member of cluster.pairs) {
      const left = find(member[0]);
      const right = find(member[1]);
      if (left !== right) parent[left] = right;
    }
  const groups: Record<string, string[]> = {};
  for (const member of Object.keys(parent)) {
    const root = find(member);
    groups[root] = groups[root] ?? [];
    groups[root].push(member);
  }
  return Object.values(groups);
}

app.get('/v1/clusters/:clusterId', async (request, reply) => {
  // TODO: this draft unions transitively on any weak pair, hides the evidence and the merge
  // history, and returns a cluster without checking the tenant. Review all three.
  const {clusterId} = request.params as {clusterId: string};
  const cluster = clusterStore.load(clusterId);
  if (cluster === null) return reply.code(404).send({error: 'not found'});
  return reply.code(200).send({cluster_id: clusterId, members: cluster.members});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify({logger: true});

const MIN_MERGE_CONFIDENCE = 0.8;

function tenantScope(tenant: string): string {
  // Namespace for one tenant's clusters; never shared across tenants.
  return 't:' + tenant;
}

app.get('/v1/clusters/:clusterId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {clusterId} = request.params as {clusterId: string};
  const cluster = await clusterStore.load(tenantScope(tenant), clusterId);
  if (cluster === null) return reply.code(404).send({error: 'not found'});
  if (cluster.confidence < MIN_MERGE_CONFIDENCE)
    // A weak link cannot bridge clusters silently; hold the pair for review.
    return reply.code(200).send({
      cluster_id: clusterId,
      members: cluster.members,
      evidence: cluster.evidence,
      history: cluster.history,
      held_for_review: true,
    });
  return reply.code(200).send({
    cluster_id: clusterId,
    members: cluster.members,
    evidence: cluster.evidence,
    history: cluster.history,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

const minMergeConfidence = 0.8

func unionFind(clusters []Cluster) [][]string {
	parent := map[string]string{}
	for _, cluster := range clusters {
		for _, member := range cluster.Members {
			parent[member] = member
		}
	}
	var find func(string) string
	find = func(node string) string {
		if parent[node] == node {
			return node
		}
		return find(parent[node])
	}
	for _, cluster := range clusters {
		for _, member := range cluster.Pairs {
			left, right := find(member[0]), find(member[1])
			if left != right {
				parent[left] = right
			}
		}
	}
	groups := map[string][]string{}
	for member := range parent {
		root := find(member)
		groups[root] = append(groups[root], member)
	}
	out := [][]string{}
	for _, group := range groups {
		out = append(out, group)
	}
	return out
}

func readCluster(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft unions transitively on any weak pair, hides the evidence and the merge
	// history, and returns a cluster without checking the tenant. Review all three.
	clusterID := strings.TrimPrefix(r.URL.Path, "/v1/clusters/")
	cluster, err := clusterStore.Load(clusterID)
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"cluster_id": clusterID,
		"members":    cluster.Members,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/clusters/", readCluster)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

const minMergeConfidence = 0.8

func tenantScope(tenant string) string {
	// Namespace for one tenant's clusters; never shared across tenants.
	return "t:" + tenant
}

func readCluster(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	clusterID := strings.TrimPrefix(r.URL.Path, "/v1/clusters/")
	cluster, err := clusterStore.Load(tenantScope(tenant), clusterID)
	if err != nil {
		// A cluster outside the caller's tenant is not found, never partially returned.
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	response := map[string]any{
		"cluster_id": clusterID,
		"members":    cluster.Members,
		"evidence":   cluster.Evidence,
		"history":    cluster.History,
	}
	if cluster.Confidence < minMergeConfidence {
		// A weak link cannot bridge clusters silently; hold the pair for review.
		reviewQueue.Enqueue(tenantScope(tenant), clusterID)
		response["held_for_review"] = true
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(response)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/clusters/", readCluster)
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Cluster(cluster_id: String, members: List[String])

object ClusterApi {
  implicit val system: ActorSystem = ActorSystem("dedupe-service")
  implicit val clusterFormat: RootJsonFormat[Cluster] = jsonFormat2(Cluster)

  val MinMergeConfidence = 0.8

  val route: Route =
    path("v1" / "clusters" / Segment) { clusterId =>
      get {
        // TODO: this draft unions transitively on any weak pair, hides the evidence and the merge
        // history, and returns a cluster without checking the tenant. Review all three.
        clusterStore.load(clusterId) match {
          case Some(cluster) =>
            complete(StatusCodes.OK, cluster)
          case None =>
            complete(StatusCodes.NotFound, """{"error":"not found"}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ClusterView(
    cluster_id: String,
    members: List[String],
    evidence: List[String],
    history: List[String],
)

object ClusterApi {
  implicit val system: ActorSystem = ActorSystem("dedupe-service")
  implicit val clusterFormat: RootJsonFormat[ClusterView] = jsonFormat4(ClusterView)

  val MinMergeConfidence = 0.8

  def tenantScope(tenant: String): String =
    "t:" + tenant

  val route: Route =
    path("v1" / "clusters" / Segment) { clusterId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          tenantOpt.filter(_.nonEmpty) match {
            case None =>
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            case Some(tenant) =>
              clusterStore.load(tenantScope(tenant), clusterId) match {
                case None =>
                  // A cluster outside the caller's tenant is not found, never partially returned.
                  complete(StatusCodes.NotFound, """{"error":"not found"}""")
                case Some(cluster) =>
                  if (cluster.confidence < MinMergeConfidence) {
                    // A weak link cannot bridge clusters silently; hold the pair for review.
                    reviewQueue.enqueue(tenantScope(tenant), clusterId)
                  }
                  complete(
                    StatusCodes.OK,
                    ClusterView(clusterId, cluster.members, cluster.evidence, cluster.history))
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

constexpr double kMinMergeConfidence = 0.8;

int main() {
  httplib::Server svr;

  svr.Get(R"(^/v1/clusters/([^/]+)$)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft unions transitively on any weak pair, hides the evidence and the merge
    // history, and returns a cluster without checking the tenant. Review all three.
    const std::string clusterId = req.matches[1];
    const json cluster = cluster_store.load(clusterId);
    if (cluster.is_null()) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"cluster_id", clusterId}, {"members", cluster["members"]}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

constexpr double kMinMergeConfidence = 0.8;

std::string tenant_scope(const std::string& tenant) {
  // Namespace for one tenant's clusters; never shared across tenants.
  return "t:" + tenant;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(^/v1/clusters/([^/]+)$)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string clusterId = req.matches[1];
    const json cluster = cluster_store.load(tenant_scope(tenant), clusterId);
    if (cluster.is_null()) {
      // A cluster outside the caller's tenant is not found, never partially returned.
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    json response = {{"cluster_id", clusterId},
                     {"members", cluster["members"]},
                     {"evidence", cluster["evidence"]},
                     {"history", cluster["history"]}};
    if (cluster["confidence"].get<double>() < kMinMergeConfidence) {
      // A weak link cannot bridge clusters silently; hold the pair for review.
      review_queue.enqueue(tenant_scope(tenant), clusterId);
      response["held_for_review"] = true;
    }
    res.status = 200;
    res.set_content(response.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope the read first: load the cluster inside `t:{tenant}` and return **404** for anything outside it. A cluster id is guessable; the tenant is what makes it safe.',
    'A cluster is a claim about identity. Return the `evidence` per pair and the `history` of merges so an operator can see why two records are in the same cluster — an unexplained merge is an unaccountable one.',
    'The confidence floor is the merge gate: a pair below it cannot union two clusters on its own. Route the weak pair to review and present the cluster as held, so A–B strong and B–C weak never put A and C together silently.',
  ],
  debrief: `The interviewer is testing whether you treat a cluster as an evidence-backed claim rather than a transitive closure. Three defects are being checked: the tenant scope (a guessed id must not leak another tenant's records), the evidence and history (an unexplained merge cannot be audited or undone), and the confidence floor (one weak pair must not bridge unrelated clusters). The subtle part is transitive union: A–B and B–C each look reasonable, but the merge that puts A and C together rests on the weakest link. Real services keep an immutable merge log so a bad merge can be replayed backwards, require a human review for pairs below the floor, and return the per-pair evidence so a reviewer can adjudicate without loading every record.`,
};
