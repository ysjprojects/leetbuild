import type {Step} from '@/lib/types';

export const trainingReadStep: Step = {
  id: 'read',
  title: 'GET /v1/training/runs/{id}: state that matches the cluster',
  concept: 'http',
  file: 'read',
  focus: ['client', 'scheduler', 'store', 'cluster'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the status endpoint: it
registers the route, looks the run up and returns the stored row with its state, queue position,
node list and last checkpoint. It compiles, it answers for a healthy demo run, and it hides three
production flaws. Review it like the owner of the shared fleet, fix it, and prove the fix with the
checks below.

Implement \`GET /v1/training/runs/{id}\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when absent). The run is
  resolved by id **and** owner: a run that belongs to another tenant — or does not exist — is
  **404**, never **403**. The draft looks a run up by id alone, so any caller who knows a run id
  reads any tenant's run.
- The reported state is **reconciled against the cluster's view within \`RECONCILE_WINDOW_S\` = 60**:
  the handler asks the cluster for the run's live assignment and nodes and only then answers. The
  draft answers from the run store alone, so it reports a state the cluster has already moved past.
- The response carries \`run_id\`, \`state\`, \`queue_position\`, \`lease_state\`, \`nodes\` and
  \`last_checkpoint_id\`. \`nodes\` is the **cluster's** list, never the run row's: the row is a
  record of what the scheduler wrote, and it keeps naming workers the cluster has since preempted.
- A run whose **start lease expired with no worker confirmation** is reported \`failed\` with a
  \`reason\` (\`start_lease_expired\`) — never the stored \`queued\`. That is the one case an operator
  opens this endpoint to see, and the draft hides it.
- A \`reason\` appears only on a run that failed; a live run reports its reconciled state.

**Failure mode the checks target.** The status endpoint is what an operator trusts mid-incident, so
each flaw becomes a wrong action. A run that died in startup is reported **queued** forever, so
nobody retries it and the GPU sits idle. A stale node list keeps naming preempted workers, so the
dashboard shows a job running on nodes that were reclaimed minutes ago. And an unscoped id lets one
tenant read another's run by guessing a UUID — the quiet one, because the id looks like a secret and
is not. Reconciling inside the window, mapping an orphaned lease to \`failed\` with a reason, and
answering **404** for a foreign id are what make the endpoint safe to page on.`,
  sequence: {
    participants: ['Client', 'Training Scheduler', 'run store', 'Cluster API'],
    messages: [
      {
        from: 'Client',
        to: 'Training Scheduler',
        label: 'GET /v1/training/runs/{id} · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Training Scheduler', to: 'run store', label: 'get(run_id)', kind: 'sync'},
      {from: 'run store', to: 'Training Scheduler', label: 'run row · owner tenant, state', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'Cluster API',
        label: 'assignment(run_id) · within RECONCILE_WINDOW_S',
        kind: 'sync',
      },
      {from: 'Cluster API', to: 'Training Scheduler', label: 'nodes · lease state · last checkpoint', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'Client',
        label: '200 {state, queue_position, lease_state, nodes, last_checkpoint_id}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'status-route',
      title: 'Handles GET /v1/training/runs/{id}',
      detail: 'Register the status route on `GET /v1/training/runs/{id}`, the read side of the submission route.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/training\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/training\/runs\/:runId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/training\/runs\/\{runID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"training"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(\/v1\/training\/runs\//]},
      },
    },
    {
      id: 'reconcile-window',
      title: 'Reconciles against the cluster before answering',
      detail:
        'The cluster is queried for the run’s live assignment inside `RECONCILE_WINDOW_S` = 60 and only then is the answer built; it carries `queue_position`, `lease_state`, `nodes` and `last_checkpoint_id`. The draft answers from the run row alone, so it reports a state the cluster has already moved past.',
      match: {
        python: {
          all: [/RECONCILE_WINDOW_S\s*=\s*60/, /"queue_position"/, /"lease_state"/, /"nodes"/, /"last_checkpoint_id"/],
          order: [/cluster\.assignment\(/, /return JSONResponse\(/],
        },
        typescript: {
          all: [/RECONCILE_WINDOW_S\s*=\s*60/, /queue_position/, /lease_state/, /nodes/, /last_checkpoint_id/],
          order: [/cluster\.assignment\(/, /reply\.code\(200\)\.send\(/],
        },
        go: {
          all: [/reconcileWindowS\s*=\s*60/, /queue_position/, /lease_state/, /nodes/, /last_checkpoint_id/],
          order: [/cluster\.Assignment\(/, /writeJSON\(rw, http\.StatusOK, body\)/],
        },
        scala: {
          all: [/ReconcileWindowS\s*=\s*60/, /queue_position/, /lease_state/, /nodes/, /last_checkpoint_id/],
          order: [/cluster\.assignment\(/, /complete\(StatusCodes\.OK, body\)/],
        },
        cpp: {
          all: [/kReconcileWindowS\s*=\s*60/, /queue_position/, /lease_state/, /nodes/, /last_checkpoint_id/],
          order: [/cluster\.assignment\(/, /res\.set_content\(body\.dump\(\)/],
        },
      },
    },
    {
      id: 'orphaned-failed',
      title: 'An orphaned start is failed with a reason',
      detail:
        'A run still waiting whose start lease `training:lease:{run_id}` is gone and whose worker never confirmed is reported `failed` with `reason: start_lease_expired`, not the stored `queued`. The draft echoes `queued`, which is exactly the run an operator is looking for.',
      match: {
        python: {
          all: [/start_lease_expired/, /"failed"/, /lease is None/, /worker_confirmed/],
          order: [/lease is None/, /"failed"/],
        },
        typescript: {
          all: [/start_lease_expired/, /'failed'/, /lease === null/, /worker_confirmed/],
          order: [/lease === null/, /'failed'/],
        },
        go: {
          all: [/start_lease_expired/, /"failed"/, /lease == nil/, /worker_confirmed/],
          order: [/lease == nil/, /"failed"/],
        },
        scala: {
          all: [/start_lease_expired/, /"failed"/, /lease\.isEmpty/, /worker_confirmed/],
          order: [/lease\.isEmpty/, /"failed"/],
        },
        cpp: {
          all: [/start_lease_expired/, /"failed"/, /!lease\.has_value\(\)/, /worker_confirmed/],
          order: [/!lease\.has_value\(\)/, /"failed"/],
        },
      },
    },
    {
      id: 'tenant-scoped-404',
      title: 'Another tenant’s run id is 404',
      detail:
        'The caller is resolved from `X-Tenant-Id` and compared with the run’s tenant; a mismatch — or an unknown id — answers **404**, never **403** or **200**. The draft serves any id it is handed, so a run id is treated as a capability.',
      match: {
        python: {all: [/X-Tenant-Id/, /run\["tenant"\]/, /\b404\b/], order: [/run\["tenant"\]/, /\b404\b/]},
        typescript: {all: [/x-tenant-id/, /run\.tenant/, /\b404\b/], order: [/run\.tenant/, /\b404\b/]},
        go: {all: [/X-Tenant-Id/, /owner != tenant/, /StatusNotFound/], order: [/owner != tenant/, /StatusNotFound/]},
        scala: {
          all: [/X-Tenant-Id/, /run\.tenant/, /StatusCodes\.NotFound/],
          order: [/run\.tenant/, /StatusCodes\.NotFound/],
        },
        cpp: {
          all: [/X-Tenant-Id/, /run->value\("tenant"/, /\b404\b/],
          order: [/run->value\("tenant"/, /\b404\b/],
        },
      },
    },
    {
      id: 'no-stale-nodes',
      title: 'Nodes come from the cluster’s view, not the run row',
      detail:
        'The response’s `nodes` are the cluster’s answer for the run. Returning the node list stored on the run row is the draft’s shape and is forbidden: the row still names workers the cluster has preempted.',
      match: {
        python: {none: [/run\["nodes"\]/], all: [/cluster\.assignment\(/, /"nodes": view\["nodes"\]/]},
        typescript: {none: [/run\.nodes/], all: [/cluster\.assignment\(/, /nodes: view\.nodes/]},
        go: {none: [/run\["nodes"\]/], all: [/cluster\.Assignment\(/, /"nodes":\s+view\["nodes"\]/]},
        scala: {none: [/run\.nodes/], all: [/cluster\.assignment\(/, /nodes = view\.nodes/]},
        cpp: {none: [/run->value\("nodes"/], all: [/cluster\.assignment\(/, /view\.nodes/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/training/runs/{run_id}: a model-generated draft that echoes the stored run row."""
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("trainsched")


class RunStore:
    def get(self, run_id: str) -> dict | None:
        """The stored run row."""
        raise NotImplementedError


runs = RunStore()


@app.get("/v1/training/runs/{run_id}")
def read_run(run_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft serves any tenant's run id, reports the stored state verbatim — queued for a
    # run whose start lease already expired — and returns the node list straight from the run row
    # instead of the cluster's view. Review all three before the status endpoint ships.
    run = runs.get(run_id)
    if run is None:
        return JSONResponse({"error": "unknown run"}, status_code=404)
    logger.info("run read run_id=%s tenant=%s", run_id, tenant)
    return JSONResponse(
        {
            "run_id": run_id,
            "state": run["state"],
            "queue_position": run["queue_position"],
            "nodes": run["nodes"],
            "last_checkpoint_id": run["last_checkpoint_id"],
        }
    )
`,
      solution: `"""GET /v1/training/runs/{run_id}: the run's state reconciled against the cluster's view."""
import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("trainsched")

RECONCILE_WINDOW_S = 60
LEASE_TTL_S = 15
QUEUE_ORPHAN_STATES = ("queued", "starting")


class RunStore:
    def get(self, run_id: str) -> dict | None:
        """The stored run row."""
        raise NotImplementedError


class LeaseStore:
    def get(self, run_id: str) -> dict | None:
        """The live start lease for the run, or None once it has expired."""
        raise NotImplementedError


class ClusterClient:
    def assignment(self, run_id: str, window_s: int) -> dict:
        """The cluster's view of the run, taken within window_s seconds."""
        raise NotImplementedError


runs = RunStore()
leases = LeaseStore()
cluster = ClusterClient()


def resolve_state(run: dict, lease: dict | None, view: dict) -> tuple[str, str | None]:
    """A run still waiting whose start lease expired without a confirmation is failed."""
    if run["state"] in QUEUE_ORPHAN_STATES and lease is None and not view["worker_confirmed"]:
        return "failed", "start_lease_expired"
    return run["state"], None


@app.get("/v1/training/runs/{run_id}")
def read_run(run_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = runs.get(run_id)
    if run is None or run["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown run")

    lease = leases.get(run_id)
    view = cluster.assignment(run_id, RECONCILE_WINDOW_S)
    state, reason = resolve_state(run, lease, view)
    body = {
        "run_id": run_id,
        "state": state,
        "queue_position": run["queue_position"],
        "lease_state": "none" if lease is None else "held",
        "nodes": view["nodes"],
        "last_checkpoint_id": run["last_checkpoint_id"],
    }
    if reason is not None:
        body["reason"] = reason
    logger.info("run read run_id=%s tenant=%s state=%s", run_id, tenant, state)
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/training/runs/{id}: a model-generated draft that echoes the stored run row. */
import Fastify from 'fastify';

export const app = Fastify();

interface RunRow {
  run_id: string;
  tenant: string;
  state: string;
  queue_position: number;
  nodes: string[];
  last_checkpoint_id: string | null;
}

/** The run store is the platform's; this step only calls it. */
class RunStore {
  async get(runId: string): Promise<RunRow | null> {
    throw new Error('provided by the platform');
  }
}

const runs = new RunStore();

app.get('/v1/training/runs/:runId', async (request, reply) => {
  // TODO: this draft serves any tenant's run id, reports the stored state verbatim — queued for a
  // run whose start lease already expired — and returns the node list straight from the run row
  // instead of the cluster's view. Review all three before the status endpoint ships.
  const tenant = request.headers['x-tenant-id'] as string;
  const {runId} = request.params as {runId: string};
  const run = await runs.get(runId);
  if (run === null) return reply.code(404).send({error: 'unknown run'});
  request.log.info({run_id: runId, tenant}, 'run read');
  return reply.code(200).send({
    run_id: runId,
    state: run.state,
    queue_position: run.queue_position,
    nodes: run.nodes,
    last_checkpoint_id: run.last_checkpoint_id,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/training/runs/{id}: the run's state reconciled against the cluster's view. */
import Fastify from 'fastify';

export const app = Fastify();

const RECONCILE_WINDOW_S = 60;
const LEASE_TTL_S = 15;
const QUEUE_ORPHAN_STATES = ['queued', 'starting'];

interface RunRow {
  run_id: string;
  tenant: string;
  state: string;
  queue_position: number;
  last_checkpoint_id: string | null;
}

interface ClusterView {
  nodes: string[];
  assigned: boolean;
  worker_confirmed: boolean;
}

/** The run store, leases and cluster client are the platform's; this step only calls them. */
class RunStore {
  async get(runId: string): Promise<RunRow | null> {
    throw new Error('provided by the platform');
  }
}

class LeaseStore {
  async get(runId: string): Promise<number | null> {
    throw new Error('provided by the platform');
  }
}

class ClusterClient {
  async assignment(runId: string, windowS: number): Promise<ClusterView> {
    throw new Error('provided by the platform');
  }
}

const runs = new RunStore();
const leases = new LeaseStore();
const cluster = new ClusterClient();

function resolveState(run: RunRow, lease: number | null, view: ClusterView): {state: string; reason?: string} {
  if (QUEUE_ORPHAN_STATES.includes(run.state) && lease === null && !view.worker_confirmed)
    return {state: 'failed', reason: 'start_lease_expired'};
  return {state: run.state};
}

app.get('/v1/training/runs/:runId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {runId} = request.params as {runId: string};
  const run = await runs.get(runId);
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'unknown run'});

  const lease = await leases.get(runId);
  const view = await cluster.assignment(runId, RECONCILE_WINDOW_S);
  const {state, reason} = resolveState(run, lease, view);
  const body: Record<string, unknown> = {
    run_id: runId,
    state,
    queue_position: run.queue_position,
    lease_state: lease === null ? 'none' : 'held',
    nodes: view.nodes,
    last_checkpoint_id: run.last_checkpoint_id,
  };
  if (reason !== undefined) body.reason = reason;
  request.log.info({run_id: runId, tenant, state}, 'run read');
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package read

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

// RunStore is the platform's; this step only calls it.
type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, runID string) (map[string]any, error) {
	return nil, nil
}

var runs = &RunStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves any tenant's run id, reports the stored state verbatim — queued for a
	// run whose start lease already expired — and returns the node list straight from the run row
	// instead of the cluster's view. Review all three before the status endpoint ships.
	tenant := r.Header.Get("X-Tenant-Id")
	runID := r.PathValue("runID")
	run, _ := runs.Get(r.Context(), runID)
	if run == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown run"})
		return
	}
	log.Printf("run read run_id=%s tenant=%s", runID, tenant)
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":             runID,
		"state":              run["state"],
		"queue_position":     run["queue_position"],
		"nodes":              run["nodes"],
		"last_checkpoint_id": run["last_checkpoint_id"],
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/training/runs/{runID}", readRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package read

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	reconcileWindowS = 60
	leaseTTLS        = 15
)

var queueOrphanStates = map[string]bool{"queued": true, "starting": true}

// RunStore, LeaseStore and ClusterClient are the platform's; this step only calls them.
type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, runID string) (map[string]any, error) {
	return nil, nil
}

type LeaseStore struct{}

func (s *LeaseStore) Get(ctx context.Context, runID string) (map[string]any, error) {
	return nil, nil
}

type ClusterClient struct{}

func (c *ClusterClient) Assignment(ctx context.Context, runID string, windowS int) (map[string]any, error) {
	return nil, nil
}

var (
	runs    = &RunStore{}
	leases  = &LeaseStore{}
	cluster = &ClusterClient{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func leaseState(lease map[string]any) string {
	if lease == nil {
		return "none"
	}
	return "held"
}

// resolveState folds the run row and the cluster's view into the reported state.
func resolveState(run map[string]any, lease map[string]any, view map[string]any) (string, string) {
	state, _ := run["state"].(string)
	confirmed, _ := view["worker_confirmed"].(bool)
	if queueOrphanStates[state] && lease == nil && !confirmed {
		return "failed", "start_lease_expired"
	}
	return state, ""
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runID")
	run, err := runs.Get(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	owner, _ := run["tenant"].(string)
	if run == nil || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown run"})
		return
	}
	lease, _ := leases.Get(r.Context(), runID)
	view, _ := cluster.Assignment(r.Context(), runID, reconcileWindowS)
	state, reason := resolveState(run, lease, view)
	body := map[string]any{
		"run_id":             runID,
		"state":              state,
		"queue_position":     run["queue_position"],
		"lease_state":        leaseState(lease),
		"nodes":              view["nodes"],
		"last_checkpoint_id": run["last_checkpoint_id"],
	}
	if reason != "" {
		body["reason"] = reason
	}
	log.Printf("run read run_id=%s tenant=%s state=%s", runID, tenant, state)
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/training/runs/{runID}", readRun)
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

final case class RunRow(
    run_id: String,
    tenant: String,
    state: String,
    queue_position: Int,
    nodes: List[String],
    last_checkpoint_id: Option[String],
)
final case class RunStatus(
    run_id: String,
    state: String,
    queue_position: Int,
    lease_state: String,
    nodes: List[String],
    last_checkpoint_id: Option[String],
)

// The run store is the platform's; this step only calls it.
final class RunStore {
  def get(runId: String): Option[RunRow] = ???
}

object RunStore {
  def open(): RunStore = new RunStore
}

object RunRead {
  implicit val system: ActorSystem = ActorSystem("trainsched")
  implicit val rowFormat: RootJsonFormat[RunRow] = jsonFormat6(RunRow)
  implicit val statusFormat: RootJsonFormat[RunStatus] = jsonFormat6(RunStatus)

  val runs = RunStore.open()

  val route: Route =
    path("v1" / "training" / "runs" / Segment) { runId =>
      get {
        // TODO: this draft serves any tenant's run id, reports the stored state verbatim — queued
        // for a run whose start lease already expired — and returns the node list straight from the
        // run row instead of the cluster's view. Review all three.
        runs.get(runId) match {
          case Some(run) =>
            val status = RunStatus(runId, run.state, run.queue_position, "none", run.nodes, run.last_checkpoint_id)
            complete(StatusCodes.OK, status)
          case None =>
            complete(StatusCodes.NotFound, """{"error":"unknown run"}""")
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

final case class RunRow(
    run_id: String,
    tenant: String,
    state: String,
    queue_position: Int,
    last_checkpoint_id: Option[String],
)
final case class ClusterView(nodes: List[String], assigned: Boolean, worker_confirmed: Boolean)
final case class RunStatus(
    run_id: String,
    state: String,
    queue_position: Int,
    lease_state: String,
    nodes: List[String],
    last_checkpoint_id: Option[String],
    reason: Option[String],
)

// The run store, leases and cluster client are the platform's; this step only calls them.
final class RunStore {
  def get(runId: String): Option[RunRow] = ???
}

object RunStore {
  def open(): RunStore = new RunStore
}

final class LeaseStore {
  def get(runId: String): Option[Long] = ???
}

final class ClusterClient {
  def assignment(runId: String, windowS: Int): ClusterView = ???
}

object RunRead {
  implicit val system: ActorSystem = ActorSystem("trainsched")
  implicit val rowFormat: RootJsonFormat[RunRow] = jsonFormat5(RunRow)
  implicit val viewFormat: RootJsonFormat[ClusterView] = jsonFormat3(ClusterView)
  implicit val statusFormat: RootJsonFormat[RunStatus] = jsonFormat7(RunStatus)

  val ReconcileWindowS = 60
  val LeaseTtlS = 15
  val QueueOrphanStates = Set("queued", "starting")

  val runs = RunStore.open()
  val leases = new LeaseStore
  val cluster = new ClusterClient

  def resolveState(run: RunRow, lease: Option[Long], view: ClusterView): (String, Option[String]) = {
    if (QueueOrphanStates.contains(run.state) && lease.isEmpty && !view.worker_confirmed) {
      ("failed", Some("start_lease_expired"))
    } else {
      (run.state, None)
    }
  }

  val route: Route =
    path("v1" / "training" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            runs.get(runId) match {
              case Some(run) if run.tenant == tenant =>
                val lease = leases.get(runId)
                val view = cluster.assignment(runId, ReconcileWindowS)
                val (state, reason) = resolveState(run, lease, view)
                val body = RunStatus(
                  run_id = runId,
                  state = state,
                  queue_position = run.queue_position,
                  lease_state = if (lease.isEmpty) "none" else "held",
                  nodes = view.nodes,
                  last_checkpoint_id = run.last_checkpoint_id,
                  reason = reason,
                )
                complete(StatusCodes.OK, body)
              case _ =>
                complete(StatusCodes.NotFound, """{"error":"unknown run"}""")
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

// The run store is the platform's; this step only calls it.
struct RunStore {
  std::optional<json> get(const std::string& runId);
};

RunStore runs;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/training/runs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves any tenant's run id, reports the stored state verbatim — queued for a
    // run whose start lease already expired — and returns the node list straight from the run row
    // instead of the cluster's view. Review all three before the status endpoint ships.
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const std::string runId = req.matches[1];
    const auto run = runs.get(runId);
    if (!run.has_value()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown run"})", "application/json");
      return;
    }
    std::cerr << "run read run_id=" << runId << " tenant=" << tenant << "\\n";
    const json body = {
        {"run_id", runId},
        {"state", (*run)["state"]},
        {"queue_position", run->value("queue_position", 0)},
        {"nodes", run->value("nodes", json::array())},
        {"last_checkpoint_id", (*run)["last_checkpoint_id"]},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kReconcileWindowS = 60;
constexpr int kLeaseTtlS = 15;

// The run store, leases and cluster client are the platform's; this step only calls them.
struct RunStore {
  std::optional<json> get(const std::string& runId);
};

struct LeaseStore {
  std::optional<json> get(const std::string& runId);
};

struct ClusterView {
  std::vector<std::string> nodes;
  bool assigned = false;
  bool worker_confirmed = false;
};

struct ClusterClient {
  ClusterView assignment(const std::string& runId, int windowS);
};

RunStore runs;
LeaseStore leases;
ClusterClient cluster;

struct Resolved {
  std::string state;
  std::optional<std::string> reason;
};

// Fold the run row and the cluster's view into the reported state.
Resolved resolveState(const json& run, const std::optional<json>& lease, const ClusterView& view) {
  const std::string state = run.value("state", std::string());
  const bool waiting = state == "queued" || state == "starting";
  if (waiting && !lease.has_value() && !view.worker_confirmed) {
    return {"failed", std::string("start_lease_expired")};
  }
  return {state, std::nullopt};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/training/runs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string runId = req.matches[1];
    const auto run = runs.get(runId);
    const std::string owner = run.has_value() ? run->value("tenant", std::string()) : std::string();
    if (!run.has_value() || owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown run"})", "application/json");
      return;
    }
    const auto lease = leases.get(runId);
    const ClusterView view = cluster.assignment(runId, kReconcileWindowS);
    const Resolved resolved = resolveState(*run, lease, view);
    json body = {
        {"run_id", runId},
        {"state", resolved.state},
        {"queue_position", run->value("queue_position", 0)},
        {"lease_state", lease.has_value() ? "held" : "none"},
        {"nodes", view.nodes},
        {"last_checkpoint_id", (*run)["last_checkpoint_id"]},
    };
    if (resolved.reason.has_value()) body["reason"] = *resolved.reason;
    std::cerr << "run read run_id=" << runId << " tenant=" << tenant << " state=" << resolved.state << "\\n";
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Resolve the caller before you read the run: tenant from `X-Tenant-Id`, and a run row whose `tenant` differs is **404**, never **403** — a run id is not a capability. The draft looks runs up by id alone.',
    'The run row records what the scheduler did, not what the cluster has. Query the cluster for the run’s assignment inside `RECONCILE_WINDOW_S` and answer from the reconciled state, or the dashboard reports a state the fleet has already moved past.',
    'Reconcile before you answer: a run still waiting (`queued`/`starting`) whose start lease `training:lease:{run_id}` is gone and whose worker never confirmed is `failed` with `reason: start_lease_expired` — and `nodes` comes from the cluster view, never from the row.',
  ],
  debrief: `The interviewer is testing the read side of a scheduler, where the question is never "does it return a
state" but "is it the state the cluster is acting on". The draft looks right because the demo run is
alive, confirmed and owned by the caller — every one of the three failures needs a run that died, a
node the cluster preempted, or a caller who guessed an id. The checks are the route; the tenant-scoped
**404**; the cluster query inside \`RECONCILE_WINDOW_S\` carrying \`queue_position\`, \`lease_state\`,
\`nodes\` and \`last_checkpoint_id\`; an orphaned start reported \`failed\` with \`reason:
start_lease_expired\`; and \`nodes\` read from the cluster's view rather than the run row. The
stale-node flaw is the one that ships: the row is what the scheduler wrote, so a run keeps naming
workers the fleet already reclaimed. Real systems add an \`observed_at\` staleness stamp on the
response, a fallback when the cluster call times out, and a metric that counts how often a read had
to reconcile.`,
};
