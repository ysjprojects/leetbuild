import type {Step} from '@/lib/types';

export const shadowClientStep: Step = {
  id: 'dependency',
  title: 'A candidate call that cannot hurt the production answer',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries'],
  file: 'client',
  focus: ['shadow', 'prodmodel', 'candidate', 'redis'],
  task: `## Task

**Starting point.** The starter is the request path with its shadow: \`complete(config_id, prompt)\`
asks the production model (\`Model.Complete\` at \`production-model:9000\`) for the answer, sends the
same prompt to the config's candidate version at \`candidate-model:9000\` up to
\`CANDIDATE_ATTEMPTS\` = 3 times, raising the last error, counts the shadow \`completed\` with
\`store.count\`, and returns production's text. With both models healthy it answers, and it hides
five flaws.

**Failure mode the checks target.** A candidate that hangs holds every shadowed request as long as it
hangs; a candidate that is down fails production requests outright; each failure is sent three
times; lost shadows are not counted; and an outage keeps receiving every shadowed request.

\`\`\`proto
service Model { rpc Complete(CompleteRequest) returns (CompleteReply); }
\`\`\`

- The candidate call carries \`SHADOW_DEADLINE_S\` = 0.3 s and is made once.
- A candidate error never reaches the caller: production's text is returned whatever the shadow did.
- Each shadow is counted \`completed\` or \`dropped\` (\`shadow:{config_id}:stats\`).
- \`BREAKER_FAILURES\` = 5 failures in a row (\`shadow:{config_id}:failures\`, reset by a success)
  set \`shadow:{config_id}:breaker\` for \`BREAKER_OPEN_S\` = 30 s; while it exists the candidate is
  not called and the shadow counts as dropped.`,
  sequence: {
    participants: ['Shadow runner', 'Production model', 'Candidate model', 'Redis'],
    messages: [
      {from: 'Shadow runner', to: 'Production model', label: 'Complete(prod-2026-03, prompt)', kind: 'sync'},
      {from: 'Production model', to: 'Shadow runner', label: 'the answer the user gets', kind: 'reply'},
      {from: 'Shadow runner', to: 'Redis', label: 'EXISTS shadow:{id}:breaker', kind: 'sync'},
      {
        from: 'Shadow runner',
        to: 'Candidate model',
        label: 'Complete(candidate, prompt) · 300 ms · once',
        kind: 'sync',
      },
      {from: 'Candidate model', to: 'Shadow runner', label: 'reply / DEADLINE_EXCEEDED · UNAVAILABLE', kind: 'reply'},
      {
        from: 'Shadow runner',
        to: 'Redis',
        label: 'count completed / dropped · INCR failures → SET breaker EX 30',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the candidate with a 300 ms deadline',
      detail:
        'The candidate call carries `SHADOW_DEADLINE_S` (0.3 s), so a candidate that hangs costs a shadowed request at most that. The starter sets no deadline: a 5 s candidate makes a 5 s production request.',
      match: {
        python: {
          all: [
            /SHADOW_DEADLINE_S\s*=\s*0?\.3\b/,
            /candidate\.Complete\([\s\S]{0,200}?timeout\s*=\s*SHADOW_DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /SHADOW_DEADLINE_MS\s*=\s*300\b/,
            /candidate\.Complete\([\s\S]{0,200}?deadline:[^\n]*SHADOW_DEADLINE_MS/,
          ],
        },
        go: {
          all: [/shadowDeadline\s*=\s*300\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*shadowDeadline\)/],
        },
        cpp: {all: [/kShadowDeadline\{300\}/, /set_deadline\([^\n]*kShadowDeadline\)/]},
      },
    },
    {
      id: 'isolate',
      title: 'A candidate failure never fails the production request',
      detail:
        "With the candidate down or failing with any status (`UNAVAILABLE`, `INTERNAL`, `RESOURCE_EXHAUSTED` and others), `complete` still returns production's text. The starter raises the candidate's last error, so a broken experiment takes production down with it.",
      match: {
        python: {all: [/except grpc\.RpcError/], none: [/^\s*raise\b/m]},
        typescript: {all: [/catch/], none: [/^\s*throw\b/m]},
        go: {all: [/candidate\.Complete\(/], none: [/candidate\.Complete\([\s\S]{0,300}?return "", err/]},
        cpp: {all: [/candidate->Complete\(/], none: [/^\s*throw\b/m]},
      },
    },
    {
      id: 'no-retry',
      title: 'Makes one attempt per shadow',
      detail:
        'A failed shadow is not sent again. The starter tries `CANDIDATE_ATTEMPTS` times, which triples the load on a candidate that is already failing.',
      match: {
        python: {none: [/CANDIDATE_ATTEMPTS/, /for attempt in/]},
        typescript: {none: [/CANDIDATE_ATTEMPTS/, /for \(let attempt/]},
        go: {none: [/candidateAttempts/, /for attempt :=/]},
        cpp: {none: [/kCandidateAttempts/, /for \(int attempt/]},
      },
    },
    {
      id: 'dropped',
      title: 'Counts every dropped shadow',
      detail:
        'A shadow that failed with any status, timed out or was skipped is counted `dropped` in `shadow:{config_id}:stats`, so the report can say how much of the share was lost. The starter counts only completions.',
      match: {
        python: {all: [/store\.count\([^\n]*["']dropped["']/]},
        typescript: {all: [/count\([^\n]*['"]dropped['"]/]},
        go: {all: [/store\.Count\([^\n]*"dropped"/]},
        cpp: {all: [/store::count\([^\n]*"dropped"/]},
      },
    },
    {
      id: 'breaker',
      title: 'Stops calling a failing candidate for 30 seconds',
      detail:
        'Five failures in a row set `shadow:{config_id}:breaker`, with its 30 s expiry in the same command, and while it exists the candidate is not called. The count is `shadow:{config_id}:failures`, shared by every instance, and a success resets it. The starter keeps sending every shadowed request to a candidate that is down.',
      match: {
        python: {all: [/:breaker/, /BREAKER_FAILURES\s*=\s*5\b/, /BREAKER_OPEN_S\s*=\s*30\b/]},
        typescript: {all: [/:breaker/, /BREAKER_FAILURES\s*=\s*5\b/, /BREAKER_OPEN_S\s*=\s*30\b/]},
        go: {all: [/:breaker/, /breakerFailures\s*=\s*5\b/, /breakerOpen\s*=\s*30\s*\*\s*time\.Second/]},
        cpp: {all: [/:breaker/, /kBreakerFailures\s*=\s*5\b/, /kBreakerOpen\{30\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import shadow_eval_pb2
import shadow_eval_pb2_grpc
from shadow import store  # get_config, count

PRODUCTION_VERSION = "prod-2026-03"
PRODUCTION_DEADLINE_S = 5
CANDIDATE_ATTEMPTS = 3

production = shadow_eval_pb2_grpc.ModelStub(grpc.insecure_channel("production-model:9000"))
candidate = shadow_eval_pb2_grpc.ModelStub(grpc.insecure_channel("candidate-model:9000"))


def complete(config_id: str, prompt: str) -> str:
    """Answer the request from production, then shadow it on the config's candidate version."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    reply = production.Complete(shadow_eval_pb2.CompleteRequest(model_version=PRODUCTION_VERSION, prompt=prompt), timeout=PRODUCTION_DEADLINE_S)
    config = store.get_config(config_id)
    request = shadow_eval_pb2.CompleteRequest(model_version=config["candidate_version"], prompt=prompt)
    for attempt in range(CANDIDATE_ATTEMPTS):
        try:
            candidate.Complete(request)
            break
        except grpc.RpcError:
            if attempt == CANDIDATE_ATTEMPTS - 1:
                raise
    store.count(config_id, "completed")
    return reply.text
`,
      solution: `import grpc
import redis

import shadow_eval_pb2
import shadow_eval_pb2_grpc
from shadow import store  # get_config, count

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PRODUCTION_VERSION = "prod-2026-03"
PRODUCTION_DEADLINE_S = 5
SHADOW_DEADLINE_S = 0.3
BREAKER_FAILURES = 5
BREAKER_OPEN_S = 30

production = shadow_eval_pb2_grpc.ModelStub(grpc.insecure_channel("production-model:9000"))
candidate = shadow_eval_pb2_grpc.ModelStub(grpc.insecure_channel("candidate-model:9000"))


def shadow(config_id: str, prompt: str) -> None:
    """Run the candidate on the prompt once; whatever happens here, production's answer stands."""
    if r.exists(f"shadow:{config_id}:breaker"):
        store.count(config_id, "dropped")  # the candidate is failing: leave it alone until the breaker expires
        return
    config = store.get_config(config_id)
    request = shadow_eval_pb2.CompleteRequest(model_version=config["candidate_version"], prompt=prompt)
    try:
        candidate.Complete(request, timeout=SHADOW_DEADLINE_S)
    except grpc.RpcError:
        store.count(config_id, "dropped")
        if r.incr(f"shadow:{config_id}:failures") >= BREAKER_FAILURES:
            r.set(f"shadow:{config_id}:breaker", "open", ex=BREAKER_OPEN_S)
            r.delete(f"shadow:{config_id}:failures")
        return
    r.delete(f"shadow:{config_id}:failures")
    store.count(config_id, "completed")


def complete(config_id: str, prompt: str) -> str:
    """Answer the request from production, then shadow it on the config's candidate version."""
    reply = production.Complete(shadow_eval_pb2.CompleteRequest(model_version=PRODUCTION_VERSION, prompt=prompt), timeout=PRODUCTION_DEADLINE_S)
    shadow(config_id, prompt)
    return reply.text
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {count, getConfig} from 'shadow/store';

export const PRODUCTION_VERSION = 'prod-2026-03';
export const PRODUCTION_DEADLINE_MS = 5000;
export const CANDIDATE_ATTEMPTS = 3;

interface CompleteRequest {
  model_version: string;
  prompt: string;
}

type ModelClient = grpc.Client & {
  Complete(request: CompleteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; model_version: string}>;
};

const {shadoweval} = grpc.loadPackageDefinition(protoLoader.loadSync('shadow_eval.proto')) as unknown as {
  shadoweval: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const production = new shadoweval.Model('production-model:9000', grpc.credentials.createInsecure());
const candidate = new shadoweval.Model('candidate-model:9000', grpc.credentials.createInsecure());

/** Answer the request from production, then shadow it on the config's candidate version. */
export async function complete(configId: string, prompt: string): Promise<string> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const reply = await production.Complete({model_version: PRODUCTION_VERSION, prompt}, new grpc.Metadata(), {
    deadline: Date.now() + PRODUCTION_DEADLINE_MS,
  });
  const config = await getConfig(configId);
  const request = {model_version: config?.candidate_version ?? '', prompt};
  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt += 1) {
    try {
      await candidate.Complete(request, new grpc.Metadata(), {});
      break;
    } catch (err) {
      if (attempt === CANDIDATE_ATTEMPTS - 1) throw err;
    }
  }
  await count(configId, 'completed');
  return reply.text;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {count, getConfig} from 'shadow/store';

const redis = new Redis({host: 'redis', port: 6379});

export const PRODUCTION_VERSION = 'prod-2026-03';
export const PRODUCTION_DEADLINE_MS = 5000;
export const SHADOW_DEADLINE_MS = 300;
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_S = 30;

interface CompleteRequest {
  model_version: string;
  prompt: string;
}

type ModelClient = grpc.Client & {
  Complete(request: CompleteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; model_version: string}>;
};

const {shadoweval} = grpc.loadPackageDefinition(protoLoader.loadSync('shadow_eval.proto')) as unknown as {
  shadoweval: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const production = new shadoweval.Model('production-model:9000', grpc.credentials.createInsecure());
const candidate = new shadoweval.Model('candidate-model:9000', grpc.credentials.createInsecure());

/** Run the candidate on the prompt once; whatever happens here, production's answer stands. */
async function shadow(configId: string, prompt: string): Promise<void> {
  if ((await redis.exists(\`shadow:\${configId}:breaker\`)) === 1) {
    await count(configId, 'dropped'); // the candidate is failing: leave it alone until the breaker expires
    return;
  }
  const config = await getConfig(configId);
  try {
    await candidate.Complete({model_version: config?.candidate_version ?? '', prompt}, new grpc.Metadata(), {
      deadline: Date.now() + SHADOW_DEADLINE_MS,
    });
  } catch {
    await count(configId, 'dropped');
    if ((await redis.incr(\`shadow:\${configId}:failures\`)) >= BREAKER_FAILURES) {
      await redis.set(\`shadow:\${configId}:breaker\`, 'open', 'EX', BREAKER_OPEN_S);
      await redis.del(\`shadow:\${configId}:failures\`);
    }
    return;
  }
  await redis.del(\`shadow:\${configId}:failures\`);
  await count(configId, 'completed');
}

/** Answer the request from production, then shadow it on the config's candidate version. */
export async function complete(configId: string, prompt: string): Promise<string> {
  const reply = await production.Complete({model_version: PRODUCTION_VERSION, prompt}, new grpc.Metadata(), {
    deadline: Date.now() + PRODUCTION_DEADLINE_MS,
  });
  await shadow(configId, prompt);
  return reply.text;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"shadow/store" // store.GetConfig, Count
	pb "shadoweval/gen/shadow_eval"
)

const (
	productionVersion  = "prod-2026-03"
	productionDeadline = 5 * time.Second
	candidateAttempts  = 3
)

var (
	productionConn, _ = grpc.NewClient("production-model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	candidateConn, _  = grpc.NewClient("candidate-model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	production        = pb.NewModelClient(productionConn)
	candidate         = pb.NewModelClient(candidateConn)
)

// complete answers the request from production, then shadows it on the config's candidate version.
func complete(ctx context.Context, configID, prompt string) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	callCtx, cancel := context.WithTimeout(ctx, productionDeadline)
	defer cancel()
	reply, err := production.Complete(callCtx, &pb.CompleteRequest{ModelVersion: productionVersion, Prompt: prompt})
	if err != nil {
		return "", err
	}
	config := store.GetConfig(ctx, configID)
	request := &pb.CompleteRequest{ModelVersion: config.CandidateVersion, Prompt: prompt}
	for attempt := 0; attempt < candidateAttempts; attempt++ {
		_, err = candidate.Complete(ctx, request)
		if err == nil {
			break
		}
		if attempt == candidateAttempts-1 {
			return "", err
		}
	}
	store.Count(ctx, configID, "completed")
	return reply.GetText(), nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"shadow/store" // store.GetConfig, Count
	pb "shadoweval/gen/shadow_eval"
)

const (
	productionVersion  = "prod-2026-03"
	productionDeadline = 5 * time.Second
	shadowDeadline     = 300 * time.Millisecond
	breakerFailures    = 5
	breakerOpen        = 30 * time.Second
)

var (
	productionConn, _ = grpc.NewClient("production-model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	candidateConn, _  = grpc.NewClient("candidate-model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	production        = pb.NewModelClient(productionConn)
	candidate         = pb.NewModelClient(candidateConn)
	rdb               = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

// complete answers the request from production, then shadows it on the config's candidate version.
func complete(ctx context.Context, configID, prompt string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, productionDeadline)
	defer cancel()
	reply, err := production.Complete(callCtx, &pb.CompleteRequest{ModelVersion: productionVersion, Prompt: prompt})
	if err != nil {
		return "", err
	}
	shadow(ctx, configID, prompt)
	return reply.GetText(), nil
}

// shadow runs the candidate on the prompt once; whatever happens here, production's answer stands.
func shadow(ctx context.Context, configID, prompt string) {
	if rdb.Exists(ctx, "shadow:"+configID+":breaker").Val() == 1 {
		store.Count(ctx, configID, "dropped") // the candidate is failing: leave it alone until the breaker expires
		return
	}
	config := store.GetConfig(ctx, configID)
	callCtx, cancel := context.WithTimeout(ctx, shadowDeadline)
	defer cancel()
	if _, err := candidate.Complete(callCtx, &pb.CompleteRequest{ModelVersion: config.CandidateVersion, Prompt: prompt}); err != nil {
		store.Count(ctx, configID, "dropped")
		if rdb.Incr(ctx, "shadow:"+configID+":failures").Val() >= breakerFailures {
			rdb.Set(ctx, "shadow:"+configID+":breaker", "open", breakerOpen)
			rdb.Del(ctx, "shadow:"+configID+":failures")
		}
		return
	}
	rdb.Del(ctx, "shadow:"+configID+":failures")
	store.Count(ctx, configID, "completed")
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "shadow/store.h"  // store::getConfig, count
#include "shadow_eval.grpc.pb.h"

const std::string kProductionVersion = "prod-2026-03";
constexpr std::chrono::seconds kProductionDeadline{5};
constexpr int kCandidateAttempts = 3;

auto production = shadoweval::Model::NewStub(grpc::CreateChannel("production-model:9000", grpc::InsecureChannelCredentials()));
auto candidate = shadoweval::Model::NewStub(grpc::CreateChannel("candidate-model:9000", grpc::InsecureChannelCredentials()));

// Answer the request from production, then shadow it on the config's candidate version.
std::string complete(const std::string& config_id, const std::string& prompt) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  grpc::ClientContext prod_ctx;
  prod_ctx.set_deadline(std::chrono::system_clock::now() + kProductionDeadline);
  shadoweval::CompleteRequest prod_request;
  prod_request.set_model_version(kProductionVersion);
  prod_request.set_prompt(prompt);
  shadoweval::CompleteReply reply;
  const grpc::Status prod_status = production->Complete(&prod_ctx, prod_request, &reply);
  if (!prod_status.ok()) throw std::runtime_error("production: " + prod_status.error_message());
  shadoweval::CompleteRequest request;
  request.set_model_version(store::getConfig(config_id)->candidate_version);
  request.set_prompt(prompt);
  for (int attempt = 0; attempt < kCandidateAttempts; attempt++) {
    grpc::ClientContext ctx;
    shadoweval::CompleteReply shadow_reply;
    const grpc::Status status = candidate->Complete(&ctx, request, &shadow_reply);
    if (status.ok()) break;
    if (attempt == kCandidateAttempts - 1) throw std::runtime_error("candidate: " + status.error_message());
  }
  store::count(config_id, "completed");
  return reply.text();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "shadow/store.h"  // store::getConfig, count
#include "shadow_eval.grpc.pb.h"

const std::string kProductionVersion = "prod-2026-03";
constexpr std::chrono::seconds kProductionDeadline{5};
constexpr std::chrono::milliseconds kShadowDeadline{300};
constexpr long long kBreakerFailures = 5;
constexpr std::chrono::seconds kBreakerOpen{30};

auto production = shadoweval::Model::NewStub(grpc::CreateChannel("production-model:9000", grpc::InsecureChannelCredentials()));
auto candidate = shadoweval::Model::NewStub(grpc::CreateChannel("candidate-model:9000", grpc::InsecureChannelCredentials()));
sw::redis::Redis redis("tcp://redis:6379");

// Run the candidate on the prompt once; whatever happens here, production's answer stands.
void shadow(const std::string& config_id, const std::string& prompt) {
  if (redis.exists("shadow:" + config_id + ":breaker") > 0) {
    store::count(config_id, "dropped");  // the candidate is failing: leave it alone until the breaker expires
    return;
  }
  shadoweval::CompleteRequest request;
  request.set_model_version(store::getConfig(config_id)->candidate_version);
  request.set_prompt(prompt);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kShadowDeadline);
  shadoweval::CompleteReply shadow_reply;
  if (!candidate->Complete(&ctx, request, &shadow_reply).ok()) {
    store::count(config_id, "dropped");
    if (redis.incr("shadow:" + config_id + ":failures") >= kBreakerFailures) {
      redis.set("shadow:" + config_id + ":breaker", "open", kBreakerOpen);
      redis.del("shadow:" + config_id + ":failures");
    }
    return;
  }
  redis.del("shadow:" + config_id + ":failures");
  store::count(config_id, "completed");
}

// Answer the request from production, then shadow it on the config's candidate version.
std::string complete(const std::string& config_id, const std::string& prompt) {
  grpc::ClientContext prod_ctx;
  prod_ctx.set_deadline(std::chrono::system_clock::now() + kProductionDeadline);
  shadoweval::CompleteRequest prod_request;
  prod_request.set_model_version(kProductionVersion);
  prod_request.set_prompt(prompt);
  shadoweval::CompleteReply reply;
  const grpc::Status prod_status = production->Complete(&prod_ctx, prod_request, &reply);
  if (!prod_status.ok()) throw std::runtime_error("production: " + prod_status.error_message());
  shadow(config_id, prompt);
  return reply.text();
}
`,
    },
  },
  harness: {
    python: `import grpc

import shadow_eval_pb2
import shadow_eval_pb2_grpc
from shadow import store

PROD = "production-model:9000"
CAND = "candidate-model:9000"
ANSWER = "production answer to hello"


class Model(shadow_eval_pb2_grpc.ModelServicer):
    def __init__(self, name):
        self.name = name

    def Complete(self, request, context):
        return shadow_eval_pb2.CompleteReply(text=f"{self.name} answer to {request.prompt}", model_version=request.model_version)


def _world(ctx):
    ctx.grpc.serve(shadow_eval_pb2_grpc.add_ModelServicer_to_server, Model("production"), target=PROD)
    ctx.grpc.serve(shadow_eval_pb2_grpc.add_ModelServicer_to_server, Model("candidate"), target=CAND)
    cfg = store.create_config("t1", "cand-2026-04", 5, ["latency"])["config_id"]
    return ctx.load("client"), cfg


def _complete(m, cfg):
    try:
        text = m.complete(cfg, "hello")
    except Exception as exc:
        raise AssertionError(f"complete raised {type(exc).__name__}: {exc}. A shadow failure must never fail the production request")
    assert text == ANSWER, f"complete returned {text!r}, expected production's answer {ANSWER!r}"


def _stats(ctx, cfg):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"shadow:{cfg}:stats").items()}


def _candidate_calls(ctx):
    return len(ctx.grpc.calls_to("Complete", target=CAND))


def check_deadline(ctx):
    m, cfg = _world(ctx)
    ctx.grpc.set_latency("Complete", 5.0, target=CAND)
    before = ctx.clock.time()
    _complete(m, cfg)
    took = ctx.clock.time() - before
    calls = ctx.grpc.calls_to("Complete", target=CAND)
    assert calls, "the candidate was never called"
    timeout = calls[0].timeout
    assert timeout is not None and 0.25 <= timeout <= 0.35, f"the candidate call carries a {timeout} s deadline, expected SHADOW_DEADLINE_S = 0.3"
    assert took <= 1.0, f"a candidate that takes 5 s held the production request for {took:.1f} s: the shadow may cost it at most the 300 ms deadline"


def check_isolate(ctx):
    m, cfg = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, times=10, target=CAND)
    _complete(m, cfg)
    ctx.grpc.failures.clear()
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.UNKNOWN, grpc.StatusCode.INVALID_ARGUMENT):
        ctx.grpc.fail("Complete", code, times=1, target=CAND)
        _complete(m, cfg)


def check_no_retry(ctx):
    m, cfg = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, times=1, target=CAND)
    _complete(m, cfg)
    n = _candidate_calls(ctx)
    assert n == 1, f"one failed shadow reached the candidate {n} times: a shadow is attempted once"


def check_dropped(ctx):
    m, cfg = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, times=1, target=CAND)
    _complete(m, cfg)
    assert _stats(ctx, cfg) == {"dropped": 1}, f"after one failed shadow shadow:{cfg}:stats is {_stats(ctx, cfg)}, expected dropped 1"
    _complete(m, cfg)
    assert _stats(ctx, cfg) == {"dropped": 1, "completed": 1}, f"after a failed and a completed shadow the stats are {_stats(ctx, cfg)}"
    ctx.grpc.fail("Complete", grpc.StatusCode.INTERNAL, times=1, target=CAND)
    _complete(m, cfg)
    assert _stats(ctx, cfg) == {"dropped": 2, "completed": 1}, f"a shadow the candidate failed with INTERNAL is dropped too; the stats are {_stats(ctx, cfg)}"
    ctx.grpc.set_latency("Complete", 5.0, target=CAND)
    _complete(m, cfg)
    assert _stats(ctx, cfg).get("dropped") == 3, f"a shadow past its deadline is dropped too; the stats are {_stats(ctx, cfg)}"


def check_breaker(ctx):
    m, cfg = _world(ctx)
    breaker = f"shadow:{cfg}:breaker"
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, times=4, target=CAND)
    for _ in range(5):  # four failures, then the candidate answers
        _complete(m, cfg)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, times=4, target=CAND)
    for _ in range(4):
        _complete(m, cfg)
    n = _candidate_calls(ctx)
    assert n == 9 and not ctx.redis.exists(breaker), f"four failures, a success, then four failures: the candidate received {n} of 9 shadows and the breaker is {'open' if ctx.redis.exists(breaker) else 'closed'}. A success resets the count, so these are not five in a row"
    _complete(m, cfg)  # a success clears the count again
    failures = f"shadow:{cfg}:failures"
    ctx.redis.set(failures, 4)  # four failures in a row seen by other instances
    opened = {}

    def watch_breaker():  # the breaker's TTL right after the command that creates it
        if ctx.redis.exists(breaker):
            opened.setdefault("ttl", ctx.redis.ttl(breaker))
        else:
            ctx.redis_after(breaker, watch_breaker)

    ctx.redis_after(failures, watch_breaker)
    ctx.grpc.fail("Complete", grpc.StatusCode.INTERNAL, times=100, target=CAND)
    for _ in range(4):
        _complete(m, cfg)
    n = _candidate_calls(ctx)
    assert n == 11, f"after four failures counted in shadow:{cfg}:failures by other instances and one here, the candidate received {n - 10} of the next 4 shadows, expected 1: the count lives in Redis and the fifth failure in a row opens the breaker for the whole fleet"
    assert opened.get("ttl") == 30, f"right after the command that opened {breaker} its TTL was {opened.get('ttl')}, expected BREAKER_OPEN_S (30): the breaker is set with its expiry in one command"
    stats = _stats(ctx, cfg)
    assert stats.get("dropped") == 12 and stats.get("completed") == 2, f"12 shadows were lost and 2 completed, the stats say {stats}"
    ctx.clock.advance(31)
    _complete(m, cfg)
    assert _candidate_calls(ctx) == 12, "30 s after the breaker opened the candidate must get the next shadow again"
`,
    typescript: `const PROD = 'production-model:9000';
const CAND = 'candidate-model:9000';
const ANSWER = 'production answer to hello';

function world(ctx) {
  const {shadoweval} = ctx.proto('shadow_eval.proto');
  for (const [name, target] of [['production', PROD], ['candidate', CAND]]) {
    ctx.grpc.serve(
      shadoweval.Model.service,
      {
        Complete(call, callback) {
          callback(null, {text: \`\${name} answer to \${call.request.prompt}\`, model_version: call.request.model_version});
        },
      },
      target,
    );
  }
  return {m: ctx.load('client'), store: ctx.load('/support/shadow/store.ts')};
}

async function setup(ctx) {
  const {m, store} = world(ctx);
  const cfg = (await store.createConfig('t1', 'cand-2026-04', 5, ['latency'])).config_id;
  return {m, cfg};
}

async function complete(m, cfg: string): Promise<void> {
  let text;
  try {
    text = await m.complete(cfg, 'hello');
  } catch (e) {
    assert.fail(\`complete threw \${(e as Error).message}. A shadow failure must never fail the production request\`);
  }
  assert.equal(text, ANSWER, \`complete returned \${JSON.stringify(text)}, expected production's answer\`);
}

function stats(ctx, cfg: string): Record<string, number> {
  const raw = ctx.redis.hgetall(\`shadow:\${cfg}:stats\`) as Record<string, string>;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

const candidateCalls = (ctx): number => ctx.grpc.callsTo('Complete', CAND).length;

export async function check_deadline(ctx) {
  const {m, cfg} = await setup(ctx);
  ctx.grpc.setLatency('Complete', 5.0, CAND);
  const before = ctx.clock.now();
  await complete(m, cfg);
  const took = (ctx.clock.now() - before) / 1000;
  const calls = ctx.grpc.callsTo('Complete', CAND);
  assert(calls.length > 0, 'the candidate was never called');
  const timeout = calls[0].timeout;
  assert(timeout !== null && timeout >= 0.25 && timeout <= 0.35, \`the candidate call carries a \${timeout} s deadline, expected SHADOW_DEADLINE_MS = 300\`);
  assert(took <= 1.0, \`a candidate that takes 5 s held the production request for \${took.toFixed(1)} s: the shadow may cost it at most the 300 ms deadline\`);
}

export async function check_isolate(ctx) {
  const {m, cfg} = await setup(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, '', 10, CAND);
  await complete(m, cfg);
  ctx.grpc.clearFailures();
  for (const code of [ctx.grpc.status.INTERNAL, ctx.grpc.status.RESOURCE_EXHAUSTED, ctx.grpc.status.UNKNOWN, ctx.grpc.status.INVALID_ARGUMENT]) {
    ctx.grpc.fail('Complete', code, '', 1, CAND);
    await complete(m, cfg);
  }
}

export async function check_no_retry(ctx) {
  const {m, cfg} = await setup(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, '', 1, CAND);
  await complete(m, cfg);
  assert.equal(candidateCalls(ctx), 1, \`one failed shadow reached the candidate \${candidateCalls(ctx)} times: a shadow is attempted once\`);
}

export async function check_dropped(ctx) {
  const {m, cfg} = await setup(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, '', 1, CAND);
  await complete(m, cfg);
  assert.deepStrictEqual(stats(ctx, cfg), {dropped: 1}, \`after one failed shadow shadow:\${cfg}:stats is \${JSON.stringify(stats(ctx, cfg))}, expected dropped 1\`);
  await complete(m, cfg);
  assert.deepStrictEqual(stats(ctx, cfg), {dropped: 1, completed: 1}, \`after a failed and a completed shadow the stats are \${JSON.stringify(stats(ctx, cfg))}\`);
  ctx.grpc.fail('Complete', ctx.grpc.status.INTERNAL, '', 1, CAND);
  await complete(m, cfg);
  assert.deepStrictEqual(stats(ctx, cfg), {dropped: 2, completed: 1}, \`a shadow the candidate failed with INTERNAL is dropped too; the stats are \${JSON.stringify(stats(ctx, cfg))}\`);
  ctx.grpc.setLatency('Complete', 5.0, CAND);
  await complete(m, cfg);
  assert.equal(stats(ctx, cfg).dropped, 3, \`a shadow past its deadline is dropped too; the stats are \${JSON.stringify(stats(ctx, cfg))}\`);
}

export async function check_breaker(ctx) {
  const {m, cfg} = await setup(ctx);
  const breaker = \`shadow:\${cfg}:breaker\`;
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, '', 4, CAND);
  for (let i = 0; i < 5; i += 1) await complete(m, cfg); // four failures, then the candidate answers
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, '', 4, CAND);
  for (let i = 0; i < 4; i += 1) await complete(m, cfg);
  const open = ctx.redis.exists(breaker) === 1;
  assert(candidateCalls(ctx) === 9 && !open, \`four failures, a success, then four failures: the candidate received \${candidateCalls(ctx)} of 9 shadows and the breaker is \${open ? 'open' : 'closed'}. A success resets the count, so these are not five in a row\`);
  await complete(m, cfg); // a success clears the count again
  const failures = \`shadow:\${cfg}:failures\`;
  ctx.redis.set(failures, '4'); // four failures in a row seen by other instances
  let openedTtl: number | undefined;
  // The breaker's TTL right after the command that creates it.
  const watchBreaker = () => {
    if (ctx.redis.exists(breaker) === 1) openedTtl ??= ctx.redis.ttl(breaker);
    else ctx.redisAfter(breaker, watchBreaker);
  };
  ctx.redisAfter(failures, watchBreaker);
  ctx.grpc.fail('Complete', ctx.grpc.status.INTERNAL, '', 100, CAND);
  for (let i = 0; i < 4; i += 1) await complete(m, cfg);
  const n = candidateCalls(ctx);
  assert.equal(n, 11, \`after four failures counted in \${failures} by other instances and one here, the candidate received \${n - 10} of the next 4 shadows, expected 1: the count lives in Redis and the fifth failure in a row opens the breaker for the whole fleet\`);
  assert.equal(openedTtl, 30, \`right after the command that opened \${breaker} its TTL was \${openedTtl}, expected BREAKER_OPEN_S (30): the breaker is set with its expiry in one command\`);
  const s = stats(ctx, cfg);
  assert(s.dropped === 12 && s.completed === 2, \`12 shadows were lost and 2 completed, the stats say \${JSON.stringify(s)}\`);
  ctx.clock.advance(31);
  await complete(m, cfg);
  assert.equal(candidateCalls(ctx), 12, '30 s after the breaker opened the candidate must get the next shadow again');
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	"shadow/store"
	pb "shadoweval/gen/shadow_eval"

	"leetbuild/harness"
)

const (
	hProdTarget = "production-model:9000"
	hCandTarget = "candidate-model:9000"
	hProdAnswer = "production answer to hello"
)

var hClientBg = context.Background()

type hModelPeer struct {
	pb.UnimplementedModelServer
	name string
}

func (p *hModelPeer) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	return &pb.CompleteReply{Text: p.name + " answer to " + req.GetPrompt(), ModelVersion: req.GetModelVersion()}, nil
}

func hClientWorld(ctx *harness.Ctx) string {
	pb.RegisterModelServer(ctx.GRPC.Server(hProdTarget), &hModelPeer{name: "production"})
	pb.RegisterModelServer(ctx.GRPC.Server(hCandTarget), &hModelPeer{name: "candidate"})
	return store.CreateConfig(hClientBg, "t1", "cand-2026-04", 5, []string{"latency"}).ConfigID
}

func hComplete(ctx *harness.Ctx, cfg string) {
	text, err := complete(hClientBg, cfg, "hello")
	ctx.Assert(err == nil, "complete failed: %v. A shadow failure must never fail the production request", err)
	ctx.Equal(text, hProdAnswer, "complete must return production's answer")
}

func hShadowStats(ctx *harness.Ctx, cfg string) map[string]int {
	out := map[string]int{}
	for k, v := range ctx.Redis.HGetAll("shadow:" + cfg + ":stats") {
		n, _ := strconv.Atoi(v)
		out[k] = n
	}
	return out
}

func hCandidateCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Complete", hCandTarget)) }

func CheckDeadline(ctx *harness.Ctx) {
	cfg := hClientWorld(ctx)
	ctx.GRPC.SetLatency("Complete", 5.0, hCandTarget)
	before := ctx.Clock.Now()
	hComplete(ctx, cfg)
	took := float64(ctx.Clock.Now()-before) / 1000
	calls := ctx.GRPC.CallsTo("Complete", hCandTarget)
	ctx.Assert(len(calls) > 0, "the candidate was never called")
	ctx.Assert(calls[0].HasDeadline(), "the candidate call carries no deadline: a candidate that hangs holds the production request")
	ctx.Assert(250*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 350*time.Millisecond, "the candidate call carries a %v deadline, expected 300 ms", calls[0].Timeout)
	ctx.Assert(took <= 1.0, "a candidate that takes 5 s held the production request for %.1f s: the shadow may cost it at most the 300 ms deadline", took)
}

func CheckIsolate(ctx *harness.Ctx) {
	cfg := hClientWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "", 10, hCandTarget)
	hComplete(ctx, cfg)
	ctx.GRPC.ClearFailures()
	for _, code := range []codes.Code{codes.Internal, codes.ResourceExhausted, codes.Unknown, codes.InvalidArgument} {
		ctx.GRPC.Fail("Complete", code, "", 1, hCandTarget)
		hComplete(ctx, cfg)
	}
}

func CheckNoRetry(ctx *harness.Ctx) {
	cfg := hClientWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "", 1, hCandTarget)
	hComplete(ctx, cfg)
	ctx.Equal(hCandidateCalls(ctx), 1, "a shadow is attempted once; the candidate calls for one failed shadow")
}

func CheckDropped(ctx *harness.Ctx) {
	cfg := hClientWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "", 1, hCandTarget)
	hComplete(ctx, cfg)
	ctx.Equal(hShadowStats(ctx, cfg), map[string]int{"dropped": 1}, "after one failed shadow, shadow:%s:stats", cfg)
	hComplete(ctx, cfg)
	ctx.Equal(hShadowStats(ctx, cfg), map[string]int{"dropped": 1, "completed": 1}, "after a failed and a completed shadow, the stats")
	ctx.GRPC.Fail("Complete", codes.Internal, "", 1, hCandTarget)
	hComplete(ctx, cfg)
	ctx.Equal(hShadowStats(ctx, cfg), map[string]int{"dropped": 2, "completed": 1}, "a shadow the candidate failed with INTERNAL is dropped too; the stats")
	ctx.GRPC.SetLatency("Complete", 5.0, hCandTarget)
	hComplete(ctx, cfg)
	ctx.Equal(hShadowStats(ctx, cfg)["dropped"], 3, "a shadow past its deadline is dropped too; dropped")
}

func CheckBreaker(ctx *harness.Ctx) {
	cfg := hClientWorld(ctx)
	breaker := "shadow:" + cfg + ":breaker"
	ctx.GRPC.Fail("Complete", codes.Unavailable, "", 4, hCandTarget)
	for i := 0; i < 5; i++ { // four failures, then the candidate answers
		hComplete(ctx, cfg)
	}
	ctx.GRPC.Fail("Complete", codes.Unavailable, "", 4, hCandTarget)
	for i := 0; i < 4; i++ {
		hComplete(ctx, cfg)
	}
	open := ctx.Redis.Exists(breaker) == 1
	ctx.Assert(hCandidateCalls(ctx) == 9 && !open, "four failures, a success, then four failures: the candidate received %d of 9 shadows and the breaker is open=%v. A success resets the count, so these are not five in a row", hCandidateCalls(ctx), open)
	hComplete(ctx, cfg) // a success clears the count again
	failures := "shadow:" + cfg + ":failures"
	ctx.Redis.Set(failures, "4") // four failures in a row seen by other instances
	openedTTL := int64(-3)
	// The breaker's TTL right after the command that creates it.
	var watchBreaker func() any
	watchBreaker = func() any {
		if ctx.Redis.Exists(breaker) == 1 {
			if openedTTL == -3 {
				openedTTL = ctx.Redis.TTL(breaker)
			}
		} else {
			ctx.Redis.After(breaker, watchBreaker)
		}
		return nil
	}
	ctx.Redis.After(failures, watchBreaker)
	ctx.GRPC.Fail("Complete", codes.Internal, "", 100, hCandTarget)
	for i := 0; i < 4; i++ {
		hComplete(ctx, cfg)
	}
	n := hCandidateCalls(ctx)
	ctx.Assert(n == 11, "after four failures counted in %s by other instances and one here, the candidate received %d of the next 4 shadows, expected 1: the count lives in Redis and the fifth failure in a row opens the breaker for the whole fleet", failures, n-10)
	ctx.Equal(openedTTL, int64(30), "the breaker is set with its expiry in one command; the TTL of %s right after the command that opened it", breaker)
	stats := hShadowStats(ctx, cfg)
	ctx.Assert(stats["dropped"] == 12 && stats["completed"] == 2, "12 shadows were lost and 2 completed, the stats say %v", stats)
	ctx.Clock.Advance(31)
	hComplete(ctx, cfg)
	ctx.Equal(hCandidateCalls(ctx), 12, "30 s after the breaker opened the candidate must get the next shadow again; the calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <functional>
#include <map>
#include <string>

#include "shadow/store.h"
#include "shadow_eval.grpc.pb.h"

namespace {

const std::string kHProdTarget = "production-model:9000";
const std::string kHCandTarget = "candidate-model:9000";
const std::string kHProdAnswer = "production answer to hello";

class HModelPeer final : public shadoweval::Model::Service {
 public:
  explicit HModelPeer(std::string name) : name_(std::move(name)) {}
  grpc::Status Complete(grpc::ServerContext*, const shadoweval::CompleteRequest* req, shadoweval::CompleteReply* out) override {
    out->set_text(name_ + " answer to " + req->prompt());
    out->set_model_version(req->model_version());
    return grpc::Status::OK;
  }

 private:
  std::string name_;
};

struct HPeers {
  HModelPeer production{"production"};
  HModelPeer candidate{"candidate"};
};

std::string hClientWorld(harness::Ctx& ctx) {
  static HPeers* peers = nullptr;
  delete peers;
  peers = new HPeers;
  ctx.GRPC.Server(kHProdTarget)->RegisterService(&peers->production);
  ctx.GRPC.Server(kHCandTarget)->RegisterService(&peers->candidate);
  return store::createConfig("t1", "cand-2026-04", 5, {"latency"}).config_id;
}

void hComplete(harness::Ctx& ctx, const std::string& cfg) {
  std::string text;
  try {
    text = complete(cfg, "hello");
  } catch (const std::exception& e) {
    ctx.Fatalf("complete threw %s: %s. A shadow failure must never fail the production request", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(text, kHProdAnswer, "complete must return production's answer");
}

std::map<std::string, long long> hShadowStats(harness::Ctx& ctx, const std::string& cfg) {
  std::map<std::string, long long> out;
  for (const auto& [k, v] : ctx.Redis.HGetAll("shadow:" + cfg + ":stats")) out[k] = std::stoll(v);
  return out;
}

size_t hCandidateCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Complete", kHCandTarget).size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  const std::string cfg = hClientWorld(ctx);
  ctx.GRPC.SetLatency("Complete", 5.0, kHCandTarget);
  const int64_t before = ctx.Clock.Now();
  hComplete(ctx, cfg);
  const double took = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  const auto calls = ctx.GRPC.CallsTo("Complete", kHCandTarget);
  ctx.Assert(!calls.empty(), "the candidate was never called");
  ctx.Assert(calls[0].HasDeadline(), "the candidate call carries no deadline: a candidate that hangs holds the production request");
  ctx.Assert(0.25 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 0.35, "the candidate call carries a %v s deadline, expected 0.3 s", calls[0].TimeoutSeconds());
  ctx.Assert(took <= 1.0, "a candidate that takes 5 s held the production request for %.1f s: the shadow may cost it at most the 300 ms deadline", took);
}

void CheckIsolate(harness::Ctx& ctx) {
  const std::string cfg = hClientWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "", 10, kHCandTarget);
  hComplete(ctx, cfg);
  ctx.GRPC.ClearFailures();
  for (const auto code : {grpc::StatusCode::INTERNAL, grpc::StatusCode::RESOURCE_EXHAUSTED, grpc::StatusCode::UNKNOWN, grpc::StatusCode::INVALID_ARGUMENT}) {
    ctx.GRPC.Fail("Complete", code, "", 1, kHCandTarget);
    hComplete(ctx, cfg);
  }
}

void CheckNoRetry(harness::Ctx& ctx) {
  const std::string cfg = hClientWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "", 1, kHCandTarget);
  hComplete(ctx, cfg);
  ctx.Equal(hCandidateCalls(ctx), 1, "a shadow is attempted once; the candidate calls for one failed shadow");
}

void CheckDropped(harness::Ctx& ctx) {
  const std::string cfg = hClientWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "", 1, kHCandTarget);
  hComplete(ctx, cfg);
  ctx.Equal(hShadowStats(ctx, cfg), std::map<std::string, long long>{{"dropped", 1}}, "after one failed shadow, shadow:%s:stats", cfg);
  hComplete(ctx, cfg);
  ctx.Equal(hShadowStats(ctx, cfg), std::map<std::string, long long>{{"completed", 1}, {"dropped", 1}}, "after a failed and a completed shadow, the stats");
  ctx.GRPC.Fail("Complete", grpc::StatusCode::INTERNAL, "", 1, kHCandTarget);
  hComplete(ctx, cfg);
  ctx.Equal(hShadowStats(ctx, cfg), std::map<std::string, long long>{{"completed", 1}, {"dropped", 2}}, "a shadow the candidate failed with INTERNAL is dropped too; the stats");
  ctx.GRPC.SetLatency("Complete", 5.0, kHCandTarget);
  hComplete(ctx, cfg);
  ctx.Equal(hShadowStats(ctx, cfg)["dropped"], 3, "a shadow past its deadline is dropped too; dropped");
}

void CheckBreaker(harness::Ctx& ctx) {
  const std::string cfg = hClientWorld(ctx);
  const std::string breaker = "shadow:" + cfg + ":breaker";
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "", 4, kHCandTarget);
  for (int i = 0; i < 5; i++) hComplete(ctx, cfg);  // four failures, then the candidate answers
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "", 4, kHCandTarget);
  for (int i = 0; i < 4; i++) hComplete(ctx, cfg);
  const bool open = ctx.Redis.Exists(breaker) == 1;
  ctx.Assert(hCandidateCalls(ctx) == 9 && !open, "four failures, a success, then four failures: the candidate received %d of 9 shadows and the breaker is %s. A success resets the count, so these are not five in a row",
             hCandidateCalls(ctx), open ? "open" : "closed");
  hComplete(ctx, cfg);  // a success clears the count again
  const std::string failures = "shadow:" + cfg + ":failures";
  ctx.Redis.Set(failures, "4");  // four failures in a row seen by other instances
  long long opened_ttl = -3;
  // The breaker's TTL right after the command that creates it.
  std::function<void()> watch_breaker = [&] {
    if (ctx.Redis.Exists(breaker) == 1) {
      if (opened_ttl == -3) opened_ttl = ctx.Redis.TTL(breaker);
    } else {
      ctx.Redis.After(breaker, watch_breaker);
    }
  };
  ctx.Redis.After(failures, watch_breaker);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::INTERNAL, "", 100, kHCandTarget);
  for (int i = 0; i < 4; i++) hComplete(ctx, cfg);
  const size_t n = hCandidateCalls(ctx);
  ctx.Assert(n == 11, "after four failures counted in %s by other instances and one here, the candidate received %d of the next 4 shadows, expected 1: the count lives in Redis and the fifth failure in a row opens the breaker for the whole fleet", failures, static_cast<long long>(n) - 10);
  ctx.Equal(opened_ttl, 30, "the breaker is set with its expiry in one command; the TTL of %s right after the command that opened it", breaker);
  auto stats = hShadowStats(ctx, cfg);
  ctx.Assert(stats["dropped"] == 12 && stats["completed"] == 2, "12 shadows were lost and 2 completed, the stats say dropped %d, completed %d", stats["dropped"], stats["completed"]);
  ctx.Clock.Advance(31);
  hComplete(ctx, cfg);
  ctx.Equal(hCandidateCalls(ctx), 12, "30 s after the breaker opened the candidate must get the next shadow again; the calls");
}
`,
  },
  hints: [
    'Make the candidate hang: every shadowed request now takes as long as the candidate does. Take the candidate down: shadowed requests start failing, and the candidate sees three calls for each.',
    'The candidate call has no deadline, sits in a retry loop that re-raises its last error, and nothing remembers that the last calls failed, so every shadowed request tries again at full price.',
    'One call with `timeout=SHADOW_DEADLINE_S` inside `try/except grpc.RpcError`; count `dropped` or `completed`; on failure INCR `shadow:{id}:failures` and at 5 SET `shadow:{id}:breaker` EX 30; skip the call while the breaker exists.',
  ],
  debrief: `The rule is that the shadow may cost production a bounded, known amount and nothing else. The deadline sets the bound per request, catching every candidate error keeps the answer production's alone, and one attempt keeps the candidate's load equal to the share. The breaker turns an outage into silence instead of a flood, and the dropped count is what tells the report how much of the share it actually saw. This version still runs the shadow inline after production answers, so a slow candidate adds up to 300 ms; production runners hand the shadow to a bounded queue served by its own workers, so the request path pays nothing and a full queue is one more dropped count.`,
};
