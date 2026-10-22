import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis approval state with compare-and-swap steps',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'policy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a decision is recorded, the
chain moves on, and the demo approval completes in two clicks. It counts approvals instead of
stepping through them, and it puts an hour of expiry on an approval that waits weeks. Review it,
fix it, and prove the fix.

Implement the decision path \`POST /v1/requests/{id}/decision\` with body
\`{"step_index": 0, "decision": "approved", "reason": ""}\`. The actor comes from \`X-User-Id\`
(**401** when missing) and the request lives in the state written by \`POST /v1/requests\`.

- The state of one request is **one Redis hash** \`approval:{request_id}:state\`: \`step_index\`,
  \`step_count\`, \`status\`, \`current_approver\`, an \`approver:{i}\` field per step, and one
  \`decision:{i}\` field per decided step.
- \`start_chain\` initialises that hash with **no TTL at all**. An approval that waits three weeks
  for finance must not evaporate because somebody put an hour of expiry on the key at creation;
  completed requests get cleaned up by a sweeper, not by a mid-flow expiry.
- One decision is one **compare-and-swap**: a single Lua script reads \`step_index\`, refuses the
  call when the caller's \`step_index\` no longer matches the stored one, and only then advances the
  index by **exactly one**. Two approvers deciding at the same moment cannot both advance the chain
  past one step; the loser gets a no-op, not a second step.
- Only the **current step's approver** may decide: an actor that is not \`current_approver\` is
  refused, so a later approver cannot jump the queue.
- A repeated decision from the same approver is a **no-op**: \`decision:{i}\` is written with
  \`HSETNX\`, so the second write changes nothing and the chain stays where it is. An approval
  advances the chain; a rejection ends it.
- Answer \`{"request_id", "step_index", "advanced", "reason"}\`: \`advanced\` is true only for the
  call that actually moved the chain.

**Failure mode the checks target.** The draft treats the length of an approvals list as the step
index, so one approver clicking twice — or a client retrying a timed-out decision — advances two
steps and a three-step chain completes with one signature. Nothing checks that the actor is the
current step's approver, so any participant can decide out of order. And the state key carries a
one-hour TTL, which is not a cache policy for an object with a three-week lifetime: the chain
silently disappears and the next decision answers 404.`,
  sequence: {
    participants: ['Approver', 'Approval API', 'Redis'],
    messages: [
      {from: 'Approver', to: 'Approval API', label: 'POST /v1/requests/r-1/decision · step_index 0', kind: 'sync'},
      {
        from: 'Approval API',
        to: 'Redis',
        label: 'EVAL advance_lua · KEYS[approval:r-1:state] · ARGV[0, u-mgr, approved]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Approval API', label: "{1, 1, 'advanced'}", kind: 'reply'},
      {from: 'Approver', to: 'Approval API', label: 'the same decision again (double click / retry)', kind: 'sync'},
      {from: 'Approval API', to: 'Redis', label: 'EVAL · ARGV[0, …] against step_index 1', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: "{0, 1, 'stale step'} — no second advance", kind: 'reply'},
      {from: 'Approval API', to: 'Approver', label: '200 {advanced: false, step_index: 1, reason}', kind: 'reply'},
    ],
  },
  hints: [
    'A hash per request, not a list of approvals: `step_index` is the chain position, `current_approver` is who may act now, and `decision:{i}` records what each step decided. `len(approvals)` is not a step index — it counts signatures, including the same signature twice.',
    'The compare-and-swap belongs in one script: read `step_index`, compare it with the `step_index` the caller decided on, `HSETNX` the per-step decision field, and only then `HSET step_index` to `index + 1`. Read-then-write from the client lets two concurrent approvers both see step 0 and both advance.',
    'Never let the state key expire while the request is open. Create the hash without a TTL and re-assert `PERSIST` on every advance; a sweeper can delete completed requests on a schedule of its own, but a one-hour `EXPIRE` at creation is a data-loss timer on a three-week workflow.',
  ],
  checks: [
    {
      id: 'cas-script',
      title: 'Advances the state hash with one atomic Lua script',
      detail:
        'The state is a hash (`HGET`/`HSET`) and the whole decision — read, compare, write, advance — runs inside a single `EVAL`/`NewScript` call. The draft reads the blob, appends to a list and writes it back, so two decisions interleave.',
      match: {
        python: {all: [/ADVANCE_LUA/, /\.eval\(/, /HGET/, /HSET/]},
        typescript: {all: [/ADVANCE_LUA/, /\.eval\(/, /HGET/, /HSET/]},
        go: {all: [/advanceScript/, /\.Run\(/, /HGET/, /HSET/]},
        scala: {all: [/AdvanceLua/, /\.eval\(/, /HGET/, /HSET/]},
        cpp: {all: [/kAdvanceLua/, /\.eval</, /HGET/, /HSET/]},
      },
    },
    {
      id: 'single-step',
      title: 'Compares the step index and advances exactly one step',
      detail:
        'The script refuses a decision whose `step_index` no longer matches the stored index and, when it matches, writes `next_index = index + 1`. The draft sets the index to the number of items in an approvals list, so a duplicate approval skips a step.',
      match: {
        python: {all: [/tonumber\(ARGV\[1\]\) ~= index/, /next_index = index \+ 1/]},
        typescript: {all: [/tonumber\(ARGV\[1\]\) ~= index/, /next_index = index \+ 1/]},
        go: {all: [/tonumber\(ARGV\[1\]\) ~= index/, /next_index = index \+ 1/]},
        scala: {all: [/tonumber\(ARGV\[1\]\) ~= index/, /next_index = index \+ 1/]},
        cpp: {all: [/tonumber\(ARGV\[1\]\) ~= index/, /next_index = index \+ 1/]},
      },
    },
    {
      id: 'duplicate-noop',
      title: 'A repeated decision is a no-op',
      detail:
        'The per-step decision field is written with `HSETNX`, so a second identical decision changes nothing and returns `duplicate decision` instead of advancing. The draft appends and advances, so the duplicate counts as a signature.',
      match: {
        python: {all: [/HSETNX/, /duplicate decision/]},
        typescript: {all: [/HSETNX/, /duplicate decision/]},
        go: {all: [/HSETNX/, /duplicate decision/]},
        scala: {all: [/HSETNX/, /duplicate decision/]},
        cpp: {all: [/HSETNX/, /duplicate decision/]},
      },
    },
    {
      id: 'persistent-state',
      title: 'The state key never expires mid-flow',
      detail:
        'The state hash is created without a TTL and `PERSIST`ed on every advance. The draft puts an hour of expiry on the key, so a long approval disappears and the next decision answers 404.',
      match: {
        python: {all: [/PERSIST/], none: [/\bTTL_S\b/, /\bsetex\(/]},
        typescript: {all: [/PERSIST/], none: [/\bTTL_S\b/, /['"]EX['"]/]},
        go: {all: [/PERSIST/], none: [/\bttlSeconds\b/, /time\.Hour/]},
        scala: {all: [/PERSIST/], none: [/\bTtlSeconds\b/, /\bsetex\(/]},
        cpp: {all: [/PERSIST/], none: [/\bkTtlSeconds\b/, /\bsetex\(/]},
      },
    },
    {
      id: 'current-approver',
      title: 'Only the current step’s approver may decide',
      detail:
        'The script compares the actor with the `current_approver` field of the hash and refuses anybody else, so approvers cannot decide out of order or on somebody else’s step.',
      match: {
        python: {all: [/current_approver/, /not the current approver/]},
        typescript: {all: [/current_approver/, /not the current approver/]},
        go: {all: [/current_approver/, /not the current approver/]},
        scala: {all: [/current_approver/, /not the current approver/]},
        cpp: {all: [/current_approver/, /not the current approver/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600


class DecisionRequest(BaseModel):
    step_index: int
    decision: str
    reason: str = ""


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def approvals_key(request_id: str) -> str:
    return f"approval:{request_id}:approvals"


def start_chain(request_id: str, approvers: list[str]) -> None:
    # TODO: this draft keeps the state in an expiring blob and counts an approvals list to find
    # the step index. Review the expiry, the missing compare-and-swap and the missing approver
    # check.
    r.set(
        state_key(request_id),
        json.dumps({"step_index": 0, "step_count": len(approvers), "status": "in_progress"}),
        ex=TTL_S,
    )


@app.post("/v1/requests/{id}/decision")
def decide(id: str, body: DecisionRequest, actor: str = Header(alias="X-User-Id")) -> JSONResponse:
    key = state_key(id)
    raw = r.get(key)
    if raw is None:
        return JSONResponse({"error": "unknown request"}, status_code=404)
    state = json.loads(raw)
    r.rpush(approvals_key(id), json.dumps({"actor": actor, "decision": body.decision, "reason": body.reason}))
    recorded = r.lrange(approvals_key(id), 0, -1)
    state["step_index"] = len(recorded)
    state["status"] = "completed" if len(recorded) >= state["step_count"] else "in_progress"
    r.set(key, json.dumps(state), ex=TTL_S)
    return JSONResponse({"request_id": id, "step_index": state["step_index"], "advanced": True}, status_code=200)
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

ADVANCE_LUA = """
local index = tonumber(redis.call('HGET', KEYS[1], 'step_index'))
if index == nil then
  return {-1, -1, 'unknown request'}
end
if tonumber(ARGV[1]) ~= index then
  return {0, index, 'stale step'}
end
if redis.call('HGET', KEYS[1], 'current_approver') ~= ARGV[2] then
  return {-2, index, 'not the current approver'}
end
if redis.call('HSETNX', KEYS[1], 'decision:' .. tostring(index), ARGV[3]) == 0 then
  return {0, index, 'duplicate decision'}
end
if ARGV[3] == 'rejected' then
  redis.call('HSET', KEYS[1], 'status', 'rejected')
  redis.call('PERSIST', KEYS[1])
  return {2, index, 'rejected'}
end
local next_index = index + 1
if next_index >= tonumber(redis.call('HGET', KEYS[1], 'step_count')) then
  redis.call('HSET', KEYS[1], 'status', 'completed')
else
  redis.call('HSET', KEYS[1], 'current_approver', redis.call('HGET', KEYS[1], 'approver:' .. next_index))
end
redis.call('HSET', KEYS[1], 'step_index', next_index)
redis.call('PERSIST', KEYS[1])
return {1, next_index, 'advanced'}
"""


class DecisionRequest(BaseModel):
    step_index: int
    decision: str
    reason: str = ""


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def start_chain(request_id: str, approvers: list[str]) -> None:
    """Initialise the chain state: a hash with no TTL, so a long approval never expires."""
    key = state_key(request_id)
    fields = {
        "step_index": 0,
        "step_count": len(approvers),
        "status": "in_progress",
        "current_approver": approvers[0],
    }
    for index, approver in enumerate(approvers):
        fields[f"approver:{index}"] = approver
    r.hset(key, mapping=fields)
    r.persist(key)


@app.post("/v1/requests/{id}/decision")
def decide(
    id: str,
    body: DecisionRequest,
    actor: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    if actor is None or actor == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    status, index, reason = r.eval(ADVANCE_LUA, 1, state_key(id), body.step_index, actor, body.decision)
    status, index, reason = int(status), int(index), str(reason)
    if status == -1:
        return JSONResponse({"error": "unknown request"}, status_code=404)
    if status == -2:
        return JSONResponse({"error": reason}, status_code=409)
    body_out = {"request_id": id, "step_index": index, "advanced": status == 1, "reason": reason}
    return JSONResponse(body_out, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/requests/{id}/decision: a model-generated draft that counts approvals. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const TTL_S = 3600;

interface DecisionBody {
  step_index: number;
  decision: string;
  reason?: string;
}

interface ChainState {
  step_index: number;
  step_count: number;
  status: string;
}

export const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;
export const approvalsKey = (requestId: string): string => \`approval:\${requestId}:approvals\`;

export async function startChain(requestId: string, approvers: string[]): Promise<void> {
  // TODO: this draft keeps the state in an expiring blob and counts an approvals list to find
  // the step index. Review the expiry, the missing compare-and-swap and the missing approver
  // check.
  const state: ChainState = {step_index: 0, step_count: approvers.length, status: 'in_progress'};
  await r.set(stateKey(requestId), JSON.stringify(state), 'EX', TTL_S);
}

app.post('/v1/requests/:id/decision', async (request, reply) => {
  const {id} = request.params as {id: string};
  const actor = request.headers['x-user-id'];
  const body = request.body as DecisionBody;
  const key = stateKey(id);
  const raw = await r.get(key);
  if (raw === null) return reply.code(404).send({error: 'unknown request'});
  const state: ChainState = JSON.parse(raw);
  await r.rpush(approvalsKey(id), JSON.stringify({actor, decision: body.decision, reason: body.reason ?? ''}));
  const recorded = await r.lrange(approvalsKey(id), 0, -1);
  state.step_index = recorded.length;
  state.status = recorded.length >= state.step_count ? 'completed' : 'in_progress';
  await r.set(key, JSON.stringify(state), 'EX', TTL_S);
  return reply.code(200).send({request_id: id, step_index: state.step_index, advanced: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/requests/{id}/decision: one compare-and-swap per decision. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const ADVANCE_LUA = \`
local index = tonumber(redis.call('HGET', KEYS[1], 'step_index'))
if index == nil then
  return {-1, -1, 'unknown request'}
end
if tonumber(ARGV[1]) ~= index then
  return {0, index, 'stale step'}
end
if redis.call('HGET', KEYS[1], 'current_approver') ~= ARGV[2] then
  return {-2, index, 'not the current approver'}
end
if redis.call('HSETNX', KEYS[1], 'decision:' .. tostring(index), ARGV[3]) == 0 then
  return {0, index, 'duplicate decision'}
end
if ARGV[3] == 'rejected' then
  redis.call('HSET', KEYS[1], 'status', 'rejected')
  redis.call('PERSIST', KEYS[1])
  return {2, index, 'rejected'}
end
local next_index = index + 1
if next_index >= tonumber(redis.call('HGET', KEYS[1], 'step_count')) then
  redis.call('HSET', KEYS[1], 'status', 'completed')
else
  redis.call('HSET', KEYS[1], 'current_approver', redis.call('HGET', KEYS[1], 'approver:' .. next_index))
end
redis.call('HSET', KEYS[1], 'step_index', next_index)
redis.call('PERSIST', KEYS[1])
return {1, next_index, 'advanced'}
\`;

interface DecisionBody {
  step_index: number;
  decision: string;
  reason?: string;
}

export const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

/** The chain state is a hash with no TTL: a long approval must never expire mid-flow. */
export async function startChain(requestId: string, approvers: string[]): Promise<void> {
  const key = stateKey(requestId);
  const fields: Record<string, string | number> = {
    step_index: 0,
    step_count: approvers.length,
    status: 'in_progress',
    current_approver: approvers[0],
  };
  approvers.forEach((approver, index) => {
    fields[\`approver:\${index}\`] = approver;
  });
  await r.hset(key, fields);
  await r.persist(key);
}

app.post('/v1/requests/:id/decision', async (request, reply) => {
  const {id} = request.params as {id: string};
  const actor = request.headers['x-user-id'];
  if (typeof actor !== 'string' || actor === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const body = request.body as DecisionBody;
  const reply_ = (await r.eval(
    ADVANCE_LUA,
    1,
    stateKey(id),
    String(body.step_index),
    actor,
    body.decision,
  )) as [number, number, string];
  const [status, index, reason] = reply_.map(String) as [string, string, string];
  if (status === '-1') return reply.code(404).send({error: 'unknown request'});
  if (status === '-2') return reply.code(409).send({error: reason});
  return reply.code(200).send({request_id: id, step_index: Number(index), advanced: status === '1', reason});
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
	"time"

	"github.com/redis/go-redis/v9"
)

const ttlSeconds = 3600

var rdb *redis.Client

type DecisionBody struct {
	StepIndex int    \`json:"step_index"\`
	Decision  string \`json:"decision"\`
	Reason    string \`json:"reason"\`
}

func stateKey(requestID string) string { return "approval:" + requestID + ":state" }

func approvalsKey(requestID string) string { return "approval:" + requestID + ":approvals" }

func startChain(ctx context.Context, requestID string, approvers []string) error {
	// TODO: this draft keeps the state in an expiring blob and counts an approvals list to find
	// the step index. Review the expiry, the missing compare-and-swap and the missing approver
	// check.
	payload, _ := json.Marshal(map[string]any{
		"step_index": 0,
		"step_count": len(approvers),
		"status":     "in_progress",
	})
	return rdb.Set(ctx, stateKey(requestID), payload, time.Hour).Err()
}

func decide(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	actor := r.Header.Get("X-User-Id")
	key := stateKey(id)
	raw, err := rdb.Get(r.Context(), key).Result()
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown request"})
		return
	}
	var state map[string]any
	_ = json.Unmarshal([]byte(raw), &state)
	var body DecisionBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	recorded, _ := json.Marshal(map[string]any{"actor": actor, "decision": body.Decision, "reason": body.Reason})
	rdb.RPush(r.Context(), approvalsKey(id), recorded)
	items, _ := rdb.LRange(r.Context(), approvalsKey(id), 0, -1).Result()
	state["step_index"] = len(items)
	if len(items) >= int(state["step_count"].(float64)) {
		state["status"] = "completed"
	}
	payload, _ := json.Marshal(state)
	rdb.Set(r.Context(), key, payload, time.Hour)
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": id, "step_index": len(items), "advanced": true})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests/{id}/decision", decide)
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

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

var advanceScript = redis.NewScript(\`
local index = tonumber(redis.call('HGET', KEYS[1], 'step_index'))
if index == nil then
  return {-1, -1, 'unknown request'}
end
if tonumber(ARGV[1]) ~= index then
  return {0, index, 'stale step'}
end
if redis.call('HGET', KEYS[1], 'current_approver') ~= ARGV[2] then
  return {-2, index, 'not the current approver'}
end
if redis.call('HSETNX', KEYS[1], 'decision:' .. tostring(index), ARGV[3]) == 0 then
  return {0, index, 'duplicate decision'}
end
if ARGV[3] == 'rejected' then
  redis.call('HSET', KEYS[1], 'status', 'rejected')
  redis.call('PERSIST', KEYS[1])
  return {2, index, 'rejected'}
end
local next_index = index + 1
if next_index >= tonumber(redis.call('HGET', KEYS[1], 'step_count')) then
  redis.call('HSET', KEYS[1], 'status', 'completed')
else
  redis.call('HSET', KEYS[1], 'current_approver', redis.call('HGET', KEYS[1], 'approver:' .. next_index))
end
redis.call('HSET', KEYS[1], 'step_index', next_index)
redis.call('PERSIST', KEYS[1])
return {1, next_index, 'advanced'}
\`)

type DecisionBody struct {
	StepIndex int    \`json:"step_index"\`
	Decision  string \`json:"decision"\`
	Reason    string \`json:"reason"\`
}

func stateKey(requestID string) string { return "approval:" + requestID + ":state" }

// startChain writes the chain state as a hash with no TTL: a long approval must never expire.
func startChain(ctx context.Context, requestID string, approvers []string) error {
	key := stateKey(requestID)
	fields := map[string]any{
		"step_index":       0,
		"step_count":       len(approvers),
		"status":           "in_progress",
		"current_approver": approvers[0],
	}
	for index, approver := range approvers {
		fields["approver:"+strconv.Itoa(index)] = approver
	}
	if err := rdb.HSet(ctx, key, fields).Err(); err != nil {
		return err
	}
	return rdb.Persist(ctx, key).Err()
}

func decide(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	actor := r.Header.Get("X-User-Id")
	if actor == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	var body DecisionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	result, err := advanceScript.Run(
		r.Context(),
		rdb,
		[]string{stateKey(id)},
		body.StepIndex,
		actor,
		body.Decision,
	).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	values := result.([]any)
	status := values[0].(int64)
	index := values[1].(int64)
	reason := values[2].(string)
	switch status {
	case -1:
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown request"})
	case -2:
		writeJSON(rw, http.StatusConflict, map[string]string{"error": reason})
	default:
		writeJSON(rw, http.StatusOK, map[string]any{
			"request_id": id,
			"step_index": index,
			"advanced":   status == 1,
			"reason":     reason,
		})
	}
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests/{id}/decision", decide)
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
import spray.json.RootJsonFormat

final case class DecisionRequest(step_index: Int, decision: String, reason: String)

object State {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[DecisionRequest] = jsonFormat3(DecisionRequest)

  val TtlSeconds = 3600
  val jedis = new Jedis("redis", 6379)

  def stateKey(requestId: String): String = s"approval:$requestId:state"
  def approvalsKey(requestId: String): String = s"approval:$requestId:approvals"

  def startChain(requestId: String, approvers: List[String]): Unit = {
    // TODO: this draft keeps the state in an expiring blob and counts an approvals list to find
    // the step index. Review the expiry, the missing compare-and-swap and the missing approver
    // check.
    val payload = s"""{"step_index":0,"step_count":\${approvers.size},"status":"in_progress"}"""
    jedis.setex(stateKey(requestId), TtlSeconds, payload)
  }

  val route: Route =
    path("v1" / "requests" / Segment / "decision") { id =>
      post {
        headerValueByName("X-User-Id") { actor =>
          entity(as[DecisionRequest]) { body =>
            Option(jedis.get(stateKey(id))) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown request"}""")
              case Some(_) =>
                jedis.rpush(
                  approvalsKey(id),
                  s"""{"actor":"$actor","decision":"\${body.decision}","reason":"\${body.reason}"}"""
                )
                val recorded = jedis.llen(approvalsKey(id)).toInt
                val payload = s"""{"step_index":$recorded,"advanced":true}"""
                jedis.setex(stateKey(id), TtlSeconds, payload)
                complete(StatusCodes.OK, s"""{"request_id":"$id","step_index":$recorded,"advanced":true}""")
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DecisionRequest(step_index: Int, decision: String, reason: String)

object State {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[DecisionRequest] = jsonFormat3(DecisionRequest)

  val jedis = new Jedis("redis", 6379)

  val AdvanceLua =
    """
      |local index = tonumber(redis.call('HGET', KEYS[1], 'step_index'))
      |if index == nil then
      |  return {-1, -1, 'unknown request'}
      |end
      |if tonumber(ARGV[1]) ~= index then
      |  return {0, index, 'stale step'}
      |end
      |if redis.call('HGET', KEYS[1], 'current_approver') ~= ARGV[2] then
      |  return {-2, index, 'not the current approver'}
      |end
      |if redis.call('HSETNX', KEYS[1], 'decision:' .. tostring(index), ARGV[3]) == 0 then
      |  return {0, index, 'duplicate decision'}
      |end
      |if ARGV[3] == 'rejected' then
      |  redis.call('HSET', KEYS[1], 'status', 'rejected')
      |  redis.call('PERSIST', KEYS[1])
      |  return {2, index, 'rejected'}
      |end
      |local next_index = index + 1
      |if next_index >= tonumber(redis.call('HGET', KEYS[1], 'step_count')) then
      |  redis.call('HSET', KEYS[1], 'status', 'completed')
      |else
      |  redis.call('HSET', KEYS[1], 'current_approver', redis.call('HGET', KEYS[1], 'approver:' .. next_index))
      |end
      |redis.call('HSET', KEYS[1], 'step_index', next_index)
      |redis.call('PERSIST', KEYS[1])
      |return {1, next_index, 'advanced'}
      |""".stripMargin

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  /** The chain state is a hash with no TTL: a long approval must never expire mid-flow. */
  def startChain(requestId: String, approvers: List[String]): Unit = {
    val key = stateKey(requestId)
    val fields = new java.util.HashMap[String, String]()
    fields.put("step_index", "0")
    fields.put("step_count", approvers.size.toString)
    fields.put("status", "in_progress")
    fields.put("current_approver", approvers.head)
    approvers.zipWithIndex.foreach { case (approver, index) => fields.put(s"approver:$index", approver) }
    jedis.hset(key, fields)
    jedis.persist(key)
  }

  val route: Route =
    path("v1" / "requests" / Segment / "decision") { id =>
      post {
        optionalHeaderValueByName("X-User-Id") { actorOpt =>
          entity(as[DecisionRequest]) { body =>
            if (!actorOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
            } else {
              val result = jedis
                .eval(
                  AdvanceLua,
                  1,
                  stateKey(id),
                  body.step_index.toString,
                  actorOpt.get,
                  body.decision
                )
                .asInstanceOf[java.util.List[Any]]
              val status = result.get(0).asInstanceOf[Long]
              val index = result.get(1).asInstanceOf[Long]
              val reason = result.get(2).asInstanceOf[String]
              status match {
                case -1L =>
                  complete(StatusCodes.NotFound, """{"error":"unknown request"}""")
                case -2L =>
                  complete(StatusCodes.Conflict, s"""{"error":"$reason"}""")
                case _ =>
                  complete(
                    StatusCodes.OK,
                    s"""{"request_id":"$id","step_index":$index,"advanced":\${status == 1L},"reason":"$reason"}"""
                  )
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kTtlSeconds = 3600;

struct DecisionBody {
  int step_index = 0;
  std::string decision;
  std::string reason;
};

std::string stateKey(const std::string& requestId) { return "approval:" + requestId + ":state"; }

std::string approvalsKey(const std::string& requestId) { return "approval:" + requestId + ":approvals"; }

void startChain(sw::redis::Redis& redis, const std::string& requestId, const std::vector<std::string>& approvers) {
  // TODO: this draft keeps the state in an expiring blob and counts an approvals list to find
  // the step index. Review the expiry, the missing compare-and-swap and the missing approver
  // check.
  const json state = {{"step_index", 0}, {"step_count", approvers.size()}, {"status", "in_progress"}};
  redis.setex(stateKey(requestId), kTtlSeconds, state.dump());
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/requests/:id/decision", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    const auto actor = req.get_header_value("X-User-Id");
    const auto key = stateKey(id);
    const auto raw = redis.get(key);
    if (!raw) {
      res.status = 404;
      res.set_content(R"({"error":"unknown request"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const json recorded = {
        {"actor", actor},
        {"decision", body.value("decision", std::string())},
        {"reason", body.value("reason", std::string())},
    };
    redis.rpush(approvalsKey(id), recorded.dump());
    const auto items = redis.llen(approvalsKey(id));
    const json state = {{"step_index", items}, {"advanced", true}};
    redis.setex(key, kTtlSeconds, state.dump());
    res.status = 200;
    res.set_content(json{{"request_id", id}, {"step_index", items}, {"advanced", true}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

const char* kAdvanceLua = R"LUA(
local index = tonumber(redis.call('HGET', KEYS[1], 'step_index'))
if index == nil then
  return {-1, -1, 'unknown request'}
end
if tonumber(ARGV[1]) ~= index then
  return {0, index, 'stale step'}
end
if redis.call('HGET', KEYS[1], 'current_approver') ~= ARGV[2] then
  return {-2, index, 'not the current approver'}
end
if redis.call('HSETNX', KEYS[1], 'decision:' .. tostring(index), ARGV[3]) == 0 then
  return {0, index, 'duplicate decision'}
end
if ARGV[3] == 'rejected' then
  redis.call('HSET', KEYS[1], 'status', 'rejected')
  redis.call('PERSIST', KEYS[1])
  return {2, index, 'rejected'}
end
local next_index = index + 1
if next_index >= tonumber(redis.call('HGET', KEYS[1], 'step_count')) then
  redis.call('HSET', KEYS[1], 'status', 'completed')
else
  redis.call('HSET', KEYS[1], 'current_approver', redis.call('HGET', KEYS[1], 'approver:' .. next_index))
end
redis.call('HSET', KEYS[1], 'step_index', next_index)
redis.call('PERSIST', KEYS[1])
return {1, next_index, 'advanced'}
)LUA";

struct DecisionBody {
  int step_index = 0;
  std::string decision;
  std::string reason;
};

std::string stateKey(const std::string& requestId) { return "approval:" + requestId + ":state"; }

/** The chain state is a hash with no TTL: a long approval must never expire mid-flow. */
void startChain(sw::redis::Redis& redis, const std::string& requestId, const std::vector<std::string>& approvers) {
  const auto key = stateKey(requestId);
  std::vector<std::pair<std::string, std::string>> fields = {
      {"step_index", "0"},
      {"step_count", std::to_string(approvers.size())},
      {"status", "in_progress"},
      {"current_approver", approvers.front()},
  };
  for (std::size_t index = 0; index < approvers.size(); ++index) {
    fields.emplace_back("approver:" + std::to_string(index), approvers[index]);
  }
  redis.hset(key, fields.begin(), fields.end());
  redis.persist(key);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/requests/:id/decision", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    const auto actor = req.get_header_value("X-User-Id");
    if (actor.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const auto result = redis.eval<std::vector<std::string>>(
        kAdvanceLua,
        {stateKey(id)},
        {std::to_string(body.value("step_index", 0)), actor, body.value("decision", std::string())});
    const long long status = std::stoll(result[0]);
    const long long index = std::stoll(result[1]);
    if (status == -1) {
      res.status = 404;
      res.set_content(R"({"error":"unknown request"})", "application/json");
      return;
    }
    if (status == -2) {
      res.status = 409;
      res.set_content(json{{"error", result[2]}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"request_id", id}, {"step_index", index}, {"advanced", status == 1}, {"reason", result[2]}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `This step is about state that must survive concurrency and time. Three properties are being
  checked, and all three fail silently in a demo. First, the step index is a compare-and-swap, not a
  count: the script refuses a decision whose \`step_index\` has moved, so a double click, a retried
  request or two approvers acting at once can move the chain by at most one step, and the loser gets
  \`advanced: false\` instead of an extra signature. Second, eligibility of the actor is evaluated
  against \`current_approver\` inside the same script, so a later approver cannot decide out of order
  and nobody can decide on somebody else's step. Third, the state key has no TTL: approvals wait for
  people, and a workflow object with a three-week lifetime must not inherit an hour of cache expiry.
  Real systems add a sweeper that deletes completed or cancelled requests on a schedule, an
  \`escalate_at\` deadline per step, and an audit row per decision beside the Redis state.`,
};
