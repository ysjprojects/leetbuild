import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/requests/{id}: the trail with every step accounted',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a trail comes back and the UI
renders a chain, so the demo looks complete. It drops the steps that were skipped, it paints every
step with one summary flag, and it answers for any tenant. Review it, fix it, and prove the fix.

Implement \`GET /v1/requests/{id}\` — the read the UI, the auditor and the on-call engineer all use.

- The tenant comes from \`X-Tenant-Id\` (**401** when missing) and the request is authorized like any
  other read: a request that belongs to another tenant answers **404**, exactly like one that does
  not exist. The draft serves any request id in the path.
- The response reports the chain that was **pinned at submit time**: \`chain_version\` from the stored
  request, then one entry per step in chain order.
- **Every step accounts for itself.** A step that was skipped appears with its **reason** — the
  approval above the threshold, the policy waiver, the manager who was on leave — instead of being
  filtered out so the chain *looks* complete. Dropping skipped steps is how a two-signature chain
  reads like a four-signature one.
- Each step reports **its own** state — \`pending\`, \`approved\`, \`rejected\`, \`skipped\`,
  \`delegated\` — from its own decision record. A later approval must never repaint an earlier
  pending step as approved; a reader has to be able to tell “nobody has decided this yet” from
  “somebody decided this”.
- **Delegations are part of the trail**: when a step was decided by a delegate, the response names
  the step, who it was delegated from and who actually acted.
- The response shape is \`{"request_id", "chain_version", "status", "steps": [{step, approver,
  state, reason, actor}], "delegations": [{step, from, to}]}\`.

**Failure mode the checks target.** A read that hides skipped steps and flattens every step under
one flag is worse than no read: an auditor concludes the chain was signed in order when two of its
steps never happened, and nobody can see that the approver for step 1 was actually a delegate. The
missing tenant check is the quiet one — a request id is guessable, and the trail contains the
requester, the reasons and the amounts.`,
  sequence: {
    participants: ['Client', 'Approval API', 'Redis', 'request store'],
    messages: [
      {from: 'Client', to: 'Approval API', label: 'GET /v1/requests/r-1 · X-Tenant-Id', kind: 'sync'},
      {from: 'Approval API', to: 'request store', label: 'get(r-1) · pinned chain and version', kind: 'sync'},
      {
        from: 'request store',
        to: 'Approval API',
        label: 'owner = acme · chain_version 7 · skipped steps',
        kind: 'reply',
      },
      {from: 'Approval API', to: 'Redis', label: 'HGETALL approval:r-1:state · decision:{i}', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: 'step_index · status · per-step decisions', kind: 'reply'},
      {
        from: 'Approval API',
        to: 'Approval API',
        label: 'foreign request → 404; skipped step keeps its reason',
        kind: 'sync',
      },
      {from: 'Approval API', to: 'Client', label: '200 {chain_version, steps[…], delegations[…]}', kind: 'reply'},
    ],
  },
  hints: [
    'Authorize before you assemble: compare the stored request’s tenant with `X-Tenant-Id` and answer `404` for a foreign one, so a guessed id is indistinguishable from an unknown one. Never build the body first and check afterwards.',
    'Build one entry per step of the pinned chain, in order, and give each entry the state of *its own* decision record — `decision:{i}` from the state hash. A single `any approved` flag stamps every earlier step as approved, which is exactly the claim an auditor is checking.',
    'Keep the skipped steps in the trail with the reason they were skipped, and read `delegated_from` out of the decision record into `delegations`. The shape of the answer is the contract: ids, per-step states, reasons, and who actually acted.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/requests/{id}',
      detail: 'Register the read route on `GET /v1/requests/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/requests\/\{id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/requests\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/requests\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"requests"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/requests\/:id"/]},
      },
    },
    {
      id: 'skipped-steps',
      title: 'Skipped steps appear with their reasons',
      detail:
        'The skipped steps of the pinned chain are carried into the response with the reason each was skipped, instead of being filtered out. The draft drops them, so a chain with skipped steps reads as complete.',
      match: {
        python: {all: [/skipped_steps/, /reason/]},
        typescript: {all: [/skippedSteps/, /reason/]},
        go: {all: [/skippedSteps/, /Reason/]},
        scala: {all: [/skippedSteps/, /reason/]},
        cpp: {all: [/skipped_steps/, /reason/]},
      },
    },
    {
      id: 'per-step-state',
      title: 'Each step reports its own state',
      detail:
        'Every entry takes its state from that step’s own decision record through `step_state` / `stepState`: `pending` when nobody has decided yet, otherwise the decision. The draft stamps every step approved once any later step approved.',
      match: {
        python: {all: [/step_state\(/, /"pending"/]},
        typescript: {all: [/stepState\(/, /'pending'/]},
        go: {all: [/stepState\(/, /"pending"/]},
        scala: {all: [/stepState\(/, /"pending"/]},
        cpp: {all: [/step_state\(/, /"pending"/]},
      },
    },
    {
      id: 'tenant-404',
      title: 'A foreign request is 404',
      detail:
        'The read requires the tenant, compares it with the stored request’s owner and answers `404` when they differ — never another tenant’s request, and never a 403 that confirms the id exists.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*404/]},
        typescript: {all: [/'x-tenant-id'/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /\b404\b/]},
      },
    },
    {
      id: 'chain-version-delegations',
      title: 'Reports the pinned chain version and the delegations',
      detail:
        'The response carries the `chain_version` pinned at submit time and a `delegations` list naming, per step, who a decision was delegated from and who acted. The draft reports neither.',
      match: {
        python: {all: [/chain_version/, /delegations/]},
        typescript: {all: [/chain_version/, /delegations/]},
        go: {all: [/chainVersion/, /Delegat/]},
        scala: {all: [/chainVersion/, /delegations/]},
        cpp: {all: [/chain_version/, /delegations/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RequestStore:
    def get(self, request_id: str) -> dict | None:
        """The stored request record: owner, requester, pinned chain and its skipped steps."""
        raise NotImplementedError


store = RequestStore()


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


@app.get("/v1/requests/{id}")
def read_request(id: str) -> JSONResponse:
    # TODO: this draft filters the skipped steps out of the chain, stamps every step "approved" as
    # soon as one step approved, never checks the tenant, and reports neither the pinned chain
    # version nor the delegations. Review all four.
    request = store.get(id)
    if request is None:
        return JSONResponse({"error": "unknown request"}, status_code=404)
    decisions = {
        int(field.split(":")[1]): json.loads(raw)
        for field, raw in r.hgetall(state_key(id)).items()
        if field.startswith("decision:")
    }
    approved = any(record.get("decision") == "approved" for record in decisions.values())
    skipped = request.get("skipped", {})
    trail = [
        {"step": index, "approver": approver, "state": "approved" if approved else "pending"}
        for index, approver in enumerate(request["approvers"])
        if str(index) not in skipped
    ]
    return JSONResponse({"request_id": id, "trail": trail}, status_code=200)
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RequestStore:
    def get(self, request_id: str) -> dict | None:
        """The stored request record: owner, requester, pinned chain and its skipped steps."""
        raise NotImplementedError


store = RequestStore()


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def step_state(record: dict | None, skip_reason: str | None) -> str:
    """The state of one step on its own: a later approval never rewrites an earlier step."""
    if skip_reason is not None:
        return "skipped"
    if record is None:
        return "pending"
    return record.get("decision", "pending")


@app.get("/v1/requests/{id}")
def read_request(
    id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    request = store.get(id)
    if request is None or request["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown request")

    records = r.hgetall(state_key(id))
    decisions = {
        int(field.split(":")[1]): json.loads(raw)
        for field, raw in records.items()
        if field.startswith("decision:")
    }
    skipped_steps = {int(index): reason for index, reason in request.get("skipped", {}).items()}

    steps = []
    delegations = []
    for index, approver in enumerate(request["approvers"]):
        record = decisions.get(index)
        skip_reason = skipped_steps.get(index)
        steps.append(
            {
                "step": index,
                "approver": approver,
                "state": step_state(record, skip_reason),
                "reason": skip_reason if skip_reason is not None else (record or {}).get("reason", ""),
                "actor": (record or {}).get("actor", ""),
            }
        )
        if record is not None and record.get("delegated_from"):
            delegations.append({"step": index, "from": record["delegated_from"], "to": record["actor"]})

    return JSONResponse(
        {
            "request_id": id,
            "chain_version": request["chain_version"],
            "status": records.get("status", "in_progress"),
            "steps": steps,
            "delegations": delegations,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/requests/{id}: a model-generated draft that hides what did not happen. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

export interface StoredRequest {
  request_id: string;
  tenant: string;
  requester: string;
  chain_version: number;
  approvers: string[];
  skipped: Record<string, string>;
}

export const store = {
  async get(requestId: string): Promise<StoredRequest | null> {
    throw new Error(\`store.get(\${requestId}) is not wired up\`);
  },
};

const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

app.get('/v1/requests/:id', async (request, reply) => {
  // TODO: this draft filters the skipped steps out of the chain, stamps every step "approved" as
  // soon as one step approved, never checks the tenant, and reports neither the pinned chain
  // version nor the delegations. Review all four.
  const {id} = request.params as {id: string};
  const stored = await store.get(id);
  if (stored === null) return reply.code(404).send({error: 'unknown request'});
  const fields = await r.hgetall(stateKey(id));
  const decisions = Object.entries(fields)
    .filter(([field]) => field.startsWith('decision:'))
    .map(([, raw]) => JSON.parse(raw) as {decision: string});
  const approved = decisions.some(record => record.decision === 'approved');
  const trail = stored.approvers
    .map((approver, index) => ({step: index, approver, state: approved ? 'approved' : 'pending'}))
    .filter(step => stored.skipped[String(step.step)] === undefined);
  return reply.code(200).send({request_id: id, trail});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/requests/{id}: the pinned chain, every step's own state, delegations and skips. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

export interface StoredRequest {
  request_id: string;
  tenant: string;
  requester: string;
  chain_version: number;
  approvers: string[];
  skipped: Record<string, string>;
}

interface DecisionRecord {
  actor: string;
  decision: string;
  reason?: string;
  delegated_from?: string;
}

export const store = {
  async get(requestId: string): Promise<StoredRequest | null> {
    throw new Error(\`store.get(\${requestId}) is not wired up\`);
  },
};

const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

/** The state of one step on its own: a later approval never rewrites an earlier step. */
function stepState(record: DecisionRecord | undefined, skipReason: string | undefined): string {
  if (skipReason !== undefined) return 'skipped';
  if (record === undefined) return 'pending';
  return record.decision;
}

app.get('/v1/requests/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  const stored = await store.get(id);
  if (stored === null || stored.tenant !== tenant) return reply.code(404).send({error: 'unknown request'});

  const fields = await r.hgetall(stateKey(id));
  const decisions = new Map<number, DecisionRecord>();
  for (const [field, raw] of Object.entries(fields)) {
    if (field.startsWith('decision:')) decisions.set(Number(field.split(':')[1]), JSON.parse(raw) as DecisionRecord);
  }
  const skippedSteps = new Map<number, string>(
    Object.entries(stored.skipped).map(([index, reason]) => [Number(index), reason]),
  );

  const steps = stored.approvers.map((approver, index) => {
    const record = decisions.get(index);
    const skipReason = skippedSteps.get(index);
    return {
      step: index,
      approver,
      state: stepState(record, skipReason),
      reason: skipReason ?? record?.reason ?? '',
      actor: record?.actor ?? '',
    };
  });
  const delegations = stored.approvers.flatMap((_, index) => {
    const record = decisions.get(index);
    if (record?.delegated_from === undefined) return [];
    return [{step: index, from: record.delegated_from, to: record.actor}];
  });

  return reply.code(200).send({
    request_id: id,
    chain_version: stored.chain_version,
    status: fields.status ?? 'in_progress',
    steps,
    delegations,
  });
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
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type RequestStore struct{}

func (s *RequestStore) Get(ctx context.Context, requestID string) (map[string]any, error) {
	return nil, nil
}

var store = &RequestStore{}

func stateKey(requestID string) string { return "approval:" + requestID + ":state" }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRequest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft filters the skipped steps out of the chain, stamps every step "approved" as
	// soon as one step approved, never checks the tenant, and reports neither the pinned chain
	// version nor the delegations. Review all four.
	id := r.PathValue("id")
	request, err := store.Get(r.Context(), id)
	if err != nil || request == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown request"})
		return
	}
	fields, _ := rdb.HGetAll(r.Context(), stateKey(id)).Result()
	approved := false
	decisions := map[int]map[string]any{}
	for field, raw := range fields {
		if !strings.HasPrefix(field, "decision:") {
			continue
		}
		index, _ := strconv.Atoi(strings.TrimPrefix(field, "decision:"))
		record := map[string]any{}
		_ = json.Unmarshal([]byte(raw), &record)
		decisions[index] = record
		if record["decision"] == "approved" {
			approved = true
		}
	}
	skipped, _ := request["skipped"].(map[string]any)
	approvers, _ := request["approvers"].([]any)
	trail := make([]map[string]any, 0, len(approvers))
	for index, approver := range approvers {
		if _, isSkipped := skipped[strconv.Itoa(index)]; isSkipped {
			continue
		}
		state := "pending"
		if approved {
			state = "approved"
		}
		trail = append(trail, map[string]any{"step": index, "approver": approver, "state": state})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": id, "trail": trail})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/requests/{id}", readRequest)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type RequestStore struct{}

func (s *RequestStore) Get(ctx context.Context, requestID string) (map[string]any, error) {
	return nil, nil
}

var store = &RequestStore{}

func stateKey(requestID string) string { return "approval:" + requestID + ":state" }

type Decision struct {
	Actor         string \`json:"actor"\`
	ActorRole     string \`json:"actor_role"\`
	Decision      string \`json:"decision"\`
	Reason        string \`json:"reason"\`
	DelegatedFrom string \`json:"delegated_from"\`
}

type StepView struct {
	Step     int    \`json:"step"\`
	Approver string \`json:"approver"\`
	State    string \`json:"state"\`
	Reason   string \`json:"reason"\`
	Actor    string \`json:"actor"\`
}

type DelegationView struct {
	Step int    \`json:"step"\`
	From string \`json:"from"\`
	To   string \`json:"to"\`
}

// stepState reports one step on its own: a later approval never rewrites an earlier step.
func stepState(record *Decision, skipReason string) string {
	if skipReason != "" {
		return "skipped"
	}
	if record == nil || record.Decision == "" {
		return "pending"
	}
	return record.Decision
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRequest(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	request, err := store.Get(r.Context(), id)
	if err != nil || request == nil || request["tenant"] != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown request"})
		return
	}

	fields, _ := rdb.HGetAll(r.Context(), stateKey(id)).Result()
	decisions := map[int]*Decision{}
	for field, raw := range fields {
		if !strings.HasPrefix(field, "decision:") {
			continue
		}
		index, _ := strconv.Atoi(strings.TrimPrefix(field, "decision:"))
		record := &Decision{}
		_ = json.Unmarshal([]byte(raw), record)
		decisions[index] = record
	}

	rawSkipped, _ := request["skipped"].(map[string]any)
	skippedSteps := map[int]string{}
	for index, reason := range rawSkipped {
		at, _ := strconv.Atoi(index)
		text, _ := reason.(string)
		skippedSteps[at] = text
	}

	approvers, _ := request["approvers"].([]any)
	steps := make([]StepView, 0, len(approvers))
	delegations := make([]DelegationView, 0)
	for index, approver := range approvers {
		record := decisions[index]
		skipReason := skippedSteps[index]
		reason := skipReason
		actor := ""
		if record != nil {
			actor = record.Actor
			if reason == "" {
				reason = record.Reason
			}
			if record.DelegatedFrom != "" {
				delegations = append(delegations, DelegationView{Step: index, From: record.DelegatedFrom, To: record.Actor})
			}
		}
		label, _ := approver.(string)
		steps = append(steps, StepView{
			Step:     index,
			Approver: label,
			State:    stepState(record, skipReason),
			Reason:   reason,
			Actor:    actor,
		})
	}

	chainVersion, _ := request["chain_version"].(int)
	writeJSON(rw, http.StatusOK, map[string]any{
		"request_id":    id,
		"chain_version": chainVersion,
		"status":        fields["status"],
		"steps":         steps,
		"delegations":   delegations,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/requests/{id}", readRequest)
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

import scala.jdk.CollectionConverters._

final case class Decision(actor: String, actor_role: String, decision: String, reason: String, delegated_from: String)

object Read {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat5(Decision)

  val jedis = new Jedis("redis", 6379)

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  object store {
    def get(requestId: String): Option[Map[String, Any]] = throw new NotImplementedError("store.get")
  }

  val route: Route =
    path("v1" / "requests" / Segment) { id =>
      get {
        // TODO: this draft filters the skipped steps out of the chain, stamps every step "approved"
        // as soon as one step approved, never checks the tenant, and reports neither the pinned
        // chain version nor the delegations. Review all four.
        store.get(id) match {
          case None =>
            complete(StatusCodes.NotFound, """{"error":"unknown request"}""")
          case Some(request) =>
            val fields = jedis.hgetAll(stateKey(id)).asScala.toMap
            val decisions = fields.collect {
              case (field, raw) if field.startsWith("decision:") =>
                field.stripPrefix("decision:").toInt -> raw.parseJson.convertTo[Decision]
            }
            val approved = decisions.values.exists(_.decision == "approved")
            val approvers = request("approvers").asInstanceOf[List[String]]
            val skipped = request("skipped").asInstanceOf[Map[String, String]]
            val trail = approvers.zipWithIndex
              .filterNot { case (_, index) => skipped.contains(index.toString) }
              .map { case (approver, index) =>
                val state = if (approved) "approved" else "pending"
                s"""{"step":$index,"approver":"$approver","state":"$state"}"""
              }
            complete(StatusCodes.OK, s"""{"request_id":"$id","trail":[\${trail.mkString(",")}]}""")
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

import scala.jdk.CollectionConverters._

final case class Decision(actor: String, actor_role: String, decision: String, reason: String, delegated_from: String)

object Read {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat5(Decision)

  val jedis = new Jedis("redis", 6379)

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  object store {
    def get(requestId: String): Option[Map[String, Any]] = throw new NotImplementedError("store.get")
  }

  /** One step on its own: a later approval never rewrites an earlier step. */
  def stepState(record: Option[Decision], skipReason: Option[String]): String = skipReason match {
    case Some(_) => "skipped"
    case None => record.map(_.decision).filter(_.nonEmpty).getOrElse("pending")
  }

  val route: Route =
    path("v1" / "requests" / Segment) { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.get(id) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown request"}""")
              case Some(request) if request("tenant") != tenant =>
                complete(StatusCodes.NotFound, """{"error":"unknown request"}""")
              case Some(request) =>
                val fields = jedis.hgetAll(stateKey(id)).asScala.toMap
                val decisions = fields.collect {
                  case (field, raw) if field.startsWith("decision:") =>
                    field.stripPrefix("decision:").toInt -> raw.parseJson.convertTo[Decision]
                }
                val approvers = request("approvers").asInstanceOf[List[String]]
                val rawSkipped = request("skipped").asInstanceOf[Map[String, String]]
                val skippedSteps = rawSkipped.map { case (index, reason) => index.toInt -> reason }
                val chainVersion = request("chain_version").asInstanceOf[Int]

                val steps = approvers.zipWithIndex.map { case (approver, index) =>
                  val record = decisions.get(index)
                  val skipReason = skippedSteps.get(index)
                  val reason = skipReason.orElse(record.map(_.reason)).getOrElse("")
                  val actor = record.map(_.actor).getOrElse("")
                  s"""{"step":$index,"approver":"$approver","state":"\${stepState(record, skipReason)}","reason":"$reason","actor":"$actor"}"""
                }
                val delegations = approvers.zipWithIndex.flatMap { case (_, index) =>
                  decisions.get(index).filter(_.delegated_from.nonEmpty).map { record =>
                    s"""{"step":$index,"from":"\${record.delegated_from}","to":"\${record.actor}"}"""
                  }
                }
                complete(
                  StatusCodes.OK,
                  s"""{"request_id":"$id","chain_version":$chainVersion,"status":"\${fields.getOrElse("status", "in_progress")}","steps":[\${steps.mkString(",")}],"delegations":[\${delegations.mkString(",")}]}"""
                )
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
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

struct RequestStore {
  std::optional<json> get(const std::string& requestId);
};

RequestStore store;

std::string stateKey(const std::string& requestId) { return "approval:" + requestId + ":state"; }

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/requests/:id", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft filters the skipped steps out of the chain, stamps every step "approved" as
    // soon as one step approved, never checks the tenant, and reports neither the pinned chain
    // version nor the delegations. Review all four.
    const auto id = req.path_params.at("id");
    const auto request = store.get(id);
    if (!request) {
      res.status = 404;
      res.set_content(R"({"error":"unknown request"})", "application/json");
      return;
    }
    std::unordered_map<std::string, std::string> fields;
    redis.hgetall(stateKey(id), std::inserter(fields, fields.end()));
    bool approved = false;
    for (const auto& [field, raw] : fields) {
      if (field.rfind("decision:", 0) != 0) continue;
      const auto record = json::parse(raw, nullptr, false);
      if (record.is_object() && record.value("decision", std::string()) == "approved") approved = true;
    }
    const auto approvers = request->value("approvers", std::vector<std::string>{});
    const auto skipped = request->value("skipped", std::map<std::string, std::string>{});
    json trail = json::array();
    for (std::size_t index = 0; index < approvers.size(); ++index) {
      if (skipped.count(std::to_string(index)) != 0) continue;
      trail.push_back(
          {{"step", index}, {"approver", approvers[index]}, {"state", approved ? "approved" : "pending"}});
    }
    res.status = 200;
    res.set_content(json{{"request_id", id}, {"trail", trail}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct RequestStore {
  std::optional<json> get(const std::string& requestId);
};

RequestStore store;

std::string stateKey(const std::string& requestId) { return "approval:" + requestId + ":state"; }

/** One step on its own: a later approval never rewrites an earlier step. */
std::string step_state(const json& record, const std::string& skipReason) {
  if (!skipReason.empty()) return "skipped";
  if (!record.is_object()) return "pending";
  const auto decision = record.value("decision", std::string());
  return decision.empty() ? "pending" : decision;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/requests/:id", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto id = req.path_params.at("id");
    const auto request = store.get(id);
    if (!request || (*request).value("tenant", std::string()) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown request"})", "application/json");
      return;
    }

    std::unordered_map<std::string, std::string> fields;
    redis.hgetall(stateKey(id), std::inserter(fields, fields.end()));
    std::map<long, json> decisions;
    for (const auto& [field, raw] : fields) {
      if (field.rfind("decision:", 0) != 0) continue;
      const auto record = json::parse(raw, nullptr, false);
      decisions[std::stol(field.substr(9))] = record;
    }

    const auto rawSkipped = (*request).value("skipped", std::map<std::string, std::string>{});
    std::map<long, std::string> skipped_steps;
    for (const auto& [index, reason] : rawSkipped) skipped_steps[std::stol(index)] = reason;

    const auto approvers = (*request).value("approvers", std::vector<std::string>{});
    json steps = json::array();
    json delegations = json::array();
    for (std::size_t index = 0; index < approvers.size(); ++index) {
      const auto record = decisions.count(static_cast<long>(index)) != 0 ? decisions[static_cast<long>(index)] : json();
      const auto skippedIt = skipped_steps.find(static_cast<long>(index));
      const auto skipReason = skippedIt == skipped_steps.end() ? std::string() : skippedIt->second;
      const auto reason = !skipReason.empty() ? skipReason : record.value("reason", std::string());
      steps.push_back(
          {{"step", index},
           {"approver", approvers[index]},
           {"state", step_state(record, skipReason)},
           {"reason", reason},
           {"actor", record.value("actor", std::string())}});
      const auto delegatedFrom = record.value("delegated_from", std::string());
      if (!delegatedFrom.empty()) {
        delegations.push_back(
            {{"step", index}, {"from", delegatedFrom}, {"to", record.value("actor", std::string())}});
      }
    }

    res.status = 200;
    res.set_content(
        json{{"request_id", id},
             {"chain_version", (*request).value("chain_version", 0)},
             {"status", fields.count("status") != 0 ? fields["status"] : std::string("in_progress")},
             {"steps", steps},
             {"delegations", delegations}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `A read endpoint is where a workflow stops being a state machine and becomes evidence. Three
  properties decide whether the trail can be trusted. Every step of the pinned chain is present,
  including the ones that were skipped, each with its reason: a filtered trail is not shorter
  evidence, it is wrong evidence, because it makes a two-signature chain look complete. Every step
  carries its own state, so a reader can distinguish “nobody has decided yet” from “somebody decided
  and it was not me” — a single “approved somewhere” flag destroys exactly the information an
  auditor came for. And the read is tenant-scoped with a 404 for a foreign id, because a request id
  is guessable and the response contains the requester, the reasons and the amount. Real systems add
  a signed, append-only audit export, a redaction pass on reasons shown to parties who are not on
  the chain, and pagination for chains that grow with escalations.`,
};
