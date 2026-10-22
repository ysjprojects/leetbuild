import type {Step} from '@/lib/types';

export const experimentClientStep: Step = {
  id: 'dependency',
  title: 'Guardrail checks before traffic increases',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'stats'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the ramp route,
validates the target, and asks the stats service before the percentage moves. It works on a demo
whose metrics are green, and it removes the gate exactly when the gate matters. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/experiments/{id}/ramp\` with body \`{"to_percent": 60}\`:

- The tenant comes from \`X-Tenant-Id\`; a missing tenant is **401**. \`to_percent\` must be an
  integer, greater than the experiment's current percentage and at most **100**; anything else is
  **400**.
- Before the new percentage is applied, ask the stats service over gRPC:
  \`CheckGuardrails(experiment_id, metric_bounds)\` with a **2 000 ms deadline**
  (\`timeout=2.0\` / \`{deadline: Date.now() + 2000}\` / \`context.WithTimeout(..., 2*time.Second)\` /
  a Scala deadline of 2 seconds / \`ClientContext.set_deadline(..., milliseconds(2000))\`). The draft
  gives the call five seconds, so a stuck stats service holds the ramp request open.
- A breached bound **pauses** the ramp: persist the experiment \`paused\`, do **not** apply the new
  percentage, and answer **409** with the offending metric —
  \`{"status": "paused", "metric": "error_rate", "limit": 0.05, "observed": 0.12}\`. The check runs
  *before* the percentage moves, so a breach can never leak into the store as a ramp.
- A \`PAUSED\` verdict is terminal for that request: it is never retried. Only a transient failure
  — \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` — may be retried, at most once (\`MAX_GUARDRAIL_ATTEMPTS\`
  = 2 attempts), and a check that never succeeds never applies the ramp.
- Nothing in the body may override the gate: \`skip_guardrails\`, \`override\` or \`force\` is
  **400**, and the bounds come from service config (\`GUARDRAIL_BOUNDS\`), never from the request.
  A guardrail a caller can switch off is not a guardrail.
- A \`paused\` experiment is not resumed by the stored flag: a ramp request re-runs the check for
  that request, stays \`paused\` and answers **409** again while the breach is present, and only a
  fresh pass lifts the pause and applies the percentage.
- Log the experiment id, the metric and the observed value — never the raw request body.

**Failure mode the checks target.** Two failures hide behind the happy path. The loud one is the
retry: \`PAUSED\` is the stats service's *answer*, so looping on it until it clears deletes the gate
while the metric is still breached, and every attempt pays the deadline again. The quiet one is the
stored pause: a resume must earn a fresh check for *this* request, so the status is consulted but
never substitutes for the call — otherwise an operator's pause is a flag the next cron ignores. And
the body is data, not policy: \`skip_guardrails\` is a 400, not a shortcut.`,
  sequence: {
    participants: ['Ramp caller', 'Experiment API', 'Stats service'],
    messages: [
      {
        from: 'Ramp caller',
        to: 'Experiment API',
        label: 'POST /v1/experiments/{id}/ramp · {"to_percent": 60} · X-Tenant-Id',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Stats service',
        label: 'CheckGuardrails(experiment_id, metric_bounds) · deadline 2 s',
        kind: 'sync',
      },
      {
        from: 'Stats service',
        to: 'Experiment API',
        label: 'PAUSED · metric=error_rate limit=0.05 observed=0.12',
        kind: 'reply',
      },
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'persist paused · a PAUSED verdict is never retried',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Ramp caller',
        label: '409 {"status":"paused","metric":"error_rate","limit":0.05,"observed":0.12}',
        kind: 'reply',
      },
      {from: 'Stats service', to: 'Experiment API', label: 'UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'retry once inside the 2 s budget · a failed check never applies the ramp',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Ramp caller',
        label: 'the next ramp re-runs the check: a fresh pass lifts the pause, a breach keeps it 409',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Guardrail RPC carries a 2 s deadline',
      detail:
        'Every `CheckGuardrails` attempt is created with an explicit 2 000 ms deadline — `timeout=GUARDRAIL_DEADLINE_S`, `{deadline: Date.now() + GUARDRAIL_DEADLINE_MS}`, `context.WithTimeout(ctx, guardrailDeadline)` with `2 * time.Second`, `withDeadlineAfter(GuardrailDeadlineS, SECONDS)` or `ctx.set_deadline(..., milliseconds(kGuardrailDeadlineMs))`. The draft gives the call five seconds, so a stuck stats service holds the ramp request past the budget the platform promised.',
      match: {
        python: {all: [/GUARDRAIL_DEADLINE_S\s*=\s*2\.0/, /timeout\s*=\s*GUARDRAIL_DEADLINE_S/]},
        typescript: {
          all: [/GUARDRAIL_DEADLINE_MS\s*=\s*2000/, /deadline\s*:\s*Date\.now\(\)\s*\+\s*GUARDRAIL_DEADLINE_MS/],
        },
        go: {all: [/guardrailDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout/]},
        scala: {all: [/GuardrailDeadlineS\s*=\s*2/, /withDeadlineAfter\(\s*GuardrailDeadlineS/]},
        cpp: {all: [/kGuardrailDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'pause-on-breach',
      title: 'A breached bound pauses the ramp and names the metric',
      detail:
        'A `PAUSED` verdict persists the experiment as `paused` and answers **409** with the offending `metric`, its `limit` and the `observed` value; the percentage is never applied. The order matcher holds the guardrail call before the ramp write, so a breach cannot slip through to `applyPercent`. The draft retries the verdict and ramps a metric that is still breached.',
      match: {
        python: {
          all: [/\bpaused\b/, /\bmetric\b/, /CheckGuardrails\(/],
          order: [/stats\.CheckGuardrails\(/, /store\.apply_percent\(/],
        },
        typescript: {
          all: [/\bpaused\b/, /\bmetric\b/, /CheckGuardrails\(/],
          order: [/stats\.CheckGuardrails\(/, /store\.applyPercent\(/],
        },
        go: {
          all: [/paused/, /(GetMetric\(|\bMetric\b)/, /CheckGuardrails\(/],
          order: [/stats\.CheckGuardrails\(/, /store\.ApplyPercent\(/],
        },
        scala: {
          all: [/paused/, /\bmetric\b/, /[Cc]heckGuardrails\(/],
          order: [/[Cc]heckGuardrails\(\s*CheckGuardrailsRequest/, /store\.applyPercent\(/],
        },
        cpp: {
          all: [/paused/, /\bmetric\b/, /CheckGuardrails\(/],
          order: [/stats->CheckGuardrails\(/, /store\.apply_percent\(/],
        },
      },
    },
    {
      id: 'no-override',
      title: 'A caller-supplied override is rejected',
      detail:
        'A body field such as `skip_guardrails`, `override` or `force` is a **400** — rejected, never honoured — and the guardrail input (the bounds and the verdict) never comes from the request. The draft reads `skip_guardrails` from the body and skips the check, which turns the gate into a suggestion.',
      match: {
        python: {
          all: [/skip_guardrails/, /OVERRIDE_FIELDS/, /status_code\s*=\s*400/],
          none: [
            /body\.get\(\s*["']skip_guardrails["']/,
            /body\[\s*["']skip_guardrails["']\s*\]/,
            /body\.get\(\s*["']metric_bounds["']/,
          ],
        },
        typescript: {
          all: [/skip_guardrails/, /OVERRIDE_FIELDS/, /code\(\s*400\s*\)/],
          none: [/body\.skip_guardrails/, /body\[['"]skip_guardrails['"]\]/, /body\.metricBounds/],
        },
        go: {
          all: [/skip_guardrails/, /overrideFields/, /StatusBadRequest/],
          none: [/body\.SkipGuardrails/, /body\["skip_guardrails"\]/],
        },
        scala: {
          all: [/skip_guardrails/, /OverrideFields/, /StatusCodes\.BadRequest/],
          none: [/fields\.get\(\s*"skip_guardrails"\)/, /body\.skipGuardrails/],
        },
        cpp: {
          all: [/skip_guardrails/, /kOverrideFields/, /\b400\b/],
          none: [/body\.value\(\s*"skip_guardrails"/, /body\[\s*"skip_guardrails"\s*\]/],
        },
      },
    },
    {
      id: 'no-retry-paused',
      title: 'A PAUSED verdict is terminal',
      detail:
        'The verdict is read once: a `PAUSED` answer ends the request, and only `UNAVAILABLE` / `DEADLINE_EXCEEDED` are retried — at most `MAX_GUARDRAIL_ATTEMPTS = 2` attempts, never an unbounded `while`/`for` around the check. The draft loops until the check passes, holding the request open and ramping on a metric that is still breached.',
      match: {
        python: {
          all: [/VERDICT_PAUSED/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_GUARDRAIL_ATTEMPTS/],
          none: [/while\s+True/, /itertools\.count\(\)/],
        },
        typescript: {
          all: [/VERDICT_PAUSED/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_GUARDRAIL_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/verdictPaused/, /codes\.Unavailable/, /codes\.DeadlineExceeded/, /maxGuardrailAttempts/],
          none: [/for\s*\{/],
        },
        scala: {
          all: [/VerdictPaused/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MaxGuardrailAttempts/],
          none: [/while\s*\(\s*true\s*\)/, /Iterator\.continually/],
        },
        cpp: {
          all: [/kVerdictPaused/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kMaxGuardrailAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'fresh-check',
      title: 'A paused experiment needs a fresh pass',
      detail:
        'The stored `paused` status is consulted for this request but never substitutes for the check: the ramp re-runs the guardrail call, stays `paused` and answers **409** while the breach is present, and only a fresh passing check lifts the pause and applies the percentage. The order matcher keeps the status ahead of the percentage. The draft never reads the stored status at all.',
      match: {
        python: {
          all: [/experiment\[["']status["']\]\s*==\s*["']paused["']/, /status_code\s*=\s*409/],
          order: [/experiment\[["']status["']\]\s*==\s*["']paused["']/, /store\.apply_percent\(/],
        },
        typescript: {
          all: [/experiment\.status\s*===\s*['"]paused['"]/, /code\(\s*409\s*\)/],
          order: [/experiment\.status\s*===\s*['"]paused['"]/, /store\.applyPercent\(/],
        },
        go: {
          all: [/experiment\.Status\s*==\s*"paused"/, /StatusConflict/],
          order: [/experiment\.Status\s*==\s*"paused"/, /store\.ApplyPercent\(/],
        },
        scala: {
          all: [/experiment\.status\s*==\s*"paused"/, /StatusCodes\.Conflict/],
          order: [/experiment\.status\s*==\s*"paused"/, /store\.applyPercent\(/],
        },
        cpp: {
          all: [/experiment\.status\s*==\s*"paused"/, /\b409\b/],
          order: [/experiment\.status\s*==\s*"paused"/, /store\.apply_percent\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/experiments/{id}/ramp: a model-generated draft that retries the verdict until it passes."""
import logging

import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

import experiments_pb2
import experiments_pb2_grpc

app = FastAPI()
logger = logging.getLogger("expd")

DEADLINE_SECONDS = 5
GUARDRAIL_BOUNDS = {"error_rate": 0.05, "p95_latency_ms": 800.0}

channel = grpc.insecure_channel("stats:9000")
stats = experiments_pb2_grpc.StatsStub(channel)


class ExperimentStore:
    def get(self, experiment_id: str) -> dict:
        """The experiment row: the current percentage and its status."""
        raise NotImplementedError

    def set_status(self, experiment_id: str, status: str) -> None:
        raise NotImplementedError

    def apply_percent(self, experiment_id: str, to_percent: int) -> None:
        """Persist the new percentage and re-point the assignment buckets."""
        raise NotImplementedError


store = ExperimentStore()


@app.post("/v1/experiments/{experiment_id}/ramp")
def ramp(experiment_id: str, body: dict, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: the draft ramps on a cron, retries the stats service until the verdict stops saying
    # PAUSED, gives the call a five-second deadline, and honours body["skip_guardrails"]. Make a
    # breach pause the experiment with the metric named, retry only transient failures, and take
    # no guardrail input from the request body.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    experiment = store.get(experiment_id)
    to_percent = body.get("to_percent")
    if not isinstance(to_percent, int) or to_percent <= experiment["percent"] or to_percent > 100:
        raise HTTPException(status_code=400, detail="to_percent must be above the current percentage and at most 100")
    skip = body.get("skip_guardrails") or body.get("override") or body.get("force")
    if skip:
        logger.info("ramp skipping the guardrail check experiment=%s body=%s", experiment_id, body)
    else:
        while True:
            verdict = stats.CheckGuardrails(
                experiments_pb2.CheckGuardrailsRequest(experiment_id=experiment_id, metric_bounds=GUARDRAIL_BOUNDS),
                timeout=DEADLINE_SECONDS,
            )
            if verdict.verdict != "PAUSED":
                break
    store.apply_percent(experiment_id, to_percent)
    logger.info("ramp applied experiment=%s body=%s", experiment_id, body)
    return JSONResponse({"status": "ramping", "to_percent": to_percent}, status_code=200)
`,
      solution: `"""POST /v1/experiments/{id}/ramp: the guardrail gate that pauses a ramp on a breached bound."""
import logging

import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

import experiments_pb2
import experiments_pb2_grpc

app = FastAPI()
logger = logging.getLogger("expd")

GUARDRAIL_DEADLINE_S = 2.0
MAX_GUARDRAIL_ATTEMPTS = 2
VERDICT_PAUSED = "PAUSED"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

# The bounds live with the service and its config; the request body never supplies them.
GUARDRAIL_BOUNDS = {"error_rate": 0.05, "p95_latency_ms": 800.0}

# A caller cannot skip, widen or replace the guardrail gate from the request.
OVERRIDE_FIELDS = ("skip_guardrails", "override", "force")

channel = grpc.insecure_channel("stats:9000")
stats = experiments_pb2_grpc.StatsStub(channel)


class GuardrailUnavailable(Exception):
    """The stats service did not answer inside its budget; the ramp does not proceed."""


class ExperimentStore:
    def get(self, experiment_id: str) -> dict:
        """The experiment row: the current percentage and its status."""
        raise NotImplementedError

    def set_status(self, experiment_id: str, status: str) -> None:
        raise NotImplementedError

    def apply_percent(self, experiment_id: str, to_percent: int) -> None:
        """Persist the new percentage and re-point the assignment buckets."""
        raise NotImplementedError


store = ExperimentStore()


def check_guardrails(experiment_id: str):
    """Ask the stats service with the 2 s deadline; only transient failures are retried."""
    last: grpc.RpcError | None = None
    for _ in range(MAX_GUARDRAIL_ATTEMPTS):
        try:
            return stats.CheckGuardrails(
                experiments_pb2.CheckGuardrailsRequest(experiment_id=experiment_id, metric_bounds=GUARDRAIL_BOUNDS),
                timeout=GUARDRAIL_DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            last = exc
            logger.warning("guardrail check retry experiment=%s code=%s", experiment_id, exc.code())
    raise GuardrailUnavailable(str(last))


@app.post("/v1/experiments/{experiment_id}/ramp")
def ramp(experiment_id: str, body: dict, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    for field in OVERRIDE_FIELDS:
        if field in body:
            raise HTTPException(status_code=400, detail=f"{field} is not accepted: guardrails are server-side")
    experiment = store.get(experiment_id)
    to_percent = body.get("to_percent")
    if not isinstance(to_percent, int) or to_percent <= experiment["percent"] or to_percent > 100:
        raise HTTPException(status_code=400, detail="to_percent must be above the current percentage and at most 100")
    if experiment["status"] == "paused":
        # A paused experiment is not resumed by the stored flag; it needs a fresh pass.
        logger.info("ramp requested on a paused experiment=%s", experiment_id)
    try:
        verdict = check_guardrails(experiment_id)
    except GuardrailUnavailable:
        logger.warning("ramp blocked experiment=%s reason=guardrails_unanswered", experiment_id)
        return JSONResponse({"status": "unavailable"}, status_code=503)
    if verdict.verdict == VERDICT_PAUSED:
        store.set_status(experiment_id, "paused")
        logger.warning(
            "ramp paused experiment=%s metric=%s observed=%s limit=%s",
            experiment_id,
            verdict.metric,
            verdict.observed,
            verdict.limit,
        )
        return JSONResponse(
            {"status": "paused", "metric": verdict.metric, "limit": verdict.limit, "observed": verdict.observed},
            status_code=409,
        )
    store.set_status(experiment_id, "running")
    store.apply_percent(experiment_id, to_percent)
    logger.info("ramp applied experiment=%s to_percent=%s", experiment_id, to_percent)
    return JSONResponse({"status": "ramping", "to_percent": to_percent}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/experiments/:id/ramp: a model-generated draft that trusts the body and retries the verdict. */
import Fastify from 'fastify';

import {stats} from './stats';

export const app = Fastify();

const DEADLINE_SECONDS = 5;
const GUARDRAIL_BOUNDS = {error_rate: 0.05, p95_latency_ms: 800};

interface RampBody {
  to_percent: number;
  skip_guardrails?: boolean;
  override?: boolean;
  force?: boolean;
}

interface ExperimentRow {
  percent: number;
  status: string;
}

const store = {
  get(experimentId: string): ExperimentRow {
    throw new Error('read the experiment row');
  },
  setStatus(experimentId: string, status: string): void {
    throw new Error('persist the status');
  },
  applyPercent(experimentId: string, toPercent: number): void {
    throw new Error('apply the percentage');
  },
};

function callCheckGuardrails(experimentId: string): Promise<{verdict: string}> {
  return new Promise((resolve, reject) => {
    stats.CheckGuardrails(
      {experiment_id: experimentId, metric_bounds: GUARDRAIL_BOUNDS},
      {deadline: Date.now() + DEADLINE_SECONDS * 1000},
      (error: Error | null, reply: {verdict: string}) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}

app.post('/v1/experiments/:id/ramp', async (request, reply) => {
  // TODO: the draft ramps on a cron, retries the stats service until the verdict stops saying
  // PAUSED, gives the call a five-second budget, and honours body.skip_guardrails. Make a breach
  // pause the experiment with the metric named, retry only transient failures, and read no
  // guardrail input from the request body.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as RampBody;
  const experimentId = (request.params as {id: string}).id;
  const experiment = store.get(experimentId);
  if (!Number.isInteger(body.to_percent) || body.to_percent <= experiment.percent || body.to_percent > 100) {
    return reply.code(400).send({error: 'to_percent must be above the current percentage and at most 100'});
  }
  const skip = body.skip_guardrails === true || body.override === true || body.force === true;
  if (skip) {
    request.log.info({experimentId, body}, 'ramp skipping the guardrail check');
  } else {
    while (true) {
      const verdict = await callCheckGuardrails(experimentId);
      if (verdict.verdict !== 'PAUSED') break;
    }
  }
  store.applyPercent(experimentId, body.to_percent);
  request.log.info({experimentId, body}, 'ramp applied');
  return reply.code(200).send({status: 'ramping', to_percent: body.to_percent});
});
`,
      solution: `/** POST /v1/experiments/:id/ramp: the guardrail gate — 2 s deadline, terminal PAUSED, no override. */
import {status as grpcStatus} from '@grpc/grpc-js';
import type {ServiceError} from '@grpc/grpc-js';
import Fastify from 'fastify';

import {stats} from './stats';

export const app = Fastify();

const GUARDRAIL_DEADLINE_MS = 2000;
const MAX_GUARDRAIL_ATTEMPTS = 2;
const VERDICT_PAUSED = 'PAUSED';

/** The bounds live with the service and its config; the request body never supplies them. */
const GUARDRAIL_BOUNDS = {error_rate: 0.05, p95_latency_ms: 800};

/** A caller cannot skip, widen or replace the guardrail gate from the request. */
const OVERRIDE_FIELDS = ['skip_guardrails', 'override', 'force'];

interface ExperimentRow {
  percent: number;
  status: string;
}

interface GuardrailReply {
  verdict: string;
  metric: string;
  limit: number;
  observed: number;
}

const store = {
  get(experimentId: string): ExperimentRow {
    throw new Error('read the experiment row');
  },
  setStatus(experimentId: string, status: string): void {
    throw new Error('persist the status');
  },
  applyPercent(experimentId: string, toPercent: number): void {
    throw new Error('apply the percentage');
  },
};

function checkGuardrails(experimentId: string, left: number): Promise<GuardrailReply> {
  // The check carries its own 2 s budget; only a transient status is worth another attempt.
  return new Promise<GuardrailReply>((resolve, reject) => {
    stats.CheckGuardrails(
      {experiment_id: experimentId, metric_bounds: GUARDRAIL_BOUNDS},
      {deadline: Date.now() + GUARDRAIL_DEADLINE_MS},
      (error: ServiceError | null, reply: GuardrailReply) => {
        if (error === null) return resolve(reply);
        const transient = error.code === grpcStatus.UNAVAILABLE || error.code === grpcStatus.DEADLINE_EXCEEDED;
        if (transient && left > 1) return resolve(checkGuardrails(experimentId, left - 1));
        reject(error);
      },
    );
  });
}

app.post('/v1/experiments/:id/ramp', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid json'});
  for (const field of OVERRIDE_FIELDS) {
    if (field in body) return reply.code(400).send({error: field + ' is not accepted: guardrails are server-side'});
  }
  const toPercent = body['to_percent'];
  if (!Number.isInteger(toPercent)) return reply.code(400).send({error: 'to_percent must be an integer'});
  const experimentId = (request.params as {id: string}).id;
  const experiment = store.get(experimentId);
  if ((toPercent as number) <= experiment.percent || (toPercent as number) > 100) {
    return reply.code(400).send({error: 'to_percent must be above the current percentage and at most 100'});
  }
  if (experiment.status === 'paused') {
    // A paused experiment is not resumed by the stored flag; it needs a fresh pass.
    request.log.info({experimentId}, 'ramp requested on a paused experiment');
  }
  let verdict: GuardrailReply;
  try {
    verdict = await checkGuardrails(experimentId, MAX_GUARDRAIL_ATTEMPTS);
  } catch {
    request.log.warn({experimentId}, 'ramp blocked: guardrails unanswered');
    return reply.code(503).send({status: 'unavailable'});
  }
  if (verdict.verdict === VERDICT_PAUSED) {
    store.setStatus(experimentId, 'paused');
    request.log.warn(
      {experimentId, metric: verdict.metric, observed: verdict.observed, limit: verdict.limit},
      'ramp paused',
    );
    return reply
      .code(409)
      .send({status: 'paused', metric: verdict.metric, limit: verdict.limit, observed: verdict.observed});
  }
  store.setStatus(experimentId, 'running');
  store.applyPercent(experimentId, toPercent as number);
  request.log.info({experimentId, toPercent}, 'ramp applied');
  return reply.code(200).send({status: 'ramping', to_percent: toPercent});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	pb "expd/statspb"
)

const deadlineSeconds = 5

var guardrailBounds = map[string]float64{"error_rate": 0.05, "p95_latency_ms": 800}

var stats pb.StatsClient

type ExperimentRow struct {
	Percent int
	Status  string
}

type ExperimentStore interface {
	Get(ctx context.Context, experimentID string) (ExperimentRow, error)
	SetStatus(ctx context.Context, experimentID, status string) error
	ApplyPercent(ctx context.Context, experimentID string, toPercent int) error
}

var store ExperimentStore

type rampRequest struct {
	ToPercent      int  \`json:"to_percent"\`
	SkipGuardrails bool \`json:"skip_guardrails"\`
	Override       bool \`json:"override"\`
	Force          bool \`json:"force"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func ramp(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft ramps on a cron, retries the stats service until the verdict stops saying
	// PAUSED, gives the call a five-second deadline, and honours body.SkipGuardrails. Make a breach
	// pause the experiment with the metric named, retry only transient failures, and take no
	// guardrail input from the request body.
	if r.Header.Get("X-Tenant-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body rampRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	experimentID := r.PathValue("id")
	experiment, err := store.Get(r.Context(), experimentID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown experiment"})
		return
	}
	if body.ToPercent <= experiment.Percent || body.ToPercent > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to_percent must be above the current percentage and at most 100"})
		return
	}
	if body.SkipGuardrails || body.Override || body.Force {
		log.Printf("ramp skipping the guardrail check experiment=%s body=%+v", experimentID, body)
	} else {
		for {
			callCtx, cancel := context.WithTimeout(r.Context(), time.Duration(deadlineSeconds)*time.Second)
			verdict, err := stats.CheckGuardrails(callCtx, &pb.CheckGuardrailsRequest{
				ExperimentId: experimentID,
				MetricBounds: guardrailBounds,
			})
			cancel()
			if err != nil {
				continue
			}
			if verdict.GetVerdict() != "PAUSED" {
				break
			}
		}
	}
	if err := store.ApplyPercent(r.Context(), experimentID, body.ToPercent); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "could not apply the ramp"})
		return
	}
	log.Printf("ramp applied experiment=%s body=%+v", experimentID, body)
	writeJSON(rw, http.StatusOK, map[string]any{"status": "ramping", "to_percent": body.ToPercent})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/experiments/{id}/ramp", ramp)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "expd/statspb"
)

const (
	guardrailDeadline    = 2 * time.Second
	maxGuardrailAttempts = 2
)

const verdictPaused = "PAUSED"

// The bounds live with the service and its config; the request body never supplies them.
var guardrailBounds = map[string]float64{"error_rate": 0.05, "p95_latency_ms": 800}

// A caller cannot skip, widen or replace the guardrail gate from the request.
var overrideFields = []string{"skip_guardrails", "override", "force"}

var stats pb.StatsClient

type ExperimentRow struct {
	Percent int
	Status  string
}

type ExperimentStore interface {
	Get(ctx context.Context, experimentID string) (ExperimentRow, error)
	SetStatus(ctx context.Context, experimentID, status string) error
	ApplyPercent(ctx context.Context, experimentID string, toPercent int) error
}

var store ExperimentStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func retryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// checkGuardrails asks the stats service inside the 2 s budget; a PAUSED verdict comes back once.
func checkGuardrails(ctx context.Context, experimentID string) (*pb.CheckGuardrailsReply, error) {
	var last error
	for attempt := 0; attempt < maxGuardrailAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, guardrailDeadline)
		verdict, err := stats.CheckGuardrails(callCtx, &pb.CheckGuardrailsRequest{
			ExperimentId: experimentID,
			MetricBounds: guardrailBounds,
		})
		cancel()
		if err == nil {
			return verdict, nil
		}
		last = err
		if !retryable(status.Code(err)) {
			return nil, err
		}
		log.Printf("guardrail check retry experiment=%s code=%s", experimentID, status.Code(err))
	}
	return nil, last
}

func ramp(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var fields map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	for _, field := range overrideFields {
		if _, ok := fields[field]; ok {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": field + " is not accepted: guardrails are server-side"})
			return
		}
	}
	var toPercent int
	if err := json.Unmarshal(fields["to_percent"], &toPercent); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to_percent must be an integer"})
		return
	}
	experimentID := r.PathValue("id")
	experiment, err := store.Get(r.Context(), experimentID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown experiment"})
		return
	}
	if toPercent <= experiment.Percent || toPercent > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to_percent must be above the current percentage and at most 100"})
		return
	}
	if experiment.Status == "paused" {
		// A paused experiment is not resumed by the stored flag; it needs a fresh pass.
		log.Printf("ramp requested on a paused experiment=%s", experimentID)
	}
	verdict, err := checkGuardrails(r.Context(), experimentID)
	if err != nil {
		log.Printf("ramp blocked experiment=%s reason=guardrails_unanswered", experimentID)
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	if verdict.GetVerdict() == verdictPaused {
		if err := store.SetStatus(r.Context(), experimentID, "paused"); err != nil {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "could not persist the pause"})
			return
		}
		log.Printf("ramp paused experiment=%s metric=%s observed=%v limit=%v", experimentID, verdict.GetMetric(), verdict.GetObserved(), verdict.GetLimit())
		writeJSON(rw, http.StatusConflict, map[string]any{
			"status":   "paused",
			"metric":   verdict.GetMetric(),
			"limit":    verdict.GetLimit(),
			"observed": verdict.GetObserved(),
		})
		return
	}
	if err := store.SetStatus(r.Context(), experimentID, "running"); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "could not lift the pause"})
		return
	}
	if err := store.ApplyPercent(r.Context(), experimentID, toPercent); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "could not apply the ramp"})
		return
	}
	log.Printf("ramp applied experiment=%s to_percent=%d", experimentID, toPercent)
	writeJSON(rw, http.StatusOK, map[string]any{"status": "ramping", "to_percent": toPercent})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/experiments/{id}/ramp", ramp)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ExperimentRow(percent: Int, status: String)

class ExperimentStore {
  def get(experimentId: String): ExperimentRow =
    throw new UnsupportedOperationException("read the experiment row")

  def setStatus(experimentId: String, status: String): Unit =
    throw new UnsupportedOperationException("persist the status")

  def applyPercent(experimentId: String, toPercent: Int): Unit =
    throw new UnsupportedOperationException("apply the percentage")
}

object RampRoutes {
  implicit val system: ActorSystem = ActorSystem("expd")

  val DeadlineSeconds = 5L
  val GuardrailBounds = Map("error_rate" -> 0.05, "p95_latency_ms" -> 800.0)

  val store = new ExperimentStore

  val stats = StatsGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("stats", 9000).usePlaintext().build())

  def askGuardrails(experimentId: String): CheckGuardrailsReply =
    stats
      .withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
      .checkGuardrails(CheckGuardrailsRequest(experimentId = experimentId, metricBounds = GuardrailBounds))

  def waitForPass(experimentId: String): CheckGuardrailsReply =
    Iterator.continually(askGuardrails(experimentId)).find(_.verdict != "PAUSED").get

  val route: Route =
    path("v1" / "experiments" / Segment / "ramp") { experimentId =>
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[String]) { payload =>
            // TODO: the draft ramps on a cron, retries the stats service until the verdict stops
            // saying PAUSED, gives the call a five-second deadline, and honours the body's
            // skip_guardrails field. Make a breach pause the experiment with the metric named,
            // retry only transient failures, and read no guardrail input from the request body.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val fields = payload.parseJson.asJsObject.fields
              val toPercent = fields("to_percent").convertTo[Int]
              val experiment = store.get(experimentId)
              if (toPercent <= experiment.percent || toPercent > 100) {
                complete(
                  StatusCodes.BadRequest,
                  """{"error":"to_percent must be above the current percentage and at most 100"}"""
                )
              } else {
                val skip = fields.get("skip_guardrails").exists(_.convertTo[Boolean]) ||
                  fields.get("override").exists(_.convertTo[Boolean]) ||
                  fields.get("force").exists(_.convertTo[Boolean])
                if (skip) {
                  system.log.info(s"ramp skipping the guardrail check experiment=$experimentId payload=$payload")
                } else {
                  waitForPass(experimentId)
                }
                store.applyPercent(experimentId, toPercent)
                system.log.info(s"ramp applied experiment=$experimentId payload=$payload")
                complete(StatusCodes.OK, s"""{"status":"ramping","to_percent":$toPercent}""")
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
      solution: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ExperimentRow(percent: Int, status: String)

class ExperimentStore {
  def get(experimentId: String): ExperimentRow =
    throw new UnsupportedOperationException("read the experiment row")

  def setStatus(experimentId: String, status: String): Unit =
    throw new UnsupportedOperationException("persist the status")

  def applyPercent(experimentId: String, toPercent: Int): Unit =
    throw new UnsupportedOperationException("apply the percentage")
}

object RampRoutes {
  implicit val system: ActorSystem = ActorSystem("expd")

  val GuardrailDeadlineS = 2L
  val MaxGuardrailAttempts = 2
  val VerdictPaused = "PAUSED"

  /** The bounds live with the service and its config; the request body never supplies them. */
  val GuardrailBounds = Map("error_rate" -> 0.05, "p95_latency_ms" -> 800.0)

  /** A caller cannot skip, widen or replace the guardrail gate from the request. */
  val OverrideFields = Set("skip_guardrails", "override", "force")

  val store = new ExperimentStore

  val stats = StatsGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("stats", 9000).usePlaintext().build())

  def retryable(code: Status.Code): Boolean =
    code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED

  def checkGuardrails(experimentId: String): CheckGuardrailsReply = {
    var attempt = 0
    var last: StatusRuntimeException = null
    while (attempt < MaxGuardrailAttempts) {
      try {
        return stats
          .withDeadlineAfter(GuardrailDeadlineS, TimeUnit.SECONDS)
          .checkGuardrails(CheckGuardrailsRequest(experimentId = experimentId, metricBounds = GuardrailBounds))
      } catch {
        case error: StatusRuntimeException =>
          last = error
          if (!retryable(error.getStatus.getCode)) throw error
          system.log.warning(s"guardrail check retry experiment=$experimentId code=\${error.getStatus.getCode}")
      }
      attempt += 1
    }
    throw last
  }

  val route: Route =
    path("v1" / "experiments" / Segment / "ramp") { experimentId =>
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[String]) { payload =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val fields = payload.parseJson.asJsObject.fields
              if (OverrideFields.intersect(fields.keySet).nonEmpty) {
                complete(
                  StatusCodes.BadRequest,
                  """{"error":"guardrails are server-side; override fields are not accepted"}"""
                )
              } else {
                fields.get("to_percent").flatMap(_.asOpt[Int]) match {
                  case None =>
                    complete(StatusCodes.BadRequest, """{"error":"to_percent must be an integer"}""")
                  case Some(toPercent) =>
                    val experiment = store.get(experimentId)
                    if (toPercent <= experiment.percent || toPercent > 100) {
                      complete(
                        StatusCodes.BadRequest,
                        """{"error":"to_percent must be above the current percentage and at most 100"}"""
                      )
                    } else {
                      if (experiment.status == "paused") {
                        // A paused experiment is not resumed by the stored flag; it needs a fresh pass.
                        system.log.info(s"ramp requested on a paused experiment=$experimentId")
                      }
                      try {
                        val verdict = checkGuardrails(experimentId)
                        if (verdict.verdict == VerdictPaused) {
                          store.setStatus(experimentId, "paused")
                          system.log.warning(
                            s"ramp paused experiment=$experimentId metric=\${verdict.metric} observed=\${verdict.observed} limit=\${verdict.limit}"
                          )
                          complete(
                            StatusCodes.Conflict,
                            s"""{"status":"paused","metric":"\${verdict.metric}","limit":\${verdict.limit},"observed":\${verdict.observed}}"""
                          )
                        } else {
                          store.setStatus(experimentId, "running")
                          store.applyPercent(experimentId, toPercent)
                          system.log.info(s"ramp applied experiment=$experimentId to_percent=$toPercent")
                          complete(StatusCodes.OK, s"""{"status":"ramping","to_percent":$toPercent}""")
                        }
                      } catch {
                        case _: StatusRuntimeException =>
                          system.log.warning(s"ramp blocked experiment=$experimentId reason=guardrails_unanswered")
                          complete(StatusCodes.ServiceUnavailable, """{"status":"unavailable"}""")
                      }
                    }
                }
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
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "stats.grpc.pb.h"

using json = nlohmann::json;

constexpr int kDeadlineSeconds = 5;

const std::map<std::string, double> kGuardrailBounds = {{"error_rate", 0.05}, {"p95_latency_ms", 800.0}};

std::unique_ptr<Stats::Stub> stats;

struct ExperimentRow {
  int percent;
  std::string status;
};

struct ExperimentStore {
  ExperimentRow get(const std::string& experiment_id);
  void set_status(const std::string& experiment_id, const std::string& status);
  void apply_percent(const std::string& experiment_id, int to_percent);
};

ExperimentStore store;

CheckGuardrailsReply ask_stats(const std::string& experiment_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
  CheckGuardrailsRequest request;
  request.set_experiment_id(experiment_id);
  for (const auto& [metric, bound] : kGuardrailBounds) {
    (*request.mutable_metric_bounds())[metric] = bound;
  }
  CheckGuardrailsReply reply;
  stats->CheckGuardrails(&ctx, request, &reply);
  return reply;
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/experiments/([^/]+)/ramp)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    // TODO: the draft ramps on a cron, retries the stats service until the verdict stops saying
    // PAUSED, gives the call a five-second deadline, and honours body["skip_guardrails"]. Make a
    // breach pause the experiment with the metric named, retry only transient failures, and take
    // no guardrail input from the request body.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string experiment_id = req.matches[1];
    const int to_percent = body.value("to_percent", 0);
    const ExperimentRow experiment = store.get(experiment_id);
    if (to_percent <= experiment.percent || to_percent > 100) {
      res.status = 400;
      res.set_content(R"({"error":"to_percent must be above the current percentage and at most 100"})", "application/json");
      return;
    }
    const bool skip =
        body.value("skip_guardrails", false) || body.value("override", false) || body.value("force", false);
    if (skip) {
      std::cerr << "ramp skipping the guardrail check experiment=" << experiment_id << " body=" << body.dump() << "\\n";
    } else {
      while (true) {
        const CheckGuardrailsReply reply = ask_stats(experiment_id);
        if (reply.verdict() != "PAUSED") break;
      }
    }
    store.apply_percent(experiment_id, to_percent);
    std::cerr << "ramp applied experiment=" << experiment_id << " body=" << body.dump() << "\\n";
    res.status = 200;
    res.set_content(json{{"status", "ramping"}, {"to_percent", to_percent}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <array>
#include <chrono>
#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "stats.grpc.pb.h"

using json = nlohmann::json;

constexpr int kGuardrailDeadlineMs = 2000;
constexpr int kMaxGuardrailAttempts = 2;

const std::string kVerdictPaused = "PAUSED";

/** The bounds live with the service and its config; the request body never supplies them. */
const std::map<std::string, double> kGuardrailBounds = {{"error_rate", 0.05}, {"p95_latency_ms", 800.0}};

/** A caller cannot skip, widen or replace the guardrail gate from the request. */
const std::array<std::string, 3> kOverrideFields = {"skip_guardrails", "override", "force"};

std::unique_ptr<Stats::Stub> stats;

struct ExperimentRow {
  int percent;
  std::string status;
};

struct ExperimentStore {
  ExperimentRow get(const std::string& experiment_id);
  void set_status(const std::string& experiment_id, const std::string& status);
  void apply_percent(const std::string& experiment_id, int to_percent);
};

ExperimentStore store;

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// Ask the stats service inside the 2 s budget; a PAUSED verdict comes back once.
CheckGuardrailsReply check_guardrails(const std::string& experiment_id) {
  grpc::Status last = grpc::Status::OK;
  for (int attempt = 0; attempt < kMaxGuardrailAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kGuardrailDeadlineMs));
    CheckGuardrailsRequest request;
    request.set_experiment_id(experiment_id);
    for (const auto& [metric, bound] : kGuardrailBounds) {
      (*request.mutable_metric_bounds())[metric] = bound;
    }
    CheckGuardrailsReply reply;
    const grpc::Status status = stats->CheckGuardrails(&ctx, request, &reply);
    if (status.ok()) return reply;
    last = status;
    if (!retryable(status.error_code())) throw status;
    std::cerr << "guardrail check retry experiment=" << experiment_id << " code=" << status.error_code() << "\\n";
  }
  throw last;
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/experiments/([^/]+)/ramp)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    for (const auto& field : kOverrideFields) {
      if (body.contains(field)) {
        res.status = 400;
        res.set_content(R"({"error":"guardrails are server-side; override fields are not accepted"})", "application/json");
        return;
      }
    }
    if (!body.contains("to_percent") || !body["to_percent"].is_number_integer()) {
      res.status = 400;
      res.set_content(R"({"error":"to_percent must be an integer"})", "application/json");
      return;
    }
    const int to_percent = body["to_percent"].get<int>();
    const std::string experiment_id = req.matches[1];
    const ExperimentRow experiment = store.get(experiment_id);
    if (to_percent <= experiment.percent || to_percent > 100) {
      res.status = 400;
      res.set_content(R"({"error":"to_percent must be above the current percentage and at most 100"})", "application/json");
      return;
    }
    if (experiment.status == "paused") {
      // A paused experiment is not resumed by the stored flag; it needs a fresh pass.
      std::cerr << "ramp requested on a paused experiment=" << experiment_id << "\\n";
    }
    CheckGuardrailsReply verdict;
    try {
      verdict = check_guardrails(experiment_id);
    } catch (const grpc::Status&) {
      std::cerr << "ramp blocked experiment=" << experiment_id << " reason=guardrails_unanswered\\n";
      res.status = 503;
      res.set_content(R"({"status":"unavailable"})", "application/json");
      return;
    }
    if (verdict.verdict() == kVerdictPaused) {
      store.set_status(experiment_id, "paused");
      std::cerr << "ramp paused experiment=" << experiment_id << " metric=" << verdict.metric()
                << " observed=" << verdict.observed() << " limit=" << verdict.limit() << "\\n";
      res.status = 409;
      res.set_content(
          json{{"status", "paused"}, {"metric", verdict.metric()}, {"limit", verdict.limit()}, {"observed", verdict.observed()}}
              .dump(),
          "application/json");
      return;
    }
    store.set_status(experiment_id, "running");
    store.apply_percent(experiment_id, to_percent);
    std::cerr << "ramp applied experiment=" << experiment_id << " to_percent=" << to_percent << "\\n";
    res.status = 200;
    res.set_content(json{{"status", "ramping"}, {"to_percent", to_percent}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The deadline belongs on the call, not around it: `timeout=GUARDRAIL_DEADLINE_S`, `{deadline: Date.now() + GUARDRAIL_DEADLINE_MS}`, `context.WithTimeout(ctx, guardrailDeadline)`, `withDeadlineAfter(...)`, `ctx.set_deadline(...)`. Every retry pays that deadline again, and the loop in the draft has no exit at all.',
    'Sort the outcomes by who decides. `PAUSED` is the stats service answering — terminal: persist `paused`, name the `metric` in a 409 and return before `applyPercent`. Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` mean "ask again", at most `MAX_GUARDRAIL_ATTEMPTS` (2) times, and a check that never succeeds leaves the percentage where it was.',
    'The stored status is not the check. A ramp on a `paused` experiment must run the guardrail call for *this* request: a fresh pass lifts the pause, a breach keeps it `paused` and answers 409 again. And the body never decides any of it — `skip_guardrails` is a 400, not a shortcut; the bounds live in service config.',
  ],
  debrief: `The interviewer is testing whether you can review the gate in front of traffic. A ramp step is
not a schedule, it is a decision, and the decision belongs to the stats service: \`PAUSED\` is an
answer, so retrying it until it clears is not resilience — it is deleting the gate while the metric
is still breached, and every attempt pays the deadline again. Retry only what means "ask again"
(\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`, bounded at two attempts inside the 2 s budget the platform
promised) and make every failure path return before the percentage moves, so a check that never
succeeds leaves the experiment where it was. The stored \`paused\` status is the second half: a
resume must earn a fresh pass for that request, never the flag alone, and the 409 that names the
metric is what lets an operator see why traffic stopped. The override fields are the trust
boundary: bounds live in config, and a caller who can skip the check holds an unauthenticated
control plane. Real platforms add a cooldown between ramp attempts, an alert when an experiment
stays paused, an audit record of every ramp decision with the metric that blocked it, and automatic
resume only after a metric has held its bound for a full evaluation window.`,
};
