import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls on a GPU slot: a deadline, bounded retries, a recorded downgrade',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies', 'leases'],
  file: 'client',
  focus: ['api', 'large', 'small', 'redis'],
  task: `## Task

**Starting point.** The starter's \`predict(pool, tenant, inference_id, image_key, task)\` takes a slot
from the step-2 pool (\`pool.admit\`), then calls \`Predictor.Predict\` (\`predictor.proto\`) up to
\`MAX_TRIES\` = 5 times, alternating between the large and the small deployment and sleeping between
tries; the first answer is released and returned as \`{status: "complete", label, confidence,
attempts}\`, and when every try fails it returns the label \`"unknown"\`. Against healthy models it
answers on the first call. It hides five flaws.

**Failure mode the checks target.** The fabricated \`"unknown"\` is the costly one: it is stored and
published as a prediction, and the quality pipeline learns from a label no model produced. A call with
no deadline holds a GPU slot as long as the model hangs. And the slot leaks on every path that does
not succeed.

\`\`\`proto
service Predictor { rpc Predict(PredictRequest) returns (PredictReply); }
message PredictRequest { string inference_id = 1; string image_key = 2; string task = 3; }
message PredictReply   { string label = 1; double confidence = 2; string model_version = 3; }
\`\`\`

Requirements:

- A refused admission returns \`{status: "throttled", retry_after}\` with **no** model call.
- Every call carries a **2-second deadline** (\`DEADLINE_S\` / \`DEADLINE_MS\`).
- The large model gets at most \`MAX_ATTEMPTS\` = 3 calls; only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`
  are retried. Any other status is \`{status: "failed", reason}\` (\`invalid_argument\`, …) at once.
- Retries spent, **one** call to the small model: \`downgraded: true\` with \`downgrade_reason\`
  (\`unavailable\` or \`deadline\`). If it fails too, \`failed\`; no invented label.
- A complete result carries \`model_version\` from the reply, \`downgraded\` and \`attempts\`.
- The ticket is **released on every path**.`,
  sequence: {
    participants: ['Worker', 'GPU pool', 'Large model', 'Small model'],
    messages: [
      {from: 'Worker', to: 'GPU pool', label: 'admit(tenant)', kind: 'sync'},
      {from: 'GPU pool', to: 'Worker', label: '{ticket}', kind: 'reply'},
      {from: 'Worker', to: 'Large model', label: 'Predict · deadline 2 s · ×3', kind: 'sync'},
      {from: 'Large model', to: 'Worker', label: 'UNAVAILABLE ×3', kind: 'reply'},
      {from: 'Worker', to: 'Small model', label: 'Predict · deadline 2 s', kind: 'sync'},
      {from: 'Small model', to: 'Worker', label: '{label, confidence, model_version}', kind: 'reply'},
      {from: 'Worker', to: 'GPU pool', label: 'release(tenant, ticket) · every path', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: when the large model is down, results come back as `unknown` with confidence 0, a hung model holds a GPU slot until it answers, and after a bad hour the tenant is throttled with nothing running.',
    'Mechanism: the call has no deadline, every RpcError is retried, the loop alternates models without saying so, the fallback is a literal label, and `release` sits on the success path only; an admission refusal is never read.',
    'Change: return `throttled` when the ticket is missing; `timeout=DEADLINE_S` on each call; retry only UNAVAILABLE/DEADLINE_EXCEEDED up to `MAX_ATTEMPTS`; one `small.Predict` marked `downgraded`; `failed` otherwise; `pool.release` in a `finally`.',
  ],
  checks: [
    {
      id: 'attempt-deadline',
      title: 'Two-second deadline on every model call',
      detail:
        'Each Predict, every retry and the small-model call included, carries its own deadline of about 2 s; a large model that hangs is cut three times and the small model answers, downgraded with reason deadline, within about 7 s. The healthy path calls the large model once and reports its model_version. The starter sends no deadline.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED, at most three calls',
      detail:
        'INVALID_ARGUMENT from the large model is failed with reason invalid_argument after one call and no small-model call, and so are RESOURCE_EXHAUSTED (reason resource_exhausted) and PERMISSION_DENIED; one UNAVAILABLE earns one retry after a backoff. The starter retries every error on alternating models.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS/, /StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/],
          none: [/MAX_TRIES/],
        },
        typescript: {all: [/MAX_ATTEMPTS/, /status\.UNAVAILABLE/, /status\.DEADLINE_EXCEEDED/], none: [/MAX_TRIES/]},
        go: {all: [/maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/], none: [/maxTries/]},
        cpp: {all: [/kMaxAttempts/, /StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/], none: [/kMaxTries/]},
      },
    },
    {
      id: 'downgrade',
      title: 'Downgrades to the small model and says so',
      detail:
        'Three UNAVAILABLE from the large model lead to one small-model call whose answer is complete with model_version vision-small-1.7.2, downgraded true and downgrade_reason unavailable; with both down the result is failed and carries no label. The starter answers "unknown".',
      match: {
        python: {all: [/downgrade_reason/, /small\.Predict\(/], none: [/["']unknown["']/, /attempt\s*%\s*2/]},
        typescript: {all: [/downgrade_reason/, /small\.Predict\(/], none: [/['"]unknown['"]/, /attempt\s*%\s*2/]},
        go: {all: [/DowngradeReason/, /small\.Predict\(/], none: [/Label:\s*"unknown"/, /attempt\s*%\s*2/]},
        cpp: {
          all: [/downgrade_reason/, /small->Predict\(|call\(\s*\*small\b/],
          none: [/label\s*=\s*"unknown"/, /attempt\s*%\s*2/],
        },
      },
    },
    {
      id: 'throttled-no-call',
      title: 'A full pool means no model call',
      detail:
        "When the tenant's pool refuses, predict answers throttled with the pool's retry_after and the models see no call; another tenant is unaffected. The starter calls the model without a slot.",
      match: {
        python: {all: [/["']throttled["']/], order: [/["']throttled["']/, /\.Predict\(/]},
        typescript: {all: [/['"]throttled['"]/], order: [/['"]throttled['"]/, /\.Predict\(/]},
        go: {all: [/"throttled"/], order: [/"throttled"/, /\.Predict\(/]},
        cpp: {all: [/"throttled"/], order: [/"throttled"/, /->Predict\(|call\(\s*\*large\b/]},
      },
    },
    {
      id: 'release-every-path',
      title: 'Gives the GPU slot back on every path',
      detail:
        "After a complete, a failed and a downgraded inference the tenant's pool is empty again. The starter releases only after a successful call, so every failure leaks a slot until its lease runs out.",
      match: {
        python: {all: [/finally\s*:[\s\S]*pool\.release\(/]},
        typescript: {all: [/finally\s*\{[\s\S]*pool\.release\(/]},
        go: {all: [/defer\s+(func\s*\(\)\s*\{[\s\S]*?)?pool\.Release\(/]},
        cpp: {all: [/~\w+\(\)\s*\{[^}]*\.release\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import predictor_pb2
import predictor_pb2_grpc
from vision.config import LARGE_MODEL, SMALL_MODEL

logger = logging.getLogger("vision.models")

MAX_TRIES = 5
BACKOFF_S = 0.2

large = predictor_pb2_grpc.PredictorStub(grpc.insecure_channel(LARGE_MODEL))
small = predictor_pb2_grpc.PredictorStub(grpc.insecure_channel(SMALL_MODEL))


def predict(pool, tenant: str, inference_id: str, image_key: str, task: str) -> dict:
    """One inference on a GPU slot: the label, its confidence and the model that produced it."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    admission = pool.admit(tenant)
    request = predictor_pb2.PredictRequest(inference_id=inference_id, image_key=image_key, task=task)
    for attempt in range(1, MAX_TRIES + 1):
        stub = large if attempt % 2 == 1 else small
        try:
            reply = stub.Predict(request)
        except grpc.RpcError as err:
            logger.warning("predict failed inference=%s code=%s", inference_id, err.code())
            time.sleep(BACKOFF_S)
            continue
        pool.release(tenant, admission["ticket"])
        return {"status": "complete", "label": reply.label, "confidence": reply.confidence, "attempts": attempt}
    return {"status": "complete", "label": "unknown", "confidence": 0.0, "attempts": MAX_TRIES}
`,
      solution: `import logging
import time

import grpc

import predictor_pb2
import predictor_pb2_grpc
from vision.config import LARGE_MODEL, SMALL_MODEL

logger = logging.getLogger("vision.models")

DEADLINE_S = 2.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

large = predictor_pb2_grpc.PredictorStub(grpc.insecure_channel(LARGE_MODEL))
small = predictor_pb2_grpc.PredictorStub(grpc.insecure_channel(SMALL_MODEL))


def reason_of(code: grpc.StatusCode) -> str:
    return "deadline" if code == grpc.StatusCode.DEADLINE_EXCEEDED else code.name.lower()


def complete(reply, attempts: int, downgraded: bool) -> dict:
    return {
        "status": "complete",
        "label": reply.label,
        "confidence": reply.confidence,
        "model_version": reply.model_version,
        "downgraded": downgraded,
        "attempts": attempts,
    }


def predict(pool, tenant: str, inference_id: str, image_key: str, task: str) -> dict:
    """One inference on a GPU slot: the label, its confidence and the model that produced it."""
    admission = pool.admit(tenant)
    if admission["ticket"] is None:
        return {"status": "throttled", "retry_after": admission["retry_after"], "attempts": 0}
    request = predictor_pb2.PredictRequest(inference_id=inference_id, image_key=image_key, task=task)
    try:
        reason = ""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                return complete(large.Predict(request, timeout=DEADLINE_S), attempt, downgraded=False)
            except grpc.RpcError as err:
                if err.code() not in RETRYABLE:
                    return {"status": "failed", "reason": reason_of(err.code()), "attempts": attempt}
                reason = reason_of(err.code())
                logger.warning("large model attempt %d failed inference=%s: %s", attempt, inference_id, reason)
                if attempt < MAX_ATTEMPTS:
                    time.sleep(BACKOFF_S * attempt)
        try:
            reply = small.Predict(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            return {"status": "failed", "reason": reason_of(err.code()), "attempts": MAX_ATTEMPTS + 1}
        result = complete(reply, MAX_ATTEMPTS + 1, downgraded=True)
        result["downgrade_reason"] = reason
        return result
    finally:
        pool.release(tenant, admission["ticket"])
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {LARGE_MODEL, SMALL_MODEL} from 'vision/config';

export const MAX_TRIES = 5;
export const BACKOFF_MS = 200;

interface PredictRequest {
  inference_id: string;
  image_key: string;
  task: string;
}
interface PredictReply {
  label: string;
  confidence: number;
  model_version: string;
}
interface PredictorClient {
  Predict(request: PredictRequest, options?: {deadline: number}): Promise<PredictReply>;
}

const {vision} = grpc.loadPackageDefinition(protoLoader.loadSync('predictor.proto')) as unknown as {
  vision: {Predictor: new (target: string, credentials: grpc.ChannelCredentials) => PredictorClient};
};
const large = new vision.Predictor(LARGE_MODEL, grpc.credentials.createInsecure());
const small = new vision.Predictor(SMALL_MODEL, grpc.credentials.createInsecure());

/** The step-2 GPU pool the worker hands in: admit before a call, release after. */
export interface GpuPool {
  admit(tenant: string): Promise<{ticket: string | null; retryAfter: number}>;
  release(tenant: string, ticket: string): Promise<boolean>;
}

export interface Prediction {
  status: string;
  reason?: string;
  label?: string;
  confidence?: number;
  model_version?: string;
  downgraded?: boolean;
  downgrade_reason?: string;
  retry_after?: number;
  attempts: number;
}

/** One inference on a GPU slot: the label, its confidence and the model that produced it. */
export async function predict(pool: GpuPool, tenant: string, inferenceId: string, imageKey: string, task: string): Promise<Prediction> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const admission = await pool.admit(tenant);
  const request = {inference_id: inferenceId, image_key: imageKey, task};
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const stub = attempt % 2 === 1 ? large : small;
    let reply: PredictReply;
    try {
      reply = await stub.Predict(request);
    } catch (err) {
      console.warn(\`predict failed inference=\${inferenceId} code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
      continue;
    }
    await pool.release(tenant, admission.ticket as string);
    return {status: 'complete', label: reply.label, confidence: reply.confidence, attempts: attempt};
  }
  return {status: 'complete', label: 'unknown', confidence: 0, attempts: MAX_TRIES};
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {LARGE_MODEL, SMALL_MODEL} from 'vision/config';

export const DEADLINE_MS = 2_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 200;

interface PredictRequest {
  inference_id: string;
  image_key: string;
  task: string;
}
interface PredictReply {
  label: string;
  confidence: number;
  model_version: string;
}
interface PredictorClient {
  Predict(request: PredictRequest, options?: {deadline: number}): Promise<PredictReply>;
}

const {vision} = grpc.loadPackageDefinition(protoLoader.loadSync('predictor.proto')) as unknown as {
  vision: {Predictor: new (target: string, credentials: grpc.ChannelCredentials) => PredictorClient};
};
const large = new vision.Predictor(LARGE_MODEL, grpc.credentials.createInsecure());
const small = new vision.Predictor(SMALL_MODEL, grpc.credentials.createInsecure());

/** The step-2 GPU pool the worker hands in: admit before a call, release after. */
export interface GpuPool {
  admit(tenant: string): Promise<{ticket: string | null; retryAfter: number}>;
  release(tenant: string, ticket: string): Promise<boolean>;
}

export interface Prediction {
  status: string;
  reason?: string;
  label?: string;
  confidence?: number;
  model_version?: string;
  downgraded?: boolean;
  downgrade_reason?: string;
  retry_after?: number;
  attempts: number;
}

const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

function reasonOf(code: grpc.status): string {
  if (code === grpc.status.DEADLINE_EXCEEDED) return 'deadline';
  const name = Object.keys(grpc.status).find(k => grpc.status[k as keyof typeof grpc.status] === code);
  return (name ?? \`status_\${code}\`).toLowerCase();
}

const complete = (reply: PredictReply, attempts: number, downgraded: boolean): Prediction => ({
  status: 'complete',
  label: reply.label,
  confidence: reply.confidence,
  model_version: reply.model_version,
  downgraded,
  attempts,
});

/** One inference on a GPU slot: the label, its confidence and the model that produced it. */
export async function predict(pool: GpuPool, tenant: string, inferenceId: string, imageKey: string, task: string): Promise<Prediction> {
  const admission = await pool.admit(tenant);
  if (admission.ticket === null) return {status: 'throttled', retry_after: admission.retryAfter, attempts: 0};
  const ticket = admission.ticket;
  const request = {inference_id: inferenceId, image_key: imageKey, task};
  try {
    let reason = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return complete(await large.Predict(request, {deadline: Date.now() + DEADLINE_MS}), attempt, false);
      } catch (err) {
        const {code} = err as grpc.ServiceError;
        if (!RETRYABLE.includes(code)) return {status: 'failed', reason: reasonOf(code), attempts: attempt};
        reason = reasonOf(code);
        console.warn(\`large model attempt \${attempt} failed inference=\${inferenceId}: \${reason}\`);
        if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
      }
    }
    try {
      const reply = await small.Predict(request, {deadline: Date.now() + DEADLINE_MS});
      return {...complete(reply, MAX_ATTEMPTS + 1, true), downgrade_reason: reason};
    } catch (err) {
      return {status: 'failed', reason: reasonOf((err as grpc.ServiceError).code), attempts: MAX_ATTEMPTS + 1};
    }
  } finally {
    await pool.release(tenant, ticket);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"vision/config" // config.LargeModel, config.SmallModel — provided
	pb "vision/gen/predictor"
)

const (
	maxTries = 5
	backoff  = 200 * time.Millisecond
)

var largeConn, _ = grpc.NewClient(config.LargeModel, grpc.WithTransportCredentials(insecure.NewCredentials()))
var smallConn, _ = grpc.NewClient(config.SmallModel, grpc.WithTransportCredentials(insecure.NewCredentials()))
var large = pb.NewPredictorClient(largeConn)
var small = pb.NewPredictorClient(smallConn)

// Admission is what the step-2 pool answers: the ticket that holds a slot ("" when full) and the seconds to wait.
type Admission struct {
	Ticket     string
	RetryAfter int64
}

// Pool is the step-2 GPU pool the worker hands in: admit before a call, release after.
type Pool interface {
	Admit(ctx context.Context, tenant string) (Admission, error)
	Release(ctx context.Context, tenant, ticket string) (bool, error)
}

// Prediction is one inference's outcome.
type Prediction struct {
	Status          string
	Reason          string
	Label           string
	Confidence      float64
	ModelVersion    string
	Downgraded      bool
	DowngradeReason string
	RetryAfter      int64
	Attempts        int
}

// predict runs one inference on a GPU slot: the label, its confidence and the model that produced it.
func predict(ctx context.Context, pool Pool, tenant, inferenceID, imageKey, task string) (Prediction, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	admission, err := pool.Admit(ctx, tenant)
	if err != nil {
		return Prediction{}, err
	}
	request := &pb.PredictRequest{InferenceId: inferenceID, ImageKey: imageKey, Task: task}
	for attempt := 1; attempt <= maxTries; attempt++ {
		stub := large
		if attempt%2 == 0 {
			stub = small
		}
		reply, err := stub.Predict(ctx, request)
		if err != nil {
			log.Printf("predict failed inference=%s code=%s", inferenceID, status.Code(err))
			time.Sleep(backoff)
			continue
		}
		if _, err := pool.Release(ctx, tenant, admission.Ticket); err != nil {
			return Prediction{}, err
		}
		return Prediction{Status: "complete", Label: reply.GetLabel(), Confidence: reply.GetConfidence(), Attempts: attempt}, nil
	}
	return Prediction{Status: "complete", Label: "unknown", Attempts: maxTries}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"vision/config" // config.LargeModel, config.SmallModel — provided
	pb "vision/gen/predictor"
)

const (
	deadline    = 2 * time.Second
	maxAttempts = 3
	backoff     = 200 * time.Millisecond
)

var largeConn, _ = grpc.NewClient(config.LargeModel, grpc.WithTransportCredentials(insecure.NewCredentials()))
var smallConn, _ = grpc.NewClient(config.SmallModel, grpc.WithTransportCredentials(insecure.NewCredentials()))
var large = pb.NewPredictorClient(largeConn)
var small = pb.NewPredictorClient(smallConn)

// Admission is what the step-2 pool answers: the ticket that holds a slot ("" when full) and the seconds to wait.
type Admission struct {
	Ticket     string
	RetryAfter int64
}

// Pool is the step-2 GPU pool the worker hands in: admit before a call, release after.
type Pool interface {
	Admit(ctx context.Context, tenant string) (Admission, error)
	Release(ctx context.Context, tenant, ticket string) (bool, error)
}

// Prediction is one inference's outcome.
type Prediction struct {
	Status          string
	Reason          string
	Label           string
	Confidence      float64
	ModelVersion    string
	Downgraded      bool
	DowngradeReason string
	RetryAfter      int64
	Attempts        int
}

// statusNames names every gRPC status code in lower snake case, indexed by its number.
var statusNames = [...]string{"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"}

func reasonOf(code codes.Code) string {
	if code == codes.DeadlineExceeded {
		return "deadline"
	}
	if code == codes.InvalidArgument {
		return "invalid_argument"
	}
	if code == codes.ResourceExhausted {
		return "resource_exhausted"
	}
	if int(code) < len(statusNames) {
		return statusNames[code]
	}
	return "unknown"
}

func complete(reply *pb.PredictReply, attempts int, downgraded bool) Prediction {
	return Prediction{Status: "complete", Label: reply.GetLabel(), Confidence: reply.GetConfidence(), ModelVersion: reply.GetModelVersion(), Downgraded: downgraded, Attempts: attempts}
}

// predict runs one inference on a GPU slot: the label, its confidence and the model that produced it.
func predict(ctx context.Context, pool Pool, tenant, inferenceID, imageKey, task string) (Prediction, error) {
	admission, err := pool.Admit(ctx, tenant)
	if err != nil {
		return Prediction{}, err
	}
	if admission.Ticket == "" {
		return Prediction{Status: "throttled", RetryAfter: admission.RetryAfter}, nil
	}
	defer pool.Release(context.Background(), tenant, admission.Ticket)
	request := &pb.PredictRequest{InferenceId: inferenceID, ImageKey: imageKey, Task: task}
	reason := ""
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := large.Predict(callCtx, request)
		cancel()
		if err == nil {
			return complete(reply, attempt, false), nil
		}
		code := status.Code(err)
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			return Prediction{Status: "failed", Reason: reasonOf(code), Attempts: attempt}, nil
		}
		reason = reasonOf(code)
		log.Printf("large model attempt %d failed inference=%s: %s", attempt, inferenceID, reason)
		if attempt < maxAttempts {
			time.Sleep(backoff * time.Duration(attempt))
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	reply, err := small.Predict(callCtx, request)
	cancel()
	if err != nil {
		return Prediction{Status: "failed", Reason: reasonOf(status.Code(err)), Attempts: maxAttempts + 1}, nil
	}
	result := complete(reply, maxAttempts+1, true)
	result.DowngradeReason = reason
	return result, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#include "predictor.grpc.pb.h"
#include "vision/config.h"  // config::kLargeModel, config::kSmallModel — provided

constexpr int kMaxTries = 5;
constexpr std::chrono::milliseconds kBackoff{200};

auto large = vision::Predictor::NewStub(grpc::CreateChannel(config::kLargeModel, grpc::InsecureChannelCredentials()));
auto small = vision::Predictor::NewStub(grpc::CreateChannel(config::kSmallModel, grpc::InsecureChannelCredentials()));

// What the step-2 pool answers: the ticket that holds a slot ("" when full) and the seconds to wait.
struct Admission {
  std::string ticket;
  long long retry_after = 0;
};

// The step-2 GPU pool the worker hands in: admit before a call, release after.
struct Pool {
  virtual ~Pool() = default;
  virtual Admission admit(const std::string& tenant) = 0;
  virtual bool release(const std::string& tenant, const std::string& ticket) = 0;
};

// One inference's outcome.
struct Prediction {
  std::string status;
  std::string reason;
  std::string label;
  double confidence = 0;
  std::string model_version;
  bool downgraded = false;
  std::string downgrade_reason;
  long long retry_after = 0;
  int attempts = 0;
};

// One inference on a GPU slot: the label, its confidence and the model that produced it.
Prediction predict(Pool& pool, const std::string& tenant, const std::string& inference_id, const std::string& image_key, const std::string& task) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const Admission admission = pool.admit(tenant);
  vision::PredictRequest request;
  request.set_inference_id(inference_id);
  request.set_image_key(image_key);
  request.set_task(task);
  for (int attempt = 1; attempt <= kMaxTries; attempt++) {
    auto& stub = attempt % 2 == 1 ? large : small;
    grpc::ClientContext ctx;
    vision::PredictReply reply;
    const grpc::Status status = stub->Predict(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "predict failed inference=" << inference_id << " code=" << status.error_code() << "\\n";
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    pool.release(tenant, admission.ticket);
    Prediction result;
    result.status = "complete";
    result.label = reply.label();
    result.confidence = reply.confidence();
    result.attempts = attempt;
    return result;
  }
  Prediction result;
  result.status = "complete";
  result.label = "unknown";
  result.attempts = kMaxTries;
  return result;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#include "predictor.grpc.pb.h"
#include "vision/config.h"  // config::kLargeModel, config::kSmallModel — provided

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{200};

auto large = vision::Predictor::NewStub(grpc::CreateChannel(config::kLargeModel, grpc::InsecureChannelCredentials()));
auto small = vision::Predictor::NewStub(grpc::CreateChannel(config::kSmallModel, grpc::InsecureChannelCredentials()));

// What the step-2 pool answers: the ticket that holds a slot ("" when full) and the seconds to wait.
struct Admission {
  std::string ticket;
  long long retry_after = 0;
};

// The step-2 GPU pool the worker hands in: admit before a call, release after.
struct Pool {
  virtual ~Pool() = default;
  virtual Admission admit(const std::string& tenant) = 0;
  virtual bool release(const std::string& tenant, const std::string& ticket) = 0;
};

// One inference's outcome.
struct Prediction {
  std::string status;
  std::string reason;
  std::string label;
  double confidence = 0;
  std::string model_version;
  bool downgraded = false;
  std::string downgrade_reason;
  long long retry_after = 0;
  int attempts = 0;
};

// Gives the slot back when predict returns, whichever path it takes.
struct SlotGuard {
  Pool& pool;
  std::string tenant;
  std::string ticket;
  ~SlotGuard() { pool.release(tenant, ticket); }
};

std::string reason_of(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::UNAVAILABLE: return "unavailable";
    case grpc::StatusCode::DEADLINE_EXCEEDED: return "deadline";
    case grpc::StatusCode::INVALID_ARGUMENT: return "invalid_argument";
    case grpc::StatusCode::RESOURCE_EXHAUSTED: return "resource_exhausted";
    default: {
      static const char* const kNames[] = {"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"};
      const int n = static_cast<int>(code);
      return n >= 0 && n < 17 ? kNames[n] : "unknown";
    }
  }
}

grpc::Status call(vision::Predictor::Stub& stub, const vision::PredictRequest& request, vision::PredictReply& reply) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  return stub.Predict(&ctx, request, &reply);
}

Prediction failed(const std::string& reason, int attempts) {
  Prediction result;
  result.status = "failed";
  result.reason = reason;
  result.attempts = attempts;
  return result;
}

Prediction complete(const vision::PredictReply& reply, int attempts, bool downgraded) {
  Prediction result;
  result.status = "complete";
  result.label = reply.label();
  result.confidence = reply.confidence();
  result.model_version = reply.model_version();
  result.downgraded = downgraded;
  result.attempts = attempts;
  return result;
}

// One inference on a GPU slot: the label, its confidence and the model that produced it.
Prediction predict(Pool& pool, const std::string& tenant, const std::string& inference_id, const std::string& image_key, const std::string& task) {
  const Admission admission = pool.admit(tenant);
  if (admission.ticket.empty()) {
    Prediction throttled;
    throttled.status = "throttled";
    throttled.retry_after = admission.retry_after;
    return throttled;
  }
  const SlotGuard guard{pool, tenant, admission.ticket};
  vision::PredictRequest request;
  request.set_inference_id(inference_id);
  request.set_image_key(image_key);
  request.set_task(task);
  std::string reason;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    vision::PredictReply reply;
    const grpc::Status status = call(*large, request, reply);
    if (status.ok()) return complete(reply, attempt, false);
    const grpc::StatusCode code = status.error_code();
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) return failed(reason_of(code), attempt);
    reason = reason_of(code);
    std::cerr << "large model attempt " << attempt << " failed inference=" << inference_id << ": " << reason << "\\n";
    if (attempt < kMaxAttempts) std::this_thread::sleep_for(kBackoff * attempt);
  }
  vision::PredictReply reply;
  const grpc::Status status = call(*small, request, reply);
  if (!status.ok()) return failed(reason_of(status.error_code()), kMaxAttempts + 1);
  Prediction result = complete(reply, kMaxAttempts + 1, true);
  result.downgrade_reason = reason;
  return result;
}
`,
    },
  },
  harness: {
    python: `import grpc

import predictor_pb2
import predictor_pb2_grpc
from vision import config, models

CAT = "tenants/t1/images/cat.jpg"


class ModelServicer(predictor_pb2_grpc.PredictorServicer):
    """One model deployment: answers from vision.models with its own version."""

    def __init__(self, version):
        self.version = version

    def Predict(self, request, context):
        label, confidence = models.answer(request.task, self.version)
        return predictor_pb2.PredictReply(label=label, confidence=confidence, model_version=self.version)


def _world(ctx):
    ctx.grpc.serve(predictor_pb2_grpc.add_PredictorServicer_to_server, ModelServicer(models.LARGE_VERSION), config.LARGE_MODEL)
    ctx.grpc.serve(predictor_pb2_grpc.add_PredictorServicer_to_server, ModelServicer(models.SMALL_VERSION), config.SMALL_MODEL)
    pool = ctx.load("state")
    return ctx.load("client"), pool


def _large(ctx):
    return ctx.grpc.calls_to("Predict", config.LARGE_MODEL)


def _small(ctx):
    return ctx.grpc.calls_to("Predict", config.SMALL_MODEL)


def _held(ctx, tenant="t1"):
    return ctx.redis.zcard(f"vision:gpu:{tenant}")


def _expect(result, status, reason=None):
    assert isinstance(result, dict), f"predict must return a dict, got {type(result).__name__}"
    assert result.get("status") == status, f"expected status {status!r}, got {result}"
    if reason is not None:
        assert result.get("reason") == reason, f"expected reason {reason!r}, got {result}"


def check_attempt_deadline(ctx):
    m, pool = _world(ctx)
    r = m.predict(pool, "t1", "inf-1", CAT, "classify")
    _expect(r, "complete")
    assert len(_large(ctx)) == 1, f"a healthy large model is called once, saw {len(_large(ctx))} calls"
    assert _large(ctx)[0].timeout is not None, "the Predict call carries no deadline: a hung model holds the GPU slot until it answers"
    assert 1.5 <= _large(ctx)[0].timeout <= 2.5, f"the deadline must be DEADLINE_S = 2 s, got {_large(ctx)[0].timeout} s"
    assert r.get("label") == "tabby_cat" and r.get("model_version") == models.LARGE_VERSION and r.get("downgraded") is False, f"a large-model answer carries its label, model_version {models.LARGE_VERSION} and downgraded False: {r}"
    ctx.grpc.set_latency("Predict", 5.0, config.LARGE_MODEL)
    started = ctx.clock.offset
    r = m.predict(pool, "t1", "inf-2", CAT, "classify")
    waited = ctx.clock.offset - started
    _expect(r, "complete")
    assert len(_large(ctx)) == 4, f"a hung large model is cut at the deadline and retried up to 3 calls, saw {len(_large(ctx)) - 1}"
    assert r.get("model_version") == models.SMALL_VERSION and r.get("downgraded") is True and r.get("downgrade_reason") == "deadline", f"after three cut calls the small model answers, downgraded with reason deadline: {r}"
    assert waited <= 8.0, f"predict waited {waited:.1f} s on a model that hangs: three 2 s deadlines and a small call fit in about 7 s"
    for call in _large(ctx)[1:] + _small(ctx):
        assert call.timeout is not None and 1.5 <= call.timeout <= 2.5, f"every call carries its own 2 s deadline, the retries and the small-model call included: a call went out with {call.timeout} s"


def check_retry_policy(ctx):
    m, pool = _world(ctx)
    ctx.grpc.fail("Predict", grpc.StatusCode.INVALID_ARGUMENT, "image is not decodable", times=1, target=config.LARGE_MODEL)
    r = m.predict(pool, "t1", "inf-1", CAT, "classify")
    _expect(r, "failed", "invalid_argument")
    assert "label" not in r, f"a failed inference carries no label: {r}"
    assert len(_large(ctx)) == 1 and len(_small(ctx)) == 0, f"INVALID_ARGUMENT is an answer, not an outage: one call and no downgrade, saw {len(_large(ctx))} large and {len(_small(ctx))} small calls"
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "replica restarting", times=1, target=config.LARGE_MODEL)
    r = m.predict(pool, "t1", "inf-2", CAT, "classify")
    _expect(r, "complete")
    assert r.get("attempts") == 2 and len(_large(ctx)) == 3, f"one UNAVAILABLE earns one retry on the large model: {r}, {len(_large(ctx)) - 1} large calls"
    assert r.get("model_version") == models.LARGE_VERSION and len(_small(ctx)) == 0, f"the retry answered, so no downgrade: {r}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    for i, (code, reason) in enumerate(((grpc.StatusCode.RESOURCE_EXHAUSTED, "resource_exhausted"), (grpc.StatusCode.PERMISSION_DENIED, "permission_denied"))):
        before = len(_large(ctx))
        ctx.grpc.fail("Predict", code, "refused", times=1, target=config.LARGE_MODEL)
        r = m.predict(pool, "t1", f"inf-{3 + i}", CAT, "classify")
        _expect(r, "failed", reason)
        assert len(_large(ctx)) == before + 1 and len(_small(ctx)) == 0, f"{code.name} is not UNAVAILABLE or DEADLINE_EXCEEDED: one call and no downgrade, saw {len(_large(ctx)) - before} large and {len(_small(ctx))} small calls"


def check_downgrade(ctx):
    m, pool = _world(ctx)
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "large pool drained", times=3, target=config.LARGE_MODEL)
    r = m.predict(pool, "t1", "inf-1", CAT, "classify")
    _expect(r, "complete")
    assert len(_large(ctx)) == 3 and len(_small(ctx)) == 1, f"three large calls, then one small call: saw {len(_large(ctx))} and {len(_small(ctx))}"
    assert r.get("label") == "tabby_cat" and r.get("confidence") == 0.81 and r.get("model_version") == models.SMALL_VERSION, f"the small model's answer, with its version: {r}"
    assert r.get("downgraded") is True and r.get("downgrade_reason") == "unavailable", f"a downgrade is recorded (downgraded True, downgrade_reason unavailable): {r}"
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "large pool drained", times=3, target=config.LARGE_MODEL)
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "small pool drained", times=1, target=config.SMALL_MODEL)
    r = m.predict(pool, "t1", "inf-2", CAT, "classify")
    assert r.get("label") != "unknown", f"both models are down and predict invented a label: {r}"
    _expect(r, "failed", "unavailable")
    assert "label" not in r, f"a failed inference carries no label: {r}"


def check_throttled_no_call(ctx):
    m, pool = _world(ctx)
    for _ in range(10):
        assert pool.admit("t1")["ticket"]
    try:
        r = m.predict(pool, "t1", "inf-1", CAT, "classify")
    except Exception as e:  # noqa: BLE001
        r = e
    assert ctx.grpc.calls_to("Predict") == [], f"t1's pool is full and predict still called the model ({len(ctx.grpc.calls_to('Predict'))} calls)"
    _expect(r, "throttled")
    assert isinstance(r.get("retry_after"), int) and 299 <= r["retry_after"] <= 300, f"a throttled result carries the pool's retry_after (the earliest lease ends in 300 s): {r}"
    _expect(m.predict(pool, "t2", "inf-2", CAT, "classify"), "complete")


def check_release_every_path(ctx):
    m, pool = _world(ctx)
    _expect(m.predict(pool, "t1", "inf-1", CAT, "classify"), "complete")
    assert _held(ctx) == 0, f"after a complete inference t1 still holds {_held(ctx)} GPU slots"
    ctx.grpc.fail("Predict", grpc.StatusCode.INVALID_ARGUMENT, "image is not decodable", times=1, target=config.LARGE_MODEL)
    m.predict(pool, "t1", "inf-2", CAT, "classify")
    assert _held(ctx) == 0, f"after a rejected inference t1 still holds {_held(ctx)} GPU slots"
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "large pool drained", times=5, target=config.LARGE_MODEL)
    ctx.grpc.fail("Predict", grpc.StatusCode.UNAVAILABLE, "small pool drained", times=5, target=config.SMALL_MODEL)
    m.predict(pool, "t1", "inf-3", CAT, "classify")
    assert _held(ctx) == 0, f"after an inference both models failed, t1 still holds {_held(ctx)} GPU slots: release on every path"
`,
    typescript: `const CAT = 'tenants/t1/images/cat.jpg';

/** Both model deployments, the step-2 pool, the learner's module. */
async function world(ctx) {
  const {vision} = ctx.proto('predictor.proto');
  const config = ctx.load('/support/vision/config.ts');
  const models = ctx.load('/support/vision/models.ts');
  for (const [target, version] of [[config.LARGE_MODEL, models.LARGE_VERSION], [config.SMALL_MODEL, models.SMALL_VERSION]]) {
    ctx.grpc.serve(vision.Predictor.service, {
      Predict(call, callback) {
        const {label, confidence} = models.answer(call.request.task, version);
        callback(null, {label, confidence, model_version: version});
      },
    }, target);
  }
  const pool = ctx.load('state');
  return {m: ctx.load('client'), pool, config, models};
}

const held = (ctx, tenant = 't1') => Number(ctx.redis.zcard(\`vision:gpu:\${tenant}\`));

function expect(result, status: string, reason?: string) {
  assert(result !== null && typeof result === 'object', \`predict must resolve to an object, got \${JSON.stringify(result)}\`);
  assert.equal(result.status, status, \`expected status \${status}, got \${JSON.stringify(result)}\`);
  if (reason !== undefined) assert.equal(result.reason, reason, \`expected reason \${reason}, got \${JSON.stringify(result)}\`);
}

export async function check_attempt_deadline(ctx) {
  const {m, pool, config, models} = await world(ctx);
  const large = () => ctx.grpc.callsTo('Predict', config.LARGE_MODEL);
  let r = await m.predict(pool, 't1', 'inf-1', CAT, 'classify');
  expect(r, 'complete');
  assert.equal(large().length, 1, \`a healthy large model is called once, saw \${large().length} calls\`);
  assert(large()[0].timeout !== null, 'the Predict call carries no deadline: a hung model holds the GPU slot until it answers');
  assert(1.5 <= large()[0].timeout && large()[0].timeout <= 2.5, \`the deadline must be DEADLINE_MS = 2000 ms, got \${large()[0].timeout} s\`);
  assert(r.label === 'tabby_cat' && r.model_version === models.LARGE_VERSION && r.downgraded === false, \`a large-model answer carries its label, model_version \${models.LARGE_VERSION} and downgraded false: \${JSON.stringify(r)}\`);
  ctx.grpc.setLatency('Predict', 5.0, config.LARGE_MODEL);
  const started = ctx.clock.now();
  r = await m.predict(pool, 't1', 'inf-2', CAT, 'classify');
  const waited = (ctx.clock.now() - started) / 1000;
  expect(r, 'complete');
  assert.equal(large().length, 4, \`a hung large model is cut at the deadline and retried up to 3 calls, saw \${large().length - 1}\`);
  assert(r.model_version === models.SMALL_VERSION && r.downgraded === true && r.downgrade_reason === 'deadline', \`after three cut calls the small model answers, downgraded with reason deadline: \${JSON.stringify(r)}\`);
  assert(waited <= 8.0, \`predict waited \${waited.toFixed(1)} s on a model that hangs: three 2 s deadlines and a small call fit in about 7 s\`);
  for (const call of [...large().slice(1), ...ctx.grpc.callsTo('Predict', config.SMALL_MODEL)]) {
    assert(call.timeout !== null && call.timeout >= 1.5 && call.timeout <= 2.5, \`every call carries its own 2 s deadline, the retries and the small-model call included: a call went out with \${call.timeout} s\`);
  }
}

export async function check_retry_policy(ctx) {
  const {m, pool, config, models} = await world(ctx);
  const large = () => ctx.grpc.callsTo('Predict', config.LARGE_MODEL);
  const small = () => ctx.grpc.callsTo('Predict', config.SMALL_MODEL);
  ctx.grpc.fail('Predict', ctx.grpc.status.INVALID_ARGUMENT, 'image is not decodable', 1, config.LARGE_MODEL);
  let r = await m.predict(pool, 't1', 'inf-1', CAT, 'classify');
  expect(r, 'failed', 'invalid_argument');
  assert(!('label' in r), \`a failed inference carries no label: \${JSON.stringify(r)}\`);
  assert(large().length === 1 && small().length === 0, \`INVALID_ARGUMENT is an answer, not an outage: one call and no downgrade, saw \${large().length} large and \${small().length} small calls\`);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'replica restarting', 1, config.LARGE_MODEL);
  r = await m.predict(pool, 't1', 'inf-2', CAT, 'classify');
  expect(r, 'complete');
  assert(r.attempts === 2 && large().length === 3, \`one UNAVAILABLE earns one retry on the large model: \${JSON.stringify(r)}, \${large().length - 1} large calls\`);
  assert(r.model_version === models.LARGE_VERSION && small().length === 0, \`the retry answered, so no downgrade: \${JSON.stringify(r)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  for (const [i, [code, name, reason]] of ([[ctx.grpc.status.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED', 'resource_exhausted'], [ctx.grpc.status.PERMISSION_DENIED, 'PERMISSION_DENIED', 'permission_denied']] as const).entries()) {
    const before = large().length;
    ctx.grpc.fail('Predict', code, 'refused', 1, config.LARGE_MODEL);
    r = await m.predict(pool, 't1', \`inf-\${3 + i}\`, CAT, 'classify');
    expect(r, 'failed', reason);
    assert(large().length === before + 1 && small().length === 0, \`\${name} is not UNAVAILABLE or DEADLINE_EXCEEDED: one call and no downgrade, saw \${large().length - before} large and \${small().length} small calls\`);
  }
}

export async function check_downgrade(ctx) {
  const {m, pool, config, models} = await world(ctx);
  const large = () => ctx.grpc.callsTo('Predict', config.LARGE_MODEL);
  const small = () => ctx.grpc.callsTo('Predict', config.SMALL_MODEL);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'large pool drained', 3, config.LARGE_MODEL);
  let r = await m.predict(pool, 't1', 'inf-1', CAT, 'classify');
  expect(r, 'complete');
  assert(large().length === 3 && small().length === 1, \`three large calls, then one small call: saw \${large().length} and \${small().length}\`);
  assert(r.label === 'tabby_cat' && r.confidence === 0.81 && r.model_version === models.SMALL_VERSION, \`the small model's answer, with its version: \${JSON.stringify(r)}\`);
  assert(r.downgraded === true && r.downgrade_reason === 'unavailable', \`a downgrade is recorded (downgraded true, downgrade_reason unavailable): \${JSON.stringify(r)}\`);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'large pool drained', 3, config.LARGE_MODEL);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'small pool drained', 1, config.SMALL_MODEL);
  r = await m.predict(pool, 't1', 'inf-2', CAT, 'classify');
  assert.notEqual(r.label, 'unknown', \`both models are down and predict invented a label: \${JSON.stringify(r)}\`);
  expect(r, 'failed', 'unavailable');
  assert(!('label' in r), \`a failed inference carries no label: \${JSON.stringify(r)}\`);
}

export async function check_throttled_no_call(ctx) {
  const {m, pool} = await world(ctx);
  for (let i = 0; i < 10; i++) assert((await pool.admit('t1')).ticket);
  const r = await m.predict(pool, 't1', 'inf-1', CAT, 'classify');
  assert.equal(ctx.grpc.callsTo('Predict').length, 0, \`t1's pool is full and predict still called the model (\${ctx.grpc.callsTo('Predict').length} calls)\`);
  expect(r, 'throttled');
  assert(Number.isInteger(r.retry_after) && r.retry_after >= 299 && r.retry_after <= 300, \`a throttled result carries the pool's retry_after (the earliest lease ends in 300 s): \${JSON.stringify(r)}\`);
  expect(await m.predict(pool, 't2', 'inf-2', CAT, 'classify'), 'complete');
}

export async function check_release_every_path(ctx) {
  const {m, pool, config} = await world(ctx);
  expect(await m.predict(pool, 't1', 'inf-1', CAT, 'classify'), 'complete');
  assert.equal(held(ctx), 0, \`after a complete inference t1 still holds \${held(ctx)} GPU slots\`);
  ctx.grpc.fail('Predict', ctx.grpc.status.INVALID_ARGUMENT, 'image is not decodable', 1, config.LARGE_MODEL);
  await m.predict(pool, 't1', 'inf-2', CAT, 'classify');
  assert.equal(held(ctx), 0, \`after a rejected inference t1 still holds \${held(ctx)} GPU slots\`);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'large pool drained', 5, config.LARGE_MODEL);
  ctx.grpc.fail('Predict', ctx.grpc.status.UNAVAILABLE, 'small pool drained', 5, config.SMALL_MODEL);
  await m.predict(pool, 't1', 'inf-3', CAT, 'classify');
  assert.equal(held(ctx), 0, \`after an inference both models failed, t1 still holds \${held(ctx)} GPU slots: release on every path\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	"vision/config"
	pb "vision/gen/predictor"
	"vision/models"

	"leetbuild/harness"
)

const kHClientCat = "tenants/t1/images/cat.jpg"

// modelPeer is one model deployment: answers from vision/models with its own version.
type HModelPeer struct {
	pb.UnimplementedPredictorServer
	version string
}

func (p *HModelPeer) Predict(_ context.Context, req *pb.PredictRequest) (*pb.PredictReply, error) {
	label, confidence := models.Answer(req.GetTask(), p.version)
	return &pb.PredictReply{Label: label, Confidence: confidence, ModelVersion: p.version}, nil
}

// clientPool stands in for the step-2 GPU pool over the harness's Redis.
type HClientPool struct {
	ctx  *harness.Ctx
	next int
}

func (p *HClientPool) Admit(_ context.Context, tenant string) (Admission, error) {
	now := p.ctx.Clock.Now() / 1000
	key := config.GPUKey(tenant)
	p.ctx.Redis.Do("ZREMRANGEBYSCORE", key, "-inf", now)
	if p.ctx.Redis.ZCard(key) >= config.GPUTokens {
		return Admission{RetryAfter: 60}, nil
	}
	p.next++
	ticket := "ticket-" + strconv.Itoa(p.next)
	p.ctx.Redis.Do("ZADD", key, now+config.LeaseSeconds, ticket)
	return Admission{Ticket: ticket}, nil
}

func (p *HClientPool) Release(_ context.Context, tenant, ticket string) (bool, error) {
	removed, _ := p.ctx.Redis.Do("ZREM", config.GPUKey(tenant), ticket).(int64)
	return removed == 1, nil
}

func hClientWorld(ctx *harness.Ctx) *HClientPool {
	pb.RegisterPredictorServer(ctx.GRPC.Server(config.LargeModel), &HModelPeer{version: models.LargeVersion})
	pb.RegisterPredictorServer(ctx.GRPC.Server(config.SmallModel), &HModelPeer{version: models.SmallVersion})
	return &HClientPool{ctx: ctx}
}

func hClientPredict(ctx *harness.Ctx, pool *HClientPool, tenant, inferenceID string) Prediction {
	r, err := predict(context.Background(), pool, tenant, inferenceID, kHClientCat, "classify")
	ctx.NoError(err, "predict(%s)", inferenceID)
	return r
}

func hClientLarge(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Predict", config.LargeModel) }
func hClientSmall(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Predict", config.SmallModel) }

func hClientExpect(ctx *harness.Ctx, r Prediction, status, reason string) {
	ctx.Equal(r.Status, status, "the prediction's status (%+v)", r)
	if reason != "" {
		ctx.Equal(r.Reason, reason, "the prediction's reason (%+v)", r)
	}
}

func CheckAttemptDeadline(ctx *harness.Ctx) {
	pool := hClientWorld(ctx)
	r := hClientPredict(ctx, pool, "t1", "inf-1")
	hClientExpect(ctx, r, "complete", "")
	ctx.Equal(len(hClientLarge(ctx)), 1, "a healthy large model is called once; calls")
	ctx.Assert(hClientLarge(ctx)[0].HasDeadline(), "the Predict call carries no deadline: a hung model holds the GPU slot until it answers")
	timeout := hClientLarge(ctx)[0].Timeout
	ctx.Assert(1500*time.Millisecond <= timeout && timeout <= 2500*time.Millisecond, "the deadline must be 2 s, got %v", timeout)
	ctx.Assert(r.Label == "tabby_cat" && r.ModelVersion == models.LargeVersion && !r.Downgraded, "a large-model answer carries its label, ModelVersion %s and Downgraded false: %+v", models.LargeVersion, r)
	ctx.GRPC.SetLatency("Predict", 5.0, config.LargeModel)
	started := ctx.Clock.Now()
	r = hClientPredict(ctx, pool, "t1", "inf-2")
	waited := float64(ctx.Clock.Now()-started) / 1000
	hClientExpect(ctx, r, "complete", "")
	ctx.Equal(len(hClientLarge(ctx)), 4, "a hung large model is cut at the deadline and retried up to 3 calls; large calls so far")
	ctx.Assert(r.ModelVersion == models.SmallVersion && r.Downgraded && r.DowngradeReason == "deadline", "after three cut calls the small model answers, downgraded with reason deadline: %+v", r)
	ctx.Assert(waited <= 8.0, "predict waited %.1f s on a model that hangs: three 2 s deadlines and a small call fit in about 7 s", waited)
	for _, call := range append(hClientLarge(ctx)[1:], hClientSmall(ctx)...) {
		ctx.Assert(call.HasDeadline() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "every call carries its own 2 s deadline, the retries and the small-model call included: a call went out with %v (deadline set: %t)", call.Timeout, call.HasDeadline())
	}
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	pool := hClientWorld(ctx)
	ctx.GRPC.Fail("Predict", codes.InvalidArgument, "image is not decodable", 1, config.LargeModel)
	r := hClientPredict(ctx, pool, "t1", "inf-1")
	hClientExpect(ctx, r, "failed", "invalid_argument")
	ctx.Equal(r.Label, "", "a failed inference carries no label")
	ctx.Assert(len(hClientLarge(ctx)) == 1 && len(hClientSmall(ctx)) == 0, "INVALID_ARGUMENT is an answer, not an outage: one call and no downgrade, saw %d large and %d small calls", len(hClientLarge(ctx)), len(hClientSmall(ctx)))
	ctx.GRPC.Fail("Predict", codes.Unavailable, "replica restarting", 1, config.LargeModel)
	r = hClientPredict(ctx, pool, "t1", "inf-2")
	hClientExpect(ctx, r, "complete", "")
	ctx.Assert(r.Attempts == 2 && len(hClientLarge(ctx)) == 3, "one UNAVAILABLE earns one retry on the large model: %+v, %d large calls", r, len(hClientLarge(ctx))-1)
	ctx.Assert(r.ModelVersion == models.LargeVersion && len(hClientSmall(ctx)) == 0, "the retry answered, so no downgrade: %+v", r)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	for i, tc := range []struct {
		code   codes.Code
		name   string
		reason string
	}{{codes.ResourceExhausted, "RESOURCE_EXHAUSTED", "resource_exhausted"}, {codes.PermissionDenied, "PERMISSION_DENIED", "permission_denied"}} {
		before := len(hClientLarge(ctx))
		ctx.GRPC.Fail("Predict", tc.code, "refused", 1, config.LargeModel)
		r = hClientPredict(ctx, pool, "t1", "inf-"+string(rune('3'+i)))
		hClientExpect(ctx, r, "failed", tc.reason)
		ctx.Assert(len(hClientLarge(ctx)) == before+1 && len(hClientSmall(ctx)) == 0, "%s is not UNAVAILABLE or DEADLINE_EXCEEDED: one call and no downgrade, saw %d large and %d small calls", tc.name, len(hClientLarge(ctx))-before, len(hClientSmall(ctx)))
	}
}

func CheckDowngrade(ctx *harness.Ctx) {
	pool := hClientWorld(ctx)
	ctx.GRPC.Fail("Predict", codes.Unavailable, "large pool drained", 3, config.LargeModel)
	r := hClientPredict(ctx, pool, "t1", "inf-1")
	hClientExpect(ctx, r, "complete", "")
	ctx.Assert(len(hClientLarge(ctx)) == 3 && len(hClientSmall(ctx)) == 1, "three large calls, then one small call: saw %d and %d", len(hClientLarge(ctx)), len(hClientSmall(ctx)))
	ctx.Assert(r.Label == "tabby_cat" && r.Confidence == 0.81 && r.ModelVersion == models.SmallVersion, "the small model's answer, with its version: %+v", r)
	ctx.Assert(r.Downgraded && r.DowngradeReason == "unavailable", "a downgrade is recorded (Downgraded true, DowngradeReason unavailable): %+v", r)
	ctx.GRPC.Fail("Predict", codes.Unavailable, "large pool drained", 3, config.LargeModel)
	ctx.GRPC.Fail("Predict", codes.Unavailable, "small pool drained", 1, config.SmallModel)
	r = hClientPredict(ctx, pool, "t1", "inf-2")
	ctx.Assert(r.Label != "unknown", "both models are down and predict invented a label: %+v", r)
	hClientExpect(ctx, r, "failed", "unavailable")
	ctx.Equal(r.Label, "", "a failed inference carries no label")
}

func CheckThrottledNoCall(ctx *harness.Ctx) {
	pool := hClientWorld(ctx)
	for i := 0; i < 10; i++ {
		a, _ := pool.Admit(context.Background(), "t1")
		ctx.Assert(a.Ticket != "", "admission %d into an empty pool", i+1)
	}
	r := hClientPredict(ctx, pool, "t1", "inf-1")
	ctx.Equal(len(ctx.GRPC.CallsTo("Predict", "")), 0, "t1's pool is full and predict still called the model; calls")
	hClientExpect(ctx, r, "throttled", "")
	ctx.Assert(r.RetryAfter == 60, "a throttled result carries the pool's RetryAfter (this pool answered 60): %+v", r)
	hClientExpect(ctx, hClientPredict(ctx, pool, "t2", "inf-2"), "complete", "")
}

func CheckReleaseEveryPath(ctx *harness.Ctx) {
	pool := hClientWorld(ctx)
	hClientExpect(ctx, hClientPredict(ctx, pool, "t1", "inf-1"), "complete", "")
	ctx.Equal(ctx.Redis.ZCard(config.GPUKey("t1")), 0, "after a complete inference; GPU slots t1 still holds")
	ctx.GRPC.Fail("Predict", codes.InvalidArgument, "image is not decodable", 1, config.LargeModel)
	hClientPredict(ctx, pool, "t1", "inf-2")
	ctx.Equal(ctx.Redis.ZCard(config.GPUKey("t1")), 0, "after a rejected inference; GPU slots t1 still holds")
	ctx.GRPC.Fail("Predict", codes.Unavailable, "large pool drained", 5, config.LargeModel)
	ctx.GRPC.Fail("Predict", codes.Unavailable, "small pool drained", 5, config.SmallModel)
	hClientPredict(ctx, pool, "t1", "inf-3")
	ctx.Equal(ctx.Redis.ZCard(config.GPUKey("t1")), 0, "after an inference both models failed (release on every path); GPU slots t1 still holds")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "vision/models.h"

namespace {

const std::string kHCat = "tenants/t1/images/cat.jpg";

// One model deployment: answers from vision/models.h with its own version.
class HModelPeer final : public vision::Predictor::Service {
 public:
  explicit HModelPeer(std::string version) : version_(std::move(version)) {}
  grpc::Status Predict(grpc::ServerContext*, const vision::PredictRequest* req, vision::PredictReply* reply) override {
    const auto answer = models::answer(req->task(), version_);
    reply->set_label(answer.label);
    reply->set_confidence(answer.confidence);
    reply->set_model_version(version_);
    return grpc::Status::OK;
  }

 private:
  std::string version_;
};

// Stands in for the step-2 GPU pool over the harness's Redis.
class HClientPool final : public Pool {
 public:
  explicit HClientPool(harness::Ctx& ctx) : ctx_(ctx) {}

  Admission admit(const std::string& tenant) override {
    const long long now = ctx_.Clock.Now() / 1000;
    const std::string key = config::gpu_key(tenant);
    ctx_.Redis.Do("ZREMRANGEBYSCORE", key, "-inf", now);
    if (ctx_.Redis.ZCard(key) >= config::kGpuTokens) return {"", 60};
    const std::string ticket = "ticket-" + std::to_string(++next_);
    ctx_.Redis.Do("ZADD", key, now + config::kLeaseSeconds, ticket);
    return {ticket, 0};
  }

  bool release(const std::string& tenant, const std::string& ticket) override {
    return ctx_.Redis.Do("ZREM", config::gpu_key(tenant), ticket).Int() == 1;
  }

 private:
  harness::Ctx& ctx_;
  int next_ = 0;
};

struct HWorld {
  HModelPeer large{models::kLargeVersion};
  HModelPeer small{models::kSmallVersion};
  HClientPool pool;
  explicit HWorld(harness::Ctx& ctx) : pool(ctx) {}
};

HWorld& hClientWorld(harness::Ctx& ctx) {
  static HWorld* world = nullptr;
  delete world;
  world = new HWorld(ctx);
  ctx.GRPC.Server(config::kLargeModel)->RegisterService(&world->large);
  ctx.GRPC.Server(config::kSmallModel)->RegisterService(&world->small);
  return *world;
}

size_t hLargeCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Predict", config::kLargeModel).size(); }
size_t hSmallCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Predict", config::kSmallModel).size(); }

void hClientExpect(harness::Ctx& ctx, const Prediction& r, const std::string& status, const std::string& reason = "") {
  ctx.Equal(r.status, status, "the prediction's status (reason %q, label %q, attempts %d)", r.reason, r.label, r.attempts);
  if (!reason.empty()) ctx.Equal(r.reason, reason, "the prediction's reason");
}

}  // namespace

void CheckAttemptDeadline(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx);
  Prediction r = predict(w.pool, "t1", "inf-1", kHCat, "classify");
  hClientExpect(ctx, r, "complete");
  ctx.Equal(hLargeCalls(ctx), 1, "a healthy large model is called once; calls");
  const auto first = ctx.GRPC.CallsTo("Predict", config::kLargeModel)[0];
  ctx.Assert(first.HasDeadline(), "the Predict call carries no deadline: a hung model holds the GPU slot until it answers");
  ctx.Assert(1.5 <= first.TimeoutSeconds() && first.TimeoutSeconds() <= 2.5, "the deadline must be 2 s, got %vs", first.TimeoutSeconds());
  ctx.Assert(r.label == "tabby_cat" && r.model_version == models::kLargeVersion && !r.downgraded, "a large-model answer carries its label, model_version %s and downgraded false (got %q, %q)", models::kLargeVersion, r.label, r.model_version);
  ctx.GRPC.SetLatency("Predict", 5.0, config::kLargeModel);
  const int64_t started = ctx.Clock.Now();
  r = predict(w.pool, "t1", "inf-2", kHCat, "classify");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  hClientExpect(ctx, r, "complete");
  ctx.Equal(hLargeCalls(ctx), 4, "a hung large model is cut at the deadline and retried up to 3 calls; large calls so far");
  ctx.Assert(r.model_version == models::kSmallVersion && r.downgraded && r.downgrade_reason == "deadline", "after three cut calls the small model answers, downgraded with reason deadline (got %q, %q)", r.model_version, r.downgrade_reason);
  ctx.Assert(waited <= 8.0, "predict waited %.1f s on a model that hangs: three 2 s deadlines and a small call fit in about 7 s", waited);
  auto later = ctx.GRPC.CallsTo("Predict", config::kLargeModel);
  later.erase(later.begin());
  for (const auto& call : ctx.GRPC.CallsTo("Predict", config::kSmallModel)) later.push_back(call);
  for (const auto& call : later) {
    ctx.Assert(call.HasDeadline() && 1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "every call carries its own 2 s deadline, the retries and the small-model call included: a call went out with %vs (deadline set: %t)", call.TimeoutSeconds(), call.HasDeadline());
  }
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx);
  ctx.GRPC.Fail("Predict", grpc::StatusCode::INVALID_ARGUMENT, "image is not decodable", 1, config::kLargeModel);
  Prediction r = predict(w.pool, "t1", "inf-1", kHCat, "classify");
  hClientExpect(ctx, r, "failed", "invalid_argument");
  ctx.Equal(r.label, "", "a failed inference carries no label");
  ctx.Assert(hLargeCalls(ctx) == 1 && hSmallCalls(ctx) == 0, "INVALID_ARGUMENT is an answer, not an outage: one call and no downgrade, saw %d large and %d small calls", hLargeCalls(ctx), hSmallCalls(ctx));
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "replica restarting", 1, config::kLargeModel);
  r = predict(w.pool, "t1", "inf-2", kHCat, "classify");
  hClientExpect(ctx, r, "complete");
  ctx.Assert(r.attempts == 2 && hLargeCalls(ctx) == 3, "one UNAVAILABLE earns one retry on the large model: attempts %d, %d large calls", r.attempts, hLargeCalls(ctx) - 1);
  ctx.Assert(r.model_version == models::kLargeVersion && hSmallCalls(ctx) == 0, "the retry answered, so no downgrade (model_version %q)", r.model_version);
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  struct Terminal {
    grpc::StatusCode code;
    std::string name;
    std::string reason;
  };
  int n = 3;
  for (const Terminal& t : {Terminal{grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED", "resource_exhausted"}, Terminal{grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED", "permission_denied"}}) {
    const size_t before = hLargeCalls(ctx);
    ctx.GRPC.Fail("Predict", t.code, "refused", 1, config::kLargeModel);
    r = predict(w.pool, "t1", "inf-" + std::to_string(n++), kHCat, "classify");
    hClientExpect(ctx, r, "failed", t.reason);
    ctx.Assert(hLargeCalls(ctx) == before + 1 && hSmallCalls(ctx) == 0, "%s is not UNAVAILABLE or DEADLINE_EXCEEDED: one call and no downgrade, saw %d large and %d small calls", t.name, hLargeCalls(ctx) - before, hSmallCalls(ctx));
  }
}

void CheckDowngrade(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx);
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "large pool drained", 3, config::kLargeModel);
  Prediction r = predict(w.pool, "t1", "inf-1", kHCat, "classify");
  hClientExpect(ctx, r, "complete");
  ctx.Assert(hLargeCalls(ctx) == 3 && hSmallCalls(ctx) == 1, "three large calls, then one small call: saw %d and %d", hLargeCalls(ctx), hSmallCalls(ctx));
  ctx.Assert(r.label == "tabby_cat" && r.confidence == 0.81 && r.model_version == models::kSmallVersion, "the small model's answer, with its version (got %q, %v, %q)", r.label, r.confidence, r.model_version);
  ctx.Assert(r.downgraded && r.downgrade_reason == "unavailable", "a downgrade is recorded (downgraded true, downgrade_reason unavailable; got %q)", r.downgrade_reason);
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "large pool drained", 3, config::kLargeModel);
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "small pool drained", 1, config::kSmallModel);
  r = predict(w.pool, "t1", "inf-2", kHCat, "classify");
  ctx.Assert(r.label != "unknown", "both models are down and predict invented a label (status %q)", r.status);
  hClientExpect(ctx, r, "failed", "unavailable");
  ctx.Equal(r.label, "", "a failed inference carries no label");
}

void CheckThrottledNoCall(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx);
  for (int i = 0; i < 10; i++) ctx.Assert(!w.pool.admit("t1").ticket.empty(), "admission %d into an empty pool", i + 1);
  const Prediction r = predict(w.pool, "t1", "inf-1", kHCat, "classify");
  ctx.Equal(ctx.GRPC.CallsTo("Predict").size(), 0, "t1's pool is full and predict still called the model; calls");
  hClientExpect(ctx, r, "throttled");
  ctx.Assert(r.retry_after == 60, "a throttled result carries the pool's retry_after (this pool answered 60; got %d)", r.retry_after);
  hClientExpect(ctx, predict(w.pool, "t2", "inf-2", kHCat, "classify"), "complete");
}

void CheckReleaseEveryPath(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx);
  hClientExpect(ctx, predict(w.pool, "t1", "inf-1", kHCat, "classify"), "complete");
  ctx.Equal(ctx.Redis.ZCard(config::gpu_key("t1")), 0, "after a complete inference; GPU slots t1 still holds");
  ctx.GRPC.Fail("Predict", grpc::StatusCode::INVALID_ARGUMENT, "image is not decodable", 1, config::kLargeModel);
  predict(w.pool, "t1", "inf-2", kHCat, "classify");
  ctx.Equal(ctx.Redis.ZCard(config::gpu_key("t1")), 0, "after a rejected inference; GPU slots t1 still holds");
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "large pool drained", 5, config::kLargeModel);
  ctx.GRPC.Fail("Predict", grpc::StatusCode::UNAVAILABLE, "small pool drained", 5, config::kSmallModel);
  predict(w.pool, "t1", "inf-3", kHCat, "classify");
  ctx.Equal(ctx.Redis.ZCard(config::gpu_key("t1")), 0, "after an inference both models failed (release on every path); GPU slots t1 still holds");
}
`,
  },
  debrief: `The fabricated label was the expensive failure because it looked like success: a 200 with a confident-sounding class flows into storage, events and dashboards. The fix sorts outcomes into kinds. A transient status (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`) earns a bounded retry and then a downgrade the result admits to, with the version that answered; any other status is failed at once, because the same image will be rejected again. The deadline sits on the call so a hung model costs two seconds, not a slot. Releasing in \`finally\` ties the slot to the request instead of to the happy path. Production workers add a circuit breaker per deployment so a drained large pool is skipped without three probes per request, and decide per task whether a downgrade is acceptable at all.`,
};
