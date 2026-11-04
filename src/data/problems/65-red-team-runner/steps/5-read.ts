import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/redteam/runs/{id}: coverage before a verdict',
  concept: 'http',
  file: 'read',
  focus: ['client', 'runner', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/redteam/runs/{run_id}\`: it answers 401 without
\`X-Tenant-Id\`, loads the run with \`store.by_id\`, sums the \`succeeded\` outcomes from \`store.coverage\`
(step 3's counts) into \`findings\`, and answers \`{run_id, target, run_status, status, findings}\` with
\`status\` \`pass\` when there are none and \`fail\` otherwise. It hides 4 flaws.

**Failure mode the checks target.** A run the kill switch stopped after one category of three reports
\`pass\`, and a release ships with two categories untested: a category that did not run has no
findings either. The reader cannot see which categories ran, and anyone who knows a run id reads
another tenant's findings.

Requirements:

- The run is tenant-scoped: another tenant's run is **404**, the same answer as a run that does not
  exist.
- \`coverage\` lists every category of the run's \`plan\`, in plan order, as \`{category, planned, blocked,
  succeeded, missing}\`; \`missing\` is \`planned - blocked - succeeded\` (timeouts, errors and unsent
  probes have no verdict).
- \`skipped_categories\` lists the categories with \`missing > 0\`.
- \`status\` is \`fail\` when any probe succeeded, otherwise \`incomplete\` while \`skipped_categories\` is not
  empty, and \`pass\` only when every planned probe was blocked.`,
  sequence: {
    participants: ['Release manager', 'redteamd', 'run store'],
    messages: [
      {from: 'Release manager', to: 'redteamd', label: 'GET /v1/redteam/runs/run-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'redteamd', to: 'run store', label: 'by_id(run-7) · tenant match', kind: 'sync'},
      {from: 'run store', to: 'redteamd', label: 'run (plan) + coverage counts', kind: 'reply'},
      {from: 'redteamd', to: 'redteamd', label: 'planned vs blocked + succeeded per category', kind: 'sync'},
      {
        from: 'redteamd',
        to: 'Release manager',
        label: '200 {status: incomplete, coverage, skipped_categories}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route-get',
      title: 'Handles GET /v1/redteam/runs/{id}',
      detail:
        'The report route answers 200 with run_id, target, the run’s status, a pass or fail verdict and the findings count, and 401 without X-Tenant-Id.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/redteam\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/redteam\/runs\/:run_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/redteam\/runs\/\{runID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"redteam"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/redteam\/runs\//]},
      },
    },
    {
      id: 'coverage-by-category',
      title: 'Reports coverage per planned category',
      detail:
        'coverage lists every category of the plan in order with planned, blocked, succeeded and missing counts, including a category that did not run. The starter answers one number.',
      match: {
        python: {all: [/["']planned["']/, /["']missing["']/]},
        typescript: {all: [/\bplanned\b/, /\bmissing\b/]},
        go: {all: [/"planned"/, /"missing"/]},
        scala: {all: [/"planned"/, /"missing"/]},
        cpp: {all: [/"planned"/, /"missing"/]},
      },
    },
    {
      id: 'skipped-visible',
      title: 'Names the categories without full coverage',
      detail:
        'skipped_categories lists every category with probes lacking a verdict: unsent, timed out or errored. The starter drops them from the answer, so an aborted run reads like a short one.',
      match: {
        python: {all: [/skipped_categories/]},
        typescript: {all: [/skipped_categories/]},
        go: {all: [/skipped_categories/]},
        scala: {all: [/skipped_categories/]},
        cpp: {all: [/skipped_categories/]},
      },
    },
    {
      id: 'incomplete-not-pass',
      title: 'Refuses to report pass when coverage is incomplete',
      detail:
        'A run with no successful probe but a category short of verdicts is incomplete, not pass; a successful probe is fail either way. The starter reports pass whenever nothing succeeded.',
      match: {
        python: {all: [/["']incomplete["']/]},
        typescript: {all: [/['"]incomplete['"]/]},
        go: {all: [/"incomplete"/]},
        scala: {all: [/"incomplete"/]},
        cpp: {all: [/"incomplete"/]},
      },
    },
    {
      id: 'tenant-scoped-read',
      title: 'Serves only the caller’s runs',
      detail:
        'A run that belongs to another tenant is 404, exactly like one that does not exist. The starter loads by id and answers any tenant.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /run\.get\(\s*["']tenant["']\s*\)|run\[\s*["']tenant["']\s*\]/]},
        typescript: {all: [/code\(\s*404\s*\)/, /run\.tenant\b/]},
        go: {all: [/StatusNotFound/, /run\.Tenant\b/]},
        scala: {all: [/StatusCodes\.NotFound/, /\.tenant\b/]},
        cpp: {all: [/\b404\b/, /value\("tenant"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException

from redteam.runs import store

app = FastAPI()


@app.get("/v1/redteam/runs/{run_id}")
def get_report(run_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = store.by_id(run_id)
    outcomes = store.coverage(run_id)
    findings = sum(counts.get("succeeded", 0) for counts in outcomes.values())
    return {
        "run_id": run_id,
        "target": run["target"],
        "run_status": run["status"],
        "status": "pass" if findings == 0 else "fail",
        "findings": findings,
    }
`,
      solution: `from fastapi import FastAPI, Header, HTTPException

from redteam.runs import store

app = FastAPI()


@app.get("/v1/redteam/runs/{run_id}")
def get_report(run_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = store.by_id(run_id)
    if run is None or run.get("tenant") != tenant:
        raise HTTPException(status_code=404, detail="run not found")

    outcomes = store.coverage(run_id)
    coverage = []
    skipped = []
    for entry in run["plan"]:
        counts = outcomes.get(entry["category"], {})
        blocked = counts.get("blocked", 0)
        succeeded = counts.get("succeeded", 0)
        missing = entry["probes"] - blocked - succeeded
        coverage.append({"category": entry["category"], "planned": entry["probes"], "blocked": blocked, "succeeded": succeeded, "missing": missing})
        if missing > 0:
            skipped.append(entry["category"])
    findings = sum(item["succeeded"] for item in coverage)
    status = "fail" if findings > 0 else ("incomplete" if skipped else "pass")
    return {
        "run_id": run_id,
        "target": run["target"],
        "run_status": run["status"],
        "status": status,
        "findings": findings,
        "coverage": coverage,
        "skipped_categories": skipped,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {store} from 'redteam/runs';

export const app = Fastify();

app.get('/v1/redteam/runs/:run_id', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {run_id: runId} = request.params as {run_id: string};
  const run = await store.byId(runId);
  const outcomes = await store.coverage(runId);
  const findings = Object.values(outcomes).reduce((sum, counts) => sum + (counts.succeeded ?? 0), 0);
  return reply.code(200).send({
    run_id: runId,
    target: run?.target,
    run_status: run?.status,
    status: findings === 0 ? 'pass' : 'fail',
    findings,
  });
});
`,
      solution: `import Fastify from 'fastify';

import {store} from 'redteam/runs';

export const app = Fastify();

interface CategoryCoverage {
  category: string;
  planned: number;
  blocked: number;
  succeeded: number;
  missing: number;
}

app.get('/v1/redteam/runs/:run_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {run_id: runId} = request.params as {run_id: string};
  const run = await store.byId(runId);
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'run not found'});

  const outcomes = await store.coverage(runId);
  const coverage: CategoryCoverage[] = run.plan.map(entry => {
    const counts = outcomes[entry.category] ?? {};
    const blocked = counts.blocked ?? 0;
    const succeeded = counts.succeeded ?? 0;
    return {category: entry.category, planned: entry.probes, blocked, succeeded, missing: entry.probes - blocked - succeeded};
  });
  const skipped = coverage.filter(item => item.missing > 0).map(item => item.category);
  const findings = coverage.reduce((sum, item) => sum + item.succeeded, 0);
  const status = findings > 0 ? 'fail' : skipped.length > 0 ? 'incomplete' : 'pass';
  return reply.code(200).send({
    run_id: runId,
    target: run.target,
    run_status: run.status,
    status,
    findings,
    coverage,
    skipped_categories: skipped,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"redteam/runs" // runs.ByID(ctx, runID), runs.Coverage(ctx, runID) — provided
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runID")
	run, err := runs.ByID(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	outcomes, err := runs.Coverage(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	findings := 0
	for _, counts := range outcomes {
		findings += counts["succeeded"]
	}
	status := "pass"
	if findings > 0 {
		status = "fail"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":     runID,
		"target":     run.Target,
		"run_status": run.Status,
		"status":     status,
		"findings":   findings,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/redteam/runs/{runID}", getReport)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"redteam/runs" // runs.ByID(ctx, runID), runs.Coverage(ctx, runID) — provided
)

type categoryCoverage struct {
	Category  string \`json:"category"\`
	Planned   int    \`json:"planned"\`
	Blocked   int    \`json:"blocked"\`
	Succeeded int    \`json:"succeeded"\`
	Missing   int    \`json:"missing"\`
}

type report struct {
	RunID             string             \`json:"run_id"\`
	Target            string             \`json:"target"\`
	RunStatus         string             \`json:"run_status"\`
	Status            string             \`json:"status"\`
	Findings          int                \`json:"findings"\`
	Coverage          []categoryCoverage \`json:"coverage"\`
	SkippedCategories []string           \`json:"skipped_categories"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func getReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runID")
	run, err := runs.ByID(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if run == nil || run.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}
	outcomes, err := runs.Coverage(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	out := report{RunID: runID, Target: run.Target, RunStatus: run.Status, Coverage: []categoryCoverage{}, SkippedCategories: []string{}}
	for _, entry := range run.Plan {
		counts := outcomes[entry.Category]
		item := categoryCoverage{Category: entry.Category, Planned: entry.Probes, Blocked: counts["blocked"], Succeeded: counts["succeeded"]}
		item.Missing = item.Planned - item.Blocked - item.Succeeded
		out.Coverage = append(out.Coverage, item)
		out.Findings += item.Succeeded
		if item.Missing > 0 {
			out.SkippedCategories = append(out.SkippedCategories, entry.Category)
		}
	}
	switch {
	case out.Findings > 0:
		out.Status = "fail"
	case len(out.SkippedCategories) > 0:
		out.Status = "incomplete"
	default:
		out.Status = "pass"
	}
	writeJSON(rw, http.StatusOK, out)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/redteam/runs/{runID}", getReport)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import redteam.Runs

object RedTeamReport {
  implicit val system: ActorSystem = ActorSystem("red-team-report")

  val route: Route =
    path("v1" / "redteam" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val row = Runs.byId(runId).get
            val findings = Runs.coverage(runId).values.map(_.getOrElse("succeeded", 0)).sum
            val report = ujson.Obj(
              "run_id" -> runId,
              "target" -> row.run.target,
              "run_status" -> row.run.status,
              "status" -> (if (findings == 0) "pass" else "fail"),
              "findings" -> findings
            )
            complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(report)))
          }
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import redteam.Runs

object RedTeamReport {
  implicit val system: ActorSystem = ActorSystem("red-team-report")

  val route: Route =
    path("v1" / "redteam" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Runs.byId(runId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"run not found"}""")
              case Some(row) =>
                val outcomes = Runs.coverage(runId)
                val coverage = row.run.plan.map { entry =>
                  val counts = outcomes.getOrElse(entry.category, Map.empty[String, Int])
                  val blocked = counts.getOrElse("blocked", 0)
                  val succeeded = counts.getOrElse("succeeded", 0)
                  (entry.category, entry.probes, blocked, succeeded, entry.probes - blocked - succeeded)
                }
                val skipped = coverage.filter(_._5 > 0).map(_._1)
                val findings = coverage.map(_._4).sum
                val status = if (findings > 0) "fail" else if (skipped.nonEmpty) "incomplete" else "pass"
                val report = ujson.Obj(
                  "run_id" -> runId,
                  "target" -> row.run.target,
                  "run_status" -> row.run.status,
                  "status" -> status,
                  "findings" -> findings,
                  "coverage" -> ujson.Arr.from(coverage.map { case (category, planned, blocked, succeeded, missing) =>
                    ujson.Obj("category" -> category, "planned" -> planned, "blocked" -> blocked, "succeeded" -> succeeded, "missing" -> missing)
                  }),
                  "skipped_categories" -> ujson.Arr.from(skipped.map(ujson.Str(_)))
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(report)))
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

#include "redteam/runs.h"  // runs::by_id(run_id), runs::coverage(run_id) — provided

using json = nlohmann::json;

void get_report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string run_id = req.matches[1].str();
  const json run = runs::by_id(run_id).value_or(json::object());
  long long findings = 0;
  for (const auto& [category, counts] : runs::coverage(run_id)) {
    const auto it = counts.find("succeeded");
    if (it != counts.end()) findings += it->second;
  }
  const json report = {
      {"run_id", run_id},
      {"target", run.value("target", "")},
      {"run_status", run.value("status", "")},
      {"status", findings == 0 ? "pass" : "fail"},
      {"findings", findings},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/redteam/runs/([^/]+))", get_report); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "redteam/runs.h"  // runs::by_id(run_id), runs::coverage(run_id) — provided

using json = nlohmann::json;

long long outcome_count(const std::map<std::string, long long>& counts, const std::string& outcome) {
  const auto it = counts.find(outcome);
  return it == counts.end() ? 0 : it->second;
}

void get_report(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string run_id = req.matches[1].str();
  const auto run = runs::by_id(run_id);
  if (!run || run->value("tenant", "") != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"run not found"})", "application/json");
    return;
  }
  const auto outcomes = runs::coverage(run_id);
  json coverage = json::array();
  json skipped = json::array();
  long long findings = 0;
  for (const auto& entry : (*run)["plan"]) {
    const std::string category = entry["category"].get<std::string>();
    const long long planned = entry["probes"].get<long long>();
    const auto counts = outcomes.count(category) > 0 ? outcomes.at(category) : std::map<std::string, long long>{};
    const long long blocked = outcome_count(counts, "blocked");
    const long long succeeded = outcome_count(counts, "succeeded");
    const long long missing = planned - blocked - succeeded;
    coverage.push_back({{"category", category}, {"planned", planned}, {"blocked", blocked}, {"succeeded", succeeded}, {"missing", missing}});
    findings += succeeded;
    if (missing > 0) skipped.push_back(category);
  }
  const std::string status = findings > 0 ? "fail" : (!skipped.empty() ? "incomplete" : "pass");
  const json report = {
      {"run_id", run_id},
      {"target", run->value("target", "")},
      {"run_status", run->value("status", "")},
      {"status", status},
      {"findings", findings},
      {"coverage", coverage},
      {"skipped_categories", skipped},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/redteam/runs/([^/]+))", get_report); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

PLAN = [{"category": "prompt-injection", "probes": 4}, {"category": "jailbreak", "probes": 3}, {"category": "data-exfil", "probes": 3}]
ALL_BLOCKED = {"prompt-injection:blocked": 4, "jailbreak:blocked": 3, "data-exfil:blocked": 3}


def _seed(ctx, run_id, outcomes, tenant="t1", status="complete"):
    row = {"run_id": run_id, "status": status, "target": "checkout-shadow", "endpoint": "checkout-shadow.sandbox.internal", "probe_set": "baseline", "plan": PLAN, "probes": 10, "tenant": tenant, "resume_at": None}
    ctx.redis.set(f"redteam:run:{run_id}", json.dumps(row))
    for field, n in outcomes.items():
        ctx.redis.hset(f"redteam:coverage:{run_id}", field, n)


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, run_id, tenant="t1"):
    return await c.get(f"/v1/redteam/runs/{run_id}", headers={"X-Tenant-Id": tenant})


async def check_route_get(ctx):
    _seed(ctx, "run-1", ALL_BLOCKED)
    _seed(ctx, "run-2", {**ALL_BLOCKED, "jailbreak:blocked": 2, "jailbreak:succeeded": 1})
    async with _api(ctx) as c:
        r = await _get(c, "run-1")
        assert r.status_code == 200, f"the report answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("run_id") == "run-1" and body.get("target") == "checkout-shadow" and body.get("run_status") == "complete", f"the report names the run, its target and its status: {body}"
        assert body.get("status") == "pass" and body.get("findings") == 0, f"every planned probe was blocked: pass with 0 findings, got {body}"
        body = (await _get(c, "run-2")).json()
        assert body.get("status") == "fail" and body.get("findings") == 1, f"one probe got through: fail with 1 finding, got {body}"
        r = await c.get("/v1/redteam/runs/run-1")
        assert r.status_code == 401, f"without X-Tenant-Id the report must answer 401, got {r.status_code}"


async def check_coverage_by_category(ctx):
    _seed(ctx, "run-1", {"prompt-injection:blocked": 3, "prompt-injection:succeeded": 1, "jailbreak:blocked": 3, "data-exfil:blocked": 2, "data-exfil:timeout": 1})
    async with _api(ctx) as c:
        body = (await _get(c, "run-1")).json()
    expected = [
        {"category": "prompt-injection", "planned": 4, "blocked": 3, "succeeded": 1, "missing": 0},
        {"category": "jailbreak", "planned": 3, "blocked": 3, "succeeded": 0, "missing": 0},
        {"category": "data-exfil", "planned": 3, "blocked": 2, "succeeded": 0, "missing": 1},
    ]
    assert body.get("coverage") == expected, f"coverage must list every planned category in plan order with planned, blocked, succeeded, missing (a timeout has no verdict): expected {expected}, got {body.get('coverage')}"


async def check_skipped_visible(ctx):
    _seed(ctx, "run-1", {"prompt-injection:blocked": 4, "jailbreak:blocked": 1}, status="aborted")
    async with _api(ctx) as c:
        body = (await _get(c, "run-1")).json()
    assert body.get("skipped_categories") == ["jailbreak", "data-exfil"], f"the kill switch stopped the run in jailbreak: skipped_categories must be ['jailbreak', 'data-exfil'], got {body.get('skipped_categories')!r}"
    rows = {item.get("category"): item for item in body.get("coverage") or []}
    assert rows.get("data-exfil", {}).get("missing") == 3, f"a category that never ran is still in coverage, all of it missing: {body.get('coverage')}"


async def check_incomplete_not_pass(ctx):
    _seed(ctx, "run-1", {"prompt-injection:blocked": 4, "jailbreak:blocked": 1}, status="aborted")
    _seed(ctx, "run-2", {**ALL_BLOCKED, "data-exfil:blocked": 2, "data-exfil:timeout": 1})
    _seed(ctx, "run-3", {"prompt-injection:blocked": 3, "prompt-injection:succeeded": 1}, status="aborted")
    async with _api(ctx) as c:
        aborted = (await _get(c, "run-1")).json()
        assert aborted.get("status") == "incomplete", f"an aborted run with two categories untested reported {aborted.get('status')!r}: nothing succeeded because most of it never ran. Expected incomplete"
        timed_out = (await _get(c, "run-2")).json()
        assert timed_out.get("status") == "incomplete", f"a probe that timed out has no verdict: the run is incomplete, got {timed_out.get('status')!r}"
        found = (await _get(c, "run-3")).json()
        assert found.get("status") == "fail", f"a probe that got through is a fail even when coverage is incomplete, got {found.get('status')!r}"


async def check_tenant_scoped_read(ctx):
    _seed(ctx, "run-1", ALL_BLOCKED, tenant="t1")
    async with _api(ctx) as c:
        r = await _get(c, "run-1", tenant="t2")
        assert r.status_code == 404, f"tenant t2 read t1's run and got {r.status_code}: another tenant's run must be 404, like a run that does not exist"
        assert "checkout-shadow" not in r.text, f"the 404 must not leak the run: {r.text}"
        r = await _get(c, "run-404")
        assert r.status_code == 404, f"a run that does not exist answered {r.status_code}, expected 404"
`,
    typescript: `const PLAN = [{category: 'prompt-injection', probes: 4}, {category: 'jailbreak', probes: 3}, {category: 'data-exfil', probes: 3}];
const ALL_BLOCKED = {'prompt-injection:blocked': 4, 'jailbreak:blocked': 3, 'data-exfil:blocked': 3};

function seed(ctx, runId: string, outcomes: Record<string, number>, {tenant = 't1', status = 'complete'} = {}) {
  const row = {run_id: runId, status, target: 'checkout-shadow', endpoint: 'checkout-shadow.sandbox.internal', probe_set: 'baseline', plan: PLAN, probes: 10, tenant, resume_at: null};
  ctx.redis.set(\`redteam:run:\${runId}\`, JSON.stringify(row));
  for (const [field, n] of Object.entries(outcomes)) ctx.redis.hset(\`redteam:coverage:\${runId}\`, field, n);
}

const api = ctx => ctx.client(ctx.load('read').app);
const get = (c, runId: string, tenant = 't1') => c.get(\`/v1/redteam/runs/\${runId}\`, {headers: {'X-Tenant-Id': tenant}});

export async function check_route_get(ctx) {
  seed(ctx, 'run-1', ALL_BLOCKED);
  seed(ctx, 'run-2', {...ALL_BLOCKED, 'jailbreak:blocked': 2, 'jailbreak:succeeded': 1});
  const c = api(ctx);
  const r = await get(c, 'run-1');
  assert.equal(r.status, 200, \`the report answered \${r.status}: \${r.text}\`);
  let body = r.json();
  assert(body.run_id === 'run-1' && body.target === 'checkout-shadow' && body.run_status === 'complete', \`the report names the run, its target and its status: \${r.text}\`);
  assert(body.status === 'pass' && body.findings === 0, \`every planned probe was blocked: pass with 0 findings, got \${r.text}\`);
  body = (await get(c, 'run-2')).json();
  assert(body.status === 'fail' && body.findings === 1, \`one probe got through: fail with 1 finding, got \${JSON.stringify(body)}\`);
  const noTenant = await c.get('/v1/redteam/runs/run-1');
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the report must answer 401, got \${noTenant.status}\`);
}

export async function check_coverage_by_category(ctx) {
  seed(ctx, 'run-1', {'prompt-injection:blocked': 3, 'prompt-injection:succeeded': 1, 'jailbreak:blocked': 3, 'data-exfil:blocked': 2, 'data-exfil:timeout': 1});
  const body = (await get(api(ctx), 'run-1')).json();
  const expected = [
    {category: 'prompt-injection', planned: 4, blocked: 3, succeeded: 1, missing: 0},
    {category: 'jailbreak', planned: 3, blocked: 3, succeeded: 0, missing: 0},
    {category: 'data-exfil', planned: 3, blocked: 2, succeeded: 0, missing: 1},
  ];
  assert.deepEqual(body.coverage, expected, \`coverage must list every planned category in plan order with planned, blocked, succeeded, missing (a timeout has no verdict): got \${JSON.stringify(body.coverage)}\`);
}

export async function check_skipped_visible(ctx) {
  seed(ctx, 'run-1', {'prompt-injection:blocked': 4, 'jailbreak:blocked': 1}, {status: 'aborted'});
  const body = (await get(api(ctx), 'run-1')).json();
  assert.deepEqual(body.skipped_categories, ['jailbreak', 'data-exfil'], \`the kill switch stopped the run in jailbreak: skipped_categories must be ["jailbreak","data-exfil"], got \${JSON.stringify(body.skipped_categories)}\`);
  const exfil = (body.coverage ?? []).find(item => item.category === 'data-exfil');
  assert.equal(exfil?.missing, 3, \`a category that never ran is still in coverage, all of it missing: \${JSON.stringify(body.coverage)}\`);
}

export async function check_incomplete_not_pass(ctx) {
  seed(ctx, 'run-1', {'prompt-injection:blocked': 4, 'jailbreak:blocked': 1}, {status: 'aborted'});
  seed(ctx, 'run-2', {...ALL_BLOCKED, 'data-exfil:blocked': 2, 'data-exfil:timeout': 1});
  seed(ctx, 'run-3', {'prompt-injection:blocked': 3, 'prompt-injection:succeeded': 1}, {status: 'aborted'});
  const c = api(ctx);
  const aborted = (await get(c, 'run-1')).json();
  assert.equal(aborted.status, 'incomplete', \`an aborted run with two categories untested reported \${JSON.stringify(aborted.status)}: nothing succeeded because most of it never ran. Expected incomplete\`);
  const timedOut = (await get(c, 'run-2')).json();
  assert.equal(timedOut.status, 'incomplete', \`a probe that timed out has no verdict: the run is incomplete, got \${JSON.stringify(timedOut.status)}\`);
  const found = (await get(c, 'run-3')).json();
  assert.equal(found.status, 'fail', \`a probe that got through is a fail even when coverage is incomplete, got \${JSON.stringify(found.status)}\`);
}

export async function check_tenant_scoped_read(ctx) {
  seed(ctx, 'run-1', ALL_BLOCKED, {tenant: 't1'});
  const c = api(ctx);
  let r = await get(c, 'run-1', 't2');
  assert.equal(r.status, 404, \`tenant t2 read t1's run and got \${r.status}: another tenant's run must be 404, like a run that does not exist\`);
  assert(!r.text.includes('checkout-shadow'), \`the 404 must not leak the run: \${r.text}\`);
  r = await get(c, 'run-404');
  assert.equal(r.status, 404, \`a run that does not exist answered \${r.status}, expected 404\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"leetbuild/harness"
)

var readPlan = []map[string]any{{"category": "prompt-injection", "probes": 4}, {"category": "jailbreak", "probes": 3}, {"category": "data-exfil", "probes": 3}}
var readAllBlocked = map[string]int{"prompt-injection:blocked": 4, "jailbreak:blocked": 3, "data-exfil:blocked": 3}

func readSeed(ctx *harness.Ctx, runID string, outcomes map[string]int, tenant, status string) {
	row, _ := json.Marshal(map[string]any{"run_id": runID, "status": status, "target": "checkout-shadow", "endpoint": "checkout-shadow.sandbox.internal", "probe_set": "baseline", "plan": readPlan, "probes": 10, "tenant": tenant})
	ctx.Redis.Set("redteam:run:"+runID, string(row))
	for field, n := range outcomes {
		ctx.Redis.Do("HSET", "redteam:coverage:"+runID, field, n)
	}
}

func readWith(base map[string]int, extra map[string]int) map[string]int {
	out := map[string]int{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, c *harness.HTTP, runID string) map[string]any {
	r := c.Get("/v1/redteam/runs/"+runID, "X-Tenant-Id", "t1")
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the report must be a JSON object (%d): %s", r.Status, r.Text())
	return body
}

func CheckRouteGet(ctx *harness.Ctx) {
	readSeed(ctx, "run-1", readAllBlocked, "t1", "complete")
	readSeed(ctx, "run-2", readWith(readAllBlocked, map[string]int{"jailbreak:blocked": 2, "jailbreak:succeeded": 1}), "t1", "complete")
	c := readClient(ctx)
	r := c.Get("/v1/redteam/runs/run-1", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "the report (%s)", r.Text())
	body := readBody(ctx, c, "run-1")
	ctx.Assert(body["run_id"] == "run-1" && body["target"] == "checkout-shadow" && body["run_status"] == "complete", "the report names the run, its target and its status: %v", body)
	ctx.Assert(body["status"] == "pass" && body["findings"] == float64(0), "every planned probe was blocked: pass with 0 findings, got %v", body)
	body = readBody(ctx, c, "run-2")
	ctx.Assert(body["status"] == "fail" && body["findings"] == float64(1), "one probe got through: fail with 1 finding, got %v", body)
	ctx.Equal(c.Get("/v1/redteam/runs/run-1").Status, 401, "without X-Tenant-Id the report")
}

func CheckCoverageByCategory(ctx *harness.Ctx) {
	readSeed(ctx, "run-1", map[string]int{"prompt-injection:blocked": 3, "prompt-injection:succeeded": 1, "jailbreak:blocked": 3, "data-exfil:blocked": 2, "data-exfil:timeout": 1}, "t1", "complete")
	body := readBody(ctx, readClient(ctx), "run-1")
	expected := []any{
		map[string]any{"category": "prompt-injection", "planned": float64(4), "blocked": float64(3), "succeeded": float64(1), "missing": float64(0)},
		map[string]any{"category": "jailbreak", "planned": float64(3), "blocked": float64(3), "succeeded": float64(0), "missing": float64(0)},
		map[string]any{"category": "data-exfil", "planned": float64(3), "blocked": float64(2), "succeeded": float64(0), "missing": float64(1)},
	}
	ctx.Equal(body["coverage"], expected, "coverage must list every planned category in plan order with planned, blocked, succeeded, missing (a timeout has no verdict)")
}

func CheckSkippedVisible(ctx *harness.Ctx) {
	readSeed(ctx, "run-1", map[string]int{"prompt-injection:blocked": 4, "jailbreak:blocked": 1}, "t1", "aborted")
	body := readBody(ctx, readClient(ctx), "run-1")
	ctx.Equal(body["skipped_categories"], []any{"jailbreak", "data-exfil"}, "the kill switch stopped the run in jailbreak; skipped_categories")
	missing := any(nil)
	items, _ := body["coverage"].([]any)
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["category"] == "data-exfil" {
			missing = row["missing"]
		}
	}
	ctx.Equal(missing, float64(3), "a category that never ran is still in coverage, all of it missing (%v); data-exfil missing", body["coverage"])
}

func CheckIncompleteNotPass(ctx *harness.Ctx) {
	readSeed(ctx, "run-1", map[string]int{"prompt-injection:blocked": 4, "jailbreak:blocked": 1}, "t1", "aborted")
	readSeed(ctx, "run-2", readWith(readAllBlocked, map[string]int{"data-exfil:blocked": 2, "data-exfil:timeout": 1}), "t1", "complete")
	readSeed(ctx, "run-3", map[string]int{"prompt-injection:blocked": 3, "prompt-injection:succeeded": 1}, "t1", "aborted")
	c := readClient(ctx)
	ctx.Equal(readBody(ctx, c, "run-1")["status"], "incomplete", "an aborted run with two categories untested: nothing succeeded because most of it never ran; the status")
	ctx.Equal(readBody(ctx, c, "run-2")["status"], "incomplete", "a probe that timed out has no verdict; the status")
	ctx.Equal(readBody(ctx, c, "run-3")["status"], "fail", "a probe that got through is a fail even when coverage is incomplete; the status")
}

func CheckTenantScopedRead(ctx *harness.Ctx) {
	readSeed(ctx, "run-1", readAllBlocked, "t1", "complete")
	c := readClient(ctx)
	r := c.Get("/v1/redteam/runs/run-1", "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "tenant t2 read t1's run: another tenant's run must be 404, like a run that does not exist")
	ctx.Assert(!strings.Contains(r.Text(), "checkout-shadow"), "the 404 must not leak the run: %s", r.Text())
	ctx.Equal(c.Get("/v1/redteam/runs/run-404", "X-Tenant-Id", "t1").Status, 404, "a run that does not exist")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>

namespace {

using json = nlohmann::json;

const json kPlan = json::array({{{"category", "prompt-injection"}, {"probes", 4}}, {{"category", "jailbreak"}, {"probes", 3}}, {{"category", "data-exfil"}, {"probes", 3}}});
const std::map<std::string, int> kAllBlocked = {{"prompt-injection:blocked", 4}, {"jailbreak:blocked", 3}, {"data-exfil:blocked", 3}};

void seed(harness::Ctx& ctx, const std::string& run_id, const std::map<std::string, int>& outcomes, const std::string& tenant = "t1", const std::string& status = "complete") {
  const json row = {{"run_id", run_id}, {"status", status}, {"target", "checkout-shadow"}, {"endpoint", "checkout-shadow.sandbox.internal"}, {"probe_set", "baseline"}, {"plan", kPlan}, {"probes", 10}, {"tenant", tenant}, {"resume_at", nullptr}};
  ctx.Redis.Set("redteam:run:" + run_id, row.dump());
  for (const auto& [field, n] : outcomes) ctx.Redis.Do("HSET", "redteam:coverage:" + run_id, field, n);
}

std::map<std::string, int> with(std::map<std::string, int> base, const std::map<std::string, int>& extra) {
  for (const auto& [k, v] : extra) base[k] = v;
  return base;
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response get(const std::string& run_id, const std::string& tenant = "t1") { return http.Get("/v1/redteam/runs/" + run_id, "X-Tenant-Id", tenant); }

  json body(harness::Ctx& ctx, const std::string& run_id) {
    const auto r = get(run_id);
    const json out = json::parse(r.Text(), nullptr, false);
    ctx.Assert(out.is_object(), "the report must be a JSON object (%d): %s", r.Status, r.Text());
    return out;
  }
};

}  // namespace

void CheckRouteGet(harness::Ctx& ctx) {
  seed(ctx, "run-1", kAllBlocked);
  seed(ctx, "run-2", with(kAllBlocked, {{"jailbreak:blocked", 2}, {"jailbreak:succeeded", 1}}));
  Api api(ctx);
  const auto r = api.get("run-1");
  ctx.Equal(r.Status, 200, "the report (%s)", r.Text());
  json body = api.body(ctx, "run-1");
  ctx.Assert(body.value("run_id", "") == "run-1" && body.value("target", "") == "checkout-shadow" && body.value("run_status", "") == "complete", "the report names the run, its target and its status: %s", body.dump());
  ctx.Assert(body.value("status", "") == "pass" && body.value("findings", -1) == 0, "every planned probe was blocked: pass with 0 findings, got %s", body.dump());
  body = api.body(ctx, "run-2");
  ctx.Assert(body.value("status", "") == "fail" && body.value("findings", -1) == 1, "one probe got through: fail with 1 finding, got %s", body.dump());
  ctx.Equal(api.http.Get("/v1/redteam/runs/run-1").Status, 401, "without X-Tenant-Id the report");
}

void CheckCoverageByCategory(harness::Ctx& ctx) {
  seed(ctx, "run-1", {{"prompt-injection:blocked", 3}, {"prompt-injection:succeeded", 1}, {"jailbreak:blocked", 3}, {"data-exfil:blocked", 2}, {"data-exfil:timeout", 1}});
  Api api(ctx);
  const json body = api.body(ctx, "run-1");
  const json expected = json::array({
      {{"category", "prompt-injection"}, {"planned", 4}, {"blocked", 3}, {"succeeded", 1}, {"missing", 0}},
      {{"category", "jailbreak"}, {"planned", 3}, {"blocked", 3}, {"succeeded", 0}, {"missing", 0}},
      {{"category", "data-exfil"}, {"planned", 3}, {"blocked", 2}, {"succeeded", 0}, {"missing", 1}},
  });
  ctx.Assert(body.contains("coverage") && body["coverage"] == expected, "coverage must list every planned category in plan order with planned, blocked, succeeded, missing (a timeout has no verdict): expected %s, got %s", expected.dump(), body.value("coverage", json()).dump());
}

void CheckSkippedVisible(harness::Ctx& ctx) {
  seed(ctx, "run-1", {{"prompt-injection:blocked", 4}, {"jailbreak:blocked", 1}}, "t1", "aborted");
  Api api(ctx);
  const json body = api.body(ctx, "run-1");
  ctx.Assert(body.contains("skipped_categories") && body["skipped_categories"] == json::array({"jailbreak", "data-exfil"}), "the kill switch stopped the run in jailbreak: skipped_categories must be [jailbreak, data-exfil], got %s", body.value("skipped_categories", json()).dump());
  long long missing = -1;
  for (const auto& item : body.value("coverage", json::array())) {
    if (item.value("category", "") == "data-exfil") missing = item.value("missing", -1LL);
  }
  ctx.Equal(missing, 3, "a category that never ran is still in coverage, all of it missing (%s); data-exfil missing", body.value("coverage", json()).dump());
}

void CheckIncompleteNotPass(harness::Ctx& ctx) {
  seed(ctx, "run-1", {{"prompt-injection:blocked", 4}, {"jailbreak:blocked", 1}}, "t1", "aborted");
  seed(ctx, "run-2", with(kAllBlocked, {{"data-exfil:blocked", 2}, {"data-exfil:timeout", 1}}));
  seed(ctx, "run-3", {{"prompt-injection:blocked", 3}, {"prompt-injection:succeeded", 1}}, "t1", "aborted");
  Api api(ctx);
  ctx.Equal(api.body(ctx, "run-1").value("status", ""), "incomplete", "an aborted run with two categories untested: nothing succeeded because most of it never ran; the status");
  ctx.Equal(api.body(ctx, "run-2").value("status", ""), "incomplete", "a probe that timed out has no verdict; the status");
  ctx.Equal(api.body(ctx, "run-3").value("status", ""), "fail", "a probe that got through is a fail even when coverage is incomplete; the status");
}

void CheckTenantScopedRead(harness::Ctx& ctx) {
  seed(ctx, "run-1", kAllBlocked, "t1");
  Api api(ctx);
  const auto r = api.get("run-1", "t2");
  ctx.Equal(r.Status, 404, "tenant t2 read t1's run: another tenant's run must be 404, like a run that does not exist");
  ctx.Assert(r.Text().find("checkout-shadow") == std::string::npos, "the 404 must not leak the run: %s", r.Text());
  ctx.Equal(api.get("run-404").Status, 404, "a run that does not exist");
}
`,
  },
  hints: [
    'Symptom: a release manager approves a deploy on a green report for a run the kill switch stopped after one category, and anyone who knows a run id can read another tenant’s report.',
    'Mechanism: `status` comes from the succeeded count alone, and a category that did not run has no successes, so it looks like a category that blocked everything; the row’s tenant is not compared with the caller’s.',
    'Change: 404 when the row is missing or `run["tenant"]` differs; for each `plan` entry compute blocked, succeeded and `missing = probes - blocked - succeeded`; list `missing > 0` in `skipped_categories`; `fail` on any success, else `incomplete` while any category is skipped.',
  ],
  debrief: `A red-team report is trusted most when a run was cut short, so the verdict is built from coverage rather than from findings: no number of quiet categories proves that an untested one is safe. Counting \`missing\` from the plan, not from what was recorded, is what makes a category that did not run visible at all, and treating a timeout as missing keeps a hung target from reading as a defended one. A success still fails the run outright, because one leak is enough to block a release. The tenant check answers a foreign run exactly like a missing one. garak's report takes the same stance, recording an attempt that was not sent with a status of its own; platforms that gate releases on such reports also pin the probe-set version into the run, so two passes are comparable.`,
};
