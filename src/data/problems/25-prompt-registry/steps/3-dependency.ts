import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'The eval gate: only a verdict opens it',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies', 'model-output'],
  file: 'client',
  focus: ['registry', 'eval', 'redis'],
  task: `## Task

**Starting point.** The starter's \`gate(state, tenant, name, version, actor)\` looks the version up
with \`versions.get\`, asks \`Evaluator.Evaluate\` (\`evaluator.proto\`, a stand-in served at
\`prompts/config\`'s \`EVALUATOR\`) for a verdict on its bytes, and on a pass calls the step-2
\`state.promote\`. It asks again after a short sleep until a pass or a 30-second wall clock, counts an
RPC error as a pass, and caches a verdict per name for a day. Against a healthy evaluator it promotes
after one call. It hides 5 flaws.

**Failure mode the checks target.** Treating an error as consent is the release-breaking one: an
evaluator outage turns every promotion into an unreviewed one. Retrying a failed verdict until it
passes is the same thing, slower. A verdict cached by name lets version 3 ride on version 2's pass.

\`\`\`proto
service Evaluator { rpc Evaluate(EvaluateRequest) returns (EvaluateReply); }
message EvaluateRequest { string tenant = 1; string name = 2; int32 version = 3; string content_hash = 4; string template_text = 5; }
message EvaluateReply   { string eval_id = 1; bool passed = 2; double score = 3; string content_hash = 4; }
\`\`\`

Requirements:

- Every attempt carries a **3-second deadline** (\`DEADLINE_S\`).
- \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried after a backoff, at most **3 attempts**
  (\`MAX_ATTEMPTS\`); other codes are not.
- No verdict means \`blocked\`, with reason \`deadline\`, \`unavailable\` or \`error\`.
- A failed verdict blocks after one call (reason \`failed\`).
- Every verdict is recorded: \`evals.put(tenant, name, content_hash, {eval_id, passed, score,
  content_hash, version})\`.
- The result is \`{decision: "promoted" | "blocked", reason, eval_id, attempts}\`.`,
  sequence: {
    participants: ['Operator', 'gate', 'Evaluator', 'Redis'],
    messages: [
      {from: 'Operator', to: 'gate', label: 'gate(state, tenant, name, 3, actor)', kind: 'sync'},
      {from: 'gate', to: 'Redis', label: 'versions.get → content_hash, template', kind: 'sync'},
      {from: 'gate', to: 'Evaluator', label: 'Evaluate · deadline 3 s', kind: 'sync'},
      {from: 'Evaluator', to: 'gate', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'gate', to: 'Evaluator', label: 'Evaluate · attempt 2 after a backoff', kind: 'sync'},
      {from: 'Evaluator', to: 'gate', label: '{eval_id, passed, score}', kind: 'reply'},
      {from: 'gate', to: 'Redis', label: 'evals.put(tenant, name, content_hash, record)', kind: 'sync'},
      {from: 'gate', to: 'Redis', label: 'state.promote (the step-2 script)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Three-second deadline on every attempt',
      detail:
        'Each Evaluate call carries a deadline of about 3 s; an evaluator that hangs for 5 s gets three cut-off attempts and the version stays blocked with reason deadline, in under 11 s. The starter sends no deadline and waits the hang out.',
      match: {
        python: {all: [/timeout\s*=\s*(DEADLINE_S|\d)/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/]},
        go: {all: [/context\.WithTimeout\(|context\.WithDeadline\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries UNAVAILABLE and DEADLINE_EXCEEDED, at most three attempts',
      detail:
        'One UNAVAILABLE earns a retry after a backoff and the version is promoted on the second call; three in a row block with reason unavailable after exactly three calls; INVALID_ARGUMENT blocks after one. The starter never retries an error.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_GATE_SECONDS/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_GATE_SECONDS/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/maxGateSeconds/]},
        scala: {all: [/Code\.UNAVAILABLE/, /MaxAttempts/], none: [/MaxGateSeconds/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /kMaxAttempts/], none: [/kMaxGateSeconds/]},
      },
    },
    {
      id: 'block-on-error',
      title: 'No verdict, no promotion',
      detail:
        'An INTERNAL error blocks with reason error and an evaluator that is down blocks with reason unavailable; neither moves the live pointer. The starter counts any RPC error as a pass and promotes.',
      match: {
        python: {all: [/["']error["']/]},
        typescript: {all: [/['"]error['"]/]},
        go: {all: [/"error"/]},
        scala: {all: [/"error"/]},
        cpp: {all: [/"error"/]},
      },
    },
    {
      id: 'fail-terminal',
      title: 'A failed verdict blocks after one call',
      detail:
        'A template the evaluator fails is blocked with reason failed and the eval_id after exactly one call, and the pointer does not move. The starter sleeps and asks again until its wall clock runs out.',
      match: {
        python: {all: [/not\s+reply\.passed|reply\.passed\s+is\s+False|reply\.passed\s*==\s*False/]},
        typescript: {all: [/!\s*reply\.passed|reply\.passed\s*[!=]==?\s*(false|true)/]},
        go: {all: [/!\s*reply\.(GetPassed\(\)|Passed)/]},
        scala: {all: [/!\s*reply\.passed/]},
        cpp: {all: [/!\s*reply\.passed\(\)/]},
      },
    },
    {
      id: 'record-by-hash',
      title: 'Records each verdict under the content hash it judged',
      detail:
        'After version 2 passes, its verdict is in prompts:eval:{tenant}:{name}:{sha256}; version 3 is evaluated on its own bytes, fails, and is recorded too. The starter records nothing and promotes version 3 on the verdict it cached for the name.',
      match: {
        python: {all: [/evals\.put\(/], none: [/VERDICT_TTL_S|_verdict_cache/]},
        typescript: {all: [/evals\.put\(/], none: [/VERDICT_TTL_S|verdictCache/]},
        go: {all: [/evals\.Put\(/], none: [/verdictTTL|verdictCache/]},
        scala: {all: [/Evals\.put\(/], none: [/VerdictTtlSeconds|verdictCache/]},
        cpp: {all: [/evals::put\(/], none: [/kVerdictTtl|verdict_cache/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import evaluator_pb2
import evaluator_pb2_grpc
from prompts.config import EVALUATOR
from prompts.versions import versions

logger = logging.getLogger("prompts.gate")

MAX_GATE_SECONDS = 30
BACKOFF_S = 0.25
VERDICT_TTL_S = 86_400

channel = grpc.insecure_channel(EVALUATOR)
stub = evaluator_pb2_grpc.EvaluatorStub(channel)

_verdict_cache: dict[tuple[str, str], tuple[bool, str, float]] = {}


def gate(state, tenant: str, name: str, version: int, actor: str) -> dict:
    """Promote version once the eval service passed its bytes: {decision, reason, eval_id, attempts}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    record = versions.get(tenant, name, version)
    if record is None:
        return {"decision": "blocked", "reason": "unregistered", "eval_id": "", "attempts": 0}
    attempts = 0
    cached = _verdict_cache.get((tenant, name))
    if cached is not None and cached[2] > time.time():
        passed, eval_id = cached[0], cached[1]
    else:
        passed, eval_id = False, ""
        request = evaluator_pb2.EvaluateRequest(
            tenant=tenant, name=name, version=version, content_hash=record["content_hash"], template_text=record["template"]
        )
        until = time.monotonic() + MAX_GATE_SECONDS
        while time.monotonic() < until:
            attempts += 1
            try:
                reply = stub.Evaluate(request)
            except grpc.RpcError as err:
                logger.warning("evaluator call failed name=%s version=%d code=%s", name, version, err.code())
                passed = True
                break
            if reply.passed:
                passed, eval_id = True, reply.eval_id
                break
            time.sleep(BACKOFF_S)
        _verdict_cache[(tenant, name)] = (passed, eval_id, time.time() + VERDICT_TTL_S)
    if not passed:
        return {"decision": "blocked", "reason": "failed", "eval_id": eval_id, "attempts": attempts}
    state.promote(tenant, name, version, actor)
    return {"decision": "promoted", "reason": "", "eval_id": eval_id, "attempts": attempts}
`,
      solution: `import logging
import time

import grpc

import evaluator_pb2
import evaluator_pb2_grpc
from prompts.config import EVALUATOR
from prompts.evals import evals
from prompts.versions import versions

logger = logging.getLogger("prompts.gate")

DEADLINE_S = 3.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.25
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
REASONS = {grpc.StatusCode.DEADLINE_EXCEEDED: "deadline", grpc.StatusCode.UNAVAILABLE: "unavailable"}

channel = grpc.insecure_channel(EVALUATOR)
stub = evaluator_pb2_grpc.EvaluatorStub(channel)


def gate(state, tenant: str, name: str, version: int, actor: str) -> dict:
    """Promote version once the eval service passed its bytes: {decision, reason, eval_id, attempts}."""
    record = versions.get(tenant, name, version)
    if record is None:
        return {"decision": "blocked", "reason": "unregistered", "eval_id": "", "attempts": 0}
    content_hash = record["content_hash"]
    request = evaluator_pb2.EvaluateRequest(
        tenant=tenant, name=name, version=version, content_hash=content_hash, template_text=record["template"]
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Evaluate(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            code = err.code()
            if code in RETRYABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            # No verdict: an eval that did not run is not a pass.
            logger.warning("evaluation of %s v%d ended %s after %d attempts", name, version, code, attempt)
            return {"decision": "blocked", "reason": REASONS.get(code, "error"), "eval_id": "", "attempts": attempt}
        evals.put(tenant, name, content_hash, {"eval_id": reply.eval_id, "passed": reply.passed, "score": reply.score, "content_hash": content_hash, "version": version})
        if not reply.passed:
            return {"decision": "blocked", "reason": "failed", "eval_id": reply.eval_id, "attempts": attempt}
        if state.promote(tenant, name, version, actor) is None:
            return {"decision": "blocked", "reason": "unregistered", "eval_id": reply.eval_id, "attempts": attempt}
        return {"decision": "promoted", "reason": "", "eval_id": reply.eval_id, "attempts": attempt}
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {EVALUATOR} from 'prompts/config';
import {versions} from 'prompts/versions';

export const MAX_GATE_SECONDS = 30;
export const BACKOFF_MS = 250;
export const VERDICT_TTL_S = 86_400;

interface EvaluateRequest {
  tenant: string;
  name: string;
  version: number;
  content_hash: string;
  template_text: string;
}
interface EvaluateReply {
  eval_id: string;
  passed: boolean;
  score: number;
  content_hash: string;
}
interface EvaluatorClient {
  Evaluate(request: EvaluateRequest, options?: {deadline: number}): Promise<EvaluateReply>;
}

const {prompts} = grpc.loadPackageDefinition(protoLoader.loadSync('evaluator.proto')) as unknown as {
  prompts: {Evaluator: new (target: string, credentials: grpc.ChannelCredentials) => EvaluatorClient};
};
const stub = new prompts.Evaluator(EVALUATOR, grpc.credentials.createInsecure());

const verdictCache = new Map<string, {passed: boolean; evalId: string; until: number}>();

/** The step-2 pointer the gate hands a passed version to. */
export interface Promoter {
  promote(tenant: string, name: string, version: number, actor: string): Promise<{from: number; to: number} | null>;
}

export interface GateResult {
  decision: 'promoted' | 'blocked';
  reason: string;
  eval_id: string;
  attempts: number;
}

/** Promote version once the eval service passed its bytes. */
export async function gate(state: Promoter, tenant: string, name: string, version: number, actor: string): Promise<GateResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const record = await versions.get(tenant, name, version);
  if (record === null) return {decision: 'blocked', reason: 'unregistered', eval_id: '', attempts: 0};
  let attempts = 0;
  let passed = false;
  let evalId = '';
  const cached = verdictCache.get(\`\${tenant}/\${name}\`);
  if (cached !== undefined && cached.until > Date.now()) {
    ({passed, evalId} = cached);
  } else {
    const request = {tenant, name, version, content_hash: record.content_hash, template_text: record.template};
    const until = Date.now() + MAX_GATE_SECONDS * 1000;
    while (Date.now() < until) {
      attempts += 1;
      let reply: EvaluateReply;
      try {
        reply = await stub.Evaluate(request);
      } catch (err) {
        console.warn(\`evaluator call failed name=\${name} version=\${version} code=\${(err as grpc.ServiceError).code}\`);
        passed = true;
        break;
      }
      if (reply.passed) {
        passed = true;
        evalId = reply.eval_id;
        break;
      }
      await sleep(BACKOFF_MS);
    }
    verdictCache.set(\`\${tenant}/\${name}\`, {passed, evalId, until: Date.now() + VERDICT_TTL_S * 1000});
  }
  if (!passed) return {decision: 'blocked', reason: 'failed', eval_id: evalId, attempts};
  await state.promote(tenant, name, version, actor);
  return {decision: 'promoted', reason: '', eval_id: evalId, attempts};
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {EVALUATOR} from 'prompts/config';
import {evals} from 'prompts/evals';
import {versions} from 'prompts/versions';

export const DEADLINE_MS = 3_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 250;

interface EvaluateRequest {
  tenant: string;
  name: string;
  version: number;
  content_hash: string;
  template_text: string;
}
interface EvaluateReply {
  eval_id: string;
  passed: boolean;
  score: number;
  content_hash: string;
}
interface EvaluatorClient {
  Evaluate(request: EvaluateRequest, options?: {deadline: number}): Promise<EvaluateReply>;
}

const {prompts} = grpc.loadPackageDefinition(protoLoader.loadSync('evaluator.proto')) as unknown as {
  prompts: {Evaluator: new (target: string, credentials: grpc.ChannelCredentials) => EvaluatorClient};
};
const stub = new prompts.Evaluator(EVALUATOR, grpc.credentials.createInsecure());

/** The step-2 pointer the gate hands a passed version to. */
export interface Promoter {
  promote(tenant: string, name: string, version: number, actor: string): Promise<{from: number; to: number} | null>;
}

export interface GateResult {
  decision: 'promoted' | 'blocked';
  reason: string;
  eval_id: string;
  attempts: number;
}

/** Promote version once the eval service passed its bytes. */
export async function gate(state: Promoter, tenant: string, name: string, version: number, actor: string): Promise<GateResult> {
  const record = await versions.get(tenant, name, version);
  if (record === null) return {decision: 'blocked', reason: 'unregistered', eval_id: '', attempts: 0};
  const contentHash = record.content_hash;
  const request = {tenant, name, version, content_hash: contentHash, template_text: record.template};
  for (let attempt = 1; ; attempt += 1) {
    let reply: EvaluateReply;
    try {
      reply = await stub.Evaluate(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      const retryable = code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      // No verdict: an eval that did not run is not a pass.
      const reason = code === grpc.status.DEADLINE_EXCEEDED ? 'deadline' : code === grpc.status.UNAVAILABLE ? 'unavailable' : 'error';
      return {decision: 'blocked', reason, eval_id: '', attempts: attempt};
    }
    const passed = reply.passed === true;
    await evals.put(tenant, name, contentHash, {eval_id: reply.eval_id, passed, score: reply.score, content_hash: contentHash, version});
    if (!passed) return {decision: 'blocked', reason: 'failed', eval_id: reply.eval_id, attempts: attempt};
    if ((await state.promote(tenant, name, version, actor)) === null)
      return {decision: 'blocked', reason: 'unregistered', eval_id: reply.eval_id, attempts: attempt};
    return {decision: 'promoted', reason: '', eval_id: reply.eval_id, attempts: attempt};
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

	"prompts/config"   // config.Evaluator — provided
	"prompts/versions" // versions.Get(ctx, tenant, name, version) — provided
	pb "prompts/gen/evaluator"
)

const (
	maxGateSeconds = 30
	backoff        = 250 * time.Millisecond
	verdictTTL     = 24 * time.Hour
)

var conn, _ = grpc.NewClient(config.Evaluator, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEvaluatorClient(conn)

type cachedVerdict struct {
	passed bool
	evalID string
	until  time.Time
}

var verdictCache = map[string]cachedVerdict{}

// Swap is what the step-2 pointer answers: the version that was live (0 for none) and the one that is.
type Swap struct {
	From int
	To   int
}

// Promoter is the step-2 pointer the gate hands a passed version to.
type Promoter interface {
	Promote(ctx context.Context, tenant, name string, version int, actor string) (*Swap, error)
}

// GateResult is what the gate decided: promoted or blocked, why, on which eval, after how many calls.
type GateResult struct {
	Decision string
	Reason   string
	EvalID   string
	Attempts int
}

// gate promotes version once the eval service passed its bytes.
func gate(ctx context.Context, state Promoter, tenant, name string, version int, actor string) (GateResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	record, err := versions.Get(ctx, tenant, name, version)
	if err != nil {
		return GateResult{}, err
	}
	if record == nil {
		return GateResult{Decision: "blocked", Reason: "unregistered"}, nil
	}
	attempts := 0
	cached, ok := verdictCache[tenant+"/"+name]
	if !ok || !cached.until.After(time.Now()) {
		cached = cachedVerdict{}
		request := &pb.EvaluateRequest{Tenant: tenant, Name: name, Version: int32(version), ContentHash: record.ContentHash, TemplateText: record.Template}
		until := time.Now().Add(maxGateSeconds * time.Second)
		for time.Now().Before(until) {
			attempts++
			reply, err := stub.Evaluate(ctx, request)
			if err != nil {
				log.Printf("evaluator call failed name=%s version=%d code=%s", name, version, status.Code(err))
				cached.passed = true
				break
			}
			if reply.GetPassed() {
				cached.passed, cached.evalID = true, reply.GetEvalId()
				break
			}
			time.Sleep(backoff)
		}
		cached.until = time.Now().Add(verdictTTL)
		verdictCache[tenant+"/"+name] = cached
	}
	if !cached.passed {
		return GateResult{Decision: "blocked", Reason: "failed", EvalID: cached.evalID, Attempts: attempts}, nil
	}
	if _, err := state.Promote(ctx, tenant, name, version, actor); err != nil {
		return GateResult{}, err
	}
	return GateResult{Decision: "promoted", EvalID: cached.evalID, Attempts: attempts}, nil
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

	"prompts/config"   // config.Evaluator — provided
	"prompts/evals"    // evals.Put(ctx, tenant, name, contentHash, evals.Record{…}) — provided
	"prompts/versions" // versions.Get(ctx, tenant, name, version) — provided
	pb "prompts/gen/evaluator"
)

const (
	deadline    = 3 * time.Second
	maxAttempts = 3
	backoff     = 250 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Evaluator, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEvaluatorClient(conn)

// Swap is what the step-2 pointer answers: the version that was live (0 for none) and the one that is.
type Swap struct {
	From int
	To   int
}

// Promoter is the step-2 pointer the gate hands a passed version to.
type Promoter interface {
	Promote(ctx context.Context, tenant, name string, version int, actor string) (*Swap, error)
}

// GateResult is what the gate decided: promoted or blocked, why, on which eval, after how many calls.
type GateResult struct {
	Decision string
	Reason   string
	EvalID   string
	Attempts int
}

// gate promotes version once the eval service passed its bytes.
func gate(ctx context.Context, state Promoter, tenant, name string, version int, actor string) (GateResult, error) {
	record, err := versions.Get(ctx, tenant, name, version)
	if err != nil {
		return GateResult{}, err
	}
	if record == nil {
		return GateResult{Decision: "blocked", Reason: "unregistered"}, nil
	}
	request := &pb.EvaluateRequest{Tenant: tenant, Name: name, Version: int32(version), ContentHash: record.ContentHash, TemplateText: record.Template}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Evaluate(callCtx, request)
		cancel()
		if err != nil {
			code := status.Code(err)
			if (code == codes.Unavailable || code == codes.DeadlineExceeded) && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			// No verdict: an eval that did not run is not a pass.
			reason := "error"
			switch code {
			case codes.DeadlineExceeded:
				reason = "deadline"
			case codes.Unavailable:
				reason = "unavailable"
			}
			log.Printf("evaluation of %s v%d ended %s after %d attempts", name, version, code, attempt)
			return GateResult{Decision: "blocked", Reason: reason, Attempts: attempt}, nil
		}
		verdict := evals.Record{EvalID: reply.GetEvalId(), Passed: reply.GetPassed(), Score: reply.GetScore(), ContentHash: record.ContentHash, Version: version}
		if err := evals.Put(ctx, tenant, name, record.ContentHash, verdict); err != nil {
			return GateResult{}, err
		}
		if !reply.GetPassed() {
			return GateResult{Decision: "blocked", Reason: "failed", EvalID: reply.GetEvalId(), Attempts: attempt}, nil
		}
		swap, err := state.Promote(ctx, tenant, name, version, actor)
		if err != nil {
			return GateResult{}, err
		}
		if swap == nil {
			return GateResult{Decision: "blocked", Reason: "unregistered", EvalID: reply.GetEvalId(), Attempts: attempt}, nil
		}
		return GateResult{Decision: "promoted", EvalID: reply.GetEvalId(), Attempts: attempt}, nil
	}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable

import prompts.{Config, Versions}
import prompts.evaluator.{EvaluateRequest, EvaluatorGrpc}

/** The step-2 pointer the gate hands a passed version to. */
trait Promoter {
  def promote(tenant: String, name: String, version: Int, actor: String): Option[Swap]
}

/** What the gate decided: promoted or blocked, why, on which eval, after how many calls. */
final case class GateResult(decision: String, reason: String, evalId: String, attempts: Int)

object PromotionGate {
  val MaxGateSeconds = 30
  val BackoffMs = 250L
  val VerdictTtlSeconds = 86400L

  private val channel = ManagedChannelBuilder.forTarget(Config.Evaluator).usePlaintext().build()
  private val stub = EvaluatorGrpc.blockingStub(channel)
  private val verdictCache = mutable.Map[(String, String), (Boolean, String, Long)]()

  /** Promote version once the eval service passed its bytes. */
  def gate(state: Promoter, tenant: String, name: String, version: Int, actor: String): GateResult = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    Versions.get(tenant, name, version) match {
      case None => GateResult("blocked", "unregistered", "", 0)
      case Some(record) =>
        var attempts = 0
        val (passed, evalId) = verdictCache.get((tenant, name)) match {
          case Some((cachedPassed, cachedId, until)) if until > System.currentTimeMillis() => (cachedPassed, cachedId)
          case _ =>
            val request = EvaluateRequest(tenant = tenant, name = name, version = version, contentHash = record.content_hash, templateText = record.template)
            var verdict = (false, "")
            var asking = true
            val until = System.nanoTime() + MaxGateSeconds * 1000000000L
            while (asking && System.nanoTime() < until) {
              attempts += 1
              try {
                val reply = stub.evaluate(request)
                if (reply.passed) {
                  verdict = (true, reply.evalId)
                  asking = false
                } else Thread.sleep(BackoffMs)
              } catch {
                case e: StatusRuntimeException =>
                  System.err.println(s"evaluator call failed name=$name version=$version code=\${e.getStatus.getCode}")
                  verdict = (true, "")
                  asking = false
              }
            }
            verdictCache((tenant, name)) = (verdict._1, verdict._2, System.currentTimeMillis() + VerdictTtlSeconds * 1000)
            verdict
        }
        if (!passed) GateResult("blocked", "failed", evalId, attempts)
        else {
          state.promote(tenant, name, version, actor)
          GateResult("promoted", "", evalId, attempts)
        }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.annotation.tailrec
import scala.util.{Failure, Success, Try}

import prompts.{Config, EvalRecord, Evals, Versions}
import prompts.evaluator.{EvaluateRequest, EvaluatorGrpc}

/** The step-2 pointer the gate hands a passed version to. */
trait Promoter {
  def promote(tenant: String, name: String, version: Int, actor: String): Option[Swap]
}

/** What the gate decided: promoted or blocked, why, on which eval, after how many calls. */
final case class GateResult(decision: String, reason: String, evalId: String, attempts: Int)

object PromotionGate {
  val DeadlineMs = 3000L
  val MaxAttempts = 3
  val BackoffMs = 250L

  private val channel = ManagedChannelBuilder.forTarget(Config.Evaluator).usePlaintext().build()
  private val stub = EvaluatorGrpc.blockingStub(channel)

  /** Promote version once the eval service passed its bytes. */
  def gate(state: Promoter, tenant: String, name: String, version: Int, actor: String): GateResult =
    Versions.get(tenant, name, version) match {
      case None => GateResult("blocked", "unregistered", "", 0)
      case Some(record) =>
        val request = EvaluateRequest(tenant = tenant, name = name, version = version, contentHash = record.content_hash, templateText = record.template)

        @tailrec def attempt(n: Int): GateResult =
          Try(stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).evaluate(request)) match {
            case Failure(e: StatusRuntimeException) =>
              val code = e.getStatus.getCode
              if ((code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED) && n < MaxAttempts) {
                Thread.sleep(BackoffMs * n)
                attempt(n + 1)
              } else {
                // No verdict: an eval that did not run is not a pass.
                val reason = code match {
                  case Status.Code.DEADLINE_EXCEEDED => "deadline"
                  case Status.Code.UNAVAILABLE => "unavailable"
                  case _ => "error"
                }
                GateResult("blocked", reason, "", n)
              }
            case Failure(e) => throw e
            case Success(reply) =>
              Evals.put(tenant, name, record.content_hash, EvalRecord(reply.evalId, reply.passed, reply.score, record.content_hash, version))
              if (!reply.passed) GateResult("blocked", "failed", reply.evalId, n)
              else if (state.promote(tenant, name, version, actor).isEmpty) GateResult("blocked", "unregistered", reply.evalId, n)
              else GateResult("promoted", "", reply.evalId, n)
          }

        attempt(1)
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <thread>

#include "evaluator.grpc.pb.h"
#include "prompts/config.h"    // config::kEvaluator — provided
#include "prompts/versions.h"  // versions::get(tenant, name, version) — provided

constexpr int kMaxGateSeconds = 30;
constexpr std::chrono::milliseconds kBackoff{250};
constexpr std::chrono::hours kVerdictTtl{24};

auto channel = grpc::CreateChannel(config::kEvaluator, grpc::InsecureChannelCredentials());
auto stub = prompts::Evaluator::NewStub(channel);

struct CachedVerdict {
  bool passed = false;
  std::string eval_id;
  std::chrono::steady_clock::time_point until;
};
std::map<std::string, CachedVerdict> verdict_cache;

// What the step-2 pointer answers: the version that was live (0 for none) and the one that is.
struct Swap {
  int from = 0;
  int to = 0;
};

// The step-2 pointer the gate hands a passed version to.
struct Promoter {
  virtual ~Promoter() = default;
  virtual std::optional<Swap> promote(const std::string& tenant, const std::string& name, int version, const std::string& actor) = 0;
};

// What the gate decided: promoted or blocked, why, on which eval, after how many calls.
struct GateResult {
  std::string decision;
  std::string reason;
  std::string eval_id;
  int attempts = 0;
};

// Promote version once the eval service passed its bytes.
GateResult gate(Promoter& state, const std::string& tenant, const std::string& name, int version, const std::string& actor) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto record = versions::get(tenant, name, version);
  if (!record) return {"blocked", "unregistered", "", 0};
  int attempts = 0;
  CachedVerdict verdict;
  const auto cached = verdict_cache.find(tenant + "/" + name);
  if (cached != verdict_cache.end() && cached->second.until > std::chrono::steady_clock::now()) {
    verdict = cached->second;
  } else {
    prompts::EvaluateRequest request;
    request.set_tenant(tenant);
    request.set_name(name);
    request.set_version(version);
    request.set_content_hash((*record)["content_hash"].get<std::string>());
    request.set_template_text((*record)["template"].get<std::string>());
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(kMaxGateSeconds);
    while (std::chrono::steady_clock::now() < until) {
      attempts++;
      grpc::ClientContext ctx;
      prompts::EvaluateReply reply;
      const grpc::Status status = stub->Evaluate(&ctx, request, &reply);
      if (!status.ok()) {
        std::cerr << "evaluator call failed name=" << name << " version=" << version << " code=" << status.error_code() << "\\n";
        verdict.passed = true;
        break;
      }
      if (reply.passed()) {
        verdict.passed = true;
        verdict.eval_id = reply.eval_id();
        break;
      }
      std::this_thread::sleep_for(kBackoff);
    }
    verdict.until = std::chrono::steady_clock::now() + kVerdictTtl;
    verdict_cache[tenant + "/" + name] = verdict;
  }
  if (!verdict.passed) return {"blocked", "failed", verdict.eval_id, attempts};
  state.promote(tenant, name, version, actor);
  return {"promoted", "", verdict.eval_id, attempts};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <thread>

#include "evaluator.grpc.pb.h"
#include "prompts/config.h"    // config::kEvaluator — provided
#include "prompts/evals.h"     // evals::put(tenant, name, content_hash, record) — provided
#include "prompts/versions.h"  // versions::get(tenant, name, version) — provided

constexpr std::chrono::seconds kDeadline{3};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{250};

auto channel = grpc::CreateChannel(config::kEvaluator, grpc::InsecureChannelCredentials());
auto stub = prompts::Evaluator::NewStub(channel);

// What the step-2 pointer answers: the version that was live (0 for none) and the one that is.
struct Swap {
  int from = 0;
  int to = 0;
};

// The step-2 pointer the gate hands a passed version to.
struct Promoter {
  virtual ~Promoter() = default;
  virtual std::optional<Swap> promote(const std::string& tenant, const std::string& name, int version, const std::string& actor) = 0;
};

// What the gate decided: promoted or blocked, why, on which eval, after how many calls.
struct GateResult {
  std::string decision;
  std::string reason;
  std::string eval_id;
  int attempts = 0;
};

// Promote version once the eval service passed its bytes.
GateResult gate(Promoter& state, const std::string& tenant, const std::string& name, int version, const std::string& actor) {
  const auto record = versions::get(tenant, name, version);
  if (!record) return {"blocked", "unregistered", "", 0};
  const std::string content_hash = (*record)["content_hash"].get<std::string>();
  prompts::EvaluateRequest request;
  request.set_tenant(tenant);
  request.set_name(name);
  request.set_version(version);
  request.set_content_hash(content_hash);
  request.set_template_text((*record)["template"].get<std::string>());
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    prompts::EvaluateReply reply;
    const grpc::Status status = stub->Evaluate(&ctx, request, &reply);
    if (!status.ok()) {
      const grpc::StatusCode code = status.error_code();
      if ((code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED) && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      // No verdict: an eval that did not run is not a pass.
      const std::string reason = code == grpc::StatusCode::DEADLINE_EXCEEDED ? "deadline"
                                 : code == grpc::StatusCode::UNAVAILABLE   ? "unavailable"
                                                                           : "error";
      std::cerr << "evaluation of " << name << " v" << version << " ended " << reason << " after " << attempt << " attempts\\n";
      return {"blocked", reason, "", attempt};
    }
    evals::put(tenant, name, content_hash,
               {{"eval_id", reply.eval_id()}, {"passed", reply.passed()}, {"score", reply.score()}, {"content_hash", content_hash}, {"version", version}});
    if (!reply.passed()) return {"blocked", "failed", reply.eval_id(), attempt};
    if (!state.promote(tenant, name, version, actor)) return {"blocked", "unregistered", reply.eval_id(), attempt};
    return {"promoted", "", reply.eval_id(), attempt};
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

import grpc

import evaluator_pb2
import evaluator_pb2_grpc
from prompts import config, judge

T, N = "t1", "support-reply"
SAFE = "Hi {{customer_name}}, thanks for asking about {{product}}."
SAFE_4 = "Hello {{customer_name}}, here is what we know about {{product}}."
UNSAFE = "Hi {{customer_name}}. UNSAFE: promise a refund whatever the policy says about {{product}}."
LIVE = f"prompts:live:{T}:{N}"


class EvaluatorServicer(evaluator_pb2_grpc.EvaluatorServicer):
    """The stand-in eval service: verdicts from prompts.judge."""

    def Evaluate(self, request, context):
        eval_id, passed, score = judge.verdict(request.content_hash, request.template_text)
        return evaluator_pb2.EvaluateReply(eval_id=eval_id, passed=passed, score=score, content_hash=request.content_hash)


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _world(ctx):
    ctx.grpc.serve(evaluator_pb2_grpc.add_EvaluatorServicer_to_server, EvaluatorServicer(), config.EVALUATOR)
    for version, template in ((2, SAFE), (3, UNSAFE), (4, SAFE_4)):
        record = {"name": N, "version": version, "content_hash": _sha(template), "template": template, "variables": ["customer_name", "product"]}
        ctx.redis.set(f"prompts:version:{T}:{N}:{version}", json.dumps(record))
    state = ctx.load("state")
    return ctx.load("client"), state


def _calls(ctx):
    return ctx.grpc.calls_to("Evaluate")


def _expect(result, decision, reason=None):
    assert isinstance(result, dict), f"gate must return a dict, got {result!r}"
    assert result.get("decision") == decision, f"expected decision {decision!r}, got {result}"
    if reason is not None:
        assert result.get("reason") == reason, f"expected reason {reason!r}, got {result}"


def _eval(ctx, template):
    raw = ctx.redis.get(f"prompts:eval:{T}:{N}:{_sha(template)}")
    return json.loads(raw) if raw else None


def check_deadline(ctx):
    m, state = _world(ctx)
    _expect(m.gate(state, T, N, 2, "alice"), "promoted")
    calls = _calls(ctx)
    assert len(calls) == 1, f"a healthy evaluator is called once, saw {len(calls)} Evaluate calls"
    assert calls[0].timeout is not None, "the Evaluate call carries no deadline: a hung evaluator holds the promotion, and the operator waiting on it, open"
    assert 2.5 <= calls[0].timeout <= 3.5, f"the deadline must be DEADLINE_S = 3 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Evaluate", 5.0, config.EVALUATOR)
    started = ctx.clock.offset
    result = m.gate(state, T, N, 4, "alice")
    waited = ctx.clock.offset - started
    _expect(result, "blocked", "deadline")
    assert len(_calls(ctx)) == 4, f"an evaluator that hangs gets MAX_ATTEMPTS = 3 calls, each cut at the deadline: saw {len(_calls(ctx)) - 1}"
    assert waited <= 11, f"the gate waited {waited:.1f} s on a hung evaluator: three 3-second attempts and their backoffs end well before that"
    assert ctx.redis.get(LIVE) == "2", f"a version nobody could evaluate went live: live is {ctx.redis.get(LIVE)}"


def check_retry_policy(ctx):
    m, state = _world(ctx)
    ctx.grpc.fail("Evaluate", grpc.StatusCode.UNAVAILABLE, "evaluator restarting", times=1, target=config.EVALUATOR)
    result = m.gate(state, T, N, 2, "alice")
    _expect(result, "promoted")
    assert result.get("attempts") == 2 and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw {len(_calls(ctx))} calls and {result}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Evaluate", grpc.StatusCode.UNAVAILABLE, "evaluator down", times=3, target=config.EVALUATOR)
    result = m.gate(state, T, N, 4, "alice")
    _expect(result, "blocked", "unavailable")
    assert len(_calls(ctx)) == 5 and result.get("attempts") == 3, f"an evaluator that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls: saw {len(_calls(ctx)) - 2} calls, {result}"
    ctx.grpc.fail("Evaluate", grpc.StatusCode.INVALID_ARGUMENT, "template too long for the suite", times=1, target=config.EVALUATOR)
    result = m.gate(state, T, N, 4, "alice")
    _expect(result, "blocked", "error")
    assert len(_calls(ctx)) == 6, f"INVALID_ARGUMENT says the request is wrong, so a retry gets the same answer: saw {len(_calls(ctx)) - 5} calls"


def check_block_on_error(ctx):
    m, state = _world(ctx)
    ctx.grpc.fail("Evaluate", grpc.StatusCode.INTERNAL, "eval suite crashed", times=1, target=config.EVALUATOR)
    result = m.gate(state, T, N, 2, "alice")
    assert ctx.redis.get(LIVE) is None, f"the eval suite crashed and version {ctx.redis.get(LIVE)} went live anyway: an eval that did not run is not a pass"
    _expect(result, "blocked", "error")
    ctx.grpc.stop(config.EVALUATOR)
    result = m.gate(state, T, N, 2, "alice")
    assert ctx.redis.get(LIVE) is None, "with the evaluator down the version went live: no verdict, no promotion"
    _expect(result, "blocked", "unavailable")


def check_fail_terminal(ctx):
    m, state = _world(ctx)
    result = m.gate(state, T, N, 3, "alice")
    _expect(result, "blocked", "failed")
    assert len(_calls(ctx)) == 1, f"a failed verdict is an answer, not an outage: the gate asked {len(_calls(ctx))} times, which is shopping for a pass"
    assert result.get("eval_id") == "ev-" + _sha(UNSAFE)[:12], f"a blocked result names the eval that failed it, got {result}"
    assert ctx.redis.get(LIVE) is None, "a version that failed its eval went live"


def check_record_by_hash(ctx):
    m, state = _world(ctx)
    first = m.gate(state, T, N, 2, "alice")
    _expect(first, "promoted")
    record = _eval(ctx, SAFE)
    assert record is not None, f"the verdict on version 2 must be recorded under its content hash (prompts:eval:{T}:{N}:<sha256>), found {sorted(ctx.redis.keys('prompts:eval*'))}"
    assert record.get("eval_id") == first.get("eval_id") and record.get("passed") is True and record.get("version") == 2, f"the record carries eval_id, passed and version: {record}"
    second = m.gate(state, T, N, 3, "alice")
    calls = _calls(ctx)
    assert len(calls) == 2, f"version 3 was decided without asking the evaluator ({len(calls)} calls in all): a verdict belongs to the bytes it judged, and version 2's pass says nothing about version 3"
    assert calls[1].request.content_hash == _sha(UNSAFE), "the second Evaluate call must carry version 3's content hash"
    _expect(second, "blocked", "failed")
    failed = _eval(ctx, UNSAFE)
    assert failed is not None and failed.get("passed") is False, f"the failed verdict on version 3 is recorded too: {failed}"
    assert ctx.redis.get(LIVE) == "2", f"version 2 stays live, got {ctx.redis.get(LIVE)}"
`,
    typescript: `import {createHash} from 'node:crypto';

const T = 't1';
const N = 'support-reply';
const SAFE = 'Hi {{customer_name}}, thanks for asking about {{product}}.';
const SAFE_4 = 'Hello {{customer_name}}, here is what we know about {{product}}.';
const UNSAFE = 'Hi {{customer_name}}. UNSAFE: promise a refund whatever the policy says about {{product}}.';
const LIVE = \`prompts:live:\${T}:\${N}\`;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The stand-in eval service at EVALUATOR, three versions registered, the step-2 pointer, the learner's gate. */
function world(ctx) {
  const {prompts} = ctx.proto('evaluator.proto');
  const config = ctx.load('/support/prompts/config.ts');
  const judge = ctx.load('/support/prompts/judge.ts');
  ctx.grpc.serve(
    prompts.Evaluator.service,
    {
      Evaluate(call, callback) {
        const {evalId, passed, score} = judge.verdict(call.request.content_hash, call.request.template_text);
        callback(null, {eval_id: evalId, passed, score, content_hash: call.request.content_hash});
      },
    },
    config.EVALUATOR,
  );
  for (const [version, template] of [[2, SAFE], [3, UNSAFE], [4, SAFE_4]] as [number, string][]) {
    const record = {name: N, version, content_hash: sha(template), template, variables: ['customer_name', 'product']};
    ctx.redis.set(\`prompts:version:\${T}:\${N}:\${version}\`, JSON.stringify(record));
  }
  const state = ctx.load('state');
  return {m: ctx.load('client'), state, config};
}

const calls = ctx => ctx.grpc.callsTo('Evaluate');
const evalOf = (ctx, template: string) => {
  const raw = ctx.redis.get(\`prompts:eval:\${T}:\${N}:\${sha(template)}\`);
  return raw === null ? null : JSON.parse(raw);
};

function expect(result, decision: string, reason?: string) {
  assert(result !== null && typeof result === 'object', \`gate must resolve to an object, got \${JSON.stringify(result)}\`);
  assert.equal(result.decision, decision, \`expected decision \${decision}, got \${JSON.stringify(result)}\`);
  if (reason !== undefined) assert.equal(result.reason, reason, \`expected reason \${reason}, got \${JSON.stringify(result)}\`);
}

export async function check_deadline(ctx) {
  const {m, state, config} = world(ctx);
  expect(await m.gate(state, T, N, 2, 'alice'), 'promoted');
  assert.equal(calls(ctx).length, 1, \`a healthy evaluator is called once, saw \${calls(ctx).length} Evaluate calls\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Evaluate call carries no deadline: a hung evaluator holds the promotion, and the operator waiting on it, open');
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the deadline must be DEADLINE_MS = 3000 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Evaluate', 5.0, config.EVALUATOR);
  const started = ctx.clock.now();
  const result = await m.gate(state, T, N, 4, 'alice');
  const waited = (ctx.clock.now() - started) / 1000;
  expect(result, 'blocked', 'deadline');
  assert.equal(calls(ctx).length, 4, \`an evaluator that hangs gets MAX_ATTEMPTS = 3 calls, each cut at the deadline: saw \${calls(ctx).length - 1}\`);
  assert(waited <= 11, \`the gate waited \${waited.toFixed(1)} s on a hung evaluator: three 3-second attempts and their backoffs end well before that\`);
  assert.equal(ctx.redis.get(LIVE), '2', \`a version nobody could evaluate went live: live is \${ctx.redis.get(LIVE)}\`);
}

export async function check_retry_policy(ctx) {
  const {m, state, config} = world(ctx);
  ctx.grpc.fail('Evaluate', ctx.grpc.status.UNAVAILABLE, 'evaluator restarting', 1, config.EVALUATOR);
  let result = await m.gate(state, T, N, 2, 'alice');
  expect(result, 'promoted');
  assert(result.attempts === 2 && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw \${calls(ctx).length} calls and \${JSON.stringify(result)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Evaluate', ctx.grpc.status.UNAVAILABLE, 'evaluator down', 3, config.EVALUATOR);
  result = await m.gate(state, T, N, 4, 'alice');
  expect(result, 'blocked', 'unavailable');
  assert(calls(ctx).length === 5 && result.attempts === 3, \`an evaluator that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls: saw \${calls(ctx).length - 2} calls, \${JSON.stringify(result)}\`);
  ctx.grpc.fail('Evaluate', ctx.grpc.status.INVALID_ARGUMENT, 'template too long for the suite', 1, config.EVALUATOR);
  result = await m.gate(state, T, N, 4, 'alice');
  expect(result, 'blocked', 'error');
  assert.equal(calls(ctx).length, 6, \`INVALID_ARGUMENT says the request is wrong, so a retry gets the same answer: saw \${calls(ctx).length - 5} calls\`);
}

export async function check_block_on_error(ctx) {
  const {m, state, config} = world(ctx);
  ctx.grpc.fail('Evaluate', ctx.grpc.status.INTERNAL, 'eval suite crashed', 1, config.EVALUATOR);
  let result = await m.gate(state, T, N, 2, 'alice');
  assert.equal(ctx.redis.get(LIVE), null, \`the eval suite crashed and version \${ctx.redis.get(LIVE)} went live anyway: an eval that did not run is not a pass\`);
  expect(result, 'blocked', 'error');
  ctx.grpc.stop(config.EVALUATOR);
  result = await m.gate(state, T, N, 2, 'alice');
  assert.equal(ctx.redis.get(LIVE), null, 'with the evaluator down the version went live: no verdict, no promotion');
  expect(result, 'blocked', 'unavailable');
}

export async function check_fail_terminal(ctx) {
  const {m, state} = world(ctx);
  const result = await m.gate(state, T, N, 3, 'alice');
  expect(result, 'blocked', 'failed');
  assert.equal(calls(ctx).length, 1, \`a failed verdict is an answer, not an outage: the gate asked \${calls(ctx).length} times, which is shopping for a pass\`);
  assert.equal(result.eval_id, \`ev-\${sha(UNSAFE).slice(0, 12)}\`, \`a blocked result names the eval that failed it, got \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.get(LIVE), null, 'a version that failed its eval went live');
}

export async function check_record_by_hash(ctx) {
  const {m, state} = world(ctx);
  const first = await m.gate(state, T, N, 2, 'alice');
  expect(first, 'promoted');
  const record = evalOf(ctx, SAFE);
  assert(record !== null, \`the verdict on version 2 must be recorded under its content hash (prompts:eval:\${T}:\${N}:<sha256>), found \${JSON.stringify(ctx.redis.keys('prompts:eval*'))}\`);
  assert(record.eval_id === first.eval_id && record.passed === true && record.version === 2, \`the record carries eval_id, passed and version: \${JSON.stringify(record)}\`);
  const second = await m.gate(state, T, N, 3, 'alice');
  assert.equal(calls(ctx).length, 2, \`version 3 was decided without asking the evaluator (\${calls(ctx).length} calls in all): a verdict belongs to the bytes it judged, and version 2's pass says nothing about version 3\`);
  assert.equal(calls(ctx)[1].request.content_hash, sha(UNSAFE), "the second Evaluate call must carry version 3's content hash");
  expect(second, 'blocked', 'failed');
  const failed = evalOf(ctx, UNSAFE);
  assert(failed !== null && failed.passed === false, \`the failed verdict on version 3 is recorded too: \${JSON.stringify(failed)}\`);
  assert.equal(ctx.redis.get(LIVE), '2', \`version 2 stays live, got \${ctx.redis.get(LIVE)}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"google.golang.org/grpc/codes"

	"prompts/config"
	pb "prompts/gen/evaluator"
	"prompts/judge"

	"leetbuild/harness"
)

const (
	gateTenant = "t1"
	gateName   = "support-reply"
	gateSafe   = "Hi {{customer_name}}, thanks for asking about {{product}}."
	gateSafe4  = "Hello {{customer_name}}, here is what we know about {{product}}."
	gateUnsafe = "Hi {{customer_name}}. UNSAFE: promise a refund whatever the policy says about {{product}}."
)

// evaluatorPeer is the stand-in eval service: verdicts from prompts/judge.
type evaluatorPeer struct {
	pb.UnimplementedEvaluatorServer
}

func (evaluatorPeer) Evaluate(_ context.Context, req *pb.EvaluateRequest) (*pb.EvaluateReply, error) {
	evalID, passed, score := judge.Verdict(req.GetContentHash(), req.GetTemplateText())
	return &pb.EvaluateReply{EvalId: evalID, Passed: passed, Score: score, ContentHash: req.GetContentHash()}, nil
}

// gatePointer stands in for the step-2 live pointer over the harness's Redis.
type gatePointer struct {
	ctx *harness.Ctx
}

func (p gatePointer) Promote(_ context.Context, tenant, name string, version int, actor string) (*Swap, error) {
	if p.ctx.Redis.Exists(config.VersionKey(tenant, name, version)) == 0 {
		return nil, nil
	}
	previous, ok := p.ctx.Redis.Get(config.LiveKey(tenant, name))
	if !ok {
		previous = "0"
	}
	p.ctx.Redis.Set(config.LiveKey(tenant, name), strconv.Itoa(version))
	p.ctx.Redis.Do("RPUSH", config.HistoryKey(tenant, name), version)
	p.ctx.Redis.Do("RPUSH", config.AuditKey(tenant, name), "promote|"+previous+"|"+strconv.Itoa(version)+"|"+actor+"|0")
	from, _ := strconv.Atoi(previous)
	return &Swap{From: from, To: version}, nil
}

func gateSha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func gateWorld(ctx *harness.Ctx) gatePointer {
	pb.RegisterEvaluatorServer(ctx.GRPC.Server(config.Evaluator), &evaluatorPeer{})
	for version, template := range map[int]string{2: gateSafe, 3: gateUnsafe, 4: gateSafe4} {
		record, _ := json.Marshal(map[string]any{"name": gateName, "version": version, "content_hash": gateSha(template), "template": template, "variables": []string{"customer_name", "product"}})
		ctx.Redis.Set(config.VersionKey(gateTenant, gateName, version), string(record))
	}
	return gatePointer{ctx: ctx}
}

func gateRun(ctx *harness.Ctx, state gatePointer, version int) GateResult {
	result, err := gate(context.Background(), state, gateTenant, gateName, version, "alice")
	ctx.NoError(err, "gate(%d)", version)
	return result
}

func gateCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Evaluate", "") }

func gateLive(ctx *harness.Ctx) string {
	live, _ := ctx.Redis.Get(config.LiveKey(gateTenant, gateName))
	return live
}

func gateExpect(ctx *harness.Ctx, result GateResult, decision, reason string) {
	ctx.Equal(result.Decision, decision, "the gate's decision (%+v)", result)
	if reason != "" {
		ctx.Equal(result.Reason, reason, "the gate's reason (%+v)", result)
	}
}

func gateEval(ctx *harness.Ctx, template string) map[string]any {
	raw, ok := ctx.Redis.Get(config.EvalKey(gateTenant, gateName, gateSha(template)))
	if !ok {
		return nil
	}
	var record map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &record), "the eval record is JSON: %s", raw)
	return record
}

func CheckDeadline(ctx *harness.Ctx) {
	state := gateWorld(ctx)
	gateExpect(ctx, gateRun(ctx, state, 2), "promoted", "")
	calls := gateCalls(ctx)
	ctx.Equal(len(calls), 1, "a healthy evaluator is called once; Evaluate calls")
	ctx.Assert(calls[0].HasDeadline(), "the Evaluate call carries no deadline: a hung evaluator holds the promotion, and the operator waiting on it, open")
	ctx.Assert(calls[0].Timeout.Seconds() >= 2.5 && calls[0].Timeout.Seconds() <= 3.5, "the deadline must be 3 s, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Evaluate", 5.0, config.Evaluator)
	started := ctx.Clock.Now()
	result := gateRun(ctx, state, 4)
	waited := float64(ctx.Clock.Now()-started) / 1000
	gateExpect(ctx, result, "blocked", "deadline")
	ctx.Equal(len(gateCalls(ctx)), 4, "an evaluator that hangs gets maxAttempts = 3 calls, each cut at the deadline; calls so far")
	ctx.Assert(waited <= 11, "the gate waited %.1f s on a hung evaluator: three 3-second attempts and their backoffs end well before that", waited)
	ctx.Equal(gateLive(ctx), "2", "a version nobody could evaluate must not go live; the live version")
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	state := gateWorld(ctx)
	ctx.GRPC.Fail("Evaluate", codes.Unavailable, "evaluator restarting", 1, config.Evaluator)
	result := gateRun(ctx, state, 2)
	gateExpect(ctx, result, "promoted", "")
	ctx.Assert(result.Attempts == 2 && len(gateCalls(ctx)) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and Attempts 2, saw %d calls and %+v", len(gateCalls(ctx)), result)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Evaluate", codes.Unavailable, "evaluator down", 3, config.Evaluator)
	result = gateRun(ctx, state, 4)
	gateExpect(ctx, result, "blocked", "unavailable")
	ctx.Assert(len(gateCalls(ctx)) == 5 && result.Attempts == 3, "an evaluator that stays UNAVAILABLE gets maxAttempts = 3 calls: saw %d calls, %+v", len(gateCalls(ctx))-2, result)
	ctx.GRPC.Fail("Evaluate", codes.InvalidArgument, "template too long for the suite", 1, config.Evaluator)
	result = gateRun(ctx, state, 4)
	gateExpect(ctx, result, "blocked", "error")
	ctx.Equal(len(gateCalls(ctx)), 6, "INVALID_ARGUMENT says the request is wrong, so a retry gets the same answer; calls so far")
}

func CheckBlockOnError(ctx *harness.Ctx) {
	state := gateWorld(ctx)
	ctx.GRPC.Fail("Evaluate", codes.Internal, "eval suite crashed", 1, config.Evaluator)
	result := gateRun(ctx, state, 2)
	ctx.Equal(gateLive(ctx), "", "the eval suite crashed: an eval that did not run is not a pass; the live version")
	gateExpect(ctx, result, "blocked", "error")
	ctx.GRPC.Stop(config.Evaluator)
	result = gateRun(ctx, state, 2)
	ctx.Equal(gateLive(ctx), "", "with the evaluator down: no verdict, no promotion; the live version")
	gateExpect(ctx, result, "blocked", "unavailable")
}

func CheckFailTerminal(ctx *harness.Ctx) {
	state := gateWorld(ctx)
	result := gateRun(ctx, state, 3)
	gateExpect(ctx, result, "blocked", "failed")
	ctx.Equal(len(gateCalls(ctx)), 1, "a failed verdict is an answer, not an outage: asking again is shopping for a pass; calls")
	ctx.Equal(result.EvalID, "ev-"+gateSha(gateUnsafe)[:12], "a blocked result names the eval that failed it")
	ctx.Equal(gateLive(ctx), "", "a version that failed its eval must not go live; the live version")
}

func CheckRecordByHash(ctx *harness.Ctx) {
	state := gateWorld(ctx)
	first := gateRun(ctx, state, 2)
	gateExpect(ctx, first, "promoted", "")
	record := gateEval(ctx, gateSafe)
	ctx.Assert(record != nil, "the verdict on version 2 must be recorded under its content hash (prompts:eval:%s:%s:<sha256>), found %v", gateTenant, gateName, ctx.Redis.Keys("prompts:eval*"))
	ctx.Assert(record["eval_id"] == first.EvalID && record["passed"] == true && record["version"] == float64(2), "the record carries eval_id, passed and version: %v", record)
	second := gateRun(ctx, state, 3)
	calls := gateCalls(ctx)
	ctx.Equal(len(calls), 2, "version 3 must be evaluated on its own bytes: a verdict belongs to the bytes it judged, and version 2's pass says nothing about version 3; Evaluate calls in all")
	request, _ := calls[1].Request.(*pb.EvaluateRequest)
	ctx.Assert(request != nil && request.GetContentHash() == gateSha(gateUnsafe), "the second Evaluate call must carry version 3's content hash")
	gateExpect(ctx, second, "blocked", "failed")
	failed := gateEval(ctx, gateUnsafe)
	ctx.Assert(failed != nil && failed["passed"] == false, "the failed verdict on version 3 is recorded too: %v", failed)
	ctx.Equal(gateLive(ctx), "2", "version 2 stays live")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "digest.h"
#include "prompts/judge.h"

namespace {

const std::string kT = "t1";
const std::string kN = "support-reply";
const std::string kSafe = "Hi {{customer_name}}, thanks for asking about {{product}}.";
const std::string kSafe4 = "Hello {{customer_name}}, here is what we know about {{product}}.";
const std::string kUnsafe = "Hi {{customer_name}}. UNSAFE: promise a refund whatever the policy says about {{product}}.";
const std::string kLive = "prompts:live:" + kT + ":" + kN;

// The stand-in eval service: verdicts from prompts/judge.h.
class EvaluatorPeer final : public prompts::Evaluator::Service {
 public:
  grpc::Status Evaluate(grpc::ServerContext*, const prompts::EvaluateRequest* req, prompts::EvaluateReply* reply) override {
    const auto v = judge::verdict(req->content_hash(), req->template_text());
    reply->set_eval_id(v.eval_id);
    reply->set_passed(v.passed);
    reply->set_score(v.score);
    reply->set_content_hash(req->content_hash());
    return grpc::Status::OK;
  }
};

// Stands in for the step-2 live pointer over the harness's Redis.
class GatePointer final : public Promoter {
 public:
  explicit GatePointer(harness::Ctx& ctx) : ctx_(ctx) {}

  std::optional<Swap> promote(const std::string& tenant, const std::string& name, int version, const std::string& actor) override {
    if (ctx_.Redis.Exists(config::version_key(tenant, name, version)) == 0) return std::nullopt;
    const std::string previous = ctx_.Redis.Get(config::live_key(tenant, name)).value_or("0");
    ctx_.Redis.Set(config::live_key(tenant, name), std::to_string(version));
    ctx_.Redis.Do("RPUSH", config::history_key(tenant, name), std::to_string(version));
    ctx_.Redis.Do("RPUSH", config::audit_key(tenant, name), "promote|" + previous + "|" + std::to_string(version) + "|" + actor + "|0");
    return Swap{std::stoi(previous), version};
  }

 private:
  harness::Ctx& ctx_;
};

struct World {
  EvaluatorPeer peer;
  GatePointer state;
  explicit World(harness::Ctx& ctx) : state(ctx) {}
};

World& gateWorld(harness::Ctx& ctx) {
  static World* world = nullptr;
  delete world;
  world = new World(ctx);
  ctx.GRPC.Server(config::kEvaluator)->RegisterService(&world->peer);
  const std::vector<std::pair<int, std::string>> registered = {{2, kSafe}, {3, kUnsafe}, {4, kSafe4}};
  for (const auto& [version, text] : registered) {
    const nlohmann::json record = {{"name", kN}, {"version", version}, {"content_hash", sha256_hex(text)}, {"template", text}, {"variables", {"customer_name", "product"}}};
    ctx.Redis.Set(config::version_key(kT, kN, version), record.dump());
  }
  return *world;
}

std::string liveNow(harness::Ctx& ctx) { return ctx.Redis.Get(kLive).value_or(""); }

void gateExpect(harness::Ctx& ctx, const GateResult& result, const std::string& decision, const std::string& reason = "") {
  ctx.Equal(result.decision, decision, "the gate's decision (reason %q, eval %q, attempts %d)", result.reason, result.eval_id, result.attempts);
  if (!reason.empty()) ctx.Equal(result.reason, reason, "the gate's reason");
}

std::optional<nlohmann::json> evalOf(harness::Ctx& ctx, const std::string& text) {
  const auto raw = ctx.Redis.Get(config::eval_key(kT, kN, sha256_hex(text)));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw, nullptr, false);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  auto& w = gateWorld(ctx);
  gateExpect(ctx, gate(w.state, kT, kN, 2, "alice"), "promoted");
  const auto calls = ctx.GRPC.CallsTo("Evaluate");
  ctx.Equal(calls.size(), 1, "a healthy evaluator is called once; Evaluate calls");
  ctx.Assert(calls[0].HasDeadline(), "the Evaluate call carries no deadline: a hung evaluator holds the promotion, and the operator waiting on it, open");
  ctx.Assert(2.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 3.5, "the deadline must be 3 s, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Evaluate", 5.0, config::kEvaluator);
  const int64_t started = ctx.Clock.Now();
  const GateResult result = gate(w.state, kT, kN, 4, "alice");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  gateExpect(ctx, result, "blocked", "deadline");
  ctx.Equal(ctx.GRPC.CallsTo("Evaluate").size(), 4, "an evaluator that hangs gets kMaxAttempts = 3 calls, each cut at the deadline; calls so far");
  ctx.Assert(waited <= 11, "the gate waited %.1f s on a hung evaluator: three 3-second attempts and their backoffs end well before that", waited);
  ctx.Equal(liveNow(ctx), "2", "a version nobody could evaluate must not go live; the live version");
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  auto& w = gateWorld(ctx);
  ctx.GRPC.Fail("Evaluate", grpc::StatusCode::UNAVAILABLE, "evaluator restarting", 1, config::kEvaluator);
  GateResult result = gate(w.state, kT, kN, 2, "alice");
  gateExpect(ctx, result, "promoted");
  ctx.Assert(result.attempts == 2 && ctx.GRPC.CallsTo("Evaluate").size() == 2, "one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw %d calls and attempts %d", ctx.GRPC.CallsTo("Evaluate").size(), result.attempts);
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Evaluate", grpc::StatusCode::UNAVAILABLE, "evaluator down", 3, config::kEvaluator);
  result = gate(w.state, kT, kN, 4, "alice");
  gateExpect(ctx, result, "blocked", "unavailable");
  ctx.Assert(ctx.GRPC.CallsTo("Evaluate").size() == 5 && result.attempts == 3, "an evaluator that stays UNAVAILABLE gets kMaxAttempts = 3 calls: saw %d calls, attempts %d", ctx.GRPC.CallsTo("Evaluate").size() - 2, result.attempts);
  ctx.GRPC.Fail("Evaluate", grpc::StatusCode::INVALID_ARGUMENT, "template too long for the suite", 1, config::kEvaluator);
  result = gate(w.state, kT, kN, 4, "alice");
  gateExpect(ctx, result, "blocked", "error");
  ctx.Equal(ctx.GRPC.CallsTo("Evaluate").size(), 6, "INVALID_ARGUMENT says the request is wrong, so a retry gets the same answer; calls so far");
}

void CheckBlockOnError(harness::Ctx& ctx) {
  auto& w = gateWorld(ctx);
  ctx.GRPC.Fail("Evaluate", grpc::StatusCode::INTERNAL, "eval suite crashed", 1, config::kEvaluator);
  GateResult result = gate(w.state, kT, kN, 2, "alice");
  ctx.Equal(liveNow(ctx), "", "the eval suite crashed: an eval that did not run is not a pass; the live version");
  gateExpect(ctx, result, "blocked", "error");
  ctx.GRPC.Stop(config::kEvaluator);
  result = gate(w.state, kT, kN, 2, "alice");
  ctx.Equal(liveNow(ctx), "", "with the evaluator down: no verdict, no promotion; the live version");
  gateExpect(ctx, result, "blocked", "unavailable");
}

void CheckFailTerminal(harness::Ctx& ctx) {
  auto& w = gateWorld(ctx);
  const GateResult result = gate(w.state, kT, kN, 3, "alice");
  gateExpect(ctx, result, "blocked", "failed");
  ctx.Equal(ctx.GRPC.CallsTo("Evaluate").size(), 1, "a failed verdict is an answer, not an outage: asking again is shopping for a pass; calls");
  ctx.Equal(result.eval_id, "ev-" + sha256_hex(kUnsafe).substr(0, 12), "a blocked result names the eval that failed it");
  ctx.Equal(liveNow(ctx), "", "a version that failed its eval must not go live; the live version");
}

void CheckRecordByHash(harness::Ctx& ctx) {
  auto& w = gateWorld(ctx);
  const GateResult first = gate(w.state, kT, kN, 2, "alice");
  gateExpect(ctx, first, "promoted");
  const auto record = evalOf(ctx, kSafe);
  ctx.Assert(record.has_value(), "the verdict on version 2 must be recorded under its content hash (prompts:eval:t1:support-reply:<sha256>), found %v", ctx.Redis.Keys("prompts:eval*"));
  ctx.Assert(record->value("eval_id", "") == first.eval_id && record->value("passed", false) && record->value("version", 0) == 2, "the record carries eval_id, passed and version: %s", record->dump());
  const GateResult second = gate(w.state, kT, kN, 3, "alice");
  const auto calls = ctx.GRPC.CallsTo("Evaluate");
  ctx.Equal(calls.size(), 2, "version 3 must be evaluated on its own bytes: a verdict belongs to the bytes it judged, and version 2's pass says nothing about version 3; Evaluate calls in all");
  ctx.Equal(calls[1].Request<prompts::EvaluateRequest>().content_hash(), sha256_hex(kUnsafe), "the second Evaluate call must carry version 3's content hash");
  gateExpect(ctx, second, "blocked", "failed");
  const auto failed = evalOf(ctx, kUnsafe);
  ctx.Assert(failed && failed->contains("passed") && (*failed)["passed"] == false, "the failed verdict on version 3 is recorded too");
  ctx.Equal(liveNow(ctx), "2", "version 2 stays live");
}
`,
  },
  hints: [
    'Symptom: an evaluator outage promotes everything, a hung evaluator parks the promotion for half a minute, an unsafe template is evaluated until the wall clock ends, and version 3 goes live on version 2’s verdict.',
    'Mechanism: the call has no deadline; the `except` branch sets `passed = True`; a failed verdict sleeps and asks again; the verdict is cached by `(tenant, name)` instead of recorded for the content hash the evaluator judged.',
    'Change: `timeout=DEADLINE_S` on each call; retry UNAVAILABLE and DEADLINE_EXCEEDED while `attempt < MAX_ATTEMPTS`, block on anything else; `evals.put` every verdict under the version’s content hash; block on `not reply.passed`; drop the name cache.',
  ],
  debrief: `One rule shapes the gate: only a verdict opens it. Transport failures are retried because they say nothing about the template, and bounded because an operator is waiting; a failed verdict is information, and asking again is shopping for a pass. Recording the verdict under the content hash makes the evidence addressable: the read in step 5 attaches exactly this record, and a new version, whose bytes differ, has none until it is judged. Gates in production also demand a minimum number of eval cases and per-slice scores before a pass counts, and they budget eval runs per name so a retry loop cannot spend the suite.`,
};
