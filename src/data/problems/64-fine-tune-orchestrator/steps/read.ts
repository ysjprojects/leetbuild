import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/finetune/jobs/{id}: a result nobody trusts blindly',
  concept: 'http',
  file: 'read',
  focus: ['readapi', 'eval', 'checkpoints'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated read handler: it looks up a job and
returns its status. It compiles, it answers the dashboard, and it reports a job as successful the
moment the trainer exits zero — even when the eval gate failed. Review it like the model owner, fix
it, and prove the fix with the checks below.

Implement \`GET /v1/finetune/jobs/{job_id}\`.

- The team comes from the authenticated \`X-Team-Id\` header. A job that belongs to another team is
  **404** — not 403 — so a foreign id cannot even be confirmed to exist.
- The response carries the job \`id\`, the \`status\`, and \`trained\` (the trainer exited zero).
- **The eval gate is part of the answer.** Report the eval result and compute \`promotable\`: a run
  that finished with exit code zero but whose eval gate did not pass is **trained but not
  promotable**. Never report \`completed\` as a success on its own.
- **Reconcile the budget.** Report \`budget.reserved\`, \`budget.spent\` and \`budget.remaining\`,
  where \`spent = reserved - remaining\`, so the numbers add up with what the Redis layer released.
- Include the **checkpoint lineage** so the run can be reproduced and its restarts explained.
- Log the read with team and job id — never the hyperparameter block.

**Failure mode the checks target.** Reporting success on exit code zero hides the eval gate, so a
model that failed its golden set reaches a registry as a promotable artifact. Hiding the spent budget
means nobody can reconcile the reservation with what the trainer actually used. And a read handler
that serves any team's jobs leaks every tenant's runs to anyone who can guess an id.`,
  sequence: {
    participants: ['Client', 'Job read API', 'Checkpoint store', 'Eval gate'],
    messages: [
      {from: 'Client', to: 'Job read API', label: 'GET /v1/finetune/jobs/{id} · X-Team-Id', kind: 'sync'},
      {from: 'Job read API', to: 'Job read API', label: 'load job · compare team', kind: 'sync'},
      {from: 'Job read API', to: 'Checkpoint store', label: 'checkpoint lineage', kind: 'sync'},
      {from: 'Checkpoint store', to: 'Job read API', label: 'checkpoint ids', kind: 'reply'},
      {from: 'Job read API', to: 'Eval gate', label: 'eval result for the job', kind: 'sync'},
      {from: 'Eval gate', to: 'Job read API', label: 'passed / failed / absent', kind: 'reply'},
      {from: 'Job read API', to: 'Client', label: '200 {status, spent, promotable, eval, checkpoints}', kind: 'reply'},
      {from: 'Job read API', to: 'Client', label: '404 for another team’s job', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/finetune/jobs/{id}',
      detail: 'Register the read route on `GET /v1/finetune/jobs/{job_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/finetune\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/finetune\/jobs\/:jobId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/finetune\/jobs\/"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"finetune"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/finetune\/jobs/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Serves only the caller’s team',
      detail:
        'The handler compares the job’s team with the authenticated team and answers **404** when they differ. The draft serves any team’s jobs.',
      match: {
        python: {all: [/job\["team"\] != x_team_id/, /status_code\s*=\s*404/]},
        typescript: {all: [/job\.team !== team/, /code\(\s*404\s*\)/]},
        go: {all: [/job\.Team != team/, /StatusNotFound/]},
        scala: {all: [/job\.team == team/, /StatusCodes\.NotFound/]},
        cpp: {all: [/job->team != team/, /\b404\b/]},
      },
    },
    {
      id: 'eval-gate',
      title: 'Reports the eval gate result',
      detail:
        'The response carries the eval result (`eval.passed`). The draft hides the gate and returns only the exit code.',
      match: {
        python: {all: [/"eval"/, /"passed"/]},
        typescript: {all: [/eval:/, /passed/]},
        go: {all: [/"eval"/, /"passed"/]},
        scala: {all: [/"eval"/, /"passed"/]},
        cpp: {all: [/"eval"/, /"passed"/]},
      },
    },
    {
      id: 'not-promotable',
      title: 'Exit-zero without a passing eval is not promotable',
      detail:
        '`promotable` requires the run to be finished, the trainer to have exited zero **and** the eval gate to have passed. The draft calls every exit-zero run a success.',
      match: {
        python: {all: [/promotable/, /exit_code/, /passed/]},
        typescript: {all: [/promotable/, /exitCode/, /passed/]},
        go: {all: [/promotable/, /ExitCode/, /Passed/]},
        scala: {all: [/promotable/, /exitCode/, /passed/]},
        cpp: {all: [/promotable/, /exit_code/, /passed/]},
      },
    },
    {
      id: 'budget-reconcile',
      title: 'Reconciles the spent budget with the reservation',
      detail:
        'The response reports `reserved`, `spent` and `remaining` so `spent = reserved - remaining` holds against what Redis released. The draft reports neither the reservation nor the remainder.',
      match: {
        python: {all: [/reserved/, /spent/, /remaining/]},
        typescript: {all: [/reserved/, /spent/, /remaining/]},
        go: {all: [/reserved/, /spent/, /remaining/]},
        scala: {all: [/reserved/, /spent/, /remaining/]},
        cpp: {all: [/reserved/, /spent/, /remaining/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/finetune/jobs/{job_id}: a job view (model-generated draft)."""
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("finetune.read")


@app.get("/v1/finetune/jobs/{job_id}")
async def read_job(job_id: str, x_team_id: str = Header(...)) -> JSONResponse:
    # TODO: serve only the caller's team (404 otherwise), report the eval gate and whether the run
    # is promotable, and reconcile the spent budget with the reservation.
    job = jobs.get(job_id)
    if job is None:
        return JSONResponse({"detail": "job not found"}, status_code=404)
    logger.info("read job %s", job_id)
    return JSONResponse({
        "id": job["id"],
        "status": "completed" if job.get("exit_code") == 0 else "failed",
        "exit_code": job.get("exit_code"),
        "budget_spent": job.get("spent"),
    }, status_code=200)
`,
      solution: `"""GET /v1/finetune/jobs/{job_id}: a job view nobody trusts blindly."""
import logging
from typing import Any, Dict

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("finetune.read")


def _promotable(job: Dict[str, Any]) -> bool:
    """A finished run is promotable only when the trainer exited zero and the eval gate passed."""
    if job["status"] != "completed":
        return False
    if job.get("exit_code") != 0:
        return False
    return job.get("eval", {}).get("passed") is True


@app.get("/v1/finetune/jobs/{job_id}")
async def read_job(job_id: str, x_team_id: str = Header(...)) -> JSONResponse:
    job = jobs.get(job_id)
    if job is None or job["team"] != x_team_id:
        return JSONResponse({"detail": "job not found"}, status_code=404)
    spent = job["reserved"] - job["released_remainder"]
    logger.info("read job %s for team %s", job_id, x_team_id)
    return JSONResponse({
        "id": job["id"],
        "status": job["status"],
        "trained": job.get("exit_code") == 0,
        "promotable": _promotable(job),
        "eval": job.get("eval", {"passed": False, "score": None}),
        "budget": {
            "reserved": job["reserved"],
            "spent": spent,
            "remaining": job["released_remainder"],
        },
        "checkpoints": job["checkpoint_lineage"],
    }, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/finetune/jobs/:jobId: a job view (model-generated draft). */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/finetune/jobs/:jobId', async (request, reply) => {
  // TODO: serve only the caller's team (404 otherwise), report the eval gate and whether the run
  // is promotable, and reconcile the spent budget with the reservation.
  const {jobId} = request.params as {jobId: string};
  const job = jobs.get(jobId);
  if (job === undefined) return reply.code(404).send({detail: 'job not found'});
  return reply.code(200).send({
    id: job.id,
    status: job.exitCode === 0 ? 'completed' : 'failed',
    exit_code: job.exitCode,
    budget_spent: job.spent,
  });
});
`,
      solution: `/** GET /v1/finetune/jobs/:jobId: a job view nobody trusts blindly. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/finetune/jobs/:jobId', async (request, reply) => {
  const team = request.headers['x-team-id'] as string;
  const {jobId} = request.params as {jobId: string};
  const job = jobs.get(jobId);
  if (job === undefined || job.team !== team) return reply.code(404).send({detail: 'job not found'});
  const spent = job.reserved - job.releasedRemainder;
  const evalPassed = job.eval?.passed === true;
  return reply.code(200).send({
    id: job.id,
    status: job.status,
    trained: job.exitCode === 0,
    promotable: job.status === 'completed' && job.exitCode === 0 && evalPassed,
    eval: {passed: evalPassed, score: job.eval?.score ?? null},
    budget: {reserved: job.reserved, spent, remaining: job.releasedRemainder},
    checkpoints: job.checkpointLineage,
  });
});
`,
    },
    go: {
      starter: `// Package read serves GET /v1/finetune/jobs/{id} (model-generated draft).
package read

import (
	"encoding/json"
	"net/http"
	"strings"
)

func Register(mux *http.ServeMux, jobs *JobStore) {
	mux.HandleFunc("GET /v1/finetune/jobs/", func(w http.ResponseWriter, r *http.Request) {
		// TODO: serve only the caller's team (404 otherwise), report the eval gate and whether the
		// run is promotable, and reconcile the spent budget with the reservation.
		jobID := strings.TrimPrefix(r.URL.Path, "/v1/finetune/jobs/")
		job, ok := jobs.Get(jobID)
		if !ok {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		body := map[string]any{
			"id":           job.ID,
			"status":       map[bool]string{true: "completed", false: "failed"}[job.ExitCode == 0],
			"exit_code":    job.ExitCode,
			"budget_spent": job.Spent,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
}
`,
      solution: `// Package read serves GET /v1/finetune/jobs/{id}.
package read

import (
	"encoding/json"
	"net/http"
	"strings"
)

func Register(mux *http.ServeMux, jobs *JobStore) {
	mux.HandleFunc("GET /v1/finetune/jobs/", func(w http.ResponseWriter, r *http.Request) {
		team := r.Header.Get("X-Team-Id")
		jobID := strings.TrimPrefix(r.URL.Path, "/v1/finetune/jobs/")
		job, ok := jobs.Get(jobID)
		if !ok || job.Team != team {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		spent := job.Reserved - job.ReleasedRemainder
		evalPassed := job.Eval != nil && job.Eval.Passed
		body := map[string]any{
			"id":          job.ID,
			"status":      job.Status,
			"trained":     job.ExitCode == 0,
			"promotable":  job.Status == "completed" && job.ExitCode == 0 && evalPassed,
			"eval":        map[string]any{"passed": evalPassed, "score": job.Eval.Score},
			"budget":      map[string]any{"reserved": job.Reserved, "spent": spent, "remaining": job.ReleasedRemainder},
			"checkpoints": job.CheckpointLineage,
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
}
`,
    },
    scala: {
      starter: `package finetune

import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  val route: Route = path("v1" / "finetune" / "jobs" / Segment) { jobId =>
    get {
      // TODO: serve only the caller's team (404 otherwise), report the eval gate and whether the
      // run is promotable, and reconcile the spent budget with the reservation.
      jobs.get(jobId) match {
        case Some(job) =>
          val status = if (job.exitCode == 0) "completed" else "failed"
          complete(StatusCodes.OK, s"""{"id":"\${job.id}","status":"$status"}""")
        case None => complete(StatusCodes.NotFound, "job not found")
      }
    }
  }
}
`,
      solution: `package finetune

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  val route: Route = path("v1" / "finetune" / "jobs" / Segment) { jobId =>
    get {
      headerValueByName("X-Team-Id") { team =>
        jobs.get(jobId) match {
          case Some(job) if job.team == team =>
            val spent = job.reserved - job.releasedRemainder
            val evalPassed = job.eval.exists(_.passed)
            val promotable = job.status == "completed" && job.exitCode == 0 && evalPassed
            complete(
              StatusCodes.OK,
              s"""{"id":"\${job.id}","status":"\${job.status}","trained":\${job.exitCode == 0},"promotable":$promotable,"eval":{"passed":$evalPassed,"score":\${job.evalScore}},"budget":{"reserved":\${job.reserved},"spent":$spent,"remaining":\${job.releasedRemainder}},"checkpoints":\${job.checkpointLineage}}""",
            )
          case _ => complete(StatusCodes.NotFound, "job not found")
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `// GET /v1/finetune/jobs/{id} (model-generated draft).
#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

void RegisterRead(httplib::Server& svr, JobStore* jobs) {
  svr.Get(R"(/v1/finetune/jobs/([^/]+))", [jobs](const httplib::Request& req, httplib::Response& res) {
    // TODO: serve only the caller's team (404 otherwise), report the eval gate and whether the run
    // is promotable, and reconcile the spent budget with the reservation.
    const std::string job_id = req.matches[1];
    auto job = jobs->Get(job_id);
    if (!job.has_value()) {
      res.status = 404;
      res.set_content(R"({"detail":"job not found"})", "application/json");
      return;
    }
    json body = {
        {"id", job->id},
        {"status", job->exit_code == 0 ? "completed" : "failed"},
        {"exit_code", job->exit_code},
        {"budget_spent", job->spent},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });
}
`,
      solution: `// GET /v1/finetune/jobs/{id}.
#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

void RegisterRead(httplib::Server& svr, JobStore* jobs) {
  svr.Get(R"(/v1/finetune/jobs/([^/]+))", [jobs](const httplib::Request& req, httplib::Response& res) {
    const std::string team = req.get_header_value("X-Team-Id");
    const std::string job_id = req.matches[1];
    auto job = jobs->Get(job_id);
    if (!job.has_value() || job->team != team) {
      res.status = 404;
      res.set_content(R"({"detail":"job not found"})", "application/json");
      return;
    }
    const long long spent = job->reserved - job->released_remainder;
    const bool eval_passed = job->eval_passed;
    const bool promotable = job->status == "completed" && job->exit_code == 0 && eval_passed;
    json body = {
        {"id", job->id},
        {"status", job->status},
        {"trained", job->exit_code == 0},
        {"promotable", promotable},
        {"eval", {{"passed", eval_passed}, {"score", job->eval_score}}},
        {"budget", {{"reserved", job->reserved}, {"spent", spent}, {"remaining", job->released_remainder}}},
        {"checkpoints", job->checkpoint_lineage},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });
}
`,
    },
  },
  hints: [
    'Serve only the caller’s team: answer **404** when the job belongs to someone else, so a foreign id cannot even be confirmed to exist.',
    'The eval gate belongs in the answer: report its result and compute `promotable` from exit code zero **and** a passing eval — a run that finished but failed its golden set is trained, not promotable.',
    'Reconcile the budget in the response: `reserved`, `spent` and `remaining`, so the numbers agree with what the Redis layer released.',
  ],
  debrief: `The interviewer is testing whether you can review a generated read path against trust and honesty. The draft reads fine because the dashboard only ever asks for its own jobs and only ever shows finished ones. Four separate defects are being checked: the team scoping (404, not 403, for a foreign job), the eval gate that must be reported rather than hidden, the \`promotable\` computation that must combine the exit code with the eval result, and the budget reconciliation against the reservation. The quiet one is exit-zero-as-success: a trainer can exit zero on a run whose eval failed, and a registry that promotes on exit code alone ships a model nobody validated. Real systems also expose the checkpoint lineage so a run can be reproduced and its restarts explained.`,
};
