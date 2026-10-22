import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/redteam/runs/{id}: coverage that matters',
  concept: 'http',
  file: 'read',
  focus: ['client', 'runner', 'db', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: it reads a run, counts the critical findings, and
answers green when there are none. It also answers for runs that belong to someone else, and it
quietly drops the categories that were never probed. Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/redteam/runs/{id}\`:

- The run is **tenant-scoped**: a run that belongs to another tenant is **404**, exactly like a run
  that does not exist. The draft returns any run to any caller.
- The report returns **coverage per category**, each with \`blocked\` and \`succeeded\` probe counts
  and an \`unfixed\` finding count, so a reader can see which categories actually ran.
- A category skipped because the kill switch fired is reported as \`skipped\` (an **incomplete**
  category, not a passing one) and the report carries a warning naming the kill switch. The draft
  hides skipped categories, so a run that covered two of five categories looks complete.
- The run **cannot report \`pass\` while any category is skipped**: the status is \`incomplete\` in
  that case, however few findings were raised. Only a run with complete coverage and no unfixed
  findings is a pass.

**Failure mode the checks target.** The loud one is honesty about coverage: a red-team report that
says pass, when a kill switch aborted two categories, is the report that lets a release ship with
untested attack surface. The quiet one is tenant scoping: a report endpoint that answers by id
alone leaks another tenant's findings, their probe ids and their evidence references.`,
  sequence: {
    participants: ['Reviewer', 'Red Team Runner', 'run store', 'Redis'],
    messages: [
      {from: 'Reviewer', to: 'Red Team Runner', label: 'GET /v1/redteam/runs/run-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'Red Team Runner', to: 'run store', label: 'get(run-7) · tenant match', kind: 'sync'},
      {from: 'run store', to: 'Red Team Runner', label: 'run + skipped categories', kind: 'reply'},
      {from: 'Red Team Runner', to: 'Redis', label: 'GET redteam:kill:{target}', kind: 'sync'},
      {from: 'Redis', to: 'Red Team Runner', label: '1 — abort recorded', kind: 'reply'},
      {from: 'Red Team Runner', to: 'Reviewer', label: '200 {status: incomplete, coverage[]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route-get',
      title: 'Handles GET /v1/redteam/runs/{id}',
      detail: 'Register the report route on `GET /v1/redteam/runs/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/redteam\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/redteam\/runs\/:runId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/redteam\/runs\/\{runID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"redteam"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/redteam\/runs\//]},
      },
    },
    {
      id: 'coverage-by-category',
      title: 'Reports coverage per category',
      detail:
        'The report carries a `coverage` list with `blocked` and `succeeded` probe counts and an `unfixed` finding count per category. The draft returns one critical count and nothing about coverage.',
      match: {
        python: {all: [/coverage/, /blocked/, /succeeded/, /unfixed/]},
        typescript: {all: [/coverage/, /blocked/, /succeeded/, /unfixed/]},
        go: {all: [/Coverage/, /Blocked/, /Succeeded/, /Unfixed/]},
        scala: {all: [/coverage/, /blocked/, /succeeded/, /unfixed/]},
        cpp: {all: [/coverage/, /blocked/, /succeeded/, /unfixed/]},
      },
    },
    {
      id: 'skipped-visible',
      title: 'Surfaces skipped categories with a warning',
      detail:
        'A category skipped because the kill switch fired is marked `skipped` and the report warns with the reason. The draft drops skipped categories from the response entirely.',
      match: {
        python: {all: [/skipped/, /kill switch fired/]},
        typescript: {all: [/skipped/, /kill switch fired/]},
        go: {all: [/Skipped/, /kill switch fired/]},
        scala: {all: [/skipped/, /kill switch fired/]},
        cpp: {all: [/skipped/, /kill switch fired/]},
      },
    },
    {
      id: 'incomplete-not-pass',
      title: 'Refuses to report pass when a category was skipped',
      detail:
        'The status is `incomplete` whenever `skipped_categories` is non-empty, regardless of how few findings there are. The draft reports `pass` as soon as no critical finding exists.',
      match: {
        python: {all: [/skipped_categories/, /"incomplete"/]},
        typescript: {all: [/skippedCategories/, /'incomplete'/]},
        go: {all: [/skippedCategories/, /"incomplete"/]},
        scala: {all: [/skippedCategories/, /"incomplete"/]},
        cpp: {all: [/skipped_categories/, /"incomplete"/]},
      },
    },
    {
      id: 'tenant-scoped-read',
      title: 'Serves only the caller’s runs',
      detail:
        'The run is loaded and compared against the caller’s tenant; a foreign run is **404**, the same answer as a missing one. The draft loads by id and answers for any tenant.',
      match: {
        python: {all: [/tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/tenant/, /StatusNotFound/]},
        scala: {all: [/tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header

app = FastAPI()


@app.get("/v1/redteam/runs/{run_id}")
def get_run(run_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft answers any caller who knows a run id, reports pass as soon as there is no
    # critical finding, and drops the categories a kill switch skipped. Scope the run to the tenant
    # with a 404, report coverage per category, and make a run with skipped categories incomplete.
    run = run_store.get(run_id)
    findings = finding_store.list(run_id)
    critical = [f for f in findings if f["severity"] == "critical"]
    return {
        "run_id": run_id,
        "tenant": tenant,
        "target": run["target"],
        "status": "pass" if not critical else "fail",
        "critical": len(critical),
    }
`,
      solution: `from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

KILL_SWITCH_WARNING = "kill switch fired"


def coverage_for(run: dict, findings: list[dict]) -> list[dict]:
    """Per category: what ran, what was blocked, what is still unfixed."""
    coverage = []
    for category in run["categories"]:
        category_findings = [f for f in findings if f["category"] == category]
        coverage.append(
            {
                "category": category,
                "blocked": sum(1 for f in category_findings if f["blocked"]),
                "succeeded": sum(1 for f in category_findings if not f["blocked"]),
                "unfixed": sum(1 for f in category_findings if not f["fixed"]),
                "skipped": category in run["skipped_categories"],
            }
        )
    return coverage


def load_run(run_id: str, tenant: str) -> dict:
    """The caller's run, or a 404: a foreign run is indistinguishable from a missing one."""
    run = run_store.get(run_id)
    if run is None or run["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@app.get("/v1/redteam/runs/{run_id}")
def get_run(run_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    run = load_run(run_id, tenant)
    coverage = coverage_for(run, finding_store.list(run_id))
    skipped_categories = [c["category"] for c in coverage if c["skipped"]]
    unfixed = sum(c["unfixed"] for c in coverage)
    warnings = [f"category {name} skipped: {KILL_SWITCH_WARNING}" for name in skipped_categories]
    return {
        "run_id": run_id,
        "tenant": tenant,
        "target": run["target"],
        "status": "incomplete" if skipped_categories else ("pass" if unfixed == 0 else "fail"),
        "coverage": coverage,
        "unfixed_findings": unfixed,
        "warnings": warnings,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/redteam/runs/:runId: a model-generated draft that answers green by default. */
import Fastify from 'fastify';

export const app = Fastify();

interface Finding {
  category: string;
  severity: string;
}

app.get('/v1/redteam/runs/:runId', async (request, reply) => {
  // TODO: this draft answers any caller who knows a run id, reports pass as soon as there is no
  // critical finding, and drops the categories a kill switch skipped. Scope the run to the tenant
  // with a 404, report coverage per category, and make a run with skipped categories incomplete.
  const {runId} = request.params as {runId: string};
  const tenant = request.headers['x-tenant-id'] as string;
  const run = await runStore.get(runId);
  const findings = await findingStore.list(runId);
  const critical = findings.filter(finding => finding.severity === 'critical');
  return reply.code(200).send({
    run_id: runId,
    tenant,
    target: run.target,
    status: critical.length === 0 ? 'pass' : 'fail',
    critical: critical.length,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/redteam/runs/:runId: honest coverage, scoped to the caller's tenant. */
import Fastify from 'fastify';

import {findingStore, runStore} from './runs';

export const app = Fastify();

const KILL_SWITCH_WARNING = 'kill switch fired';

interface Finding {
  category: string;
  blocked: boolean;
  fixed: boolean;
}

interface Coverage {
  category: string;
  blocked: number;
  succeeded: number;
  unfixed: number;
  skipped: boolean;
}

export function coverageFor(run: RunRecord, findings: Finding[]): Coverage[] {
  return run.categories.map(category => {
    const categoryFindings = findings.filter(finding => finding.category === category);
    return {
      category,
      blocked: categoryFindings.filter(finding => finding.blocked).length,
      succeeded: categoryFindings.filter(finding => !finding.blocked).length,
      unfixed: categoryFindings.filter(finding => !finding.fixed).length,
      skipped: run.skipped_categories.includes(category),
    };
  });
}

/** The caller's run, or a 404: a foreign run is indistinguishable from a missing one. */
export async function loadRun(runId: string, tenant: string): Promise<RunRecord | null> {
  const run = await runStore.get(runId);
  if (run === null || run.tenant !== tenant) return null;
  return run;
}

app.get('/v1/redteam/runs/:runId', async (request, reply) => {
  const {runId} = request.params as {runId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const run = await loadRun(runId, tenant);
  if (run === null) return reply.code(404).send({error: 'run not found'});

  const coverage = coverageFor(run, await findingStore.list(runId));
  const skippedCategories = coverage.filter(entry => entry.skipped).map(entry => entry.category);
  const unfixed = coverage.reduce((total, entry) => total + entry.unfixed, 0);
  return reply.code(200).send({
    run_id: runId,
    tenant,
    target: run.target,
    status: skippedCategories.length > 0 ? 'incomplete' : unfixed === 0 ? 'pass' : 'fail',
    coverage,
    unfixed_findings: unfixed,
    warnings: skippedCategories.map(name => \`category \${name} skipped: \${KILL_SWITCH_WARNING}\`),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Finding struct {
	Category string \`json:"category"\`
	Severity string \`json:"severity"\`
}

func getRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft answers any caller who knows a run id, reports pass as soon as there is no
	// critical finding, and drops the categories a kill switch skipped. Scope the run to the tenant
	// with a 404, report coverage per category, and make a run with skipped categories incomplete.
	runID := r.PathValue("runID")
	tenant := r.Header.Get("X-Tenant-Id")
	run, _ := runStore.Get(r.Context(), runID)
	findings, _ := findingStore.List(r.Context(), runID)
	critical := 0
	for _, finding := range findings {
		if finding.Severity == "critical" {
			critical++
		}
	}
	status := "pass"
	if critical > 0 {
		status = "fail"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":   runID,
		"tenant":   tenant,
		"target":   run.Target,
		"status":   status,
		"critical": critical,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/redteam/runs/{runID}", getRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const killSwitchWarning = "kill switch fired"

type Finding struct {
	Category string \`json:"category"\`
	Severity string \`json:"severity"\`
	Blocked  bool   \`json:"blocked"\`
	Fixed    bool   \`json:"fixed"\`
}

type Coverage struct {
	Category  string \`json:"category"\`
	Blocked   int    \`json:"blocked"\`
	Succeeded int    \`json:"succeeded"\`
	Unfixed   int    \`json:"unfixed"\`
	Skipped   bool   \`json:"skipped"\`
}

func skippedSet(run RunRecord) map[string]bool {
	skipped := map[string]bool{}
	for _, category := range run.SkippedCategories {
		skipped[category] = true
	}
	return skipped
}

func coverageFor(run RunRecord, findings []Finding) []Coverage {
	skipped := skippedSet(run)
	coverage := make([]Coverage, 0, len(run.Categories))
	for _, category := range run.Categories {
		entry := Coverage{Category: category, Skipped: skipped[category]}
		for _, finding := range findings {
			if finding.Category != category {
				continue
			}
			if finding.Blocked {
				entry.Blocked++
			} else {
				entry.Succeeded++
			}
			if !finding.Fixed {
				entry.Unfixed++
			}
		}
		coverage = append(coverage, entry)
	}
	return coverage
}

// loadRun answers only for the caller's tenant: a foreign run is indistinguishable from a missing one.
func loadRun(ctx context.Context, runID, tenant string) (RunRecord, bool) {
	run, err := runStore.Get(ctx, runID)
	if err != nil || run.Tenant != tenant {
		return RunRecord{}, false
	}
	return run, true
}

func getRun(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("runID")
	tenant := r.Header.Get("X-Tenant-Id")
	run, ok := loadRun(r.Context(), runID, tenant)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}
	findings, _ := findingStore.List(r.Context(), runID)
	coverage := coverageFor(run, findings)
	skippedCategories := []string{}
	unfixed := 0
	for _, entry := range coverage {
		if entry.Skipped {
			skippedCategories = append(skippedCategories, entry.Category)
		}
		unfixed += entry.Unfixed
	}
	status := "pass"
	if len(skippedCategories) > 0 {
		status = "incomplete"
	} else if unfixed > 0 {
		status = "fail"
	}
	warnings := []string{}
	for _, category := range skippedCategories {
		warnings = append(warnings, "category "+category+" skipped: "+killSwitchWarning)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":            runID,
		"tenant":            tenant,
		"target":            run.Target,
		"status":            status,
		"coverage":          coverage,
		"unfixed_findings":  unfixed,
		"warnings":          warnings,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/redteam/runs/{runID}", getRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")

  val route: Route =
    path("v1" / "redteam" / "runs" / Segment) { runId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft answers any caller who knows a run id, reports pass as soon as there is
          // no critical finding, and drops the categories a kill switch skipped. Scope the run to
          // the tenant with a 404, report coverage per category, and make a run with skipped
          // categories incomplete.
          val run = runStore.get(runId)
          val findings = findingStore.list(runId)
          val critical = findings.filter(_.severity == "critical")
          complete(
            StatusCodes.OK,
            s"""{"run_id":"$runId","tenant":"$tenant","target":"\${run.target}","status":"\${if (critical.isEmpty) "pass" else "fail"}","critical":\${critical.size}}"""
          )
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
import spray.json.DefaultJsonProtocol._
import spray.json._

object Read {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")

  val KillSwitchWarning = "kill switch fired"

  final case class Coverage(category: String, blocked: Int, succeeded: Int, unfixed: Int, skipped: Boolean)
  final case class Finding(category: String, severity: String, blocked: Boolean, fixed: Boolean)
  implicit val coverageFormat = jsonFormat5(Coverage)

  def coverageFor(run: RunRecord, findings: List[Finding]): List[Coverage] =
    run.categories.map { category =>
      val categoryFindings = findings.filter(_.category == category)
      Coverage(
        category,
        categoryFindings.count(_.blocked),
        categoryFindings.count(!_.blocked),
        categoryFindings.count(!_.fixed),
        run.skippedCategories.contains(category)
      )
    }

  /** The caller's run, or a 404: a foreign run is indistinguishable from a missing one. */
  def loadRun(runId: String, tenant: String): Option[RunRecord] =
    runStore.get(runId).filter(_.tenant == tenant)

  val route: Route =
    path("v1" / "redteam" / "runs" / Segment) { runId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          loadRun(runId, tenant) match {
            case None =>
              complete(StatusCodes.NotFound, """{"error":"run not found"}""")
            case Some(run) =>
              val coverage = coverageFor(run, findingStore.list(runId))
              val skippedCategories = coverage.filter(_.skipped).map(_.category)
              val unfixed = coverage.map(_.unfixed).sum
              val status =
                if (skippedCategories.nonEmpty) "incomplete" else if (unfixed == 0) "pass" else "fail"
              val warnings = skippedCategories.map(name => s"category $name skipped: $KillSwitchWarning")
              val body = JsObject(
                "run_id" -> JsString(runId),
                "tenant" -> JsString(tenant),
                "target" -> JsString(run.target),
                "status" -> JsString(status),
                "coverage" -> coverage.toJson,
                "unfixed_findings" -> JsNumber(unfixed),
                "warnings" -> warnings.toJson
              )
              complete(StatusCodes.OK, body.compactPrint)
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

int main() {
  httplib::Server svr;

  svr.Get("/v1/redteam/runs/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto runId = req.matches[1].str();
    const auto tenant = req.get_header_value("X-Tenant-Id");
    // TODO: this draft answers any caller who knows a run id, reports pass as soon as there is no
    // critical finding, and drops the categories a kill switch skipped. Scope the run to the tenant
    // with a 404, report coverage per category, and make a run with skipped categories incomplete.
    const auto run = runStore.get(runId);
    const auto findings = findingStore.list(runId);
    int critical = 0;
    for (const auto& finding : findings) {
      if (finding.value("severity", std::string()) == "critical") critical++;
    }
    std::string status = critical == 0 ? "pass" : "fail";
    res.status = 200;
    res.set_content(
        json{{"run_id", runId}, {"tenant", tenant}, {"target", run.value("target", std::string())},
             {"status", status}, {"critical", critical}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kKillSwitchWarning = "kill switch fired";

/** The caller's run, or nothing: a foreign run is indistinguishable from a missing one. */
std::optional<json> loadRun(const std::string& runId, const std::string& tenant) {
  const auto run = runStore.get(runId);
  if (!run || run->value("tenant", std::string()) != tenant) return std::nullopt;
  return run;
}

json coverageFor(const json& run, const json& findings) {
  json coverage = json::array();
  for (const auto& category : run["categories"]) {
    const auto name = category.get<std::string>();
    int blocked = 0;
    int succeeded = 0;
    int unfixed = 0;
    for (const auto& finding : findings) {
      if (finding.value("category", std::string()) != name) continue;
      if (finding.value("blocked", false)) {
        blocked++;
      } else {
        succeeded++;
      }
      if (!finding.value("fixed", false)) unfixed++;
    }
    const bool skipped =
        std::find(run["skipped_categories"].begin(), run["skipped_categories"].end(), name) !=
        run["skipped_categories"].end();
    coverage.push_back(
        json{{"category", name}, {"blocked", blocked}, {"succeeded", succeeded},
             {"unfixed", unfixed}, {"skipped", skipped}});
  }
  return coverage;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/redteam/runs/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto runId = req.matches[1].str();
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto run = loadRun(runId, tenant);
    if (!run) {
      res.status = 404;
      res.set_content(R"({"error":"run not found"})", "application/json");
      return;
    }
    const auto coverage = coverageFor(*run, findingStore.list(runId));
    std::vector<std::string> skippedCategories;
    int unfixed = 0;
    json warnings = json::array();
    for (const auto& entry : coverage) {
      if (entry["skipped"].get<bool>()) {
        const auto name = entry["category"].get<std::string>();
        skippedCategories.push_back(name);
        warnings.push_back("category " + name + " skipped: " + kKillSwitchWarning);
      }
      unfixed += entry["unfixed"].get<int>();
    }
    const std::string status =
        !skippedCategories.empty() ? "incomplete" : (unfixed == 0 ? "pass" : "fail");
    res.status = 200;
    res.set_content(
        json{{"run_id", runId}, {"tenant", tenant}, {"target", run->value("target", std::string())},
             {"status", status}, {"coverage", coverage}, {"unfixed_findings", unfixed},
             {"warnings", warnings}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Coverage first, status second: build the per-category list, then derive `status` from it. A status computed from findings alone cannot see the category that produced no findings because it never ran.',
    '`skipped_categories` is the honest signal. If it is non-empty the answer is `incomplete`, and the response should say which categories and why (`kill switch fired`) — a warning the reader can act on beats a green badge they cannot trust.',
    'Scope the read by tenant and answer 404 for a foreign run. A 403 confirms the run exists, which is exactly the fact the other tenant does not want shared.',
  ],
  debrief: `The interviewer is asking whether your report can be trusted when the run was cut short. The draft is the classic shape: it counts what went wrong and calls the absence of severity a success, which turns an aborted probe set into a green badge. Three contracts are checked here. Coverage is reported per category with blocked, succeeded and unfixed counts, so a reader can see where the run actually went. A skipped category is incomplete, and incomplete beats pass: no amount of quiet findings makes an untested category tested. And the read is tenant-scoped with a 404, because a report endpoint keyed by run id alone leaks another tenant's findings and evidence references. Real platforms add run-to-run comparison, a signed snapshot of the report at the moment a release decision was made, and an export that keeps the warnings attached to the numbers.`,
};
