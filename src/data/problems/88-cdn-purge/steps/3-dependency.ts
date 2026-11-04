import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'BatchPurge with a deadline, one batch id and per-path outcomes',
  concept: 'grpc',
  file: 'client',
  focus: ['purge', 'cdn', 'edges'],
  task: `## Task

**Starting point.** The starter's \`submit_batch(purge_id, domain, paths)\` hands a queued purge to the
CDN provider's \`BatchPurge\` RPC (\`cdn_purge.proto\`) up to \`MAX_ATTEMPTS\` = 3 times, minting a
\`batch_id\` per attempt from the purge id, sending every path each time, moving on after any
\`RpcError\`, and stopping once one path is \`accepted\`. It answers \`{batch_id, outcomes,
succeeded}\`. It purges a healthy provider's batch and hides four flaws.

**Failure mode the checks target.** A provider that hangs holds the purge worker forever; a retry
reaches the provider as a new batch and re-purges paths it already accepted; a refused request is
sent three times; and a purge with one accepted path out of thirty reports success.

- Every attempt carries a **2 s deadline** (\`DEADLINE_S\` = 2; \`DEADLINE_MS\` = 2000 in TypeScript).
- The \`batch_id\` is minted **once** per batch; each retry sends only the paths still pending.
- Per path, \`accepted\` and \`invalid_pattern\` are final; \`throttled\` stays pending. Only
  \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` (\`RETRYABLE\`) earn another attempt; any other status
  ends the batch.
- \`outcomes\` names every path: \`accepted\`, \`invalid_pattern\`, or \`failed\` (\`OUTCOME_FAILED\`)
  for whatever is still pending at the end; \`succeeded\` only when every path is \`accepted\`.

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 3}`,
  sequence: {
    participants: ['provider client', 'CDN provider'],
    messages: [
      {
        from: 'provider client',
        to: 'provider client',
        label: 'batch_id = purge_id:uuid (once) · pending = paths',
        kind: 'sync',
      },
      {
        from: 'provider client',
        to: 'CDN provider',
        label: 'BatchPurge(batch_id, pending, attempt 1) · 2 s deadline',
        kind: 'sync',
      },
      {
        from: 'CDN provider',
        to: 'provider client',
        label: 'accepted · invalid_pattern · throttled per path',
        kind: 'reply',
      },
      {
        from: 'provider client',
        to: 'CDN provider',
        label: 'attempt 2: same batch_id, throttled paths only',
        kind: 'sync',
      },
      {
        from: 'CDN provider',
        to: 'provider client',
        label: 'UNAVAILABLE / DEADLINE_EXCEEDED → retry · other codes → stop',
        kind: 'reply',
      },
      {
        from: 'provider client',
        to: 'provider client',
        label: 'still pending → failed · succeeded = all accepted',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt runs under a 2-second deadline',
      detail:
        'Each `BatchPurge` carries a deadline of about 2 s, so a provider that takes ten seconds costs three attempts of two seconds and leaves the paths `failed`. The starter calls with no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/, /2\s*\*\s*time\.Second|2000\s*\*\s*time\.Millisecond/]},
        scala: {all: [/DeadlineMs\s*=\s*2000L?/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/set_deadline\(/, /kDeadline\{2000\}|milliseconds\{?\(?2000|seconds\{?\(?2\b/]},
      },
    },
    {
      id: 'batch-id',
      title: 'One batch id for every attempt, and only pending paths resent',
      detail:
        'The `batch_id` is minted before the attempts and every retry sends only the paths not yet final, so the provider sees one batch and never re-purges an accepted path. The starter mints an id per attempt and resends everything.',
      match: {
        python: {order: [/batch_id\s*=/, /for\s+attempt\s+in/], all: [/patterns\s*=\s*pending/]},
        typescript: {order: [/batchId\s*=\s*`\$\{purgeId\}/, /for\s*\(\s*let attempt/], all: [/patterns:\s*pending/]},
        go: {order: [/batchID\s*:?=\s*purgeID\s*\+/, /for attempt\s*:=/], all: [/Patterns:\s*pending/]},
        scala: {
          order: [/batchId\s*=\s*s"\$purgeId:/, /while\s*\(/],
          all: [/BatchPurgeRequest\(batchId,\s*domain,\s*pending/],
        },
        cpp: {
          order: [/batch_id\s*=\s*purge_id\s*\+/, /for\s*\(int attempt/],
          all: [/:\s*pending\)\s*request\.add_patterns\(/],
        },
      },
    },
    {
      id: 'terminal',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        '`INVALID_ARGUMENT` or `FAILED_PRECONDITION` ends the batch after one call with every path `failed`; only the `RETRYABLE` codes earn another attempt. The starter retries every error.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/, /\.code\(\)\s+in\s+RETRYABLE/]},
        typescript: {all: [/status\.UNAVAILABLE/, /status\.DEADLINE_EXCEEDED/, /RETRYABLE\.(includes|has)\(/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /retryable\[status\.Code\(err\)\]/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /Status\.Code\.DEADLINE_EXCEEDED/, /Retryable\.contains\(/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/, /kRetryable\.count\(/]},
      },
    },
    {
      id: 'complete',
      title: 'Every path ends accepted, invalid_pattern or failed',
      detail:
        'A throttled path is retried until the attempts run out and then reported `failed`, an `invalid_pattern` is final, and `succeeded` holds only when every path is `accepted`. The starter stops at the first accepted path and reports success.',
      match: {
        python: {all: [/OUTCOME_FAILED\s*=\s*["']failed["']/, /\ball\(/], none: [/\bany\(/]},
        typescript: {all: [/OUTCOME_FAILED\s*=\s*['"]failed['"]/, /\.every\(/], none: [/\.some\(/]},
        go: {all: [/outcomeFailed\s*=\s*"failed"/, /!=\s*outcomeAccepted/]},
        scala: {all: [/OutcomeFailed\s*=\s*"failed"/, /\.forall\(/], none: [/\.exists\(/]},
        cpp: {all: [/kOutcomeFailed\s*=\s*"failed"/, /!=\s*kOutcomeAccepted|std::all_of\(/], none: [/std::any_of\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import cdn_purge_pb2
import cdn_purge_pb2_grpc

MAX_ATTEMPTS = 3

provider = cdn_purge_pb2_grpc.CdnProviderStub(grpc.insecure_channel("cdn-provider:9000"))


def submit_batch(purge_id: str, domain: str, paths: list[str]) -> dict:
    """Hand the purge's paths to the provider: the batch id, each path's outcome, and whether the batch succeeded."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    outcomes = {}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        batch_id = f"{purge_id}:{uuid.uuid4()}"
        try:
            reply = provider.BatchPurge(cdn_purge_pb2.BatchPurgeRequest(batch_id=batch_id, domain=domain, patterns=paths, attempt=attempt))
        except grpc.RpcError:
            continue  # the provider hiccuped: try again
        for result in reply.results:
            outcomes[result.pattern] = result.result
        if "accepted" in outcomes.values():
            break
    return {"batch_id": batch_id, "outcomes": outcomes, "succeeded": any(outcome == "accepted" for outcome in outcomes.values())}
`,
      solution: `import uuid

import grpc

import cdn_purge_pb2
import cdn_purge_pb2_grpc

MAX_ATTEMPTS = 3
DEADLINE_S = 2
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
OUTCOME_ACCEPTED = "accepted"
OUTCOME_INVALID_PATTERN = "invalid_pattern"
OUTCOME_FAILED = "failed"

provider = cdn_purge_pb2_grpc.CdnProviderStub(grpc.insecure_channel("cdn-provider:9000"))


def submit_batch(purge_id: str, domain: str, paths: list[str]) -> dict:
    """Hand the purge's paths to the provider: the batch id, each path's outcome, and whether the batch succeeded."""
    batch_id = f"{purge_id}:{uuid.uuid4()}"  # minted once: every attempt is the same batch to the provider
    final = {}
    pending = list(paths)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if not pending:
            break
        try:
            reply = provider.BatchPurge(
                cdn_purge_pb2.BatchPurgeRequest(batch_id=batch_id, domain=domain, patterns=pending, attempt=attempt),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() in RETRYABLE:
                continue
            break  # the provider refuses this request: asking again gets the same answer
        results = {result.pattern: result.result for result in reply.results}
        for path in pending:
            if results.get(path) in (OUTCOME_ACCEPTED, OUTCOME_INVALID_PATTERN):
                final[path] = results[path]
        pending = [path for path in pending if path not in final]  # throttled or unanswered: send again
    outcomes = {path: final.get(path, OUTCOME_FAILED) for path in paths}
    return {"batch_id": batch_id, "outcomes": outcomes, "succeeded": all(outcome == OUTCOME_ACCEPTED for outcome in outcomes.values())}
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const MAX_ATTEMPTS = 3;

interface BatchPurgeRequest {
  batch_id: string;
  domain: string;
  patterns: string[];
  attempt: number;
}

interface BatchPurgeReply {
  results: {pattern: string; result: string}[];
}

export interface BatchResult {
  batch_id: string;
  outcomes: Record<string, string>;
  succeeded: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdn_purge.proto')) as unknown as {
  cdnpurge: {CdnProvider: grpc.ServiceClientConstructor};
};
const provider = new pkg.cdnpurge.CdnProvider('cdn-provider:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  BatchPurge(request: BatchPurgeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<BatchPurgeReply>;
};

/** Hand the purge's paths to the provider: the batch id, each path's outcome, and whether the batch succeeded. */
export async function submitBatch(purgeId: string, domain: string, paths: string[]): Promise<BatchResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const outcomes: Record<string, string> = {};
  let batchId = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    batchId = \`\${purgeId}:\${randomUUID()}\`;
    let reply: BatchPurgeReply;
    try {
      reply = await provider.BatchPurge({batch_id: batchId, domain, patterns: paths, attempt}, new grpc.Metadata(), {});
    } catch {
      continue; // the provider hiccuped: try again
    }
    for (const {pattern, result} of reply.results) outcomes[pattern] = result;
    if (Object.values(outcomes).includes('accepted')) break;
  }
  return {batch_id: batchId, outcomes, succeeded: Object.values(outcomes).some(outcome => outcome === 'accepted')};
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const MAX_ATTEMPTS = 3;
export const DEADLINE_MS = 2000;
export const RETRYABLE: grpc.status[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
export const OUTCOME_ACCEPTED = 'accepted';
export const OUTCOME_INVALID_PATTERN = 'invalid_pattern';
export const OUTCOME_FAILED = 'failed';

interface BatchPurgeRequest {
  batch_id: string;
  domain: string;
  patterns: string[];
  attempt: number;
}

interface BatchPurgeReply {
  results: {pattern: string; result: string}[];
}

export interface BatchResult {
  batch_id: string;
  outcomes: Record<string, string>;
  succeeded: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdn_purge.proto')) as unknown as {
  cdnpurge: {CdnProvider: grpc.ServiceClientConstructor};
};
const provider = new pkg.cdnpurge.CdnProvider('cdn-provider:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  BatchPurge(request: BatchPurgeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<BatchPurgeReply>;
};

/** Hand the purge's paths to the provider: the batch id, each path's outcome, and whether the batch succeeded. */
export async function submitBatch(purgeId: string, domain: string, paths: string[]): Promise<BatchResult> {
  const batchId = \`\${purgeId}:\${randomUUID()}\`; // minted once: every attempt is the same batch to the provider
  const final = new Map<string, string>();
  let pending = [...paths];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
    let reply: BatchPurgeReply;
    try {
      reply = await provider.BatchPurge({batch_id: batchId, domain, patterns: pending, attempt}, new grpc.Metadata(), {
        deadline: Date.now() + DEADLINE_MS,
      });
    } catch (e) {
      if (RETRYABLE.includes((e as grpc.ServiceError).code)) continue;
      break; // the provider refuses this request: asking again gets the same answer
    }
    for (const {pattern, result} of reply.results) {
      if (pending.includes(pattern) && (result === OUTCOME_ACCEPTED || result === OUTCOME_INVALID_PATTERN)) final.set(pattern, result);
    }
    pending = pending.filter(path => !final.has(path)); // throttled or unanswered: send again
  }
  const outcomes = Object.fromEntries(paths.map(path => [path, final.get(path) ?? OUTCOME_FAILED]));
  return {batch_id: batchId, outcomes, succeeded: paths.every(path => outcomes[path] === OUTCOME_ACCEPTED)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "purge/gen/cdn_purge"
)

const maxAttempts = 3

var (
	providerConn, _ = grpc.NewClient("cdn-provider:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	provider        = pb.NewCdnProviderClient(providerConn)
)

// BatchResult is what became of a batch: its id, each path's outcome, and whether it succeeded.
type BatchResult struct {
	BatchID   string
	Outcomes  map[string]string
	Succeeded bool
}

// submitBatch hands the purge's paths to the provider.
func submitBatch(ctx context.Context, purgeID, domain string, paths []string) BatchResult {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	outcomes := map[string]string{}
	var batchID string
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		batchID = purgeID + ":" + uuid.NewString()
		reply, err := provider.BatchPurge(ctx, &pb.BatchPurgeRequest{BatchId: batchID, Domain: domain, Patterns: paths, Attempt: int32(attempt)})
		if err != nil {
			continue // the provider hiccuped: try again
		}
		for _, result := range reply.GetResults() {
			outcomes[result.GetPattern()] = result.GetResult()
		}
		if anyAccepted(outcomes) {
			break
		}
	}
	return BatchResult{BatchID: batchID, Outcomes: outcomes, Succeeded: anyAccepted(outcomes)}
}

func anyAccepted(outcomes map[string]string) bool {
	for _, outcome := range outcomes {
		if outcome == "accepted" {
			return true
		}
	}
	return false
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "purge/gen/cdn_purge"
)

const (
	maxAttempts           = 3
	deadline              = 2 * time.Second
	outcomeAccepted       = "accepted"
	outcomeInvalidPattern = "invalid_pattern"
	outcomeFailed         = "failed"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	providerConn, _ = grpc.NewClient("cdn-provider:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	provider        = pb.NewCdnProviderClient(providerConn)
)

// BatchResult is what became of a batch: its id, each path's outcome, and whether it succeeded.
type BatchResult struct {
	BatchID   string
	Outcomes  map[string]string
	Succeeded bool
}

// submitBatch hands the purge's paths to the provider.
func submitBatch(ctx context.Context, purgeID, domain string, paths []string) BatchResult {
	batchID := purgeID + ":" + uuid.NewString() // minted once: every attempt is the same batch to the provider
	final := map[string]string{}
	pending := append([]string{}, paths...)
	for attempt := 1; attempt <= maxAttempts && len(pending) > 0; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := provider.BatchPurge(callCtx, &pb.BatchPurgeRequest{BatchId: batchID, Domain: domain, Patterns: pending, Attempt: int32(attempt)})
		cancel()
		if err != nil {
			if retryable[status.Code(err)] {
				continue
			}
			break // the provider refuses this request: asking again gets the same answer
		}
		results := map[string]string{}
		for _, result := range reply.GetResults() {
			results[result.GetPattern()] = result.GetResult()
		}
		var still []string
		for _, path := range pending {
			if r := results[path]; r == outcomeAccepted || r == outcomeInvalidPattern {
				final[path] = r
			} else {
				still = append(still, path) // throttled or unanswered: send again
			}
		}
		pending = still
	}
	res := BatchResult{BatchID: batchID, Outcomes: map[string]string{}, Succeeded: true}
	for _, path := range paths {
		outcome, ok := final[path]
		if !ok {
			outcome = outcomeFailed
		}
		res.Outcomes[path] = outcome
		if outcome != outcomeAccepted {
			res.Succeeded = false
		}
	}
	return res
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import cdnpurge.cdn_purge.{BatchPurgeRequest, CdnProviderGrpc}

/** What became of a batch: its id, each path's outcome, and whether it succeeded. */
final case class BatchResult(batchId: String, outcomes: Map[String, String], succeeded: Boolean)

object ProviderClient {
  val MaxAttempts = 3

  private val provider = CdnProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("cdn-provider", 9000).usePlaintext().build())

  /** Hand the purge's paths to the provider. */
  def submitBatch(purgeId: String, domain: String, paths: Seq[String]): BatchResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val outcomes = scala.collection.mutable.Map.empty[String, String]
    var batchId = ""
    var attempt = 1
    while (attempt <= MaxAttempts && !outcomes.values.toSeq.contains("accepted")) {
      batchId = s"$purgeId:\${UUID.randomUUID()}"
      try {
        val reply = provider.batchPurge(BatchPurgeRequest(batchId, domain, paths, attempt))
        reply.results.foreach(r => outcomes(r.pattern) = r.result)
      } catch {
        case _: StatusRuntimeException => () // the provider hiccuped: try again
      }
      attempt += 1
    }
    BatchResult(batchId, outcomes.toMap, outcomes.values.exists(_ == "accepted"))
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import cdnpurge.cdn_purge.{BatchPurgeRequest, CdnProviderGrpc}

/** What became of a batch: its id, each path's outcome, and whether it succeeded. */
final case class BatchResult(batchId: String, outcomes: Map[String, String], succeeded: Boolean)

object ProviderClient {
  val MaxAttempts = 3
  val DeadlineMs = 2000L
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val OutcomeAccepted = "accepted"
  val OutcomeInvalidPattern = "invalid_pattern"
  val OutcomeFailed = "failed"

  private val provider = CdnProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("cdn-provider", 9000).usePlaintext().build())

  /** Hand the purge's paths to the provider. */
  def submitBatch(purgeId: String, domain: String, paths: Seq[String]): BatchResult = {
    val batchId = s"$purgeId:\${UUID.randomUUID()}" // minted once: every attempt is the same batch to the provider
    val decided = scala.collection.mutable.Map.empty[String, String]
    var pending = paths
    var attempt = 1
    var refused = false
    while (attempt <= MaxAttempts && pending.nonEmpty && !refused) {
      try {
        val reply = provider.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).batchPurge(BatchPurgeRequest(batchId, domain, pending, attempt))
        reply.results.foreach { r =>
          if (pending.contains(r.pattern) && (r.result == OutcomeAccepted || r.result == OutcomeInvalidPattern)) decided(r.pattern) = r.result
        }
        pending = pending.filterNot(decided.contains) // throttled or unanswered: send again
      } catch {
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) => ()
        case _: StatusRuntimeException => refused = true // asking again gets the same answer
      }
      attempt += 1
    }
    val outcomes = paths.map(path => path -> decided.getOrElse(path, OutcomeFailed)).toMap
    BatchResult(batchId, outcomes, outcomes.values.forall(_ == OutcomeAccepted))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <uuid/uuid.h>

#include <map>
#include <string>
#include <vector>

#include "cdn_purge.grpc.pb.h"

constexpr int kMaxAttempts = 3;

auto provider = cdnpurge::CdnProvider::NewStub(grpc::CreateChannel("cdn-provider:9000", grpc::InsecureChannelCredentials()));

// What became of a batch: its id, each path's outcome, and whether it succeeded.
struct BatchResult {
  std::string batch_id;
  std::map<std::string, std::string> outcomes;
  bool succeeded = false;
};

std::string newUuid() {
  uuid_t raw;
  uuid_generate_random(raw);
  char text[37];
  uuid_unparse_lower(raw, text);
  return text;
}

bool anyAccepted(const std::map<std::string, std::string>& outcomes) {
  for (const auto& [path, outcome] : outcomes) {
    if (outcome == "accepted") return true;
  }
  return false;
}

// Hand the purge's paths to the provider.
BatchResult submitBatch(const std::string& purge_id, const std::string& domain, const std::vector<std::string>& paths) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  BatchResult out;
  for (int attempt = 1; attempt <= kMaxAttempts && !anyAccepted(out.outcomes); attempt++) {
    out.batch_id = purge_id + ":" + newUuid();
    grpc::ClientContext ctx;
    cdnpurge::BatchPurgeRequest request;
    request.set_batch_id(out.batch_id);
    request.set_domain(domain);
    for (const auto& path : paths) request.add_patterns(path);
    request.set_attempt(attempt);
    cdnpurge::BatchPurgeReply reply;
    if (!provider->BatchPurge(&ctx, request, &reply).ok()) continue;  // the provider hiccuped: try again
    for (const auto& result : reply.results()) out.outcomes[result.pattern()] = result.result();
  }
  out.succeeded = anyAccepted(out.outcomes);
  return out;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <uuid/uuid.h>

#include <chrono>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "cdn_purge.grpc.pb.h"

constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kDeadline{2000};
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};
const std::string kOutcomeAccepted = "accepted";
const std::string kOutcomeInvalidPattern = "invalid_pattern";
const std::string kOutcomeFailed = "failed";

auto provider = cdnpurge::CdnProvider::NewStub(grpc::CreateChannel("cdn-provider:9000", grpc::InsecureChannelCredentials()));

// What became of a batch: its id, each path's outcome, and whether it succeeded.
struct BatchResult {
  std::string batch_id;
  std::map<std::string, std::string> outcomes;
  bool succeeded = false;
};

std::string newUuid() {
  uuid_t raw;
  uuid_generate_random(raw);
  char text[37];
  uuid_unparse_lower(raw, text);
  return text;
}

// Hand the purge's paths to the provider.
BatchResult submitBatch(const std::string& purge_id, const std::string& domain, const std::vector<std::string>& paths) {
  const std::string batch_id = purge_id + ":" + newUuid();  // minted once: every attempt is the same batch to the provider
  std::map<std::string, std::string> decided;
  std::vector<std::string> pending = paths;
  for (int attempt = 1; attempt <= kMaxAttempts && !pending.empty(); attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    cdnpurge::BatchPurgeRequest request;
    request.set_batch_id(batch_id);
    request.set_domain(domain);
    for (const auto& path : pending) request.add_patterns(path);
    request.set_attempt(attempt);
    cdnpurge::BatchPurgeReply reply;
    const grpc::Status status = provider->BatchPurge(&ctx, request, &reply);
    if (!status.ok()) {
      if (kRetryable.count(status.error_code())) continue;
      break;  // the provider refuses this request: asking again gets the same answer
    }
    std::map<std::string, std::string> results;
    for (const auto& result : reply.results()) results[result.pattern()] = result.result();
    std::vector<std::string> still;
    for (const auto& path : pending) {
      const std::string result = results[path];
      if (result == kOutcomeAccepted || result == kOutcomeInvalidPattern) {
        decided[path] = result;
      } else {
        still.push_back(path);  // throttled or unanswered: send again
      }
    }
    pending = still;
  }
  BatchResult out{batch_id, {}, true};
  for (const auto& path : paths) {
    const std::string outcome = decided.count(path) ? decided[path] : kOutcomeFailed;
    out.outcomes[path] = outcome;
    if (outcome != kOutcomeAccepted) out.succeeded = false;
  }
  return out;
}
`,
    },
  },
  harness: {
    python: `import grpc

import cdn_purge_pb2
import cdn_purge_pb2_grpc

DOMAIN = "shop.example.com"


class Provider(cdn_purge_pb2_grpc.CdnProviderServicer):
    """Accepts every pattern but a malformed one (with "[") and /hot, which it throttles every time; a pattern in throttle_once is throttled on its first arrival."""

    def __init__(self):
        self.throttle_once = set()

    def BatchPurge(self, request, context):
        results = []
        for pattern in request.patterns:
            if "[" in pattern:
                result = "invalid_pattern"
            elif pattern == "/hot":
                result = "throttled"
            elif pattern in self.throttle_once:
                self.throttle_once.discard(pattern)
                result = "throttled"
            else:
                result = "accepted"
            results.append(cdn_purge_pb2.PathResult(pattern=pattern, result=result))
        return cdn_purge_pb2.BatchPurgeReply(results=results)


def _client(ctx):
    provider = Provider()
    ctx.grpc.serve(cdn_purge_pb2_grpc.add_CdnProviderServicer_to_server, provider)
    return ctx.load("client"), provider


def _sent(ctx):
    return [list(call.request.patterns) for call in ctx.grpc.calls_to("BatchPurge")]


def check_deadline(ctx):
    m, _ = _client(ctx)
    healthy = m.submit_batch("pg-1", DOMAIN, ["/pricing"])
    assert healthy["succeeded"] and healthy["outcomes"] == {"/pricing": "accepted"}, f"a healthy provider's batch answered {healthy}"
    for call in ctx.grpc.calls_to("BatchPurge"):
        assert call.timeout is not None, "a BatchPurge call carries no deadline: a provider that hangs holds the purge worker forever"
        assert 1.5 <= call.timeout <= 2.5, f"a BatchPurge call carries a {call.timeout} s deadline, expected DEADLINE_S = 2"
    ctx.grpc.set_latency("BatchPurge", 10.0)
    before = ctx.clock.time()
    slow = m.submit_batch("pg-2", DOMAIN, ["/pricing"])
    took = ctx.clock.time() - before
    assert took <= 7, f"submit_batch against a provider that takes 10 s spent {took:.0f} s: three attempts of 2 s each is the bound"
    assert slow["outcomes"] == {"/pricing": "failed"} and slow["succeeded"] is False, f"a batch whose every attempt timed out answered {slow}, expected /pricing failed"
    assert len(ctx.grpc.calls_to("BatchPurge")) == 4, f"a deadline is retryable: expected 3 attempts for the slow batch, the provider saw {len(ctx.grpc.calls_to('BatchPurge')) - 1}"


def check_batch_id(ctx):
    m, provider = _client(ctx)
    ctx.grpc.fail("BatchPurge", grpc.StatusCode.UNAVAILABLE, "connection reset")
    provider.throttle_once.add("/b")
    res = m.submit_batch("pg-1", DOMAIN, ["/a", "/b"])
    ids = sorted({call.request.batch_id for call in ctx.grpc.calls_to("BatchPurge")})
    assert len(ids) == 1, f"the attempts of one batch carried batch ids {ids}: to the provider every retry is a new batch, and it purges again what it already accepted"
    assert res["batch_id"] == ids[0], f"submit_batch answered batch id {res['batch_id']!r}, the provider saw {ids[0]!r}"
    assert _sent(ctx) == [["/a", "/b"], ["/a", "/b"], ["/b"]], f"the attempts sent {_sent(ctx)}: after /a was accepted a retry carries only the pending /b"
    assert res["succeeded"] and res["outcomes"] == {"/a": "accepted", "/b": "accepted"}, f"the batch answered {res}"


def check_terminal(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("BatchPurge", grpc.StatusCode.INVALID_ARGUMENT, "domain is not configured on this service")
    refused = m.submit_batch("pg-1", DOMAIN, ["/pricing", "/about"])
    calls = len(ctx.grpc.calls_to("BatchPurge"))
    assert calls == 1, f"INVALID_ARGUMENT was answered with {calls} calls: a refused request gets the same answer every time, retrying it only loads the provider"
    assert refused["outcomes"] == {"/pricing": "failed", "/about": "failed"} and refused["succeeded"] is False, f"a refused batch answered {refused}, expected every path failed"
    ctx.grpc.fail("BatchPurge", grpc.StatusCode.FAILED_PRECONDITION, "purging is paused for this service")
    m.submit_batch("pg-2", DOMAIN, ["/pricing"])
    assert len(ctx.grpc.calls_to("BatchPurge")) == 2, "FAILED_PRECONDITION is terminal too: one call"
    ctx.grpc.fail("BatchPurge", grpc.StatusCode.UNAVAILABLE, "connection reset")
    retried = m.submit_batch("pg-3", DOMAIN, ["/pricing"])
    assert retried["succeeded"], f"UNAVAILABLE is retryable and the second attempt reaches a healthy provider, the batch answered {retried}"


def check_complete(ctx):
    m, _ = _client(ctx)
    res = m.submit_batch("pg-1", DOMAIN, ["/a", "/b[", "/hot"])
    assert res["outcomes"] == {"/a": "accepted", "/b[": "invalid_pattern", "/hot": "failed"}, f"the batch answered outcomes {res['outcomes']}: /a accepted, /b[ invalid_pattern, and /hot, throttled on every attempt, failed"
    assert res["succeeded"] is False, "a batch with an invalid pattern and a failed path reported success"
    sent = _sent(ctx)
    assert sum("/b[" in patterns for patterns in sent) == 1, f"the attempts sent {sent}: invalid_pattern is final, resending it changes nothing"
    assert len(sent) == 3, f"/hot was throttled every time and must be tried MAX_ATTEMPTS = 3 times, the provider saw {len(sent)} calls"
    clean = m.submit_batch("pg-2", DOMAIN, ["/x", "/y"])
    assert clean["succeeded"] and clean["outcomes"] == {"/x": "accepted", "/y": "accepted"}, f"a batch the provider accepts whole answered {clean}"
`,
    typescript: `const DOMAIN = 'shop.example.com';

/** Accepts every pattern but a malformed one (with "[") and /hot, which it throttles every time; a pattern in throttleOnce is throttled on its first arrival. */
function client(ctx) {
  const pkg = ctx.proto('cdn_purge.proto');
  const throttleOnce = new Set<string>();
  ctx.grpc.serve(pkg.cdnpurge.CdnProvider.service, {
    BatchPurge(call, callback) {
      const results = (call.request.patterns as string[]).map(pattern => {
        let result = 'accepted';
        if (pattern.includes('[')) result = 'invalid_pattern';
        else if (pattern === '/hot') result = 'throttled';
        else if (throttleOnce.delete(pattern)) result = 'throttled';
        return {pattern, result};
      });
      callback(null, {results});
    },
  });
  return {m: ctx.load('client'), throttleOnce};
}

const sent = ctx => ctx.grpc.callsTo('BatchPurge').map(call => [...call.request.patterns]);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const healthy = await m.submitBatch('pg-1', DOMAIN, ['/pricing']);
  assert(healthy.succeeded && JSON.stringify(healthy.outcomes) === '{"/pricing":"accepted"}', \`a healthy provider's batch answered \${JSON.stringify(healthy)}\`);
  for (const call of ctx.grpc.callsTo('BatchPurge')) {
    assert(call.timeout !== null, 'a BatchPurge call carries no deadline: a provider that hangs holds the purge worker forever');
    assert(1.5 <= call.timeout && call.timeout <= 2.5, \`a BatchPurge call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 2000\`);
  }
  ctx.grpc.setLatency('BatchPurge', 10.0);
  const before = ctx.clock.now();
  const slow = await m.submitBatch('pg-2', DOMAIN, ['/pricing']);
  const took = (ctx.clock.now() - before) / 1000;
  assert(took <= 7, \`submitBatch against a provider that takes 10 s spent \${took.toFixed(0)} s: three attempts of 2 s each is the bound\`);
  assert(JSON.stringify(slow.outcomes) === '{"/pricing":"failed"}' && slow.succeeded === false, \`a batch whose every attempt timed out answered \${JSON.stringify(slow)}, expected /pricing failed\`);
  assert.equal(ctx.grpc.callsTo('BatchPurge').length, 4, 'a deadline is retryable: expected 3 attempts for the slow batch');
}

export async function check_batch_id(ctx) {
  const {m, throttleOnce} = client(ctx);
  ctx.grpc.fail('BatchPurge', ctx.grpc.status.UNAVAILABLE, 'connection reset');
  throttleOnce.add('/b');
  const res = await m.submitBatch('pg-1', DOMAIN, ['/a', '/b']);
  const ids = [...new Set(ctx.grpc.callsTo('BatchPurge').map(call => call.request.batch_id))];
  assert.equal(ids.length, 1, \`the attempts of one batch carried batch ids \${JSON.stringify(ids)}: to the provider every retry is a new batch, and it purges again what it already accepted\`);
  assert.equal(res.batch_id, ids[0], \`submitBatch answered batch id \${res.batch_id}, the provider saw \${ids[0]}\`);
  assert.deepEqual(sent(ctx), [['/a', '/b'], ['/a', '/b'], ['/b']], \`the attempts sent \${JSON.stringify(sent(ctx))}: after /a was accepted a retry carries only the pending /b\`);
  assert(res.succeeded && JSON.stringify(res.outcomes) === '{"/a":"accepted","/b":"accepted"}', \`the batch answered \${JSON.stringify(res)}\`);
}

export async function check_terminal(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('BatchPurge', ctx.grpc.status.INVALID_ARGUMENT, 'domain is not configured on this service');
  const refused = await m.submitBatch('pg-1', DOMAIN, ['/pricing', '/about']);
  const calls = ctx.grpc.callsTo('BatchPurge').length;
  assert.equal(calls, 1, \`INVALID_ARGUMENT was answered with \${calls} calls: a refused request gets the same answer every time, retrying it only loads the provider\`);
  assert(JSON.stringify(refused.outcomes) === '{"/pricing":"failed","/about":"failed"}' && refused.succeeded === false, \`a refused batch answered \${JSON.stringify(refused)}, expected every path failed\`);
  ctx.grpc.fail('BatchPurge', ctx.grpc.status.FAILED_PRECONDITION, 'purging is paused for this service');
  await m.submitBatch('pg-2', DOMAIN, ['/pricing']);
  assert.equal(ctx.grpc.callsTo('BatchPurge').length, 2, 'FAILED_PRECONDITION is terminal too: one call');
  ctx.grpc.fail('BatchPurge', ctx.grpc.status.UNAVAILABLE, 'connection reset');
  const retried = await m.submitBatch('pg-3', DOMAIN, ['/pricing']);
  assert(retried.succeeded, \`UNAVAILABLE is retryable and the second attempt reaches a healthy provider, the batch answered \${JSON.stringify(retried)}\`);
}

export async function check_complete(ctx) {
  const {m} = client(ctx);
  const res = await m.submitBatch('pg-1', DOMAIN, ['/a', '/b[', '/hot']);
  assert.deepEqual(res.outcomes, {'/a': 'accepted', '/b[': 'invalid_pattern', '/hot': 'failed'}, \`the batch answered outcomes \${JSON.stringify(res.outcomes)}: /a accepted, /b[ invalid_pattern, and /hot, throttled on every attempt, failed\`);
  assert.equal(res.succeeded, false, 'a batch with an invalid pattern and a failed path reported success');
  const patterns = sent(ctx);
  assert.equal(patterns.filter(p => p.includes('/b[')).length, 1, \`the attempts sent \${JSON.stringify(patterns)}: invalid_pattern is final, resending it changes nothing\`);
  assert.equal(patterns.length, 3, \`/hot was throttled every time and must be tried MAX_ATTEMPTS = 3 times, the provider saw \${patterns.length} calls\`);
  const clean = await m.submitBatch('pg-2', DOMAIN, ['/x', '/y']);
  assert(clean.succeeded && JSON.stringify(clean.outcomes) === '{"/x":"accepted","/y":"accepted"}', \`a batch the provider accepts whole answered \${JSON.stringify(clean)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	pb "purge/gen/cdn_purge"

	"leetbuild/harness"
)

const clientDomain = "shop.example.com"

var clientBg = context.Background()

// providerPeer accepts every pattern but a malformed one (with "[") and /hot, which it throttles
// every time; a pattern in throttleOnce is throttled on its first arrival.
type providerPeer struct {
	pb.UnimplementedCdnProviderServer
	throttleOnce map[string]bool
}

func (p *providerPeer) BatchPurge(_ context.Context, req *pb.BatchPurgeRequest) (*pb.BatchPurgeReply, error) {
	reply := &pb.BatchPurgeReply{}
	for _, pattern := range req.GetPatterns() {
		result := "accepted"
		switch {
		case strings.Contains(pattern, "["):
			result = "invalid_pattern"
		case pattern == "/hot":
			result = "throttled"
		case p.throttleOnce[pattern]:
			delete(p.throttleOnce, pattern)
			result = "throttled"
		}
		reply.Results = append(reply.Results, &pb.PathResult{Pattern: pattern, Result: result})
	}
	return reply, nil
}

func providerFor(ctx *harness.Ctx) *providerPeer {
	peer := &providerPeer{throttleOnce: map[string]bool{}}
	pb.RegisterCdnProviderServer(ctx.GRPC.Server(""), peer)
	return peer
}

func sentPatterns(ctx *harness.Ctx) [][]string {
	var out [][]string
	for _, call := range ctx.GRPC.CallsTo("BatchPurge", "") {
		out = append(out, append([]string{}, call.Request.(*pb.BatchPurgeRequest).GetPatterns()...))
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	providerFor(ctx)
	healthy := submitBatch(clientBg, "pg-1", clientDomain, []string{"/pricing"})
	ctx.Assert(healthy.Succeeded && healthy.Outcomes["/pricing"] == "accepted", "a healthy provider's batch answered %+v", healthy)
	for _, call := range ctx.GRPC.CallsTo("BatchPurge", "") {
		ctx.Assert(call.HasDeadline(), "a BatchPurge call carries no deadline: a provider that hangs holds the purge worker forever")
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a BatchPurge call carries a %v deadline, expected 2 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("BatchPurge", 10.0, "")
	before := ctx.Clock.Now()
	slow := submitBatch(clientBg, "pg-2", clientDomain, []string{"/pricing"})
	took := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(took <= 7, "submitBatch against a provider that takes 10 s spent %.0f s: three attempts of 2 s each is the bound", took)
	ctx.Assert(!slow.Succeeded && slow.Outcomes["/pricing"] == "failed", "a batch whose every attempt timed out answered %+v, expected /pricing failed", slow)
	ctx.Equal(len(ctx.GRPC.CallsTo("BatchPurge", "")), 4, "a deadline is retryable: the healthy call plus 3 attempts for the slow batch; the calls")
}

func CheckBatchId(ctx *harness.Ctx) {
	peer := providerFor(ctx)
	ctx.GRPC.Fail("BatchPurge", codes.Unavailable, "connection reset", 1, "")
	peer.throttleOnce["/b"] = true
	res := submitBatch(clientBg, "pg-1", clientDomain, []string{"/a", "/b"})
	ids := map[string]bool{}
	for _, call := range ctx.GRPC.CallsTo("BatchPurge", "") {
		ids[call.Request.(*pb.BatchPurgeRequest).GetBatchId()] = true
	}
	ctx.Assert(len(ids) == 1, "the attempts of one batch carried batch ids %v: to the provider every retry is a new batch, and it purges again what it already accepted", ids)
	ctx.Assert(ids[res.BatchID], "submitBatch answered batch id %q, the provider saw %v", res.BatchID, ids)
	ctx.Equal(sentPatterns(ctx), [][]string{{"/a", "/b"}, {"/a", "/b"}, {"/b"}}, "after /a was accepted a retry carries only the pending /b; the attempts sent")
	ctx.Equal(res.Outcomes, map[string]string{"/a": "accepted", "/b": "accepted"}, "the batch's outcomes")
	ctx.Equal(res.Succeeded, true, "the batch's success")
}

func CheckTerminal(ctx *harness.Ctx) {
	providerFor(ctx)
	ctx.GRPC.Fail("BatchPurge", codes.InvalidArgument, "domain is not configured on this service", 1, "")
	refused := submitBatch(clientBg, "pg-1", clientDomain, []string{"/pricing", "/about"})
	ctx.Equal(len(ctx.GRPC.CallsTo("BatchPurge", "")), 1, "a refused request gets the same answer every time, retrying it only loads the provider; the calls after INVALID_ARGUMENT")
	ctx.Equal(refused.Outcomes, map[string]string{"/pricing": "failed", "/about": "failed"}, "a refused batch's outcomes")
	ctx.Equal(refused.Succeeded, false, "a refused batch's success")
	ctx.GRPC.Fail("BatchPurge", codes.FailedPrecondition, "purging is paused for this service", 1, "")
	submitBatch(clientBg, "pg-2", clientDomain, []string{"/pricing"})
	ctx.Equal(len(ctx.GRPC.CallsTo("BatchPurge", "")), 2, "FAILED_PRECONDITION is terminal too: one call; the calls")
	ctx.GRPC.Fail("BatchPurge", codes.Unavailable, "connection reset", 1, "")
	retried := submitBatch(clientBg, "pg-3", clientDomain, []string{"/pricing"})
	ctx.Assert(retried.Succeeded, "UNAVAILABLE is retryable and the second attempt reaches a healthy provider, the batch answered %+v", retried)
}

func CheckComplete(ctx *harness.Ctx) {
	providerFor(ctx)
	res := submitBatch(clientBg, "pg-1", clientDomain, []string{"/a", "/b[", "/hot"})
	ctx.Equal(res.Outcomes, map[string]string{"/a": "accepted", "/b[": "invalid_pattern", "/hot": "failed"}, "/a accepted, /b[ invalid_pattern, and /hot, throttled on every attempt, failed; the outcomes")
	ctx.Equal(res.Succeeded, false, "a batch with an invalid pattern and a failed path must not report success; succeeded")
	sent := sentPatterns(ctx)
	invalid := 0
	for _, patterns := range sent {
		for _, p := range patterns {
			if p == "/b[" {
				invalid++
			}
		}
	}
	ctx.Equal(invalid, 1, "invalid_pattern is final, resending it changes nothing; the times /b[ was sent")
	ctx.Equal(len(sent), 3, "/hot was throttled every time and must be tried MAX_ATTEMPTS = 3 times; the calls")
	clean := submitBatch(clientBg, "pg-2", clientDomain, []string{"/x", "/y"})
	ctx.Assert(clean.Succeeded && clean.Outcomes["/x"] == "accepted" && clean.Outcomes["/y"] == "accepted", "a batch the provider accepts whole answered %+v", clean)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <set>
#include <string>
#include <vector>

namespace {

const std::string kClientDomain = "shop.example.com";

// Accepts every pattern but a malformed one (with "[") and /hot, which it throttles every time; a
// pattern in throttle_once is throttled on its first arrival.
class ProviderPeer final : public cdnpurge::CdnProvider::Service {
 public:
  std::set<std::string> throttle_once;
  grpc::Status BatchPurge(grpc::ServerContext*, const cdnpurge::BatchPurgeRequest* req, cdnpurge::BatchPurgeReply* out) override {
    for (const auto& pattern : req->patterns()) {
      std::string result = "accepted";
      if (pattern.find('[') != std::string::npos) {
        result = "invalid_pattern";
      } else if (pattern == "/hot") {
        result = "throttled";
      } else if (throttle_once.erase(pattern) > 0) {
        result = "throttled";
      }
      auto* r = out->add_results();
      r->set_pattern(pattern);
      r->set_result(result);
    }
    return grpc::Status::OK;
  }
};

ProviderPeer& providerFor(harness::Ctx& ctx) {
  static ProviderPeer* peer = nullptr;
  delete peer;
  peer = new ProviderPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::vector<std::vector<std::string>> sentPatterns(harness::Ctx& ctx) {
  std::vector<std::vector<std::string>> out;
  for (const auto& call : ctx.GRPC.CallsTo("BatchPurge")) {
    const auto req = call.Request<cdnpurge::BatchPurgeRequest>();
    out.emplace_back(req.patterns().begin(), req.patterns().end());
  }
  return out;
}

using Outcomes = std::map<std::string, std::string>;

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  providerFor(ctx);
  const BatchResult healthy = submitBatch("pg-1", kClientDomain, {"/pricing"});
  ctx.Assert(healthy.succeeded && healthy.outcomes == Outcomes{{"/pricing", "accepted"}}, "a healthy provider's batch must accept /pricing");
  for (const auto& call : ctx.GRPC.CallsTo("BatchPurge")) {
    ctx.Assert(call.HasDeadline(), "a BatchPurge call carries no deadline: a provider that hangs holds the purge worker forever");
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a BatchPurge call carries a %v s deadline, expected kDeadline = 2 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("BatchPurge", 10.0);
  const int64_t before = ctx.Clock.Now();
  const BatchResult slow = submitBatch("pg-2", kClientDomain, {"/pricing"});
  const double took = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(took <= 7, "submitBatch against a provider that takes 10 s spent %.0f s: three attempts of 2 s each is the bound", took);
  ctx.Assert(!slow.succeeded && slow.outcomes == Outcomes{{"/pricing", "failed"}}, "a batch whose every attempt timed out must report /pricing failed");
  ctx.Equal(ctx.GRPC.CallsTo("BatchPurge").size(), 4, "a deadline is retryable: the healthy call plus 3 attempts for the slow batch; the calls");
}

void CheckBatchId(harness::Ctx& ctx) {
  ProviderPeer& peer = providerFor(ctx);
  ctx.GRPC.Fail("BatchPurge", grpc::StatusCode::UNAVAILABLE, "connection reset");
  peer.throttle_once.insert("/b");
  const BatchResult res = submitBatch("pg-1", kClientDomain, {"/a", "/b"});
  std::set<std::string> ids;
  for (const auto& call : ctx.GRPC.CallsTo("BatchPurge")) ids.insert(call.Request<cdnpurge::BatchPurgeRequest>().batch_id());
  ctx.Assert(ids.size() == 1, "the attempts of one batch carried %d batch ids: to the provider every retry is a new batch, and it purges again what it already accepted", ids.size());
  ctx.Assert(ids.count(res.batch_id) == 1, "submitBatch answered batch id %q, which the provider never saw", res.batch_id);
  ctx.Equal(sentPatterns(ctx), std::vector<std::vector<std::string>>{{"/a", "/b"}, {"/a", "/b"}, {"/b"}}, "after /a was accepted a retry carries only the pending /b; the attempts sent");
  ctx.Equal(res.outcomes, Outcomes{{"/a", "accepted"}, {"/b", "accepted"}}, "the batch's outcomes");
  ctx.Equal(res.succeeded, true, "the batch's success");
}

void CheckTerminal(harness::Ctx& ctx) {
  providerFor(ctx);
  ctx.GRPC.Fail("BatchPurge", grpc::StatusCode::INVALID_ARGUMENT, "domain is not configured on this service");
  const BatchResult refused = submitBatch("pg-1", kClientDomain, {"/pricing", "/about"});
  ctx.Equal(ctx.GRPC.CallsTo("BatchPurge").size(), 1, "a refused request gets the same answer every time, retrying it only loads the provider; the calls after INVALID_ARGUMENT");
  ctx.Equal(refused.outcomes, Outcomes{{"/about", "failed"}, {"/pricing", "failed"}}, "a refused batch's outcomes");
  ctx.Equal(refused.succeeded, false, "a refused batch's success");
  ctx.GRPC.Fail("BatchPurge", grpc::StatusCode::FAILED_PRECONDITION, "purging is paused for this service");
  submitBatch("pg-2", kClientDomain, {"/pricing"});
  ctx.Equal(ctx.GRPC.CallsTo("BatchPurge").size(), 2, "FAILED_PRECONDITION is terminal too: one call; the calls");
  ctx.GRPC.Fail("BatchPurge", grpc::StatusCode::UNAVAILABLE, "connection reset");
  const BatchResult retried = submitBatch("pg-3", kClientDomain, {"/pricing"});
  ctx.Assert(retried.succeeded, "UNAVAILABLE is retryable and the second attempt reaches a healthy provider, but the batch did not succeed");
}

void CheckComplete(harness::Ctx& ctx) {
  providerFor(ctx);
  const BatchResult res = submitBatch("pg-1", kClientDomain, {"/a", "/b[", "/hot"});
  ctx.Equal(res.outcomes, Outcomes{{"/a", "accepted"}, {"/b[", "invalid_pattern"}, {"/hot", "failed"}}, "/a accepted, /b[ invalid_pattern, and /hot, throttled on every attempt, failed; the outcomes");
  ctx.Equal(res.succeeded, false, "a batch with an invalid pattern and a failed path must not report success; succeeded");
  const auto sent = sentPatterns(ctx);
  int invalid = 0;
  for (const auto& patterns : sent) {
    for (const auto& p : patterns) {
      if (p == "/b[") invalid++;
    }
  }
  ctx.Equal(invalid, 1, "invalid_pattern is final, resending it changes nothing; the times /b[ was sent");
  ctx.Equal(sent.size(), 3, "/hot was throttled every time and must be tried kMaxAttempts = 3 times; the calls");
  const BatchResult clean = submitBatch("pg-2", kClientDomain, {"/x", "/y"});
  ctx.Assert(clean.succeeded && clean.outcomes == Outcomes{{"/x", "accepted"}, {"/y", "accepted"}}, "a batch the provider accepts whole must succeed");
}
`,
  },
  hints: [
    'A provider that hangs pins the purge worker; the provider log shows three batch ids for one purge and `/a` purged three times; a purge with one accepted path out of thirty reports success.',
    'The call has no deadline, the id is minted inside the loop and the whole path list goes out every time, every `RpcError` leads to another attempt, and the loop stops at the first `accepted`.',
    'Mint `batch_id` before the loop, send `pending` with `timeout=DEADLINE_S`, `continue` only on `RETRYABLE`, else `break`; keep `accepted`/`invalid_pattern`, resend the rest, map leftovers to `OUTCOME_FAILED`, and `succeeded = all(... == OUTCOME_ACCEPTED)`.',
  ],
  debrief: `Each piece bounds one dimension of the worst case. The deadline bounds an attempt, \`MAX_ATTEMPTS\` bounds the batch, and the retryable set bounds which failures are worth repeating: \`INVALID_ARGUMENT\` is a statement about the request, and repeating it turns a client bug into load on the provider. The batch id minted once lets the provider recognise its own retries, and sending only pending paths means an accepted path is purged once even when the provider does not deduplicate. Reporting every path's outcome turns "partially failed" into a list an operator can act on. What this step leaves out: jittered backoff between attempts, a circuit breaker per provider endpoint, and writing the outcomes back with \`records.set_outcomes\` so the status read sees them.`,
};
