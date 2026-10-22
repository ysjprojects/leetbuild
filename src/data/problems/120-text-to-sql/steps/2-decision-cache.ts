import type {Step} from '@/lib/types';

export const decisionCacheStep: Step = {
  id: 'decision-cache',
  title: 'Redis: decision cache, query budget, pending ACK',
  concept: 'redis',
  file: 'decisions',
  focus: ['api', 'redis', 'agents'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a repeated question comes
back from the cache, a user under budget gets through, and the pending ACK is stored, so the demo
passes. It hides four production flaws: a cache key that collides and never expires, a budget that
races and never resets, a budget charged after the agents ran, and a pending ACK that lives forever.
Find them, fix them, and prove the fix.

Implement the Redis side of \`POST /v1/queries\`:

- The table agent's decision is cached under \`decision:{workspace}:{qhash}\`, where \`qhash\` is
  the SHA-256 of the **normalised** question (trimmed, lower-cased, whitespace collapsed). The key
  includes the workspace because the same words mean different tables in Mobility and in Ads, and
  the hash because "Trips in Seattle" and "trips in seattle" are one decision. Entries expire after
  **24 hours** (\`DECISION_TTL_S = 86400\`): workspaces are re-curated, and a cached decision must
  not outlive the table list it was made from.
- Each user may create **50 queries per hour** (\`QUERY_BUDGET = 50\`, \`WINDOW_S = 3600\`). The key
  is \`budget:{user}:{window}\` with \`window = floor(unix_seconds / 3600)\`; one atomic Lua
  \`EVAL\` reads the counter, rejects when it is at the limit, increments it and sets \`EXPIRE\` on
  the first write. Over budget is **429** with \`Retry-After\` (the key's TTL).
- Reserve the budget **before** the first agent call; a rejected request must never have paid for
  an intent call.
- The proposed tables wait for the user's ACK under \`pending:{query_id}\` with
  \`PENDING_TTL_S = 600\`: an ACK that does not arrive within ten minutes expires with the query.

**Failure mode the checks target.** A key built from the raw question misses on every
capitalisation and collides across workspaces; a key without a TTL serves yesterday's table list
after the workspace was re-curated; a read-then-set budget lets two concurrent requests both pass;
a window-less budget key never resets, so one busy hour locks the user out for good; charging
after the agents means the rejected request already cost two model calls; and pending ACKs that
never expire grow Redis by one entry per abandoned question.`,
  sequence: {
    participants: ['querygen', 'Redis', 'Agents'],
    messages: [
      {from: 'querygen', to: 'Redis', label: 'EVAL budget · KEYS[budget:jlee:498213] · ARGV[50, 3600]', kind: 'sync'},
      {from: 'Redis', to: 'querygen', label: '{1, 2144} / {0, ttl} → 429 Retry-After', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'Intent(question) only after the reservation', kind: 'sync'},
      {from: 'querygen', to: 'Redis', label: 'GET decision:mobility:{sha256(normalised question)}', kind: 'sync'},
      {from: 'Redis', to: 'querygen', label: 'cached tables / nil', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PickTables(question, workspace) on miss', kind: 'sync'},
      {from: 'querygen', to: 'Redis', label: 'SET decision:… EX 86400 · SET pending:{query_id} EX 600', kind: 'async'},
    ],
  },
  hints: [
    'Normalise before hashing: `strip`, lower-case, collapse runs of whitespace to one space, then SHA-256. The key is `decision:{workspace}:{qhash}`; the workspace is part of the identity of a decision, not metadata about it.',
    'The budget script does all of it on the server: `GET` the counter, compare against `ARGV[1]`, `INCR`, and `EXPIRE` with `ARGV[2]` when the increment returned 1. Return `{ok, TTL}` so the 429 can carry a real `Retry-After`. Call it before the intent agent — the reservation is the first thing the handler does after validation.',
    'Every `SET` in this file carries an expiry: `ex=DECISION_TTL_S` on the decision, `ex=PENDING_TTL_S` on the pending ACK. A key you write without a TTL is a key you have promised to delete yourself.',
  ],
  checks: [
    {
      id: 'normalised-key',
      title: 'Keys the decision by workspace and normalised question hash',
      detail:
        'The cache key is `decision:{workspace}:{qhash}` with `qhash` the SHA-256 of the lower-cased, whitespace-collapsed question. The draft keys by the raw question and no workspace, so it collides across workspaces and misses on every capitalisation.',
      match: {
        python: {all: [/decision:\{workspace\}:\{qhash\}/, /sha256/, /\.lower\(\)/]},
        typescript: {all: [/decision:\$\{workspace\}:\$\{qhash\}/, /sha256/, /toLowerCase\(\)/]},
        go: {all: [/decision:%s:%s/, /sha256/, /strings\.ToLower/]},
        scala: {all: [/decision:\$workspace:\$qhash/, /SHA-256/, /toLowerCase/]},
        cpp: {all: [/"decision:"/, /SHA256/, /tolower/]},
      },
    },
    {
      id: 'decision-ttl',
      title: 'Decision entries expire after 24 hours',
      detail:
        'The decision is written with `DECISION_TTL_S = 86400` as its expiry. Without it a cached table list outlives the workspace curation it was made from.',
      match: {
        python: {all: [/DECISION_TTL_S\s*=\s*86_?400/, /ex\s*=\s*DECISION_TTL_S/]},
        typescript: {all: [/DECISION_TTL_S\s*=\s*86_?400/, /'EX',\s*DECISION_TTL_S/]},
        go: {all: [/decisionTTL\s*=\s*86400/, /\.Set\([^)]*decisionTTL\)/]},
        scala: {all: [/DecisionTtlS\s*=\s*86400/, /setex\([^)]*DecisionTtlS/]},
        cpp: {all: [/kDecisionTtlS\s*=\s*86400/, /std::chrono::seconds\(kDecisionTtlS\)/]},
      },
    },
    {
      id: 'atomic-budget',
      title: 'Reserves the hourly budget with one atomic script',
      detail:
        'The counter is read, checked, incremented and given its `EXPIRE` inside one Lua `EVAL` on `budget:{user}:{window}`. A client-side read followed by a write lets two concurrent requests both pass, and a window-less key never resets.',
      match: {
        python: {all: [/BUDGET_LUA/, /INCR/, /EXPIRE/, /budget:\{user\}:\{window\}/]},
        typescript: {all: [/BUDGET_LUA/, /INCR/, /EXPIRE/, /budget:\$\{user\}:\$\{window\}/]},
        go: {all: [/(budgetScript|NewScript)/, /INCR/, /EXPIRE/, /budget:%s:%d/]},
        scala: {all: [/BudgetLua/, /INCR/, /EXPIRE/, /budget:\$user:\$window/]},
        cpp: {all: [/kBudgetLua/, /INCR/, /EXPIRE/, /"budget:"/]},
      },
    },
    {
      id: 'budget-first',
      title: 'Answers 429 with Retry-After, and reserves before the agents',
      detail:
        'Over `QUERY_BUDGET = 50` the handler answers **429** with `Retry-After` from the script’s TTL, and the reservation runs before the intent agent is called. The draft charges after the agents ran, so a rejected request has already paid for two model calls.',
      match: {
        python: {
          all: [/QUERY_BUDGET\s*=\s*50/, /status_code\s*=\s*429/, /Retry-After/],
          order: [/reserve\(/, /\.Intent\(/],
        },
        typescript: {
          all: [/QUERY_BUDGET\s*=\s*50/, /code\(\s*429\s*\)/, /Retry-After/],
          order: [/reserve\(/, /\.Intent\(/],
        },
        go: {
          all: [/queryBudget\s*=\s*50/, /StatusTooManyRequests/, /Retry-After/],
          order: [/reserve\(/, /\.Intent\(/],
        },
        scala: {
          all: [/QueryBudget\s*=\s*50/, /StatusCodes\.TooManyRequests/, /Retry-After/],
          order: [/reserve\(/, /\.intent\(/],
        },
        cpp: {
          all: [/kQueryBudget\s*=\s*50/, /status\s*=\s*429/, /Retry-After/],
          order: [/reserve\(/, /->Intent\(/],
        },
      },
    },
    {
      id: 'pending-expiry',
      title: 'Pending ACK state expires after ten minutes',
      detail:
        'The proposed tables are stored under `pending:{query_id}` with `PENDING_TTL_S = 600`. The draft writes the key without an expiry, so every abandoned question stays in Redis forever.',
      match: {
        python: {all: [/PENDING_TTL_S\s*=\s*600/, /pending:\{query_id\}/, /ex\s*=\s*PENDING_TTL_S/]},
        typescript: {all: [/PENDING_TTL_S\s*=\s*600/, /pending:\$\{queryId\}/, /'EX',\s*PENDING_TTL_S/]},
        go: {all: [/pendingTTL\s*=\s*600/, /"pending:"\s*\+\s*queryID/, /\.Set\([^;]*pendingTTL\)/]},
        scala: {all: [/PendingTtlS\s*=\s*600/, /pending:\$queryId/, /setex\([^)]*PendingTtlS/]},
        cpp: {all: [/kPendingTtlS\s*=\s*600/, /"pending:"/, /std::chrono::seconds\(kPendingTtlS\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import uuid

import grpc
import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import agents_pb2
import agents_pb2_grpc

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))

BUDGET = 50


class QueryRequest(BaseModel):
    question: str
    workspace: str | None = None


def charge(user: str) -> bool:
    # TODO: replace the read-then-set budget with one atomic EVAL on a windowed key with EXPIRE,
    # and reserve before the agents run instead of charging after they did.
    key = f"budget:{user}"
    used = int(r.get(key) or 0)
    if used >= BUDGET:
        return False
    r.set(key, used + 1)
    return True


def decide(question: str, workspace: str) -> dict:
    # TODO: key by workspace and the hash of the normalised question, and give the entry a TTL.
    cached = r.get(f"decision:{question}")
    if cached is not None:
        return json.loads(cached)
    picked = agents.PickTables(agents_pb2.PickTablesRequest(question=question, workspace=workspace))
    decision = {"workspace": workspace, "tables_proposed": list(picked.tables)}
    r.set(f"decision:{question}", json.dumps(decision))
    return decision


@app.post("/v1/queries")
def create_query(body: QueryRequest, user: str = Header(alias="X-User-Id")) -> dict:
    workspace = body.workspace
    if workspace is None:
        workspace = agents.Intent(agents_pb2.IntentRequest(question=body.question)).workspace
    decision = decide(body.question, workspace)
    if not charge(user):
        raise HTTPException(status_code=429, detail="query budget exhausted", headers={"Retry-After": "3600"})
    query_id = str(uuid.uuid4())
    # TODO: the pending ACK never expires.
    r.set(f"pending:{query_id}", json.dumps({"user": user, **decision}))
    return {"query_id": query_id, "status": "pending_ack", **decision}
`,
      solution: `import hashlib
import json
import re
import time
import uuid

import grpc
import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import agents_pb2
import agents_pb2_grpc

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))

DECISION_TTL_S = 86_400
PENDING_TTL_S = 600
WINDOW_S = 3600
QUERY_BUDGET = 50
AGENT_DEADLINE_S = 10.0

BUDGET_LUA = """
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, redis.call('TTL', KEYS[1])}
"""


class QueryRequest(BaseModel):
    question: str
    workspace: str | None = None


def normalise(question: str) -> str:
    return re.sub(r"\\s+", " ", question.strip().lower())


def decision_key(workspace: str, question: str) -> str:
    qhash = hashlib.sha256(normalise(question).encode("utf-8")).hexdigest()
    return f"decision:{workspace}:{qhash}"


def reserve(user: str) -> tuple[bool, int]:
    window = int(time.time()) // WINDOW_S
    ok, ttl = r.eval(BUDGET_LUA, 1, f"budget:{user}:{window}", QUERY_BUDGET, WINDOW_S)
    return bool(ok), int(ttl)


def decide(question: str, workspace: str) -> dict:
    key = decision_key(workspace, question)
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    picked = agents.PickTables(
        agents_pb2.PickTablesRequest(question=question, workspace=workspace), timeout=AGENT_DEADLINE_S
    )
    decision = {"workspace": workspace, "tables_proposed": list(picked.tables)}
    r.set(key, json.dumps(decision), ex=DECISION_TTL_S)
    return decision


@app.post("/v1/queries")
def create_query(body: QueryRequest, user: str = Header(alias="X-User-Id")) -> dict:
    ok, ttl = reserve(user)
    if not ok:
        raise HTTPException(
            status_code=429, detail="query budget exhausted", headers={"Retry-After": str(max(ttl, 1))}
        )
    workspace = body.workspace
    if workspace is None:
        intent = agents.Intent(agents_pb2.IntentRequest(question=body.question), timeout=AGENT_DEADLINE_S)
        workspace = intent.workspace
    decision = decide(body.question, workspace)
    query_id = str(uuid.uuid4())
    r.set(f"pending:{query_id}", json.dumps({"user": user, **decision}), ex=PENDING_TTL_S)
    return {"query_id": query_id, "status": "pending_ack", **decision}
`,
    },
    typescript: {
      starter: `/** POST /v1/queries: a model-generated draft that caches by raw question and charges after the agents. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {agents} from './agents';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const BUDGET = 50;

interface QueryBody {
  question: string;
  workspace?: string;
}

interface Decision {
  workspace: string;
  tables_proposed: string[];
}

async function charge(user: string): Promise<boolean> {
  // TODO: replace the read-then-set budget with one atomic EVAL on a windowed key with EXPIRE,
  // and reserve before the agents run instead of charging after they did.
  const key = \`budget:\${user}\`;
  const used = Number((await r.get(key)) ?? 0);
  if (used >= BUDGET) return false;
  await r.set(key, used + 1);
  return true;
}

async function decide(question: string, workspace: string): Promise<Decision> {
  // TODO: key by workspace and the hash of the normalised question, and give the entry a TTL.
  const cached = await r.get(\`decision:\${question}\`);
  if (cached !== null) return JSON.parse(cached) as Decision;
  const picked = await agents.PickTables({question, workspace});
  const decision: Decision = {workspace, tables_proposed: picked.tables};
  await r.set(\`decision:\${question}\`, JSON.stringify(decision));
  return decision;
}

app.post('/v1/queries', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const body = request.body as QueryBody;
  const workspace = body.workspace ?? (await agents.Intent({question: body.question})).workspace;
  const decision = await decide(body.question, workspace);
  if (!(await charge(user))) {
    return reply.code(429).header('Retry-After', '3600').send({error: 'query budget exhausted'});
  }
  const queryId = randomUUID();
  // TODO: the pending ACK never expires.
  await r.set(\`pending:\${queryId}\`, JSON.stringify({user, ...decision}));
  return reply.code(202).send({query_id: queryId, status: 'pending_ack', ...decision});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries: budget reserved first, decisions cached by workspace + normalised question. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {agents} from './agents';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const DECISION_TTL_S = 86_400;
const PENDING_TTL_S = 600;
const WINDOW_S = 3600;
const QUERY_BUDGET = 50;
const AGENT_DEADLINE_MS = 10_000;

const BUDGET_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, redis.call('TTL', KEYS[1])}
\`;

interface QueryBody {
  question: string;
  workspace?: string;
}

interface Decision {
  workspace: string;
  tables_proposed: string[];
}

function decisionKey(workspace: string, question: string): string {
  const normalised = question.trim().toLowerCase().replace(/\\s+/g, ' ');
  const qhash = createHash('sha256').update(normalised).digest('hex');
  return \`decision:\${workspace}:\${qhash}\`;
}

async function reserve(user: string): Promise<[boolean, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const result = (await r.eval(BUDGET_LUA, 1, \`budget:\${user}:\${window}\`, QUERY_BUDGET, WINDOW_S)) as [
    number,
    number,
  ];
  return [result[0] === 1, result[1]];
}

async function decide(question: string, workspace: string): Promise<Decision> {
  const key = decisionKey(workspace, question);
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as Decision;
  const picked = await agents.PickTables({question, workspace}, {deadline: Date.now() + AGENT_DEADLINE_MS});
  const decision: Decision = {workspace, tables_proposed: picked.tables};
  await r.set(key, JSON.stringify(decision), 'EX', DECISION_TTL_S);
  return decision;
}

app.post('/v1/queries', async (request, reply) => {
  const user = request.headers['x-user-id'] as string;
  const body = request.body as QueryBody;
  const [ok, ttl] = await reserve(user);
  if (!ok) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .send({error: 'query budget exhausted'});
  }
  const workspace =
    body.workspace ??
    (await agents.Intent({question: body.question}, {deadline: Date.now() + AGENT_DEADLINE_MS})).workspace;
  const decision = await decide(body.question, workspace);
  const queryId = randomUUID();
  await r.set(\`pending:\${queryId}\`, JSON.stringify({user, ...decision}), 'EX', PENDING_TTL_S);
  return reply.code(202).send({query_id: queryId, status: 'pending_ack', ...decision});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	pb "querygen/agentspb"
)

const budget = 50

var (
	rdb    *redis.Client
	agents pb.AgentsClient
)

type Decision struct {
	Workspace      string   \`json:"workspace"\`
	TablesProposed []string \`json:"tables_proposed"\`
}

func charge(ctx context.Context, user string) bool {
	// TODO: replace the read-then-set budget with one atomic EVAL on a windowed key with EXPIRE,
	// and reserve before the agents run instead of charging after they did.
	key := "budget:" + user
	used, _ := rdb.Get(ctx, key).Int()
	if used >= budget {
		return false
	}
	rdb.Set(ctx, key, used+1, 0)
	return true
}

func decide(ctx context.Context, question, workspace string) (Decision, error) {
	// TODO: key by workspace and the hash of the normalised question, and give the entry a TTL.
	key := "decision:" + question
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var decision Decision
		_ = json.Unmarshal([]byte(cached), &decision)
		return decision, nil
	}
	picked, err := agents.PickTables(ctx, &pb.PickTablesRequest{Question: question, Workspace: workspace})
	if err != nil {
		return Decision{}, err
	}
	decision := Decision{Workspace: workspace, TablesProposed: picked.Tables}
	payload, _ := json.Marshal(decision)
	rdb.Set(ctx, key, payload, 0)
	return decision, nil
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		Question  string \`json:"question"\`
		Workspace string \`json:"workspace"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	workspace := body.Workspace
	if workspace == "" {
		intent, _ := agents.Intent(r.Context(), &pb.IntentRequest{Question: body.Question})
		workspace = intent.Workspace
	}
	decision, err := decide(r.Context(), body.Question, workspace)
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	if !charge(r.Context(), user) {
		rw.Header().Set("Retry-After", "3600")
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	queryID := uuid.NewString()
	pending, _ := json.Marshal(map[string]any{"user": user, "workspace": workspace, "tables_proposed": decision.TablesProposed})
	// TODO: the pending ACK never expires.
	rdb.Set(r.Context(), "pending:"+queryID, pending, 0)
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusAccepted)
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"query_id":%q,"status":"pending_ack","workspace":%q}\`, queryID, workspace)))
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	pb "querygen/agentspb"
)

const (
	decisionTTL   = 86400 * time.Second
	pendingTTL    = 600 * time.Second
	windowSeconds = 3600
	queryBudget   = 50
	agentDeadline = 10 * time.Second
)

var (
	rdb    *redis.Client
	agents pb.AgentsClient
)

var budgetScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, redis.call('TTL', KEYS[1])}
\`)

type Decision struct {
	Workspace      string   \`json:"workspace"\`
	TablesProposed []string \`json:"tables_proposed"\`
}

func decisionKey(workspace, question string) string {
	normalised := strings.Join(strings.Fields(strings.ToLower(question)), " ")
	sum := sha256.Sum256([]byte(normalised))
	return fmt.Sprintf("decision:%s:%s", workspace, hex.EncodeToString(sum[:]))
}

func reserve(ctx context.Context, user string) (bool, int64, error) {
	window := time.Now().Unix() / windowSeconds
	key := fmt.Sprintf("budget:%s:%d", user, window)
	values, err := budgetScript.Run(ctx, rdb, []string{key}, queryBudget, windowSeconds).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return values[0] == 1, values[1], nil
}

func decide(ctx context.Context, question, workspace string) (Decision, error) {
	key := decisionKey(workspace, question)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var decision Decision
		if err := json.Unmarshal([]byte(cached), &decision); err == nil {
			return decision, nil
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, agentDeadline)
	defer cancel()
	picked, err := agents.PickTables(callCtx, &pb.PickTablesRequest{Question: question, Workspace: workspace})
	if err != nil {
		return Decision{}, err
	}
	decision := Decision{Workspace: workspace, TablesProposed: picked.Tables}
	payload, _ := json.Marshal(decision)
	rdb.Set(ctx, key, payload, decisionTTL)
	return decision, nil
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	body := struct {
		Question  string \`json:"question"\`
		Workspace string \`json:"workspace"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ok, ttl, err := reserve(r.Context(), user)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if !ok {
		if ttl < 1 {
			ttl = 1
		}
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", ttl))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	workspace := body.Workspace
	if workspace == "" {
		callCtx, cancel := context.WithTimeout(r.Context(), agentDeadline)
		defer cancel()
		intent, err := agents.Intent(callCtx, &pb.IntentRequest{Question: body.Question})
		if err != nil {
			rw.WriteHeader(http.StatusBadGateway)
			return
		}
		workspace = intent.Workspace
	}
	decision, err := decide(r.Context(), body.Question, workspace)
	if err != nil {
		rw.WriteHeader(http.StatusBadGateway)
		return
	}
	queryID := uuid.NewString()
	pending, _ := json.Marshal(map[string]any{"user": user, "workspace": workspace, "tables_proposed": decision.TablesProposed})
	rdb.Set(r.Context(), "pending:"+queryID, pending, pendingTTL)
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusAccepted)
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"query_id":%q,"status":"pending_ack","workspace":%q}\`, queryID, workspace)))
}

func main() {}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class QueryRequest(question: String, workspace: Option[String])
final case class Decision(workspace: String, tables_proposed: Seq[String])

object DecisionsApi {
  implicit val system: ActorSystem = ActorSystem("querygen")
  implicit val requestFormat: RootJsonFormat[QueryRequest] = jsonFormat2(QueryRequest)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat2(Decision)

  val Budget = 50L
  val jedis = new Jedis("redis", 6379)
  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())

  // TODO: replace the read-then-set budget with one atomic EVAL on a windowed key with EXPIRE,
  // and reserve before the agents run instead of charging after they did.
  def charge(user: String): Boolean = {
    val key = s"budget:$user"
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= Budget) false
    else {
      jedis.set(key, (used + 1).toString)
      true
    }
  }

  // TODO: key by workspace and the hash of the normalised question, and give the entry a TTL.
  def decide(question: String, workspace: String): Decision = {
    val key = s"decision:$question"
    Option(jedis.get(key)).map(_.parseJson.convertTo[Decision]).getOrElse {
      val picked = agents.pickTables(PickTablesRequest(question = question, workspace = workspace))
      val decision = Decision(workspace, picked.tables)
      jedis.set(key, decision.toJson.compactPrint)
      decision
    }
  }

  val route: Route =
    path("v1" / "queries") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[QueryRequest]) { body =>
            val workspace = body.workspace.getOrElse(agents.intent(IntentRequest(question = body.question)).workspace)
            val decision = decide(body.question, workspace)
            if (!charge(user)) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(RawHeader("Retry-After", "3600")),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"query budget exhausted"}""")
                )
              )
            } else {
              val queryId = UUID.randomUUID().toString
              // TODO: the pending ACK never expires.
              jedis.set(s"pending:$queryId", JsObject(decision.toJson.asJsObject.fields + ("user" -> JsString(user))).compactPrint)
              complete(StatusCodes.Accepted, s"""{"query_id":"$queryId","status":"pending_ack","workspace":"$workspace"}""")
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
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class QueryRequest(question: String, workspace: Option[String])
final case class Decision(workspace: String, tables_proposed: Seq[String])

object DecisionsApi {
  implicit val system: ActorSystem = ActorSystem("querygen")
  implicit val requestFormat: RootJsonFormat[QueryRequest] = jsonFormat2(QueryRequest)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat2(Decision)

  val DecisionTtlS = 86400L
  val PendingTtlS = 600L
  val WindowSeconds = 3600L
  val QueryBudget = 50L
  val AgentDeadlineMs = 10000L

  val jedis = new Jedis("redis", 6379)
  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())

  val BudgetLua =
    """
      |local used = tonumber(redis.call('GET', KEYS[1])) or 0
      |if used >= tonumber(ARGV[1]) then
      |  return {0, redis.call('TTL', KEYS[1])}
      |end
      |local n = redis.call('INCR', KEYS[1])
      |if n == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |return {1, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def decisionKey(workspace: String, question: String): String = {
    val normalised = question.trim.toLowerCase.split("\\\\s+").mkString(" ")
    val digest = MessageDigest.getInstance("SHA-256").digest(normalised.getBytes(StandardCharsets.UTF_8))
    val qhash = digest.map("%02x".format(_)).mkString
    s"decision:$workspace:$qhash"
  }

  def reserve(user: String): (Boolean, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val result = jedis
      .eval(BudgetLua, 1, s"budget:$user:$window", QueryBudget.toString, WindowSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1))
  }

  def decide(question: String, workspace: String): Decision = {
    val key = decisionKey(workspace, question)
    Option(jedis.get(key)).map(_.parseJson.convertTo[Decision]).getOrElse {
      val picked = agents
        .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
        .pickTables(PickTablesRequest(question = question, workspace = workspace))
      val decision = Decision(workspace, picked.tables)
      jedis.setex(key, DecisionTtlS, decision.toJson.compactPrint)
      decision
    }
  }

  val route: Route =
    path("v1" / "queries") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[QueryRequest]) { body =>
            val (ok, ttl) = reserve(user)
            if (!ok) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(RawHeader("Retry-After", math.max(ttl, 1L).toString)),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"query budget exhausted"}""")
                )
              )
            } else {
              val workspace = body.workspace.getOrElse(
                agents
                  .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
                  .intent(IntentRequest(question = body.question))
                  .workspace
              )
              val decision = decide(body.question, workspace)
              val queryId = UUID.randomUUID().toString
              val pending = JsObject(decision.toJson.asJsObject.fields + ("user" -> JsString(user))).compactPrint
              jedis.setex(s"pending:$queryId", PendingTtlS, pending)
              complete(StatusCodes.Accepted, s"""{"query_id":"$queryId","status":"pending_ack","workspace":"$workspace"}""")
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
#include <sw/redis++/redis++.h>

#include "agents.grpc.pb.h"

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kBudget = 50;

std::unique_ptr<Agents::Stub> agents;
std::string uuidString();

bool charge(sw::redis::Redis& redis, const std::string& user) {
  // TODO: replace the read-then-set budget with one atomic EVAL on a windowed key with EXPIRE,
  // and reserve before the agents run instead of charging after they did.
  const auto key = "budget:" + user;
  const auto raw = redis.get(key);
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used >= kBudget) return false;
  redis.set(key, std::to_string(used + 1));
  return true;
}

json decide(sw::redis::Redis& redis, const std::string& question, const std::string& workspace) {
  // TODO: key by workspace and the hash of the normalised question, and give the entry a TTL.
  const auto key = "decision:" + question;
  if (const auto cached = redis.get(key)) return json::parse(*cached);
  grpc::ClientContext ctx;
  PickTablesRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  PickTablesReply picked;
  agents->PickTables(&ctx, request, &picked);
  const std::vector<std::string> tables(picked.tables().begin(), picked.tables().end());
  const json decision = {{"workspace", workspace}, {"tables_proposed", tables}};
  redis.set(key, decision.dump());
  return decision;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  agents = Agents::NewStub(grpc::CreateChannel("agents:9000", grpc::InsecureChannelCredentials()));

  svr.Post("/v1/queries", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto question = body.value("question", std::string());
    auto workspace = body.value("workspace", std::string());
    if (workspace.empty()) {
      grpc::ClientContext ctx;
      IntentRequest request;
      request.set_question(question);
      IntentReply intent;
      agents->Intent(&ctx, request, &intent);
      workspace = intent.workspace();
    }
    json decision = decide(redis, question, workspace);
    if (!charge(redis, user)) {
      res.status = 429;
      res.set_header("Retry-After", "3600");
      res.set_content(R"({"error":"query budget exhausted"})", "application/json");
      return;
    }
    const auto queryId = uuidString();
    decision["user"] = user;
    // TODO: the pending ACK never expires.
    redis.set("pending:" + queryId, decision.dump());
    decision["query_id"] = queryId;
    decision["status"] = "pending_ack";
    res.status = 202;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include "agents.grpc.pb.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr long long kDecisionTtlS = 86400;
constexpr long long kPendingTtlS = 600;
constexpr long long kWindowSeconds = 3600;
constexpr long long kQueryBudget = 50;
constexpr int kAgentDeadlineMs = 10000;

const char* kBudgetLua = R"LUA(
local used = tonumber(redis.call('GET', KEYS[1])) or 0
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, redis.call('TTL', KEYS[1])}
)LUA";

std::unique_ptr<Agents::Stub> agents;
std::string uuidString();

std::string normalise(const std::string& question) {
  std::string out;
  bool pendingSpace = false;
  for (const unsigned char c : question) {
    if (std::isspace(c)) {
      pendingSpace = !out.empty();
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += static_cast<char>(std::tolower(c));
  }
  return out;
}

std::string sha256Hex(const std::string& text) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(text.data()), text.size(), digest);
  std::ostringstream out;
  for (const unsigned char c : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(c);
  return out.str();
}

std::string decisionKey(const std::string& workspace, const std::string& question) {
  return "decision:" + workspace + ":" + sha256Hex(normalise(question));
}

std::pair<bool, long long> reserve(sw::redis::Redis& redis, const std::string& user) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const auto result = redis.eval<std::vector<long long>>(
      kBudgetLua, {"budget:" + user + ":" + std::to_string(window)}, {kQueryBudget, kWindowSeconds});
  return {result[0] == 1, result[1]};
}

json decide(sw::redis::Redis& redis, const std::string& question, const std::string& workspace) {
  const auto key = decisionKey(workspace, question);
  if (const auto cached = redis.get(key)) return json::parse(*cached);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAgentDeadlineMs));
  PickTablesRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  PickTablesReply picked;
  agents->PickTables(&ctx, request, &picked);
  const std::vector<std::string> tables(picked.tables().begin(), picked.tables().end());
  const json decision = {{"workspace", workspace}, {"tables_proposed", tables}};
  redis.set(key, decision.dump(), std::chrono::seconds(kDecisionTtlS));
  return decision;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  agents = Agents::NewStub(grpc::CreateChannel("agents:9000", grpc::InsecureChannelCredentials()));

  svr.Post("/v1/queries", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto question = body.value("question", std::string());

    const auto [ok, ttl] = reserve(redis, user);
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max(ttl, 1LL)));
      res.set_content(R"({"error":"query budget exhausted"})", "application/json");
      return;
    }
    auto workspace = body.value("workspace", std::string());
    if (workspace.empty()) {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAgentDeadlineMs));
      IntentRequest request;
      request.set_question(question);
      IntentReply intent;
      agents->Intent(&ctx, request, &intent);
      workspace = intent.workspace();
    }
    json decision = decide(redis, question, workspace);
    const auto queryId = uuidString();
    decision["user"] = user;
    redis.set("pending:" + queryId, decision.dump(), std::chrono::seconds(kPendingTtlS));
    decision["query_id"] = queryId;
    decision["status"] = "pending_ack";
    res.status = 202;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing three Redis habits at once. Identity: a cache key names *what* was decided — the workspace and the normalised question — not the bytes that happened to arrive, so the same question cached once serves every user who asks it that hour and never leaks a Mobility table list into an Ads question. Lifetime: every key in this file has a TTL, because the decision is only as good as the curation it was made from and a pending ACK that nobody answers is garbage by definition. Atomicity and order: a budget is a reservation made in one server-side script before the money is spent, not a count taken after the agents already ran; a read-then-write budget passes every serial test and fails under exactly the load it exists for. Real services add a cache version stamped from the workspace's curation revision so a re-curation invalidates in one step, a per-workspace budget beside the per-user one, and a refund when the chain fails before generation.`,
};
