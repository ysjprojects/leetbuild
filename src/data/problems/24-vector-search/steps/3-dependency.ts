import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Scatter-gather over index shards',
  concept: 'grpc',
  file: 'client',
  focus: ['search', 'shards'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: with every shard healthy it
returns the union of the shard replies and the demo ranks well. Three failure modes are hidden in it.
Find them, fix them, and prove the fix with the checks below.

The search fans a query out to the index shards over gRPC.

- Every shard call carries a **400 ms deadline** (\`timeout\`, \`deadline:\`, \`WithTimeout\`,
  \`withDeadlineAfter\`, \`set_deadline\`). A shard that has not answered by then is a *missing*
  answer, not a slow one: the call is abandoned and the query proceeds.
- Retries are **bounded**: at most **2 attempts** per shard and a **150 ms retry budget** measured
  from the first attempt. The draft retries timeouts forever, which turns one stuck shard into a
  request that never returns and a client that cancels by timing out at the edge.
- A shard reply set must reach a **quorum** — a majority of the configured shards
  (\`shard_count // 2 + 1\`). Below quorum the search answers **503** with the answered and required
  counts and \`partial: true\`; it must never answer 200 with a silently incomplete list.
- A failing or timing-out shard counts as a **failure** (\`failures += 1\`), never as an empty hit
  list. The draft maps a rejected shard call to \`[]\`, so a dead shard looks exactly like a shard
  with nothing to return.
- Above quorum, the response reports \`partial\` — \`true\` when any shard failed — alongside
  \`shards.answered\` and \`shards.required\`, so a client can tell a degraded answer from a complete
  one.

**Failure mode the checks target.** Waiting for the slowest shard makes one hot shard's latency the
service's latency. Catching a shard error into an empty list is the quiet one: the ranking looks
plausible, the recall is gone, and nothing in the response says so. Unbounded retries on top of an
unbounded wait means a partial shard outage becomes a full outage under load.`,
  sequence: {
    participants: ['Search API', 'Index shard 0', 'Index shard 1', 'Index shard 2'],
    messages: [
      {from: 'Search API', to: 'Index shard 0', label: 'Search(ctx, deadline = 400 ms)', kind: 'sync'},
      {from: 'Search API', to: 'Index shard 1', label: 'Search(ctx, deadline = 400 ms)', kind: 'sync'},
      {from: 'Search API', to: 'Index shard 2', label: 'Search(ctx, deadline = 400 ms)', kind: 'sync'},
      {from: 'Index shard 0', to: 'Search API', label: 'hits', kind: 'reply'},
      {from: 'Index shard 1', to: 'Search API', label: 'hits', kind: 'reply'},
      {
        from: 'Search API',
        to: 'Search API',
        label: 'shard 2 cut at the deadline · retries stop at the budget',
        kind: 'sync',
      },
      {
        from: 'Search API',
        to: 'Search API',
        label: 'answered 2 >= quorum 2 → 200 {hits, partial: true}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'A deadline is per attempt, not per request: build a fresh context (or set a fresh deadline on the call) for every shard attempt, and pass the request context down so a client cancel stops the fan-out too.',
    'The retry budget is the second bound and it is wall-clock: record the time before the first attempt and break out of the retry loop when the budget is gone or the attempt count hits the cap. `while true` plus a `sleep` is how a stuck shard becomes a stuck request.',
    'Keep failures and hits in two separate accumulators: `failures` counts shards that did not answer (including the ones you deliberately dropped), and it is what decides the quorum, the 503 and the `partial` flag. Mapping an error to `[]` destroys that information at the exact moment it is needed.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Gives every shard a 400 ms deadline',
      detail:
        'Each shard call carries a 400 ms deadline, so a stuck shard is cut off and the search proceeds. The draft awaits the slowest shard with no timeout at all.',
      match: {
        python: {all: [/SHARD_DEADLINE_MS\s*=\s*400/, /timeout=SHARD_DEADLINE_S/]},
        typescript: {all: [/SHARD_DEADLINE_MS\s*=\s*400/, /deadline:\s*Date\.now\(\)\s*\+\s*SHARD_DEADLINE_MS/]},
        go: {all: [/shardDeadline\s*=\s*400\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^)]*shardDeadline\)/]},
        scala: {all: [/ShardDeadlineMs\s*=\s*400/, /withDeadlineAfter\(\s*ShardDeadlineMs/]},
        cpp: {all: [/kShardDeadlineMs\s*=\s*400/, /std::chrono::milliseconds\(kShardDeadlineMs\)/]},
      },
    },
    {
      id: 'quorum',
      title: 'Requires a quorum of shard replies',
      detail:
        'A majority of the configured shards must answer; below quorum the search answers **503** with the answered and required counts. The draft answers 200 with whatever came back, so a partial index looks complete.',
      match: {
        python: {all: [/def quorum_size\(/, /status_code\s*=\s*503/, /answered\s*<\s*quorum/]},
        typescript: {all: [/function quorumSize\(/, /code\(\s*503\s*\)/, /answered\s*<\s*quorum/]},
        go: {all: [/func quorumSize\(/, /StatusServiceUnavailable/, /answered\s*<\s*quorum/]},
        scala: {all: [/def quorumSize\(/, /StatusCodes\.ServiceUnavailable/, /answered\s*<\s*quorum/]},
        cpp: {all: [/int quorumSize\(/, /\b503\b/, /answered\s*<\s*quorum/]},
      },
    },
    {
      id: 'failures-not-empty',
      title: 'A failed shard is a failure, not an empty result',
      detail:
        'A rejected or timed-out shard increments a failure counter (`failures += 1`) and its hits are not merged; the draft turns the error into an empty hit list, so a dead shard is indistinguishable from an empty one.',
      match: {
        python: {all: [/failures\s*\+=\s*1/, /return_exceptions=True/]},
        typescript: {all: [/failures\s*\+=\s*1/, /allSettled/]},
        go: {all: [/failures\s*\+=\s*1/, /result\.err\s*!=\s*nil/]},
        scala: {all: [/failures\s*\+=\s*1/, /recover\s*\{/]},
        cpp: {all: [/failures\s*\+=\s*1/, /outcome\.ok/]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'Retries stop at the attempt cap and the budget',
      detail:
        'At most 2 attempts per shard inside a 150 ms wall-clock budget; the loop exits when either bound is reached. The draft retries every timeout forever, so one stuck shard stalls the whole query.',
      match: {
        python: {all: [/RETRY_BUDGET_MS/, /MAX_ATTEMPTS/, /attempt\s*\+=\s*1/], none: [/while True/]},
        typescript: {all: [/RETRY_BUDGET_MS/, /MAX_ATTEMPTS/, /attempts\s*\+=\s*1/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/retryBudget/, /maxAttempts/, /attempt\+\+/], none: [/for\s*\{/]},
        scala: {all: [/RetryBudgetMs/, /MaxAttempts/, /attempt\s*\+=\s*1/], none: [/while\s*\(true\)/]},
        cpp: {all: [/kRetryBudgetMs/, /kMaxAttempts/, /\+\+attempt/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'partial-flag',
      title: 'Reports a partial answer explicitly',
      detail:
        'Above quorum the response carries `partial` (true when any shard failed) together with `shards.answered` and `shards.required`. The draft merges silently, so the caller cannot tell how complete the list is.',
      match: {
        python: {all: [/partial/, /quorum_size\(/]},
        typescript: {all: [/partial/, /quorumSize\(/]},
        go: {all: [/partial/, /quorumSize\(/]},
        scala: {all: [/partial/, /quorumSize\(/]},
        cpp: {all: [/partial/, /quorumSize\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import logging

import grpc
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import shards_pb2
import shards_pb2_grpc

app = FastAPI()
logger = logging.getLogger("search")

ACTIVE_INDEX_VERSION = "idx-42"
SHARD_TARGETS = ("index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100")

channels = {target: grpc.aio.insecure_channel(target) for target in SHARD_TARGETS}


class SearchQuery(BaseModel):
    query: list[float]
    k: int = 10


async def query_shard(target: str, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
    stub = shards_pb2_grpc.IndexShardStub(channels[target])
    request = shards_pb2.SearchRequest(tenant=tenant, query=query, k=k, index_version=version)
    # TODO: this draft has no deadline, no quorum and no retry budget. It awaits every shard
    # forever, turns a rejected shard into an empty hit list, and retries timeouts in a loop that
    # never ends. Review all three before this fan-out takes traffic.
    while True:
        try:
            reply = await stub.Search(request)
            return [{"id": hit.id, "score": hit.score, "shard": target} for hit in reply.hits]
        except grpc.aio.AioRpcError:
            logger.warning("shard %s did not answer, retrying", target)
            await asyncio.sleep(0.05)
        except Exception:
            return []


async def scatter_gather(tenant: str, query: list[float], k: int, version: str) -> list[dict]:
    replies = await asyncio.gather(*(query_shard(target, tenant, query, k, version) for target in SHARD_TARGETS))
    hits: list[dict] = []
    for reply in replies:
        hits.extend(reply)
    return hits


@app.post("/v1/search")
async def search(body: SearchQuery) -> JSONResponse:
    hits = await scatter_gather("", body.query, body.k, ACTIVE_INDEX_VERSION)
    logger.info("search k=%d hits=%d", body.k, len(hits))
    return JSONResponse({"hits": hits, "k": body.k, "index_version": ACTIVE_INDEX_VERSION}, status_code=200)
`,
      solution: `import asyncio
import logging

import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import shards_pb2
import shards_pb2_grpc

app = FastAPI()
logger = logging.getLogger("search")

ACTIVE_INDEX_VERSION = "idx-42"
SHARD_DEADLINE_MS = 400
SHARD_DEADLINE_S = SHARD_DEADLINE_MS / 1000
RETRY_BUDGET_MS = 150
MAX_ATTEMPTS = 2
SHARD_TARGETS = ("index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100")

channels = {target: grpc.aio.insecure_channel(target) for target in SHARD_TARGETS}


class SearchQuery(BaseModel):
    query: list[float]
    k: int = 10


def quorum_size(shard_count: int) -> int:
    """A majority: fewer answers than this is a guess, not a result."""
    return shard_count // 2 + 1


async def query_shard(target: str, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
    """One shard, a deadline per attempt, and no more attempts than the budget allows."""
    stub = shards_pb2_grpc.IndexShardStub(channels[target])
    request = shards_pb2.SearchRequest(tenant=tenant, query=query, k=k, index_version=version)
    loop = asyncio.get_running_loop()
    until = loop.time() + RETRY_BUDGET_MS / 1000
    attempt = 0
    while attempt < MAX_ATTEMPTS:
        attempt += 1
        try:
            reply = await stub.Search(request, timeout=SHARD_DEADLINE_S)
            return [{"id": hit.id, "score": hit.score, "shard": target} for hit in reply.hits]
        except grpc.aio.AioRpcError as error:
            if error.code() not in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
                raise
            if loop.time() >= until:
                break
    raise TimeoutError(f"{target} missed the {SHARD_DEADLINE_MS} ms deadline")


async def scatter_gather(tenant: str, query: list[float], k: int, version: str) -> tuple[list[dict], int]:
    replies = await asyncio.gather(
        *(query_shard(target, tenant, query, k, version) for target in SHARD_TARGETS),
        return_exceptions=True,
    )
    hits: list[dict] = []
    failures = 0
    for reply in replies:
        if isinstance(reply, BaseException):
            failures += 1  # a shard that did not answer is missing, never empty
            logger.warning("shard failed: %s", reply)
            continue
        hits.extend(reply)
    return hits, failures


@app.post("/v1/search")
async def search(
    body: SearchQuery,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    hits, failures = await scatter_gather(tenant, body.query, body.k, ACTIVE_INDEX_VERSION)
    answered = len(SHARD_TARGETS) - failures
    quorum = quorum_size(len(SHARD_TARGETS))
    if answered < quorum:
        raise HTTPException(
            status_code=503,
            detail={"error": "quorum not met", "answered": answered, "required": quorum, "partial": True},
        )
    hits.sort(key=lambda hit: hit["score"], reverse=True)
    logger.info("search tenant=%s k=%d answered=%d partial=%s", tenant, body.k, answered, failures > 0)
    return JSONResponse(
        {
            "hits": hits[: body.k],
            "k": body.k,
            "index_version": ACTIVE_INDEX_VERSION,
            "partial": failures > 0,
            "shards": {"answered": answered, "required": quorum},
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Scatter-gather over index shards: a model-generated draft with no bounds. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {loadShardProto} from './proto';

export const app = Fastify();

const ACTIVE_INDEX_VERSION = 'idx-42';
const SHARD_TARGETS = ['index-shard-0:9100', 'index-shard-1:9100', 'index-shard-2:9100'];

const shardProto = loadShardProto();
const clients = SHARD_TARGETS.map(target => new shardProto.IndexShard(target, grpc.credentials.createInsecure()));

interface Hit {
  id: string;
  score: number;
  shard: string;
}

interface ShardRequest {
  tenant: string;
  vector: number[];
  k: number;
  index_version: string;
}

function callShard(client: grpc.Client, request: ShardRequest): Promise<{hits?: Hit[]}> {
  const {promise, resolve, reject} = Promise.withResolvers<{hits?: Hit[]}>();
  (client as grpc.Client & {Search: (...args: unknown[]) => void}).Search(
    request,
    {deadline: Number.POSITIVE_INFINITY},
    (error: grpc.ServiceError | null, value: {hits?: Hit[]}) => (error === null ? resolve(value) : reject(error)),
  );
  return promise;
}

async function queryShard(target: string, client: grpc.Client, request: ShardRequest): Promise<Hit[]> {
  // TODO: this draft has no deadline, no quorum and no retry budget. It awaits every shard
  // forever, turns a rejected shard into an empty hit list, and retries timeouts in a loop that
  // never ends. Review all three before this fan-out takes traffic.
  while (true) {
    try {
      const reply = await callShard(client, request);
      return (reply.hits ?? []).map(hit => ({id: hit.id, score: hit.score, shard: target}));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

app.post('/v1/search', async (request, reply) => {
  const body = request.body as ShardRequest;
  const replies = await Promise.all(
    SHARD_TARGETS.map((target, index) => queryShard(target, clients[index], {...body, index_version: ACTIVE_INDEX_VERSION})),
  );
  const hits = replies.flat();
  request.log.info({k: body.k, hits: hits.length}, 'scattered');
  return reply.code(200).send({hits, k: body.k, index_version: ACTIVE_INDEX_VERSION});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Scatter-gather over index shards: a deadline per shard, a quorum, and bounded retries. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {loadShardProto} from './proto';

export const app = Fastify();

const ACTIVE_INDEX_VERSION = 'idx-42';
const SHARD_DEADLINE_MS = 400;
const RETRY_BUDGET_MS = 150;
const MAX_ATTEMPTS = 2;
const SHARD_TARGETS = ['index-shard-0:9100', 'index-shard-1:9100', 'index-shard-2:9100'];

const shardProto = loadShardProto();
const clients = SHARD_TARGETS.map(target => new shardProto.IndexShard(target, grpc.credentials.createInsecure()));

interface Hit {
  id: string;
  score: number;
  shard: string;
}

interface ShardRequest {
  tenant: string;
  vector: number[];
  k: number;
  index_version: string;
}

function quorumSize(shardCount: number): number {
  return Math.floor(shardCount / 2) + 1;
}

function callShard(client: grpc.Client, request: ShardRequest): Promise<{hits?: Hit[]}> {
  const {promise, resolve, reject} = Promise.withResolvers<{hits?: Hit[]}>();
  (client as grpc.Client & {Search: (...args: unknown[]) => void}).Search(
    request,
    {deadline: Date.now() + SHARD_DEADLINE_MS},
    (error: grpc.ServiceError | null, value: {hits?: Hit[]}) => (error === null ? resolve(value) : reject(error)),
  );
  return promise;
}

async function queryShard(target: string, client: grpc.Client, request: ShardRequest): Promise<Hit[]> {
  const until = Date.now() + RETRY_BUDGET_MS;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const reply = await callShard(client, request);
      return (reply.hits ?? []).map(hit => ({id: hit.id, score: hit.score, shard: target}));
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code !== grpc.status.DEADLINE_EXCEEDED && code !== grpc.status.UNAVAILABLE) throw error;
      if (Date.now() >= until) break;
    }
  }
  throw new Error(\`\${target} missed the \${SHARD_DEADLINE_MS} ms deadline\`);
}

async function scatterGather(tenant: string, request: ShardRequest): Promise<{hits: Hit[]; failures: number}> {
  const replies = await Promise.allSettled(
    SHARD_TARGETS.map((target, index) => queryShard(target, clients[index], request)),
  );
  const hits: Hit[] = [];
  let failures = 0;
  for (const reply of replies) {
    if (reply.status === 'rejected') {
      failures += 1; // a shard that did not answer is missing, never empty
      continue;
    }
    hits.push(...reply.value);
  }
  return {hits, failures};
}

app.post('/v1/search', async (request, reply) => {
  const authenticated = request.headers['x-tenant-id'];
  if (typeof authenticated !== 'string' || authenticated === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = (request.body ?? {}) as Partial<ShardRequest>;
  const request_ = {
    tenant: authenticated,
    vector: body.vector ?? [],
    k: body.k ?? 10,
    index_version: ACTIVE_INDEX_VERSION,
  } satisfies ShardRequest;

  const {hits, failures} = await scatterGather(authenticated, request_);
  const answered = SHARD_TARGETS.length - failures;
  const quorum = quorumSize(SHARD_TARGETS.length);
  if (answered < quorum)
    return reply
      .code(503)
      .send({error: 'quorum not met', answered, required: quorum, partial: true});

  hits.sort((left, right) => right.score - left.score);
  request.log.info({tenant: authenticated, k: request_.k, answered, partial: failures > 0}, 'scattered');
  return reply.code(200).send({
    hits: hits.slice(0, request_.k),
    k: request_.k,
    index_version: ACTIVE_INDEX_VERSION,
    partial: failures > 0,
    shards: {answered, required: quorum},
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
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	shards "search/shardspb"
)

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

var shardTargets = []string{"index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100"}

func shardClient(target string) shards.IndexShardClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return shards.NewIndexShardClient(conn)
}

func queryShard(ctx context.Context, target string, request *shards.SearchRequest) []Hit {
	// TODO: this draft has no deadline, no quorum and no retry budget. It awaits every shard
	// forever, turns a rejected shard into an empty hit list, and retries timeouts in a loop that
	// never ends. Review all three before this fan-out takes traffic.
	for {
		reply, err := shardClient(target).Search(ctx, request)
		if err == nil {
			return hitsFrom(reply, target)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func search(rw http.ResponseWriter, r *http.Request, body shards.SearchRequest) {
	results := make(chan []Hit, len(shardTargets))
	for _, target := range shardTargets {
		go func(target string) {
			results <- queryShard(r.Context(), target, &body)
		}(target)
	}
	hits := make([]Hit, 0)
	for range shardTargets {
		hits = append(hits, <-results...)
	}
	log.Printf("search k=%d hits=%d", body.K, len(hits))
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"hits": hits, "k": body.K})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", func(rw http.ResponseWriter, r *http.Request) {
		var body shards.SearchRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		search(rw, r, body)
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	shards "search/shardspb"
)

const (
	activeIndexVersion = "idx-42"
	shardDeadline      = 400 * time.Millisecond
	retryBudget        = 150 * time.Millisecond
	maxAttempts        = 2
)

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

var shardTargets = []string{"index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100"}

func shardClient(target string) shards.IndexShardClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return shards.NewIndexShardClient(conn)
}

func quorumSize(shardCount int) int {
	return shardCount/2 + 1
}

func queryShard(ctx context.Context, target string, request *shards.SearchRequest) ([]Hit, error) {
	until := time.Now().Add(retryBudget)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		shardCtx, cancel := context.WithTimeout(ctx, shardDeadline)
		reply, err := shardClient(target).Search(shardCtx, request)
		cancel()
		if err == nil {
			return hitsFrom(reply, target), nil
		}
		code := status.Code(err)
		if code != codes.DeadlineExceeded && code != codes.Unavailable {
			return nil, err
		}
		if time.Now().After(until) {
			break
		}
	}
	return nil, fmt.Errorf("%s missed the %s deadline", target, shardDeadline)
}

func scatterGather(ctx context.Context, request *shards.SearchRequest) ([]Hit, int) {
	type outcome struct {
		hits []Hit
		err  error
	}
	results := make(chan outcome, len(shardTargets))
	for _, target := range shardTargets {
		go func(target string) {
			hits, err := queryShard(ctx, target, request)
			results <- outcome{hits: hits, err: err}
		}(target)
	}
	hits := make([]Hit, 0)
	failures := 0
	for range shardTargets {
		result := <-results
		if result.err != nil {
			failures += 1 // a shard that did not answer is missing, never empty
			continue
		}
		hits = append(hits, result.hits...)
	}
	return hits, failures
}

func search(rw http.ResponseWriter, r *http.Request, body *shards.SearchRequest) {
	hits, failures := scatterGather(r.Context(), body)
	answered := len(shardTargets) - failures
	quorum := quorumSize(len(shardTargets))
	if answered < quorum {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(rw).Encode(map[string]any{
			"error":    "quorum not met",
			"answered": answered,
			"required": quorum,
			"partial":  true,
		})
		return
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > int(body.K) {
		hits = hits[:body.K]
	}
	log.Printf("search tenant=%s k=%d answered=%d partial=%t", body.Tenant, body.K, answered, failures > 0)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"hits":          hits,
		"k":             body.K,
		"index_version": activeIndexVersion,
		"partial":       failures > 0,
		"shards":        map[string]int{"answered": answered, "required": quorum},
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", func(rw http.ResponseWriter, r *http.Request) {
		var body shards.SearchRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		search(rw, r, &body)
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import scala.concurrent.duration._
import scala.concurrent.{Await, ExecutionContext, Future}

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import shards.IndexShardGrpc
import shards.Shards.SearchRequest
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchBody(query: List[Double], k: Int)
final case class Hit(id: String, score: Double)

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val executionContext: ExecutionContext = system.dispatcher
  implicit val bodyFormat: RootJsonFormat[SearchBody] = jsonFormat2(SearchBody)

  val ActiveIndexVersion = "idx-42"
  val ShardTargets = Seq("index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100")
  val stubs = ShardTargets.map(target =>
    IndexShardGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build()))

  def queryShard(stub: IndexShardGrpc.IndexShardBlockingStub, request: SearchRequest): List[Hit] = {
    // TODO: this draft has no deadline, no quorum and no retry budget. It awaits every shard
    // forever, turns a rejected shard into an empty hit list, and retries timeouts in a loop that
    // never ends. Review all three before this fan-out takes traffic.
    while (true) {
      try {
        val reply = stub.search(request)
        return reply.hits.map(hit => Hit(hit.id, hit.score)).toList
      } catch {
        case _: io.grpc.StatusRuntimeException => Thread.sleep(50)
      }
    }
    Nil
  }

  def scatterGather(request: SearchRequest): List[Hit] = stubs.flatMap { stub =>
    Await.result(Future(queryShard(stub, request)).recover { case _ => Nil }, Duration.Inf)
  }

  val route: Route =
    path("v1" / "search") {
      post {
        entity(as[SearchBody]) { body =>
          val request = SearchRequest(tenant = "", query = body.query, k = body.k, indexVersion = ActiveIndexVersion)
          val hits = scatterGather(request)
          system.log.info(s"search k=\${body.k} hits=\${hits.size}")
          complete(StatusCodes.OK, s"""{"k":\${body.k},"index_version":"$ActiveIndexVersion","hits":\${hits.size}}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import scala.collection.mutable.ListBuffer
import scala.concurrent.duration._
import scala.concurrent.{ExecutionContext, Future}

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import shards.IndexShardGrpc
import shards.Shards.SearchRequest
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchBody(query: List[Double], k: Int)
final case class Hit(id: String, score: Double)
final case class Gather(hits: List[Hit], failures: Int)

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val executionContext: ExecutionContext = system.dispatcher
  implicit val bodyFormat: RootJsonFormat[SearchBody] = jsonFormat2(SearchBody)

  val ShardDeadlineMs = 400L
  val RetryBudgetMs = 150L
  val MaxAttempts = 2
  val ActiveIndexVersion = "idx-42"
  val ShardTargets = Seq("index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100")
  val stubs = ShardTargets.map(target =>
    IndexShardGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build()))

  def quorumSize(shardCount: Int): Int = shardCount / 2 + 1

  def queryShard(stub: IndexShardGrpc.IndexShardBlockingStub, target: String, request: SearchRequest): Option[List[Hit]] = {
    val until = System.currentTimeMillis() + RetryBudgetMs
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = stub.withDeadlineAfter(ShardDeadlineMs, MILLISECONDS).search(request)
        return Some(reply.hits.map(hit => Hit(hit.id, hit.score)).toList)
      } catch {
        case error: StatusRuntimeException =>
          val code = error.getStatus.getCode
          if (code != Status.Code.DEADLINE_EXCEEDED && code != Status.Code.UNAVAILABLE) throw error
          if (System.currentTimeMillis() >= until) return None
      }
    }
    None
  }

  def scatterGather(tenant: String, query: List[Double], k: Int): Future[Gather] = {
    val request = SearchRequest(tenant = tenant, query = query, k = k, indexVersion = ActiveIndexVersion)
    val pending = stubs.zip(ShardTargets).map { case (stub, target) =>
      Future(queryShard(stub, target, request)).recover { case _ => None }
    }
    Future.sequence(pending).map { answers =>
      val hits = ListBuffer.empty[Hit]
      var failures = 0
      answers.foreach {
        case Some(shardHits) => hits ++= shardHits
        case None =>
          failures += 1 // a shard that did not answer is missing, never empty
      }
      Gather(hits.toList, failures)
    }
  }

  val route: Route =
    path("v1" / "search") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[SearchBody]) { body =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(tenant) =>
                onSuccess(scatterGather(tenant, body.query, body.k)) { gather =>
                  val answered = ShardTargets.length - gather.failures
                  val quorum = quorumSize(ShardTargets.length)
                  if (answered < quorum) {
                    complete(
                      StatusCodes.ServiceUnavailable,
                      s"""{"error":"quorum not met","answered":$answered,"required":$quorum,"partial":true}""")
                  } else {
                    val ranked = gather.hits.sortBy(hit => -hit.score).take(body.k)
                    system.log.info(s"search tenant=$tenant k=\${body.k} answered=$answered partial=\${gather.failures > 0}")
                    complete(
                      StatusCodes.OK,
                      s"""{"k":\${body.k},"index_version":"$ActiveIndexVersion","partial":\${gather.failures > 0},"shards":{"answered":$answered,"required":$quorum},"hits":\${ranked.size}}""")
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
#include <future>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "shards.grpc.pb.h"

using json = nlohmann::json;

const std::string kActiveIndexVersion = "idx-42";

struct Hit {
  std::string id;
  double score;
};

struct ShardOutcome {
  bool ok;
  std::vector<Hit> hits;
};

const std::vector<std::string> kShardTargets = {"index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100"};

std::unique_ptr<shards::IndexShard::Stub> shardStub(const std::string& target) {
  return shards::IndexShard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
}

ShardOutcome queryShard(const std::string& target, const shards::SearchRequest& request) {
  // TODO: this draft has no deadline, no quorum and no retry budget. It awaits every shard
  // forever, turns a rejected shard into an empty hit list, and retries timeouts in a loop that
  // never ends. Review all three before this fan-out takes traffic.
  auto stub = shardStub(target);
  while (true) {
    grpc::ClientContext context;
    shards::SearchReply reply;
    const grpc::Status outcome = stub->Search(&context, request, &reply);
    if (outcome.ok()) {
      return ShardOutcome{true, hitsFrom(reply, target)};
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    shards::SearchRequest request;
    request.set_tenant(body.value("tenant", std::string()));
    request.set_index_version(kActiveIndexVersion);

    std::vector<std::future<ShardOutcome>> pending;
    for (const auto& target : kShardTargets) {
      pending.push_back(std::async(std::launch::async, [target, request] { return queryShard(target, request); }));
    }
    std::vector<Hit> hits;
    for (auto& future : pending) {
      const auto outcome = future.get();
      hits.insert(hits.end(), outcome.hits.begin(), outcome.hits.end());
    }
    res.status = 200;
    res.set_content(json{{"hits", hits.size()}, {"index_version", kActiveIndexVersion}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "shards.grpc.pb.h"

using json = nlohmann::json;

constexpr int kShardDeadlineMs = 400;
constexpr int kRetryBudgetMs = 150;
constexpr int kMaxAttempts = 2;
const std::string kActiveIndexVersion = "idx-42";

struct Hit {
  std::string id;
  double score;
};

struct ShardOutcome {
  bool ok;
  std::vector<Hit> hits;
};

const std::vector<std::string> kShardTargets = {"index-shard-0:9100", "index-shard-1:9100", "index-shard-2:9100"};

std::unique_ptr<shards::IndexShard::Stub> shardStub(const std::string& target) {
  return shards::IndexShard::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
}

int quorumSize(int shardCount) {
  return shardCount / 2 + 1;
}

ShardOutcome queryShard(const std::string& target, const shards::SearchRequest& request) {
  auto stub = shardStub(target);
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(kRetryBudgetMs);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kShardDeadlineMs));
    shards::SearchReply reply;
    const grpc::Status outcome = stub->Search(&context, request, &reply);
    if (outcome.ok()) {
      return ShardOutcome{true, hitsFrom(reply, target)};
    }
    if (outcome.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED &&
        outcome.error_code() != grpc::StatusCode::UNAVAILABLE) {
      return ShardOutcome{false, {}};
    }
    if (std::chrono::steady_clock::now() >= until) {
      break;
    }
  }
  return ShardOutcome{false, {}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    shards::SearchRequest request;
    request.set_tenant(body.value("tenant", std::string()));
    request.set_index_version(kActiveIndexVersion);

    std::vector<std::future<ShardOutcome>> pending;
    for (const auto& target : kShardTargets) {
      pending.push_back(std::async(std::launch::async, [target, request] { return queryShard(target, request); }));
    }
    std::vector<Hit> hits;
    int failures = 0;
    for (auto& future : pending) {
      const auto outcome = future.get();
      if (!outcome.ok) {
        failures += 1; // a shard that did not answer is missing, never empty
        continue;
      }
      hits.insert(hits.end(), outcome.hits.begin(), outcome.hits.end());
    }

    const int answered = static_cast<int>(kShardTargets.size()) - failures;
    const int quorum = quorumSize(static_cast<int>(kShardTargets.size()));
    if (answered < quorum) {
      res.status = 503;
      res.set_content(json{{"error", "quorum not met"},
                           {"answered", answered},
                           {"required", quorum},
                           {"partial", true}}
                          .dump(),
                      "application/json");
      return;
    }

    res.status = 200;
    res.set_content(json{{"hits", hits.size()},
                         {"index_version", kActiveIndexVersion},
                         {"partial", failures > 0},
                         {"shards", {{"answered", answered}, {"required", quorum}}}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `A scatter-gather is where a search service's tail latency and its honesty both live. The draft's
three defects are the three questions an interviewer asks in order. First, is the wait bounded?
Without a per-attempt deadline the service inherits the slowest shard's latency, so one hot shard
becomes an outage. Second, is the answer complete? A quorum turns "some shards replied" into a
decidable question, and the 503 is the honest answer when the majority did not — a 200 with a short
list is a lie that the ranking makes plausible. Third, do retries have a budget? Retrying a timeout
without a bound multiplies load exactly when the shard is already struggling, which is how a partial
outage becomes a total one. The subtle bug is the exception handler that maps a shard error to an
empty list: it destroys the failure signal that the quorum and the \`partial\` flag depend on. Real
services add hedged requests against the second-fastest shard, per-shard circuit breakers, and a
merging strategy (score normalization, dedupe by document id, tie-break by shard) so a partial answer
still ranks correctly.
`,
};
